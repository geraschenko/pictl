import type {
  SessionEntry,
  SessionTreeNode,
} from "@geraschenko/pi-coding-agent";

export type ToolResultDisplayMode = "summary" | "none" | "full";

export interface MessageFormatOptions {
  readonly maxToolArgChars: number;
  readonly toolResults: ToolResultDisplayMode;
  readonly maxErrorLines: number;
}

export interface EntryFormatOptions {
  readonly timestamps: boolean;
  readonly full: boolean;
}

/**
 * Tree filter modes.
 *
 * `conversation` is pictl-specific and means only user and assistant message
 * entries are shown.
 *
 * `pi-*` modes are intentionally aligned with pi's TreeSelector FilterMode from:
 * pi repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
 *
 * If pi changes TreeSelector filtering behavior, update these modes to match.
 */
export type TreeFilterMode =
  | "conversation"
  | "pi-default"
  | "pi-no-tools"
  | "pi-user-only"
  | "pi-labeled-only"
  | "pi-all";

export interface TreeFormatOptions {
  readonly filter: TreeFilterMode;
  readonly width: number;
}

export interface EntriesInput {
  readonly entries: readonly SessionEntry[];
  readonly leafId?: string | null;
}

export interface TreeInput {
  readonly tree: readonly SessionTreeNode[];
  readonly leafId: string | null;
}
