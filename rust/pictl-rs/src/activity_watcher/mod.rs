//! Event-driven working/idle status over an owned pi.sock connection (one
//! socket per watcher; the server supports multiple clients).

use std::path::Path;
use std::time::Duration;

use pi_rpc_rs::types::{AgentEvent, RpcEvent, RpcSessionState};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::error::Result;
use crate::pi_socket_client::PiSocketClient;
use crate::socket_record::SocketRecord;

/// Derived from `get_state`, re-evaluated on `agent_start` / `agent_end` /
/// `compaction_start` / `compaction_end` events (event-triggered, never
/// polling):
/// - `Compacting` ⇔ `is_compacting`
/// - `Streaming` ⇔ `is_streaming || pending_message_count > 0` (when not
///   Compacting) — queued-but-not-yet-streaming counts as Streaming
/// - `Idle` otherwise
/// - `Disconnected` on socket close (terminal — callers reconnect by making
///   a new watcher)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentActivity {
    Streaming,
    Compacting,
    Idle,
    Disconnected,
}

fn derive_activity(state: &RpcSessionState) -> AgentActivity {
    if state.is_compacting {
        AgentActivity::Compacting
    } else if state.is_streaming || state.pending_message_count > 0.0 {
        AgentActivity::Streaming
    } else {
        AgentActivity::Idle
    }
}

/// `watch::Sender` has no equality-aware send: `send_if_modified` hands the
/// closure the current value, and the closure's bool return is the only
/// notify-receivers decision, so the equality test must live inside it.
fn send_if_changed(tx: &watch::Sender<AgentActivity>, activity: AgentActivity) {
    tx.send_if_modified(|current| {
        let changed = *current != activity;
        *current = activity;
        changed
    });
}

pub struct ActivityWatcher {
    rx: watch::Receiver<AgentActivity>,
    task: JoinHandle<()>,
}

impl ActivityWatcher {
    /// Initial value comes from `get_state` at connect. Retries with backoff
    /// until `deadline` elapses, like [`PiSocketClient::connect`].
    pub async fn connect(pi_sock: impl AsRef<Path>, deadline: Duration) -> Result<ActivityWatcher> {
        let (client, mut events) = PiSocketClient::connect(pi_sock, deadline).await?;
        let initial = derive_activity(&client.get_state().await?);
        let (tx, rx) = watch::channel(initial);
        let task = tokio::spawn(async move {
            loop {
                let Some(record) = events.next().await else {
                    let _ = tx.send(AgentActivity::Disconnected);
                    return;
                };
                let SocketRecord::Event(RpcEvent::Agent(event)) = record else {
                    continue;
                };
                match event {
                    // agent_start needs no round-trip: the agent is streaming
                    // by definition.
                    AgentEvent::AgentStart => {
                        send_if_changed(&tx, AgentActivity::Streaming);
                    }
                    // The other boundaries re-derive from get_state, because
                    // the next activity depends on state the event doesn't
                    // carry (queued messages, compaction inside a turn).
                    // A get_state round-trip per boundary is wasteful; see
                    // docs/thoughts/passive-state-tracker.md for the planned
                    // replacement (track RpcSessionState from the event
                    // stream after a single get_state).
                    AgentEvent::AgentEnd { .. }
                    | AgentEvent::CompactionStart { .. }
                    | AgentEvent::CompactionEnd { .. } => {
                        let Ok(state) = client.get_state().await else {
                            let _ = tx.send(AgentActivity::Disconnected);
                            return;
                        };
                        send_if_changed(&tx, derive_activity(&state));
                    }
                    _ => {}
                }
            }
        });
        Ok(ActivityWatcher { rx, task })
    }

    pub fn current(&self) -> AgentActivity {
        *self.rx.borrow()
    }

    /// Resolves on the next transition. After the terminal `Disconnected`
    /// transition has been observed, pends forever (there are no more
    /// transitions), which keeps `select!` loops well-behaved.
    pub async fn changed(&mut self) -> AgentActivity {
        match self.rx.changed().await {
            Ok(()) => *self.rx.borrow_and_update(),
            Err(_) => std::future::pending().await,
        }
    }
}

impl Drop for ActivityWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests;
