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
* If you don't set `$PICTL_TARGET`, commands that require a target need `--target PREFIX` or `-t PREFIX`. Any unique prefix of the agent id is accepted.
* If you want to pass extra args to `pi`, put them after `--` when you spawn the agent, like this: `pictl spawn -- -e my_extension.ts`

**Attach to the TUI** in another terminal if you want to follow along in "regular pi view" (recommended).

```sh
pictl attach --target <PREFIX_OF_PICTL_TARGET>
```

* You can detach with `ctrl+]`. Detaching does not stop the agent.
* You can also exit with `ctrl+d` as usual, which _does_ stop the agent since it forwards the exit command to the pi process. But it'll be automatically revived when any commands are sent to it. When it's revived, the same cwd and arguments to pi are used that were used when it was first created.

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

* For all available RPC commands, see pi's [`rpc-types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts), or run `pictl -H`. The tweaked version of pi used by `pictl` also includes the commands `get-entries`, `get-tree`, and `navigate-tree`, which stock pi does not.
* The help also includes details about subcommand arguments, e.g. `pictl set-model -H` to learn about arguments of `set-model`.

**Manage your agents**

```sh
pictl list [--all] [--cwd PATH]

# Non-destructive. Shuts down processes and removes from default `pictl list`.
pictl archive -t <PREFIX_OF_PICTL_TARGET>

# Destructive. Deletes file from registry.
pictl purge -t <PREFIX_OF_PICTL_TARGET>
```

* The actual session messages live in your `~/.pi` as usual.
* `pictl`'s agent registry lives in files in `~/.config/pictl`

**Setup tab completion** with `pictl completion install` (bash only).

## `pictl format`, `pictl tail`

TODO: explain these

## Further reading

These documents are meant to answer different questions:

- **How does pictl work?** See [`docs/architecture.md`](docs/architecture.md) for details about the agent registry, command and tty sockets, daemon processes, and how I expect pictl to interact with other languages.

- **Tweaks to pi.** See [`docs/pi-modifications.md`](docs/pi-modifications.md) for details about the tweaked version of pi `pictl` depends on, especially `--rpc-socket` mode.
