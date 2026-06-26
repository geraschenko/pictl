# pictl orchestration

Use this reference when writing scripts or workflows around `pictl`. For one-off agent interaction, the top-level skill is usually enough.

## General scripting rules

- Prefer machine-readable output: `list --json`, `status --json`, `prompt`/`tail --json`, and RPC command output. RPC commands already print JSON by default; use `--raw` only when you need the exact wire response.
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

## Fan out and wait

To run agents in parallel, fan out detached prompts, then wait for each. For a single agent you need none of this — just `prompt` and read its output.

Snapshot each agent's cursor before prompting, so afterward you can collect *everything* it did, not just its last message (a human may also be steering it, and the last message can omit crucial context):

```bash
starts=()
for a in "${agents[@]}"; do
  starts+=("$(pictl tail -t "$a" --json | tail -1 | jq -r .entryId)")
  pictl prompt -t "$a" "Do your part and report back." -d
done
# `tail --until turn-end` waits for each agent's turn to end, then prints
# everything it did since the snapshot. Indexes zip the two arrays.
for i in "${!agents[@]}"; do
  pictl tail -t "${agents[i]}" --since "${starts[i]}" --until turn-end
done
```

When you want the join signal without the output, use bare `pictl wait -t <agent> --until turn-end` instead.

Wait conditions (shared by `wait`, `tail --until`, and `prompt --until`):

- `turn-end`: the current or queued turn finished. Returns immediately if already idle, so `prompt -d` then `--until turn-end` is race-free.
- `idle`: not streaming and no queued messages.
- `no-activity:<secs>`: no socket events for that long, regardless of streaming state. Use for “possibly stuck” detection (`--timeout` bounds the wait).

Exit codes:

- `0`: condition met
- `1`: runtime error / agent dead
- `2`: usage error
- `3`: timeout (the condition was not reached; do not assume the task failed)

## Tail streams and cursors

`pictl tail` prints formatted output by default; scripts that parse it must add `--json`. A bounded message stream ends with a cursor record (`--json` form shown):

```json
{"type":"pictl_cursor","sessionId":"...","entryId":"..."}
```

```bash
pictl tail -t <agent> --json                  # current context, ends with a cursor
pictl tail -t <agent> --json --since "$CURSOR" # everything after a cursor
pictl tail -t <agent> --json --follow          # stream indefinitely
pictl tail -t <agent> --type raw               # raw socket events (always JSON)
```

The cursor is the durable place to resume from: `tail` gives you one, and `tail --since <entryId>` returns everything after it plus an updated cursor. This is how you check back asynchronously — fire `prompt -d`, do other work, then tail since the cursor you held:

```bash
start=$(pictl tail -t <agent> --json | tail -1 | jq -r .entryId)
pictl prompt -t <agent> "Long task; I'll check back." -d
# ... do other work ...
pictl tail -t <agent> --since "$start"
```

Persist the latest cursor record after each drain. For robust scripts persist both `sessionId` and `entryId`: entry ids are session-scoped, so an old id may not exist after a session change (`/new`, `/resume`, `fork`, `clone`, `switch-session`).

If `--since` fails with “entry not found”, the session probably changed. Good recovery options are:

- reset the cursor and drain the current session from the beginning;
- resync to the current tip and only process future entries;
- stop and ask the user.

Choose based on the workflow; pictl does not interweave old and new sessions for you.

## Minimal worker-drain pattern

This pattern blocks until the worker's turn ends, drains its new messages, saves the cursor record, and sends the drain to a supervisor. It requires `jq` for JSON parsing. Message streams end with a `pictl_cursor` record; entry streams do not, which is why the drain uses messages.

```bash
cursor_file="$STATE_DIR/worker-cursor.json"
messages_file="$STATE_DIR/worker-messages.jsonl"

since_args=()
if [ -s "$cursor_file" ]; then
  entry_id=$(jq -r '.entryId // empty' < "$cursor_file")
  if [ -n "$entry_id" ]; then
    since_args=(--since "$entry_id")
  fi
fi

pictl tail -t "$worker" --json --until turn-end "${since_args[@]}" > "$messages_file"

# The stream always ends with the cursor record.
tail -n1 "$messages_file" > "$cursor_file"

# Only notify when there were non-cursor messages.
if grep -v '"type":"pictl_cursor"' "$messages_file" >/dev/null; then
  pictl prompt -t "$supervisor" - < "$messages_file"
fi
```

## Prompting from scripts

`pictl prompt` emits a final cursor after the prompt's turn completes. Add `--json` when a script parses the stream:

```bash
pictl prompt -t "$agent" "Do the task and report completion." --json
```

Use `-d`/`--detach` when you only need to enqueue the prompt and return after acceptance.

Use stdin for structured or multi-line messages:

```bash
cat > "$state_dir/task.md" <<'EOF'
Please inspect the latest worker messages and decide what to do next.
Return either a command for the worker or a short status update.
EOF
pictl prompt -t "$agent" - < "$state_dir/task.md"
```

If the target might already be streaming, add `--streaming-behavior steer` or `follow-up` to avoid a check-then-act race.
