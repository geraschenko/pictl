# pictl RPC details and gotchas

Use this reference when you need exact command behavior beyond the top-level pictl skill.

## Always use `prompt`, never raw `steer`/`follow-up`

`pictl prompt` streams the turn's activity on the same socket used to send the prompt, avoiding subscription races and returning a final cursor. When the target may be streaming, add `--streaming-behavior steer|follow-up` rather than checking status and then calling a raw command: that check-then-act is a race (the target may finish in between), while pi decides atomically — normal prompt if idle, steer/follow-up if streaming.

`pictl steer` and `pictl follow-up` exist for exact RPC use but are almost never the right choice.

Use `--until` for a stop condition other than turn end:

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
