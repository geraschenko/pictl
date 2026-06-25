# Formatted output by default for `prompt` and `tail`

# SPEC

## Problem

`pictl prompt` and `pictl tail` currently print machine-readable JSONL by
default. The people most likely to run these commands interactively want
human-readable output. We want formatted, human-readable output to be the
default, while keeping the JSONL forms available for scripting and for piping
into `pictl format`.

Today the output shape is controlled by a single `--type` flag whose values
are `messages | entries | raw` (plus a `detach` value on `prompt` only). This
conflates two orthogonal concerns: *what* stream of data to emit (messages,
entries, or raw socket events) and *how* to encode it (human-readable vs JSON).
It also overloads `--type` with a lifecycle option (`detach`) that is not an
output shape at all.

We separate these concerns:

- `--type {messages|entries|raw}` selects the data stream (unchanged values,
  minus `detach`).
- `--json` selects JSON encoding instead of the default human-readable
  formatting.
- `-d`/`--detach` (on `prompt` only) is a lifecycle option: send the prompt and
  return immediately.

## What we want

For both `prompt` and `tail`:

- `--type` accepts `messages` (default), `entries`, `raw`.
- Without `--json`, output is human-readable, rendered through the *same*
  formatting code as `pictl format`:
  - `--type messages` → `formatMessageRecord` per record (default options).
  - `--type entries` → `formatEntry` per entry (default options).
  - `--type raw` → raw socket events, one JSON object per line (`--json` is a
    no-op here; raw is inherently JSON).
- With `--json`, output is JSONL exactly as today:
  - `--type messages` → JSONL message records.
  - `--type entries` → JSONL entry records.
  - `--type raw` → JSONL socket events (unchanged; `--json` is a no-op).

For `prompt` only:

- `-d`/`--detach` sends the prompt and returns immediately without streaming.
  `--type` and `--json` are silently ignored (there is no output to shape).
  `--detach` combined with `--until` or `--timeout` is an error (those flags
  express an intent to wait, which contradicts detach).

Finer formatting control (tool-result display, widths, timestamps, filters,
etc.) is intentionally *not* exposed on `prompt`/`tail`. It is obtained by
emitting `--json` and piping into `pictl format messages|entries`.

### Final cursor parity

The default-formatted `--type messages` output of a **finite** stream must be
byte-identical to piping that stream's `--json` output through
`pictl format messages` **with no format flags** (so that `formatMessageRecords`
falls back to `DEFAULT_MESSAGE_FORMAT_OPTIONS`, matching what
`FormattedMessageWriter` uses).

A finite `messages` stream always ends with a single `pictl_cursor` record
(written by `writeFinalCursor` after the stream loop resolves). This is the
default for `prompt` (its default `until` is the finite `turn-end`) and for
`tail` with no `--until`/`--follow` (where `until === undefined` also triggers
`writeFinalCursor`, see `streamTail`), as well as for any finite `--until`. The
batch formatter (`formatMessageRecords`) emits `chunks.join("\n\n") + "\n"`. To
match it, `FormattedMessageWriter` separates records as follows:

- after a `message` or `control` record: `"\n\n"`,
- after a `pictl_cursor` record: `"\n"`.

This yields exact parity for finite `messages` streams (which always terminate in
a cursor). Infinite streams (`--follow` / `--until killed`) never write a cursor
and terminate only by throwing when the socket closes; there is no clean EOF, so
trailing-newline parity does not apply to them.

`--type raw` finite streams also write a final cursor, but raw always uses
`StdoutJsonlWriter` (JSON), so the message-formatting parity rule does not apply
to it — the cursor is just another JSON line, unchanged from today.

Entry output is one line per entry and, **with the default options that
`prompt`/`tail` use**, is byte-identical to `pictl format entries` run with no
format flags. It is *not* byte-identical if the user pipes `--json` into
`pictl format entries` with non-default flags (`--timestamps`, `--full`,
`--filter`, `--width`); that is expected and fine.

## Examples

```sh
# Human-readable by default (new behavior):
pictl prompt "Say hi"
pictl tail

# Machine-readable, unchanged from today:
pictl prompt --json "Say hi"
pictl tail --json

# Pipe JSONL into pictl format for fine control:
pictl prompt --json "Say hi" | pictl format messages --tool-results full
pictl tail --type entries --json | pictl format entries --timestamps

# Raw socket events (--json is a no-op):
pictl tail --type raw

# Fire-and-forget:
pictl prompt -d "Go work on the thing"
```

## Type design

### `src/core/streaming.ts`

Remove the prompt-only type machinery; `prompt` reuses the tail output-type set.

```ts
// REMOVED: PROMPT_TYPES, PromptType, parsePromptType.
// STREAM_OUTPUT_TYPES / StreamOutputType / parseStreamOutputType stay and now
// serve both prompt and tail. Values: "messages" | "entries" | "raw".

// Renamed from JsonlWriter; now the injected output seam. Exported.
export interface RecordWriter {
  writeRecord(record: unknown): void;
}

// StdoutJsonlWriter MOVES OUT to src/format/record-writer.ts.
// The two internal `new StdoutJsonlWriter(context)` constructions are removed;
// the writer is injected by the caller.

// All `writer: JsonlWriter` annotations become `writer: RecordWriter`
// (writeFinalCursor, streamMessages, streamEntries, drainEntries,
// emitHistoricalMessages, streamRaw).

export interface PromptStreamOptions {
  type: StreamOutputType;            // was PromptType; no "detach"
  writer: RecordWriter;              // injected
  until: StreamUntil;
  timeoutMs: number | undefined;
  message: string;
  images: Extract<RpcCommand, { type: "prompt" }>["images"] | undefined;
  streamingBehavior: "steer" | "followUp" | undefined;
}

interface StreamOptions {            // tail
  outputType: StreamOutputType;
  writer: RecordWriter;              // injected
  since: string | undefined;
  limit: number | undefined;
  until: StreamUntil | undefined;
  timeoutMs: number | undefined;
}

// Shared by streamPrompt and promptDetached; builds the pi "prompt" RpcCommand.
function buildPromptCommand(options: {
  message: string;
  images: Extract<RpcCommand, { type: "prompt" }>["images"] | undefined;
  streamingBehavior: "steer" | "followUp" | undefined;
}): RpcCommand;

// New: the detach path, separated from the streaming path. Connect, send the
// prompt, close. No writer, no streaming.
export async function promptDetached(
  context: CommandContext,
  options: {
    message: string;
    images: Extract<RpcCommand, { type: "prompt" }>["images"] | undefined;
    streamingBehavior: "steer" | "followUp" | undefined;
  },
): Promise<void>;

// streamPrompt: drops the internal writer construction and the detach branch;
// uses options.writer and buildPromptCommand. Signature unchanged otherwise.
export async function streamPrompt(
  context: CommandContext,
  options: PromptStreamOptions,
): Promise<void>;

// streamTail: drops the internal writer construction; uses options.writer.
export async function streamTail(
  context: CommandContext,
  options: StreamOptions,
): Promise<void>;
```

### `src/format/record-writer.ts` (new)

Holds every `RecordWriter` implementation and the factory. Legal under the
existing dependency direction (`format` → `core`); `core` does not import this
module. The factory is injected by the command layer (dependency inversion), so
the streaming engine stays free of any `format` import.

```ts
import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { CommandContext } from "../core/targets.ts";
import type { MessageStreamRecord } from "../core/stream-types.ts";
import type { RecordWriter, StreamOutputType } from "../core/streaming.ts";
import {
  DEFAULT_MESSAGE_FORMAT_OPTIONS,
  formatMessageRecord,
} from "./messages.ts";
import { DEFAULT_ENTRY_FORMAT_OPTIONS, formatEntry } from "./entries.ts";

// All three writers store the context the same way StdoutJsonlWriter does
// today (explicit `private readonly context: CommandContext;` field assigned in
// a `constructor(context: CommandContext)`), matching existing codebase style.

export class StdoutJsonlWriter implements RecordWriter {
  // moved verbatim from core/streaming.ts: JSON.stringify(record) + "\n"
}

export class FormattedMessageWriter implements RecordWriter {
  private readonly context: CommandContext;
  constructor(context: CommandContext) {
    this.context = context;
  }
  writeRecord(record: unknown): void {
    const r = record as MessageStreamRecord;
    const chunk = formatMessageRecord(r, DEFAULT_MESSAGE_FORMAT_OPTIONS);
    if (chunk === undefined || chunk === "") return;
    const separator = r.type === "pictl_cursor" ? "\n" : "\n\n";
    this.context.process.stdout.write(`${chunk}${separator}`);
  }
}

export class FormattedEntryWriter implements RecordWriter {
  private readonly context: CommandContext;
  constructor(context: CommandContext) {
    this.context = context;
  }
  writeRecord(record: unknown): void {
    const line = formatEntry(record as SessionEntry, DEFAULT_ENTRY_FORMAT_OPTIONS);
    this.context.process.stdout.write(`${line}\n`);
  }
}

// Explicit precedence: json forces JSONL even for messages/entries; raw is
// always JSONL. Order matters — the json/raw check must come first.
export function makeRecordWriter(
  context: CommandContext,
  type: StreamOutputType,
  json: boolean,
): RecordWriter {
  if (type === "raw" || json) return new StdoutJsonlWriter(context);
  if (type === "messages") return new FormattedMessageWriter(context);
  return new FormattedEntryWriter(context);
}
```

### `src/core/rpc-commands.ts` (`prompt`)

```ts
// promptFlags:
//  - type:    parsedFlag("Output type (messages|entries|raw)",
//             parseStreamOutputType, "type", completeChoices(STREAM_OUTPUT_TYPES))
//  - detach:  booleanFlag("Send the prompt and return immediately")
//  - json:    booleanFlag("Emit JSONL instead of formatted output")
//  - until, timeout, streamingBehavior, image: unchanged
// promptCommand: aliases: { d: "detach" }; brief drops "as JSONL".

export async function prompt(
  this: CommandContext,
  flags: PromptFlags,
  message: string,
): Promise<void> {
  if (flags.detach) {
    if (flags.until !== undefined)
      throw new UsageError("--detach cannot be combined with --until");
    if (flags.timeout !== undefined)
      throw new UsageError("--detach cannot be combined with --timeout");
    const { images } = await imagesFromFlags(flags.image);
    await promptDetached(this, {
      message: await messageFrom(this, message),
      images,
      streamingBehavior: /* steer|followUp normalization, unchanged */,
    });
    return;
  }
  const type = flags.type ?? "messages";
  const { images } = await imagesFromFlags(flags.image);
  await streamPrompt(this, {
    type,
    writer: makeRecordWriter(this, type, flags.json),
    until: flags.until ?? { kind: "turn-end" },
    timeoutMs: flags.timeout === undefined ? undefined : flags.timeout * 1000,
    message: await messageFrom(this, message),
    images,
    streamingBehavior: /* unchanged */,
  });
}
```

### `src/core/tail.ts` (`tail`)

```ts
// tailFlags: add json: booleanFlag("Emit JSONL instead of formatted output").
// type/since/n/follow/until/timeout unchanged. Brief and header comment drop
// "JSONL".

export async function tail(this: CommandContext, flags: TailFlags): Promise<void> {
  const outputType: StreamOutputType = flags.type ?? "messages";
  if (outputType === "raw" && flags.n !== undefined) {
    throw new UsageError("-n is not supported with --type raw");
  }
  await streamTail(this, {
    outputType,
    writer: makeRecordWriter(this, outputType, flags.json),
    since: flags.since,
    limit: flags.n,
    until: normalizeFollowUntil({ follow: flags.follow, until: flags.until }),
    timeoutMs: flags.timeout === undefined ? undefined : flags.timeout * 1000,
  });
}
```

### `src/core/index.ts`

Drop `parsePromptType`, `PROMPT_TYPES`, `PromptType` from the re-exports. Add
the core-owned `RecordWriter` interface and `promptDetached`. Do **not**
re-export `makeRecordWriter` here — `core/index.ts` stays format-free. SDK
consumers that call `streamPrompt`/`streamTail` either implement `RecordWriter`
themselves or import `makeRecordWriter` from the `format` surface.

## Edge cases

- **Cursor-only finite stream** (no history, no new messages): records `[cursor]`
  render to `[cursor: X]\n` in both batch and streaming form. ✓
- **Empty-rendering records**: a message that formats to `""`/`undefined` is
  skipped (no text, no separator) in both batch and streaming form. ✓
- **`--type raw` + `--json`**: `--json` is a no-op (raw is already JSON). Not an
  error.
- **`--type raw` + `-n`** (tail): unchanged error ("-n is not supported with
  --type raw").
- **`--type raw` + `--since`** (tail): unchanged error, raised inside
  `streamTail` ("--since is not supported with --type raw").
- **`--detach` + `--type`/`--json`**: silently ignored (no output to shape).
- **`--detach` + `--until`/`--timeout`**: error.
- **Entries never emit a cursor**: `formatEntry` output (one line per entry) is
  unaffected by the cursor-separator rule; entries match `pictl format entries`
  exactly.

## Non-goals

- Exposing message/entry formatting options (`--tool-results`, `--width`,
  `--timestamps`, `--filter`, etc.) directly on `prompt`/`tail`. Use
  `--json | pictl format …`.
- Changing the `pictl format` subcommands.
- Changing the streaming protocol, cursor semantics, or `--until`/`--follow`
  behavior.
- Adding a short flag for `--json` (long-only).
- Byte-exact trailing-newline parity for infinite (`killed`) streams (not a
  meaningful concept; they terminate by throwing).

## Success criteria

1. `pictl prompt "…"` and `pictl tail` print human-readable formatted output by
   default.
2. `--json` reproduces today's JSONL output exactly for `messages`, `entries`,
   and `raw`.
3. For a finite `messages` stream, default output is byte-identical to
   `<that stream> --json | pictl format messages`.
4. For an `entries` stream, default output is byte-identical to
   `<that stream> --json | pictl format entries`.
5. `pictl prompt -d "…"` sends the prompt and returns immediately with no
   streamed output; `--detach` with `--until`/`--timeout` errors.
6. No `core` module imports `src/format/` except the two command modules
   (`rpc-commands.ts`, `tail.ts`). In particular, neither `core/streaming.ts`
   (the streaming engine) nor `core/index.ts` (the public SDK surface) imports
   `format`.
7. `npm run check`, `npm run lint`, `npm test` all pass.

# IMPLEMENTATION IDEAS

## Dependency inversion (the core design choice)

The naive implementation imports `formatMessageRecord`/`formatEntry` directly
into `core/streaming.ts` and branches on `type`+`json` there. That puts a
`core → format` edge in the reusable streaming engine — the lower-level piece a
future SDK would consume — which inverts the intended layering (`format` renders
`core`'s data, so `format` should depend on `core`, not vice versa).

Instead we invert: `core/streaming.ts` owns only the `RecordWriter` *interface*
and accepts a writer as a parameter. The concrete writers and the
`type`+`json` → writer factory live in `src/format/record-writer.ts` (which may
legally depend on `core`). The command functions `prompt` and `tail` are the
composition root: they call `makeRecordWriter` and inject the result. `--json`
is consumed entirely in the command layer and never reaches the engine.

The `core → format` import then lands only in `rpc-commands.ts` and `tail.ts`
(command modules / composition root) — never in the streaming engine
(`core/streaming.ts`) nor the public SDK surface (`core/index.ts`), both of
which stay format-free. No import cycle results: `format/record-writer.ts`
imports from `core/streaming.ts`, `core/targets.ts`, `core/stream-types.ts`,
`format/messages.ts`, `format/entries.ts`; none of those import
`format/record-writer.ts`.

## Separating detach from streaming

Detach short-circuits before any streaming, so a required-but-unused `writer`
in `PromptStreamOptions` would be a smell. Splitting it into a dedicated
`promptDetached` keeps each unit single-purpose and lets `streamPrompt` always
require a writer. `buildPromptCommand` removes the duplication of the pi
`prompt` RpcCommand construction between the two paths.

## Writer separators

- `FormattedMessageWriter`: `"\n\n"` after message/control, `"\n"` after
  `pictl_cursor`. Stateless; achieves exact `pictl format messages` parity for
  finite streams because they always end in exactly one cursor record written
  last.
- `FormattedEntryWriter`: `"\n"` after each entry, matching
  `formatEntryJsonl`'s `lines.join("\n") + "\n"`.
- `StdoutJsonlWriter`: `JSON.stringify(record) + "\n"` (moved verbatim).

## Tests (`src/core/streaming.test.ts`)

Update existing tests whose default changed:

- "prompt streams assistant response and final cursor": add `--json` to keep
  asserting the JSONL records + cursor.
- "prompt entries stream only includes entry records": add `--json` (still
  asserting JSON record shape).
- detach validation tests: switch `--type detach` → `--detach`; update expected
  error strings to "--detach cannot be combined with --timeout/--until".

Add:

- `prompt` with no flags → formatted text (not JSON; ends with `[cursor: …]\n`).
- `prompt --type entries` (no `--json`) → formatted entry lines (id + role).
- `tail` default → formatted messages.
- `tail --type entries` default → formatted entries.
- `prompt -d` → returns immediately, prompt RPC sent, no streamed output.
- Parity check: a finite `messages` stream's default output equals its `--json`
  output piped through `formatMessageRecords` (assert byte-equality).

Optionally a small unit test for `makeRecordWriter` selection.

## Docs

- README `## pictl format, pictl tail` section (currently `TODO: explain
  these`): explain that `prompt`/`tail` print formatted output by default; that
  `--json` emits `messages`/`entries`/`raw` JSONL for piping into
  `pictl format messages|entries|tree`; document `pictl prompt -d/--detach` and
  `pictl tail --since`.
- `prompt` brief: drop "as JSONL".
- `tail` brief and header comment: drop "JSONL".
- `--type` help string on `prompt`: `(messages|entries|raw)`.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks,
mark completed ones with [x], document decisions and problems encountered.

### 2026-06-25 — spec drafted + fresh-context review

Drafted the spec; ran a fresh-context adversarial review (pictl reviewer agent).
Applied its precision fixes: explicit `makeRecordWriter` if-else (no ambiguous
branch table), constructors on the formatted writers, parity wording scoped to
`--type messages` with default options, the `tail` `until === undefined` cursor
path named explicitly, and the `core → format` edge list corrected to include
`core/index.ts`. The race / `formatControl`-default concerns it raised are
pre-existing and don't change with this work; flagged for the test pass.

**RESOLVED (owner, 2026-06-25)**: Keep `core/index.ts` format-free. It exports
the core-owned `RecordWriter` interface and `promptDetached`, but **not**
`makeRecordWriter`. The `core → format` edge is confined to the two command
modules (`rpc-commands.ts`, `tail.ts`). SDK consumers import `makeRecordWriter`
from the `format` surface.

### Tasks

- [x] `core/streaming.ts`: remove `PROMPT_TYPES`/`PromptType`/`parsePromptType`;
      rename `JsonlWriter` → `RecordWriter` (export); remove `StdoutJsonlWriter`
      and internal writer construction; add `writer` to `PromptStreamOptions` and
      `StreamOptions`; change `PromptStreamOptions.type` to `StreamOutputType`;
      add `buildPromptCommand`; add `promptDetached`; drop the detach branch in
      `streamPrompt`.
- [x] `src/format/record-writer.ts`: `StdoutJsonlWriter` (moved),
      `FormattedMessageWriter`, `FormattedEntryWriter`, `makeRecordWriter`.
- [x] `core/rpc-commands.ts`: `prompt` flags (`--type` values, `-d/--detach`,
      `--json`), detach branch, `makeRecordWriter` injection, brief.
- [x] `core/tail.ts`: `--json` flag, `makeRecordWriter` injection, brief/comment.
- [x] `core/index.ts`: drop `parsePromptType`/`PROMPT_TYPES`/`PromptType`; add
      `RecordWriter`, `promptDetached` (stays format-free — no
      `makeRecordWriter` re-export).
- [x] Tests: update changed-default tests; add formatted/detach/parity tests.
- [x] Docs: README section; briefs; `--type` help string.
- [x] `npm run check && npm run lint && npm test` green.

### 2026-06-25 — implemented

All tasks complete; `npm run check`, `npm run lint`, `npm test` (56/56) green.

Notes from implementation (matched the spec; no design changes):

- `streamPrompt`/`streamTail` now read `options.writer`; `buildPromptCommand`
  de-duplicates the pi `prompt` RpcCommand construction shared with
  `promptDetached`.
- The `--detach` validation moved ahead of the `--type` branch in `prompt`, and
  `streamingBehavior` normalization was hoisted so both the detach and stream
  paths reuse it.
- Test harness gained a `get_messages` handler on the fake pi socket — the prior
  tests only exercised `prompt` (which uses message events), but the new
  `tail` default-messages test drains historical messages via `get_messages`.
- Added a byte-equality parity test: `prompt`'s default formatted output equals
  its `--json` output parsed and run through `formatMessageRecords`.
