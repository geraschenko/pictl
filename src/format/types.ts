import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { FilterMode } from "./filter.ts";

export type ToolResultDisplayMode = "summary" | "none" | "full";

export interface MessageFormatOptions {
  readonly maxToolArgChars: number;
  readonly toolResults: ToolResultDisplayMode;
  readonly maxErrorLines: number;
}

export interface EntryFormatOptions {
  readonly timestamps: boolean;
  readonly full: boolean;
  readonly filter: FilterMode | undefined;
  readonly width: number;
}

export interface TreeFormatOptions {
  readonly filter: FilterMode;
  readonly width: number;
}

export interface EntriesInput {
  readonly entries: readonly SessionEntry[];
  readonly leafId?: string | null;
}
