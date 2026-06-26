import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import { extractTextContent } from "./text.ts";

export const FILTER_MODES = [
  "conversation",
  "pi-default",
  "pi-no-tools",
  "pi-user-only",
  "pi-labeled-only",
  "pi-all",
] as const;

/**
 * Filter modes.
 *
 * `conversation` is pictl-specific and means user/assistant message entries and
 * compaction entries are shown.
 *
 * `pi-*` modes are intentionally aligned with pi's TreeSelector FilterMode from:
 * pi repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
 *
 * If pi changes TreeSelector filtering behavior, update these modes to match.
 */
export type FilterMode = (typeof FILTER_MODES)[number];

export interface FilterNode {
  readonly entry: SessionEntry;
  readonly label?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasBlock(content: unknown, type: string): boolean {
  return Array.isArray(content)
    ? content.some((block) => isRecord(block) && block.type === type)
    : false;
}

function assistantHasText(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    extractTextContent(entry.message.content).trim() !== ""
  );
}

function assistantToolOnlySuppressed(
  entry: SessionEntry,
  currentLeafId: string | null,
): boolean {
  if (
    entry.type !== "message" ||
    entry.message.role !== "assistant" ||
    entry.id === currentLeafId
  ) {
    return false;
  }
  const hasText = assistantHasText(entry);
  const hasToolCall = hasBlock(entry.message.content, "toolCall");
  const isErrorOrAborted =
    entry.message.stopReason !== "stop" &&
    entry.message.stopReason !== "toolUse";
  return hasToolCall && !hasText && !isErrorOrAborted;
}

export function passesFilter(
  node: FilterNode,
  currentLeafId: string | null,
  filter: FilterMode,
): boolean {
  const entry = node.entry;
  const isCurrentLeaf = entry.id === currentLeafId;

  // Adapted from pi TreeSelector filtering.
  // pi repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
  if (
    filter !== "conversation" &&
    assistantToolOnlySuppressed(entry, currentLeafId)
  ) {
    return false;
  }

  if (filter === "conversation") {
    if (entry.type === "compaction") {
      return true;
    }
    if (entry.type !== "message") {
      return false;
    }
    if (entry.message.role === "user") {
      return true;
    }
    if (entry.message.role !== "assistant") {
      return false;
    }
    return (
      assistantHasText(entry) ||
      entry.message.stopReason === "aborted" ||
      entry.message.errorMessage !== undefined ||
      isCurrentLeaf
    );
  }

  const isSettingsEntry =
    entry.type === "label" ||
    entry.type === "custom" ||
    entry.type === "model_change" ||
    entry.type === "thinking_level_change" ||
    entry.type === "session_info";

  switch (filter) {
    case "pi-user-only":
      return entry.type === "message" && entry.message.role === "user";
    case "pi-no-tools":
      return !(
        isSettingsEntry ||
        (entry.type === "message" && entry.message.role === "toolResult")
      );
    case "pi-labeled-only":
      return node.label !== undefined;
    case "pi-all":
      return true;
    case "pi-default":
      return !isSettingsEntry;
  }
}
