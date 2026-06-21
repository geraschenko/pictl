import type {
  AgentMessage,
  MessageStreamRecord,
} from "../core/stream-types.ts";
import type { MessageFormatOptions } from "./types.ts";
import {
  countLines,
  extractTextContent,
  oneLine,
  summarizeContentBlock,
  summarizeUnknown,
  truncateText,
} from "./text.ts";

export const DEFAULT_MESSAGE_FORMAT_OPTIONS: MessageFormatOptions = {
  maxToolArgChars: 120,
  toolResults: "summary",
  maxErrorLines: 10,
};

export interface MessageFormatState {
  lastNoisyControl: string | undefined;
}

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

function formatToolArguments(args: unknown, maxChars: number): string {
  if (!isRecord(args)) {
    return summarizeUnknown(args, maxChars);
  }
  const preferredKeys = ["path", "file_path", "command", "pattern"];
  const preferred = preferredKeys
    .filter((key) => args[key] !== undefined)
    .map((key) => `${key}: ${String(args[key])}`);
  const text =
    preferred.length > 0 ? preferred.join(", ") : JSON.stringify(args);
  return truncateText(oneLine(text ?? "{}"), maxChars);
}

function formatToolCall(
  block: Record<string, unknown>,
  options: MessageFormatOptions,
): string {
  const name = typeof block.name === "string" ? block.name : "unknown";
  const args = formatToolArguments(block.arguments, options.maxToolArgChars);
  return args === "" ? `[tool:${name}]` : `[tool:${name} ${args}]`;
}

function formatToolResultText(
  toolName: string,
  isError: boolean,
  text: string,
  options: MessageFormatOptions,
): string | undefined {
  if (options.toolResults === "none") {
    return undefined;
  }
  const status = isError ? "error" : "ok";
  const summary = `[${toolName}:${status} ${countLines(text)} lines, ${Buffer.byteLength(text, "utf8")} bytes]`;
  if (options.toolResults === "summary" && !isError) {
    return summary;
  }
  const lines = text.split("\n");
  const snippet =
    options.toolResults === "summary"
      ? lines.slice(0, options.maxErrorLines).join("\n")
      : text;
  return snippet === "" ? summary : `${summary}\n${snippet}`;
}

function eventField(event: unknown, field: string): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const value = event[field];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function formatControl(record: MessageStreamRecord): string | undefined {
  if (record.type !== "control") {
    return undefined;
  }
  const event = record.control.event;
  switch (record.control.kind) {
    case "compaction":
      return event.type === "compaction_start"
        ? "[control: compaction started]"
        : "[control: compaction finished]";
    case "tree_navigated": {
      const leafId =
        eventField(event, "leafId") ?? eventField(event, "entryId");
      return `[control: tree navigated${leafId === undefined ? "" : ` to ${leafId}`}]`;
    }
    case "session_changed": {
      const sessionId = eventField(event, "sessionId");
      return `[control: session changed${sessionId === undefined ? "" : ` to ${sessionId}`}]`;
    }
    case "queue_update": {
      const length =
        eventField(event, "queueLength") ??
        eventField(event, "pendingMessageCount") ??
        eventField(event, "length");
      return `[control: queue update${length === undefined ? "" : ` ${length} pending`}]`;
    }
  }
}

function formatMessage(
  message: AgentMessage,
  options: MessageFormatOptions,
): string {
  switch (message.role) {
    case "user":
      return `== user ==\n${extractTextContent(message.content)}`;
    case "assistant": {
      const lines = ["== assistant =="];
      if (hasContentBlock(message.content, "thinking")) {
        lines.push("[thinking]");
      }
      for (const block of contentBlocks(message.content)) {
        if (isRecord(block) && block.type === "toolCall") {
          lines.push(formatToolCall(block, options));
        } else if (isRecord(block) && block.type === "text") {
          if (typeof block.text === "string" && block.text !== "") {
            lines.push(block.text);
          }
        } else if (isRecord(block) && block.type !== "thinking") {
          lines.push(summarizeContentBlock(block));
        }
      }
      if (message.stopReason === "aborted") {
        lines.push("[aborted]");
      }
      if (message.errorMessage !== undefined) {
        lines.push(`[error: ${message.errorMessage}]`);
      }
      return lines.join("\n");
    }
    case "toolResult": {
      const text = extractTextContent(message.content);
      return (
        formatToolResultText(
          message.toolName,
          message.isError,
          text,
          options,
        ) ?? ""
      );
    }
    case "bashExecution":
      return `== bash ==\n${message.command}\n[exit: ${message.exitCode ?? "unknown"}]${
        message.output === "" ? "" : `\n${message.output}`
      }`;
    case "custom":
      return `== custom:${message.customType} ==\n${extractTextContent(message.content)}`;
    case "branchSummary":
      return `== branchSummary:${message.fromId} ==\n${message.summary}`;
    case "compactionSummary":
      return `== compactionSummary ==\n${message.summary}`;
  }
}

export function formatMessageRecords(
  records: Iterable<MessageStreamRecord>,
  options?: Partial<MessageFormatOptions>,
): string {
  const fullOptions: MessageFormatOptions = {
    maxToolArgChars:
      options?.maxToolArgChars ??
      DEFAULT_MESSAGE_FORMAT_OPTIONS.maxToolArgChars,
    toolResults:
      options?.toolResults ?? DEFAULT_MESSAGE_FORMAT_OPTIONS.toolResults,
    maxErrorLines:
      options?.maxErrorLines ?? DEFAULT_MESSAGE_FORMAT_OPTIONS.maxErrorLines,
  };
  const state: MessageFormatState = { lastNoisyControl: undefined };
  const chunks = Array.from(records)
    .map((record) => formatMessageRecord(record, fullOptions, state))
    .filter((chunk) => chunk !== undefined && chunk !== "");
  return chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`;
}

export function formatMessageRecord(
  record: MessageStreamRecord,
  options: MessageFormatOptions,
  state: MessageFormatState,
): string | undefined {
  if (record.type === "pictl_cursor") {
    state.lastNoisyControl = undefined;
    return `[cursor: ${record.entryId ?? "null"}]`;
  }
  if (record.type === "control") {
    state.lastNoisyControl = undefined;
    return formatControl(record);
  }
  state.lastNoisyControl = undefined;
  return formatMessage(record.message, options);
}
