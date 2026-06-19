# pictl RPC details and gotchas

Use this reference when you need exact command behavior beyond the top-level pictl skill.

## `prompt` vs `steer` vs `follow-up`

Prefer `prompt` for most messaging.

```bash
pictl prompt <agent> "Do this."
```

When the target may be streaming, use `prompt --streaming-behavior` instead of checking status and then choosing a raw command:

```bash
pictl prompt <agent> "Correction: use branch feature/foo." --streaming-behavior steer
pictl prompt <agent> "After this turn, also check Y." --streaming-behavior follow-up
```

Why: checking whether an agent is streaming and then calling raw `steer` or `follow-up` is a race. The target may finish between your check and your send. `prompt --streaming-behavior ...` lets pi decide atomically:

- if idle, it behaves like a normal prompt;
- if streaming, it becomes a steer or follow-up according to the flag.

Raw commands still exist for exact RPC use:

```bash
pictl steer <agent> "Interject into the current turn."
pictl follow-up <agent> "Queue this after the current turn."
```

Use them only when you deliberately want those exact semantics.

## Waiting after prompting

`pictl prompt` waits on the same socket connection used to send the prompt. This is the recommended one-shot form because it avoids subscription races.

```bash
pictl prompt <agent> "Do X."
```

Equivalent two-step usage is usually fine too:

```bash
pictl prompt <agent> "Do X."
pictl wait <agent> --until turn-end
```

Use `--and-wait-until` when you want a condition other than turn end:

```bash
pictl prompt <agent> "Start investigating." --and-wait-until no-activity:30
```

## Abort etiquette

`abort` interrupts the current turn. Prefer sending a correction first:

```bash
pictl prompt <agent> "Correction: stop editing foo; inspect bar instead." --streaming-behavior steer
```

Use abort when continuing the current turn is harmful or wasteful:

```bash
pictl abort <agent>
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
pictl get-state <agent>                 # model, streaming state, pending count, session info
pictl get-last-assistant-text <agent>   # text of the last assistant message
pictl get-messages <agent>              # full message history
pictl get-entries <agent>               # session entries
pictl get-tree <agent>                  # session entry tree
pictl get-session-stats <agent>         # token/cost stats
pictl get-commands <agent>              # slash commands available to prompt
```

Most passthrough commands print response data as JSON. Add `--raw` for the raw RPC response record.
