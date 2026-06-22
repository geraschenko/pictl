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
   `isStreaming` queue check (`agent-session.ts:1011` before `:1047`), so the
   command handler runs immediately. A direct `navigate_tree` RPC would instead be
   rejected by the streaming guard.

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
- `--label <str>`: label to attach to the target (new-leaf) entry. Maps to
  `navigateTree`'s `label`; with no summary entry, `navigateTree` applies the label
  to the target entry directly (`agent-session.ts`: "Attach label to target entry
  when not summarizing").
- `--continue <rest-of-line>`: after a successful (non-cancelled) navigation, send
  this as a user message to start a fresh turn on the new branch. Consumes the
  **entire remaining argument string** (so the continuation text needs no inner
  quoting). Optional — omit it to rewind and go idle.
- `--continue-file <path>`: alternative to `--continue`; the file's contents are
  used as the continuation text. At most one of `--continue` / `--continue-file`
  may be given.

`navOptions` passed to `ctx.navigateTree` is exactly `{ label }` (omitted when no
`--label` is given).

The continuation is delivered **verbatim** via `ctx.sendUserMessage` — there is no
slash/skill/template expansion. (Verbatim is acceptable for machine-authored
continuations and is the simplest correct option; full-expansion can be revisited
later if needed — see Non-goals and IMPLEMENTATION IDEAS.)

## Behavior contract

- The command is accepted immediately: the handler returns **before** navigating,
  so the agent's `pictl prompt` call sees success as soon as the request is queued,
  not when navigation completes.
- Navigation fires once the agent's run has finished streaming. Any follow-ups that
  were queued meanwhile run first (on the old branch) and are then rewound away —
  same as a human `/tree` superseding queued input.
- The continuation (`--continue` / `--continue-file`) is sent only if navigation
  was **not cancelled**, and starts a fresh turn on the new branch.
- The detached task **never throws out**; errors are reported via the extension's
  notify channel (`ctx.ui.notify(..., "error")`).
- The handler does not block the turn: it must not `await` quiescence inline before
  returning.

## Type Design

A single standalone pi extension file in `extensions/`. New symbols:

```ts
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Parsed form of the /navigate-tree argument string. */
interface NavigateArgs {
  /** Required positional entry id. */
  targetId: string;
  /** --label value; labels the target (new-leaf) entry. */
  label?: string;
  /** Verbatim continuation text from --continue (rest-of-line). */
  continuation?: string;
  /** Path from --continue-file; resolved to text by the handler. */
  continuationFile?: string;
}

/**
 * Parse the raw argument string (everything after "/navigate-tree ").
 * `--continue` consumes the rest of the line; `--label` / `--continue-file`
 * take a single following token. Throws on a missing targetId or when both
 * `--continue` and `--continue-file` are supplied.
 */
function parseNavigateArgs(raw: string): NavigateArgs;

export default function navigateTreeExtension(pi: ExtensionAPI): void {
  pi.registerCommand("navigate-tree", {
    description: "Navigate the agent's own conversation tree after the current run settles.",
    // handler:
    //   1. parsed = parseNavigateArgs(raw)
    //   2. continuation = parsed.continuation ?? (parsed.continuationFile
    //        ? await readFile(parsed.continuationFile, "utf8") : undefined)
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
      ctx.sendUserMessage(continuation); // verbatim; returns void, reports its own errors
    }
  } catch (err) {
    ctx.ui.notify(`navigate-tree failed: ${err instanceof Error ? err.message : String(err)}`, "error");
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
6. **Label applied.** With `--label`, the target (new-leaf) entry carries the label.
7. **`--continue-file` resolution.** The file's contents are used as the
   continuation text.
8. **Robust detached task.** A failure during the detached settle/navigate/continue
   sequence is surfaced via `ctx.ui.notify(..., "error")` and never throws out of
   the detached task.

## Edge cases

- **`targetId` equals the current leaf:** `navigateTree` no-ops and returns
  `{ cancelled: false }`; a supplied continuation is still sent (no-op rewind, then
  a fresh turn). Acceptable.
- **Navigation cancelled** (`result.cancelled === true`): no continuation is sent.
- **Both `--continue` and `--continue-file`:** `parseNavigateArgs` throws; the
  command surfaces the error and does nothing.
- **`--continue-file` path unreadable:** the file is read in the handler **before
  detaching**, so a bad path makes the handler reject — a normal command failure,
  surfaced inline to the agent's `pictl prompt` call. Navigation never starts.
- **Parse errors** (missing `targetId`, both continue flags): `parseNavigateArgs`
  throws in the handler, so they surface inline the same way — before any detached
  work.
- **Follow-ups queued during the wait:** they run on the old branch and are then
  rewound away by the navigation — same as a human `/tree` superseding queued
  input.

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

- **Inline-during-streaming is real.** `agent-session.ts:1011` runs
  `_tryExecuteExtensionCommand` before the `isStreaming` queue check (`:1047`). The
  slash command is accepted while streaming; the `navigate_tree` RPC is not.
- **ctx stays valid after the handler returns.** `runner.ts`'s `assertActive()`
  throws only once `staleMessage` is set, and that happens **only** on session
  *replacement/dispose* (`newSession` / `fork` / `switchSession` / `reload`;
  `agent-session.ts:745`). `navigateTree` does **not** invalidate the ctx, so the
  detached `navigateTree` → `sendUserMessage` chain is safe. We do not need to
  register an `agent_end`-triggered action instead of a free-floating promise.
- **`ctx.sendUserMessage` is verbatim.** It calls `AgentSession.sendUserMessage` →
  `prompt(text, { expandPromptTemplates: false, source: "extension" })`
  (`agent-session.ts:1384`). Returns `void` and reports its own errors via
  `emitError`. This is the chosen continuation transport (Option C).
- **`--label` works without summarize.** `navigateTree` applies `label` to the
  target entry when there is no summary entry (`agent-session.ts`: "Attach label to
  target entry when not summarizing").

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

`parseNavigateArgs(raw)` operates on the full string after `/navigate-tree `:

1. If `--continue ` appears, split there: everything after it (rest-of-line) is the
   verbatim `continuation`; the prefix is the "head". (`--continue` must therefore
   be the last flag.)
2. Tokenize the head on whitespace. The first non-flag token is `targetId`
   (required). `--label <token>` and `--continue-file <token>` each consume the
   next single token.
3. Reject if `targetId` is missing, or if both `continuation` and
   `continuationFile` are set.

`--continue-file` is resolved to text by the handler via `node:fs/promises`
`readFile` **before detaching**, so a bad path fails fast and the captured text is
immune to later filesystem changes. Labels containing spaces are an edge case not
covered by the single-token rule; if that proves limiting, prefer `--label` before
`--continue` and revisit quoting.

## Error reporting

The detached task is fire-and-forget; it must not throw. Failures *inside* it
(navigation errors) are reported via `ctx.ui.notify(message, "error")`. In rpc mode
(how pictl runs pi) `notify` emits an `extension_ui_request` on the rpc output
stream (`rpc-mode.ts:130`), so the error is surfaced rather than swallowed.

**Known limitation:** a detached-task failure is reported *out of band* (rpc
output / attached human), **not** back into the requesting agent's context — by the
time it fires, the requesting turn is long over, so there is no clean channel into
the agent's conversation. Failures that can be detected *before* detaching (parse
errors, an unreadable `--continue-file`) are kept in the handler precisely so they
surface inline to the agent's `pictl prompt` call instead.

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

- [ ] Implement `extensions/navigate-tree.ts`: `parseNavigateArgs`, the command
      registration, and the detached settle→navigate→continue task (using
      `ctx.waitForIdle` with the `waitForSettled` TODO).
- [ ] `parseNavigateArgs` unit tests: targetId required; `--label`; `--continue`
      rest-of-line (incl. embedded spaces/quotes/slashes); `--continue-file`;
      both-continue-flags error.
- [ ] Behavior verification: accepted mid-turn; handler returns before navigation;
      navigation after the run; continuation on the new branch; rewind-and-idle;
      label applied; cancelled → no continuation; detached task never throws.
- [ ] Fresh-context blind-spot review per `skills/pictl/reviewer.md`; iterate.
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
- **Standalone extension in `extensions/`.** No pictl CLI / daemon / install
  integration in this spec; that is a follow-up spec.
- **Start on `waitForIdle`, upgrade to `waitForSettled`.** The race-free primitive
  is being built in pi in parallel and is not in the pinned pi yet; the extension
  ships on `waitForIdle` with a one-line swap pending.
- **Detached free-floating promise is safe** (not an `agent_end`-registered
  action): `assertActive()` only fails after session replacement, which
  self-navigation does not trigger.

*Work log entries go here*
