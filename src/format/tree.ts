import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import { summarizeEntry } from "./entries.ts";
import { passesFilter, type FilterNode } from "./filter.ts";
import { toLayoutTree, type ParentMap } from "./flat-tree.ts";
import { extractTextContent, oneLine, truncateText } from "./text.ts";
import type { FlatLayoutNode } from "./tree-layout.ts";
import { flattenVisibleTree, treePrefix } from "./tree-layout.ts";
import type { EntriesInput, TreeFormatOptions } from "./types.ts";

export const DEFAULT_TREE_FORMAT_OPTIONS: TreeFormatOptions = {
  filter: "conversation",
  width: 120,
};

function entrySummary(entry: SessionEntry): string {
  if (entry.type === "message") {
    switch (entry.message.role) {
      case "user":
        return `user: ${oneLine(extractTextContent(entry.message.content))}`;
      case "assistant":
        return `assistant: ${summarizeEntry(entry)}`;
      case "toolResult":
        return `${entry.message.toolName}: ${entry.message.isError ? "error" : "ok"}`;
      case "bashExecution":
        return `bash: ${oneLine(entry.message.command)}`;
      case "custom":
        return `${entry.message.customType}: ${oneLine(extractTextContent(entry.message.content))}`;
      case "branchSummary":
        return `branch summary: ${oneLine(entry.message.summary)}`;
      case "compactionSummary":
        return `compaction: ${oneLine(entry.message.summary)}`;
    }
  }
  switch (entry.type) {
    case "thinking_level_change":
      return `thinking: ${entry.thinkingLevel}`;
    case "model_change":
      return `model: ${entry.modelId}`;
    case "compaction":
      return `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`;
    case "branch_summary":
      return `branch summary: ${oneLine(entry.summary)}`;
    case "custom":
      return `custom: ${entry.customType}`;
    case "custom_message":
      return `${entry.customType}: ${oneLine(extractTextContent(entry.content))}`;
    case "label":
      return `label: ${entry.label ?? "(cleared)"}`;
    case "session_info":
      return `title: ${entry.name ?? "(empty)"}`;
  }
}

/** Throws (file corruption, not usage) on a duplicate entry id: a Map would
 *  silently collapse the duplicate and hide it. The layout's duplicate-id
 *  check remains as backstop. */
function entryParentMap(entries: readonly SessionEntry[]): ParentMap {
  const parentMap = new Map<string, string | null>();
  for (const entry of entries) {
    if (parentMap.has(entry.id)) {
      throw new Error(`duplicate session entry id: ${entry.id}`);
    }
    parentMap.set(entry.id, entry.parentId);
  }
  return parentMap;
}

/** targetId → label; latest label entry wins, empty/absent label clears
 *  (mirrors pi SessionManager._buildIndex). */
function resolveLabels(entries: readonly SessionEntry[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "label") {
      if (entry.label !== undefined && entry.label !== "") {
        labels.set(entry.targetId, entry.label);
      } else {
        labels.delete(entry.targetId);
      }
    }
  }
  return labels;
}

function formatTreeNodeLine(
  flatNode: FlatLayoutNode<FilterNode>,
  options: TreeFormatOptions,
): string {
  const marker = flatNode.isCurrentLeaf
    ? "* "
    : flatNode.isOnActivePath
      ? "• "
      : "";
  const entry = flatNode.node.payload.entry;
  const prefix = `${treePrefix(flatNode)}${marker}${entry.id} `;
  const availableSummary = Math.max(0, options.width - [...prefix].length);
  return `${prefix}${truncateText(entrySummary(entry), availableSummary)}`.trimEnd();
}

/** Cursor: input.leafId if present (null renders as [cursor: null]); when
 *  absent (raw JSONL input), the last entry's id — pi's own on-load leaf
 *  rule (SessionManager._buildIndex). */
export function formatEntriesTree(
  input: EntriesInput,
  options?: Partial<TreeFormatOptions>,
): string {
  const fullOptions: TreeFormatOptions = {
    filter: options?.filter ?? DEFAULT_TREE_FORMAT_OPTIONS.filter,
    width: options?.width ?? DEFAULT_TREE_FORMAT_OPTIONS.width,
  };
  const parentMap = entryParentMap(input.entries);
  const entryById = new Map(input.entries.map((entry) => [entry.id, entry]));
  const labels = resolveLabels(input.entries);
  const leafId =
    input.leafId !== undefined
      ? input.leafId
      : (input.entries.at(-1)?.id ?? null);
  const roots = toLayoutTree<FilterNode>(parentMap, (id) => {
    const entry = entryById.get(id);
    if (entry === undefined) {
      throw new Error(`missing entry for id: ${id}`);
    }
    const label = labels.get(id);
    return { entry, ...(label !== undefined && { label }) };
  });
  const lines = flattenVisibleTree(roots, leafId, (node) =>
    passesFilter(node.payload, leafId, fullOptions.filter),
  ).map((node) => formatTreeNodeLine(node, fullOptions));
  lines.push(`[cursor: ${leafId ?? "null"}]`);
  return `${lines.join("\n")}\n`;
}
