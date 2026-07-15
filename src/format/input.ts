import type {
  SessionEntry,
  SessionTreeNode,
} from "@geraschenko/pi-coding-agent";
import { parseJsonInput, parseJsonlInput } from "../core/read-input.ts";
import type { MessageStreamRecord } from "../core/stream-types.ts";
import { UsageError } from "../core/util.ts";
import type { EntriesInput, TreeInput } from "./types.ts";

const MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);
const ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const CONTROL_KINDS = new Set([
  "compaction",
  "tree_navigated",
  "session_changed",
  "queue_update",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function describeValue(value: unknown): string {
  const json = JSON.stringify(value);
  return `${typeof value}${json === undefined ? "" : ` ${json}`}`;
}

function requireString(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "string") {
    throw new UsageError(
      `invalid session entry: expected string ${key}, got ${describeValue(record[key])}`,
    );
  }
}

function requireNumber(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "number") {
    throw new UsageError(
      `invalid session entry: expected number ${key}, got ${describeValue(record[key])}`,
    );
  }
}

function requireBoolean(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "boolean") {
    throw new UsageError(
      `invalid session entry: expected boolean ${key}, got ${describeValue(record[key])}`,
    );
  }
}

function validateMessage(value: unknown): void {
  if (!isRecord(value) || typeof value.role !== "string") {
    throw new UsageError("invalid session entry: invalid message");
  }
  if (!MESSAGE_ROLES.has(value.role)) {
    throw new UsageError(
      `invalid session entry: invalid message role ${value.role}`,
    );
  }
  switch (value.role) {
    case "user":
      if (
        !(typeof value.content === "string" || Array.isArray(value.content))
      ) {
        throw new UsageError("invalid session entry: invalid user content");
      }
      break;
    case "assistant":
      if (!Array.isArray(value.content)) {
        throw new UsageError(
          "invalid session entry: invalid assistant content",
        );
      }
      break;
    case "toolResult":
      requireString(value, "toolName");
      requireBoolean(value, "isError");
      if (!Array.isArray(value.content)) {
        throw new UsageError(
          "invalid session entry: invalid tool result content",
        );
      }
      break;
    case "bashExecution":
      requireString(value, "command");
      requireBoolean(value, "cancelled");
      requireBoolean(value, "truncated");
      break;
    case "custom":
      requireString(value, "customType");
      break;
    case "branchSummary":
      requireString(value, "summary");
      requireString(value, "fromId");
      break;
    case "compactionSummary":
      requireString(value, "summary");
      requireNumber(value, "tokensBefore");
      break;
  }
}

function validateSessionEntryRecord(record: Record<string, unknown>): void {
  requireString(record, "id");
  requireString(record, "timestamp");
  if (!isStringOrNull(record.parentId)) {
    throw new UsageError(
      "invalid session entry: expected string|null parentId",
    );
  }
  if (typeof record.type !== "string" || !ENTRY_TYPES.has(record.type)) {
    throw new UsageError("invalid session entry");
  }

  switch (record.type) {
    case "message":
      validateMessage(record.message);
      break;
    case "thinking_level_change":
      requireString(record, "thinkingLevel");
      break;
    case "model_change":
      requireString(record, "provider");
      requireString(record, "modelId");
      break;
    case "compaction":
      requireString(record, "summary");
      requireString(record, "firstKeptEntryId");
      requireNumber(record, "tokensBefore");
      break;
    case "branch_summary":
      requireString(record, "fromId");
      requireString(record, "summary");
      break;
    case "custom":
      requireString(record, "customType");
      break;
    case "custom_message":
      requireString(record, "customType");
      if (
        !(typeof record.content === "string" || Array.isArray(record.content))
      ) {
        throw new UsageError(
          "invalid session entry: invalid custom message content",
        );
      }
      requireBoolean(record, "display");
      break;
    case "label":
      requireString(record, "targetId");
      if (!(typeof record.label === "string" || record.label === undefined)) {
        throw new UsageError("invalid session entry: invalid label");
      }
      break;
    case "session_info":
      if (!(typeof record.name === "string" || record.name === undefined)) {
        throw new UsageError("invalid session entry: invalid session name");
      }
      break;
  }
}

function decodeTreeNode(value: unknown): SessionTreeNode {
  if (!isRecord(value) || !Array.isArray(value.children)) {
    throw new UsageError("invalid tree input");
  }
  const entry = decodeSessionEntry(value.entry);
  const children = value.children.map(decodeTreeNode);
  return {
    entry,
    children,
    ...(typeof value.label === "string" && { label: value.label }),
    ...(typeof value.labelTimestamp === "string" && {
      labelTimestamp: value.labelTimestamp,
    }),
  };
}

export function decodeMessageStreamRecord(value: unknown): MessageStreamRecord {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new UsageError("invalid message stream record");
  }
  if (value.type === "message") {
    validateMessage(value.message);
    return value as unknown as MessageStreamRecord;
  }
  if (value.type === "control" && isRecord(value.control)) {
    if (
      typeof value.control.kind === "string" &&
      CONTROL_KINDS.has(value.control.kind) &&
      isRecord(value.control.event)
    ) {
      return value as unknown as MessageStreamRecord;
    }
  }
  if (
    value.type === "pictl_cursor" &&
    isStringOrNull(value.sessionId) &&
    isStringOrNull(value.entryId)
  ) {
    return value as unknown as MessageStreamRecord;
  }
  throw new UsageError("invalid message stream record");
}

export function decodeSessionEntry(value: unknown): SessionEntry {
  if (!isRecord(value)) {
    throw new UsageError("invalid session entry");
  }
  validateSessionEntryRecord(value);
  return value as unknown as SessionEntry;
}

export function decodeEntriesInput(value: unknown): EntriesInput {
  if (isRecord(value) && Array.isArray(value.entries)) {
    if ("leafId" in value && !isStringOrNull(value.leafId)) {
      throw new UsageError("invalid entries input: invalid leafId");
    }
    return {
      entries: value.entries.map(decodeSessionEntry),
      leafId: isStringOrNull(value.leafId) ? value.leafId : undefined,
    };
  }
  throw new UsageError("invalid entries input");
}

export function decodeTreeInput(value: unknown): TreeInput {
  if (
    isRecord(value) &&
    Array.isArray(value.tree) &&
    isStringOrNull(value.leafId)
  ) {
    return { tree: value.tree.map(decodeTreeNode), leafId: value.leafId };
  }
  throw new UsageError("invalid tree input");
}

export function parseEntriesInput(
  input: string,
): EntriesInput | readonly SessionEntry[] {
  if (input.trim() === "") {
    return [];
  }
  const trimmed = input.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (isRecord(parsed) && "entries" in parsed) {
        return decodeEntriesInput(parsed);
      }
    } catch {
      // Not a single JSON object; parse below as JSONL.
    }
  }
  return parseJsonlInput(input).map(decodeSessionEntry);
}

export function parseTreeInput(input: string): TreeInput {
  return decodeTreeInput(parseJsonInput(input));
}

function decodeMessagesInput(
  value: Record<string, unknown>,
): readonly MessageStreamRecord[] {
  if (!Array.isArray(value.messages)) {
    throw new UsageError("invalid messages input");
  }
  return value.messages.map((message) => {
    validateMessage(message);
    return { type: "message", message } as unknown as MessageStreamRecord;
  });
}

export function parseMessageRecords(
  input: string,
): readonly MessageStreamRecord[] {
  if (input.trim() === "") {
    return [];
  }
  if (input.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (isRecord(parsed) && "messages" in parsed) {
        return decodeMessagesInput(parsed);
      }
    } catch {
      // Not a single JSON object; parse below as JSONL.
    }
  }
  return parseJsonlInput(input).map(decodeMessageStreamRecord);
}
