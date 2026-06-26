# `pictl`: a pi agent orchestration CLI

There are many agent orchestration tools. This one is mine. `pictl` aims to let humans, agents, scripts, and code interact with live pi instances _simultaneously_, each on their own terms. Humans can attach with the stock pi TUI, and agents/scripts get ergonomic (but unfettered) access to the RPC interface. You don't have to give up your `/tree`, and they aren't forced to `tmux capture-pane`.

## Installation

```sh
npm install -g github:geraschenko/pictl
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
pictl set-model openai-codex gpt-5.5

# Note: compaction will fail if the session is already tiny.
pictl compact --custom-instructions "Next we're going to say goodbye. Only keep context relevant to that task."

# RPC pass-through commands (except for `prompt`) return json. `pictl format`
# can prettify the responses from `get-messages`, `get-entries`, and `get-tree`.
pictl get-entries | pictl format entries

# Note: you have to use a real entry id from your actual session here;
# see the output from `get-entries` above.
pictl navigate-tree 8c5cb595
```

> [!NOTE]
> - For all available RPC commands, see pi's [`rpc-types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts), or run `pictl -H`. The tweaked version of pi used by `pictl` also includes the commands `get-entries`, `get-tree`, and `navigate-tree`, which stock pi does not.
> - The help also includes details about subcommand arguments, e.g. `pictl set-model -H` to learn about arguments of `set-model`.

**Manage your agents**

```sh
pictl list [--all] [--cwd PATH]

# Non-destructive. Shuts down processes and removes from default `pictl list`.
pictl archive -t <PREFIX_OF_PICTL_TARGET>

# Destructive. Deletes file from registry.
pictl purge -t <PREFIX_OF_PICTL_TARGET>
```

> [!NOTE]
> - The actual session messages live in your `~/.pi` as usual.
> - `pictl`'s agent registry lives in your per-OS user data dir (`~/.local/share/pictl` on Linux), or wherever `$PICTL_DIR` points if you set it.

**Setup tab completion** with `pictl completion install` (bash only).

## Getting fancy with `pictl [prompt|tail|format]`

`pictl prompt` and `pictl tail` both stream a live agent's activity. `prompt` sends a message and streams until the end of the assistant turn; `tail` streams
an existing agent's activity without sending anything.

### Machine-readable output

Both `prompt` and `tail` print human-readable, formatted output by default, but add `--json` to get machine-readable output. If you want finer control over the formatting use `--json` and pipe to `pictl format`.

### Async prompting

Send a prompt without waiting for the reply with `pictl prompt --detach`. Then check back with `tail`. The output of `prompt`/`tail` end with a "cursor" that identifies the entry id of last message returned, and `pictl tail --since <entry-id>` will return all the messages after that. For example:

```sh
$ pictl tail -t c8b
...
== assistant ==
You are so smart.

[cursor: 6be9380a]
```

Then you can send an async message with

```sh
$ pictl prompt -t c8b -d "Stop being such a boot-licker and write a compiler. No mistakes."
```

The `-d` causes the prompt command to return immediately with no output, but then when you're ready to check back in on this agent, you can see what's happened since last you checked with

```sh
$ pictl tail -t c8b --since 6be9380a
== user ==
Stop being such a boot-licker and write a compiler. No mistakes.

== assistant ==
[thinking]
Yes sir. I'll get right on it.
[tool: bash ...]
...
```

> [!NOTE]
>
> - If no `--since` is provided, `tail` will give you all the messages in the agent's **current context**.
> - If `--since` is provided, you get all messages from all activity since that entry, which can cross **compaction boundaries** and **tree navitation**. If you used `/tree` to navigate back and forth between branches of the conversation, sending messages here and there, what you'll get is the messages in the order they were inserted into the session file (i.e. chronological order).
> - If the underlying session _file_ has changed (e.g. you typed `/new` or `/fork` into the interactive TUI, or used the `switch-session` command), then you'll only get the new activity on the current session _file_, and you'll get an error if the current file doesn't contain the given entry id. You can use `pictl status` to see what session files have been associated with a given agent.

### Messages vs Entries (vs raw RPC messages)

pi distinguishes between _messages_ (the agent/LLM-facing conversation units) and _entries_ (durable, branchable session history). Messages are derived from entries. If you need the greater fidelity of entries, you can get it. You can even stream the raw RPC messages if you really need to, but watch out because that includes a bunch of stuff that doesn't get written to the session file, like incremental message updates.

You can control what you get from `prompt`/`tail` with `--type`:

- `--type messages` (default): one block per message (and per control event like compaction), the same rendering as `pictl format messages`. `--json` for no formatting.
- `--type entries`: one line per session entry (`<id> <role> <summary>`), the same rendering as `pictl format entries`. `--json` for no formatting.
- `--type raw`: raw pi socket events, one JSON object per line. `raw` is
  inherently JSON, so `--json` is a no-op for it. Since raw RPC messages aren't persisted, you can only get raw messages that appear _after_ you run the command.

If the reason you're after entries is to recover the tree structure from the `parentId` field, you may want to get the tree structure directly with `get-tree`. The output of `get-tree` is json (like pretty much all subcommands other than `prompt` and `tail`), but you can pretty print it like this:

```sh
pictl get-tree -t c8b | pictl format tree
```

## Further reading

- **How does pictl work?** See [`docs/architecture.md`](docs/architecture.md) for details about the agent registry, command and tty sockets, daemon processes, and how I expect pictl to interact with other languages.

- **Tweaks to pi.** See [`docs/pi-modifications.md`](docs/pi-modifications.md) for details about the tweaked version of pi `pictl` depends on, especially `--rpc-socket` mode.

- For all available subcommands, run `pictl --help-all`. Subcommands have their own help info; e.g. `pictl format entries --help`.
