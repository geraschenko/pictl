# Core module restructure

# SPEC

## Problem statement

`pictl` has reached a point where the base pieces exist and useful tooling (message-formatting utilities, a Rust `tty.sock` client) is about to be built on top. Before that, the source tree should be reorganized so that:

1. There is an explicit, named home for the **core** of pictl, distinct from the helper/battery utilities that will be added later.
2. There is an explicit **public entry point** that declares pictl-core's intended API surface.
3. Two files that currently mix unrelated responsibilities are split so the structure makes sense to a future reader.

This spec covers **only** the structural reorganization. It does not add the formatting utilities, the Rust client, or any API-surface tooling (api-extractor / visualization), which is a deliberately deferred follow-up.

## Scope (exactly four changes)

1. **Move `src/*` → `src/core/`.** Everything currently in `src` is core. `main.ts` (the CLI bin entry) moves too. Tests stay colocated with their modules and move alongside them — this spec does **not** introduce a separate tests directory.
2. **Split `cli.ts`** into `targets.ts` (agent selection/resolution) + `cli.ts` (stricli command/flag-building glue).
3. **Extract `until.ts`** from `wait.ts` (the `--until` condition engine), keeping the `wait` command as a thin command over it, and renaming the `Wait*` condition symbols to `Until*`.
4. **Add `src/core/index.ts`** — an explicit, provisional public surface for pictl-core.

These four changes are independent and each must compile (`npm run check`) and pass tests (`npm test`) on its own.

## Non-goals

- Removing the `wait` command. (Considered and rejected for now: there is no silent, exit-code-only blocking replacement today — `tail --until` always emits the backlog and a final cursor — so removal would drop a capability. Revisit later, bundled with a possible `tail` quiet mode, once orchestration scripts reveal whether the affordance is needed.)
- Moving tests into a separate directory. (Deferred — the future API-visualization step may remove the underlying "src looks cluttered" motivation; re-evaluate then.)
- Wiring up api-extractor or any export-visualization tooling. (Deferred follow-up. The expectation is that the `index.ts` surface will be cut down substantially once that tooling exists.)
- Any change to runtime behavior, CLI surface, flags, exit codes, or protocol.

## Success criteria

- All source and test files live under `src/core/`.
- `npm run check`, `npm run lint`, `npm test`, and `treefmt --fail-on-change` all pass (i.e. `npm run presubmit` is green).
- `pictl --version` and `pictl --help` behave exactly as before; the built binary runs from `dist/core/main.js`.
- `cli.ts` no longer contains target-resolution logic; `targets.ts` no longer contains stricli flag/command-builder glue.
- `wait.ts` contains only the `wait` command; `until.ts` contains the condition engine; `tail` and `prompt` obtain their `--until` logic transitively from `until.ts`.
- `src/core/index.ts` exists and re-exports the declared surface; it compiles.
- No `Wait*` condition symbol names remain (`UntilCondition`, `parseUntilCondition`, `applyUntilCondition`, `UNTIL_USAGE`, `UntilTimeoutError`, `UNTIL_COMPLETIONS`).

## Type Design

No function signatures change. The work is moving symbols between files and renaming the condition symbols. Signatures below are reproduced only where a rename or a visibility change applies.

### Change 1 — directory move

All files in `src/` move to `src/core/` unchanged. Because every intra-module import is a sibling import (`"./x.ts"`) and all files move together, **no intra-module import statements change.**

Out-of-tree adjustments:

- `package.json`: `"bin": { "pictl": "dist/main.js" }` → `"dist/core/main.js"`.
- `docs/architecture.md`: links `../src/tty-protocol.ts` and `../src/registry.ts` → `../src/core/tty-protocol.ts` and `../src/core/registry.ts` (and the two `src/...` references in the "Open questions" list).
- `tsconfig.json` / `tsconfig.build.json`: no change required (`rootDir: "src"`, `include: ["src"]`, and the `src/**/*.test.ts` exclude glob all still resolve; output relocates to `dist/core/`).

### Change 2 — split `cli.ts` → `targets.ts` + `cli.ts`

The dependency is one-directional: command-builders consume target resolution, so `cli.ts` imports from `targets.ts`.

**`src/core/targets.ts`** (agent selection/resolution):

```ts
export interface CommandContext extends StricliCommandContext {
  process: StricliProcess & { env: NodeJS.ProcessEnv };
  env: NodeJS.ProcessEnv;
  targets: AgentRecord[];
}

// Currently private in cli.ts; now exported for use by the command builders.
export const targetFlag: /* unchanged literal */;
export const singleTargetFlags: /* unchanged literal */;
export const multiTargetFlags: /* unchanged literal */;

export function determineTargets(
  targetMode: "none" | "single" | "multiple",
  flagTargets: readonly string[],
  env: NodeJS.ProcessEnv,
): string[];

export async function resolveTargets(
  targetInputs: readonly string[],
): Promise<AgentRecord[]>;

export function oneTarget(context: CommandContext): AgentRecord;
export function multiTargets(context: CommandContext): readonly AgentRecord[];
```

`targets.ts` imports `AgentRecord`, `listAgentIds`, `loadAgent` from `./registry.ts` and `UsageError` from `./util.ts`. The target-resolution portion of the current `cli.ts` header comment moves here.

**`src/core/cli.ts`** (stricli command/flag-building glue — name retained) keeps everything else:

- `CompletionFn`, `completeChoices`
- flag-inference type machinery: `CliFlag`, `InferFlagValue`, `OptionalFlagKeys`, `RequiredFlagKeys`, `InferFlags`
- flag builders: `booleanFlag`, `stringFlag`, `variadicStringFlag`, `enumFlag`, `parsedFlag`, `requiredParsedFlag`, `requiredStringFlag`, `secondsFlag`, `restArgs`, `stringArg`
- command-building internals: `CommandSpec`, `Parameters`, `CommandRoute`, `CommandFlagsConstraint`, `markCommon`
- command builders: `commandNoTarget`, `commandOneTarget`, `commandMultiTarget`
- `runCliApp`

`cli.ts` now imports `CommandContext`, `determineTargets`, `resolveTargets`, `singleTargetFlags`, `multiTargetFlags` from `./targets.ts`. The subcommand-building portion of the header comment stays here. The `./registry.ts` imports currently in `cli.ts` (`listAgentIds`, `loadAgent`, `AgentRecord`) move to `targets.ts` along with their only users (`targetFlag`, `resolveTargets`, `CommandContext`); `cli.ts` should no longer import from `registry.ts`.

**Repointing consumers.** The symbols moving to `targets.ts` are imported across the tree, so every `from "./cli.ts"` import that pulls one of them must be split between the two files. Affected importers (each currently imports the moved symbol — often in the same statement as a flag/command builder that stays in `cli.ts`):

- `CommandContext` (11): `daemon.ts`, `wait.ts`, `inspect.ts`, `spawn.ts`, `app.ts`, `lifecycle.ts`, `completion.ts`, `tail.ts`, `attach.ts`, `streaming.ts`, `rpc-commands.ts`
- `oneTarget` (4): `attach.ts`, `wait.ts`, `rpc-commands.ts`, `streaming.ts`
- `multiTargets` (2): `lifecycle.ts`, `inspect.ts`

`determineTargets` and `resolveTargets` have no external importers (only `cli.ts` internals, plus the `determineTargets` unit test which moves to `targets.test.ts`). After the split, `grep -rn 'from "./cli.ts"' src/core` import lines should reference only flag/command builders and `runCliApp`, never `CommandContext`/`oneTarget`/`multiTargets`.

**Test split:** the `determineTargets` unit test (current `cli.test.ts` lines 10–29) moves to a new `src/core/targets.test.ts` importing `determineTargets` from `./targets.ts`. The remaining integration tests in `cli.test.ts` (help/version/parsing/completion, which drive `runCliApp`/`app`) stay, with line 7 changed to import `runCliApp` from `./cli.ts` only.

### Change 3 — extract `until.ts` from `wait.ts`

The condition engine moves to `until.ts`; the `wait` command stays in `wait.ts` and imports the engine.

**`src/core/until.ts`** (the `--until` condition engine):

| moved from `wait.ts`         | new name in `until.ts`         |
| ---------------------------- | ------------------------------ |
| `WaitCondition` (type)       | `UntilCondition`               |
| `parseWaitCondition`         | `parseUntilCondition`          |
| `applyWaitCondition`         | `applyUntilCondition`          |
| `WAIT_UNTIL_USAGE`           | `UNTIL_USAGE`                  |
| `WaitTimeoutError`           | `UntilTimeoutError`            |
| `WAIT_CONDITION_COMPLETIONS` | `UNTIL_COMPLETIONS` (exported) |

Private helpers `waitTurnEnd`, `waitNoActivity`, `withDeadline` move into `until.ts` and keep their names (the verb "wait" accurately describes blocking; they remain unexported). `SOCKET_CONNECT_DEADLINE_MS` stays in `wait.ts` (only the command uses it).

Resulting signatures (unchanged except the renames):

```ts
export class UntilTimeoutError extends Error {} // app.ts maps this to exit code 3
export type UntilCondition =
  | { kind: "turn-end" }
  | { kind: "idle" }
  | { kind: "no-activity"; idleMs: number };
export const UNTIL_USAGE = "turn-end|idle|no-activity:<secs>";
export const UNTIL_COMPLETIONS = ["turn-end", "idle", "no-activity:"] as const;
export function parseUntilCondition(value: string): UntilCondition;
export async function applyUntilCondition(
  client: PiSocketClient,
  condition: UntilCondition,
  timeoutMs: number | undefined,
): Promise<void>;
```

`until.ts` imports `IdleTimeoutError`, `waitIdle` from `./lifecycle.ts`, the `PiSocketClient`/`getState` it needs from `./pi-socket-client.ts`, and `UsageError` from `./util.ts`.

**`src/core/wait.ts`** (the `wait` command only) keeps `waitFlags`, `wait`, `waitCommand`, `waitRoute` and imports `UntilCondition`-family symbols from `./until.ts` (e.g. `parseUntilCondition`, `UNTIL_USAGE`, `UNTIL_COMPLETIONS`, `applyUntilCondition`).

**Consumer updates:**

- `streaming.ts`: import `applyUntilCondition`, `parseUntilCondition`, `UNTIL_USAGE`, `type UntilCondition` from `./until.ts`. `StreamUntil = UntilCondition | { kind: "killed" }`; `STREAM_UNTIL_USAGE = ${UNTIL_USAGE}|killed`; body uses the renamed functions.
- `app.ts`: import `UntilTimeoutError` from `./until.ts`; `determineExitCode` checks `error instanceof UntilTimeoutError`. It continues to import `waitRoute` from `./wait.ts`.

### Change 4 — `src/core/index.ts`

A new file declaring the **provisional** public surface (a header comment must state it is provisional and expected to be pruned once export-visualization tooling lands). First cut, organized by the `sdks-and-helpers.md` "canonical library" responsibilities:

```ts
// pi.sock client
export {
  PiSocketClient,
  connectWithRetry,
  getState,
  type SocketEvent,
  type SessionChangedEvent,
} from "./pi-socket-client.ts";

// tty.sock protocol
export {
  FrameType,
  MAX_PAYLOAD_BYTES,
  encodeFrame,
  encodeResize,
  decodeResize,
  encodeExit,
  decodeExit,
  FrameDecoder,
  type Frame,
  type ResizePayload,
  type ExitPayload,
} from "./tty-protocol.ts";

// registry / agent discovery
export {
  loadAgent,
  listAgentIds,
  piSocketPath,
  ttySocketPath,
  type AgentRecord,
} from "./registry.ts";

// stream consumption
export {
  streamTail,
  streamPrompt,
  parseStreamOutputType,
  parsePromptType,
  parseStreamUntil,
  normalizeFollowUntil,
  STREAM_OUTPUT_TYPES,
  PROMPT_TYPES,
  STREAM_UNTIL_USAGE,
  type StreamOutputType,
  type PromptType,
  type StreamUntil,
  type PromptStreamOptions,
} from "./streaming.ts";

// until-conditions
export {
  parseUntilCondition,
  applyUntilCondition,
  UntilTimeoutError,
  UNTIL_USAGE,
  type UntilCondition,
} from "./until.ts";
```

`index.ts` is a re-export barrel only; it is not imported by any other module (`main.ts` remains the bin entry and is unaffected).

## Edge cases

- The `cli.test.ts` completion test exercises `pictl wait --until` completions; these remain driven by `UNTIL_COMPLETIONS` via the `wait` command, so the test still passes unchanged (it tests CLI behavior, not symbol names).
- `treefmt`/`prettier` may reorder or reformat moved code; the WORK LOG should run `npm run fmt` before declaring a change done.
- The build's `chmod 0o755` target in `package.json` (`dist/main.js`) must be updated to `dist/core/main.js` alongside the `bin` path.

# IMPLEMENTATION IDEAS

- **Sequence:** do the directory move first (purely mechanical, `git mv`, verify green), then the `cli.ts` split, then the `until.ts` extraction, then `index.ts`. Each is a self-contained reviewable unit; the user will review all four together as a batch but they should be landed/committed by the user, not by the agent.
- **Move mechanics:** `git mv src/*.ts src/core/` (including `*.test.ts`). Confirm no import churn with `grep -rn 'from "\.\./' src/core` (should be empty) and `npm run check`.
- **`package.json`:** both the `bin` map and the inline `chmodSync('dist/main.js', ...)` in the `build` script reference the old path; update both.
- **Split verification:** after the `cli.ts` split, `grep -n 'determineTargets\|resolveTargets\|oneTarget\|multiTargets\|CommandContext' src/core/cli.ts` should show only imports, not definitions.
- **Rename verification:** after the `until.ts` extraction, `grep -rn 'WaitCondition\|WaitTimeoutError\|WAIT_UNTIL_USAGE\|WAIT_CONDITION_COMPLETIONS\|parseWaitCondition\|applyWaitCondition' src/core` should be empty.
- **Open follow-ups (out of scope, recorded for continuity):** export-visualization tooling (evaluate api-extractor vs alternatives), pruning the `index.ts` surface, the separate-tests-dir question, and the `wait`-command-removal + `tail`-quiet-mode question.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Change 1: move `src/*` → `src/core/`; update `package.json` (`bin` + `chmod` path) and `docs/architecture.md` links; verify `npm run presubmit`.
- [x] Change 2: split `cli.ts` → `targets.ts` + `cli.ts`; move `determineTargets` test to `targets.test.ts`; update `cli.test.ts` import; verify green.
- [x] Change 3: extract `until.ts` from `wait.ts` with `Wait*`→`Until*` renames; update `streaming.ts` and `app.ts`; verify green.
- [x] Change 4: add `src/core/index.ts` with the provisional surface; verify `npm run check`.
- [x] Final: `npm run presubmit` green (30 tests pass); `npm run build` + `node dist/core/main.js --version`/`--help` confirm the relocated bin works. No commits by agent.

## Implementation-Time Decisions

- **`cli.ts` keeps its `./util.ts` import.** The split removed `determineTargets` (a `UsageError` user) from `cli.ts`, but `secondsFlag` also throws `UsageError`, so `cli.ts` still imports it. Caught by `tsc` after an initial over-eager removal.
- **`WaitTimeoutError` doc comment corrected during the rename.** The original `/** main.ts maps this to exit code 3. */` was inaccurate — the mapping lives in `app.ts`'s `determineExitCode`. Updated to `app.ts` while renaming the class to `UntilTimeoutError`.
- **Condition-semantics comments moved with the engine.** The `turn-end`/`idle`/`no-activity` definitions moved from the `wait.ts` header into `until.ts` (they document `UntilCondition`); `wait.ts`'s header now describes only the command (usage line, exit codes, dormant-agent behavior).
- **`SessionChangedEvent` dropped from the surface (post-review).** Addressing a review TDC, the type moved to `daemon.ts` (its only structural reader) and is no longer exported from `pi-socket-client.ts` or listed in `index.ts`. The Change-4 listing above still shows it as planned; the shipped surface omits it.
