use pi_rpc_rs::types::RpcEvent;

use super::*;

async fn accept_with_banner(
    listener: tokio::net::UnixListener,
    banner: &str,
) -> (
    tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
    tokio::net::unix::OwnedWriteHalf,
) {
    let (stream, _) = listener.accept().await.unwrap();
    let (read_half, mut write_half) = stream.into_split();
    write_half
        .write_all(format!("{banner}\n").as_bytes())
        .await
        .unwrap();
    (BufReader::new(read_half).lines(), write_half)
}

#[tokio::test]
async fn client_correlates_responses_and_broadcasts_events() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("pi.sock");
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    let server = tokio::spawn(async move {
        let (mut lines, mut writer) = accept_with_banner(
            listener,
            r#"{"type":"hello","protocol":"pi-rpc-socket","version":1}"#,
        )
        .await;
        // An event racing ahead of the response must not confuse
        // correlation.
        writer.write_all(b"{\"type\":\"agent_start\"}\n").await.unwrap();
        let request: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(request["type"], "get_state");
        let id = request["id"].as_str().unwrap();
        let state = serde_json::json!({
            "type": "response", "id": id, "command": "get_state", "success": true,
            "data": {
                "thinkingLevel": "off", "isStreaming": false, "isCompacting": false,
                "steeringMode": "all", "followUpMode": "one-at-a-time",
                "sessionId": "s1", "autoCompactionEnabled": true,
                "messageCount": 0, "pendingMessageCount": 0
            }
        });
        writer
            .write_all(format!("{state}\n").as_bytes())
            .await
            .unwrap();
    });

    let (client, mut events) =
        PiSocketClient::connect(&sock, Duration::from_secs(1)).await.unwrap();
    let state = client.get_state().await.unwrap();
    assert!(!state.is_streaming);
    assert_eq!(state.session_id, "s1");
    assert!(matches!(
        events.next().await.unwrap(),
        SocketRecord::Event(RpcEvent::Agent(pi_rpc_rs::types::AgentEvent::AgentStart))
    ));
    server.await.unwrap();
    assert!(events.next().await.is_none());
}

#[tokio::test]
async fn error_response_is_rpc_error() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("pi.sock");
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    let server = tokio::spawn(async move {
        let (mut lines, mut writer) = accept_with_banner(
            listener,
            r#"{"type":"hello","protocol":"pi-rpc-socket","version":1}"#,
        )
        .await;
        let request: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        let id = request["id"].as_str().unwrap();
        let response = serde_json::json!({
            "type": "response", "id": id, "command": "abort",
            "success": false, "error": "nothing to abort"
        });
        writer
            .write_all(format!("{response}\n").as_bytes())
            .await
            .unwrap();
    });

    let (client, _events) =
        PiSocketClient::connect(&sock, Duration::from_secs(1)).await.unwrap();
    let result = client.request(RpcCommandKind::Abort).await;
    assert!(matches!(result, Err(Error::Rpc(message)) if message.contains("nothing to abort")));
    server.await.unwrap();
}

#[tokio::test]
async fn wrong_protocol_banner_fails_connect() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("pi.sock");
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    tokio::spawn(async move {
        let _halves = accept_with_banner(
            listener,
            r#"{"type":"hello","protocol":"something-else","version":1}"#,
        )
        .await;
    });
    let result = PiSocketClient::connect(&sock, Duration::from_secs(1)).await;
    assert!(matches!(result, Err(Error::Protocol(_))));
}

#[tokio::test]
async fn socket_close_fails_pending_request() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("pi.sock");
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    let server = tokio::spawn(async move {
        let (mut lines, writer) = accept_with_banner(
            listener,
            r#"{"type":"hello","protocol":"pi-rpc-socket","version":1}"#,
        )
        .await;
        // Read the request, then hang up without responding.
        lines.next_line().await.unwrap().unwrap();
        drop(writer);
        drop(lines);
    });
    let (client, _events) =
        PiSocketClient::connect(&sock, Duration::from_secs(1)).await.unwrap();
    let result = client.request(RpcCommandKind::Abort).await;
    assert!(matches!(result, Err(Error::Closed)));
    server.await.unwrap();
}
