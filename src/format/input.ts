import { readFile } from "node:fs/promises";
import type {
  SessionEntry,
  SessionTreeNode,
} from "@geraschenko/pi-coding-agent";
import type { MessageStreamRecord } from "../core/stream-types.ts";
import type { CommandContext } from "../core/targets.ts";
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

async function readStdin(
  stdin: AsyncIterable<Buffer | string>,
): Promise<string> {
  let data = "";
  for await (const chunk of stdin) {
    data += chunk.toString();
  }
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

// TDC: in these require* functions, you say "expected X", but don't say what you got. Why not include `got ${typeof record[key]} {record[key]}`, or maybe include the full record?
function requireString(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "string") {
    throw new UsageError(`invalid session entry: expected string ${key}`);
  }
}

function requireNumber(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "number") {
    throw new UsageError(`invalid session entry: expected number ${key}`);
  }
}

function requireBoolean(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "boolean") {
    throw new UsageError(`invalid session entry: expected boolean ${key}`);
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

export async function readInputFile(
  context: CommandContext,
  file: string | undefined,
): Promise<string> {
  if (file === undefined || file === "-") {
    return await readStdin((context.process as NodeJS.Process).stdin);
  }
  return await readFile(file, "utf8");
}

export function parseJsonInput(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new UsageError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseJsonlInput(input: string): readonly unknown[] {
  const lines = input.split(/\r?\n/u).filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new UsageError(
        `invalid JSONL line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
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

export function parseMessageRecords(
  input: string,
): readonly MessageStreamRecord[] {
  if (input.trim() === "") {
    return [];
  }
  return parseJsonlInput(input).map(decodeMessageStreamRecord);
}
