use futures_util::SinkExt;

use super::*;
use crate::frame_codec::TtyExit;

#[tokio::test]
async fn tty_client_handshake_and_events() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("tty.sock");
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, write_half) = stream.into_split();
        let mut reader = FramedRead::new(read_half, FrameCodec);
        let mut writer = FramedWrite::new(write_half, FrameCodec);
        match reader.next().await.unwrap().unwrap() {
            Frame::Hello(hello) => {
                assert_eq!(hello.pid, std::process::id());
                assert_eq!(hello.client, "test-client");
            }
            other => panic!("expected hello first, got {other:?}"),
        }
        writer.send(Frame::Snapshot(Bytes::from_static(b"snap"))).await.unwrap();
        writer.send(Frame::Output(Bytes::from_static(b"out"))).await.unwrap();
        assert_eq!(
            reader.next().await.unwrap().unwrap(),
            Frame::Input(Bytes::from_static(b"keys"))
        );
        assert_eq!(
            reader.next().await.unwrap().unwrap(),
            Frame::Resize(TtyResize { cols: 100, rows: 30 })
        );
        writer.send(Frame::Exit(TtyExit { reason: "bye".into() })).await.unwrap();
    });

    let (mut client, mut events) =
        TtyClient::connect(&sock, "test-client", Duration::from_secs(1)).await.unwrap();
    assert!(matches!(
        events.next().await.unwrap().unwrap(),
        TtyEvent::Snapshot(bytes) if bytes.as_ref() == b"snap"
    ));
    assert!(matches!(
        events.next().await.unwrap().unwrap(),
        TtyEvent::Output(bytes) if bytes.as_ref() == b"out"
    ));
    client.input(b"keys").await.unwrap();
    client.resize(TtyResize { cols: 100, rows: 30 }).await.unwrap();
    assert!(matches!(
        events.next().await.unwrap().unwrap(),
        TtyEvent::Exit { reason } if reason == "bye"
    ));
    server.await.unwrap();
    assert!(events.next().await.is_none());
}

#[tokio::test]
async fn tty_client_connect_retries_until_socket_exists() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("tty.sock");
    let sock_for_server = sock.clone();
    let server = tokio::spawn(async move {
        // Simulates the real-world race this retry exists for: the daemon
        // creates the socket some time after spawn returns.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let listener = tokio::net::UnixListener::bind(&sock_for_server).unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = FramedRead::new(stream, FrameCodec);
        assert!(matches!(reader.next().await.unwrap().unwrap(), Frame::Hello(_)));
    });
    let result = TtyClient::connect(&sock, "retry-test", Duration::from_secs(5)).await;
    assert!(result.is_ok());
    server.await.unwrap();
}

#[tokio::test]
async fn tty_client_connect_fails_after_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("never.sock");
    let result = TtyClient::connect(&sock, "x", Duration::from_millis(100)).await;
    assert!(matches!(result, Err(Error::Io(_))));
}
