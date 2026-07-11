//! Rust client for [pictl](https://github.com/geraschenko/pictl)-managed pi
//! agents. Lifecycle and inspection shell out to the `pictl` CLI ([`Pictl`]);
//! the attach protocol ([`TtyClient`]) and the RPC/event protocol
//! ([`PiSocketClient`], [`ActivityWatcher`]) are spoken natively over the
//! agent's Unix sockets. The `ratatui` feature adds an embeddable terminal
//! pane widget ([`AttachPane`]).

mod activity_watcher;
mod agent_id;
mod agent_probe;
#[cfg(feature = "ratatui")]
mod attach_pane;
mod connect_with_retry;
mod error;
mod frame_codec;
mod pi_socket_client;
mod pictl;
mod socket_record;
mod tty_client;

pub use activity_watcher::{ActivityWatcher, AgentActivity};
pub use agent_id::AgentId;
pub use agent_probe::{AgentProbe, AgentRecord, AgentStatus, AttachmentInfo, SessionHistoryEntry};
#[cfg(feature = "ratatui")]
pub use attach_pane::{AttachPane, DEFAULT_SCROLLBACK_LINES, PaneState};
pub use error::{Error, Result};
pub use frame_codec::{Frame, FrameCodec, MAX_PAYLOAD_BYTES, TtyExit, TtyHello, TtyResize};
pub use pi_socket_client::{PiSocketClient, SocketEvents};
pub use pictl::{Pictl, SpawnOptions, UntilCondition};
pub use socket_record::{SocketHello, SocketRecord};
pub use tty_client::{TtyClient, TtyEvent, TtyEvents};
