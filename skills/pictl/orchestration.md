# pictl orchestration

Use this reference when writing scripts or workflows around `pictl`. For one-off agent interaction, the top-level skill is usually enough.

## General scripting rules

- Prefer machine-readable output: `list --json`, `status --json`, prompt/tail JSONL, and RPC command output. RPC commands already print JSON by default; use `--raw` only when you need the exact wire response.
- Do not parse the interactive TUI or human-readable `status` output in scripts.
- Persist enough state to restart safely: agent ids, role names, and any tail cursor.
- Make scripts idempotent: if an agent id already exists, reuse it.
- Consider a lock file for workflow state dirs so two copies of the same script do not race.

## Create or reuse agents

A simple state-dir pattern:

```bash
state_dir=${STATE_DIR:-.pictl-workflow}
mkdir -p "$state_dir"

agent_file="$state_dir/worker.agent"
if [ -s "$agent_file" ] && pictl status "$(cat "$agent_file")" >/dev/null 2>&1; then
  worker=$(cat "$agent_file")
else
  worker=$(pictl spawn --tag worker -- --approve)
  printf '%s\n' "$worker" > "$agent_file"
fi
```

Commands that need the socket transparently revive dormant or archived agents.

## Wait conditions

```bash
pictl wait -t <agent> --until turn-end
pictl wait -t <agent> --until idle
pictl wait -t <agent> --until no-activity:30 --timeout 120
```

- `turn-end`: the current or queued turn finishes. Good after sending a prompt.
- `idle`: the agent is not streaming and has no queued messages.
- `no-activity:<secs>`: no socket events for that long, regardless of streaming state. Use this for “possibly stuck” detection.

Exit codes:

- `0`: condition met
- `1`: runtime error / agent dead
- `2`: usage error
- `3`: timeout

## Tail streams and cursors

`pictl tail` emits JSONL. Message mode is the default. Use `--type entries` for raw session entries or `--type raw` for future socket records. Bounded message/entry streams end with a cursor record:

```json
{"type":"pictl_cursor","sessionId":"...","entryId":"..."}
```

Examples:

```bash
pictl tail -t <agent>
pictl tail -t <agent> --since "$ENTRY_ID"
pictl tail -t <agent> --type entries --since "$ENTRY_ID"
pictl tail -t <agent> --follow
pictl tail -t <agent> --until idle
pictl tail -t <agent> --type raw
```

Cursor records are the durable place to resume from. Persist the latest cursor record after each drain. For robust scripts, persist both `sessionId` and `entryId`: entry ids are session-scoped. Session changes are uncommon in simple worker scripts, but they can happen through `/new`, `/resume`, `fork`, or `clone`.

If `--since` fails with “entry not found”, the session probably changed. Good recovery options are:

- reset the cursor and drain the current session from the beginning;
- resync to the current tip and only process future entries;
- stop and ask the user.

Choose based on the workflow; pictl does not interweave old and new sessions for you.

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

pictl wait -t "$worker" --until turn-end
pictl tail -t "$worker" --type entries "${since_args[@]}" > "$entries_file"

grep '"type":"pictl_cursor"' "$entries_file" | tail -1 > "$cursor_file"

# Only notify when there were non-cursor entries.
if grep -v '"type":"pictl_cursor"' "$entries_file" >/dev/null; then
  pictl prompt -t "$supervisor" - < "$entries_file"
fi
```

## Prompting from scripts

`pictl prompt` streams JSONL by default and emits a final cursor after the prompt's turn completes:

```bash
pictl prompt -t "$agent" "Do the task and report completion."
```

Use `--type detach` when you only need to enqueue the prompt and return after acceptance:

```bash
pictl prompt -t "$agent" "Do the task and report completion." --type detach
```

If you need entry-shaped data instead of message-shaped data, request entries directly:

```bash
pictl prompt -t "$agent" "Do the task and report completion." --type entries
```

Use stdin for structured or multi-line messages:

```bash
cat > "$state_dir/task.md" <<'EOF'
Please inspect the latest worker entries and decide what to do next.
Return either a command for the worker or a short status update.
EOF
pictl prompt -t "$agent" - < "$state_dir/task.md"
```

If the target might already be streaming, avoid check-then-act races by using prompt's streaming behavior:

```bash
pictl prompt -t "$agent" "Correction: use branch feature/foo." --streaming-behavior steer
pictl prompt -t "$agent" "Queue this after the current turn." --streaming-behavior follow-up
```
