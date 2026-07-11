use std::path::PathBuf;

use pi_rpc_rs::types::{RpcEvent, RpcResponse};
use serde::Deserialize;

/// The server banner: `{"type":"hello","protocol":"pi-rpc-socket","version":1}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SocketHello {
    pub protocol: String,
    pub version: u64,
}

/// One JSONL record from pi.sock. Dispatch on `type` handles socket/fork
/// records BEFORE delegating to [`RpcEvent`] (they are unknown to upstream
/// pi), and unrecognized or malformed types become
/// [`SocketRecord::Unknown`] — never a hard error. The fork variants here are
/// the list of what to eventually upstream to pi-rpc-rs.
#[derive(Debug)]
pub enum SocketRecord {
    Hello(SocketHello),
    Response(RpcResponse),
    SessionChanged {
        session_id: String,
        session_file: Option<PathBuf>,
    },
    Shutdown,
    UiWaitStart {
        request_id: String,
        request: serde_json::Value,
    },
    UiWaitEnd {
        request_id: String,
        request: serde_json::Value,
        resolution: serde_json::Value,
    },
    TreeNavigated {
        old_leaf_id: Option<String>,
        new_leaf_id: Option<String>,
    },
    Event(RpcEvent),
    Unknown(serde_json::Value),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionChangedRecord {
    session_id: String,
    session_file: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiWaitStartRecord {
    request_id: String,
    request: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiWaitEndRecord {
    request_id: String,
    request: serde_json::Value,
    resolution: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TreeNavigatedRecord {
    old_leaf_id: Option<String>,
    new_leaf_id: Option<String>,
}

impl SocketRecord {
    /// Classify one parsed JSONL record. Infallible by design: a record whose
    /// typed parse fails degrades to [`SocketRecord::Unknown`] rather than
    /// erroring, so version skew never kills a long-lived connection.
    pub fn from_value(value: serde_json::Value) -> SocketRecord {
        fn typed<T, F>(value: serde_json::Value, wrap: F) -> SocketRecord
        where
            T: serde::de::DeserializeOwned,
            F: FnOnce(T) -> SocketRecord,
        {
            match serde_json::from_value(value.clone()) {
                Ok(record) => wrap(record),
                Err(_) => SocketRecord::Unknown(value),
            }
        }

        let record_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match record_type {
            "hello" => typed(value, SocketRecord::Hello),
            "response" => typed(value, SocketRecord::Response),
            "session_changed" => typed(value, |r: SessionChangedRecord| {
                SocketRecord::SessionChanged {
                    session_id: r.session_id,
                    session_file: r.session_file,
                }
            }),
            "shutdown" => SocketRecord::Shutdown,
            "ui_wait_start" => typed(value, |r: UiWaitStartRecord| SocketRecord::UiWaitStart {
                request_id: r.request_id,
                request: r.request,
            }),
            "ui_wait_end" => typed(value, |r: UiWaitEndRecord| SocketRecord::UiWaitEnd {
                request_id: r.request_id,
                request: r.request,
                resolution: r.resolution,
            }),
            "tree_navigated" => typed(value, |r: TreeNavigatedRecord| {
                SocketRecord::TreeNavigated {
                    old_leaf_id: r.old_leaf_id,
                    new_leaf_id: r.new_leaf_id,
                }
            }),
            _ => match serde_json::from_value::<RpcEvent>(value.clone()) {
                // Canonicalize: an event pi-rpc-rs itself could not type is
                // reported as Unknown here, not Event(RpcEvent::Unknown).
                Ok(RpcEvent::Unknown(unknown)) => SocketRecord::Unknown(unknown),
                Ok(event) => SocketRecord::Event(event),
                // RpcEvent's deserializer can still fail on a malformed
                // extension_ui_request or session_* wrapper record.
                Err(_) => SocketRecord::Unknown(value),
            },
        }
    }
}

#[cfg(test)]
mod tests;
