/*
 * RecordWriter implementations and the `type`+`json` → writer factory. This is
 * the composition seam between the format and streaming layers: it legally
 * depends on `core` (format renders core's data), so the streaming engine can
 * stay free of any `format` import and accept an injected writer instead.
 */

import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { CommandContext } from "../core/targets.ts";
import type { MessageStreamRecord } from "../core/stream-types.ts";
import type { RecordWriter, StreamOutputType } from "../core/streaming.ts";
import {
  DEFAULT_MESSAGE_FORMAT_OPTIONS,
  formatMessageRecord,
} from "./messages.ts";
import { DEFAULT_ENTRY_FORMAT_OPTIONS, formatEntry } from "./entries.ts";

export class StdoutJsonlWriter implements RecordWriter {
  private readonly context: CommandContext;

  constructor(context: CommandContext) {
    this.context = context;
  }

  writeRecord(record: unknown): void {
    this.context.process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

/**
 * Renders message records the same way `pictl format messages` does. The
 * separators (`"\n\n"` after message/control, `"\n"` after a `pictl_cursor`)
 * make a finite stream byte-identical to `formatMessageRecords`, which always
 * ends in exactly one cursor.
 */
export class FormattedMessageWriter implements RecordWriter {
  private readonly context: CommandContext;

  constructor(context: CommandContext) {
    this.context = context;
  }

  writeRecord(record: unknown): void {
    const messageRecord = record as MessageStreamRecord;
    const chunk = formatMessageRecord(
      messageRecord,
      DEFAULT_MESSAGE_FORMAT_OPTIONS,
    );
    if (chunk === undefined || chunk === "") {
      return;
    }
    const separator = messageRecord.type === "pictl_cursor" ? "\n" : "\n\n";
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

/**
 * Selects the writer for a stream. `--json` (and raw, which is inherently JSON)
 * force JSONL; the json/raw check must come first so `(messages, json)` routes
 * to JSONL rather than the formatted writer.
 */
export function makeRecordWriter(
  context: CommandContext,
  type: StreamOutputType,
  json: boolean,
): RecordWriter {
  if (type === "raw" || json) {
    return new StdoutJsonlWriter(context);
  }
  if (type === "messages") {
    return new FormattedMessageWriter(context);
  }
  return new FormattedEntryWriter(context);
}
