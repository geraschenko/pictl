---
name: pi-ctl
description: Use pi-ctl to discover, message, monitor, spawn, suspend, resume, and coordinate pi agent peers. Load this when asked to work with other agents, subagents, supervisors/workers, agent fleets, or pi-ctl orchestration.
---

# pi-ctl

`pi-ctl` controls long-lived pi agents. Use it to discover peers, send them work, monitor progress, and spawn helper agents.

For scripting/orchestration details, read [references/orchestration.md](references/orchestration.md). For RPC command gotchas, read [references/rpc-details.md](references/rpc-details.md).

## Core rules

- Do **not** purge, force-kill, or take over agents you did not create unless the user explicitly asks.
- When spawning subagents, give them clear role instructions and tell them relevant agent ids, including your own `$PI_AGENT_ID`.
- Prefer `pi-ctl prompt ... --streaming-behavior ...` over raw `steer`/`follow-up`; it avoids races when the target's streaming state changes.
- Use machine-readable output for scripts (`list --json`, `status --json`, RPC `--raw`, `tail`); do not parse human TUI text.

## Identify yourself and discover nearby agents

Agents commonly need peers working in the same directory:

```bash
echo "$PI_AGENT_ID"          # your own agent id, if pi-ctl spawned you
pi-ctl list --cwd .          # human-readable agents in this cwd
pi-ctl list --cwd . --json   # machine-readable agents in this cwd
pi-ctl status <agent>        # details for one agent
```

`<agent>` accepts a full agent id or any unique prefix. Use cwd, tags, and status output to avoid confusing unrelated agents.

## Message another agent

Send a normal task and wait for that turn to finish:

```bash
pi-ctl prompt <agent> "Please do X and report back." --and-wait
```

Read a longer prompt from stdin:

```bash
pi-ctl prompt <agent> - --and-wait < task.md
```

If the peer might be busy, choose what should happen explicitly:

```bash
# Timely correction to the active turn if it is streaming; normal prompt otherwise.
pi-ctl prompt <agent> "Correction: use branch feature/foo, not main." --streaming-behavior steer

# Queue this as the next turn if the agent is streaming; normal prompt otherwise.
pi-ctl prompt <agent> "After your current turn, also check Y." --streaming-behavior follow-up
```

Use raw `pi-ctl steer` and `pi-ctl follow-up` only when you deliberately want those exact RPC commands. In most cases, `prompt --streaming-behavior ...` is safer.

Abort only when necessary:

```bash
pi-ctl abort <agent>
```

## Wait for progress

```bash
pi-ctl wait <agent> --until turn-end
pi-ctl wait <agent> --until idle
pi-ctl wait <agent> --until no-activity:30 --timeout 120
```

- `turn-end`: the current or queued turn finished.
- `idle`: not streaming and no queued messages.
- `no-activity:<secs>`: no socket events for that long, even if the agent is not idle; useful for stalled UI/tool waits.

Exit code `3` means `--timeout` expired. Do not assume the task failed; the condition simply was not reached in time.

## Check what happened

For casual inspection:

```bash
pi-ctl get-state <agent>
pi-ctl get-last-assistant-text <agent>
pi-ctl get-messages <agent>
pi-ctl get-session-stats <agent>
```

For continuous or crash-resumable scripts, use `pi-ctl tail`; see [references/orchestration.md](references/orchestration.md).

Most RPC passthrough commands print response data as JSON. Add `--raw` to print the raw RPC response record.

## Spawn helper agents

```bash
worker=$(pi-ctl spawn --tag worker -- --approve)
pi-ctl prompt "$worker" "You are my worker agent. My agent id is $PI_AGENT_ID. Please ..." --and-wait
```

Use `--tag` to make helpers discoverable.

## When you are done with an agent

Archive agents you created when you are done with them:

```bash
pi-ctl archive <agent>
```

`archive` waits until the agent is idle, stops its process, and hides it from normal `pi-ctl list` output. Archived agents are still visible with `pi-ctl list --all` and are revived automatically if you interact with them later.

Only use destructive lifecycle commands such as `purge` when the user explicitly tells you to remove an agent permanently.
