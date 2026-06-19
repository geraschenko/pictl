---
name: pictl
description: Use pictl to discover, message, monitor, spawn, suspend, resume, and coordinate pi agent peers. Load this when asked to work with other agents, peer reviewers, supervisors/workers, agent fleets, or pictl orchestration.
---

# pictl

`pictl` controls long-lived pi agents. Use it to discover peers, send them work, monitor progress, and spawn helper agents.

For scripting/orchestration details, read [references/orchestration.md](references/orchestration.md). For reviewer agents, read [references/reviewer.md](references/reviewer.md). For RPC command gotchas, read [references/rpc-details.md](references/rpc-details.md).

## Core rules

- Do **not** purge, force-kill, or take over agents you did not create unless the user explicitly asks.
- When spawning subagents, give them clear role instructions and tell them relevant agent ids, including your own `$PI_AGENT_ID`.
- Spawn review agents read-only by default (`-- --tools read,grep,find,ls`) unless tests or edits are explicitly needed.
- Prefer `pictl prompt -t ... --streaming-behavior ...` over raw `steer`/`follow-up`; it avoids races when the target's streaming state changes.
- `pictl prompt` streams JSONL by default and emits a final cursor. Use `--type detach` only when you want to send the prompt and return after acceptance without output.
- Use machine-readable output for scripts (`list --json`, `status --json`, prompt/tail JSONL, RPC command output); do not parse human TUI text.

## Identify yourself and discover nearby agents

Agents commonly need peers working in the same directory:

```bash
echo "$PI_AGENT_ID"         # your own agent id, if pictl spawned you
pictl list --cwd .          # human-readable agents in this cwd
pictl list --cwd . --json   # machine-readable agents in this cwd
pictl status -t <agent>        # details for one agent
```

`<agent>` accepts a full agent id or any unique prefix. Use cwd, tags, and status output to avoid confusing unrelated agents.

## Message another agent

Send a normal task, stream its activity as JSONL, and get a final cursor:

```bash
pictl prompt -t <agent> "Please do X and report back."
```

Send without streaming output:

```bash
pictl prompt -t <agent> "Please do X and report back." --type detach
```

Read a longer prompt from stdin:

```bash
pictl prompt -t <agent> - < task.md
```

If the peer is busy, `prompt` will return an error by default. If you want to queue the prompt, choose what should happen explicitly:

```bash
# Timely correction to the active turn if it is streaming; normal prompt otherwise.
pictl prompt -t <agent> "Correction: use branch feature/foo, not main." --streaming-behavior steer

# Queue this as the next turn if the agent is streaming; normal prompt otherwise.
pictl prompt -t <agent> "After your current turn, also check Y." --streaming-behavior follow-up
```

Use raw `pictl steer` and `pictl follow-up` only when you deliberately want those exact RPC commands. In most cases, `prompt --streaming-behavior ...` is safer.

Abort only when necessary:

```bash
pictl abort -t <agent>
```

## Wait for progress

```bash
pictl wait -t <agent> --until turn-end
pictl wait -t <agent> --until idle
pictl wait -t <agent> --until no-activity:30 --timeout 120
```

- `turn-end`: the current or queued turn finished.
- `idle`: not streaming and no queued messages.
- `no-activity:<secs>`: no socket events for that long, even if the agent is not idle; useful for stalled UI/tool waits.

Exit code `3` means `--timeout` expired. Do not assume the task failed; the condition simply was not reached in time.

## Check what happened

For casual inspection:

```bash
pictl get-state -t <agent>
pictl get-last-assistant-text -t <agent>
pictl get-messages -t <agent>
pictl get-session-stats -t <agent>
```

For continuous or crash-resumable scripts, use `pictl tail`; see [references/orchestration.md](references/orchestration.md).

## Spawn helper agents

```bash
worker=$(pictl spawn --tag worker)
pictl prompt -t "$worker" "You are my worker agent. My agent id is $PI_AGENT_ID. Please ..."
```

Use `--tag` to make helpers discoverable. For fresh-context peer review, use the reviewer branch in [references/reviewer.md](references/reviewer.md).

## When you are done with an agent

Archive agents you created when you are done with them:

```bash
pictl archive -t <agent>
```

`archive` waits until the agent is idle, stops its process, and hides it from normal `pictl list` output. Archived agents are still visible with `pictl list --all` and are revived automatically if you interact with them later.

Only use destructive lifecycle commands such as `purge` when the user explicitly tells you to remove an agent permanently.
