use std::os::unix::fs::PermissionsExt;

use super::*;
use crate::agent_probe::AgentStatus;

/// Writes a fake `pictl` executable that records its argv and prints a
/// canned stdout, so arg construction and output parsing are testable
/// without a real pictl.
async fn fake_pictl(dir: &std::path::Path, stdout: &str, exit_code: i32) -> (Pictl, PathBuf) {
    let bin = dir.join("pictl");
    let argv_file = dir.join("argv");
    let stdout_file = dir.join("stdout");
    tokio::fs::write(&stdout_file, stdout).await.unwrap();
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > {argv}\ncat {stdout}\nexit {exit_code}\n",
        argv = argv_file.display(),
        stdout = stdout_file.display(),
    );
    tokio::fs::write(&bin, script).await.unwrap();
    tokio::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))
        .await
        .unwrap();
    // ETXTBSY guard: a parallel test's fork can briefly inherit this
    // script's write fd, making exec fail with ExecutableFileBusy until
    // that child execs. Probe until the script is runnable so the test
    // body never sees the race (the probe's argv write is overwritten by
    // the real invocation).
    loop {
        match Command::new(&bin).output().await {
            Ok(_) => break,
            Err(err) if err.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                tokio::task::yield_now().await;
            }
            Err(err) => panic!("fake pictl probe failed: {err}"),
        }
    }
    (Pictl::with_bin(bin), argv_file)
}

async fn recorded_argv(argv_file: &std::path::Path) -> Vec<String> {
    tokio::fs::read_to_string(argv_file)
        .await
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn spawn_builds_args_and_parses_id() {
    let dir = tempfile::tempdir().unwrap();
    let (pictl, argv_file) = fake_pictl(dir.path(), "my-agent\n", 0).await;
    let opts = SpawnOptions {
        cwd: Some(PathBuf::from("/work")),
        id: Some(AgentId("my-agent".to_owned())),
        tag: Some("t1".to_owned()),
        pi_args: vec!["--no-extensions".to_owned()],
    };
    let agent_id = pictl.spawn(&opts).await.unwrap();
    assert_eq!(agent_id, AgentId("my-agent".to_owned()));
    assert_eq!(
        recorded_argv(&argv_file).await,
        ["spawn", "--cwd", "/work", "--id", "my-agent", "--tag", "t1", "--", "--no-extensions"]
    );
}

#[tokio::test]
async fn list_parses_probes_and_socket_paths() {
    let dir = tempfile::tempdir().unwrap();
    let probes_json = serde_json::json!([{
        "agentId": "agent-1",
        "status": "compacting",
        "record": {
            "id": "agent-1",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "cwd": "/tmp",
            "piBin": "/usr/bin/pi",
            "spawnArgs": [],
            "daemonPid": 100,
            "piPid": 101,
            "sessions": [{"sessionFile": "/tmp/s.jsonl", "sessionId": "s1"}],
            "attachments": [{"pid": 7, "client": "pictl attach", "connectedAt": "2026-01-01T00:00:01.000Z", "size": {"cols": 80, "rows": 24}}],
            "agentDir": "/home/u/.pictl/agent-1"
        },
        "state": {
            "thinkingLevel": "off", "isStreaming": true, "isCompacting": true,
            "steeringMode": "all", "followUpMode": "one-at-a-time",
            "sessionId": "s1", "autoCompactionEnabled": true,
            "messageCount": 4, "pendingMessageCount": 0
        }
    }, {
        "agentId": "agent-2",
        "status": "unreachable",
        "error": "connect ECONNREFUSED"
    }])
    .to_string();
    let (pictl, argv_file) = fake_pictl(dir.path(), &probes_json, 0).await;
    let probes = pictl.list(true).await.unwrap();
    assert_eq!(recorded_argv(&argv_file).await, ["list", "--json", "--all"]);
    assert_eq!(probes.len(), 2);
    assert_eq!(probes[0].status, AgentStatus::Compacting);
    let record = probes[0].record.as_ref().unwrap();
    assert_eq!(
        record.pi_socket_path(),
        PathBuf::from("/home/u/.pictl/agent-1/pi.sock")
    );
    assert_eq!(
        record.tty_socket_path(),
        PathBuf::from("/home/u/.pictl/agent-1/tty.sock")
    );
    assert!(probes[0].state.as_ref().unwrap().is_compacting);
    assert_eq!(probes[1].status, AgentStatus::Unreachable);
    assert!(probes[1].record.is_none());
}

#[tokio::test]
async fn wait_maps_exit_codes() {
    let dir = tempfile::tempdir().unwrap();
    let (pictl, argv_file) = fake_pictl(dir.path(), "", 3).await;
    let result = pictl
        .wait(
            "agent-1",
            UntilCondition::NoActivity(Duration::from_millis(1500)),
            Some(Duration::from_secs(10)),
        )
        .await;
    assert!(matches!(result, Err(Error::Timeout)));
    assert_eq!(
        recorded_argv(&argv_file).await,
        ["wait", "--target", "agent-1", "--until", "no-activity:1.5", "--timeout", "10"]
    );

    let failure_dir = tempfile::tempdir().unwrap();
    let (pictl, _) = fake_pictl(failure_dir.path(), "", 1).await;
    let result = pictl.wait("agent-1", UntilCondition::Idle, None).await;
    assert!(matches!(result, Err(Error::Cli { status: Some(1), .. })));
}

#[tokio::test]
async fn multi_target_verbs_pass_all_targets() {
    let dir = tempfile::tempdir().unwrap();
    let (pictl, argv_file) = fake_pictl(dir.path(), "", 0).await;
    pictl.suspend(&["a", "b"]).await.unwrap();
    assert_eq!(
        recorded_argv(&argv_file).await,
        ["suspend", "--target", "a", "--target", "b"]
    );
}
