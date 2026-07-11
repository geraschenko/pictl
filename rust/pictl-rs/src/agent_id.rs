use serde::{Deserialize, Serialize};

/// A pictl agent id. Not guaranteed to be a UUID: `pictl spawn --id` accepts
/// any `[A-Za-z0-9._-]+`.
#[derive(Clone, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct AgentId(pub String);

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
