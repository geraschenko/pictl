# Command-line argument parsing

The current CLI uses Node's built-in `parseArgs` directly in each command. This works, but the result feels increasingly awkward as the CLI grows.

Current pain points:

- no short flags for free, such as `-f` for `--follow`;
- no generated `--help`;
- no generated `--version`;
- usage text is manually maintained;
- global options are hard because each command parses its own arguments;
- accepting a global option before or after the subcommand is awkward;
- error formatting and usage messages are easy to make inconsistent;
- command definitions and help text can drift from the actual parser.

There is probably something in the TypeScript ecosystem analogous to Rust's `clap` that would fit better.

## Things to investigate

Potential libraries to learn about:

- [`commander`](https://www.npmjs.com/package/commander)
- [`yargs`](https://www.npmjs.com/package/yargs)
- [`clipanion`](https://www.npmjs.com/package/clipanion)
- [`cac`](https://www.npmjs.com/package/cac)
- [`oclif`](https://www.npmjs.com/package/oclif)
- [`@effect/cli`](https://www.npmjs.com/package/@effect/cli)
- [`sade`](https://www.npmjs.com/package/sade)

This list is only a starting point, not a shortlist.

## Capabilities that may matter

Unknown which of these are hard requirements yet:

- subcommands;
- global options;
- global options before and after subcommands;
- short aliases;
- repeatable flags;
- generated `--help`;
- generated `--version`;
- good TypeScript types / inference;
- async command handlers;
- ESM compatibility;
- no decorators or unusual build step;
- minimal dependency footprint;
- shell completions;
- nested commands, if command grammar ever grows;
- clean separation between command definitions, parsing, and execution.

Help output may need two levels: a punchy default `--help` that shows only the most common commands, plus a full listing behind a flag such as `--helpfull` (name undecided).

## Relationship to other thoughts

The global target idea would be much cleaner with better argument parsing:

```bash
pictl --target abc prompt "..."
pictl prompt --target abc "..."
pictl -t abc prompt "..."
```

Hand-rolling support for this across all commands would be tedious and likely inconsistent.

The prompt/tail output-mode idea may also need common flags across multiple commands:

```bash
--entries
--events
--raw
--until <condition>
--timeout <secs>
-n <count>
```

A better CLI library might make shared option groups easier to define and document.

## Open questions

- Which library is closest to Rust `clap` in ergonomics and reliability?
- How much TypeScript type safety is realistic for CLI parsing?
- Do we want generated help output enough to shape the command definitions around a library?
- How should command specs interact with the existing RPC passthrough table?
- Would a library make startup noticeably slower?
- Are shell completions worth considering now or later?

Migration planning should wait until the broader CLI shape is clearer.
