# Handoff: `/self-navigate` extension (agent self-navigation)

> **Status:** handoff / not started. Depends on the pi-side `waitForSettled`
> primitive (`/home/anton/git/earendil-works/pi/docs/wait-for-settled.md`), which
> is being implemented in parallel. This doc is the design to pick up once (or in
> tandem with) that primitive landing.

## Goal

Let a running agent navigate **its own** conversation tree from inside a turn —
e.g. "explore messily, then rewind to a clean point carrying only a summary, and
continue." The agent triggers this with an ordinary shell call in its own turn:

```
pictl prompt "/self-navigate <targetId> --summarize --continue 'Resume implementing X using the summary above.'"
```

(Or via a thin `pictl self-navigate …` wrapper that just sends that prompt — see
"pictl surface" below.)

This is the **Option C** realization discussed in design: all the fancy behavior
lives in this extension; pi core only contributes the generic `waitForSettled`
signal. We deliberately do **not** use the `navigate_tree` RPC for self-navigation
(it rejects during streaming, which is exactly when a self-navigating agent calls
it), and we do **not** add any deferral/continuation parameters to that RPC.

## Why this shape works (the two hard constraints)

1. **The request must be accepted while the agent is mid-turn.** When the agent
   runs `pictl prompt "/self-navigate …"`, its own turn is streaming. Extension
   commands invoked via `prompt` execute **inline even during streaming**
   (pi: `AgentSession.prompt` runs `_tryExecuteExtensionCommand` before the
   `isStreaming` queue check), so the command handler runs immediately. A direct
   `navigate_tree` RPC would instead be rejected by the streaming guard.

2. **The handler must return immediately, and the actual navigation must wait for
   true quiescence.** The handler runs inside `prompt()`, which is what the
   agent's `bash` tool call is blocked on. If the handler blocks (e.g. `await`s
   idle inline), the turn can never end → deadlock. And navigation itself
   (`ctx.navigateTree`) throws while streaming and would corrupt agent state if it
   ran concurrently with the run, a retry, or a compaction. So the handler
   **detaches** a continuation that waits for the session to fully settle, then
   navigates, then optionally continues:

```ts
// inside the command handler — returns synchronously, navigation happens later
void (async () => {
  try {
    await ctx.waitForSettled();              // NOT waitForIdle — see below
    const result = await ctx.navigateTree(targetId, navOptions);
    if (continuation && !result.cancelled) {
      await ctx.sendUserMessage(continuation); // starts a new turn — see expansion caveat below
    }
  } catch (err) {
    // surface via ctx.ui.notify / pi.emitError; never throw out of the detached task
  }
})();
// handler returns here → prompt() returns → bash returns → turn proceeds → settles
```

**Why `waitForSettled`, not `waitForIdle`:** `waitForIdle` resolves at the end of
a single agent run, which during an auto-retry happens *during the exponential
backoff*, before the retry runs. Navigating there races the session's
continuation and can corrupt state (and `navigateTree`'s own guard may pass in the
transient `isStreaming === false` window). `waitForSettled` resolves only once the
session has fully quiesced (run + retries/backoff + compaction + queued
continuations). This extension is the motivating consumer for that primitive.

## Command surface

`/self-navigate <targetId> [flags]`

- `targetId` (positional, required): an entry id from `pictl get-tree` /
  `pictl get-entries`. Semantics are inherited from `navigateTree`: a user /
  custom message target rewinds to *before* it; any other entry becomes the new
  leaf.
- `--summarize`: generate a branch summary of the abandoned branch and attach it
  at the new leaf (maps to `navigateTree`'s `summarize`).
- `--custom-instructions <str>`: summarizer instructions (`customInstructions`).
- `--replace-instructions`: `customInstructions` replaces the default summarizer
  prompt instead of appending (`replaceInstructions`).
- `--label <str>`: label for the summary/target entry (`label`).
- `--continue <prompt>`: after a successful (non-cancelled) navigation, send this
  as a normal user prompt to start a fresh turn on the new branch. Optional —
  omit it to rewind and go idle (the common case for non-self navigations).

`navOptions` passed to `ctx.navigateTree` is exactly
`{ summarize, customInstructions, replaceInstructions, label }`.

## Behavior contract

- The command is accepted immediately (it returns before navigating); the agent's
  `pictl prompt` call sees success as soon as the request is queued, not when
  navigation completes. Accepted practice: after issuing `/self-navigate`, do not
  emit further follow-up prompts expecting a particular ordering relative to the
  navigation — let the continuation drive the next turn.
- Navigation fires once the session is fully settled. Any follow-ups that were
  queued meanwhile run first (on the old branch) and are then rewound away — same
  as a human `/tree` superseding queued input.
- The continuation prompt (`--continue`) starts a fresh turn on the new branch,
  sent only if navigation was not cancelled. **Expansion caveat:** the desired
  behavior was "exactly like a regular prompt issued immediately after
  navigation" (i.e. with the slash/skill/template expansion a normal `pictl
  prompt` performs). `ctx.sendUserMessage` sends **verbatim** (it calls
  `prompt(..., { expandPromptTemplates: false })`), so it is *not* an exact
  regular prompt. Resolve during implementation — see open items.
- The detached task must never throw; errors are reported via the extension's
  error/notify channel.

## Recovery-packet / provenance discipline (agent-facing guidance)

`navigate-tree` rolls back only the *conversation* branch, not the filesystem,
git, processes, or external effects (see
`docs/thoughts/metacognition-with-pictl.md`). The continuation summary becomes the
agent's memory, so before a high-risk self-navigation the agent should record a
recovery packet (entry to return to, user intent/constraints, state planes
touched, claims-with-provenance, side effects, next prompt). This is **agent
workflow**, not extension logic — the extension just carries the `--summarize`
branch summary and the `--continue` prompt. Optionally, the extension can require
`--summarize` (or a `--note`) for self-navigation as a guardrail; decide during
implementation.

## pictl surface (optional, thin)

- The minimal version needs **no pictl change**: the agent calls
  `pictl prompt "/self-navigate …"` directly.
- Optional nicety: a `pictl self-navigate <targetId> [flags]` subcommand that just
  constructs and sends the `/self-navigate …` prompt (so the agent doesn't hand-
  build the slash string). If added, it lives alongside the other RPC commands in
  `src/core/rpc-commands.ts` and routes through the existing `prompt` command —
  it does **not** call `navigate_tree`.
- `PI_AGENT_ID` (set by `src/core/daemon.ts:101`) lets a self-navigation wrapper
  target the agent's own session by default. Not required for correctness.

## Where the extension lives / loading

It's a pi extension (`export default function (pi: ExtensionAPI) { pi.registerCommand("self-navigate", { … }) }`,
per pi's `examples/extensions/commands.ts`). Decide during implementation whether
to:
- ship it inside pictl and install it into the agent's `.pi/extensions/` at daemon
  setup, or
- keep it as a standalone extension users opt into.

The handler's `ctx` is the `ExtensionCommandContext`, which provides
`waitForSettled`, `navigateTree`, and `sendUserMessage`.

## Open items to resolve during implementation

- **`ctx` validity after the handler returns.** The detached task calls
  `ctx.navigateTree` / `ctx.sendUserMessage` after the command handler has
  returned. Verify pi's `assertActive()` (in `extensions/runner.ts`, wrapping
  context methods) does not reject calls made post-handler from a still-loaded
  extension. If it does, hold a reference to the underlying session control
  another way, or have the handler register an `agent_end`/settled-triggered
  action instead of a free-floating detached promise.
- **Continuation expansion semantics.** Decide whether the continuation must
  match a real `pictl prompt` (with slash/skill/template expansion) or send
  verbatim. `ctx.sendUserMessage` is verbatim. If exact-regular-prompt behavior is
  required, find/confirm a context method that runs the full `prompt()` path
  (expansion + default source), or expand the text in the extension before
  sending. Verbatim may actually be preferable for machine-authored continuations
  (a stray leading `/` won't be interpreted as a command) — confirm intent.
- **Arg parsing** for `--continue` values containing spaces/quotes — make sure the
  command arg string (everything after `/self-navigate `) is split so the
  continuation prompt survives intact. Prefer reading the continuation from a file
  flag (`--continue-file <path>`) if quoting proves fragile.
- **Guardrail policy**: whether to require `--summarize`/a note, and whether to
  announce the navigation as a visible event when a human is attached.
- **Fallback before `waitForSettled` exists**: if implemented ahead of the pi
  primitive, the detached task can temporarily use `ctx.waitForIdle`, accepting
  the retry/compaction race — but gate the real release on `waitForSettled`.

## Dependencies

- pi `ctx.waitForSettled` — `/home/anton/git/earendil-works/pi/docs/wait-for-settled.md`.
- pi extension command APIs already present: `registerCommand`, `navigateTree`,
  `sendUserMessage`, and (existing) inline execution of extension commands during
  streaming.
