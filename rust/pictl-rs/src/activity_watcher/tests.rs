use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::*;

/// (is_streaming, is_compacting, pending_message_count)
type MockState = (bool, bool, f64);

/// A driveable mock pi.sock server. `ActivityWatcher` observes through a
/// coalescing `watch` channel, so tests must emit one transition at a
/// time and observe it before emitting the next — a free-running
/// scripted server races ahead and only the final value is visible.
struct MockPi {
    event_tx: mpsc::UnboundedSender<String>,
    state: Arc<Mutex<MockState>>,
    served_rx: watch::Receiver<u64>,
    server: tokio::task::JoinHandle<()>,
}

impl MockPi {
    async fn start(sock: &std::path::Path, initial: MockState) -> MockPi {
        let listener = tokio::net::UnixListener::bind(sock).unwrap();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<String>();
        let (served_tx, served_rx) = watch::channel(0u64);
        let state = Arc::new(Mutex::new(initial));
        let server = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                let (stream, _) = listener.accept().await.unwrap();
                let (read_half, mut writer) = stream.into_split();
                writer
                    .write_all(
                        b"{\"type\":\"hello\",\"protocol\":\"pi-rpc-socket\",\"version\":1}\n",
                    )
                    .await
                    .unwrap();
                let mut lines = BufReader::new(read_half).lines();
                loop {
                    tokio::select! {
                        line = lines.next_line() => {
                            let Ok(Some(line)) = line else { return };
                            let request: serde_json::Value =
                                serde_json::from_str(&line).unwrap();
                            assert_eq!(request["type"], "get_state");
                            let (is_streaming, is_compacting, pending) =
                                *state.lock().unwrap();
                            let response = serde_json::json!({
                                "type": "response",
                                "id": request["id"],
                                "command": "get_state", "success": true,
                                "data": {
                                    "thinkingLevel": "off",
                                    "isStreaming": is_streaming,
                                    "isCompacting": is_compacting,
                                    "steeringMode": "all",
                                    "followUpMode": "one-at-a-time",
                                    "sessionId": "s1",
                                    "autoCompactionEnabled": true,
                                    "messageCount": 0,
                                    "pendingMessageCount": pending
                                }
                            });
                            writer
                                .write_all(format!("{response}\n").as_bytes())
                                .await
                                .unwrap();
                            served_tx.send_modify(|count| *count += 1);
                        }
                        event = event_rx.recv() => {
                            // Channel closed = test done: hang up.
                            let Some(event) = event else { return };
                            writer
                                .write_all(format!("{event}\n").as_bytes())
                                .await
                                .unwrap();
                        }
                    }
                }
            }
        });
        MockPi { event_tx, state, served_rx, server }
    }

    fn set_state(&self, state: MockState) {
        *self.state.lock().unwrap() = state;
    }

    fn emit(&self, event: &str) {
        self.event_tx.send(event.to_owned()).unwrap();
    }

    /// Wait until the server has answered `count` get_state requests.
    async fn wait_served(&mut self, count: u64) {
        while *self.served_rx.borrow_and_update() < count {
            self.served_rx.changed().await.unwrap();
        }
    }

    async fn close(self) {
        drop(self.event_tx);
        self.server.await.unwrap();
    }
}

fn session_state(is_streaming: bool, is_compacting: bool, pending: f64) -> RpcSessionState {
    use pi_rpc_rs::types::{QueueMode, ThinkingLevel};
    RpcSessionState {
        model: None,
        thinking_level: ThinkingLevel::Off,
        is_streaming,
        is_compacting,
        steering_mode: QueueMode::All,
        follow_up_mode: QueueMode::All,
        session_file: None,
        session_id: "s1".to_owned(),
        session_name: None,
        auto_compaction_enabled: true,
        message_count: 0.0,
        pending_message_count: pending,
    }
}

#[test]
fn derivation_matrix() {
    assert_eq!(derive_activity(&session_state(false, false, 0.0)), AgentActivity::Idle);
    assert_eq!(derive_activity(&session_state(true, false, 0.0)), AgentActivity::Streaming);
    // Queued-but-not-yet-streaming counts as Streaming.
    assert_eq!(derive_activity(&session_state(false, false, 2.0)), AgentActivity::Streaming);
    // Compacting wins over streaming and queued messages.
    assert_eq!(derive_activity(&session_state(true, true, 0.0)), AgentActivity::Compacting);
    assert_eq!(derive_activity(&session_state(false, true, 3.0)), AgentActivity::Compacting);
}

#[tokio::test]
async fn tracks_streaming_and_idle_transitions() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("pi.sock");
    let mock = MockPi::start(&sock, (false, false, 0.0)).await;

    let mut watcher =
        ActivityWatcher::connect(&sock, Duration::from_secs(1)).await.unwrap();
    assert_eq!(watcher.current(), AgentActivity::Idle);

    // agent_start flips to Streaming with no get_state round-trip.
    mock.emit(r#"{"type":"agent_start"}"#);
    assert_eq!(watcher.changed().await, AgentActivity::Streaming);

    // agent_end re-derives from get_state.
    mock.emit(r#"{"type":"agent_end","messages":[]}"#);
    assert_eq!(watcher.changed().await, AgentActivity::Idle);

    mock.close().await;
    assert_eq!(watcher.changed().await, AgentActivity::Disconnected);
}

#[tokio::test]
async fn compacting_takes_precedence_over_streaming() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("pi.sock");
    let mock = MockPi::start(&sock, (true, false, 0.0)).await;

    let mut watcher =
        ActivityWatcher::connect(&sock, Duration::from_secs(1)).await.unwrap();
    assert_eq!(watcher.current(), AgentActivity::Streaming);

    mock.set_state((true, true, 0.0));
    mock.emit(r#"{"type":"compaction_start","reason":"threshold"}"#);
    assert_eq!(watcher.changed().await, AgentActivity::Compacting);

    mock.set_state((true, false, 0.0));
    mock.emit(
        r#"{"type":"compaction_end","reason":"threshold","aborted":false,"willRetry":false}"#,
    );
    assert_eq!(watcher.changed().await, AgentActivity::Streaming);

    mock.close().await;
}

#[tokio::test]
async fn queued_messages_count_as_streaming() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("pi.sock");
    let mut mock = MockPi::start(&sock, (true, false, 0.0)).await;

    let mut watcher =
        ActivityWatcher::connect(&sock, Duration::from_secs(1)).await.unwrap();
    assert_eq!(watcher.current(), AgentActivity::Streaming);

    // agent_end with a queued message: re-derives to Streaming, so no
    // transition is observable.
    mock.set_state((false, false, 1.0));
    mock.emit(r#"{"type":"agent_end","messages":[]}"#);
    mock.wait_served(2).await; // 1 was the connect-time get_state
    assert_eq!(watcher.current(), AgentActivity::Streaming);

    // The queue drains: the next observable transition is Idle.
    mock.set_state((false, false, 0.0));
    mock.emit(r#"{"type":"agent_end","messages":[]}"#);
    assert_eq!(watcher.changed().await, AgentActivity::Idle);

    mock.close().await;
}
