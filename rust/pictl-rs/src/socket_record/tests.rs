use std::path::Path;

use pi_rpc_rs::types::RpcResponseKind;

use super::*;

fn parse(json: &str) -> SocketRecord {
    SocketRecord::from_value(serde_json::from_str(json).unwrap())
}

#[test]
fn dispatches_hello() {
    let record = parse(r#"{"type":"hello","protocol":"pi-rpc-socket","version":1}"#);
    assert!(matches!(
        record,
        SocketRecord::Hello(SocketHello { ref protocol, version: 1 }) if protocol == "pi-rpc-socket"
    ));
}

#[test]
fn dispatches_response() {
    let record =
        parse(r#"{"type":"response","id":"pictl-rs-1","command":"prompt","success":true}"#);
    match record {
        SocketRecord::Response(response) => {
            assert_eq!(response.id.as_deref(), Some("pictl-rs-1"));
            assert_eq!(response.kind, RpcResponseKind::Prompt);
        }
        other => panic!("expected response, got {other:?}"),
    }
}

#[test]
fn dispatches_session_changed_with_and_without_file() {
    match parse(r#"{"type":"session_changed","sessionId":"abc","sessionFile":"/tmp/s.jsonl"}"#) {
        SocketRecord::SessionChanged { session_id, session_file } => {
            assert_eq!(session_id, "abc");
            assert_eq!(session_file.as_deref(), Some(Path::new("/tmp/s.jsonl")));
        }
        other => panic!("expected session_changed, got {other:?}"),
    }
    match parse(r#"{"type":"session_changed","sessionId":"mem"}"#) {
        SocketRecord::SessionChanged { session_id, session_file } => {
            assert_eq!(session_id, "mem");
            assert_eq!(session_file, None);
        }
        other => panic!("expected session_changed, got {other:?}"),
    }
}

#[test]
fn dispatches_shutdown() {
    assert!(matches!(parse(r#"{"type":"shutdown"}"#), SocketRecord::Shutdown));
}

#[test]
fn dispatches_ui_wait_records() {
    match parse(r#"{"type":"ui_wait_start","requestId":"r1","request":{"method":"confirm"}}"#) {
        SocketRecord::UiWaitStart { request_id, request } => {
            assert_eq!(request_id, "r1");
            assert_eq!(request["method"], "confirm");
        }
        other => panic!("expected ui_wait_start, got {other:?}"),
    }
    match parse(
        r#"{"type":"ui_wait_end","requestId":"r1","request":{"method":"confirm"},"resolution":"confirmed"}"#,
    ) {
        SocketRecord::UiWaitEnd { request_id, resolution, .. } => {
            assert_eq!(request_id, "r1");
            assert_eq!(resolution, "confirmed");
        }
        other => panic!("expected ui_wait_end, got {other:?}"),
    }
}

#[test]
fn dispatches_tree_navigated_with_nulls() {
    match parse(r#"{"type":"tree_navigated","oldLeafId":null,"newLeafId":"n2"}"#) {
        SocketRecord::TreeNavigated { old_leaf_id, new_leaf_id } => {
            assert_eq!(old_leaf_id, None);
            assert_eq!(new_leaf_id.as_deref(), Some("n2"));
        }
        other => panic!("expected tree_navigated, got {other:?}"),
    }
}

#[test]
fn dispatches_upstream_agent_events() {
    use pi_rpc_rs::types::AgentEvent;
    assert!(matches!(
        parse(r#"{"type":"agent_start"}"#),
        SocketRecord::Event(RpcEvent::Agent(AgentEvent::AgentStart))
    ));
    assert!(matches!(
        parse(r#"{"type":"session_process_exited","code":0,"stderr":""}"#),
        SocketRecord::Event(RpcEvent::Session(_))
    ));
}

#[test]
fn unknown_record_types_never_error() {
    assert!(matches!(
        parse(r#"{"type":"never_heard_of_it","x":1}"#),
        SocketRecord::Unknown(_)
    ));
    // No type field at all.
    assert!(matches!(parse(r#"{"x":1}"#), SocketRecord::Unknown(_)));
}

#[test]
fn malformed_typed_records_degrade_to_unknown() {
    assert!(matches!(
        parse(r#"{"type":"session_changed"}"#),
        SocketRecord::Unknown(_)
    ));
    assert!(matches!(
        parse(r#"{"type":"extension_ui_request"}"#),
        SocketRecord::Unknown(_)
    ));
}
