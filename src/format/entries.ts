import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { AgentMessage } from "../core/stream-types.ts";
import { passesFilter } from "./filter.ts";
import type { EntriesInput, EntryFormatOptions } from "./types.ts";
import {
  countLines,
  extractTextContent,
  oneLine,
  summarizeUnknown,
  truncateText,
} from "./text.ts";

const DEFAULT_ENTRY_WIDTH = 120;

export const DEFAULT_ENTRY_FORMAT_OPTIONS: EntryFormatOptions = {
  timestamps: false,
  full: false,
  filter: undefined,
  width: DEFAULT_ENTRY_WIDTH,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contentBlocks(content: unknown): readonly unknown[] {
  return Array.isArray(content) ? content : [];
}

function hasContentBlock(content: unknown, type: string): boolean {
  return contentBlocks(content).some(
    (block) => isRecord(block) && block.type === type,
  );
}

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

function entryFormatOptions(
  options: Partial<EntryFormatOptions> | undefined,
): EntryFormatOptions {
  return {
    timestamps: options?.timestamps ?? DEFAULT_ENTRY_FORMAT_OPTIONS.timestamps,
    full: options?.full ?? DEFAULT_ENTRY_FORMAT_OPTIONS.full,
    filter: options?.filter ?? DEFAULT_ENTRY_FORMAT_OPTIONS.filter,
    width: options?.width ?? DEFAULT_ENTRY_FORMAT_OPTIONS.width,
  };
}

function summarizeMessage(message: AgentMessage, maxChars: number): string {
  switch (message.role) {
    case "user":
      return truncateText(
        oneLine(extractTextContent(message.content)),
        maxChars,
      );
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
        parts.push(truncateText(oneLine(text), maxChars));
      } else if (message.stopReason === "aborted") {
        parts.push("(aborted)");
      } else if (message.errorMessage !== undefined) {
        parts.push(truncateText(oneLine(message.errorMessage), maxChars));
      }
      return truncateText(parts.join(" ") || "(no content)", maxChars);
    }
    case "toolResult": {
      const text = extractTextContent(message.content);
      const status = message.isError ? "error" : "ok";
      return truncateText(
        `${message.toolName} ${status}, ${countLines(text)} lines, ${Buffer.byteLength(text, "utf8")} bytes`,
        maxChars,
      );
    }
    case "bashExecution":
      return `[bash] ${truncateText(oneLine(message.command), maxChars)}`;
    case "custom":
      return `[custom:${message.customType}] ${truncateText(oneLine(extractTextContent(message.content)), maxChars)}`;
    case "branchSummary":
      return truncateText(oneLine(message.summary), maxChars);
    case "compactionSummary":
      return truncateText(oneLine(message.summary), maxChars);
  }
}

export function summarizeEntry(
  entry: SessionEntry,
  maxChars = DEFAULT_ENTRY_WIDTH,
): string {
  switch (entry.type) {
    case "message":
      return summarizeMessage(entry.message, maxChars);
    case "thinking_level_change":
      return truncateText(entry.thinkingLevel, maxChars);
    case "model_change":
      return truncateText(`${entry.provider}/${entry.modelId}`, maxChars);
    case "compaction":
      return truncateText(
        `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`,
        maxChars,
      );
    case "branch_summary":
      return `${entry.fromId}: ${truncateText(oneLine(entry.summary), maxChars)}`;
    case "custom":
      return `${entry.customType}${entry.data === undefined ? "" : ` ${summarizeUnknown(entry.data, maxChars)}`}`;
    case "custom_message":
      return `[${entry.customType}] ${truncateText(oneLine(extractTextContent(entry.content)), maxChars)}`;
    case "label":
      return truncateText(
        `${entry.targetId}: ${entry.label ?? "(cleared)"}`,
        maxChars,
      );
    case "session_info":
      return truncateText(entry.name ?? "(empty title)", maxChars);
  }
}

export function formatEntriesInput(
  input: EntriesInput,
  options?: Partial<EntryFormatOptions>,
): string {
  const fullOptions = entryFormatOptions(options);
  if (fullOptions.filter === undefined) {
    return formatEntryJsonl(input.entries, fullOptions);
  }
  const filter = fullOptions.filter;
  return formatEntryJsonl(
    input.entries.filter((entry) =>
      passesFilter({ entry }, input.leafId ?? null, filter),
    ),
    fullOptions,
  );
}

export function formatEntryJsonl(
  entriesInput: Iterable<SessionEntry>,
  options?: Partial<EntryFormatOptions>,
): string {
  const fullOptions = entryFormatOptions(options);
  const inputEntries = Array.from(entriesInput);
  const entries = (() => {
    if (fullOptions.filter === undefined) {
      return inputEntries;
    }
    const filter = fullOptions.filter;
    return inputEntries.filter((entry) =>
      passesFilter({ entry }, null, filter),
    );
  })();
  const lines = entries.map((entry) => formatEntry(entry, fullOptions));
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
