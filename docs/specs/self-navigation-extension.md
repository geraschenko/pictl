# `/navigate-tree` extension (agent self-navigation)

# SPEC

## Problem

A running agent cannot navigate **its own** conversation tree from inside a turn.
The natural thing for the agent to try —

```
pictl -t $PI_AGENT_ID navigate-tree <targetId>
```

— issues the `navigate_tree` RPC, which is **rejected while the session is
streaming** (`AgentSession.navigateTree`: "Cannot navigate the session tree while
streaming or compacting"). But streaming is exactly the state the agent is in when
it runs the command from within its own turn. So self-navigation is impossible
through the RPC.

We want an agent to be able to say, in effect: "explore messily, then rewind to a
clean point carrying only a summary, and continue" — triggered from inside its own
turn by an ordinary shell call.

## What we want

A pi extension that registers a `/navigate-tree` slash command. The agent triggers
self-navigation with:

```
pictl prompt "/navigate-tree <targetId> --continue 'Resume implementing X using the summary above.'"
```

The command is **accepted immediately** (mid-turn, while streaming), and the actual
tree navigation is **deferred** until the agent's run has finished, then optionally
followed by a continuation prompt on the new branch.

This is the **Option C** realization discussed in design: all the deferral behavior
lives in this extension; pi core is not modified for it. We deliberately do **not**
use the `navigate_tree` RPC for self-navigation (it rejects during streaming), and
we do **not** add any deferral/continuation parameters to that RPC.

## Why this shape works (the two hard constraints)

1. **The request must be accepted while the agent is mid-turn.** When the agent
   runs `pictl prompt "/navigate-tree …"`, its own turn is streaming. Extension
   commands invoked via `prompt` execute **inline even during streaming**: pi's
   `AgentSession.prompt` runs `_tryExecuteExtensionCommand` *before* the
   `isStreaming` queue check (`core/agent-session.ts:1011-1015` before `:1048`), so
   the command handler runs immediately. A direct `navigate_tree` RPC would instead
   be rejected by the streaming guard.

2. **The handler must return immediately, and the actual navigation must wait for
   the run to finish.** The handler runs inside `prompt()`, which is what the
   agent's `bash` tool call is blocked on. If the handler blocks (e.g. `await`s
   idle inline), the turn can never end → deadlock. And navigation itself
   (`ctx.navigateTree`) throws while streaming and would corrupt agent state if it
   ran concurrently with the run. So the handler **detaches** a continuation that
   waits for the session to finish streaming, then navigates, then optionally
   continues.

## Command surface

```
/navigate-tree <targetId> [--label <str>] [ --continue <rest-of-line> | --continue-file <path> ]
```

- `targetId` (positional, required): an entry id from `pictl get-tree` /
  `pictl get-entries`. Semantics are inherited from `navigateTree`: a user /
  custom message target rewinds to *before* it; any other entry becomes the new
  leaf.
- `--label <str>`: label passed through to `navigateTree`'s `label`. **Note:** with
  no summary entry, `navigateTree` applies the label to `targetId` itself
  (`core/agent-session.ts:2889`: "Attach label to target entry when not
  summarizing"), **not** to the resulting leaf. For a non-user/custom target these
  coincide (`newLeafId === targetId`); for a user/custom-message target the new leaf
  is the target's *parent*, so the label lands on the rewound-before message, not
  the leaf.
- `--continue <rest-of-line>`: after a successful (non-cancelled) navigation, send
  this as a user message to start a fresh turn on the new branch. The **first
  standalone `--continue` token** ends flag parsing and consumes the **entire raw
  remainder** of the argument string verbatim — including any later text that looks
  like a flag (so the continuation needs no inner quoting). Optional — omit it to
  rewind and go idle.
- `--continue-file <path>`: alternative to `--continue`; the file's contents are
  used as the continuation text. `--continue` and `--continue-file` are mutually
  exclusive — supplying both (i.e. a `--continue-file` token *before* a `--continue`
  token) is a parse error.

`navOptions` passed to `ctx.navigateTree` is exactly `{ label }` (omitted when no
`--label` is given).

The continuation is delivered **verbatim** via `ctx.sendUserMessage` — there is no
slash/skill/template expansion. (Verbatim is acceptable for machine-authored
continuations and is the simplest correct option; full-expansion can be revisited
later if needed — see Non-goals and IMPLEMENTATION IDEAS.)

## Behavior contract

- The command is accepted immediately: the handler returns **before** navigating.
  Because pi treats a handled extension command as a successful prompt, the agent's
  `pictl prompt` call reports success as soon as the command is accepted — *not*
  when navigation completes, and (see Error reporting) *regardless of* whether the
  handler later detects an error.
- Navigation fires once the agent's run has finished streaming.
- **Under `waitForSettled` (the eventual target):** any follow-ups queued meanwhile
  run first (on the old branch) and are then rewound away — same as a human `/tree`
  superseding queued input. **Under the initial `waitForIdle` implementation this
  ordering is NOT guaranteed:** `waitForIdle` can resolve during retry backoff or
  before compaction / queued-continuation drives, so navigation may race that
  pending work. This is the known limitation the `waitForSettled` swap resolves; see
  IMPLEMENTATION IDEAS.
- The continuation (`--continue` / `--continue-file`) is sent only if navigation
  was **not cancelled**, and starts a fresh turn on the new branch.
- The detached task **never throws out**; errors are reported via the extension's
  notify channel (`ctx.ui.notify(..., "error")`) — out of band (see Error reporting).
- The handler does not block the turn: it must not `await` quiescence inline before
  returning.
- **Best-effort lifecycle.** The detached task is a free-floating promise tied to
  the live process. If the pi process exits, the daemon shuts down, or the session
  is replaced (`newSession`/`fork`/`switchSession`/`reload`) before it reaches
  navigation, the navigation simply does not happen. Concretely, after a session
  replacement the `ctx` methods throw `assertActive` (`ctx.ui` is itself a guarded
  getter, runner.js:415-417), so the task's `try/catch` swallows the navigation
  error and the error-report path is itself guarded so the task never throws out
  (see Error reporting / criterion 9). There is no persistence or resume;
  self-navigation is best-effort within the lifetime of the current run.

## Type Design

A single standalone pi extension file in `extensions/`. New symbols:

```ts
import type { ExtensionAPI, ExtensionCommandContext } from "@geraschenko/pi-coding-agent";

/** Parsed form of the /navigate-tree argument string. */
interface NavigateArgs {
  /** Required positional entry id. */
  targetId: string;
  /** --label value; passed to navigateTree, which labels targetId (see surface note). */
  label?: string;
  /** Verbatim continuation text from --continue (rest-of-line). */
  continuation?: string;
  /** Path from --continue-file; resolved to text by the handler. */
  continuationFile?: string;
}

/**
 * Parse the raw argument string (everything after "/navigate-tree ").
 * `--continue` consumes the rest of the line; `--label` / `--continue-file`
 * take a single following token. Throws on: a missing targetId; both
 * `--continue` and `--continue-file` supplied; an empty/whitespace-only
 * `--continue`. (Empty `--continue-file` contents are rejected by the handler
 * after reading the file.)
 */
function parseNavigateArgs(raw: string): NavigateArgs;

export default function navigateTreeExtension(pi: ExtensionAPI): void {
  pi.registerCommand("navigate-tree", {
    description: "Navigate the agent's own conversation tree after the current run settles.",
    // handler:
    //   1. parsed = parseNavigateArgs(raw)  (throws on empty --continue, etc.)
    //   2. continuation = parsed.continuation ?? (parsed.continuationFile
    //        ? await readFile(parsed.continuationFile, "utf8") : undefined)
    //      then: if a continuation flag was given but the text is empty/whitespace
    //      after trimming, throw (the empty --continue-file case).
    //   3. detach: settle → navigate → continue (see detached-task skeleton)
    //   4. return (synchronously, before navigation)
    handler: async (raw: string, ctx: ExtensionCommandContext): Promise<void> => {
      throw new Error("todo");
    },
  });
}
```

Detached-task skeleton (inside the handler, after parsing/resolving):

```ts
const navOptions = label !== undefined ? { label } : {};
void (async () => {
  try {
    // TODO: switch to ctx.waitForSettled() once it lands in the pinned pi
    // (docs/specs/self-navigation-extension.md → Dependencies). waitForIdle
    // resolves at the end of a single run and races auto-retry/compaction;
    // waitForSettled resolves only at full session quiescence.
    await ctx.waitForIdle();
    const result = await ctx.navigateTree(targetId, navOptions);
    if (continuation !== undefined && !result.cancelled) {
      pi.sendUserMessage(continuation); // verbatim; returns void, reports its own errors
    }
  } catch (err) {
    // ctx.ui is a getter that asserts the session is still active, so guard the
    // report too: if the session was replaced, drop it silently rather than
    // escaping as an unhandled rejection (criterion 9 / best-effort lifecycle).
    try {
      ctx.ui.notify(`navigate-tree failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } catch { /* session no longer active */ }
  }
})();
```

Existing pi types this design relies on (unchanged):

```ts
// pi: ExtensionCommandContext (packages/coding-agent/src/core/extensions/types.ts)
navigateTree(
  targetId: string,
  options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
): Promise<{ cancelled: boolean }>;
waitForIdle(): Promise<void>;
// pi: ExtensionAPI (NOT ExtensionCommandContext) — sendUserMessage lives on the `pi`
// object, not `ctx`. The command-context type has no sendUserMessage; only
// ExtensionAPI and the post-switch ReplacedSessionContext do. Both route to the
// same verbatim AgentSession.sendUserMessage (expandPromptTemplates: false).
sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { deliverAs?: "steer" | "followUp" }): void;
// pi: registerCommand(name, { description?, getArgumentCompletions?, handler })
//   handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
```

## Success criteria

1. **Accepted mid-turn.** Issued via `pictl prompt "/navigate-tree …"` while the
   agent is streaming, the command handler runs and returns without error; the
   `pictl prompt` call reports success.
2. **No deadlock.** The handler returns before navigation; the agent's run
   completes normally (the `bash`/`prompt` call is not blocked on navigation).
3. **Navigation after the run, not during.** `ctx.navigateTree` runs only after the
   run finishes streaming, so it does not hit the streaming guard and does not
   corrupt state.
4. **Continuation on the new branch.** With `--continue`/`--continue-file`, after a
   non-cancelled navigation the continuation text is delivered verbatim as a new
   user turn on the new branch.
5. **Rewind-and-idle.** With no continuation flag, navigation rewinds and the
   session goes idle; nothing further is sent.
6. **Label applied.** With `--label`, the target entry (`targetId`) carries the
   label (the new leaf for a non-user/custom target; the rewound-before message for
   a user/custom target).
7. **`--continue-file` resolution.** The file's contents are used as the
   continuation text; an empty/whitespace-only file is an error (no navigation).
8. **Empty continuation rejected.** A continuation flag with empty/whitespace-only
   text is an error (handler throws, no navigation), distinct from omitting the flag
   (criterion 5).
9. **Robust detached task.** A failure during the detached wait/navigation, or a
   synchronous throw from calling `ctx.sendUserMessage`, is surfaced via
   `ctx.ui.notify(..., "error")` and never throws out of the detached task — even
   when the session has been replaced and `ctx` is stale, since the `notify` call is
   itself guarded (see Error reporting / Implementation-Time Decisions). (Async
   continuation-delivery failures are emitted separately by the runtime as
   `extension_error` and are not observable by the task — see Error reporting #3.)

## Edge cases

- **`targetId` equals the current leaf:** `navigateTree` no-ops and returns
  `{ cancelled: false }`; a supplied continuation is still sent (no-op rewind, then
  a fresh turn). Acceptable.
- **Navigation cancelled** (`result.cancelled === true`): no continuation is sent.
- **Parse errors** (missing `targetId`; a `--continue-file` token before a
  `--continue` token) and an **unreadable `--continue-file`**: detected in the
  handler **before detaching**, so navigation never starts. The handler throws; pi
  catches it in `_tryExecuteExtensionCommand` and emits an extension *command-error*
  event (`core/agent-session.ts:1176-1181`) — it does **not** fail the agent's
  `pictl prompt` call, which still reports success. Reading `--continue-file` in the
  handler (not the detached task) keeps these failures pre-navigation and surfaced
  promptly, even though they are out of band (see Error reporting).
- **Empty / whitespace-only continuation** (`--continue` with no following text, or
  a `--continue-file` whose contents are blank after trimming): **error.** A
  continuation flag with no text is treated as a malformed command, not as "omit the
  continuation" — the handler throws (→ command-error event) and **navigation does
  not happen**. (Omitting the continuation entirely — no flag at all — remains the
  valid rewind-and-idle path.)
- **Follow-ups queued during the wait:** under `waitForSettled` they run on the old
  branch and are then rewound away by the navigation (same as a human `/tree`
  superseding queued input); under the initial `waitForIdle` impl this ordering is
  not guaranteed (see Behavior contract).

## Non-goals

- **No pictl CLI / daemon / install integration.** This spec is the standalone
  extension only (lives in `extensions/`). Bundling it into pictl-spawned agents
  (e.g. installing into the agent's `.pi/extensions/` at daemon setup) is a
  **follow-up spec**.
- **No changes to `navigate_tree`** (RPC, command, or `AgentSession.navigateTree`),
  and no deferral/continuation parameters added to any RPC.
- **No continuation expansion.** The continuation is sent verbatim; matching a real
  `pictl prompt` (slash/skill/template expansion, `source: "rpc"`) is explicitly
  out of scope for this spec.
- **No `--summarize` / `--custom-instructions` / `--replace-instructions`.** The
  continuation message *is* the agent's summary, so pi's auto branch-summary is not
  exposed by this command. (Only `--label` of the `navigateTree` option family is
  surfaced.)
- **No guardrail policy** (e.g. requiring a note before self-navigation). The
  extension is a clean mechanism; agent-side discipline (below) is workflow, not
  extension logic.

---

# IMPLEMENTATION IDEAS

## Verified pi internals (load-bearing)

All line numbers are in `packages/coding-agent/src/` of the pi repo.

- **Inline-during-streaming is real.** `core/agent-session.ts:1011-1015` runs
  `_tryExecuteExtensionCommand` before the `isStreaming` queue check (`:1048`). The
  slash command is accepted while streaming; the `navigate_tree` RPC is not.
- **Handler errors are caught, not propagated.** `_tryExecuteExtensionCommand`
  wraps `await command.handler(...)` in `try { … return true } catch { emitError;
  return true }` (`core/agent-session.ts:1170-1182`), so a throwing handler is
  reported as a command extension-error event and the prompt is still treated as
  handled/successful. There is no inline-to-`pictl-prompt` failure path; all errors
  are out of band.
- **ctx stays valid after the handler returns.** `core/extensions/runner.ts`'s
  `assertActive()` (`:510-519`) throws only once `staleMessage` is set, and that
  happens **only** on session *replacement/dispose* (`newSession` / `fork` /
  `switchSession` / `reload`; runner/loader invalidation, `core/extensions/loader.ts:129`).
  `navigateTree` does **not** invalidate the ctx, so the detached `navigateTree` →
  `sendUserMessage` chain is safe. We do not need to register an
  `agent_end`-triggered action instead of a free-floating promise.
- **`pi.sendUserMessage` is verbatim, and lives on `pi`, not `ctx`.** In the pinned
  pi (`@geraschenko/pi-coding-agent` 0.79.8-fork.0) the command context
  (`ExtensionCommandContext`) has **no** `sendUserMessage`; it is exposed on the
  `ExtensionAPI` object (the `pi` factory arg) and, separately, on the post-switch
  `ReplacedSessionContext`. Both route to `AgentSession.sendUserMessage`, which calls
  `prompt(text, { expandPromptTemplates: false })`
  (`dist/core/agent-session.js:1020-1043`, expansion-disabled at `:1043`) — verbatim.
  The `pi.sendUserMessage` action is wired void/fire-and-forget with a `.catch` that
  emits an extension error event `send_user_message`
  (`dist/core/agent-session.js:1750-1758`), so the detached task cannot observe a
  continuation-delivery failure. This is the chosen continuation transport
  (Option C). The handler closes over `pi`, so the detached task calls
  `pi.sendUserMessage` directly.
- **`--label` applies without summarize, but to `targetId`.** `navigateTree`
  attaches `label` to `targetId` when there is no summary entry
  (`core/agent-session.ts:2889`: "Attach label to target entry when not
  summarizing"). For user/custom-message targets the new leaf is `targetId`'s parent
  (`:2844-2860`), so the label is not on the resulting leaf.
- **rpc-mode `notify` emits.** In rpc mode `notify` writes an `extension_ui_request`
  to the rpc output stream (`modes/rpc/rpc-mode.ts:130-138`).

## `waitForIdle` now, `waitForSettled` later

`ctx.waitForIdle()` resolves at the end of a **single** agent run. During an
auto-retry it resolves *during the exponential backoff*, before the retry runs, and
during auto-compaction / queued-continuation drives it can resolve before the
session is truly done. Navigating there races the session's continuation and can
corrupt state. The correct signal is `ctx.waitForSettled()`, which resolves only
once the session has fully quiesced (run + retries/backoff + compaction + queued
continuations).

`waitForSettled` is a pi-side primitive **being built in parallel**
(`/home/anton/git/earendil-works/pi/docs/wait-for-settled.md`) and is **not present
in the pinned pi yet**. Per review decision, the initial implementation uses
`ctx.waitForIdle()` with the `TODO` above; the swap to `waitForSettled` is a
one-line change gated on that primitive landing. This extension is the motivating
consumer for `waitForSettled`.

## Arg parsing

`parseNavigateArgs(raw)` operates on the full string after `/navigate-tree `, with
**token-level** (not substring) recognition. The `raw` it receives is verbatim:
`_tryExecuteExtensionCommand` slices `text.slice(spaceIndex + 1)` and does **not**
trim it for extension commands (`dist/core/agent-session.js:842-843`; skill commands
trim at `:873`, extension commands do not), so embedded/leading whitespace in the
continuation survives to the parser.

1. Scan tokens left-to-right. The **first standalone `--continue` token** ends flag
   parsing: the raw remainder after it (skipping one separating space) becomes the
   verbatim `continuation` — embedded spaces, quotes, slashes, and flag-looking text
   are all literal. `--continue` is therefore necessarily the last flag.
2. Before that point, recognized flags are `--label <token>` and
   `--continue-file <token>` (each consuming one following token); the first bare
   (non-flag) token is `targetId`.
3. Errors (handler throws `Error`, caught by pi → command-error event):
   - `targetId` missing;
   - both a `--continue-file` token and a `--continue` token present;
   - a continuation flag present but its text empty/whitespace-only after trimming.

The empty-continuation check has two sites: `parseNavigateArgs` rejects an empty
`--continue` directly; the handler rejects an empty `--continue-file` *after* reading
it. Both are pre-navigation (the handler reads the file before detaching) and throw,
so navigation never starts. `--continue-file` is read via `node:fs/promises`
`readFile`, so a bad path is caught pre-navigation too and the captured text is
immune to later filesystem changes.

Known limits of this grammar: `--label` / `--continue-file` values are single
whitespace-delimited tokens (no spaces); a value with spaces is not expressible.
This is acceptable for ids and labels; if it bites, revisit quoting.

## Error reporting

There are three distinct error paths, and **all are out of band** — none fails the
agent's `pictl prompt` call or returns into the agent's conversation:

1. **Pre-detach (handler) errors** — parse errors, unreadable `--continue-file`. The
   handler throws; pi catches it and emits a command extension-error event
   (`core/agent-session.ts:1176-1181`). Kept in the handler so they fire *before*
   any navigation and surface promptly.
2. **Detached navigation errors** — `ctx.navigateTree` rejecting. Caught by the
   detached task's `try/catch` and reported via `ctx.ui.notify(message, "error")`,
   which in rpc mode emits an `extension_ui_request` on the rpc output stream
   (`modes/rpc/rpc-mode.ts:130-138`). The task never throws out.
3. **Continuation-delivery errors** — `pi.sendUserMessage` is typed `void` and
   fire-and-forget; its async failures are caught by the runtime and emitted as an
   extension error event (`send_user_message`, `dist/core/agent-session.js:1750-1758`).
   The detached task cannot observe them.

**Known limitation:** because the requesting turn is long over by the time the
detached task runs, there is no clean channel to deliver any of these errors back
into the requesting agent's context — only out-of-band (rpc output / attached
human). An agent that needs to confirm a self-navigation succeeded must observe its
own tree (e.g. `pictl get-tree`) on the next turn rather than rely on an error
surfacing.

## Where the extension lives / loading

A standalone pi extension
(`export default function (pi: ExtensionAPI) { pi.registerCommand("navigate-tree", { … }) }`,
per pi's `examples/extensions/commands.ts`), placed in `extensions/`. pi has no
existing `/navigate-tree` slash command (only the `navigate_tree` RPC), so there is
no name collision. Users opt in by loading it from their pi extensions directory.
Auto-installing it into pictl-spawned agents is deferred to a follow-up spec.

## Recovery-packet / provenance discipline (agent-facing guidance, not extension logic)

`navigate-tree` rolls back only the *conversation* branch, not the filesystem, git,
processes, or external effects (see `docs/thoughts/metacognition-with-pictl.md`).
The continuation becomes the agent's memory, so before a high-risk self-navigation
the agent should record a recovery packet (entry to return to, user
intent/constraints, state planes touched, claims-with-provenance, side effects,
next prompt) inside the continuation text. This is **agent workflow**, not extension
logic — the extension just carries the `--continue` text and applies `--label`.

## Review

Before implementation, do a fresh-context blind-spot review of this spec per
`skills/pictl/reviewer.md` (critic/advocate loop): spawn a read-only reviewer,
focus on omissions, unsafe failure modes, and overconfident claims, then iterate.

## Dependencies

- pi extension command APIs already present in the pinned pi: `registerCommand`,
  `ctx.navigateTree`, `ctx.sendUserMessage`, `ctx.waitForIdle`, `ctx.ui.notify`,
  and inline execution of extension commands during streaming.
- pi `ctx.waitForSettled` —
  `/home/anton/git/earendil-works/pi/docs/wait-for-settled.md`. **Not required to
  ship**; it is the eventual upgrade target for the quiescence wait (see above).

---

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

## Tasks

- [x] Implement `extensions/navigate-tree.ts`: `parseNavigateArgs`, the command
      registration, and the detached settle→navigate→continue task (using
      `ctx.waitForIdle` with the `waitForSettled` TODO). Typechecks clean
      (`tsc --noEmit --strict` against the file).
- [x] `parseNavigateArgs` unit tests (`extensions/navigate-tree.test.ts`, 16 tests
      passing): targetId required; `--label` (before/after targetId); `--continue`
      rest-of-line (incl. embedded spaces/quotes/slashes, one-separator skip,
      flag-looking text); `--continue-file`; both-continue-flags conflict (and the
      after-`--continue` non-conflict); empty/whitespace `--continue` error; plus the
      fail-closed completeness cases (unknown flag, missing value, duplicate flag,
      extra positional).
- [ ] Behavior verification: accepted mid-turn; handler returns before navigation;
      navigation after the run; continuation on the new branch; rewind-and-idle;
      label applied; cancelled → no continuation; detached task never throws.
- [x] Fresh-context blind-spot review per `skills/pictl/reviewer.md`; findings
      applied (see below).
- [x] Decide empty/whitespace-only continuation behavior → **error** (see Decisions).
- [ ] (Gated on pi) swap `ctx.waitForIdle` → `ctx.waitForSettled` when it lands.

## Decisions

- **Option C (verbatim continuation).** Continuation is sent via
  `ctx.sendUserMessage` (verbatim, no expansion). Simplest correct option;
  full-expansion can be revisited later if needed.
- **Command surface trimmed.** Keep `--label`; drop `--summarize`,
  `--custom-instructions`, `--replace-instructions` — the continuation message *is*
  the agent's summary, so pi's auto branch-summary is not exposed.
- **`--continue` is rest-of-line**, with `--continue-file <path>` as an optional
  alternative (avoids quoting fragility).
- **Empty/whitespace-only continuation is an error**, not a silent omit. A
  continuation flag with no text is almost always a malformed command (e.g. an
  empty shell-variable expansion); failing closed (no navigation) is safer than
  navigating and silently discarding the intended summary. Omitting the flag
  entirely remains the valid rewind-and-idle path.
- **Standalone extension in `extensions/`.** No pictl CLI / daemon / install
  integration in this spec; that is a follow-up spec.
- **Start on `waitForIdle`, upgrade to `waitForSettled`.** The race-free primitive
  is being built in pi in parallel and is not in the pinned pi yet; the extension
  ships on `waitForIdle` with a one-line swap pending.
- **Detached free-floating promise is safe** (not an `agent_end`-registered
  action): `assertActive()` only fails after session replacement, which
  self-navigation does not trigger.

## Implementation-Time Decisions

- **Continuation transport is `pi.sendUserMessage`, not `ctx.sendUserMessage`**
  (forced; behavior-identical). The approved Type Design called `ctx.sendUserMessage`,
  but in the pinned pi (`@geraschenko/pi-coding-agent` 0.79.8-fork.0) the command
  context has no such method — it lives on the `ExtensionAPI` (`pi`) object. The
  handler closes over `pi`, so the detached task calls `pi.sendUserMessage`. Both
  the `pi` action and the (absent-here) ctx method route to the same verbatim
  `AgentSession.sendUserMessage` (`expandPromptTemplates: false`), and the `pi`
  action is the same void/fire-and-forget shape (errors → `send_user_message`
  extension error event). Option C and all error-path claims are unchanged; only the
  receiver changed. Spec Type Design / IMPLEMENTATION IDEAS / Error reporting updated.
- **Import path is `@geraschenko/pi-coding-agent`** (the fork actually depended on),
  not the upstream `@earendil-works/pi-coding-agent` the spec drafted against.
- **Error reporter is guarded against a stale `ctx`** (review finding). `ctx.ui` is
  a getter that calls `assertActive()` (runner.js:415-417), so after a session
  replacement the detached task's `catch` would itself throw when it tried to
  `notify`, producing an unhandled rejection and violating criterion 9. The `notify`
  call is wrapped in its own `try/catch`; on a stale ctx the report is dropped
  silently — matching the best-effort lifecycle (navigation "simply does not
  happen"). Updated Type Design skeleton, Behavior contract lifecycle note.
- **Parser fails closed beyond the spec's three explicit throws.** The spec's error
  contract names: missing `targetId`, both continue flags, empty `--continue`. A
  total parser must also define behavior for the remaining malformed inputs; per the
  spec's own fail-closed philosophy (see the empty-continuation Decision) each
  **throws** rather than silently dropping input: an unknown `--flag`, a flag missing
  its value (`--label`/`--continue-file` at end of input), a duplicate
  `--label`/`--continue-file`, and a second bare positional argument. These are
  command-error events like the other parse errors (out of band). Flagged for owner
  review — easy to relax to last-wins/ignore if any prove too strict.
- **`parseNavigateArgs` and `NavigateArgs` are exported** (the spec drafted them as
  module-private). Needed so the spec-mandated unit tests can import them; no runtime
  effect.
- **`extensions/` is outside the project's `tsc`/test globs** (`tsconfig.json`
  includes only `src`; `npm test` globs `src/**/*.test.ts`). The extension is
  typechecked ad hoc (`npx tsc --noEmit --strict … extensions/navigate-tree.ts`) and
  its test run directly (`node --test extensions/navigate-tree.test.ts`). Wiring
  `extensions/` into the build/test harness belongs with the deferred pictl-integration
  follow-up spec, not here.

## Review findings (fresh-context reviewer, applied)

- **Error visibility corrected (high-confidence).** `_tryExecuteExtensionCommand`
  catches handler throws and still reports the prompt as handled
  (`core/agent-session.ts:1170-1182`), so there is **no** inline-to-`pictl-prompt`
  failure path. Rewrote Behavior contract / Edge cases / Error reporting: all error
  paths are out of band. Pre-detach detection is still kept in the handler (fails
  before navigation, surfaces promptly), but as a command-error event, not a prompt
  failure.
- **`--label` semantics corrected (high-confidence).** `navigateTree` labels
  `targetId`, not the new leaf (`:2889`); for user/custom-message targets the leaf
  is the parent. Fixed all "new-leaf" wording.
- **Queued-follow-up ordering downgraded (high-confidence).** That ordering holds
  only under `waitForSettled`; the initial `waitForIdle` impl does not guarantee it.
  Marked as a known limitation in the contract.
- **Detached-task lifecycle made explicit (high-confidence).** Added a best-effort
  caveat: the free-floating promise is lost on process exit / daemon shutdown /
  session replacement before navigation; no persistence/resume.
- **Arg grammar tightened (speculative).** Switched from substring `--continue `
  detection to token-level recognition; defined the `--continue`/`--continue-file`
  conflict precisely; flagged empty-continuation as an open item.
- **Stale pi paths fixed.** All references now use the real `core/…` / `modes/…`
  paths and verified line numbers.
- Reviewer **confirmed** the load-bearing claims: inline-before-streaming-queue,
  `assertActive` (safe post-handler), verbatim `sendUserMessage`, label-without-
  summarize, rpc-mode `notify` emits.

*Work log entries go here*
