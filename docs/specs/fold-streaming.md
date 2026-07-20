# Fold streaming: one shared event stream for output and conditions

# SPEC

## Problem

pictl's streaming engine (`streaming.ts`) is racy: the stop condition runs as
a separate listener (`startStopWatcher` → `applyUntilCondition`) issuing its
own `get_state` RPCs, racing the printer's event processing, with the two
sides coordinated by a hand-rolled scheduler (`wakeArrived`/`notifyWake`/
`stopRequested`). The condition can be observed met from a state snapshot
ahead of (or behind) what the printer has emitted; `entries` mode papers over
this with a post-stop drain. clauctl's port of this engine
(clauctl `docs/specs/wait-and-tail-until.md`) redesigned it as a fold — each
event updates state, emits output, and decides whether to stop, in one step —
and earmarked the design for hand-off back to pictl. This spec is that
hand-off, enabled by pi fork changes (see also
`docs/thoughts/passive-state-tracker.md`, whose "path to a complete fold"
the fork implemented):

- Bump `@geraschenko/pi-coding-agent` to **0.80.10-fork.0**:
  - `session_changed` now carries `state: RpcSessionState` (previously
    `{sessionId, sessionFile?}`) and is sent to each client right after
    `hello` — the seed is on the stream itself, atomically ordered before all
    subsequent events.
  - `nextSessionState(state, event)` is exported: the pure client-side fold,
    single-source-of-truth with the server's `buildRpcSessionState`. New
    broadcast events (`model_changed`, `steering_mode_changed`,
    `follow_up_mode_changed`, `auto_compaction_changed`) make every
    `RpcSessionState` field foldable except `messageCount` (several code
    paths mutate the message list eventlessly; consumers needing a fresh
    count must re-poll `get_state` — no pictl consumer does).
- Replace the dual-listener design with a single subscribed stream folded
  through `nextSessionState`, driving both output and condition checking.
- Eliminate **all** `get_state` polling from the TypeScript client
  (`until.ts` waiters, `inspect.ts` probe, `writeFinalCursor`); the
  `rpc get-state` CLI passthrough remains (it is a user-facing command, not
  polling).

Note the dep bump alone is a silent runtime break — `handleSessionEvent`
reads the old `event.sessionId` shape through a cast, so `entries`-mode
resync would die undetected — which is why bump and refactor land together.

## Conditions

Grammar: `turn-end|idle|no-activity:<secs>`; the streaming-only `killed`
extension is removed (see below). Semantics:

- `turn-end` — the next `agent_end` event with `willRetry !== true`
  (unchanged). Met at the seed only when `isIdle(seed)`: a pending queued
  message counts as a turn that must end, keeping sequential `prompt; wait`
  race-free.
- `idle` — `isIdle(state)` on the post-fold state. **Semantic change**: the
  fold clears `isStreaming` on `agent_settled` ("no automatic retry,
  compaction, or queued continuation will run"), not `agent_end`, so idle
  becomes event-driven at settlement instead of today's re-poll of
  `get_state` per `agent_end`. Stricter (waits out retries and in-run
  compaction) and race-free.
- `isIdle(state)` =
  `!isStreaming && !isCompacting && pendingMessageCount === 0` (named for
  the grammar word, not its negation).
  **Semantic change**: `isCompacting` is new — today's `waitIdle` ignores it,
  so a manual `/compact` on an idle agent counts as idle. Compacting is a
  kind of working (clauctl's stance on compaction results, applied to state).
- `no-activity:<secs>` — no socket event for N seconds, regardless of state
  (unchanged). Never met at the seed; the quiet timer arms once the seed is
  processed.
- `killed` is removed entirely: the grammar word, `StreamUntil`,
  `parseStreamUntil`, and `normalizeFollowUntil` all go — and so does
  `tail --follow`/`-f`, because following becomes tail's only mode. `tail`
  prints history (per `-n`/`--since`), then streams until `--until` is met
  or the socket closes (close throws "pi socket closed", today's `-f`
  behavior); plain `tail` no longer exits after history. In the stream
  options `until: undefined` means follow-until-close; there is no follow
  flag or field anywhere. `prompt` always stops at its condition (default
  `turn-end`) or detaches; prompt-then-follow is `prompt -d && tail`.

`--timeout <secs>`: unchanged surface (exit 3 via `UntilTimeoutError`).
Durations (both `--timeout` and `no-activity:`) go through a new
`secondsToTimerMs`: 0 is valid and fires immediately; non-finite values or
ms above Node's timer max (2**31−1, above which setTimeout fires
~immediately) are usage errors. Ported from clauctl's hardening round.

## Type design

Changed `src/core/pi-socket-client.ts` — **the client owns the fold** (v2
design; the first implementation buffered every post-hello record until
subscribe and replayed them, which grows without bound on long-lived
non-subscribers and can duplicate `tail` output against the history drain):

```ts
/** Maintains the folded RpcSessionState internally: seeds from the first
 *  session_changed after hello (never delivered as an event) and folds every
 *  subsequent broadcast through nextSessionState at dispatch. subscribe()
 *  resolves with the current folded state and delivers each later event
 *  together with the state after folding it — the (event, state) pair keeps
 *  a consumer's view aligned with the event it is processing even when it
 *  processes events asynchronously. Events before subscribe are not
 *  replayed: they are already reflected in the returned state, and nothing
 *  is buffered (a long-lived non-subscriber like the daemon costs O(1)
 *  memory). One subscriber per client (second call throws). */
class PiSocketClient {
  subscribe(
    onEvent: (event: RpcSocketBroadcastEvent, state: RpcSessionState) => void,
  ): Promise<RpcSessionState>;
  // request, waitClosed, isClosed, close unchanged.
}
```

`SocketEvent` (the "any JSON record" transport type) becomes private to
`pi-socket-client.ts`: dispatch casts each parsed non-response record to
pi's exported `RpcSocketBroadcastEvent` once, at the transport boundary —
safe because that union is what pi sends and `nextSessionState` returns
state unchanged for unknown types (forward compatibility with newer pi
events rests on that default). Everything downstream — subscribers, the
until checkers, `stream-types.ts` control records, the daemon's
`session_changed` narrowing — speaks pi's exported event type instead of a
pictl-local one.

Deleted from `pi-socket-client.ts`: `getState`, `waitIdle`,
`IdleTimeoutError`, `onEvent()`, the `onEvent` parameters of `connect` and
`connectWithRetry`, the exported `SocketEvent`.

### Shared engine (canonical here, synced to clauctl)

Two new files hold the repo-agnostic engine, written to be consumed verbatim
by clauctl's `scripts/sync-from-pictl.mjs` (whole-file copies into
`generated/` with import rewriting): no pi-specific imports — they may import
only each other and `./util.ts` (already in clauctl's sync set, for
`UsageError`). Type parameters `TEvent` and `TState` (descriptive generic
names everywhere, never bare `E`/`S`) instantiate to
`RpcSocketBroadcastEvent`/`RpcSessionState` here and
`SdkEvent`/`AgentState` in clauctl; the fold itself lives in each repo's
socket client (see above), which delivers post-fold state alongside each
event. Adding the files to
clauctl's sync set and rewriting its `until.ts`/`streaming.ts` onto them is
clauctl-side work (its own spec and commit); this spec only guarantees
sync-cleanliness.

New `src/core/until-engine.ts` — grammar plus generic checkers:

```ts
export class UntilTimeoutError extends Error {}      // moved from until.ts
export type UntilCondition = /* unchanged shape */;
export const UNTIL_USAGE, UNTIL_COMPLETIONS;         // "killed" nowhere
export function parseUntilCondition(value: string): UntilCondition;  // unchanged grammar
export function secondsToTimerMs(seconds: number): number;           // new, see Conditions

/** The two repo-specific judgments the checkers close over. "isIdle", not
 *  "isBusy": match the grammar's terminology instead of naming a negation. */
export interface UntilPredicates<TEvent, TState> {
  isIdle(state: TState): boolean;
  isTurnEnd(event: TEvent): boolean;
}

export function makeUntilCheckers<TEvent, TState>(
  predicates: UntilPredicates<TEvent, TState>,
): {
  /** Whether the condition already holds at the subscribe seed. */
  untilMetAtSeed(c: UntilCondition, seed: TState): boolean;
  /** Whether this event satisfies the condition; `state` is post-fold. */
  untilMetByEvent(c: UntilCondition, event: TEvent, state: TState): boolean;
  /** Quiet-timer duration the driver must enforce; undefined = event-driven. */
  untilQuietMs(c: UntilCondition): number | undefined;
};
```

New `src/core/stream-driver.ts` — the generic stream driver. It does not
fold: the client already delivers each event with its post-fold state, and
that pairing is load-bearing — with async handlers the client's live state
can run ahead of the event being processed, so handlers must judge each
event against the state snapshot taken when it was dispatched, not the
current one.

```ts
/** Narrow client slice so tests can drive runStream with a fake. */
export interface StreamClient<TEvent, TState> {
  subscribe(
    onEvent: (event: TEvent, state: TState) => void,
  ): Promise<TState>;
  waitClosed(): Promise<void>;
}

/** A stream consumer: each hook may emit output (possibly via RPCs — hence
 *  async) and returns whether to stop. Consumer state lives in the
 *  handler's closure. */
export interface StreamHandler<TEvent, TState> {
  onSeed(seed: TState): boolean | Promise<boolean>;
  onEvent(event: TEvent, state: TState): boolean | Promise<boolean>;
  quietMs?: number;
}

export interface StreamResult<TState> {
  /** "done" = handler or quiet-timer stop; "closed" = socket closed. */
  outcome: "done" | "closed";
  /** State delivered with the last processed event (the seed if none) —
   *  callers read stream-end facts like sessionId from here. */
  state: TState;
}

/**
 * Subscribe on `client` and drive `handler` over the pushed (event, state)
 * pairs. Contract (clauctl's runStream, plus async handlers):
 * - `onSeed` runs exactly once, before any `onEvent`; pairs dispatched
 *   before onSeed completes are queued and processed after it.
 * - Events are queued FIFO and processed strictly one handler call at a
 *   time (a second event must not start processing while one is in
 *   flight). A satisfying event is always emitted before the stream stops.
 * - First settlement wins; afterwards queued and later events are dropped
 *   and both timers are cleared on every path (a pending timer keeps the
 *   process alive).
 * - Both timers arm after `onSeed` resolves false — seed satisfaction takes
 *   precedence, and connect/subscribe latency never counts against the
 *   deadline. The quiet timer resets as each handler call completes.
 *   Deadline expiry rejects with UntilTimeoutError, winning ties against
 *   the quiet timer.
 * - Handler exceptions reject the returned promise; they must not escape
 *   into the socket's data listener.
 * - Socket close settles "closed" once the in-flight handler call (if any)
 *   completes; callers needing an error map it themselves.
 */
export function runStream<TEvent, TState>(
  client: StreamClient<TEvent, TState>,
  handler: StreamHandler<TEvent, TState>,
  timeoutMs: number | undefined,
): Promise<StreamResult<TState>>;
```

### Repo-specific layers

Changed `src/core/until.ts` — thin instantiation of the engine:

```ts
export function isIdle(state: RpcSessionState): boolean;  // see Conditions

export const { untilMetAtSeed, untilMetByEvent, untilQuietMs } =
  makeUntilCheckers<RpcSocketBroadcastEvent, RpcSessionState>({
    isIdle,
    isTurnEnd: (e) => e.type === "agent_end" && e.willRetry !== true,
  });
// Grammar consumers re-import from until-engine.ts directly.
```

No fold adapter: the fold lives inside `PiSocketClient`, and the checkers
speak pi's `RpcSocketBroadcastEvent` directly.

Deleted from `until.ts`: `applyUntilCondition`, `waitTurnEnd`,
`waitNoActivity`, `withDeadline` (the driver owns all timers),
`UntilTimeoutError` (moved to the engine).

Changed `src/core/streaming.ts` — deletes `StreamState`, `newStreamState`,
`handleSessionEvent`, `nextWake`, `startStopWatcher`, `waitForUntil`,
`createGate`, `StreamUntil`, `parseStreamUntil`, `normalizeFollowUntil`,
`STREAM_UNTIL_USAGE`, `STREAMING_NOISE_EVENTS`, and the wake loops. `StreamOptions` carries `until: UntilCondition | undefined`
(undefined = follow until close); `PromptStreamOptions.until` is a required
`UntilCondition` (the command defaults it to turn-end). The three mode
handlers become closures over a `RecordWriter` (seam unchanged) driven by
`runStream(client, handler, timeoutMs)`:

- **messages**: `onEvent` writes `messageRecordFromEvent` records; the
  `session_changed` control record now carries `{state}` (output shape
  change, no back-compat).
- **entries**: incremental `since`-bounded drains via `drainEntries` —
  cheap because `get_entries since=<cursor>` is incremental server-side.
  After each entry-producing event the handler drains past its cursor and
  emits the new entries as the stream progresses; `ENTRY_DELTA_EVENTS`
  (`message_update`/`tool_execution_update`) skip the drain as RPC economy
  (one drain per token otherwise), while still feeding the checkers and
  quiet timer. The starting cursor is the cursor the history drain ended
  on (tail) or the pre-prompt leaf (prompt — so the drains emit exactly
  the prompt's entries). Entry cursors are session-scoped: a mid-stream
  session replacement resets the cursor, resyncing from the new session's
  start.
- **raw**: `onEvent` writes the event verbatim.

Each mode composes with the until checkers: `onSeed` returns
`untilMetAtSeed`, `onEvent` returns `untilMetByEvent`, `quietMs` is
`untilQuietMs`. Without `--until` both hooks return false and the caller
maps "closed" to the thrown "pi socket closed" (current `-f` behavior);
with `--until`, "closed" before the condition is met is likewise an error.

`streamPrompt` — the gate is deleted, not reshaped: connect, start
`runStream` (it subscribes synchronously inside the call), then await the
prompt RPC while the stream is already listening — a fast turn's events
cannot be missed, with no buffering. The prompt handlers skip the seed
check (`onSeed` → false): the seed predates the prompt, and an idle
pre-prompt seed must not satisfy `turn-end`/`idle` (the reason the gate
existed). Timers arm at the seed — marginally before prompt acceptance, but
connect latency is still excluded and the prompt round-trip on a local
socket is negligible against any real `--timeout`. On an already-busy
agent, `turn-end` means the first non-retry `agent_end` after the seed —
possibly an earlier queued turn's (same as today; waiting out the queue is
`idle`).

`writeFinalCursor` takes the settling `state.sessionId` from `runStream`'s
result (it still makes one `get_entries` call at stream end for `leafId`;
adding `leafId` to `RpcSessionState` in the pi fork would eliminate that
last full fetch and the prompt-entries start-point fetch — noted as a
follow-up, not this spec).

Changed `src/core/wait.ts`: `applyUntilCondition` call becomes `subscribe` +
`runStream` with a no-output handler (the until checkers directly);
`"closed"` → throw. Dormant/archived fast path unchanged. `--timeout` and
`no-activity` durations go through `secondsToTimerMs`.

Changed `src/core/lifecycle.ts` `stopRunningAgent`: `waitIdle` becomes
`runStream` with an idle handler; the three `IdleTimeoutError` catch sites
match `UntilTimeoutError` instead; messages and exit codes unchanged.

Changed `src/core/inspect.ts` `probeAgent`: reads the seed
(`subscribe` with a no-op listener) instead of `get_state`. Equivalent
freshness: the seeding `session_changed` is built by `buildRpcSessionState`
at send time, and the probe is connect-read-close. `messageCount` in `--json`
output stays accurate for the same reason.

Changed `src/core/daemon/daemon.ts` (a break site the original Problem
section missed — its session-history tracking read the old
`session_changed` `{sessionId, sessionFile}` shape through connect's
deleted `onEvent` parameter): it subscribes, records the subscribe seed as
the initial session announcement, and records later sessions from the
`state` of `session_changed` events. It narrows events from pi's exported
`RpcSocketBroadcastEvent` union — no pictl-local redeclaration of a shape
pi already exports.

Changed `src/core/index.ts` (+ `docs/pictl.api.md`): `getState` export
removed; export the until checkers/`runStream` as needed by existing
consumers only — no speculative surface.

## Edge cases

- Condition met at seed: `wait` returns without processing events; `tail
  --until` emits historical output only. `prompt --until` never meets at
  seed (see gate deletion).
- Events racing `subscribe`: not replayed — they are already reflected in
  the folded state subscribe returns. `prompt` cannot miss its turn because
  it subscribes before sending; `tail` history-window events are covered by
  the history fetch itself (replaying them would duplicate output, a bug in
  the buffering design).
- A second `session_changed` mid-stream: the client's fold reseeds
  wholesale; the entries cursor resets, resyncing from the new session's
  start.
- `no-activity` quiet timer counts every socket event (including
  `message_update`/`tool_execution_update` noise events) — unchanged; the
  old `STREAMING_NOISE_EVENTS` wake filter was scheduler machinery, not
  condition semantics, and dies with the scheduler.
- Timers cleared on every settlement path; deadline beats quiet timer on
  ties (registered first; Node fires equal-delay timers in registration
  order).
- Async handler in flight when a satisfying event is queued behind it: the
  queued event is still processed (emitted, stop honored, judged against
  its own state snapshot) before any later event; settlement drops only
  events after the stop decision.
- Socket close with a non-empty queue: drain nothing further; settle
  "closed" after the in-flight call completes.
- `--timeout 0`: exit 0 if met at seed, else exit 3 immediately.
  `no-activity:0` met at the first quiet check after the seed. Oversized /
  non-finite durations: usage error (exit 2).

## Data flow / cost

Per-command cost budget (the lens the first implementation lacked; v2 is
designed against it):

- **Client**: O(1) memory regardless of subscribe timing or lifetime — the
  fold replaces buffering; no event is ever stored.
- **During any stream**: zero RPCs issued per event, except entries mode —
  its incremental drain (one `since`-bounded `get_entries` per
  entry-producing event, delta events skipped) is the price of emitting
  entries as they appear. Everywhere else events flow one way (pi →
  client fold → driver queue → handler); the only per-event work is the
  fold and the handler's write.
- **RPC totals**: `wait`/`suspend`/`purge`/`archive` idle-waits and the
  `status` probe: 0 RPCs (seed only). `tail` messages: 1 history fetch +
  1 end `get_entries` (cursor). `tail` entries: 1 history fetch + the
  incremental drains. `prompt` messages/raw: 1 prompt + 1 end
  `get_entries` (cursor). `prompt` entries: 1 pre-prompt fetch (start
  point) + 1 prompt + the incremental drains. The cursor/start-point
  `get_entries` calls are the known remaining fat, removable once the
  fork exposes `leafId` in `RpcSessionState`.
- **Wire note**: `get_entries since=<id>` is incremental server-side (pi
  slices at the cursor), so the end drain sends only the stream's entries.

## Success criteria

1. `pictl prompt --until turn-end` on an idle agent returns after that
   turn's non-retry `agent_end`, never before, and never hangs when the turn
   finishes faster than the CLI subscribes.
2. `pictl wait --until idle` exits 0 immediately on an idle agent; on a busy
   agent, only at `agent_settled` with an empty queue; on a compacting
   agent, not before `compaction_end`.
3. `pictl wait --until no-activity:1 --timeout 5` exits 0 after the first 1s
   gap, or 3 after 5s of activity. Dormant agents still meet any condition
   immediately without revival.
4. `pictl tail`/`prompt` output is record-identical to today for messages,
   entries, and raw modes — except `session_changed` records, which now
   carry `{state}`, and plain `tail` (no `--until`), which now follows
   instead of exiting after history, so it emits no final cursor record
   (cursors are written only when `--until` settles the stream).
5. `purge`/`suspend` still wait politely and report "still busy" on timeout
   with unchanged messages and exit codes.
6. `pictl list`/`status` issue no `get_state` RPC; `grep -rn "get_state"
   src/` hits only the `rpc get-state` passthrough table and its docs.
7. `--until killed` and `tail --follow`/`-f` are usage errors; `tail`
   without `--until` prints history then follows until socket close,
   exiting 1 when pi dies; `prompt` without `--until`/`-d` stops at
   turn-end.
8. `until-engine.ts` and `stream-driver.ts` import nothing outside
   themselves and `util.ts` (sync-clean for clauctl).
9. Unit tests cover: the until checkers (met-at-seed/by-event per
   condition), `secondsToTimerMs` (zero, huge, non-finite), the client's
   fold ownership (seed from `session_changed`, state advanced by events,
   subscribe returns current state, no replay of pre-subscribe events, one
   subscriber), and `runStream` against a fake `StreamClient` (seed
   satisfaction, (event, state) pairing preserved under async handlers,
   FIFO serialization, emit-before-stop order, post-settlement
   suppression, quiet timer + reset, deadline + tie precedence, closed
   socket mid-queue, handler exceptions, final state in the result).
   Existing streaming tests updated: the fake pi server sends the
   new-shape `session_changed` seed after `hello`.
10. `npm run presubmit` passes.

## Non-goals (deferred)

- **Rust port** (`rust/pictl-rs` `ActivityWatcher` → owned folded state,
  per `docs/thoughts/passive-state-tracker.md`): blocked upstream of pictl.
  pi-rpc-rs tracks upstream pi (currently 0.80.6), and the inputs the fold
  needs — the `session_changed { state }` shape and the new broadcast
  events (`model_changed`, `steering_mode_changed`, `follow_up_mode_changed`,
  `auto_compaction_changed`) — exist only in the pi fork, so a typed Rust
  fold has nothing to deserialize. Moreover the fold function itself is
  pi-rpc-rs's job, not pictl's: it mirrors pi's `rpc-state-fold.ts` and
  belongs next to the crate's protocol types (as `next_session_state`),
  exactly as pi co-locates `nextSessionState` with its RPC types. Once
  pi-rpc-rs gains the message types and the fold, the pictl-rs side is a
  small follow-up spec: seed `ActivityWatcher` from the connect-time
  `session_changed`, fold locally, delete the per-boundary `get_state`
  round-trips.
- **Debug-mode fold-vs-`get_state` assertion** (passive-state-tracker's
  drift safeguard): pi-side fold and server state now share
  `buildRpcSessionState`, shrinking the drift risk this guarded against;
  revisit if a drift bug appears.
- **clauctl adoption of the shared engine** — adding `until-engine.ts` and
  `stream-driver.ts` to clauctl's sync set and rewriting its
  `until.ts`/`streaming.ts` onto them (its sync handlers work unchanged
  under the async driver): a clauctl spec/commit, coordinated after phase 1
  lands. This spec guarantees only that the files are sync-clean.

# IMPLEMENTATION IDEAS

- Driver skeleton: port clauctl `src/core/streaming.ts` `runStream`
  (settled-guard, settle/settleWithError, resetQuietTimer with reentrancy
  guard, deadline-before-quiet registration), with the sync `processEvent`
  replaced by an async FIFO pump over (event, state) pairs (chain
  `processing = processing.then(...)`). The driver keeps a small
  pre-onSeed queue for pairs dispatched during the subscribe microtask
  window; it holds at most that window's events, not history.
- Client fold: `dispatchLine` casts each non-response record to
  `RpcSocketBroadcastEvent`; the first `session_changed` sets the state
  (never dispatched), every later record folds through `nextSessionState`
  before being handed (with the new state) to the subscriber, if any.
- Handler stop-composition: mode handlers wrap the until checkers rather
  than the driver knowing about conditions — follow mode is just a handler
  that never stops.
- The `messages`-mode `AgentMessage` cast and `messageRecordFromEvent`
  stay as-is; only the session_changed record's payload shape changes.
- Fake `StreamClient` tests mirror clauctl's `streaming.test.ts` cases, plus
  the async-handler serialization cases clauctl doesn't need.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-20: Spec written. Inputs: clauctl `wait-and-tail-until.md` (fold
  design + post-implementation review findings), pi 0.80.10-fork.0 API
  inspection, `passive-state-tracker.md` derisking. Decisions (Anton): bump
  and refactor land as one commit; all TS `get_state` polling goes (inspect
  probe reads the seed); Rust port deferred to a follow-up spec. Decisions
  (proposed in spec, pending review): `isBusy` includes `isCompacting`;
  `idle` moves to `agent_settled`; prompt gate deleted outright (buffering
  makes it unnecessary, seed check skipped instead); noise-event wake filter
  dies with the scheduler (`no-activity` already counted every event);
  `secondsToTimerMs` hardening ported from clauctl.
- 2026-07-20: TDC review round resolved. (1) `killed` removed entirely —
  grammar word, `StreamUntil`, `parseStreamUntil`, `normalizeFollowUntil`;
  follow-until-close becomes a `follow: boolean` in the stream options;
  `prompt` gains `--follow`/`-f` to preserve the `prompt --until killed`
  capability (flagged for review — drop it if `prompt -d && tail -f` is
  preferred). (2) Rust port briefly promoted to phases 2–3, then reverted
  to a non-goal (Anton): pi-rpc-rs tracks _upstream_ pi, and the fold's
  inputs (`session_changed { state }` shape, new broadcast events) are
  fork-only — nothing for a typed Rust fold to deserialize; also the fold
  function belongs in pi-rpc-rs next to its protocol types, not in pictl.
  Deferred until pi-rpc-rs adds the message types and `next_session_state`.
  (3) Engine shared with clauctl via type parameters: new sync-clean
  `until-engine.ts` (grammar + `makeUntilCheckers` over `isBusy`/`isTurnEnd`
  predicates) and `stream-driver.ts` (`runStream<E, S>` with the fold as a
  value parameter); clauctl-side adoption stays a clauctl commit.
- 2026-07-20: Spec approved by Anton with one amendment (supersedes the
  `--follow` part of the previous entry): no `--follow`/`-f` anywhere —
  `prompt -f` dropped, and tail's existing `-f` deleted too, since
  following becomes tail's only mode (`until: undefined` =
  follow-until-close; prompt-then-follow is `prompt -d && tail`). Plain
  `tail` therefore no longer exits after history and emits no final cursor.
  Implementation not yet started. The working tree already carries the dep
  bump to 0.80.10-fork.0 (`npm install` done, `npm run check` passes) and
  this spec; everything lands in the single review commit.
- 2026-07-20: Phase 1 implemented; `npm run presubmit` green (115 tests, 18
  new across `until-engine.test.ts`/`stream-driver.test.ts`);
  `docs/pictl.api.md` regenerated. Two findings beyond the spec letter,
  flagged for review:
  1. **daemon.ts was a fourth silent-break site** the Problem section
     missed: the daemon's session-history tracking read the old
     `session_changed` `{sessionId, sessionFile}` shape through connect's
     deleted `onEvent` parameter. Adapted: it now connects, subscribes, and
     records the subscribe seed as the initial session announcement
     (`recordSession(await piClient.subscribe(handleEvent))`), with later
     `session_changed` events handled through the subscription.
  2. **Entries mode keeps a drain skip for per-delta events**
     (`message_update`/`tool_execution_update`, local `ENTRY_DELTA_EVENTS`
     in streaming.ts): the spec deletes `STREAMING_NOISE_EVENTS` as
     scheduler machinery, but for entries mode the filter was also RPC
     economy — draining `get_entries` on every token delta would issue one
     RPC per token. Condition checks and the quiet timer still see every
     event (per spec); only the drain is skipped, matching old behavior.
     Minor surface note: the socket-closed-while-waiting error is now the
     driver-uniform "pi socket closed before condition met" (`wait`) / "pi
     socket closed" (streams) instead of the three per-waiter phrasings.
- 2026-07-21: Review round (Anton, commit 1557918 + discussion) — **v2
  redesign, spec updated above, code not yet reworked**. Decisions:
  1. No connect→subscribe buffering: `PiSocketClient` owns the fold and
     `subscribe()` returns current state; dispatch delivers (event,
     post-fold state) pairs so async consumers judge each event against
     its own snapshot; `runStream` loses its fold parameter and resolves
     `{ outcome, state }` (replaces the myopic sessionId threading).
     `streamPrompt` closes the fast-turn window by ordering (subscribe
     before the prompt RPC), not buffering — the buffering design also
     had a `tail` duplication bug (history fetch + replay of the same
     event).
  2. Entries mode: no incremental draining, no `drainEntries`, no
     `ENTRY_DELTA_EVENTS` — one `get_entries since=<start>` when the
     condition settles; `tail --type entries` without `--until` becomes a
     usage error (no settling drain point). Verified `get_entries since`
     is incremental server-side; the remaining full fetches (final cursor
     `leafId`, prompt-entries start point) wait on a fork change adding
     `leafId` to `RpcSessionState` (TODO in streaming.ts, separate spec).
  3. `SocketEvent` goes private to the transport; everything downstream
     uses pi's exported `RpcSocketBroadcastEvent` (cast once at dispatch),
     killing the `foldSessionState` adapter; the daemon narrows from the
     pi union instead of redeclaring `SessionChangedEvent`.
  4. Renames: `isBusy` → `isIdle` (match grammar terminology, don't name a
     negation); descriptive generic parameters everywhere (`TEvent`,
     `TState`, `TPayload` — Anton renamed several by IDE; audit remaining
     generics and their comments, e.g. stream-driver's header still says
     `E`/`S`). Remove each inline `TDC:` comment as it is resolved.
  5. Retrospective: adopted a "data flow / cost" spec lens (section
     above); the buffering and drain-per-event mistakes were spec-level
     costs never surfaced as decisions.
- 2026-07-21: v2 implemented, with one amendment to the entry above
  (Anton, commit 0a09dfa): `drainEntries` is kept, used **only** by
  `tail --type entries` — the one mode with no settlement point — so tail
  entries keeps following via incremental `since`-bounded drains
  (`ENTRY_DELTA_EVENTS` survives as its RPC-economy skip) and the
  planned "entries requires `--until`" usage error is dropped. `prompt`
  entries drains once at settlement as decided. Everything else landed as
  specced: client-owned fold with (event, post-fold state) dispatch and
  the `RpcSocketBroadcastEvent` cast at the transport boundary
  (`SocketEvent` unexported, `foldSessionState` deleted); `runStream`
  without a fold parameter returning `StreamResult` (close before the
  seed now rejects — there is no state to resolve with);
  subscribe-before-prompt ordering in `streamPrompt` (with an explicit
  close-and-rethrow path when the prompt RPC fails); `isIdle` rename;
  daemon narrowing from pi's union; generics audit (`TFlag`/`TFlags` in
  cli.ts, `TPayload` in flat-tree.ts, driver header comment); all inline
  TDCs resolved and removed. New `pi-socket-client.test.ts` covers the
  fold ownership criteria using barrier requests (no sleeps); driver
  tests reworked for pairs and `StreamResult`.
- 2026-07-21: Review round (Anton, commit 3b2536c), two corrections to the
  entry above. (1) `prompt --type entries` must emit entries as the turn
  progresses, so the at-end drain was a mistake: entries mode always
  drains incrementally now (`EntriesDrain` deleted; `runModeStream` takes
  `entriesSince` — the pre-prompt leaf for prompt, the history-drain
  cursor for tail). Settlement still emits everything: the satisfying
  event's own drain runs before its stop decision, and any entry is
  eventually followed by an entry-producing broadcast. (2) Driver
  bookkeeping: the separate `seedProcessed` flag was a second source of
  truth for `lastState !== undefined`; folded together by assigning
  `lastState` only after `onSeed` resolves false (undefined now doubles
  as "still pre-seed"). Consequence: close during an in-flight async
  `onSeed` now rejects like close-before-seed instead of resolving
  closed-with-seed — all real onSeed hooks are synchronous checks, so no
  caller can see the difference.
