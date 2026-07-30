import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { AgentMessage } from "../core/streaming/types.ts";
import { passesFilter } from "./filter.ts";
import type { EntriesInput, EntryFormatOptions } from "./types.ts";
import {
  contentBlocks,
  countLines,
  extractTextContent,
  hasContentBlock,
  oneLine,
  summarizeUnknown,
  truncateText,
} from "./text.ts";
import { DEFAULT_FORMAT_WIDTH } from "../core/constants.ts";
import { isRecord } from "../core/util.ts";

export const DEFAULT_ENTRY_FORMAT_OPTIONS: EntryFormatOptions = {
  timestamps: false,
  full: false,
  filter: undefined,
  width: DEFAULT_FORMAT_WIDTH,
};

function roleLabel(entry: SessionEntry): string {
  if (entry.type === "message") {
    return entry.message.role;
  }
  return entry.type;
}

function formatToolCall(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name : "unknown";
  return `[tool: ${name}]`;
}

export function entryFormatOptions(
  options: Partial<EntryFormatOptions> | undefined,
): EntryFormatOptions {
  return {
    timestamps: options?.timestamps ?? DEFAULT_ENTRY_FORMAT_OPTIONS.timestamps,
    full: options?.full ?? DEFAULT_ENTRY_FORMAT_OPTIONS.full,
    filter: options?.filter ?? DEFAULT_ENTRY_FORMAT_OPTIONS.filter,
    width: options?.width ?? DEFAULT_ENTRY_FORMAT_OPTIONS.width,
  };
}

export function rawMessageSummary(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      return oneLine(extractTextContent(message.content));
    case "assistant": {
      const text = extractTextContent(message.content);
      const parts: string[] = [];
      if (hasContentBlock(message.content, "thinking")) {
        parts.push("[thinking]");
      }
      for (const block of contentBlocks(message.content)) {
        if (isRecord(block) && block.type === "toolCall") {
          parts.push(formatToolCall(block));
        }
      }
      if (text.trim() !== "") {
        parts.push(oneLine(text));
      } else if (message.stopReason === "aborted") {
        parts.push("(aborted)");
      } else if (message.errorMessage !== undefined) {
        parts.push(oneLine(message.errorMessage));
      }
      return parts.join(" ") || "(no content)";
    }
    case "toolResult": {
      const text = extractTextContent(message.content);
      const status = message.isError ? "error" : "ok";
      return `${message.toolName} ${status}, ${countLines(text)} lines, ${Buffer.byteLength(text, "utf8")} bytes`;
    }
    case "bashExecution":
      return `[bash] ${oneLine(message.command)}`;
    case "custom":
      return `[custom:${message.customType}] ${oneLine(extractTextContent(message.content))}`;
    case "branchSummary":
      return oneLine(message.summary);
    case "compactionSummary":
      return oneLine(message.summary);
  }
}

function rawEntrySummary(entry: SessionEntry, maxChars: number): string {
  switch (entry.type) {
    case "message":
      return rawMessageSummary(entry.message);
    case "thinking_level_change":
      return entry.thinkingLevel;
    case "model_change":
      return `${entry.provider}/${entry.modelId}`;
    case "compaction":
      return `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`;
    case "branch_summary":
      return `${entry.fromId}: ${oneLine(entry.summary)}`;
    case "custom":
      return `${entry.customType}${entry.data === undefined ? "" : ` ${summarizeUnknown(entry.data, maxChars)}`}`;
    case "custom_message":
      return `[${entry.customType}] ${oneLine(extractTextContent(entry.content))}`;
    case "label":
      return `${entry.targetId}: ${entry.label ?? "(cleared)"}`;
    case "session_info":
      return entry.name ?? "(empty title)";
  }
}

export function summarizeEntry(
  entry: SessionEntry,
  maxChars = DEFAULT_FORMAT_WIDTH,
): string {
  return truncateText(rawEntrySummary(entry, maxChars), maxChars);
}

/** The entry's rendered line, or undefined when the filter drops it. Serves
 *  both the buffered document path and the streaming per-record path. */
export function formatFilteredEntry(
  entry: SessionEntry,
  leafId: string | null,
  options: EntryFormatOptions,
): string | undefined {
  if (
    options.filter !== undefined &&
    !passesFilter({ entry }, leafId, options.filter)
  ) {
    return undefined;
  }
  return formatEntry(entry, options);
}

export function formatEntriesInput(
  input: EntriesInput,
  options?: Partial<EntryFormatOptions>,
): string {
  const fullOptions = entryFormatOptions(options);
  const lines = input.entries
    .map((entry) =>
      formatFilteredEntry(entry, input.leafId ?? null, fullOptions),
    )
    .filter((line): line is string => line !== undefined);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function formatEntry(
  entry: SessionEntry,
  options: EntryFormatOptions,
): string {
  const prefixFields = [entry.id, roleLabel(entry).padEnd(10)];
  if (options.timestamps) {
    prefixFields.unshift(entry.timestamp);
  }
  const prefix = `${prefixFields.join(" ")} `;
  const fullSuffix = options.full ? ` ${JSON.stringify(entry)}` : "";
  const availableSummary = Math.max(
    0,
    options.width - [...prefix].length - [...fullSuffix].length,
  );
  return `${prefix}${summarizeEntry(entry, availableSummary)}${fullSuffix}`.trimEnd();
}
