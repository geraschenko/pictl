use std::path::PathBuf;

use serde::Deserialize;

use crate::agent_id::AgentId;
use crate::frame_codec::TtyResize;

/// One agent's entry in `pictl {list,status} --json` output.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbe {
    pub agent_id: AgentId,
    pub status: AgentStatus,
    pub record: Option<AgentRecord>,
    pub state: Option<pi_rpc_rs::types::RpcSessionState>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle,
    Streaming,
    Compacting,
    Dormant,
    Archived,
    Tombstoned,
    Corrupt,
    Unreachable,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub id: AgentId,
    pub created_at: String,
    pub cwd: PathBuf,
    pub tag: Option<String>,
    pub pi_bin: PathBuf,
    pub spawn_args: Vec<String>,
    pub daemon_pid: u32,
    pub pi_pid: u32,
    pub sessions: Vec<SessionHistoryEntry>,
    #[serde(default)]
    pub attachments: Vec<AttachmentInfo>,
    pub agent_dir: PathBuf,
}

impl AgentRecord {
    pub fn pi_socket_path(&self) -> PathBuf {
        self.agent_dir.join("pi.sock")
    }

    pub fn tty_socket_path(&self) -> PathBuf {
        self.agent_dir.join("tty.sock")
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryEntry {
    pub session_file: PathBuf,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub pid: u32,
    pub client: String,
    pub connected_at: String,
    pub size: Option<TtyResize>,
}
