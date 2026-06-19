# pictl RPC details and gotchas

Use this reference when you need exact command behavior beyond the top-level pictl skill.

## `prompt` vs `steer` vs `follow-up`

Prefer `prompt` for most messaging.

```bash
pictl prompt -t <agent> "Do this."
```

When the target may be streaming, use `prompt --streaming-behavior` instead of checking status and then choosing a raw command:

```bash
pictl prompt -t <agent> "Correction: use branch feature/foo." --streaming-behavior steer
pictl prompt -t <agent> "After this turn, also check Y." --streaming-behavior follow-up
```

Why: checking whether an agent is streaming and then calling raw `steer` or `follow-up` is a race. The target may finish between your check and your send. `prompt --streaming-behavior ...` lets pi decide atomically:

- if idle, it behaves like a normal prompt;
- if streaming, it becomes a steer or follow-up according to the flag.

Raw commands still exist for exact RPC use:

```bash
pictl steer -t <agent> "Interject into the current turn."
pictl follow-up -t <agent> "Queue this after the current turn."
```

Use them only when you deliberately want those exact semantics.

## Prompt streaming and waiting

`pictl prompt` streams JSONL on the same socket connection used to send the prompt. This is the recommended one-shot form because it avoids subscription races and returns the activity plus a final cursor.

```bash
pictl prompt -t <agent> "Do X."
```

Equivalent two-step usage is available when you do not need prompt output:

```bash
pictl prompt -t <agent> "Do X." --type detach
pictl wait -t <agent> --until turn-end
```

Use `--until` when you want a stop condition other than turn end:

```bash
pictl prompt -t <agent> "Start investigating." --until no-activity:30
```

## Abort etiquette

`abort` interrupts the current turn. Prefer sending a correction first:

```bash
pictl prompt -t <agent> "Correction: stop editing foo; inspect bar instead." --streaming-behavior steer
```

Use abort when continuing the current turn is harmful or wasteful:

```bash
pictl abort -t <agent>
```

## Lifecycle command meanings

- `suspend`: wait until idle, stop the process, keep the agent/session for later revival.
- `archive`: suspend and hide from normal `list` output; still resumable.
- `resume`: revive a dormant or archived agent on its latest existing session.
- `purge`: permanently delete the agent directory after an idle wait.
- `purge --now`: abort current turn first, then wait for idle and delete.
- `purge --force`: SIGKILL and delete; last resort for wedged agents.

Do not purge agents you did not create unless the user explicitly instructs you to.

## Dormant and archived agents

Most commands that need the socket transparently revive dormant or archived agents before proceeding. `list`, `status`, `gc`, and `wait` do not revive:

- `list`/`status` are inspection-only;
- `gc` only removes tombstoned or corrupt dirs;
- `wait` treats dormant/archived agents as already doing no work.

## Tail cursors are session-scoped

`pictl tail` cursor records include both `sessionId` and `entryId`:

```json
{"type":"pictl_cursor","sessionId":"...","entryId":"..."}
```

In simple usage, saving only `entryId` often works. For robust orchestration, save both. If the session changes, an old entry id may not exist in the new session and `tail --since` can fail with “entry not found”.

Session changes can happen via `/new`, `/resume`, `fork`, `clone`, or `switch-session`.

## Useful passthrough commands

```bash
pictl get-state -t <agent>                 # model, streaming state, pending count, session info
pictl get-last-assistant-text -t <agent>   # text of the last assistant message
pictl get-messages -t <agent>              # full message history
pictl get-entries -t <agent>               # session entries
pictl get-tree -t <agent>                  # session entry tree
pictl get-session-stats -t <agent>         # token/cost stats
pictl get-commands -t <agent>              # slash commands available to prompt
```

Most passthrough commands print response data as JSON. Add `--raw` for the raw RPC response record.
