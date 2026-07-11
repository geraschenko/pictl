use std::path::PathBuf;
use std::process::Output;
use std::time::Duration;

use tokio::process::Command;

use crate::agent_id::AgentId;
use crate::agent_probe::AgentProbe;
use crate::error::{Error, Result};

/// `pictl wait` exits 3 when `--timeout` expires.
const WAIT_TIMEOUT_EXIT_CODE: i32 = 3;

/// Runs the `pictl` CLI for lifecycle and inspection. Agent targets are
/// `&str` because pictl resolves agent-id *prefixes*; parsed outputs carry
/// full [`AgentId`]s.
pub struct Pictl {
    bin: PathBuf,
}

pub struct SpawnOptions {
    pub cwd: Option<PathBuf>,
    pub id: Option<AgentId>,
    pub tag: Option<String>,
    /// Forwarded to pi after `--`.
    pub pi_args: Vec<String>,
}

pub enum UntilCondition {
    TurnEnd,
    Idle,
    NoActivity(Duration),
}

impl UntilCondition {
    fn to_flag_value(&self) -> String {
        match self {
            UntilCondition::TurnEnd => "turn-end".to_owned(),
            UntilCondition::Idle => "idle".to_owned(),
            UntilCondition::NoActivity(window) => {
                format!("no-activity:{}", window.as_secs_f64())
            }
        }
    }
}

fn cli_error(args: Vec<String>, output: &Output) -> Error {
    Error::Cli {
        args,
        status: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn target_args(verb: &str, targets: &[&str]) -> Vec<String> {
    let mut args = vec![verb.to_owned()];
    for target in targets {
        args.push("--target".to_owned());
        args.push((*target).to_owned());
    }
    args
}

impl Pictl {
    /// Uses `pictl` from `PATH`.
    pub fn new() -> Self {
        Self {
            bin: PathBuf::from("pictl"),
        }
    }

    pub fn with_bin(bin: PathBuf) -> Self {
        Self { bin }
    }

    async fn run(&self, args: Vec<String>) -> Result<String> {
        let output = Command::new(&self.bin).args(&args).output().await?;
        if !output.status.success() {
            return Err(cli_error(args, &output));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Runs `pictl spawn` and returns the new agent's id.
    pub async fn spawn(&self, opts: &SpawnOptions) -> Result<AgentId> {
        let mut args = vec!["spawn".to_owned()];
        if let Some(cwd) = &opts.cwd {
            args.push("--cwd".to_owned());
            args.push(cwd.display().to_string());
        }
        if let Some(id) = &opts.id {
            args.push("--id".to_owned());
            args.push(id.0.clone());
        }
        if let Some(tag) = &opts.tag {
            args.push("--tag".to_owned());
            args.push(tag.clone());
        }
        if !opts.pi_args.is_empty() {
            args.push("--".to_owned());
            args.extend(opts.pi_args.iter().cloned());
        }
        let stdout = self.run(args).await?;
        let agent_id = stdout.trim();
        if agent_id.is_empty() {
            return Err(Error::Protocol(
                "pictl spawn printed no agent id".to_owned(),
            ));
        }
        Ok(AgentId(agent_id.to_owned()))
    }

    /// `pictl list --json [--all]`. Archived agents are included only with
    /// `all`.
    pub async fn list(&self, all: bool) -> Result<Vec<AgentProbe>> {
        let mut args = vec!["list".to_owned(), "--json".to_owned()];
        if all {
            args.push("--all".to_owned());
        }
        Ok(serde_json::from_str(&self.run(args).await?)?)
    }

    /// `pictl status --json` for the given targets.
    pub async fn status(&self, targets: &[&str]) -> Result<Vec<AgentProbe>> {
        let mut args = target_args("status", targets);
        args.push("--json".to_owned());
        Ok(serde_json::from_str(&self.run(args).await?)?)
    }

    /// Blocks until the agent meets the condition. A `pictl wait` timeout
    /// (exit code 3) is [`Error::Timeout`]; other failures are
    /// [`Error::Cli`]. Returns immediately for dormant/archived agents
    /// (pictl treats any condition as already met for a process that is
    /// doing nothing).
    pub async fn wait(
        &self,
        target: &str,
        until: UntilCondition,
        timeout: Option<Duration>,
    ) -> Result<()> {
        let mut args = target_args("wait", &[target]);
        args.push("--until".to_owned());
        args.push(until.to_flag_value());
        if let Some(timeout) = timeout {
            args.push("--timeout".to_owned());
            args.push(timeout.as_secs_f64().to_string());
        }
        let output = Command::new(&self.bin).args(&args).output().await?;
        if output.status.success() {
            Ok(())
        } else if output.status.code() == Some(WAIT_TIMEOUT_EXIT_CODE) {
            Err(Error::Timeout)
        } else {
            Err(cli_error(args, &output))
        }
    }

    pub async fn suspend(&self, targets: &[&str]) -> Result<()> {
        self.run(target_args("suspend", targets)).await.map(|_| ())
    }

    pub async fn archive(&self, targets: &[&str]) -> Result<()> {
        self.run(target_args("archive", targets)).await.map(|_| ())
    }

    pub async fn resume(&self, targets: &[&str]) -> Result<()> {
        self.run(target_args("resume", targets)).await.map(|_| ())
    }

    pub async fn purge(&self, targets: &[&str]) -> Result<()> {
        self.run(target_args("purge", targets)).await.map(|_| ())
    }

    pub async fn gc(&self) -> Result<()> {
        self.run(vec!["gc".to_owned()]).await.map(|_| ())
    }
}

impl Default for Pictl {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests;
