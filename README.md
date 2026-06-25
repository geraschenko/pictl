# pictl

`pictl` is a CLI orchestration tool for pi coding-agent instances. It aims to let humans, scripts, and agents interact with live pi instances in a unified way.

## Installation

```sh
npm install -g github:geraschenko/pictl
```

Check that `pictl` is now on your `PATH`:

```sh
pictl --version
```

## Quickstart

**Start an agent** and make it the default target for subsequent commands:

```sh
export PICTL_TARGET="$(pictl spawn)"
echo "$PICTL_TARGET"
```

- If you don't set `$PICTL_TARGET`, commands that require a target need `--target PREFIX` or `-t PREFIX`. Any unique prefix of the agent id is accepted.
- If you want to pass extra args to `pi`, put them after `--` when you spawn the agent, like this: `pictl spawn -- -e my_extension.ts`

**Attach to the TUI** in another terminal if you want to follow along in "regular pi view" (recommended).

```sh
pictl attach --target <PREFIX_OF_PICTL_TARGET>
```

- You can detach with `ctrl+]`. Detaching does not stop the agent.
- You can also exit with `ctrl+d` as usual, which _does_ stop the agent since it forwards the exit command to the pi process. But it'll be automatically revived when any commands are sent to it. When it's revived, the same cwd and arguments to pi are used that were used when it was first created.

**Send commands** to the agent with `prompt` and pi's other RPC commands. Do this from the first terminal (or wherever you've set `PICTL_TARGET`):

```sh
pictl prompt "Say hello. Keep it short"
pictl set-model anthropic claude-opus-4-8

# Note: compaction will fail if the session is already tiny.
pictl compact --custom-instructions "Next we're going to say goodbye. Only keep context relevant to that task."
pictl get-entries

# Note: you have to use a real entry id from your actual session here; see the output from get-entries.
pictl navigate-tree 8c5cb595
```

- For all available RPC commands, see pi's [`rpc-types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts), or run `pictl -H`. The tweaked version of pi used by `pictl` also includes the commands `get-entries`, `get-tree`, and `navigate-tree`, which stock pi does not.
- The help also includes details about subcommand arguments, e.g. `pictl set-model -H` to learn about arguments of `set-model`.

**Manage your agents**

```sh
pictl list [--all] [--cwd PATH]

# Non-destructive. Shuts down processes and removes from default `pictl list`.
pictl archive -t <PREFIX_OF_PICTL_TARGET>

# Destructive. Deletes file from registry.
pictl purge -t <PREFIX_OF_PICTL_TARGET>
```

- The actual session messages live in your `~/.pi` as usual.
- `pictl`'s agent registry lives in your per-OS user data dir (`~/.local/share/pictl` on Linux), or wherever `$PICTL_DIR` points if you set it.

**Setup tab completion** with `pictl completion install` (bash only).

## Watching activity: `pictl prompt`, `pictl tail`, `pictl format`

`pictl prompt` and `pictl tail` both stream a live agent's activity. `prompt`
sends a message and streams the resulting turn; `tail` streams an existing
agent's activity without sending anything. Both print **human-readable,
formatted output by default**.

**Choose what to stream** with `--type`:

- `--type messages` (default) — one block per message (and per control event
  like compaction), the same rendering as `pictl format messages`.
- `--type entries` — one line per session entry (`<id> <role> <summary>`), the
  same rendering as `pictl format entries`.
- `--type raw` — raw pi socket events, one JSON object per line. (`raw` is
  inherently JSON, so `--json` is a no-op for it.)

```sh
pictl prompt "Say hi"          # formatted messages, then a final cursor
pictl tail                     # formatted messages from a running agent
pictl tail --type entries      # one line per entry
pictl tail --type raw          # raw socket events
```

**Get machine-readable JSONL** with `--json`. This is exactly the output that
older `pictl` versions printed by default, and it is meant for piping into
`pictl format` (for finer control than `prompt`/`tail` expose) or into your own
tooling:

```sh
# Fine-grained formatting that prompt/tail don't expose directly:
pictl prompt --json "Say hi" | pictl format messages --tool-results full
pictl tail --type entries --json | pictl format entries --timestamps

# pictl format also has a `tree` renderer for the entry tree:
pictl get-tree | pictl format tree
```

For a **finite** message stream, the default formatted output is byte-identical
to its `--json` output piped through `pictl format messages` — the trailing
`[cursor: …]` line is preserved so you can resume from it.

**`pictl tail --since <entry-id>`** starts the stream just after a given entry
instead of from the beginning of history — handy for resuming from a cursor you
saw earlier. (`--since` does not apply to `--type raw`, which has no backlog.)

**`pictl prompt -d`/`--detach`** sends the prompt and returns immediately
without streaming. `--type`/`--json` are ignored (there is nothing to print),
and combining `--detach` with `--until` or `--timeout` is an error.

```sh
pictl prompt -d "Go work on the thing"
```

## Further reading

These documents are meant to answer different questions:

- **How does pictl work?** See [`docs/architecture.md`](docs/architecture.md) for details about the agent registry, command and tty sockets, daemon processes, and how I expect pictl to interact with other languages.

- **Tweaks to pi.** See [`docs/pi-modifications.md`](docs/pi-modifications.md) for details about the tweaked version of pi `pictl` depends on, especially `--rpc-socket` mode.
