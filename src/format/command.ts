import { buildRouteMap, type RouteMap } from "@stricli/core";
import {
  booleanFlag,
  commandNoTarget,
  enumFlag,
  parsedFlag,
  stringArg,
  type InferFlags,
} from "../core/cli.ts";
import type { CommandContext } from "../core/targets.ts";
import { UsageError } from "../core/util.ts";
import { formatEntriesInput, formatEntryJsonl } from "./entries.ts";
import {
  parseEntriesInput,
  parseMessageRecords,
  parseTreeInput,
  readInputFile,
} from "./input.ts";
import { formatMessageRecords } from "./messages.ts";
import { formatTreeInput } from "./tree.ts";
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

export async function formatMessages(
  this: CommandContext,
  flags: FormatMessagesFlags,
  file?: string,
): Promise<void> {
  const input = await readInputFile(this, file);
  this.process.stdout.write(
    formatMessageRecords(parseMessageRecords(input), {
      toolResults: flags.toolResults,
      maxToolArgChars: flags.maxToolArgChars,
      maxErrorLines: flags.maxErrorLines,
    }),
  );
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
};
type FormatEntriesFlags = InferFlags<typeof formatEntriesFlags>;

export async function formatEntries(
  this: CommandContext,
  flags: FormatEntriesFlags,
  file?: string,
): Promise<void> {
  const input = parseEntriesInput(await readInputFile(this, file));
  this.process.stdout.write(
    isEntriesInput(input)
      ? formatEntriesInput(input, flags)
      : formatEntryJsonl(input, flags),
  );
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

const formatTreeFlags = {
  filter: enumFlag("Tree filter", [
    "conversation",
    "pi-default",
    "pi-no-tools",
    "pi-user-only",
    "pi-labeled-only",
    "pi-all",
  ]),
  width: parsedFlag("Output width", parsePositiveInteger, "num"),
};
type FormatTreeFlags = InferFlags<typeof formatTreeFlags>;

export async function formatTree(
  this: CommandContext,
  flags: FormatTreeFlags,
  file?: string,
): Promise<void> {
  const input = parseTreeInput(await readInputFile(this, file));
  this.process.stdout.write(
    formatTreeInput(input, {
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
  docs: { brief: "format pictl tree JSON" },
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
      tree: formatTreeCommand,
    },
    docs: { brief: "Format raw pictl output" },
  }),
  { common: true as const },
);
