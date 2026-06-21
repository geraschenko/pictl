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
  const summary = (() => {
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
  })();
  return truncateText(summary, maxChars);
}

export function summarizeEntry(
  entry: SessionEntry,
  maxChars = DEFAULT_ENTRY_WIDTH,
): string {
  const summary = (() => {
    switch (entry.type) {
      case "message":
        return summarizeMessage(entry.message, maxChars);
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
  })();
  return truncateText(summary, maxChars);
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
