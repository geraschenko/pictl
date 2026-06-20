import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { AgentMessage } from "../core/stream-types.ts";
import type { EntriesInput, EntryFormatOptions } from "./types.ts";
import {
  countLines,
  extractTextContent,
  oneLine,
  summarizeUnknown,
  truncateText,
} from "./text.ts";

const SUMMARY_WIDTH = 80;

export const DEFAULT_ENTRY_FORMAT_OPTIONS: EntryFormatOptions = {
  timestamps: false,
  full: false,
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

function summarizeMessage(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      return truncateText(
        oneLine(extractTextContent(message.content)),
        SUMMARY_WIDTH,
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
        parts.push(truncateText(oneLine(text), SUMMARY_WIDTH));
      } else if (message.stopReason === "aborted") {
        parts.push("(aborted)");
      } else if (message.errorMessage !== undefined) {
        parts.push(truncateText(oneLine(message.errorMessage), SUMMARY_WIDTH));
      }
      return parts.join(" ") || "(no content)";
    }
    case "toolResult": {
      const text = extractTextContent(message.content);
      const status = message.isError ? "error" : "ok";
      return `${message.toolName} ${status}, ${countLines(text)} lines, ${Buffer.byteLength(text, "utf8")} bytes`;
    }
    case "bashExecution":
      return `[bash] ${truncateText(oneLine(message.command), SUMMARY_WIDTH)}`;
    case "custom":
      return `[custom:${message.customType}] ${truncateText(oneLine(extractTextContent(message.content)), SUMMARY_WIDTH)}`;
    case "branchSummary":
      return truncateText(oneLine(message.summary), SUMMARY_WIDTH);
    case "compactionSummary":
      return truncateText(oneLine(message.summary), SUMMARY_WIDTH);
  }
}

function summarizeEntry(entry: SessionEntry): string {
  switch (entry.type) {
    case "message":
      return summarizeMessage(entry.message);
    case "thinking_level_change":
      return entry.thinkingLevel;
    case "model_change":
      return `${entry.provider}/${entry.modelId}`;
    case "compaction":
      return `${truncateText(oneLine(entry.summary), SUMMARY_WIDTH)} (${entry.tokensBefore} tokens)`;
    case "branch_summary":
      return `${entry.fromId}: ${truncateText(oneLine(entry.summary), SUMMARY_WIDTH)}`;
    case "custom":
      return `${entry.customType}${entry.data === undefined ? "" : ` ${summarizeUnknown(entry.data, SUMMARY_WIDTH)}`}`;
    case "custom_message":
      return `[${entry.customType}] ${truncateText(oneLine(extractTextContent(entry.content)), SUMMARY_WIDTH)}`;
    case "label":
      return `${entry.targetId}: ${entry.label ?? "(cleared)"}`;
    case "session_info":
      return entry.name ?? "(empty title)";
  }
}

export function formatEntriesInput(
  input: EntriesInput,
  options?: Partial<EntryFormatOptions>,
): string {
  return formatEntryJsonl(input.entries, options);
}

export function formatEntryJsonl(
  entries: Iterable<SessionEntry>,
  options?: Partial<EntryFormatOptions>,
): string {
  const fullOptions: EntryFormatOptions = {
    timestamps: options?.timestamps ?? DEFAULT_ENTRY_FORMAT_OPTIONS.timestamps,
    full: options?.full ?? DEFAULT_ENTRY_FORMAT_OPTIONS.full,
  };
  const lines = Array.from(entries, (entry) => formatEntry(entry, fullOptions));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function formatEntry(
  entry: SessionEntry,
  options: EntryFormatOptions,
): string {
  const fields = [entry.id, roleLabel(entry).padEnd(10), summarizeEntry(entry)];
  if (options.timestamps) {
    fields.unshift(entry.timestamp);
  }
  if (options.full) {
    fields.push(JSON.stringify(entry));
  }
  return fields.join(" ").trimEnd();
}
