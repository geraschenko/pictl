use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio_util::codec::{FramedRead, FramedWrite};

use super::*;
use crate::frame_codec::{Frame, FrameCodec, TtyExit};

#[tokio::test]
async fn pane_applies_snapshot_and_output_to_screen() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("tty.sock");
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, write_half) = stream.into_split();
        let mut reader = FramedRead::new(read_half, FrameCodec);
        let mut writer = FramedWrite::new(write_half, FrameCodec);
        assert!(matches!(reader.next().await.unwrap().unwrap(), Frame::Hello(_)));
        assert_eq!(
            reader.next().await.unwrap().unwrap(),
            Frame::Resize(TtyResize { cols: 20, rows: 5 })
        );
        writer
            .send(Frame::Snapshot(Bytes::from_static(b"snapshot")))
            .await
            .unwrap();
        writer
            .send(Frame::Output(Bytes::from_static(b" then output")))
            .await
            .unwrap();
        writer
            .send(Frame::Exit(TtyExit { reason: "done".into() }))
            .await
            .unwrap();
    });

    let mut pane = AttachPane::connect(
        &sock,
        "pane-test",
        TtyResize { cols: 20, rows: 5 },
        DEFAULT_SCROLLBACK_LINES,
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    assert_eq!(pane.state(), PaneState::Connected);

    // Wait until the exit frame has been applied; screen content then
    // reflects everything sent before it.
    while pane.state() == PaneState::Connected {
        pane.changed().await;
    }
    assert_eq!(pane.state(), PaneState::Exited { reason: "done".into() });
    let row = pane.with_screen(|screen| screen.contents());
    assert!(row.contains("snapshot then output"), "screen was: {row:?}");
    server.await.unwrap();
}

#[tokio::test]
async fn pane_reports_disconnected_on_socket_close() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("tty.sock");
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = FramedRead::new(stream, FrameCodec);
        assert!(matches!(reader.next().await.unwrap().unwrap(), Frame::Hello(_)));
        assert!(matches!(reader.next().await.unwrap().unwrap(), Frame::Resize(_)));
        // Hang up without an exit frame.
    });

    let mut pane = AttachPane::connect(
        &sock,
        "pane-test",
        TtyResize { cols: 20, rows: 5 },
        DEFAULT_SCROLLBACK_LINES,
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    while pane.state() == PaneState::Connected {
        pane.changed().await;
    }
    assert_eq!(pane.state(), PaneState::Disconnected);
    server.await.unwrap();
}
