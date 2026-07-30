/*
 * RecordWriter implementations and the `type`+`json` → writer factory. This is
 * the composition seam between the format and streaming layers: it legally
 * depends on `core` (format renders core's data), so the streaming engine can
 * stay free of any `format` import and accept an injected writer instead.
 */

import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { CommandContext } from "../core/targets.ts";
import type { MessageStreamRecord } from "../core/streaming/types.ts";
import type {
  RecordWriter,
  StreamOutputType,
} from "../core/streaming/stream.ts";
import { MessageFormatter } from "./messages.ts";
import { DEFAULT_ENTRY_FORMAT_OPTIONS, formatEntry } from "./entries.ts";
import { formatEvent } from "./events.ts";
import type { EventStreamRecord } from "./input.ts";

export class StdoutJsonlWriter implements RecordWriter {
  private readonly context: CommandContext;

  constructor(context: CommandContext) {
    this.context = context;
  }

  writeRecord(record: unknown): void {
    this.context.process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  end(): void {}
}

/**
 * Renders message records the same way `pictl format messages` does: both
 * paths flow through one `MessageFormatter`, so byte-equality between them is
 * structural.
 */
export class FormattedMessageWriter implements RecordWriter {
  private readonly context: CommandContext;
  private readonly formatter = new MessageFormatter();

  constructor(context: CommandContext) {
    this.context = context;
  }

  writeRecord(record: unknown): void {
    this.write(this.formatter.push(record as MessageStreamRecord));
  }

  end(): void {
    this.write(this.formatter.end());
  }

  private write(chunk: string): void {
    if (chunk !== "") {
      this.context.process.stdout.write(chunk);
    }
  }
}

export class FormattedEntryWriter implements RecordWriter {
  private readonly context: CommandContext;

  constructor(context: CommandContext) {
    this.context = context;
  }

  writeRecord(record: unknown): void {
    const line = formatEntry(
      record as SessionEntry,
      DEFAULT_ENTRY_FORMAT_OPTIONS,
    );
    this.context.process.stdout.write(`${line}\n`);
  }

  end(): void {}
}

export class FormattedEventWriter implements RecordWriter {
  private readonly context: CommandContext;

  constructor(context: CommandContext) {
    this.context = context;
  }

  writeRecord(record: unknown): void {
    this.context.process.stdout.write(
      `${formatEvent(record as EventStreamRecord)}\n`,
    );
  }

  end(): void {}
}

/** Selects the writer for a stream: `--json` forces JSONL, each type
 *  otherwise gets its formatted writer. */
export function makeRecordWriter(
  context: CommandContext,
  type: StreamOutputType,
  json: boolean,
): RecordWriter {
  if (json) {
    return new StdoutJsonlWriter(context);
  }
  switch (type) {
    case "messages":
      return new FormattedMessageWriter(context);
    case "entries":
      return new FormattedEntryWriter(context);
    case "events":
      return new FormattedEventWriter(context);
  }
}
