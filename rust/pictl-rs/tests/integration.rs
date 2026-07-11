//! Real end-to-end test against a live pictl + pi. Ignored by default: it
//! needs `pictl` and `pi` on PATH plus provider API keys (the agent must
//! actually stream a response). Run manually with:
//!
//! ```sh
//! PICTL_DIR=$(mktemp -d) cargo test --test integration -- --ignored --nocapture
//! ```
//!
//! Setting `PICTL_DIR` to a tempdir keeps the test away from the real
//! registry; the test purges its agent on the way out either way.

use std::time::Duration;

use pi_rpc_rs::types::RpcCommandKind;
use pictl_rs::{
    ActivityWatcher, AgentActivity, PiSocketClient, Pictl, SpawnOptions, TtyClient, TtyEvent,
    TtyResize,
};

const CONNECT_DEADLINE: Duration = Duration::from_secs(10);
const STEP_TIMEOUT: Duration = Duration::from_secs(60);

async fn step<T>(label: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(STEP_TIMEOUT, future)
        .await
        .unwrap_or_else(|_| panic!("timed out: {label}"))
}

#[tokio::test]
#[ignore = "requires pictl + pi on PATH and provider API keys; see module docs"]
async fn end_to_end() {
    assert!(
        std::env::var_os("PICTL_DIR").is_some(),
        "set PICTL_DIR to a scratch directory before running (see module docs)"
    );
    let workdir = tempfile::tempdir().unwrap();
    let pictl = Pictl::new();

    let agent_id = pictl
        .spawn(&SpawnOptions {
            cwd: Some(workdir.path().to_path_buf()),
            id: None,
            tag: Some("pictl-rs-integration".to_owned()),
            pi_args: vec![],
        })
        .await
        .unwrap();
    println!("spawned {agent_id}");

    let result = run_against_agent(&pictl, &agent_id.0).await;
    // Purge before asserting so a failed run doesn't leak a live agent.
    let purge_result = pictl.purge(&[&agent_id.0]).await;
    result.unwrap();
    purge_result.unwrap();
}

async fn run_against_agent(
    pictl: &Pictl,
    agent_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let probes = pictl.status(&[agent_id]).await?;
    let record = probes[0].record.as_ref().ok_or("agent has no record")?;

    // tty.sock: connect, receive the snapshot, and see typed input echoed
    // back as output.
    let (mut tty, mut tty_events) =
        TtyClient::connect(record.tty_socket_path(), "pictl-rs-integration", CONNECT_DEADLINE)
            .await?;
    tty.resize(TtyResize { cols: 80, rows: 24 }).await?;
    match step("tty snapshot", tty_events.next()).await {
        Some(Ok(TtyEvent::Snapshot(_))) => {}
        other => return Err(format!("expected snapshot first, got {other:?}").into()),
    }
    tty.input(b"hello tty").await?;
    loop {
        match step("tty output after input", tty_events.next()).await {
            Some(Ok(TtyEvent::Output(_))) => break,
            Some(Ok(_)) => continue,
            other => return Err(format!("expected output, got {other:?}").into()),
        }
    }

    // pi.sock: watcher starts Idle, a prompt drives Streaming, then back to
    // Idle when the turn completes.
    let mut watcher = ActivityWatcher::connect(record.pi_socket_path(), CONNECT_DEADLINE).await?;
    assert_eq!(watcher.current(), AgentActivity::Idle);
    let (rpc, _events) = PiSocketClient::connect(record.pi_socket_path(), CONNECT_DEADLINE).await?;
    rpc.request(RpcCommandKind::Prompt {
        message: "Reply with the single word: ok".to_owned(),
        images: None,
        streaming_behavior: None,
    })
    .await?;
    // The watch channel coalesces, so a fast turn can collapse
    // Streaming→Idle into one observed change: any transition sequence that
    // ends back at Idle passes (starting from Idle, a changed() returning
    // Idle proves the watcher left Idle in between).
    loop {
        match step("watcher settles back to Idle", watcher.changed()).await {
            AgentActivity::Idle => break,
            AgentActivity::Streaming | AgentActivity::Compacting => continue,
            AgentActivity::Disconnected => return Err("watcher disconnected".into()),
        }
    }
    Ok(())
}
