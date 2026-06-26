# Stricli CLI migration, 3 of 4: inferred flag types and boolean presence flags

# SPEC

## Status

This document refines the typed command-definition architecture from `docs/specs/stricli-cli-migration-2-of-4.md`. The user-facing grammar and route ownership rules from parts 1 and 2 still apply unless this document explicitly says otherwise.

This pass is intentionally small. It does not redesign route metadata, `common` handling, target resolution, or command-builder inference.

## Problem statement

The current Stricli command modules still define command flag types separately from the runtime flag parameter objects. Example shape:

```ts
interface PromptFlags {
  raw?: true;
  image?: readonly string[];
  andWait?: true;
}

const promptCommand = commandOneTarget<PromptFlags, [string]>({
  parameters: {
    flags: {
      raw: trueFlag("Print raw RPC response"),
      image: imageFlag,
      andWait: trueFlag("Wait for turn end after prompting"),
    },
    // ...
  },
  func: prompt,
});
```

This is type-safe, but the type and the flag-definition value are separate sources of information. This pass makes the runtime flag-definition value the source of truth and derives the TypeScript implementation flag type from that value.

At the same time, presence flags should no longer use the `raw?: true` style. The command-line flag is optional, but the implementation type should receive a required boolean: `true` when the flag is present, `false` when absent.

## Success criteria

- Command-specific flag interfaces that merely mirror Stricli flag parameter objects are replaced with inferred types derived from flag-definition values.
- Presence flags use required boolean properties in implementation types.
- Optional non-boolean scalar flags remain optional in the implementation type.
- Variadic image flags are normalized to a required readonly array, with absence represented as an empty array.
- Command builders may continue to be called with explicit generics, e.g. `commandOneTarget<PromptFlags, [string]>`.
- This pass does not attempt to remove or redesign `markCommon` / `common` route visibility handling.
- Existing behavior remains compatible except for implementation-internal flag typing changes.
- Type checking, linting, build, and tests pass after implementation.

## Concrete examples

### Boolean presence flag

Desired command-line behavior:

```bash
pictl prompt "hello"
# implementation sees flags.raw === false

pictl prompt --raw "hello"
# implementation sees flags.raw === true
```

Desired TypeScript shape:

```ts
const rawFlags = {
  raw: booleanFlag("Print raw RPC response"),
};

type RawFlags = InferFlags<typeof rawFlags>;
// Equivalent intended shape: { readonly raw: boolean }
```

### Optional scalar flag

```ts
const outputFlags = {
  outputPath: stringFlag("Output path"),
};

type OutputFlags = InferFlags<typeof outputFlags>;
// Equivalent intended shape: { readonly outputPath?: string }
```

### Variadic image flag

```ts
const imageFlags = {
  image: variadicStringFlag("Attach image path"),
};

type ImageFlags = InferFlags<typeof imageFlags>;
// Equivalent intended shape: { readonly image: readonly string[] }
```

Command implementations should not need to normalize `flags.image ?? []`; absence of `--image` should already be represented as `[]`.

### Prompt command shape

```ts
const promptFlags = {
  raw: booleanFlag("Print raw RPC response"),
  image: variadicStringFlag("Attach image path"),
  andWait: booleanFlag("Wait for turn end after prompting"),
  andWaitUntil: parsedFlag(
    `Wait until ${WAIT_UNTIL_USAGE} after prompting`,
    parseWaitCondition,
  ),
  streamingBehavior: enumFlag(
    "Behavior while the agent is streaming",
    ["steer", "follow-up"] as const,
  ),
};

type PromptFlags = InferFlags<typeof promptFlags>;

export async function prompt(
  this: CommandContext,
  flags: PromptFlags,
  message: string,
): Promise<void> {
  if (flags.raw) {
    // raw output
  }
  for (const imagePath of flags.image) {
    // zero or more paths
  }
}

const promptCommand = commandOneTarget<PromptFlags, [string]>({
  common: true,
  docs: { brief: "send a prompt" },
  parameters: {
    flags: promptFlags,
    positional: {
      kind: "tuple",
      parameters: [stringArg("Message", "message|-")],
    },
  },
  func: prompt,
});
```

## Type Design

The following symbols may be added to `src/cli.ts`.

```ts
import type {
  CommandContext as StricliCommandContext,
  FlagParametersForType,
  TypedFlagParameter,
} from "@stricli/core";

declare const flagValue: unique symbol;

export type CliFlag<T, PARAMETER> = PARAMETER & {
  readonly [flagValue]?: T;
};

export type InferFlagValue<F> = F extends {
  readonly [flagValue]?: infer T;
}
  ? T
  : never;

export type OptionalFlagKeys<F extends Record<string, unknown>> = {
  readonly [K in keyof F]: undefined extends InferFlagValue<F[K]> ? K : never;
}[keyof F];

export type RequiredFlagKeys<F extends Record<string, unknown>> = Exclude<
  keyof F,
  OptionalFlagKeys<F>
>;

export type InferFlags<F extends Record<string, unknown>> = {
  readonly [K in RequiredFlagKeys<F>]: InferFlagValue<F[K]>;
} & {
  readonly [K in OptionalFlagKeys<F>]?: Exclude<
    InferFlagValue<F[K]>,
    undefined
  >;
};

export function booleanFlag(
  brief: string,
): CliFlag<boolean, TypedFlagParameter<boolean, CommandContext>>;

export function stringFlag(
  brief: string,
  placeholder: string,
): CliFlag<string | undefined, TypedFlagParameter<string | undefined, CommandContext>>;

export function variadicStringFlag(
  brief: string,
  placeholder: string,
): CliFlag<
  readonly string[],
  TypedFlagParameter<readonly string[], CommandContext>
>;

export function enumFlag<const VALUES extends readonly [string, ...string[]]>(
  brief: string,
  values: VALUES,
): CliFlag<VALUES[number] | undefined, TypedFlagParameter<VALUES[number] | undefined, CommandContext>>;

export function parsedFlag<T>(
  brief: string,
  parse: (input: string) => T,
  placeholder: string,
): CliFlag<T | undefined, TypedFlagParameter<T | undefined, CommandContext>>;

export function requiredParsedFlag<T>(
  brief: string,
  parse: (input: string) => T,
  placeholder: string,
): CliFlag<T, TypedFlagParameter<T, CommandContext>>;

export function requiredStringFlag(
  brief: string,
  placeholder: string,
): CliFlag<string, TypedFlagParameter<string, CommandContext>>;
```

Notes:

- `CommandContext` in these signatures refers to the existing pictl command context exported by `src/cli.ts`, not Stricli's base `CommandContext` import.
- `booleanFlag` should use Stricli's native boolean flag support.
- `variadicStringFlag` returns a required readonly array type. Its runtime flag parameter should ensure absence is represented as an empty array.
- `stringFlag`, `enumFlag`, and `parsedFlag` represent optional flags by default.
- `requiredParsedFlag` and `requiredStringFlag` are included because existing commands such as `_daemon` and `wait` have required command flags.
- Additional helper overloads or internal helper types are acceptable only if needed to make these approved public signatures type-check.

## Edge cases

- Boolean presence flags should be safe to test directly with `if (flags.raw)`.
- Optional scalar flags should still require `undefined` handling.
- Variadic image flags should not require `undefined` handling.
- Shared flag fragments should compose by object spread:

```ts
const rawFlags = { raw: booleanFlag("Print raw RPC response") };
const imageFlags = { image: variadicStringFlag("Attach image path") };

const promptFlags = {
  ...rawFlags,
  ...imageFlags,
  andWait: booleanFlag("Wait for turn end after prompting"),
};
```

## Non-goals

- Do not introduce Zod as a CLI schema or metadata source in this pass.
- Do not switch away from Stricli in this pass.
- Do not redesign route exports or remove `markCommon` in this pass.
- Do not require command builders to infer `FLAGS` from `parameters.flags` in this pass; explicit command-builder generics remain acceptable.
- Do not change target handling or include target flags in command-specific flag types.

# IMPLEMENTATION IDEAS

- Implement the flag typing layer in `src/cli.ts` first with stub bodies or minimal bodies, then run type checking before migrating commands.
- Keep any unavoidable casts inside `src/cli.ts`; command modules should not need casts to use inferred flag types.
- Start migration with `src/rpc-commands.ts`, especially `prompt`, because it exercises boolean flags, a variadic image flag, enum flags, custom parsed flags, and positional arguments.
- Migrate shared fragments such as raw/image flags before individual RPC commands.
- After migrating one representative command, inspect the inferred type in editor/TypeScript by assigning representative values or using compile-time checks if useful.
- Replace `flags.raw === true` and similar checks with direct boolean use where the inferred type is now `boolean`.
- For image handling, update helper signatures to accept `readonly string[]` rather than `readonly string[] | undefined` if the helper is only called with normalized inferred image flags.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Created the part-3 spec file and later renamed the series to `of-4` for the completion spec.
- [x] Implemented typed flag helpers in `src/cli.ts`, including comments explaining the phantom-type based `InferFlags` machinery.
- [x] Added required parsed/string flag helpers after discovering `_daemon` and `wait` need required command flags.
- [x] Migrated command modules to infer implementation flag types from flag-spec values.
- [x] Removed `defineFlags` after review; plain object literals are easier to understand and still work with `InferFlags<typeof flags>`.
- [x] Verified boolean presence flags now infer required `boolean` values, and variadic image flags infer required `readonly string[]` values.
- [x] Ran `npm run fmt` and `treefmt --fail-on-change` successfully.
- [x] Ran `npm run check`, `npm run lint`, `npm run build`, and `npm test` successfully after formatting.
- [x] Smoke-tested `node dist/main.js --version` and `./dist/main.js --version`.
- [x] Addressed review comments from `112124a`: removed `defineFlags`, removed custom Stricli localization after comparing output, renamed the hidden daemon entrypoint/file/function/API to `_daemon`/`daemon.ts`/`daemon`/`launchDaemon`, and moved command-specific flag definitions closer to their commands.
