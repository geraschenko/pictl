---
name: pictl
description: Use pictl to coordinate pi agent peers: discover, message, monitor, spawn, suspend, resume, review, and orchestrate agents.
---

`pictl` controls long-lived pi agents.

Read branch references as needed:
[orchestration](orchestration.md)
[fresh-context reviewers](reviewer.md)
[conversation tree navigation](tree-navigation.md)
[RPC gotchas](rpc-details.md).

## Core rules

- Do **not** purge, force-kill, or take over agents you did not create unless the user explicitly asks.
- When spawning subagents, give them clear role instructions and tell them relevant agent ids, including your own `$PI_AGENT_ID`.
- Spawn review agents read-only by default (`-- --tools read,grep,find,ls`) unless edits or tests are explicitly needed.
- Always message with `pictl prompt`, never raw `steer`/`follow-up`. For a single agent, `prompt` and read its streamed output; you do not need `-d` or `wait`.
- `pictl prompt` streams formatted output by default and emits a final cursor. Add `--json` for machine-readable JSONL.
- Use machine-readable output for scripts (`list --json`, `status --json`, `prompt`/`tail --json`, RPC command output); do not parse human TUI text.

## Identify yourself and discover nearby agents

Agents commonly need peers working in the same directory:

```bash
echo "$PI_AGENT_ID"         # your own agent id, if pictl spawned you
pictl list --cwd .          # human-readable agents in this cwd
pictl list --cwd . --json   # machine-readable agents in this cwd
pictl status -t <agent>     # details for one agent
```

`<agent>` accepts a full agent id or any unique prefix. Use cwd, tags, and status output to avoid confusing unrelated agents.

## Message another agent

Send a task and stream its activity, ending with a final cursor:

```bash
pictl prompt -t <agent> "Please do X and report back."
pictl prompt -t <agent> - < task.md      # longer prompt from stdin
```

If the peer is busy, `prompt` errors by default. To queue instead, say what should happen:

```bash
# Correct the active turn if it is streaming; normal prompt otherwise.
pictl prompt -t <agent> "Correction: use branch feature/foo, not main." --streaming-behavior steer

# Queue as the next turn if the agent is streaming; normal prompt otherwise.
pictl prompt -t <agent> "After your current turn, also check Y." --streaming-behavior follow-up
```

Abort only when continuing the turn is harmful or wasteful:

```bash
pictl abort -t <agent>
```

To prompt several agents at once and wait for them, or to fire a prompt and check back later, see [orchestration](orchestration.md).

## Check what happened

For casual inspection:

```bash
pictl get-state -t <agent>
pictl get-last-assistant-text -t <agent>
pictl get-messages -t <agent>
pictl get-session-stats -t <agent>
```

For continuous or crash-resumable scripts, use `pictl tail`; see [orchestration.md](orchestration.md).

## Spawn helper agents

```bash
worker=$(pictl spawn --tag worker)
pictl prompt -t "$worker" "You are my worker agent. My agent id is $PI_AGENT_ID. Please ..."
```

Use `--tag` to make helpers discoverable. For fresh-context peer review, use [reviewer.md](reviewer.md). For conversation-tree rewinds, use [tree-navigation.md](tree-navigation.md).

## When you are done with an agent

Archive agents you created when you are done with them:

```bash
pictl archive -t <agent>
```

`archive` waits until the agent is idle, stops its process, and hides it from normal `pictl list` output. Archived agents are still visible with `pictl list --all` and are revived automatically if you interact with them later.

Only use destructive lifecycle commands such as `purge` when the user explicitly tells you to remove an agent permanently.
