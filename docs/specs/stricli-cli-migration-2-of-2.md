# Stricli CLI migration, 2 of 2: typed command definitions

# SPEC

## Status

This document supersedes implementation-shape decisions from `docs/specs/stricli-cli-migration-1-of-2.md` where they conflict. The user-facing grammar and behavior from part 1 still apply.

## Problem statement

The first implementation pass centralized command dispatch through Stricli but preserved the old `argv: string[]` command entrypoints and reconstructed argv from parsed flags. That is not an acceptable migration: it hides the old parser behind Stricli, erases strict flag/argument types, and requires broad casts.

This pass finishes the actual migration:

- each command module owns its command-line route definitions;
- Stricli owns syntactic parsing;
- command implementations receive typed parsed flags and positionals;
- target resolution is shared through typed command context;
- old `runX(argv)` parsing entrypoints are removed;
- route composition happens only at the root.

## Design goals

- Treat the CLI as if it had always used Stricli.
- Keep command flags, docs, positionals, and implementation colocated in the module that owns the command.
- Preserve Stricli's strict typing instead of erasing flags to `Record<string, unknown>`.
- Export Stricli-ready routes from command modules, not raw specs for the root to interpret.
- Keep the root (`src/main.ts`) as composition only: ordered route imports, root route map, app config, and run.
- Keep shared target parsing/resolution in one place, but do not put target in command-specific flag types.

## Required file organization

### `src/cli.ts`

`src/cli.ts` should contain only shared CLI framework utilities, such as:

- `CommandContext`
- target-aware command builders
- target accessor helpers
- target determination/resolution helpers
- shared parsers such as timeout/true-flag helpers if useful
- shared Stricli localization/run helpers

It must not define individual command routes such as `attach`, `spawn`, `prompt`, etc.

### Command-owning modules

Each command-owning module should export route objects or route groups, not raw specs. Examples:

```ts
export async function attach(this: CommandContext, flags: AttachFlags): Promise<void> {
  const target = oneTarget(this);
  // ... actual command logic using typed flags/context ...
}

const attachCommand = commandOneTarget<AttachFlags, []>({
  docs: { brief: "attach this terminal to an agent" },
  parameters: { flags: {} },
  func: attach,
});

export const attachRoute = {
  attach: attachCommand,
} as const;
```

For modules with multiple commands:

```ts
export const lifecycleRoutes = {
  suspend: suspendCommand,
  archive: archiveCommand,
  resume: resumeCommand,
  purge: purgeCommand,
} as const;
```

This keeps open the option for a module to export a nested route map later without the parent/root needing to know its internals.

### `src/main.ts`

`src/main.ts` imports ordered route groups and composes the root app:

```ts
const routes = {
  ...spawnRoute,
  ...listRoute,
  ...attachRoute,
  ...statusRoute,
  ...waitRoute,
  ...tailRoute,
  ...gcRoute,
  ...lifecycleRoutes,
  ...rpcRoutes,
  ...internalRoutes,
};
```

`main.ts` should not know each command's flags, positionals, target mode, docs, or implementation details.

## Naming

Use the command-line name whenever possible:

- `attach`
- `list`
- `status`
- `spawn`
- `wait`
- `tail`
- `suspend`
- `archive`
- `resume`
- `purge`
- `gc`

For command-line names that are not valid TypeScript identifiers, use the natural camelCase equivalent:

- `follow-up` -> `followUp`
- `get-state` -> `getState`
- `set-auto-retry` -> `setAutoRetry`
- `_hold` -> `_hold` if practical, otherwise `hold` with route key `_hold`

Route exports should be named after the route group:

- `attachRoute = { attach: attachCommand }`
- `spawnRoute = { spawn: spawnCommand }`
- `lifecycleRoutes = { suspend, archive, resume, purge }`
- `rpcRoutes = { prompt, steer, follow-up, ... }`
- `internalRoutes = { _hold: holdCommand }`

## Command builders and targets

Prefer mode-specific builders if they eliminate untyped target injection and broad casts:

- `commandNoTarget`
- `commandOneTarget`
- `commandMultiTarget`

If these builders still require keeping the current `targetFlag`, `withTargets`, and `TargetMode` machinery, then they are just duplication and should not be introduced for their own sake.

Target flags must not appear in command-specific flag types. Target selection belongs to shared CLI plumbing and resolved targets belong to `CommandContext`.

Target accessor helpers should be provided to avoid unsafe indexing:

```ts
export function oneTarget(context: CommandContext): AgentRecord;
export function multiTargets(context: CommandContext): readonly AgentRecord[];
```

The implementation may attempt target-mode-specific context typing if feasible. The baseline acceptable API is:

```ts
export interface CommandContext extends StricliCommandContext {
  process: PictlProcess;
  env: NodeJS.ProcessEnv;
  targets: AgentRecord[];
}
```

Command implementations read targets from context:

```ts
const target = oneTarget(this);
```

not from flags.

## `common` and route visibility

`CommandSpec` or the command builder inputs still need to carry `common?: true` so root help can hide non-common routes by default using Stricli route-map `docs.hideRoute`.

The command builders should return Stricli route targets annotated with `common?: true`, or provide another typed way for `main.ts` to build `hideRoute` without knowing command internals.

`--json` and similar presence flags should use literal `true` where possible:

```ts
interface ListFlags {
  json?: true;
  all?: true;
  cwd?: string;
}
```

This mirrors `common?: true`: absence is false, presence is true.

## Parsing responsibilities

Stricli should own all syntactic parsing:

- booleans / presence flags;
- strings;
- repeated flags;
- positional arity;
- enum-like values;
- timeout numbers;
- wait conditions.

Semantic validation that depends on multiple inputs remains in command logic. Example: `tail --events --since` is syntactically valid but semantically invalid and should be rejected by `tail`.

Existing parsers should be reused directly as Stricli parsers where appropriate. Example:

```ts
interface WaitFlags {
  until: WaitCondition;
  timeout?: number; // seconds
}
```

`parseWaitCondition` should parse `--until` into `WaitCondition`.

Timeout flags should remain seconds in parsed flags and be converted to milliseconds inside command logic, matching current behavior.

## Remove old argv entrypoints

Old parser entrypoints must be removed:

- no `runAttach(argv: string[])`
- no `runList(argv: string[])`
- no `runStatus(argv: string[])`
- no `runWait(argv: string[])`
- no `runTail(argv: string[])`
- no `runSpawn(argv: string[])`
- no `runHold(argv: string[])`
- no lifecycle `runX(argv: string[])`

Useful internal helpers should remain, but they should operate on typed values and command context, not argv. Examples:

- `connectToTty(...)`
- `probeAgent(...)`
- `waitIdle(...)`
- `stopRunningAgent(...)`
- `launchHolder(...)`

Do not add an `argvFromFlags` helper. Reconstructing argv from typed Stricli flags is explicitly forbidden.

## RPC command migration

The existing `RpcCliSpec` table should be removed if feasible. It duplicates the kind of command-specification structure Stricli is meant to provide.

RPC commands should be actual Stricli commands/routes exported from `src/rpc-commands.ts`, with typed flags and typed positionals. The module remains the single owner of RPC command surface area.

Acceptable shape:

```ts
interface PromptFlags {
  raw?: true;
  andWait?: true;
  andWaitUntil?: WaitCondition;
  streamingBehavior?: "steer" | "follow-up";
  image: string[];
}

export async function prompt(
  this: CommandContext,
  flags: PromptFlags,
  message: string,
): Promise<void> {
  const target = oneTarget(this);
  const command: RpcCommand = { ... };
  await sendRpc(target, command, { raw: flags.raw === true });
}

const promptCommand = commandOneTarget<PromptFlags, [string]>({ ... });
```

Where Stricli typing makes a completely generic RPC helper difficult, prefer some repetition over recreating `RpcCliSpec` or weakening flags to `Record<string, unknown>`.

## Context and process access

Command logic should prefer the Stricli context:

- `this.process.stdout.write(...)`
- `this.process.stderr.write(...)`
- `this.env`

The shared `CommandContext.process` may need to extend Stricli's process shape to include stdin/stdout TTY APIs used by `attach`, or `attach` may need a narrowly-typed local assertion with a documented reason. This needs explicit design before implementation.

Do not use broad direct `console.log`, `console.error`, or `process.env` in migrated command logic unless there is a documented reason.

## Cast policy

Broad casts such as `as never`, `as any`, or casts that erase command flag/argument types are not acceptable without a detailed written argument.

For every remaining cast, document:

1. exact location;
2. why TypeScript cannot prove the desired type;
3. why the cast is locally safe;
4. what would be required to remove it later.

The preferred outcome is no broad casts in command definitions or command modules.

## Testing requirements

Migrate tests to the typed Stricli architecture as if the project always used Stricli.

Acceptance criteria include:

- no `argvFromFlags`;
- no command calls an old `runX(argv)` parser entrypoint;
- no command-specific flags typed as generic `Record<string, unknown>`;
- no `parseArgs` in command modules except possibly a documented, temporary exception for code not yet migrated;
- no `RpcCliSpec` if feasible;
- target-taking commands still use `--target` / `-t` and `PICTL_TARGET` rules from part 1;
- no-target commands reject `--target` / `-t`;
- help/version behavior remains from part 1;
- existing output and exit-code behavior is preserved.

## Open questions before implementation

1. `attach` needs stdin raw-mode and terminal dimensions. Should `CommandContext.process` grow a project-specific process type that includes `stdin`, `stdout.isTTY`, `stdout.rows`, `stdout.columns`, `stdout.on("resize", ...)`, and `process.exit`, or should `attach` use direct Node `process` with a documented exception?
2. Should route groups be exported as plain objects only, or may a module export a nested `RouteMap` directly when useful? Current preference: either is allowed; root should treat both as route targets.
3. For RPC commands, confirm that removing `RpcCliSpec` entirely is preferred even if it causes some repetition in `src/rpc-commands.ts`.

# WORK LOG

- [x] Created part-2 spec draft after review feedback on the typed Stricli migration.
- [ ] Get approval on this spec before implementation.
- [ ] Refactor shared CLI builders/types.
- [ ] Migrate first-class command modules to typed Stricli command functions.
- [ ] Remove old `runX(argv)` parser entrypoints.
- [ ] Migrate RPC commands away from `RpcCliSpec` if feasible.
- [ ] Replace direct console/env/process usage where practical.
- [ ] Add/update tests for typed parsing and target behavior.
- [ ] Run check/lint/format/test.
