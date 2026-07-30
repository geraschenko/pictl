import { buildRouteMap, type RouteMap } from "@stricli/core";
import {
  booleanFlag,
  commandNoTarget,
  enumFlag,
  parsedFlag,
  stringArg,
  type InferFlags,
} from "../core/cli.ts";
import { readInputFile } from "../core/read-input.ts";
import type { CommandContext } from "../core/targets.ts";
import { UsageError } from "../core/util.ts";
import { entryFormatOptions, formatFilteredEntry } from "./entries.ts";
import { FILTER_MODES } from "./filter.ts";
import { formatEvent } from "./events.ts";
import {
  decodeFormatInput,
  entriesOf,
  eventsOf,
  inputChunks,
  messageRecordsOf,
  parseEntriesInput,
} from "./input.ts";
import { MessageFormatter } from "./messages.ts";
import { formatEntriesTree } from "./tree.ts";
import type { EntriesInput } from "./types.ts";

function isEntriesInput(
  input: EntriesInput | readonly unknown[],
): input is EntriesInput {
  return !Array.isArray(input);
}

const formatMessagesFlags = {
  toolResults: enumFlag("Tool result display (summary|none|full)", [
    "summary",
    "none",
    "full",
  ]),
  maxToolArgChars: parsedFlag(
    "Maximum tool argument characters",
    parsePositiveInteger,
    "num",
  ),
  maxErrorLines: parsedFlag(
    "Maximum failed tool result snippet lines",
    parsePositiveInteger,
    "num",
  ),
};
type FormatMessagesFlags = InferFlags<typeof formatMessagesFlags>;

function writeChunk(context: CommandContext, chunk: string): void {
  if (chunk !== "") {
    context.process.stdout.write(chunk);
  }
}

export async function formatMessages(
  this: CommandContext,
  flags: FormatMessagesFlags,
  file?: string,
): Promise<void> {
  const input = await decodeFormatInput(inputChunks(this, file));
  const formatter = new MessageFormatter({
    toolResults: flags.toolResults,
    maxToolArgChars: flags.maxToolArgChars,
    maxErrorLines: flags.maxErrorLines,
  });
  for await (const record of messageRecordsOf(input)) {
    writeChunk(this, formatter.push(record));
  }
  writeChunk(this, formatter.end());
}

const formatMessagesCommand = commandNoTarget<
  FormatMessagesFlags,
  [string | undefined]
>({
  common: true,
  docs: { brief: "format pictl message JSONL" },
  parameters: {
    flags: formatMessagesFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatMessages,
});

const formatEntriesFlags = {
  timestamps: booleanFlag("Show timestamps"),
  full: booleanFlag("Show full entry details"),
  filter: enumFlag("Entry filter", FILTER_MODES),
  width: parsedFlag("Output width", parsePositiveInteger, "num"),
};
type FormatEntriesFlags = InferFlags<typeof formatEntriesFlags>;

export async function formatEntries(
  this: CommandContext,
  flags: FormatEntriesFlags,
  file?: string,
): Promise<void> {
  const { records, leafId } = entriesOf(
    await decodeFormatInput(inputChunks(this, file)),
  );
  const options = entryFormatOptions(flags);
  for await (const entry of records) {
    const line = formatFilteredEntry(entry, leafId, options);
    if (line !== undefined) {
      this.process.stdout.write(`${line}\n`);
    }
  }
}

const formatEntriesCommand = commandNoTarget<
  FormatEntriesFlags,
  [string | undefined]
>({
  common: true,
  docs: { brief: "format pictl entries JSON or JSONL" },
  parameters: {
    flags: formatEntriesFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatEntries,
});

const formatEventsFlags = {};
type FormatEventsFlags = InferFlags<typeof formatEventsFlags>;

export async function formatEvents(
  this: CommandContext,
  _flags: FormatEventsFlags,
  file?: string,
): Promise<void> {
  const input = await decodeFormatInput(inputChunks(this, file));
  for await (const event of eventsOf(input)) {
    this.process.stdout.write(`${formatEvent(event)}\n`);
  }
}

const formatEventsCommand = commandNoTarget<
  FormatEventsFlags,
  [string | undefined]
>({
  common: true,
  docs: { brief: "format pictl event JSONL" },
  parameters: {
    flags: formatEventsFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatEvents,
});

const formatTreeFlags = {
  filter: enumFlag("Tree filter", FILTER_MODES),
  width: parsedFlag("Output width", parsePositiveInteger, "num"),
};
type FormatTreeFlags = InferFlags<typeof formatTreeFlags>;

export async function formatTree(
  this: CommandContext,
  flags: FormatTreeFlags,
  file?: string,
): Promise<void> {
  const input = parseEntriesInput(await readInputFile(this, file));
  this.process.stdout.write(
    formatEntriesTree(isEntriesInput(input) ? input : { entries: input }, {
      filter: flags.filter,
      width: flags.width,
    }),
  );
}

const formatTreeCommand = commandNoTarget<
  FormatTreeFlags,
  [string | undefined]
>({
  common: true,
  docs: { brief: "format pictl get-entries output or entry JSONL as a tree" },
  parameters: {
    flags: formatTreeFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatTree,
});

export function parsePositiveInteger(input: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`invalid positive integer value: ${input}`);
  }
  return value;
}

export const formatRoute: RouteMap<CommandContext> & {
  readonly common?: true;
} = Object.assign(
  buildRouteMap({
    routes: {
      messages: formatMessagesCommand,
      entries: formatEntriesCommand,
      events: formatEventsCommand,
      tree: formatTreeCommand,
    },
    docs: { brief: "Format pictl JSON/JSONL output" },
  }),
  { common: true as const },
);
