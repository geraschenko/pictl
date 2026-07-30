/**
 * `format` input decoding. The streaming path (`decodeFormatInput`) classifies
 * a stream from its first complete record, then validates and yields records
 * lazily so subcommands can render a live pipe as it flows; only the finite
 * document forms (get-entries/get-messages output) are buffered whole.
 * Mismatched input fails with a cross-pointing UsageError, so a swapped pipe
 * is a one-line fix instead of silence. `format tree` keeps the whole-input
 * `parseEntriesInput` (tree layout needs every entry).
 */

import { createReadStream } from "node:fs";
import type {
  RpcSocketBroadcastEvent,
  SessionEntry,
} from "@geraschenko/pi-coding-agent";
import { LineReader, type Line } from "../core/line-reader.ts";
import { parseJsonlInput } from "../core/read-input.ts";
import {
  EntryMessageRecordProjector,
  EventMessageRecordProjector,
} from "../core/streaming/message-records.ts";
import type {
  MessageStreamRecord,
  StreamCursorRecord,
} from "../core/streaming/types.ts";
import type { CommandContext } from "../core/targets.ts";
import { isRecord, UsageError } from "../core/util.ts";
import type { EntriesInput } from "./types.ts";

const MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);
const ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const CONTROL_KINDS = new Set([
  "compaction",
  "tree_navigated",
  "session_changed",
  "queue_update",
  "model_changed",
]);
const MESSAGE_RECORD_TYPES = new Set(["message", "control"]);

/** Runtime mirror of `RpcSocketBroadcastEvent["type"]`; the Record type makes
 *  tsc enforce exact agreement with the pi union. Only a stream's first
 *  record is checked against this list — later records in an events stream
 *  need only a `type` outside the entry/message space, so event types newer
 *  than this pictl are not rejected mid-stream. */
const EVENT_TYPE_MARKERS: Record<RpcSocketBroadcastEvent["type"], true> = {
  agent_start: true,
  agent_end: true,
  agent_settled: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  bash_execution_update: true,
  queue_update: true,
  compaction_start: true,
  compaction_end: true,
  entry_appended: true,
  model_changed: true,
  steering_mode_changed: true,
  follow_up_mode_changed: true,
  auto_compaction_changed: true,
  tree_navigated: true,
  session_info_changed: true,
  thinking_level_changed: true,
  auto_retry_start: true,
  auto_retry_end: true,
  summarization_retry_scheduled: true,
  summarization_retry_attempt_start: true,
  summarization_retry_finished: true,
  ui_wait_start: true,
  ui_wait_end: true,
  session_changed: true,
  extension_error: true,
};
const EVENT_TYPES = new Set<string>(Object.keys(EVENT_TYPE_MARKERS));

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function describeValue(value: unknown): string {
  const json = JSON.stringify(value);
  return `${typeof value}${json === undefined ? "" : ` ${json}`}`;
}

function requireString(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "string") {
    throw new UsageError(
      `invalid session entry: expected string ${key}, got ${describeValue(record[key])}`,
    );
  }
}

function requireNumber(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "number") {
    throw new UsageError(
      `invalid session entry: expected number ${key}, got ${describeValue(record[key])}`,
    );
  }
}

function requireBoolean(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "boolean") {
    throw new UsageError(
      `invalid session entry: expected boolean ${key}, got ${describeValue(record[key])}`,
    );
  }
}

// Persisted session files are parsed without validation, so old versions,
// forks, or hand-edited files may contain null/missing content. Pi normalizes
// these entries in packages/coding-agent/src/core/session-manager.ts's
// sessionEntryToContextMessages; get-entries formatting must reach that
// canonical conversion rather than rejecting the entry first.
function validateMessage(value: unknown, allowLegacyNullContent = false): void {
  if (!isRecord(value) || typeof value.role !== "string") {
    throw new UsageError("invalid session entry: invalid message");
  }
  if (!MESSAGE_ROLES.has(value.role)) {
    throw new UsageError(
      `invalid session entry: invalid message role ${value.role}`,
    );
  }
  switch (value.role) {
    case "user":
      if (allowLegacyNullContent && value.content == null) {
        break;
      }
      if (
        !(typeof value.content === "string" || Array.isArray(value.content))
      ) {
        throw new UsageError("invalid session entry: invalid user content");
      }
      break;
    case "assistant":
      if (allowLegacyNullContent && value.content == null) {
        break;
      }
      if (!Array.isArray(value.content)) {
        throw new UsageError(
          "invalid session entry: invalid assistant content",
        );
      }
      break;
    case "toolResult":
      requireString(value, "toolName");
      requireBoolean(value, "isError");
      if (allowLegacyNullContent && value.content == null) {
        break;
      }
      if (!Array.isArray(value.content)) {
        throw new UsageError(
          "invalid session entry: invalid tool result content",
        );
      }
      break;
    case "bashExecution":
      requireString(value, "command");
      requireBoolean(value, "cancelled");
      requireBoolean(value, "truncated");
      break;
    case "custom":
      requireString(value, "customType");
      break;
    case "branchSummary":
      requireString(value, "summary");
      requireString(value, "fromId");
      break;
    case "compactionSummary":
      requireString(value, "summary");
      requireNumber(value, "tokensBefore");
      break;
  }
}

function validateSessionEntryRecord(record: Record<string, unknown>): void {
  requireString(record, "id");
  requireString(record, "timestamp");
  if (!isStringOrNull(record.parentId)) {
    throw new UsageError(
      "invalid session entry: expected string|null parentId",
    );
  }
  if (typeof record.type !== "string" || !ENTRY_TYPES.has(record.type)) {
    throw new UsageError("invalid session entry");
  }

  switch (record.type) {
    case "message":
      validateMessage(record.message, true);
      break;
    case "thinking_level_change":
      requireString(record, "thinkingLevel");
      break;
    case "model_change":
      requireString(record, "provider");
      requireString(record, "modelId");
      break;
    case "compaction":
      requireString(record, "summary");
      requireString(record, "firstKeptEntryId");
      requireNumber(record, "tokensBefore");
      break;
    case "branch_summary":
      requireString(record, "fromId");
      requireString(record, "summary");
      break;
    case "custom":
      requireString(record, "customType");
      break;
    case "custom_message":
      requireString(record, "customType");
      if (
        !(
          record.content == null ||
          typeof record.content === "string" ||
          Array.isArray(record.content)
        )
      ) {
        throw new UsageError(
          "invalid session entry: invalid custom message content",
        );
      }
      requireBoolean(record, "display");
      break;
    case "label":
      requireString(record, "targetId");
      if (!(typeof record.label === "string" || record.label === undefined)) {
        throw new UsageError("invalid session entry: invalid label");
      }
      break;
    case "session_info":
      if (!(typeof record.name === "string" || record.name === undefined)) {
        throw new UsageError("invalid session entry: invalid session name");
      }
      break;
  }
}

export function decodeMessageStreamRecord(value: unknown): MessageStreamRecord {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new UsageError("invalid message stream record");
  }
  if (value.type === "message") {
    validateMessage(value.message);
    return value as unknown as MessageStreamRecord;
  }
  if (value.type === "control" && isRecord(value.control)) {
    if (
      typeof value.control.kind === "string" &&
      CONTROL_KINDS.has(value.control.kind) &&
      isRecord(value.control.event)
    ) {
      return value as unknown as MessageStreamRecord;
    }
  }
  if (
    value.type === "pictl_cursor" &&
    isStringOrNull(value.sessionId) &&
    isStringOrNull(value.entryId)
  ) {
    return value as unknown as MessageStreamRecord;
  }
  throw new UsageError("invalid message stream record");
}

export function decodeSessionEntry(value: unknown): SessionEntry {
  if (!isRecord(value)) {
    throw new UsageError("invalid session entry");
  }
  validateSessionEntryRecord(value);
  return value as unknown as SessionEntry;
}

export function decodeEntriesInput(value: unknown): EntriesInput {
  if (isRecord(value) && Array.isArray(value.entries)) {
    if ("leafId" in value && !isStringOrNull(value.leafId)) {
      throw new UsageError("invalid entries input: invalid leafId");
    }
    return {
      entries: value.entries.map(decodeSessionEntry),
      leafId: isStringOrNull(value.leafId) ? value.leafId : undefined,
    };
  }
  throw new UsageError("invalid entries input");
}

export function parseEntriesInput(
  input: string,
): EntriesInput | readonly SessionEntry[] {
  if (input.trim() === "") {
    return [];
  }
  const trimmed = input.trimStart();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      parsed = undefined; // Not a single JSON object; parse below as JSONL.
    }
    if (isRecord(parsed)) {
      if ("entries" in parsed) {
        return decodeEntriesInput(parsed);
      }
      if (Array.isArray(parsed.tree)) {
        throw new UsageError(
          "input looks like get-tree output; feed it get-entries output instead",
        );
      }
    }
  }
  return parseJsonlInput(input).map(decodeSessionEntry);
}

function decodeMessagesInput(
  value: Record<string, unknown>,
): readonly MessageStreamRecord[] {
  if (!Array.isArray(value.messages)) {
    throw new UsageError("invalid messages input");
  }
  return value.messages.map((message) => {
    validateMessage(message);
    return { type: "message", message } as unknown as MessageStreamRecord;
  });
}

/** What an events stream yields: socket events plus the `pictl_cursor`
 *  records a finite `tail --json` run appends. */
export type EventStreamRecord = RpcSocketBroadcastEvent | StreamCursorRecord;

export type FormatInput =
  | Readonly<{
      kind: "entries";
      records: AsyncIterable<SessionEntry>;
      /** The filter anchor; null for JSONL input and leafless documents. */
      leafId: string | null;
    }>
  | Readonly<{ kind: "messages"; records: AsyncIterable<MessageStreamRecord> }>
  | Readonly<{ kind: "events"; records: AsyncIterable<EventStreamRecord> }>
  /** No complete record before EOF; every subcommand emits nothing. */
  | Readonly<{ kind: "empty" }>;

/** Chunk source: stdin (file undefined or "-") or fs.createReadStream. */
export function inputChunks(
  context: CommandContext,
  file: string | undefined,
): AsyncIterable<Buffer | string> {
  if (file === undefined || file === "-") {
    return (context.process as NodeJS.Process).stdin;
  }
  return createReadStream(file);
}

type RecordShape = "entry" | "message" | "event" | "cursor" | undefined;

/** Session entries and stream records overlap on type "message"; the string
 *  `id` and `timestamp` only entries carry disambiguate. An entry type
 *  without them still classifies as an entry (so validation reports the
 *  missing field) unless it could be a stream record. Cursors get their own
 *  shape because both message and events streams contain them. "event" is
 *  any other string type — decodeFormatInput additionally gates a stream's
 *  FIRST record on EVENT_TYPES. */
function classifyRecord(value: unknown): RecordShape {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type === "pictl_cursor") {
    return "cursor";
  }
  if (ENTRY_TYPES.has(value.type)) {
    if (typeof value.id === "string" && typeof value.timestamp === "string") {
      return "entry";
    }
    return MESSAGE_RECORD_TYPES.has(value.type) ? "message" : "entry";
  }
  return MESSAGE_RECORD_TYPES.has(value.type) ? "message" : "event";
}

function crossPointer(lineNumber: number, shape: RecordShape): UsageError {
  switch (shape) {
    case "entry":
      return new UsageError(
        `record ${lineNumber} looks like session-entry output; use \`pictl format entries\``,
      );
    case "message":
    case "cursor":
      return new UsageError(
        `record ${lineNumber} looks like message output; use \`pictl format messages\``,
      );
    case "event":
      return new UsageError(
        `record ${lineNumber} looks like socket events; use \`pictl format events\``,
      );
    case undefined:
      return new UsageError(
        `record ${lineNumber} is not recognized (expected a session entry, message record, or event)`,
      );
  }
}

function parseStreamLine(line: Line): unknown {
  try {
    return JSON.parse(line.text) as unknown;
  } catch (error) {
    throw new UsageError(
      `invalid JSONL line ${line.lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function withRecordNumber<T>(line: Line, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    throw error instanceof UsageError
      ? new UsageError(`record ${line.lineNumber}: ${error.message}`)
      : error;
  }
}

async function* finishedRecords<T>(values: readonly T[]): AsyncGenerator<T> {
  yield* values;
}

async function* chunkStream(
  chunks: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
): AsyncGenerator<Buffer | string> {
  yield* chunks;
}

/** The finite document forms: get-entries output (entries + leafId),
 *  get-messages output (messages), and the get-tree cross-pointer.
 *  `failure` is what stream classification would have thrown, deferred in
 *  case the whole input is a document instead. */
function documentInput(document: unknown, failure: UsageError): FormatInput {
  if (!isRecord(document)) {
    throw failure;
  }
  if ("entries" in document) {
    const input = decodeEntriesInput(document);
    return {
      kind: "entries",
      leafId: input.leafId ?? null,
      records: finishedRecords(input.entries),
    };
  }
  if ("messages" in document) {
    return {
      kind: "messages",
      records: finishedRecords(decodeMessagesInput(document)),
    };
  }
  if (Array.isArray(document.tree)) {
    throw new UsageError(
      "input looks like get-tree output; feed it get-entries output instead",
    );
  }
  throw failure;
}

/**
 * Classifies the stream from its first complete record, then validates and
 * yields records lazily; a mid-stream record of the wrong shape throws a
 * cross-pointing UsageError naming its record number (line numbers count
 * blank lines, so they match the file). The finite document forms are
 * buffered whole and yielded as finished streams.
 */
export async function decodeFormatInput(
  chunks: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
): Promise<FormatInput> {
  const iterator = chunkStream(chunks);
  const lineReader = new LineReader();
  const queue: Line[] = [];
  let eof = false;
  /** Raw bytes consumed so far; retained for the document path's whole-input
   *  parse, dropped once the stream is classified as JSONL. */
  let rawChunks: Buffer[] | undefined = [];

  const nextLine = async (): Promise<Line | undefined> => {
    while (queue.length === 0 && !eof) {
      const result = await iterator.next();
      if (result.done === true) {
        eof = true;
        break;
      }
      const chunk =
        typeof result.value === "string"
          ? Buffer.from(result.value)
          : result.value;
      rawChunks?.push(chunk);
      queue.push(...lineReader.push(chunk));
    }
    return queue.shift();
  };

  const decodeDocument = async (failure: UsageError): Promise<FormatInput> => {
    while (!eof) {
      const result = await iterator.next();
      if (result.done === true) {
        eof = true;
        break;
      }
      rawChunks!.push(
        typeof result.value === "string"
          ? Buffer.from(result.value)
          : result.value,
      );
    }
    const text = Buffer.concat(rawChunks!).toString("utf8").trim();
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw failure;
    }
    return documentInput(document, failure);
  };

  const first = await nextLine();
  if (first === undefined) {
    // No complete line at all. A document without a trailing newline is
    // still valid input; anything else is empty (a torn final line is not a
    // record, matching LineReader semantics everywhere else).
    const tornLine = new UsageError("input has no complete record");
    try {
      return await decodeDocument(tornLine);
    } catch (error) {
      if (error === tornLine) {
        return { kind: "empty" };
      }
      throw error;
    }
  }

  let parsed: unknown;
  try {
    parsed = parseStreamLine(first);
  } catch (error) {
    // A pretty-printed document's first line (`{`) does not parse alone.
    return await decodeDocument(error as UsageError);
  }

  const shape = classifyRecord(parsed);
  const knownEventType =
    isRecord(parsed) &&
    typeof parsed.type === "string" &&
    EVENT_TYPES.has(parsed.type);
  if (shape === undefined || (shape === "event" && !knownEventType)) {
    // Could still be a one-line minified document.
    return await decodeDocument(crossPointer(first.lineNumber, undefined));
  }
  rawChunks = undefined;

  async function* records<T>(
    accepted: readonly RecordShape[],
    decodeRecord: (value: unknown, line: Line) => T,
  ): AsyncGenerator<T> {
    let line: Line | undefined = first;
    let value: unknown = parsed;
    while (line !== undefined) {
      const recordShape = classifyRecord(value);
      if (!accepted.includes(recordShape)) {
        throw crossPointer(line.lineNumber, recordShape);
      }
      yield decodeRecord(value, line);
      line = await nextLine();
      if (line !== undefined) {
        value = parseStreamLine(line);
      }
    }
  }

  switch (shape) {
    case "entry":
      return {
        kind: "entries",
        leafId: null,
        records: records(["entry"], (value, line) =>
          withRecordNumber(line, () => decodeSessionEntry(value)),
        ),
      };
    case "message":
    case "cursor":
      return {
        kind: "messages",
        records: records(["message", "cursor"], (value, line) =>
          withRecordNumber(line, () => decodeMessageStreamRecord(value)),
        ),
      };
    case "event":
      return {
        kind: "events",
        // Event payloads are rendered defensively, so structural validation
        // beyond classification would only reject events newer than this
        // pictl.
        records: records(
          ["event", "cursor"],
          (value) => value as EventStreamRecord,
        ),
      };
  }
}

/** The message-record view of a FormatInput: message streams pass through;
 *  entry and event streams are projected through EntryMessageRecordProjector
 *  and EventMessageRecordProjector — the same conversions `tail --type
 *  messages` uses. */
export function messageRecordsOf(
  input: FormatInput,
): AsyncIterable<MessageStreamRecord> {
  switch (input.kind) {
    case "messages":
      return input.records;
    case "entries":
      return projectedEntryRecords(input.records);
    case "events":
      return projectedEventRecords(input.records);
    case "empty":
      return finishedRecords([]);
  }
}

async function* projectedEntryRecords(
  entries: AsyncIterable<SessionEntry>,
): AsyncGenerator<MessageStreamRecord> {
  const projector = new EntryMessageRecordProjector();
  for await (const entry of entries) {
    yield* projector.project(entry);
  }
}

async function* projectedEventRecords(
  events: AsyncIterable<EventStreamRecord>,
): AsyncGenerator<MessageStreamRecord> {
  const projector = new EventMessageRecordProjector();
  for await (const event of events) {
    if (event.type === "pictl_cursor") {
      yield event;
    } else {
      yield* projector.project(event);
    }
  }
  yield* projector.finish();
}

export function entriesOf(input: FormatInput): {
  records: AsyncIterable<SessionEntry>;
  leafId: string | null;
} {
  switch (input.kind) {
    case "entries":
      return { records: input.records, leafId: input.leafId };
    case "messages":
      throw new UsageError(
        "input looks like message output; use `pictl format messages`",
      );
    case "events":
      throw new UsageError(
        "input looks like socket events; use `pictl format events`",
      );
    case "empty":
      return { records: finishedRecords([]), leafId: null };
  }
}

export function eventsOf(input: FormatInput): AsyncIterable<EventStreamRecord> {
  switch (input.kind) {
    case "events":
      return input.records;
    case "entries":
      throw new UsageError(
        "input looks like session-entry output; use `pictl format entries`",
      );
    case "messages":
      // A cursor-first stream classifies as messages, but a cursor-only one
      // (`tail --type events --json --timeout 0`) is legitimate events
      // output; reject only when an actual message record shows up.
      return messageCursorsOnly(input.records);
    case "empty":
      return finishedRecords([]);
  }
}

async function* messageCursorsOnly(
  records: AsyncIterable<MessageStreamRecord>,
): AsyncGenerator<EventStreamRecord> {
  for await (const record of records) {
    if (record.type !== "pictl_cursor") {
      throw new UsageError(
        "input looks like message output; use `pictl format messages`",
      );
    }
    yield record;
  }
}
