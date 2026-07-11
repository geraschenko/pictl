//! pi.sock JSONL client. Public now; expected to move into pi-rpc-rs when it
//! grows a transport abstraction (see pi-rpc-rs/docs/handoff-unknown-records.md).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pi_rpc_rs::types::{RpcCommand, RpcCommandKind, RpcResponse, RpcResponseKind, RpcSessionState};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::connect_with_retry::connect_with_retry;
use crate::error::{Error, Result};
use crate::socket_record::SocketRecord;

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>>;

/// A pi.sock RPC client. A background reader task routes responses to their
/// requesters by id and everything else to [`SocketEvents`]. Dropping the
/// client aborts the task and disconnects.
pub struct PiSocketClient {
    writer: tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>,
    pending: PendingMap,
    next_id: AtomicU64,
    reader_task: JoinHandle<()>,
}

/// All non-response records, in arrival order. `next()` returning `None`
/// means the connection is gone.
pub struct SocketEvents {
    rx: mpsc::UnboundedReceiver<SocketRecord>,
}

impl PiSocketClient {
    /// Validates the server banner; a wrong `protocol` is
    /// [`Error::Protocol`], an unexpected `version` is tolerated (matching
    /// pictl's TS client). Retries with backoff until `deadline` elapses: the
    /// socket may not exist yet right after spawn.
    pub async fn connect(
        pi_sock: impl AsRef<Path>,
        deadline: Duration,
    ) -> Result<(PiSocketClient, SocketEvents)> {
        let stream = connect_with_retry(pi_sock.as_ref(), deadline).await?;
        let (read_half, write_half) = stream.into_split();
        let mut lines = BufReader::new(read_half).lines();

        let banner_line = loop {
            match lines.next_line().await? {
                Some(line) if !line.trim().is_empty() => break line,
                Some(_) => continue,
                None => return Err(Error::Closed),
            }
        };
        let banner: serde_json::Value = serde_json::from_str(&banner_line).map_err(|_| {
            Error::Protocol("first record on pi socket was not valid JSON".to_owned())
        })?;
        match SocketRecord::from_value(banner) {
            SocketRecord::Hello(hello) if hello.protocol == "pi-rpc-socket" => {}
            _ => {
                // char-wise truncation: a byte slice could split a multibyte
                // character and panic.
                let excerpt: String = banner_line.chars().take(100).collect();
                return Err(Error::Protocol(format!(
                    "not a pi RPC socket (got {excerpt})"
                )));
            }
        }

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::unbounded_channel();
        let reader_task = tokio::spawn({
            let pending = Arc::clone(&pending);
            async move {
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    // Malformed JSON lines are ignored, like the TS client.
                    let Ok(value) = serde_json::from_str(&line) else {
                        continue;
                    };
                    match SocketRecord::from_value(value) {
                        SocketRecord::Response(response) => {
                            let waiter = response
                                .id
                                .as_ref()
                                .and_then(|id| pending.lock().unwrap().remove(id));
                            // A response nobody is waiting for is dropped,
                            // like the TS client (it was another client's).
                            if let Some(waiter) = waiter {
                                let _ = waiter.send(response);
                            }
                        }
                        // A dropped SocketEvents just means nobody is
                        // listening; keep draining so the kernel buffer (and
                        // pi's writes) never back up.
                        record => {
                            let _ = tx.send(record);
                        }
                    }
                }
                // Closed: dropping the senders fails all pending requests.
                pending.lock().unwrap().clear();
            }
        });

        Ok((
            PiSocketClient {
                writer: tokio::sync::Mutex::new(write_half),
                pending,
                next_id: AtomicU64::new(0),
                reader_task,
            },
            SocketEvents { rx },
        ))
    }

    /// Assigns a request id, correlates the response; an RPC error response
    /// is [`Error::Rpc`], a connection lost before the response is
    /// [`Error::Closed`].
    pub async fn request(&self, kind: RpcCommandKind) -> Result<RpcResponseKind> {
        let id = format!("pictl-rs-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let (waiter_tx, waiter_rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), waiter_tx);

        let command = RpcCommand {
            id: Some(id.clone()),
            kind,
        };
        let mut line = serde_json::to_string(&command)?;
        line.push('\n');
        let write_result = self.writer.lock().await.write_all(line.as_bytes()).await;
        if let Err(err) = write_result {
            self.pending.lock().unwrap().remove(&id);
            return Err(err.into());
        }

        let response = waiter_rx.await.map_err(|_| Error::Closed)?;
        match response.kind {
            RpcResponseKind::Error { command, error } => {
                Err(Error::Rpc(format!("pi rejected {command}: {error}")))
            }
            kind => Ok(kind),
        }
    }

    pub async fn get_state(&self) -> Result<RpcSessionState> {
        match self.request(RpcCommandKind::GetState).await? {
            RpcResponseKind::GetState(state) => Ok(state),
            other => Err(Error::Rpc(format!(
                "unexpected response to get_state: {other:?}"
            ))),
        }
    }
}

impl Drop for PiSocketClient {
    fn drop(&mut self) {
        self.reader_task.abort();
    }
}

impl SocketEvents {
    pub async fn next(&mut self) -> Option<SocketRecord> {
        self.rx.recv().await
    }
}

#[cfg(test)]
mod tests;
