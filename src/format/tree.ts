import type {
  SessionEntry,
  SessionTreeNode,
} from "@geraschenko/pi-coding-agent";
import type { TreeFilterMode, TreeFormatOptions, TreeInput } from "./types.ts";
import { summarizeEntry } from "./entries.ts";
import { extractTextContent, oneLine, truncateText } from "./text.ts";

export const DEFAULT_TREE_FORMAT_OPTIONS: TreeFormatOptions = {
  filter: "conversation",
  width: 120,
};

export interface TreeGutter {
  readonly position: number;
  readonly show: boolean;
}

export interface FlatTreeNode {
  readonly node: SessionTreeNode;
  readonly indent: number;
  readonly showConnector: boolean;
  readonly isLast: boolean;
  readonly gutters: readonly TreeGutter[];
  readonly isVirtualRootChild: boolean;
  readonly isOnActivePath: boolean;
  readonly isCurrentLeaf: boolean;
}

interface FlatTreeNodeDraft {
  node: SessionTreeNode;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  gutters: readonly TreeGutter[];
  isVirtualRootChild: boolean;
  isOnActivePath: boolean;
  isCurrentLeaf: boolean;
}

interface StackItem {
  readonly node: SessionTreeNode;
  readonly indent: number;
  readonly justBranched: boolean;
  readonly showConnector: boolean;
  readonly isLast: boolean;
  readonly gutters: readonly TreeGutter[];
  readonly isVirtualRootChild: boolean;
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

function passesFilter(
  flatNode: FlatTreeNodeDraft,
  currentLeafId: string | null,
  filter: TreeFilterMode,
): boolean {
  const entry = flatNode.node.entry;
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
      return flatNode.node.label !== undefined;
    case "pi-all":
      return true;
    case "pi-default":
      return !isSettingsEntry;
  }
}

function buildActivePath(
  flatNodes: readonly FlatTreeNodeDraft[],
  currentLeafId: string | null,
): Set<string> {
  const path = new Set<string>();
  if (currentLeafId === null) {
    return path;
  }
  const byId = new Map(flatNodes.map((node) => [node.node.entry.id, node]));
  let currentId: string | null = currentLeafId;
  while (currentId !== null) {
    path.add(currentId);
    currentId = byId.get(currentId)?.node.entry.parentId ?? null;
  }
  return path;
}

function computeContainsActive(
  roots: readonly SessionTreeNode[],
  currentLeafId: string | null,
): Map<SessionTreeNode, boolean> {
  const containsActive = new Map<SessionTreeNode, boolean>();
  const allNodes: SessionTreeNode[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    allNodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  for (let index = allNodes.length - 1; index >= 0; index -= 1) {
    const node = allNodes[index];
    if (node === undefined) {
      continue;
    }
    let has = currentLeafId !== null && node.entry.id === currentLeafId;
    for (const child of node.children) {
      if (containsActive.get(child) === true) {
        has = true;
      }
    }
    containsActive.set(node, has);
  }
  return containsActive;
}

function flattenAll(
  roots: readonly SessionTreeNode[],
  currentLeafId: string | null,
): FlatTreeNodeDraft[] {
  const result: FlatTreeNodeDraft[] = [];
  const containsActive = computeContainsActive(roots, currentLeafId);
  const multipleRoots = roots.length > 1;
  const stack: StackItem[] = [];
  const orderedRoots = [...roots].sort(
    (a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)),
  );

  for (let index = orderedRoots.length - 1; index >= 0; index -= 1) {
    const root = orderedRoots[index];
    if (root === undefined) {
      continue;
    }
    stack.push({
      node: root,
      indent: multipleRoots ? 1 : 0,
      justBranched: multipleRoots,
      showConnector: multipleRoots,
      isLast: index === orderedRoots.length - 1,
      gutters: [],
      isVirtualRootChild: multipleRoots,
    });
  }

  // Adapted from pi TreeSelector flattenTree indentation and active-branch ordering.
  // pi repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      continue;
    }
    result.push({ ...item, isOnActivePath: false, isCurrentLeaf: false });

    const multipleChildren = item.node.children.length > 1;
    const orderedChildren: SessionTreeNode[] = [];
    for (const child of item.node.children) {
      if (containsActive.get(child) === true) {
        orderedChildren.push(child);
      }
    }
    for (const child of item.node.children) {
      if (containsActive.get(child) !== true) {
        orderedChildren.push(child);
      }
    }

    const childIndent = multipleChildren
      ? item.indent + 1
      : item.justBranched && item.indent > 0
        ? item.indent + 1
        : item.indent;
    const connectorDisplayed = item.showConnector && !item.isVirtualRootChild;
    const currentDisplayIndent = multipleRoots
      ? Math.max(0, item.indent - 1)
      : item.indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...item.gutters, { position: connectorPosition, show: !item.isLast }]
      : item.gutters;

    for (let index = orderedChildren.length - 1; index >= 0; index -= 1) {
      const child = orderedChildren[index];
      if (child === undefined) {
        continue;
      }
      stack.push({
        node: child,
        indent: childIndent,
        justBranched: multipleChildren,
        showConnector: multipleChildren,
        isLast: index === orderedChildren.length - 1,
        gutters: childGutters,
        isVirtualRootChild: false,
      });
    }
  }
  return result;
}

function recalculateVisibleStructure(
  visibleFlatNodes: readonly FlatTreeNodeDraft[],
  allFlatNodes: readonly FlatTreeNodeDraft[],
  activePath: ReadonlySet<string>,
  currentLeafId: string | null,
): readonly FlatTreeNode[] {
  const visibleIds = new Set(
    visibleFlatNodes.map((node) => node.node.entry.id),
  );
  const allById = new Map(
    allFlatNodes.map((node) => [node.node.entry.id, node]),
  );
  const visibleChildren = new Map<string | null, string[]>();
  visibleChildren.set(null, []);

  for (const flatNode of visibleFlatNodes) {
    let parentId = flatNode.node.entry.parentId;
    while (parentId !== null && !visibleIds.has(parentId)) {
      parentId = allById.get(parentId)?.node.entry.parentId ?? null;
    }
    const children = visibleChildren.get(parentId) ?? [];
    children.push(flatNode.node.entry.id);
    visibleChildren.set(parentId, children);
  }

  const multipleRoots = (visibleChildren.get(null) ?? []).length > 1;
  const byId = new Map(
    visibleFlatNodes.map((node) => [node.node.entry.id, node]),
  );
  const result: FlatTreeNode[] = [];
  const stack: Array<{
    readonly nodeId: string;
    readonly indent: number;
    readonly justBranched: boolean;
    readonly showConnector: boolean;
    readonly isLast: boolean;
    readonly gutters: readonly TreeGutter[];
    readonly isVirtualRootChild: boolean;
  }> = [];
  const rootIds = visibleChildren.get(null) ?? [];

  for (let index = rootIds.length - 1; index >= 0; index -= 1) {
    const nodeId = rootIds[index];
    if (nodeId !== undefined) {
      stack.push({
        nodeId,
        indent: multipleRoots ? 1 : 0,
        justBranched: multipleRoots,
        showConnector: multipleRoots,
        isLast: index === rootIds.length - 1,
        gutters: [],
        isVirtualRootChild: multipleRoots,
      });
    }
  }

  // Adapted from pi TreeSelector recalculateVisualStructure.
  // pi repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      continue;
    }
    const flatNode = byId.get(item.nodeId);
    if (flatNode === undefined) {
      continue;
    }
    result.push({
      node: flatNode.node,
      indent: item.indent,
      showConnector: item.showConnector,
      isLast: item.isLast,
      gutters: item.gutters,
      isVirtualRootChild: item.isVirtualRootChild,
      isOnActivePath: activePath.has(item.nodeId),
      isCurrentLeaf: item.nodeId === currentLeafId,
    });

    const children = visibleChildren.get(item.nodeId) ?? [];
    const multipleChildren = children.length > 1;
    const childIndent = multipleChildren
      ? item.indent + 1
      : item.justBranched && item.indent > 0
        ? item.indent + 1
        : item.indent;
    const connectorDisplayed = item.showConnector && !item.isVirtualRootChild;
    const currentDisplayIndent = multipleRoots
      ? Math.max(0, item.indent - 1)
      : item.indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...item.gutters, { position: connectorPosition, show: !item.isLast }]
      : item.gutters;

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        stack.push({
          nodeId: child,
          indent: childIndent,
          justBranched: multipleChildren,
          showConnector: multipleChildren,
          isLast: index === children.length - 1,
          gutters: childGutters,
          isVirtualRootChild: false,
        });
      }
    }
  }
  return result;
}

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
      return `compaction: ${oneLine(entry.summary)}`;
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

function treePrefix(flatNode: FlatTreeNode): string {
  const displayIndent = flatNode.isVirtualRootChild
    ? Math.max(0, flatNode.indent - 1)
    : flatNode.indent;
  const connector =
    flatNode.showConnector && !flatNode.isVirtualRootChild
      ? flatNode.isLast
        ? "└─ "
        : "├─ "
      : "";
  const connectorPosition = connector === "" ? -1 : displayIndent - 1;
  const chars: string[] = [];
  for (let index = 0; index < displayIndent * 3; index += 1) {
    const level = Math.floor(index / 3);
    const posInLevel = index % 3;
    const gutter = flatNode.gutters.find(
      (candidate) => candidate.position === level,
    );
    if (gutter !== undefined) {
      chars.push(posInLevel === 0 && gutter.show ? "│" : " ");
    } else if (connector !== "" && level === connectorPosition) {
      chars.push(
        posInLevel === 0 ? (connector[0] ?? "") : posInLevel === 1 ? "─" : " ",
      );
    } else {
      chars.push(" ");
    }
  }
  return chars.join("");
}

export function formatTreeInput(
  input: TreeInput,
  options?: Partial<TreeFormatOptions>,
): string {
  const fullOptions: TreeFormatOptions = {
    filter: options?.filter ?? DEFAULT_TREE_FORMAT_OPTIONS.filter,
    width: options?.width ?? DEFAULT_TREE_FORMAT_OPTIONS.width,
  };
  const lines = flattenTreeForFormat(
    input.tree,
    input.leafId,
    fullOptions.filter,
  ).map((node) => formatTreeNodeLine(node, fullOptions));
  lines.push(`[cursor: ${input.leafId ?? "null"}]`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function flattenTreeForFormat(
  roots: readonly SessionTreeNode[],
  currentLeafId: string | null,
  filter: TreeFilterMode,
): readonly FlatTreeNode[] {
  const flatNodes = flattenAll(roots, currentLeafId);
  const activePath = buildActivePath(flatNodes, currentLeafId);
  const filtered = flatNodes.filter((node) =>
    passesFilter(node, currentLeafId, filter),
  );
  return recalculateVisibleStructure(
    filtered,
    flatNodes,
    activePath,
    currentLeafId,
  );
}

export function formatTreeNodeLine(
  flatNode: FlatTreeNode,
  options: TreeFormatOptions,
): string {
  const marker = flatNode.isCurrentLeaf
    ? "* "
    : flatNode.isOnActivePath
      ? "• "
      : "";
  const prefix = `${treePrefix(flatNode)}${marker}${flatNode.node.entry.id} `;
  const availableSummary = Math.max(0, options.width - [...prefix].length);
  return `${prefix}${truncateText(entrySummary(flatNode.node.entry), availableSummary)}`.trimEnd();
}
