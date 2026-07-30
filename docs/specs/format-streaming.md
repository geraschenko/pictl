# SPEC

## Problem

Three related problems in the `pictl format` message/entry pipeline:

1. **Buffered input.** `format messages` and `format entries` read stdin to
   EOF (`readInputFile`) before rendering anything. `tail --json` documents
   its output as "for piping into `pictl format`", but a live pipe renders
   nothing until the tail terminates, so the pipe is only useful with
   `--until`. clauctl solved this with a classify-from-first-record streaming
   decoder (`decodeFormatInput` in its `src/format/input.ts`); this spec ports
   the design to pictl's input family.

2. **Split byte-equality guarantee.** "Formatted `tail` output equals
   `format messages` output" is maintained by two implementations —
   `formatMessageRecords` (join with `\n\n`) and `FormattedMessageWriter`
   (separator-after, relying on message streams ending in a cursor) — kept
   equal by a comment, not by code.

3. **Tool-call noise.** Agent transcripts are dominated by runs of read-only
   tool calls, each costing an assistant block plus a tool-result summary
   line. These should coalesce into a single line. That requires a stateful
   formatter, which the current pure per-record `formatMessageRecord` cannot
   express — and which problem 2's consolidation enables: one stateful
   formatter serves `format messages`, `tail`, and `prompt`.

Historical note: `format-command.md` removed an earlier `MessageFormatState`
when _control_ coalescing was dropped (controls render individually). That
decision stands; this spec coalesces only read-only tool calls.

## Ontology

This spec adopts the events/entries/messages ontology from clauctl's
docs/specs/prompt-tail-parity-overview.md — the names describe what records
_are_, not where a command happens to use them:

- **Events** are records observed on pi's RPC socket
  (`RpcSocketBroadcastEvent`): live message completions plus daemon-known
  transient facts (agent lifecycle, queue changes, navigation). What `tail
  --type raw` emits today.
- **Entries** are pi session-tree records (`SessionEntry`): the durable
  history, id-linked.
- **Messages** are the context-facing conversation units plus explicitly
  typed control records (`MessageStreamRecord`). pictl projects them from
  _both_ sources: events → messages (`EventMessageRecordProjector`) and
  entries → messages (`messageRecordsFromEntries`).

Accordingly, `--type raw` is renamed `--type events` on `tail` and `prompt`
(no back-compat alias), and events become a first-class format type: `tail
--type events` renders formatted output by default like the other types
(today raw forces JSONL), `--json` restores the record stream, and a new
`pictl format events` renders event JSONL. The raw-mode restrictions carry
over unchanged (no historical backlog, so `-n`/`--since` do not apply).

## Success criteria

- `pictl format messages [file]`, `pictl format entries [file]`, and `pictl
  format events [file]` render incrementally: each complete input record is
  processed — and any output it produces written — before the next record is
  read, so `pictl tail --json | pictl format messages` displays activity as
  it happens (a coalescing run in progress deliberately produces no output
  until it closes).
- `pictl format tree` is unchanged (tree layout needs every entry; it keeps
  whole-input reading).
- `tail`/`prompt` accept `--type events` (replacing `raw`) and render events
  formatted by default, `--json` for JSONL.
- One `MessageFormatter` implementation produces formatted message output for
  `format messages`, `tail`, and `prompt` (`FormattedMessageWriter` delegates
  to it); byte-equality between the paths is structural, not promised in a
  comment.
- Runs of thinking and read-only tool calls render as one coalesced line
  (model: clauctl's TUI fold in its src/tui/transcript.ts), in every
  formatted message path — `format messages`, `tail`, and `prompt` alike.
- For finite inputs, output is byte-identical to today's output except where
  coalescing applies.
- Streaming input reuses `src/core/line-reader.ts`; per-record validation
  errors gain line numbers (today only JSON syntax errors have them).

## Input decoding design

`src/format/input.ts` gains a streaming decoder built on `LineReader`,
modeled on clauctl's `decodeFormatInput`:

```ts
export type FormatInput =
  | { kind: "entries"; records: AsyncIterable<SessionEntry>; leafId?: string | null }
  | { kind: "messages"; records: AsyncIterable<MessageStreamRecord> }
  | { kind: "events"; records: AsyncIterable<RpcSocketBroadcastEvent> }
  | { kind: "empty" };

export function inputChunks(
  context: CommandContext,
  file: string | undefined,
): AsyncIterable<Buffer | string>; // stdin or fs.createReadStream

export async function decodeFormatInput(
  chunks: AsyncIterable<Buffer | string>,
): Promise<FormatInput>;
```

Classification from the first complete record:

- **Entry record**: string `type` in `ENTRY_TYPES` _and_ string `id` and
  `timestamp`. The extra field check disambiguates the overlap with stream
  records: a session entry with `type: "message"` carries `id`/`timestamp`; a
  stream message record does not.
- **Message stream record**: `type` is `"message"`, `"control"`, or
  `"pictl_cursor"` and the entry check above fails.
- **Event record**: string `type` in `EVENT_TYPES`, a runtime list mirroring
  `RpcSocketBroadcastEvent` (maintained like `CONTROL_KINDS`). Only the
  _first_ record is classified against the list; once a stream is classified
  as events, later records need only a string `type` outside the
  entry/message space — pi's fork adds event types over time and the fold
  ignores unknown types, so the formatter must not reject them.
- **Documents** (finite by construction, buffered whole, yielded as a
  finished stream): `{entries: [...]}` → `kind: "entries"` with `leafId`;
  `{messages: [...]}` → `kind: "messages"`. `{tree: [...]}` keeps its
  existing cross-pointing error.
- No complete record before EOF and no non-blank bytes → `kind: "empty"`.

Existing strict validation (`decodeSessionEntry`, `decodeMessageStreamRecord`)
runs per record as it is yielded; errors are prefixed with the record's line
number. A mid-stream record of the wrong shape throws a cross-pointing
UsageError naming the line number (e.g. "record 7 looks like session-entry
output; use `pictl format entries`").

Subcommand acceptance:

- `format messages`: message JSONL, `{messages}` document, `{entries}`
  document (projected through `messageRecordsFromEntries`, which is already a
  generator), — new, for symmetry with clauctl — raw entry JSONL, projected
  the same way, and event JSONL, projected through
  `EventMessageRecordProjector` (the same conversion `tail --type messages`
  uses).
- `format entries`: entry JSONL or `{entries}` document. The `--filter` path
  needs `leafId`, which only the document form carries; JSONL input filters
  against a null leaf, exactly as `formatEntryJsonl` does today.
- `format events`: event JSONL only.
- `format tree`: unchanged (whole-input `parseEntriesInput`).

## Formatter design

`src/format/messages.ts` gains a stateful push/end formatter replacing the
free-function pair:

```ts
export class MessageFormatter {
  constructor(options: MessageFormatOptions);
  /** The record's rendered chunk including any separator; "" if nothing. */
  push(record: MessageStreamRecord): string;
  /** Flushes any open coalesced run and the final newline. */
  end(): string;
}
```

The concatenation of every `push()` and the final `end()` is the stream's
formatted output. The `\n\n` separator is emitted _before_ each block (the
old writer's `\n` after a cursor was only ever the stream-final newline,
which `end()` now supplies); for finite streams this reproduces
`formatMessageRecords`' bytes exactly, without relying on the stream ending
in a cursor.

Callers:

- `formatMessages` (command): `decodeFormatInput`, then push each record,
  writing each non-empty chunk immediately.
- `FormattedMessageWriter`: holds a `MessageFormatter`; `writeRecord` writes
  `push()`'s chunk. `RecordWriter` gains an `end(): void` member so the
  streaming engine can flush the formatter when a stream finishes;
  `StdoutJsonlWriter` and `FormattedEntryWriter` implement it as a no-op.
- `formatMessageRecords` survives only as a thin wrapper (construct, push
  all, end, join) or is deleted in favor of call sites using the class
  directly — implementer's choice by test ergonomics.
- `prompt`'s default formatted output flows through `FormattedMessageWriter`
  and therefore gains coalescing too (confirmed wanted).

## Events formatter

`src/format/events.ts`: one line per event, stateless per record (a
`FormattedEventWriter` mirrors `FormattedEntryWriter`; its `end()` is a
no-op). Rendering:

- Events that message mode wraps as controls (`compaction_*`,
  `tree_navigated`, `session_changed`, `queue_update`, `model_changed`)
  reuse `formatControl`'s field extraction, labeled with the event type:
  `[tree_navigated: abc123 -> def456]`, `[queue_update: steering=1
  follow-up=0]`.
- `message_end` renders the contained message's one-line summary (the
  `rawMessageSummary` code entries mode already uses): `[message_end]
  assistant: [tool: read] Sure — looking now…`.
- Everything else — including event types unknown to this pictl — renders
  bare `[<type>]`. Payload details beyond the above are `--json`'s job.

## Read-only tool-call coalescing

Modeled on clauctl's TUI fold (clauctl repo-relative: src/tui/transcript.ts),
adapted from a re-renderable screen to an append-only stream.

- **Allowlist**: `READ_ONLY_TOOLS = ["read", "grep", "find", "ls"]` in
  `src/format/messages.ts`, mirroring pi's own `createReadOnlyTools` (pi
  repo-relative: packages/coding-agent/src/core/tools/index.ts); a comment
  cites that source so drift is checkable.
- **Run membership** (adapted from transcript.ts `isFoldable`): assistant
  messages with no non-blank text, no abort, and no error, whose tool calls
  are all read-only, join the run — their thinking blocks contribute to the
  thought clause instead of emitting `[thinking]`, and the successful tool
  results answering coalesced calls are absorbed silently (their summaries
  are the noise being removed).
- **Run breakers**: an assistant message with visible text, a non-read-only
  tool call, an abort or error; a _failed_ tool result (which then renders
  normally); any control or cursor record; user / bash / custom / summary
  messages; and `end()`. The breaker closes the line, then renders normally.
- **Held back until the run closes**: `push()` returns `""` for records that
  join the run; the breaker's `push()` — or `end()` at EOF — emits the
  completed line first, then the breaker's own block. During a live `tail` a
  run in progress therefore shows nothing until it breaks; accepted, since
  any visible activity is itself a breaker.
- **Line shape** (aggregated over the whole run, like the TUI fold):
  `[thought for 4.3s; read src/core/util.ts, src/core/line-reader.ts; grep TODO]`
  — one thought clause first when any coalesced message had thinking, then
  one clause per tool name in first-appearance order, that tool's args in
  call order joined by `,`; clauses joined by `;`. A clause arg is the bare
  value of the first preferred key
  (`path`/`file_path`/`command`/`pattern`, truncated to `maxToolArgChars`);
  calls with none fall back to `formatToolArguments`'s JSON summary. Full
  paths rather than the TUI's `read 2 files` counts: agent consumers of
  formatted output can use them.
- **Thought clause**: every pi `AgentMessage` carries a numeric `timestamp`;
  a thinking message's duration is its timestamp minus the previous record's
  (clauctl's session-file delta rule, transcript.ts), summed across the
  run's thinking messages and rendered to one decimal (`thought for 4.3s`);
  bare `thought` when no duration was computable (timestamps missing or time
  ran backwards).
- `--tool-results full` disables coalescing entirely (full detail was asked
  for). `--tool-results none`/`summary` coalesce.

## Edge cases

- **Partial output before a mid-stream error.** A streaming formatter has
  already written earlier records when record N fails validation; the error
  goes to stderr after partial stdout. Inherent to streaming; clauctl accepts
  the same.
- **Torn final line.** An unterminated trailing line is not a record and is
  dropped, matching `LineReader` semantics everywhere else.
- **Blank lines** are skipped but counted, so reported line numbers match the
  input file.
- **Empty input** renders nothing and exits 0 for all three streaming
  subcommands.
- A block's trailing separator arrives with the next block, so a live pipe's
  last block sits without a trailing newline until then. Cosmetic, and
  inherent to separator-before streaming.

## Non-goals

- No change to any command's `--json` record shapes. The only surface
  changes: the `--type raw` → `--type events` rename, and events mode
  rendering formatted by default instead of forcing JSONL.
- No `format tree` streaming.
- No control-record coalescing (see historical note).
- No ANSI styling.

# IMPLEMENTATION IDEAS

- Port clauctl's `decodeFormatInput` structure (first-record classification,
  deferred document fallback, lazy validating generator) rather than
  reinventing; the classification predicates and error wording are the
  pictl-specific parts.
- Implementation order: (1) `MessageFormatter` with byte-equality tests
  against existing fixtures, wire into `FormattedMessageWriter` +
  `RecordWriter.end()`; (2) streaming input decoding; (3) the
  `--type events` rename plus events formatter; (4) coalescing last, behind
  its own tests.
- `format.test.ts` fixtures already cover the finite paths; add a test
  driving `formatMessages` with a chunked fake stdin to assert incremental
  emission (chunk boundaries observable via `fakeProcess`'s
  `stdoutChunks`).

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [x] Resolved review comments (9a1ec25): adopted the events/entries/messages
      ontology (`--type raw` → `--type events`, new `format events`);
      coalescing modeled on clauctl's TUI fold (its src/tui/transcript.ts)
      with the `[thought for 4.3s; read a, b]` line shape; allowlist mirrors
      pi's `createReadOnlyTools` (`read`, `grep`, `find`, `ls` — checked
      against the pi package, not guessed); entry JSONL accepted by
      `format messages`; `prompt` gains coalescing.
- Decision (user, superseding an earlier order-preserving live-growth
  proposal): the coalesced line is held back until the run closes (breaker
  `push()` or `end()`), which allows full TUI-style aggregation — summed
  thought clause, tools grouped by name. Cost: a live run shows nothing
  until it breaks; acceptable because any visible activity is itself a
  breaker.
- Decision: thinking durations use the message-timestamp delta rule; verified
  every pi `AgentMessage` role carries `timestamp` (fixtures + pi types), so
  durations work on message JSONL input, not just entries.
- [x] Implement `MessageFormatter` + writer unification. Correction to this
      spec: it said the separator before a cursor line is `\n`, but the
      committed fixture (and today's `formatMessageRecords`, which joins every
      block with `\n\n`) puts `\n\n` there; the old writer's `\n` _after_ a
      cursor only ever materialized as the stream-final newline, since tail
      writes its cursor last. A uniform `\n\n` separator-before plus `end()`'s
      trailing `\n` reproduces both old paths byte-exactly, so that is what is
      implemented. `writer.end()` is called in the stream `finally`, so a
      failed stream (e.g. "pi socket closed") still flushes.
- [x] Implement streaming input decoding. Notes: `FormatInput`'s entries kind
      carries `leafId: string | null` (non-optional; null for JSONL input and
      leafless documents) — simpler for `format entries` than the sketched
      optional. `messageRecordsFromEntries` was refactored into an
      `EntryMessageRecordProjector` class (parallel to
      `EventMessageRecordProjector`) so the entries→messages projection runs
      per-record over the async stream; the sync generator survives as a thin
      wrapper. The subcommand views live in `input.ts` as `messageRecordsOf` /
      `entriesOf` (cross-pointing rejections included), shared by commands and
      tests. `fakeProcess` gained an optional stdin-chunks parameter
      (test-util.ts is in the clauctl sync set; the change is additive).
      Behavior change inherent to the port: a finite JSONL file without a
      trailing newline now drops its torn final line (spec's torn-final-line
      rule), where the old buffered parser accepted it.
- [x] Implement `--type events` rename + events formatter. Addition the spec
      missed: finite `tail --type events --json` output ends in a
      `pictl_cursor` record, so cursors get their own classification shape,
      accepted by both message and events streams and rendered
      `[cursor: <id>]` in both; a cursor-FIRST stream classifies as messages
      (`tail --json --timeout 0` in default mode emits the same bytes), so
      `eventsOf` additionally accepts a messages-kind stream that turns out
      to be cursor-only.
- [x] Implement read-only coalescing. Refinements settled during
      implementation: an assistant message contributing neither thinking nor
      a tool call (e.g. empty content) renders normally instead of opening an
      empty run; a successful read-only result is absorbed only when it
      answers a call in the OPEN run (a stray one renders normally and
      breaks); `previousTimestamp` for the thought delta updates on every
      message record carrying a numeric timestamp, including absorbed ones,
      so a second thinking message's delta starts at the preceding tool
      result. Existing fixtures updated where coalescing applies (the spec's
      byte-identity carve-out).
- [x] Resolved review comments (b0282a3): the default width 120 → 100,
      shared as `DEFAULT_FORMAT_WIDTH` in `core/constants.ts` (entry/tree
      line width, message tool-arg truncation, event message summaries);
      `format messages` accepts event JSONL, projected through
      `EventMessageRecordProjector` instead of cross-pointing (spec
      acceptance list updated); event cross-pointers say "looks like socket
      events" instead of "looks like tail output" (tail produces all three
      types); a thought duration that would round to 0.0s renders as
      `thought for <n>ms`.
