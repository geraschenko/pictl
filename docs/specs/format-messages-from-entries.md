# SPEC

## Problem

`pictl format messages` accepts message-stream JSONL and the `{ messages }` object returned by `pictl get-messages`, but it does not accept the `{ entries, leafId }` object returned by `pictl get-entries`.

A get-entries snapshot is an append-ordered history, not merely the active LLM context. Formatting it as messages must therefore project each entry independently and preserve messages appended on inactive branches. It must not use `buildSessionContext`, follow `leafId`, or apply compaction-aware context selection.

The code that defines and produces message stream records is also split between `streaming.ts` and `stream-types.ts`. Its singular event adapter cannot retain state or flush buffered output, so it would force another interface change when message coalescing is added. This change consolidates the streaming machinery under `src/core/streaming/`, changes socket-to-driver delivery to async iteration, and gives event streams and entry streams explicit stateful adapters into the common `MessageStreamRecord` representation. The handler remains push-shaped: the driver is the sole async-iterator consumer and serially invokes `onEvent`.

The two adapters should produce the same user-visible records where their inputs contain equivalent information. Exact equivalence is impossible where the RPC event protocol and persisted entries expose different facts; those limitations are explicit below.

## Success criteria

- `pictl get-entries --target <agent> | pictl format messages` renders the append-ordered session history.
- Messages appended on inactive branches are included; `leafId` does not select or filter entries.
- `message`, `custom_message`, `compaction`, and `branch_summary` entries use Pi's canonical `sessionEntryToContextMessages` conversion.
- Entry types that do not project to messages are omitted from message output, except:
  - `model_change` entries after the first input entry emit a model-change control immediately;
  - a parent discontinuity after the first input entry emits an inferred tree-navigation control immediately.
- The first input entry never emits inferred navigation. If it is a `model_change`, it does not emit a model control.
- Every entry, including omitted bookkeeping entries, advances the previous-entry ID used to detect parent discontinuities.
- Directly observed RPC `model_changed`, `tree_navigated`, and `session_changed` events are faithfully converted to controls.
- A directly observed tree navigation with no known old leaf is formatted using only the new leaf.
- Existing get-messages JSON, message-stream JSONL, formatting flags, and cursor behavior remain unchanged.
- Streaming implementation and types live under `src/core/streaming/`; command and formatting callers remain outside that directory.
- Live socket delivery is an `AsyncIterable` of RPC events paired with their post-fold state snapshots. Event-to-message conversion retains state and emits zero or more records per pushed event, then flushes at stream end.
- Existing stream ordering and condition semantics remain intact, with deliberate settlement changes: source cutoffs stop accepting new events and drain records accepted before the cutoff; quiet timing follows source pushes rather than handler throughput; and timeout is a distinct successful driver outcome interpreted by each caller.
- Seed satisfaction and handler satisfaction cancel queued events. Quiet completion, transport close, and timeout establish source cutoffs and drain queued events; a draining `onEvent` may still satisfy the condition and produce `done`. Every successful outcome invokes `onEnd`; hook/projector failures cancel without flushing.
- If transport closure prevents prompt or tail from fetching its required final cursor, the command fails rather than succeeding with incomplete finite output.
- No complete Pi `Model` is fabricated from a `model_change` entry, and no unsafe cast is introduced to do so.
- Driver tests cover atomic seed ordering, FIFO consumption, per-event folded state, satisfying-event delivery, projector flush ordering, source-cutoff draining, consumer cancellation, source-timed quiet activity, timer precedence, exceptions, and close-before-seed.
- The project builds with stubs before behavior is implemented, then passes presubmit after implementation.

## Behavior

### Append-order projection

Given these entries in input order:

```text
A message(parentId=null)
B message(parentId=A)
C message(parentId=A)
D model_change(parentId=C, provider=anthropic, modelId=claude-sonnet)
E message(parentId=D)
```

`C.parentId !== B.id`, so the output is shaped as:

```text
<message A>
<message B>
[control: tree navigated B -> A]
<message C>
[model: anthropic/claude-sonnet]
<message E>
```

`C` is retained even if it is not on the branch selected by the snapshot's `leafId`.

### First-entry behavior

The first entry seeds the previous-entry ID. Its projected messages are emitted normally, but no navigation is inferred from its `parentId`. A first entry of type `model_change` is silent because the preceding history is unavailable.

This also applies to partial `get-entries --since <entry-id>` output: the formatter does not need the omitted cursor and intentionally does not diagnose a discontinuity at the first returned entry.

### Navigation controls

For entries, if the previous input entry has ID `old` and the current entry has `parentId: new`, where `new !== old`, conversion emits a synthetic `tree_navigated` control `old -> new` before projecting the current entry.

For directly observed RPC events:

- known old and new leaves render as `[control: tree navigated old -> new]`;
- an unknown old leaf renders as `[control: tree navigated to new]`;
- null new leaves render as `null`.

A session replacement is only observable in the event stream because session entries do not contain a session ID. Direct `session_changed` events continue to emit session-change controls. In entry conversion, the first appended entry from a replacement session can only appear as a parent discontinuity and is treated as inferred tree navigation; if it is the first input entry, no change is reported. The inferred control does not speculate that the session may have changed: session replacement is rare and adding that caveat to every ordinary navigation would create misleading noise.

### Model controls

A directly observed RPC `model_changed` event always emits a model-change control.

A `model_change` entry emits a model-change control unless it is the first input entry. The control reports only the selected model:

```text
[model: <provider>/<model-id>]
```

There is no previous-model field and no coalescing in this change. Repeated model entries are faithfully emitted. Later formatter-level coalescing is a separate concern.

### Compaction and branch summaries

A persisted `compaction` entry projects through `sessionEntryToContextMessages` to the existing `compactionSummary` message rendering. A persisted `branch_summary` entry similarly projects to the existing `branchSummary` rendering.

Live compaction events retain the existing lifecycle controls (`compaction started` and `compaction finished`). Persisted summaries and live lifecycle controls represent different facts and are intentionally not made identical.

## Type design

### Streaming directory layout

```text
src/core/streaming/
  async-queue.ts
  async-queue.test.ts
  driver.ts
  driver.test.ts
  message-records.ts
  stream.ts
  stream.test.ts
  types.ts
```

Existing files move as follows:

```text
src/core/stream-driver.ts      -> src/core/streaming/driver.ts
src/core/stream-driver.test.ts -> src/core/streaming/driver.test.ts
src/core/streaming.ts          -> src/core/streaming/stream.ts
src/core/streaming.test.ts     -> src/core/streaming/stream.test.ts
src/core/stream-types.ts       -> src/core/streaming/types.ts
```

`src/core/tail.ts`, `src/core/rpc-commands.ts`, `src/core/until.ts`, `src/core/until-engine.ts`, and formatting modules remain in place as callers or separate domains. Imports are updated to the new direct module paths; no barrel module is added.

`async-queue.ts`, `driver.ts`, and their tests remain generic and syncable to clauctl. `driver.ts` imports the sibling `AsyncQueue` type from `./async-queue.ts`; the downstream sync set and import rewriter must preserve that sibling layout as documented in the clauctl handoff.

The command-facing exports `RecordWriter`, `StreamOutputType`, `PromptStreamOptions`, `parseStreamOutputType`, `promptDetached`, `streamPrompt`, and `streamTail` move with `stream.ts` without signature changes. The stream-driver interface changes as specified below. The package-level exports in `src/core/index.ts` continue to expose the driver symbols from their new path, so this is an intentional public package interface change for `StreamClient`, `StreamHandler`, and `runStream`.

### `src/core/streaming/types.ts`

```ts
import type { RpcSocketBroadcastEvent } from "@geraschenko/pi-coding-agent";

type RpcEventOf<
  T extends RpcSocketBroadcastEvent["type"],
> = Extract<RpcSocketBroadcastEvent, { type: T }>;

export interface StreamModelReference {
  readonly provider: string;
  readonly id: string;
}

export type StreamControl =
  | {
      readonly kind: "compaction";
      readonly event: RpcEventOf<"compaction_start" | "compaction_end">;
    }
  | {
      readonly kind: "tree_navigated";
      readonly event: RpcEventOf<"tree_navigated">;
    }
  | {
      readonly kind: "session_changed";
      readonly event: RpcEventOf<"session_changed">;
    }
  | {
      readonly kind: "queue_update";
      readonly event: RpcEventOf<"queue_update">;
    }
  | {
      readonly kind: "model_changed";
      readonly event: {
        readonly type: "model_changed";
        readonly model: StreamModelReference;
      };
    };

export type StreamControlKind = StreamControl["kind"];

export interface StreamControlRecord {
  readonly type: "control";
  readonly control: StreamControl;
}
```

The existing `GetMessagesData`, `AgentMessage`, `StreamCursorRecord`, and `StreamMessageRecord` definitions move unchanged. `MessageStreamRecord` remains:

```ts
export type MessageStreamRecord =
  | StreamMessageRecord
  | StreamControlRecord
  | StreamCursorRecord;
```

A complete model carried by a real `model_changed` RPC event structurally satisfies `StreamModelReference`. An entry-derived control creates only the honest `{ provider, id }` projection.

### `src/core/streaming/async-queue.ts`

`AsyncQueue<T>` is the one-producer/one-consumer pushed-to-async-iteration bridge. Its small interface makes source and consumer endings distinct:

```ts
export class AsyncQueue<T> implements AsyncIterable<T> {
  push(value: T): void;
  onPush(handler: () => void): () => void;
  close(): boolean;
  cancel(): void;
}
```

`push` synchronously notifies registered handlers only when the value is accepted. `close` is a source cutoff: the first call returns true, later calls return false, new pushes are rejected, and accepted values drain FIFO. `cancel` is consumer settlement: it drops queued values and ends immediately. Returning the async iterator delegates to `cancel`.

The first successful `close` determines which source cutoff won without depending on consumer throughput. The driver uses `onPush` to reset quiet timing at enqueue time and unregisters its handler when the stream settles.

### `src/core/pi-socket-client.ts`

```ts
import type {
  RpcSessionState,
  RpcSocketBroadcastEvent,
} from "@geraschenko/pi-coding-agent";
import type { StreamSubscription } from "./streaming/driver.ts";

export type RpcEventSubscription = StreamSubscription<
  RpcSocketBroadcastEvent,
  RpcSessionState
>;

export class PiSocketClient {
  subscribe(): Promise<RpcEventSubscription>;
  waitClosed(): Promise<void>;
  close(): void;
}
```

`subscribe` atomically installs an event queue before waiting for the initial `session_changed` seed. The first `session_changed` establishes the seed and is not yielded; subsequent events are folded synchronously by `PiSocketClient` and queued as `StreamEvent` values carrying the post-fold state snapshot. Events arriving after the seed is observed but before the subscribe promise continuation runs remain queued in wire order.

On socket close after seeding, the client closes the queue: new events are rejected, already accepted events drain FIFO, then iteration ends. A queued event may satisfy the stream condition before the driver observes exhaustion. Consumer cancellation drops the remaining queue without closing the socket. Only one subscription is allowed per client.

Close before the seed makes `subscribe` reject with `Error("pi socket closed before the subscribe seed")`; the driver propagates that client-owned error. If the seed was established before close, subscription succeeds with a closed queue that drains any accepted values and then ends.

`waitClosed` remains on the concrete client because lifecycle shutdown uses it, but it is not part of the generic `StreamClient` interface. The event iterable's normal completion is the driver's transport-close signal.

### `src/core/streaming/driver.ts`

```ts
import type { AsyncQueue } from "./async-queue.ts";

export interface StreamEvent<TEvent, TState> {
  readonly event: TEvent;
  readonly state: TState;
}

export interface StreamSubscription<TEvent, TState> {
  readonly seed: TState;
  readonly events: AsyncQueue<StreamEvent<TEvent, TState>>;
}

export interface StreamClient<TEvent, TState> {
  subscribe(): Promise<StreamSubscription<TEvent, TState>>;
}

export interface StreamHandler<TEvent, TState> {
  readonly onSeed: (seed: TState) => boolean | Promise<boolean>;
  readonly onEvent: (
    event: TEvent,
    state: TState,
  ) => boolean | Promise<boolean>;
  readonly onStop?: () => void | Promise<void>;
  readonly onEnd?: () => void | Promise<void>;
  readonly quietMs?: number;
}

export interface StreamResult<TState> {
  readonly outcome: "done" | "closed" | "timeout";
  readonly state: TState;
}

export function runStream<TEvent, TState>(
  client: StreamClient<TEvent, TState>,
  handler: StreamHandler<TEvent, TState>,
  timeoutMs: number | undefined,
): Promise<StreamResult<TState>>;
```

`runStream` is the sole consumer of the subscription iterable. It calls `onSeed` once, then invokes `onEvent` serially for each already-paired event/state value. There is one event queue, owned by the client; the driver does not refold events or build a second queue.

Settlement rules:

- `Settlement` is exactly `StreamResult<TState>["outcome"]`: `done`, `closed`, or `timeout`.
- Subscription latency does not count toward either timer. The driver registers its queue-push observer before `onSeed`, then arms timers only after `onSeed` resolves false.
- Seed satisfaction cancels the queue, awaits `onEnd`, then resolves `done` with the seed.
- Timeout registration precedes quiet-timer registration, so timeout wins equal-delay ties.
- Every accepted source push resets the quiet timer synchronously, including pushes while `onEvent` is in flight. Quiet completion therefore depends on source-event silence, not handler throughput.
- Quiet and timeout callbacks attempt `events.close()`. The first successful close establishes the source cutoff (`done` for quiet, `timeout` for timeout), rejects later pushes, and drains all values accepted before that cutoff. A transport close that wins first similarly drains and eventually produces `closed`.
- If transport close, quiet, and timeout race, the first source cutoff wins even when draining runs past a later timer. Consumer speed cannot change the eventual cutoff outcome.
- When seed satisfaction, handler satisfaction, quiet, or timeout first stops event acceptance, the driver invokes optional `onStop` immediately and at most once. Cursor-producing handlers start their final `get_entries` snapshot there; draining continues concurrently, then settlement awaits `onStop` before `onEnd`.
- If `onEvent` returns true while any source cutoff is draining, condition satisfaction overrides the pending cutoff: the driver cancels the remaining queue, awaits the already-started `onStop`, awaits `onEnd`, and resolves `done` with the satisfying event's state.
- If no event satisfies while draining, iterable exhaustion awaits `onEnd` and resolves the pending quiet/timeout outcome, or `closed` when transport close established the cutoff.
- `onSeed`, `onEvent`, `onStop`, or projector failure cancels and rejects without calling `onEnd`, because buffered state is not trustworthy. `onEnd` failure rejects any logically successful outcome.
- Source cutoff is distinct from settlement. Settlement and cancellation still obey first-settlement-wins, and `onEnd` runs at most once after the queue is cancelled or exhausted.
- Result state is the state paired with the last processed event, or the seed if none was processed.

The generic driver never converts `timeout` into an exception. `tail` and `prompt` treat timeout as successful finite observation; `wait`, suspend, archive, and purge convert timeout to `UntilTimeoutError` because their requested condition was not achieved. Timed message/raw prompt and tail streams fetch a final cursor; entries mode remains entry-only because each emitted entry carries its cursor.

Concrete clients may retain independent `waitClosed` methods, but the generic driver relies only on queue completion.

### `src/core/streaming/message-records.ts`

```ts
import type {
  RpcSocketBroadcastEvent,
  SessionEntry,
} from "@geraschenko/pi-coding-agent";
import type { MessageStreamRecord } from "./types.ts";

export class EventMessageRecordProjector {
  project(
    event: RpcSocketBroadcastEvent,
  ): readonly MessageStreamRecord[];

  finish(): readonly MessageStreamRecord[];
}

export function messageRecordsFromEntries(
  entries: Iterable<SessionEntry>,
): IterableIterator<MessageStreamRecord>;
```

Dependencies and responsibilities:

- One `EventMessageRecordProjector` instance lives for one message-mode stream.
- `project` retains existing conversion for `message_end`, compaction lifecycle, tree navigation, session changes, and queue updates, and adds faithful conversion for `model_changed`. It may emit zero, one, or multiple records for each event.
- `finish` returns records buffered by the projector. It returns an empty array in this implementation because coalescing is not added by this spec, but it establishes the flush interface needed by later coalescing.
- Message-mode `onEvent` writes every record returned by `project` before checking out of the handler. Its `onEnd` writes every record returned by `finish`.
- `messageRecordsFromEntries` is the single entry-to-message-record adapter and calls Pi's exported `sessionEntryToContextMessages` for non-model entries.
- Entry conversion uses an internal previous-entry ID only; it does not build an index, inspect `leafId`, track previous models, or mutate entries.
- Future event and entry projectors may feed a shared record-level coalescer downstream of their distinct source projections. Raw RPC events and persisted entries are not unified into a fabricated common observation type.
- Future coalescers must flush whenever a record is not mergeable with the current group and must not buffer beyond that current group. This bounds cutoff cleanup and prevents an arbitrarily large history from remaining unflushed.

The class and function first exist as compiling stubs before their implementations are added.

### `src/format/input.ts`

The existing signature is unchanged:

```ts
export function parseMessageRecords(
  input: string,
): readonly MessageStreamRecord[];
```

For a single JSON document, recognition order becomes:

1. an object with `messages` uses existing get-messages decoding;
2. an object with `entries` uses `decodeEntriesInput`, passes `entries` to `messageRecordsFromEntries`, and materializes the result;
3. other input falls through to existing message-stream JSONL decoding.

The snapshot's `leafId` is validated by `decodeEntriesInput` but is deliberately not passed to entry conversion.

Raw session-entry JSONL support is not added by this change. The requested new input is the JSON object emitted by `pictl get-entries`; existing message-stream JSONL behavior remains authoritative for JSONL input.

### `src/format/messages.ts`

Existing exported signatures remain unchanged:

```ts
export function formatMessageRecords(
  records: Iterable<MessageStreamRecord>,
  options?: Partial<MessageFormatOptions>,
): string;

export function formatMessageRecord(
  record: MessageStreamRecord,
  options: MessageFormatOptions,
): string | undefined;
```

`formatControl` adds `model_changed` rendering and updates tree-navigation rendering so an unknown old leaf reports only the new leaf. Other control and message formatting remains unchanged.

### Import and caller updates

- `src/core/tail.ts` and `src/core/rpc-commands.ts` import stream command functions/types from `./streaming/stream.ts`.
- `src/core/index.ts`, `src/core/wait.ts`, and `src/core/lifecycle.ts` import driver symbols from `./streaming/driver.ts`.
- `wait.ts` and `lifecycle.ts` keep their push-shaped `onSeed`/`onEvent` handlers; only driver imports and the client subscription implementation change.
- Message mode constructs one `EventMessageRecordProjector`; entries and raw modes retain their current `onEvent` side effects.
- `src/format/record-writer.ts` imports stream records from `../core/streaming/types.ts` and writer/output types from `../core/streaming/stream.ts`.
- `src/format/input.ts`, `src/format/messages.ts`, and `src/format/entries.ts` import stream types from `../core/streaming/types.ts`.
- Tests and internal comments referring to the old paths, promise-chain queue, pre-seed driver queue, callback subscription contract, or old quiet-timer behavior are updated.

## Data flow

### RPC event stream

```text
PiSocketClient dispatch
  -> fold event into live RpcSessionState
  -> queue { event, postFoldState }
  -> runStream for-await pump
  -> serialized handler.onEvent(event, state)
  -> EventMessageRecordProjector.project(event)
  -> MessageStreamRecord[]
  -> RecordWriter
  -> handler.onEnd
  -> EventMessageRecordProjector.finish()
  -> RecordWriter
```

`runStream` evaluates every RPC event, including events that produce no message record. Directly observed `model_changed`, `tree_navigated`, and `session_changed` information is retained rather than inferred. One projector instance spans the stream, so later stateful coalescing can span adjacent events and flush through `onEnd` without changing the driver interface.

### Get-entries formatting

```text
get-entries JSON object
  -> parseMessageRecords
  -> decodeEntriesInput
  -> entries in append order
  -> messageRecordsFromEntries
       -> optional inferred tree-navigation control
       -> model-change control, or
       -> sessionEntryToContextMessages(entry)
       -> StreamMessageRecord(s)
  -> formatMessageRecords
  -> text
```

`leafId` does not participate after validation. Data flows only forward through the input order.

### Commutativity goal

For facts represented by both inputs, event and entry adapters target the same `MessageStreamRecord` interface and therefore the same formatter. The intended equivalence is user-visible semantic equivalence, not byte-for-byte identity for all traces.

Known non-commuting cases:

- Entry-producing events generally do not include persisted entry IDs.
- Entry-derived navigation is delayed until a subsequent entry exposes a parent discontinuity.
- Navigation with no subsequent append is absent from entries.
- Session identity is present in session-change events but absent from entries.
- Events expose compaction start, completion, abortion, and failure; entries expose only persisted successful summaries.
- A tree-navigation event can carry a branch summary entry while persisted entry conversion emits that summary as a separate message record.

No approximate event-to-entry adapter is added. Fabricating ID-less `SessionEntry` values would weaken the meaning of the session-entry interface and would not resolve these information differences.

## Cost

- **Entry conversion compute:** `O(n + m)`, where `n` is input entries and `m` is projected messages. Work is concentrated in the single append-order pass and Pi's per-entry projection.
- **Projection state:** `O(1)`, consisting only of the previous input entry ID.
- **Parser result memory:** `O(m)`, because `parseMessageRecords` retains its array return type and materializes the generator output. This is concentrated at the existing whole-input parser seam.
- **Socket event queue:** `O(burst)` memory when the socket produces events faster than the serialized handler advances. Source cutoffs drain accepted values; consumer condition satisfaction or hook failure cancels and drops the remainder. The socket cannot be paused for backpressure because RPC responses share it and entry-mode handlers issue RPC requests while processing events.
- **Output backpressure:** `RecordWriter.writeRecord` is synchronous and does not await Node stdout backpressure. A stalled pipe reader can move queued output into Node's writable buffering, increase memory use, and delay process completion while stdout remains unflushed.
- **Cutoff drain:** transport close, quiet, or timeout may leave `O(burst)` residual handler calls before settlement. Later timers cannot change the first cutoff outcome. This deliberate cost makes emitted records independent of handler throughput and lets a queued satisfying event produce `done`.
- **State folding:** `PiSocketClient` folds each event once at dispatch and stores one post-fold snapshot with each queued event. The driver performs no duplicate fold.
- **Timeout cleanup:** after cutoff, cleanup drains every accepted event plus `onEnd`; a hung handler can delay settlement indefinitely. Risk concentrates in entry-mode RPC calls.
- **File reorganization:** broad import churn with no runtime cost. Review should focus on stale imports, intentional driver export changes, and removal of obsolete promise-chain/pre-seed queue comments.
- **No tree/context index:** entry conversion does not allocate an ID map or branch path and does not incur `buildSessionContext` costs.

## Edge cases

- Empty `entries` produces empty formatted output.
- A one-entry snapshot emits no inferred navigation; a lone model-change entry emits nothing.
- A non-message bookkeeping entry between messages advances the expected parent ID.
- A model-change entry after the first input entry emits even if no message precedes it, and repeated model-change entries are not deduplicated.
- Parent discontinuity is checked before handling the current entry, so navigation output precedes a current model control or projected message.
- `parentId: null` after a previous entry emits navigation from the previous ID to `null`.
- An entry may project to multiple messages; all are emitted in Pi's returned order.
- `sessionEntryToContextMessages` normalization of null legacy message content remains Pi-owned.
- Invalid get-entries input continues to fail through `decodeEntriesInput` with `UsageError`.
- A directly observed `model_changed` event always emits, including the first event in a stream.
- A directly observed `tree_navigated` event always emits. If `oldLeafId` is null or otherwise unavailable, only `newLeafId` is shown.
- Existing parsed control JSONL remains valid; `model_changed` joins the accepted control kinds.
- Events arriving after the seed is observed but before subscribe continuation are queued and consumed after `onSeed`.
- A satisfying event is converted and written, then `onEnd` flushes, before `done` settlement.
- Timeout establishes a source cutoff, drains accepted events, flushes through `onEnd`, and resolves `timeout`; a queued satisfying event instead resolves `done`.
- Quiet timing resets when the client accepts an event, not when the handler consumes it. Quiet cutoff drains every event accepted before the silence interval elapsed.
- Seed/handler satisfaction and hook failure cancel queued events without closing the socket; callers may still request a final cursor.
- Socket close stops new input but drains queued events. A queued event can satisfy the condition and produce `done`; otherwise queue exhaustion flushes and produces `closed`.
- Pictl prompt/tail require a final cursor after `done` or `timeout` for message/raw output. The final `get_entries` request starts in `onStop` as soon as event acceptance ends, and cursor writing uses that captured response rather than a later fetch. Pi does not expose an event-aligned leaf ID, so a concurrent append/session replacement can still race this snapshot; this accepted limitation remains until Pi's protocol can carry the folded leaf. If transport closure made the RPC impossible, the command fails rather than omitting the cursor.
- `tail --timeout 0` is history-only: after emitting message/entry history (raw has none), it does not pull live events. Message/raw output fetches a final cursor; entries output remains entry-only.
- Close before seed resolution is a client-owned subscription error because no result state exists.
- `onEnd` runs on seed satisfaction, handler satisfaction, quiet completion, timeout, and post-drain close. It does not run after subscription, `onSeed`, `onEvent`, or projector failure.

## Non-goals

- Do not derive the active LLM context or use `buildSessionContext`.
- Do not filter entries according to `leafId`.
- Do not add raw session-entry JSONL as a new `format messages` input form.
- Do not add a formatter `--since` flag.
- Do not detect session replacement directly from entries.
- Do not coalesce or deduplicate model controls.
- Do not synthesize previous-model information.
- Do not add an approximate event-to-entry conversion.
- Do not change Pi's RPC protocol or add entry IDs to events.
- Do not make compaction lifecycle events and persisted compaction summaries artificially identical.
- Do not move tail commands, RPC commands, until-condition modules, or formatters into `src/core/streaming/`.
- Do not migrate clauctl in this spec. Its generated stream driver and sync configuration are covered by the separate handoff `clauctl/docs/specs/async-iterable-stream-driver-handoff.md`.

# IMPLEMENTATION IDEAS

- Pi's exported `sessionEntryToContextMessages` is the key primitive. It is a pure per-entry projection and, unlike `buildSessionContext`, does not select an active branch or apply compaction-aware history replacement.
- Keep inferred navigation in `messageRecordsFromEntries`, not in formatting. This lets JSONL writers and text formatters consume the same semantic record and keeps entry-order state out of presentation code.
- Keep model changes in `StreamControlRecord`. A separate top-level record would split one semantic concept across multiple representations.
- Narrow `StreamControlRecord.control` into a discriminated union. This preserves the existing `{ type: "control", control: { kind, event } }` wire shape while allowing an honest minimal model reference for entry-derived controls.
- A real Pi model has many required fields (`name`, `api`, `baseUrl`, cost, limits, and capabilities). Entry conversion must not cast `{ provider, modelId }` to that complete type; structural projection to `StreamModelReference` avoids that lie.
- The first-entry rule makes partial `get-entries --since` output useful without requiring the formatter to know the omitted cursor. It deliberately sacrifices detection of navigation immediately before the first returned entry.
- Treat the conversion seam as event/entry adapters into message records, not as event-to-entry emulation. This keeps `SessionEntry` reserved for genuinely persisted records.
- Direct event conversion should remain faithful even when entry conversion cannot reproduce the same observation: model selection, explicit navigation, and session replacement should not be discarded merely to force artificial equivalence.
- Tests should compare concrete record sequences before testing formatted text. The conversion interface is the primary test surface; formatter tests then verify control wording.
- Keep async iteration at the client/driver seam, where source exhaustion and FIFO queueing are transport concepts. Keep handlers push-shaped: one serialized `onEvent` call gives the driver an observable completion point for quiet timing and flushing.
- Pair each event with its post-fold state at socket dispatch. This preserves event/state alignment without duplicate folding even if the client's live state advances while a handler awaits.
- Use queue cancellation for consumer satisfaction and hook failure. Use queue close for source cutoffs so accepted records drain without closing the socket; prompt/tail still need the connection after successful settlement to fetch the final cursor.
- Treat source cutoff differently from consumer cancellation: drain its received queue so output does not depend on handler speed and a queued satisfying event is not misreported. Handler failures during that drain remain ordinary failures.
- Mark settlement and stop the source before awaiting `onEnd`; this prevents async flush from racing another `onEvent`.
- Do not pause the shared socket to impose backpressure: doing so could deadlock entry-mode processing while it waits for an RPC response carried by that socket.
- Build in two phases: first move files, add the approved types/functions as stubs, and compile; then implement conversion and tests. This separates import/type failures from behavioral failures.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Derisk desired semantics: append-order projection, not active-context reconstruction.
- [x] Verify Pi exports `sessionEntryToContextMessages` and document its per-entry behavior.
- [x] Derisk navigation: infer from parent discontinuities after the first input entry; preserve directly observed navigation events.
- [x] Derisk session replacement: preserve direct events; entries can only reveal a later parent discontinuity.
- [x] Derisk models: explicit controls report the new model immediately; no previous-model synthesis or coalescing.
- [x] Derisk compaction and branch summaries: use Pi's per-entry projection; retain distinct live compaction lifecycle controls.
- [x] Approve streaming directory seam and initial type/data-flow design.
- [x] Resolve review comments: no speculative session-change logspam; replace singular event conversion with a stateful projector.
- [x] Approve paired async socket subscription with a serialized push handler and no duplicate state fold.
- [x] Approve initial `onEnd` ordering and deadline semantics.
- [x] Revise settlement after implementation review: source cutoffs drain accepted records, quiet timing follows queue pushes, timeout is a driver outcome, and prompt/tail treat timeout as successful finite observation with final message/raw cursors.
- [x] Minimize the accepted cursor race by starting and retaining the final `get_entries` snapshot in `onStop`, immediately after event acceptance ends; document the remaining Pi protocol limitation.
- [x] Complete iterative fresh-context review; final verdict: land.
- [x] Approve close semantics: drain queued events; a queued satisfying event wins; fail pictl finite streams if their final cursor cannot be fetched.
- [x] Create and revise a separate clauctl migration handoff for the generated driver and sync configuration.
- [x] Incorporate cross-repo review: pre-seed protocol handling, quiet-timer behavior change, test ownership, stalled-pipe cost, and nested sync constraints.
- [x] Move streaming files and update imports; build with conversion stubs.
- [x] Implement discriminated stream controls and event conversion.
- [x] Implement entry-to-message-record conversion.
- [x] Accept get-entries documents in `parseMessageRecords`.
- [x] Add conversion and formatting tests.
- [x] Run check, lint, formatting verification, and tests.
- [x] Perform implementation review and update this work log.
