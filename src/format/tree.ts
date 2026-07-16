import type {
  SessionEntry,
  SessionTreeNode,
} from "@geraschenko/pi-coding-agent";
import { summarizeEntry } from "./entries.ts";
import { passesFilter } from "./filter.ts";
import { extractTextContent, oneLine, truncateText } from "./text.ts";
import type { FlatLayoutNode, LayoutNode } from "./tree-layout.ts";
import { flattenVisibleTree, treePrefix } from "./tree-layout.ts";
import type { TreeFormatOptions, TreeInput } from "./types.ts";

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

function toLayoutNode(node: SessionTreeNode): LayoutNode<SessionTreeNode> {
  return {
    id: node.entry.id,
    children: node.children.map(toLayoutNode),
    payload: node,
  };
}

function formatTreeNodeLine(
  flatNode: FlatLayoutNode<SessionTreeNode>,
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

export function formatTreeInput(
  input: TreeInput,
  options?: Partial<TreeFormatOptions>,
): string {
  const fullOptions: TreeFormatOptions = {
    filter: options?.filter ?? DEFAULT_TREE_FORMAT_OPTIONS.filter,
    width: options?.width ?? DEFAULT_TREE_FORMAT_OPTIONS.width,
  };
  const roots = input.tree.map(toLayoutNode);
  const lines = flattenVisibleTree(roots, input.leafId, (node) =>
    passesFilter(
      { entry: node.payload.entry, label: node.payload.label },
      input.leafId,
      fullOptions.filter,
    ),
  ).map((node) => formatTreeNodeLine(node, fullOptions));
  lines.push(`[cursor: ${input.leafId ?? "null"}]`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
