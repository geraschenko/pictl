---
name: pi-ctl
description: Use pi-ctl to discover, message, monitor, spawn, suspend, resume, and coordinate pi agent peers. Load this when asked to work with other agents, subagents, supervisors/workers, agent fleets, or pi-ctl orchestration.
---

# pi-ctl

`pi-ctl` controls long-lived pi agents. Use it to discover peers, send them work, monitor their progress, and spawn helper agents.

## Core rules

- Prefer `prompt`/`follow-up`/`steer` over interrupting an agent.
- Prefer `suspend` or `archive` over `purge`.
- Do **not** purge, force-kill, or take over agents you did not create unless the user explicitly asks.
- When spawning subagents, give them clear role instructions and tell them relevant agent ids, including your own `$PI_AGENT_ID` when set.
- Treat entry cursors as session-scoped: persist both `sessionId` and `entryId`.

## Identify yourself and discover agents

```bash
printf '%s\n' "$PI_AGENT_ID"          # your own agent id, if pi-ctl spawned you
pi-ctl list                         # human-readable list
pi-ctl list --json                  # machine-readable list
pi-ctl status <agent>               # details for one agent
```

`<agent>` accepts a full agent id or any unique prefix. Use tags, cwd, and status output to avoid confusing unrelated agents.

## Message another agent

Send a normal task when the peer is idle:

```bash
pi-ctl prompt <agent> "Please do X and report back." --and-wait
```

Read a longer prompt from stdin:

```bash
pi-ctl prompt <agent> - --and-wait < task.md
```

If the peer is busy, either queue a follow-up or explicitly choose streaming behavior:

```bash
pi-ctl follow-up <agent> "After your current turn, also check Y."
pi-ctl prompt <agent> "Do this next." --streaming-behavior follow-up
```

Use `steer` only for timely corrections during an active turn:

```bash
pi-ctl steer <agent> "Correction: use branch feature/foo, not main."
```

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

## Read session entries with durable cursors

`tail` emits JSONL. Normal entry records are followed by cursor records like:

```json
{"type":"pi_ctl_cursor","sessionId":"...","entryId":"..."}
```

Examples:

```bash
pi-ctl tail <agent>
pi-ctl tail <agent> --since "$ENTRY_ID"
pi-ctl tail <agent> --follow --until idle
pi-ctl tail <agent> --events --until no-activity:10
```

Persist both `sessionId` and `entryId`. If a saved cursor is rejected as “entry not found”, the agent likely changed sessions via `/new`, `/resume`, `fork`, or `clone`; reset the cursor or ask the user how to proceed.

## Spawn helper agents

```bash
worker=$(pi-ctl spawn --tag worker -- --approve)
pi-ctl prompt "$worker" "You are my worker agent. My agent id is ${PI_AGENT_ID:-unknown}. Please ..." --and-wait
```

Use `--tag` to make helpers discoverable. `-- --approve` passes pi's project-trust approval flag through to pi; use it only when appropriate for the current project/workflow.

## Lifecycle commands

Non-destructive:

```bash
pi-ctl suspend <agent>       # stop process; keep agent/session for revival
pi-ctl resume <agent>        # revive a dormant/archived agent
pi-ctl archive <agent>       # suspend and hide from normal list output
```

Destructive:

```bash
pi-ctl purge <agent>         # permanently delete after idle wait
pi-ctl purge <agent> --now   # abort current turn first, then delete
pi-ctl purge <agent> --force # last resort for wedged agents
```

Only purge agents you created or that the user explicitly told you to remove.

## Useful inspection and RPC commands

```bash
pi-ctl get-state <agent>
pi-ctl get-last-assistant-text <agent>
pi-ctl get-messages <agent>
pi-ctl get-session-stats <agent>
pi-ctl get-commands <agent>
```

Most RPC passthrough commands print response data as JSON. Add `--json` to print the raw RPC response record.

## Minimal worker-drain pattern

This pattern waits for a worker, drains new entries, saves the cursor record, and sends the drain to a supervisor. Adapt it rather than parsing human TUI output.

```bash
cursor_file="$STATE_DIR/worker-cursor.json"
entries_file="$STATE_DIR/worker-entries.jsonl"

since_args=()
if [ -s "$cursor_file" ]; then
  entry_id=$(jq -r '.entryId // empty' < "$cursor_file")
  if [ -n "$entry_id" ]; then
    since_args=(--since "$entry_id")
  fi
fi

pi-ctl wait "$worker" --until turn-end
pi-ctl tail "$worker" "${since_args[@]}" > "$entries_file"

grep '"type":"pi_ctl_cursor"' "$entries_file" | tail -1 > "$cursor_file"
# Only notify when there were non-cursor entries.
if grep -v '"type":"pi_ctl_cursor"' "$entries_file" >/dev/null; then
  pi-ctl prompt "$supervisor" - --and-wait < "$entries_file"
fi
```

If `jq` is unavailable, use another JSON parser; do not rely on fragile human-readable output for orchestration.
