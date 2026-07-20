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

function optionalStringOrNumberField(
  event: unknown,
  field: string,
): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const value = event[field];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function stringListField(event: unknown, field: string): readonly string[] {
  if (!isRecord(event)) {
    return [];
  }
  const value = event[field];
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
    ? value
    : [];
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
      const oldLeafId =
        optionalStringOrNumberField(event, "oldLeafId") ?? "null";
      const newLeafId =
        optionalStringOrNumberField(event, "newLeafId") ?? "null";
      return `[control: tree navigated ${oldLeafId} -> ${newLeafId}]`;
    }
    case "session_changed": {
      // Records may come from parsed JSONL (`pictl format`), so read the
      // state defensively despite the static type.
      const state = event.type === "session_changed" ? event.state : undefined;
      const sessionId = optionalStringOrNumberField(state, "sessionId");
      const sessionFile = optionalStringOrNumberField(state, "sessionFile");
      return `[control: session changed${sessionId === undefined ? "" : ` to ${sessionId}`}${sessionFile === undefined ? "" : ` ${sessionFile}`}]`;
    }
    case "queue_update": {
      const steeringCount = stringListField(event, "steering").length;
      const followUpCount = stringListField(event, "followUp").length;
      return `[control: queue update steering=${steeringCount} follow-up=${followUpCount}]`;
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
  const chunks = Array.from(records)
    .map((record) => formatMessageRecord(record, fullOptions))
    .filter((chunk) => chunk !== undefined && chunk !== "");
  return chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`;
}

export function formatMessageRecord(
  record: MessageStreamRecord,
  options: MessageFormatOptions,
): string | undefined {
  if (record.type === "pictl_cursor") {
    return `[cursor: ${record.entryId ?? "null"}]`;
  }
  if (record.type === "control") {
    return formatControl(record);
  }
  return formatMessage(record.message, options);
}
