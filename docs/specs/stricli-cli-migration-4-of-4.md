# Stricli CLI migration, 4 of 4: shell completion

# SPEC

## Status

This document extends the completed Stricli migration from parts 1 through 3:

- `docs/specs/stricli-cli-migration-1-of-4.md`
- `docs/specs/stricli-cli-migration-2-of-4.md`
- `docs/specs/stricli-cli-migration-3-of-4.md`

The prior parts define the command grammar, typed command modules, inferred flag types, and target handling. This pass adds shell completion only. CLI polish items such as terse runtime errors, help visibility, and command locality cleanup are not part of this spec unless they directly affect completion.

## Problem statement

`pictl` now has a Stricli route map that knows the command tree, flags, aliases, enum-like values, hidden route metadata, and typed parsed parameters. Users should be able to use shell tab completion backed by that same Stricli command definition rather than maintaining a separate completion table.

The implementation should first add out-of-the-box Stricli completion for command names, nested routes, flags, aliases, enum values, and ordinary parsed/positional structure. After that basic path is proven, implementation must stop for review and planning before adding pictl-specific completion callbacks. Later phases should add `--target` / `-t` agent-id completion and path completion only after agreeing on the helper/API design.

## Desired user behavior

Users can install bash completion with:

```bash
pictl completion install
```

Users can uninstall bash completion with:

```bash
pictl completion uninstall
```

The shell-installed completion hook calls an internal command:

```bash
pictl completion complete -- <current command line words...>
```

The `complete` command prints one completion candidate per line on stdout. It is intended for shell integration, not direct interactive use.

Root help should expose at most one completion-related route:

```text
completion  Manage shell completion
```

`pictl completion --help` should show the useful user-facing subcommands:

```text
install
uninstall
```

`pictl completion complete` should be hidden from normal help but visible in `--help-all`.

## Completion behavior

Completion should include all commands and route maps known to the app, including hidden/internal routes. Help visibility and completion visibility are separate: a route may be hidden from default help while still being offered as a completion candidate.

### Phase 1: out-of-the-box Stricli completion

The first implementation phase should call Stricli's completion engine directly:

```ts
proposeCompletions(app, inputs, context)
```

This should provide completions for Stricli-owned syntax without a pictl-specific completion table:

- root commands and route maps, including routes hidden from default help;
- nested completion subcommands;
- flags;
- flag aliases, including `-t` for `--target`;
- enum flag values and other values Stricli can infer from flag/argument definitions.

Completion must be generated from the real `app` route map. Do not duplicate the command list or flag list in a separate completion registry.

After phase 1, stop implementation and review the observed completion behavior, route visibility, import structure, and command invocation shape. Do not start target-id or path completion until the next-phase type/API design is explicitly discussed and approved.

### Phase 2: target agent-id completion

After phase 1 works, add dynamic completions for the shared target flag.

When the current completion position is a value for `--target` or `-t`, completion should suggest existing agent ids from a prefix-aware registry helper.

Filtering behavior:

```ts
completeAgentIds("abc") // returns ids where id.startsWith("abc")
completeAgentIds("")    // returns all known ids
```

The completion callback should only list agent ids. It must not load full `AgentRecord`s, resolve prefixes, revive agents, connect to sockets, or validate whether a completed id is currently running.

The registry API should own prefix filtering rather than forcing completion code to fetch all ids and filter locally. The exact filesystem implementation may still need to scan directory entries, but callers should express the desired prefix through the API.

### Phase 3: path completion for path-like inputs

After target completion, add path completion for flags and positionals whose values are filesystem paths.

Use Stricli's per-parameter `proposeCompletions` hook if it is sufficient. If Stricli has no built-in path completer, add a small pictl helper that completes filesystem entries relative to the current working directory.

Path-like inputs include at least:

- `spawn --cwd`;
- `_daemon --agent-dir`, `--cwd`, and `--pi-bin`;
- RPC path flags such as `prompt --image`, `steer --image`, `follow-up --image`, `new-session --parent-session`, and `export-html --output-path`.

Path completion should not validate command semantics. It only proposes filesystem path strings.

Before starting phase 2 or phase 3, discuss whether helpers such as `stringFlag`, `parsedFlag`, `variadicStringFlag`, and `stringArg` should accept completion callbacks. Do not retrofit completion callbacks into these helpers without an approved type design.

## Stricli completion contract

Stricli's completion API lives in the local Stricli clone at:

- `/home/anton/git/stricli/packages/core/src/application/propose-completions.ts`
- `/home/anton/git/stricli/packages/core/src/routing/route-map/propose-completions.ts`
- `/home/anton/git/stricli/packages/core/src/routing/command/propose-completions.ts`

`proposeCompletions(app, rawInputs, context)` needs the application object because completion routes through the same root route map and scanner configuration used for normal command execution. It scans the partial command line, determines whether completion is currently in a route map or command, then delegates to route-map or command parameter completion.

The implementation should follow the pattern generated by Stricli's own app generator: a completion entrypoint imports the same `app` as the main CLI and calls `proposeCompletions` with a normal command context. The `app` does not need to be placed on `CommandContext`.

Relevant Stricli-generated template source:

- `/home/anton/git/stricli/packages/create-app/src/files.ts`

## Installation behavior

Use `@stricli/auto-complete`, pinned to the same Stricli version family as `@stricli/core` (`1.2.7` at spec time), for install/uninstall command builders.

`@stricli/auto-complete` currently supports bash. This spec only requires bash completion.

The installed bash hook should invoke:

```bash
pictl completion complete --
```

as the completion proposal command for the user-facing `pictl` command. The argument escape marker is required so the completion command can receive command-line words such as `--target` as positionals rather than parsing them as flags to `completion complete`.

## Type Design

The following symbols are approved for addition or modification. Exact import ordering and local helper names may vary, but the public/shared shape should match this design.

### New completion module

Add `src/completion.ts`.

```ts
import type { RouteMap } from "@stricli/core";
import type { CommandContext } from "./cli.ts";

export async function complete(
  this: CommandContext,
  _flags: Record<never, never>,
  ...inputs: string[]
): Promise<void>;

export const completionRoute: {
  readonly completion: RouteMap<CommandContext> & { readonly common?: true };
};
```

`complete` is the shell-facing proposal command. It should:

1. receive the words passed by the bash hook;
2. strip the first word when it is the executable name (`pictl` or a path used to invoke `pictl`);
3. append an empty partial input when `process.env.COMP_LINE` ends with a space;
4. call `proposeCompletions(app, inputs, context)`;
5. print each returned `completion` on its own line;
6. swallow completion-generation failures, matching Stricli's generated template behavior.

The `completion` route map should contain:

```ts
const completionRoutes = {
  complete: completeCommand,
  install: installCompletionCommand,
  uninstall: uninstallCompletionCommand,
};
```

Default root help should show only the top-level `completion` route. Default `completion --help` should hide `complete` and show `install` / `uninstall`. `--help-all` should reveal `complete`.

### App import shape

The completion implementation may import the built Stricli `app` directly. If that requires splitting app construction out of `src/main.ts`, add `src/app.ts`:

```ts
export const app: Application<CommandContext>;
```

Then `src/main.ts` imports `app` and only runs it. Tests should import `app` from the same app module if this split is made.

A temporary circular dependency is acceptable in the first implementation if it keeps the completion flow easy to understand, but it should be documented in the work log. If a small `src/app.ts` split eliminates the cycle without broad refactoring, prefer the split.

Do not add an `app` property to `CommandContext` for this spec.

### Target completion callback

Add a target completion helper in `src/cli.ts` or another shared CLI-adjacent location:

```ts
async function completeAgentIds(partial: string): Promise<readonly string[]>;
```

It depends on a prefix-aware registry helper:

```ts
import { listAgentIds } from "./registry.ts";

export async function listAgentIds(prefix?: string): Promise<string[]>;
```

The shared `targetFlag` should include this callback:

```ts
const targetFlag = {
  kind: "parsed",
  parse: String,
  brief: "Target agent id or unique prefix",
  placeholder: "agent",
  optional: true,
  proposeCompletions: completeAgentIds,
} as const;
```

Do not change command-specific flag types to include target. Target remains shared CLI plumbing.

### Path completion helper

Add a path completion helper if Stricli does not already provide one:

```ts
export async function completePath(
  this: CommandContext,
  partial: string,
): Promise<readonly string[]>;
```

This helper may live in `src/cli.ts` or another shared CLI utility module. It should be attached only to path-like flag and positional parameter definitions.

## Success criteria

- `@stricli/auto-complete` is added as a pinned dependency.
- `pictl completion install` and `pictl completion uninstall` exist.
- `pictl completion complete -- ...` exists, is hidden from normal help, and prints one candidate per line.
- Default root help shows at most one completion-related route: `completion`.
- `pictl completion --help` shows `install` and `uninstall` but not `complete`.
- `pictl --help-all` or `pictl completion --help-all` exposes completion internals sufficiently for debugging.
- Completion proposals are generated by Stricli's `proposeCompletions` from the real app route map.
- No separate command/flag completion table is introduced.
- Out-of-the-box completion works for commands, nested completion routes, hidden routes, flags, aliases, and enum values.
- Target value completion suggests ids returned by `listAgentIds(prefix)`.
- Path-like flags and arguments offer filesystem path completions where practical.
- Completion does not execute command implementations, resolve/load targets, revive agents, or connect to sockets.
- Type checking, linting, build, and tests pass.

## Test requirements

Add tests that exercise completion without requiring a real interactive shell.

Representative completion tests:

```bash
pictl completion complete -- pictl sta
# includes status

pictl completion complete -- pictl completion in
# includes install

pictl completion complete -- pictl status --
# includes --target and other valid flags for status

pictl completion complete -- pictl status -
# includes -t when alias completion is enabled

pictl completion complete -- pictl _d
# includes _daemon even though it is hidden from default help
```

Target completion tests should use an isolated `PICTL_DIR` registry fixture:

```bash
pictl completion complete -- pictl status --target ab
# includes matching agent ids such as abcdef
# excludes non-matching ids
```

Trailing-space behavior should be tested because bash completion treats:

```bash
pictl status
```

as a request to complete the next word, not the partial word `status`.

Help tests should assert key lines rather than snapshotting full help text.

## Edge cases and non-goals

- Bash is the only required shell for this spec.
- Do not implement zsh/fish completion in this spec.
- Do not add a postinstall script that modifies user shell files automatically.
- Do not maintain a pictl-specific command/flag completion table.
- Do not complete archived/running status differently; target completion lists known agent ids only.
- Do not restrict completion proposals to default-help-visible commands; hidden commands should also be proposed.
- Do not resolve prefixes during completion.
- Do not make completion load or revive agents.
- Do not fix all existing circular dependencies in this spec. The daemon launch path may continue to run `pictl _daemon` through the main program.

# IMPLEMENTATION IDEAS

- Read Stricli completion sources before implementation:
  - `/home/anton/git/stricli/packages/core/src/application/propose-completions.ts`
  - `/home/anton/git/stricli/packages/auto-complete/src/shells/bash.ts`
  - `/home/anton/git/stricli/packages/create-app/src/files.ts`
- Implement phase 1 first with only Stricli's built-in proposals.
- Prefer adding `src/app.ts` if importing `app` from `src/main.ts` causes an awkward cycle. Keep `src/main.ts` as the executable wrapper that imports and runs `app`.
- The route-map annotation for `common?: true` may need the same `Object.assign(..., { common: true })` pattern used for command routes.
- Configure Stricli completion with `includeAliases: true` so `-t` can be proposed alongside `--target`.
- Configure Stricli completion with `includeHiddenRoutes: true` so all routes can be completed, including hidden/internal commands.
- The completion command should use the current context's process/env, like other commands. Reading `COMP_LINE` from `this.env` is preferred over direct `process.env`.
- The Stricli-generated template uses `process.argv.slice(3)` because it is a separate binary. For a nested `pictl completion complete` command, `complete` receives only its rest positionals, so the implementation should not blindly copy the slice value; it should operate on its `inputs` rest parameter.
- If bash passes the command line as unquoted words, values containing whitespace may not round-trip perfectly through `completion complete`. This is acceptable for this spec; match Stricli's generated helper behavior first.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Created part-4 spec for shell completion after parts 1-3 completed the core Stricli migration.
- [x] Renamed existing migration specs into the four-part series and updated cross-references.
- [x] Add pinned `@stricli/auto-complete` dependency.
- [x] Add completion route map with `completion install`, `completion uninstall`, and hidden `completion complete`.
- [x] Implement out-of-the-box Stricli completion via `proposeCompletions(app, inputs, context)`.
- [x] Add tests for command/route/flag/alias completion.
- [x] Stop after phase 1 for review and next-phase type/API planning.
  - Phase 1 uses `pictl completion complete -- ...`; the argument escape marker is needed so command-line words beginning with `-` are passed through as completion inputs.
  - Added `src/app.ts` so normal execution and completion import the same app object. `src/completion.ts` imports `app`, so there is a small app/completion cycle; it is limited to the completion function reading `app` only when invoked.
- [ ] Add target-id completion via prefix-aware `listAgentIds(prefix)` after review.
- [ ] Add tests for target-id completion with isolated registry fixtures after review.
- [ ] Add path completion for path-like flags and positionals after review.
- [ ] Add tests for representative path completion behavior after review.
- [ ] Validate help visibility for completion routes.
- [ ] Run format, typecheck, lint, build, tests, and CLI smoke checks.
