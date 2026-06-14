# pi-ctl orchestration

Use this reference when writing scripts or workflows around `pi-ctl`. For one-off agent interaction, the top-level skill is usually enough.

## General scripting rules

- Prefer machine-readable output: `list --json`, `status --json`, RPC `--raw`, and `pi-ctl tail` JSONL.
- Do not parse the interactive TUI or human-readable `status` output in scripts.
- Persist enough state to restart safely: agent ids, role names, and any tail cursor.
- Make scripts idempotent: if an agent id already exists, reuse it.
- Consider a lock file for workflow state dirs so two copies of the same script do not race.

## Create or reuse agents

A simple state-dir pattern:

```bash
state_dir=${STATE_DIR:-.pi-ctl-workflow}
mkdir -p "$state_dir"

agent_file="$state_dir/worker.agent"
if [ -s "$agent_file" ] && pi-ctl status "$(cat "$agent_file")" >/dev/null 2>&1; then
  worker=$(cat "$agent_file")
else
  worker=$(pi-ctl spawn --tag worker -- --approve)
  printf '%s\n' "$worker" > "$agent_file"
fi
```

Commands that need the socket transparently revive dormant or archived agents.

## Wait conditions

```bash
pi-ctl wait <agent> --until turn-end
pi-ctl wait <agent> --until idle
pi-ctl wait <agent> --until no-activity:30 --timeout 120
```

- `turn-end`: the current or queued turn finishes. Good after sending a prompt.
- `idle`: the agent is not streaming and has no queued messages.
- `no-activity:<secs>`: no socket events for that long, regardless of streaming state. Use this for “possibly stuck” detection.

Exit codes:

- `0`: condition met
- `1`: runtime error / agent dead
- `2`: usage error
- `3`: timeout

## Tail entries and cursors

`pi-ctl tail` emits JSONL. It prints session entries and cursor records:

```json
{"type":"pi_ctl_cursor","sessionId":"...","entryId":"..."}
```

Examples:

```bash
pi-ctl tail <agent>
pi-ctl tail <agent> --since "$ENTRY_ID"
pi-ctl tail <agent> --follow
pi-ctl tail <agent> --follow --until idle
pi-ctl tail <agent> --events --until no-activity:10
```

Cursor records are the durable place to resume from. Persist the latest cursor record after each drain. For robust scripts, persist both `sessionId` and `entryId`: entry ids are session-scoped. Session changes are uncommon in simple worker scripts, but they can happen through `/new`, `/resume`, `fork`, or `clone`.

If `--since` fails with “entry not found”, the session probably changed. Good recovery options are:

- reset the cursor and drain the current session from the beginning;
- resync to the current tip and only process future entries;
- stop and ask the user.

Choose based on the workflow; pi-ctl does not interweave old and new sessions for you.

## Minimal worker-drain pattern

This pattern waits for a worker, drains new entries, saves the cursor record, and sends the drain to a supervisor. It requires `jq` for JSON parsing.

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

## Prompting from scripts

Use `--and-wait` when you only need to know that the turn completed:

```bash
pi-ctl prompt "$agent" "Do the task and report completion." --and-wait
```

If you need the agent's resulting entries as data, use a cursor: record the latest cursor before prompting, send the prompt, wait for completion, then drain entries since that cursor. Avoid treating `--and-wait` as if it returned the agent's new messages.

Use stdin for structured or multi-line messages:

```bash
cat > "$state_dir/task.md" <<'EOF'
Please inspect the latest worker entries and decide what to do next.
Return either a command for the worker or a short status update.
EOF
pi-ctl prompt "$agent" - --and-wait < "$state_dir/task.md"
```

If the target might already be streaming, avoid check-then-act races by using prompt's streaming behavior:

```bash
pi-ctl prompt "$agent" "Correction: use branch feature/foo." --streaming-behavior steer
pi-ctl prompt "$agent" "Queue this after the current turn." --streaming-behavior follow-up
```
