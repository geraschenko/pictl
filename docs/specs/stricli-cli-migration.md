# Stricli CLI migration

# SPEC

## Problem statement

`pictl` currently parses command-line arguments by calling Node's `parseArgs` inside each command. As the CLI grows, this makes help text, target selection, aliases, global-ish options, and error behavior hard to keep consistent.

This spec replaces the current ad hoc parser structure with a centralized Stricli-based command layer. It also resolves the earlier CLI argument parsing and global target design thoughts, now archived at:

- `docs/thoughts/old/cli-argument-parsing.md`
- `docs/thoughts/old/global-target.md`

The new CLI grammar intentionally removes positional agent arguments. Commands that operate on agents select them with `--target` / `-t`, or with the `PICTL_TARGET` environment variable as a fallback.

Use `@stricli/core`, pinned in `package.json`. Do not use the plain `stricli` npm package.

## User-facing command grammar

General command shape:

```bash
pictl <command> [command flags] [command positionals]
```

Target-taking commands accept `--target <target>` / `-t <target>` after the command:

```bash
pictl prompt -t abc "hello"
pictl prompt --target abc "hello"
pictl prompt "hello" -t abc
PICTL_TARGET=abc pictl prompt "hello"
```

Flags and positionals may be intermixed after the command when Stricli supports it. The preferred documentation examples should place `-t` logically right after the command:

```bash
pictl prompt -t abc "hello"
```

Global target flags before the command are not supported:

```bash
pictl -t abc prompt "hello"       # not supported
pictl --target abc prompt "hello" # not supported
```

No custom error is required for this case; Stricli's default unknown-command/error behavior is acceptable.

## Target selection rules

Commands declare one of three target modes:

```ts
export type TargetMode = "none" | "single" | "multiple";
```

Target selection behavior:

- `none`
  - The command does not accept `--target` / `-t`.
  - Supplying an explicit target is a usage error.
  - `PICTL_TARGET` is ignored.
- `single`
  - The command accepts at most one explicit `--target` / `-t`.
  - If no explicit target is supplied, `PICTL_TARGET` is used if set.
  - If neither is available, this is a usage error.
  - Multiple explicit targets are a usage error.
- `multiple`
  - The command accepts one or more explicit repeated `--target` / `-t` flags.
  - If at least one explicit target is supplied, `PICTL_TARGET` is ignored completely.
  - If no explicit target is supplied, `PICTL_TARGET` is used as a single target if set.
  - If no explicit target and no `PICTL_TARGET` are available, this is a usage error.

`PICTL_TARGET` always represents a single target. It is not comma-split. Explicit target strings are also not comma-split; `--target a,b` is one literal target string and should fail normal target resolution unless such a target exists.

Target resolution should happen after syntactic command parsing and command-specific required positional validation. For example, `pictl prompt -t bad` with a missing message should report the missing message before trying to resolve `bad`.

Target resolution loads `AgentRecord`s from disk as early as practical, but it must not automatically revive dormant agents. Individual command logic decides whether revival is appropriate.

## Command target modes

`target: none`:

- `spawn`
- `_hold`
- `list`
- `gc`

`target: single`:

- `attach`
- `wait`
- `tail`
- all RPC passthrough commands, including `prompt`, `steer`, `follow-up`, `get-state`, etc.

`target: multiple`:

- `status`
- `suspend`
- `archive`
- `resume`
- `purge`

## Required command shape changes

Remove positional agent arguments from public commands.

Examples:

```bash
# Old
pictl prompt abc "hello"
pictl status a b --json
pictl suspend a b --timeout 10
pictl purge a b --timeout 10 --now --force
pictl attach a

# New
pictl prompt -t abc "hello"
pictl status -t a -t b --json
pictl suspend -t a -t b --timeout 10
pictl purge -t a -t b --timeout 10 --now --force
pictl attach -t a
```

Commands keep their non-agent positionals. For example, `prompt` still has a message positional:

```bash
pictl prompt -t abc "hello"
pictl prompt -t abc -
```

Preserve `spawn` passthrough behavior:

```bash
pictl spawn --cwd dir -- --session abc
```

Preserve `_hold` behavior. It may be migrated into the Stricli command map. It is acceptable for `_hold` to appear in `--help-all`.
TDC: look into "hideRoute" in the stricli docs: https://bloomberg.github.io/stricli/docs/features/command-routing/route-maps. I think that allows hiding some commands from documentation. Please review the rest of the documentation there to see if there are any other features we could be using, or any ways in which we're not aligning with the stricli philosophy.

## Help and version behavior

Add generated help/version behavior through Stricli:

```bash
pictl --help
pictl <command> --help
pictl --help-all
pictl --version
```

Default `--help` should show common commands only. Initial common command list:

- `spawn`
- `list`
- `attach`
- `prompt`
- `tail`
- `status`
- `archive`
- `purge`

`--help-all` should include all RPC passthrough commands. It is acceptable for `_hold` to appear in `--help-all`.

`pictl --version` prints only the package version, matching pi's behavior:

```text
0.1.0
```

Implementation should read the version from `package.json` at runtime, following pi's general approach of locating package assets and exporting a `VERSION` constant.

## Output and exit behavior

Preserve existing output behavior except where help formatting necessarily changes:

- `list` and `status` keep command-specific `--json`.
- RPC passthrough commands continue to print JSON data by default and support RPC-specific `--raw`.
- `tail` remains as-is for this spec; do not add `tail --raw` here.
- The prompt/tail `--and-tail` redesign is out of scope for this spec.
- Usage errors exit `2`.
- Runtime errors exit `1`.
- Wait timeouts continue to exit `3`.
- Errors should continue to print on stderr.

## Type design

The implementation should introduce a central CLI layer with these core types or close equivalents:

```ts
export type TargetMode = "none" | "single" | "multiple";

export interface CommandContext {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  /** Empty for targetMode none; length 1 for single; length >= 1 for multiple. */
  targets: AgentRecord[];
}

export interface TargetSelection {
  flagTargets: string[];
  envTarget: string | undefined;
  // TDC: why is selectedTargets part of the same structure? Shouldn't it be derived from the other two fields? Please explain this to me.
  selectedTargets: string[];
}
```

Target selection should be factored into pure and disk-backed helpers similar to:

```ts
export function determineTargets(
  targetMode: TargetMode,
  flagTargets: readonly string[],
  envTarget: string | undefined,
): string[];

export async function resolveTargets(
  targetMode: TargetMode,
  flagTargets: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<AgentRecord[]>;
```

`determineTargets` implements target precedence and cardinality rules without touching disk. `resolveTargets` calls `determineTargets` and loads each selected target into an `AgentRecord`.
TDC: why not have resolveTargets accept the output of determineTargets and _just_ be responsible for resolving the strings to uuids and loading the agent information from disk? It seems clearer that way to me. For ergonomics, we can have determineTargets take env instead of envTarget.

Command definitions should declare `targetMode`. The Stricli command adapter should inject `--target` / `-t` only for `single` and `multiple` commands.

The command-spec layer may be modeled as:

```ts
interface PictlCommandSpec<FLAGS, ARGS extends readonly unknown[]> {
  targetMode: TargetMode;
  hidden?: boolean;  // TDC: let's go with `common?: boolean` instead (the inverse of hidden), because it's a clearer mental model that we curate the list of common commands, not the list of hidden commands ... commands are hidden by default. Also, if the field is optional _and_ it's a boolean, there are three states, aren't there? Does typescript have a unit type? What's the convention in cases like this?
  docs: {
    brief: string;
    fullDescription?: string;
  };
  parameters: {
    flags?: FlagParametersForType<FLAGS, CommandContext>;
    aliases?: Aliases<keyof FLAGS & string>;
    positional?: TypedPositionalParameters<ARGS, CommandContext>;
  };
  // TDC: Would calling this field `func` be more consistent with stricli terminology? Don't change it without discussing this question with me first.
  run: (
    this: CommandContext,
    flags: FLAGS,
    ...args: ARGS
  ) => void | Promise<void>;
}
```

Exact generic spelling may differ to fit Stricli ergonomics, but the implementation should preserve the design intent:

- command definitions are centralized;
- `targetMode` is declared once per command;
- target parsing and target resolution are enforced by a shared wrapper;
- command implementations receive a `CommandContext` with loaded, non-revived `AgentRecord`s;
- command implementations decide whether to revive targets.

If full injection is easy, command logic should prefer `CommandContext.stdout`, `CommandContext.stderr`, and `CommandContext.env` over direct `console.log`, `console.error`, and `process.env`, to improve testability.

## Success criteria

- `@stricli/core` is added as a pinned dependency.
- CLI dispatch is centralized through Stricli.
- Public commands no longer accept positional agent arguments.
- Target-taking commands accept `--target` / `-t` after the command.
- Target-taking commands use `PICTL_TARGET` as fallback according to the rules above.
- No-target commands do not accept `--target` / `-t`.
- Default help shows common commands.
- `--help-all` shows RPC passthrough commands.
- `--version` prints only the version number.
- Existing command behavior is preserved aside from intentional target grammar and help formatting changes.
- Usage errors, runtime errors, and wait timeouts preserve exit code behavior.
- Tests cover target selection, representative parsing behavior, and key help/version lines.

## Test matrix

Parser/selection tests should cover at least:

Accepted:

```bash
pictl prompt -t abc "hello"
pictl prompt --target abc "hello"
pictl prompt "hello" -t abc
PICTL_TARGET=abc pictl prompt "hello"
pictl status -t a -t b --json
PICTL_TARGET=abc pictl status
PICTL_TARGET=env pictl status -t a -t b # selects only a and b
pictl spawn --cwd dir -- --session abc
pictl --version
pictl --help
pictl --help-all
```

Rejected:

```bash
pictl prompt abc "hello"        # old positional agent form
pictl prompt "hello"            # no target and no PICTL_TARGET
pictl prompt -t a -t b "hello"  # single-target command with multiple targets
pictl status                    # no target and no PICTL_TARGET
pictl list -t abc               # no-target command with explicit target
pictl -t abc prompt "hello"     # global target before command is unsupported
```

Help tests should assert key lines rather than snapshotting the full help text.

## Edge cases and non-goals

- Do not support `pictl -t abc prompt ...` in this spec.
- Do not comma-split target strings.
- Do not add a global `--json` in this spec.
- Do not add `tail --raw` in this spec.
- Do not implement the prompt/tail `--and-tail` redesign in this spec.
- Do not perform a broad clig.dev philosophy pass beyond the concrete behavior in this spec.
- Shell completion support via `@stricli/auto-complete` is optional: include it now if it is straightforward; otherwise document why it was deferred.

# IMPLEMENTATION IDEAS

A likely implementation path:

1. Add `@stricli/core` as a pinned dependency.
2. Add a small version/config helper mirroring pi's package-version approach.
3. Add target selection helpers and pure tests for `determineTargets`.
4. Build a Stricli app from centralized command specs.
5. Migrate first-class commands to specs.
6. Migrate RPC passthrough command specs into the same command-definition framework.
7. Preserve `_hold` either as a Stricli command or as an internal command path; it is acceptable for it to appear in `--help-all`. TDC: I think it should be a stricli command.
8. Add parser/dispatcher tests and a small CLI smoke test.
9. Optionally evaluate `@stricli/auto-complete`; wire it in only if the integration is simple.

Notes:

- Stricli supports command route maps, generated help, aliases, typed flags, typed positionals, async handlers, `--help-all`, and version info.
- Stricli does not naturally support global flags before the command; this spec intentionally avoids requiring that behavior.
- Parse/usage validation should happen before target resolution so missing required positionals are reported before unknown target IDs.
- `wait` and `status` need special care because they intentionally should not revive dormant agents.
- Existing code currently mixes parsing, validation, and command execution. It may be useful to split command logic into functions that accept already-parsed values and `CommandContext`.
- Building with stubs first is not required, but it is a good way to keep the type migration controlled.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Created spec from design discussion.
- [x] Moved resolved thought docs into `docs/thoughts/old/`.
- [ ] Add pinned `@stricli/core` dependency.
- [ ] Implement central target selection helpers.
- [ ] Add pure tests for target selection behavior.
- [ ] Build Stricli app and command-spec adapter.
- [ ] Migrate first-class commands.
- [ ] Migrate RPC passthrough commands.
- [ ] Preserve `spawn -- ...` passthrough behavior.
- [ ] Preserve `_hold` behavior.
- [ ] Add key-line help/version tests.
- [ ] Add representative CLI smoke tests.
- [ ] Evaluate optional autocomplete support and either implement or document deferral.
