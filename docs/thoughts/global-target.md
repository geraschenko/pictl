# Global target selection

The current command shape puts the agent id after the command name:

```bash
pictl prompt <agent> "..."
pictl get-messages <agent>
pictl wait <agent> --until idle
```

This is discoverable, but awkward when interacting with the same agent repeatedly. It also bakes the word “agent” into command grammar even though the long-lived thing being addressed is not exactly the same as a pi session. A single managed pi instance can move between sessions over time.

## Possible direction

Remove positional `<agent>` arguments from agent-scoped commands and use a global target instead:

```bash
pictl --target <target> prompt "..."
pictl prompt --target <target> "..."
pictl --target <target> get-messages
pictl --target <target> wait --until idle
```

If `--target` is not supplied, fall back to an environment variable:

```bash
export PICTL_TARGET=<target>
pictl prompt "..."
pictl get-messages
pictl wait --until idle
```

Precedence:

1. explicit `--target`;
2. `PICTL_TARGET`;
3. error if the command requires a target.

For now, targets would resolve only to agent ids or unique agent-id prefixes. No tags, roles, sessions, or workflow concepts.

## Flag placement

It would be convenient to accept `--target` both before and after the subcommand:

```bash
pictl --target abc123 prompt "..."
pictl prompt --target abc123 "..."
```

This likely argues for rethinking command-line parsing rather than continuing to hand-roll `parseArgs` separately in each command.

## Short form

There should probably be a short alias, perhaps:

```bash
pictl -t abc123 prompt "..."
```

The exact short flag should be considered alongside the larger CLI argument parsing work.

## Agent vs target terminology

There is a broader naming question: should “agent” become “target” more generally?

Reasons to consider “target”:

- “agent” may be confused with “session”. A managed pi instance outlives and can switch sessions.
- “target” describes the addressing role in a command: the thing the command is sent to.
- A future target might not be only an agent id, even though ids/prefixes are the only intended target form for now.

Reasons to keep “agent”:

- The registry resource is still an agent-like long-lived managed pi instance.
- “target” is generic and may obscure what is being addressed.
- `PICTL_TARGET` is convenient for commands, but internal docs may still need a concrete noun for the managed resource.

Possible split:

- **agent** remains the resource type in architecture and registry docs;
- **target** is the command-line addressing mechanism (`--target`, `PICTL_TARGET`).

This is not decided. The goal is to preserve the distinction for later discussion.

## Multi-target commands

Some commands currently accept multiple agents, such as status/lifecycle operations. With a target flag, possibilities include:

```bash
pictl --target a --target b status
pictl --target a,b status
pictl status --target a --target b
```

Open questions:

- Should `--target` be repeatable?
- Should comma-separated lists be accepted?
- Should single-target commands reject multiple targets?
- Is multi-target support worth preserving in the first version of this change?

## Global commands

Commands like `spawn`, `list`, and `gc` do not operate on a selected target in the same way.

Likely behavior: error if `--target` is supplied to a command that does not accept a target. Silently ignoring a target could hide mistakes.

Examples:

```bash
pictl --target abc list     # probably an error
pictl --target abc spawn    # probably an error
```

## Open questions

- Should positional target arguments be removed entirely, or kept as a secondary form?  TDC: I lean towards removing them. Is there any argument for keeping them?
- Is `target` really the right term, or just convenient for CLI grammar?
- Where should the agent/target terminology change: CLI help, docs, code types, env vars, user-facing errors?
- Should `PICTL_TARGET` be documented as the normal repeated-interaction workflow?
- How does target selection interact with future tags, roles, workflows, or session ids if those ever return?
