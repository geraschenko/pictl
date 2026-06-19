# SPEC

## Problem

`pictl` exposes useful raw JSON and JSONL outputs, but coding agents often need compact, readable text views of that data. We want a new formatting layer that converts raw pictl output into concise, navigation-friendly text without changing existing pictl command output.

This spec adds `src/format/` and a new `pictl format` command family. It does not change the output of `pictl prompt`, `pictl tail`, `pictl get-entries`, `pictl get-tree`, or any other existing subcommand.

The existing `scripts/pictl-render` jq prototype must remain in place unchanged for now.

## Success criteria

- `pictl format messages [file]` formats JSONL message stream records from `pictl tail` or `pictl prompt`.
- `pictl format entries [file]` formats either:
  - the JSON object produced by `pictl get-entries`, or
  - JSONL entries produced by `pictl tail --type entries`.
- `pictl format tree [file]` formats the JSON object produced by `pictl get-tree`.
- For all three subcommands, omitted `file` and `-` both mean stdin.
- Formatted output includes copyable entry ids where entry ids are relevant.
- Message formatting renders user and assistant text in full, indicates thinking without printing thinking contents, renders tool calls compactly, and does not print full successful tool responses by default.
- Message formatting summarizes successful tool results by default. Failed tool results include short snippets by default. `--tool-results full` prints full tool results, successful or failed.
- Entry formatting shows all valid session entries by default, including model changes, thinking level changes, compactions, branch summaries, labels, custom entries, messages, and tool results.
- Tree formatting defaults to a conversation-oriented view containing only user and assistant message entries.
- Tree formatting supports pi-aligned filter modes with explicit source comments identifying the pi implementation they are adapted from.
- No existing pictl subcommand output changes in this spec.
- `scripts/pictl-render` remains untouched.

## CLI design

```bash
pictl format messages [file]
pictl format entries [file]
pictl format tree [file]
```

`file` is optional. If omitted or equal to `-`, the formatter reads stdin.

### `pictl format messages`

Flags:

```bash
--tool-results summary|none|full
--max-tool-arg-chars <count>
--max-error-lines <count>
```

Defaults:

- `--tool-results summary`
- `--max-tool-arg-chars 120`
- `--max-error-lines 10`

`summary` mode prints full user/assistant text, compact tool calls, successful tool result summaries, and truncated failed tool result snippets.

### `pictl format entries`

Flags:

```bash
--timestamps
--full
```

Defaults:

- timestamps hidden unless `--timestamps` is passed
- entries are shown as summaries unless `--full` is passed

### `pictl format tree`

Flags:

```bash
--filter conversation|pi-default|pi-no-tools|pi-user-only|pi-labeled-only|pi-all
--width <columns>
```

Defaults:

- `--filter conversation`
- current leaf taken from required input `leafId`
- `--width 120`

## Examples

Message stream input:

```jsonl
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"toolCall","name":"read","arguments":{"path":"README.md"}}]}}
{"type":"message","message":{"role":"toolResult","toolName":"read","content":[{"type":"text","text":"large output"}],"isError":false}}
{"type":"pictl_cursor","sessionId":"session-1","entryId":"0eb932a9"}
```

Formatted message output shape:

```text
== user ==
Hello

== assistant ==
[thinking]
[tool:read path: README.md]
[read:ok 1 lines, 12 bytes]
[cursor: 0eb932a9]
```

Entry output shape:

```text
79d4e93e user       Help me write a small jq-based script...
ab4e0c01 assistant  [thinking] [tool: read]
0eb932a9 toolResult read ok, 63 lines, 2953 bytes
```

Entries do not show `parentId` by default. They show the entry id, role/type, and compact summary.

Tree output shape with branching:

```text
79d4e93e user: Help me write a small jq-based script...
├─ ab4e0c01 assistant: [thinking] [tool: read]
│  └─ 0eb932a9 user: What else should this script do?
└─ d66116fb user: I prefer TypeScript over jq.
   └─ › ea28b2b5 assistant: Agreed. Let's make this `pictl format`...
[cursor: ea28b2b5]
```

The current leaf line is marked with `›`, and tree output ends with a cursor line containing the input `leafId`.

Formatted text ends with exactly one trailing newline when there is at least one output line. Empty formatted output is the empty string.

Truncation uses the single Unicode ellipsis character `…`. Width-limited one-line summaries are truncated to fit within the configured width, including the ellipsis.

Line counts count newline-separated text lines after joining text content. Byte counts use UTF-8 byte length.

## Tree filter behavior

Tree filter predicates are normative behavior, not implementation hints.

- `conversation`: show only message entries whose role is `user` or `assistant`. User messages are always shown. Assistant messages are shown when they have text content, contain at least one `toolCall` content block, have `stopReason === "aborted"`, have an error message, or are the current leaf. Thinking-only assistant messages are hidden unless they satisfy one of those conditions.
- `pi-default`: mirror pi TreeSelector `default`: hide settings/bookkeeping entries (`label`, `custom`, `model_change`, `thinking_level_change`, `session_info`); hide assistant messages with only tool calls and no text unless current/error/aborted; otherwise show entries.
- `pi-no-tools`: mirror pi TreeSelector `no-tools`: apply `pi-default`, then also hide tool result messages.
- `pi-user-only`: mirror pi TreeSelector `user-only`: show only user message entries.
- `pi-labeled-only`: mirror pi TreeSelector `labeled-only`: show only tree nodes with a label.
- `pi-all`: mirror pi TreeSelector `all`: show every entry that passes the assistant tool-call-only suppression rule.

The `pi-*` predicates are adapted from pi's TreeSelector implementation. Source references that must appear in implementation comments near copied/adapted logic:

```text
repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
local reference: /home/anton/git/earendil-works/pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts
```

## Flag validation

- `--max-tool-arg-chars`, `--max-error-lines`, and `--width` must parse as positive integers.
- Invalid positive integer flags throw `UsageError` with message `invalid positive integer value: <input>`.

## Type Design

### `src/core/stream-types.ts`

This module extracts stream record types currently local to `src/core/streaming.ts` so formatting code can reuse them without duplicating schema definitions.

```ts
import type { RpcResponse } from "@geraschenko/pi-coding-agent";
import type { SocketEvent } from "./pi-socket-client.ts";

export type GetMessagesData = Extract<
  RpcResponse,
  { command: "get_messages"; success: true }
>["data"];

export type AgentMessage = GetMessagesData["messages"][number];

export interface StreamCursorRecord {
  readonly type: "pictl_cursor";
  readonly sessionId: string | null;
  readonly entryId: string | null;
}

export interface StreamMessageRecord {
  readonly type: "message";
  readonly message: AgentMessage;
}

export type StreamControlKind =
  | "compaction"
  | "tree_navigated"
  | "session_changed"
  | "queue_update";

export interface StreamControlRecord {
  readonly type: "control";
  readonly control: {
    readonly kind: StreamControlKind;
    readonly event: SocketEvent;
  };
}

export type MessageStreamRecord =
  | StreamMessageRecord
  | StreamControlRecord
  | StreamCursorRecord;
```

`src/core/streaming.ts` imports these symbols instead of defining local equivalents.

### `src/format/types.ts`

```ts
import type { SessionEntry, SessionTreeNode } from "@geraschenko/pi-coding-agent";

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
 * repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
 * local reference: /home/anton/git/earendil-works/pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts
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
```

### `src/format/text.ts`

```ts
export function oneLine(text: string): string;

export function truncateText(text: string, maxChars: number): string;

export function countLines(text: string): number;

export function extractTextContent(content: unknown): string;

export function summarizeUnknown(value: unknown, maxChars: number): string;

export function summarizeContentBlock(block: unknown): string;
```

### `src/format/messages.ts`

```ts
import type { MessageStreamRecord } from "../core/stream-types.ts";
import type { MessageFormatOptions } from "./types.ts";

export const DEFAULT_MESSAGE_FORMAT_OPTIONS: MessageFormatOptions;

export interface MessageFormatState {
  lastNoisyControl: string | undefined;
}

export function formatMessageRecords(
  records: Iterable<MessageStreamRecord>,
  options?: Partial<MessageFormatOptions>,
): string;

export function formatMessageRecord(
  record: MessageStreamRecord,
  options: MessageFormatOptions,
  state: MessageFormatState,
): string | undefined;
```

`formatMessageRecords` calls `formatMessageRecord` for each record and joins emitted strings. Cursor records are rendered as `[cursor: <entryId>]` when `entryId` is non-null and `[cursor: null]` otherwise.

### `src/format/entries.ts`

```ts
import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { EntriesInput, EntryFormatOptions } from "./types.ts";

export const DEFAULT_ENTRY_FORMAT_OPTIONS: EntryFormatOptions;

export function formatEntriesInput(
  input: EntriesInput,
  options?: Partial<EntryFormatOptions>,
): string;

export function formatEntryJsonl(
  entries: Iterable<SessionEntry>,
  options?: Partial<EntryFormatOptions>,
): string;

export function formatEntry(
  entry: SessionEntry,
  options: EntryFormatOptions,
): string;
```

`formatEntriesInput` and `formatEntryJsonl` call `formatEntry` for each entry in input order.

### `src/format/tree.ts`

```ts
import type { SessionTreeNode } from "@geraschenko/pi-coding-agent";
import type { TreeFilterMode, TreeFormatOptions, TreeInput } from "./types.ts";

export const DEFAULT_TREE_FORMAT_OPTIONS: TreeFormatOptions;

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
}

export function formatTreeInput(
  input: TreeInput,
  options?: Partial<TreeFormatOptions>,
): string;

export function flattenTreeForFormat(
  roots: readonly SessionTreeNode[],
  currentLeafId: string | null,
  filter: TreeFilterMode,
): readonly FlatTreeNode[];

export function formatTreeNodeLine(
  flatNode: FlatTreeNode,
  options: TreeFormatOptions,
): string;
```

`formatTreeInput` passes `input.leafId` to `flattenTreeForFormat`, calls `formatTreeNodeLine` for each flat node, and appends `[cursor: <leafId>]`.

Any tree flattening, filtering, connector, or entry-summary logic adapted from pi must have explicit comments naming the source file:

```text
repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
local reference: /home/anton/git/earendil-works/pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts
```

### `src/format/input.ts`

```ts
import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { MessageStreamRecord, StreamCursorRecord } from "../core/stream-types.ts";
import type { CommandContext } from "../core/targets.ts";
import type { EntriesInput, TreeInput } from "./types.ts";

export async function readInputFile(
  context: CommandContext,
  file: string | undefined,
): Promise<string>;

export function parseJsonInput(input: string): unknown;

export function parseJsonlInput(input: string): readonly unknown[];

export function decodeMessageStreamRecord(value: unknown): MessageStreamRecord;

export function decodeStreamCursorRecord(value: unknown): StreamCursorRecord;

export function decodeSessionEntry(value: unknown): SessionEntry;

export function decodeEntriesInput(value: unknown): EntriesInput;

export function decodeTreeInput(value: unknown): TreeInput;

export function parseEntriesInput(input: string): EntriesInput | readonly SessionEntry[];

export function parseTreeInput(input: string): TreeInput;

export function parseMessageRecords(input: string): readonly MessageStreamRecord[];
```

The `decode*` functions validate unknown input and return typed values. Invalid input throws `UsageError` with a useful message so the command exits non-zero without crashing. `parseEntriesInput` accepts and ignores `pictl_cursor` records in JSONL input; non-cursor records must decode as `SessionEntry`.

### `src/format/command.ts`

```ts
import type { RouteMap } from "@stricli/core";
import {
  booleanFlag,
  commandNoTarget,
  enumFlag,
  parsedFlag,
  stringArg,
  type InferFlags,
} from "../core/cli.ts";
import type { CommandContext } from "../core/targets.ts";
import type { ToolResultDisplayMode, TreeFilterMode } from "./types.ts";

const messageFormatFlags = {
  toolResults: enumFlag("Tool result display (summary|none|full)", [
    "summary",
    "none",
    "full",
  ]),
  maxToolArgChars: parsedFlag(
    "Maximum tool argument characters",
    parsePositiveInteger,
    "count",
  ),
  maxErrorLines: parsedFlag(
    "Maximum failed tool result snippet lines",
    parsePositiveInteger,
    "count",
  ),
};
type MessageFormatFlags = InferFlags<typeof messageFormatFlags>;

export async function formatMessagesCommand(
  this: CommandContext,
  flags: MessageFormatFlags,
  file?: string,
): Promise<void>;

const messagesCommand = commandNoTarget<MessageFormatFlags, [string | undefined]>({
  common: true,
  docs: { brief: "format pictl message JSONL" },
  parameters: {
    flags: messageFormatFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatMessagesCommand,
});

const entryFormatFlags = {
  timestamps: booleanFlag("Show timestamps"),
  full: booleanFlag("Show full entry details"),
};
type EntryFormatFlags = InferFlags<typeof entryFormatFlags>;

export async function formatEntriesCommand(
  this: CommandContext,
  flags: EntryFormatFlags,
  file?: string,
): Promise<void>;

const entriesCommand = commandNoTarget<EntryFormatFlags, [string | undefined]>({
  common: true,
  docs: { brief: "format pictl entries JSON or JSONL" },
  parameters: {
    flags: entryFormatFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatEntriesCommand,
});

const treeFormatFlags = {
  filter: enumFlag("Tree filter", [
    "conversation",
    "pi-default",
    "pi-no-tools",
    "pi-user-only",
    "pi-labeled-only",
    "pi-all",
  ]),
  width: parsedFlag("Output width", parsePositiveInteger, "columns"),
};
type TreeFormatFlags = InferFlags<typeof treeFormatFlags>;

export async function formatTreeCommand(
  this: CommandContext,
  flags: TreeFormatFlags,
  file?: string,
): Promise<void>;

const treeCommand = commandNoTarget<TreeFormatFlags, [string | undefined]>({
  common: true,
  docs: { brief: "format pictl tree JSON" },
  parameters: {
    flags: treeFormatFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatTreeCommand,
});

export function parsePositiveInteger(input: string): number;

export const formatRoute: RouteMap<CommandContext>;
```

Flag specs and inferred flag types are intentionally adjacent to their commands, following the existing repo convention.

`formatMessagesCommand` calls `readInputFile`, `parseMessageRecords`, and `formatMessageRecords`.

`formatEntriesCommand` calls `readInputFile`, `parseEntriesInput`, and either `formatEntriesInput` or `formatEntryJsonl` depending on parsed shape.

`formatTreeCommand` calls `readInputFile`, `parseTreeInput`, and `formatTreeInput`.

`formatRoute` is a no-target route map with subcommands `messages`, `entries`, and `tree`. `src/core/app.ts` imports `formatRoute` from `../format/command.ts` and includes it in the top-level routes as `format: formatRoute`.

## Edge cases

- Empty input behavior is subcommand-specific: `format messages` treats empty input as an empty JSONL stream and emits empty output; `format entries` treats empty input as an empty JSONL stream and emits empty output; `format tree` requires a JSON object and reports a parse error for empty input.
- Invalid JSON or JSONL should produce a command error rather than partial misleading output.
- Unknown message content blocks should not crash formatting; they should render as compact placeholders using `summarizeContentBlock`.
- Entry input that is not a valid `SessionEntry` is invalid, except for `pictl_cursor` records in entry JSONL.
- Message formatting is defined for the stream record types exported from `src/core/stream-types.ts`; invalid or unsupported records should produce a command error rather than misleading output.
- Entry JSONL input may include `pictl_cursor` records from bounded `pictl tail --type entries`; these cursor records are ignored.
- Repeated noisy control records in message streams may be coalesced only for `queue_update` records with identical rendered text and repeated `compaction_start` records. Session changes, tree navigation, and compaction end records are always shown.
- Tool call arguments may be large and must be truncated according to `maxToolArgChars`.
- Full successful tool results are printed only when `--tool-results full` is selected.
- Failed tool result snippets are printed in `summary` mode and in `full` mode; `none` mode suppresses all tool results.

## Non-goals

- Do not change output of existing pictl commands in this spec.
- Do not remove or modify `scripts/pictl-render` in this spec.
- Do not add ANSI styling in this spec.
- Do not make live daemon calls from `pictl format`.
- Do not implement interactive tree navigation in this spec.

# IMPLEMENTATION IDEAS

- Put formatter implementation under `src/format/`, outside `src/core/`, because it is a helper utility layer rather than core daemon/control logic.
- Add a top-level `format` route map to the existing app routes.
- Keep formatting functions pure: they should transform parsed input into text and should not mutate daemon/session state.
- Extract stream record types from `src/core/streaming.ts` into `src/core/stream-types.ts` to avoid schema duplication.
- Use TypeScript rather than jq because formatting will become configurable and stateful.
- Use `/tmp/pictl-tail`, `/tmp/pictl-entries`, `/tmp/pictl-tree`, and `/tmp/pi-tree-example` as exploratory examples while designing tests.
- Add committed test fixtures under an appropriate test fixture directory rather than depending on `/tmp` files.
- Tree output should prioritize copyable entry ids for `navigate-tree` workflows and for understanding explored branches.
- Tree formatting should adapt pi's tree selector behavior where useful, but copied/adapted behavior must include explicit comments pointing to the source file:
  `/home/anton/git/earendil-works/pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts`.
- Pi's tree selector has filter modes `default | no-tools | user-only | labeled-only | all`; pictl exposes pi-aligned versions as `pi-default | pi-no-tools | pi-user-only | pi-labeled-only | pi-all` plus pictl-specific `conversation`.
- Tree filter predicates are specified normatively in SPEC. Implementation comments near copied/adapted tree behavior must cite pi's TreeSelector source.
- The current jq prototype is useful for comparing `format messages` output, but remains untouched.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Derisked scope: add `src/format/` and `pictl format`; do not change existing subcommand output.
- [x] Derisked naming: use `format`, not `view` or `render`.
- [x] Derisked input forms: message JSONL, entries JSON or JSONL, tree JSON.
- [x] Derisked defaults: tree defaults to conversation-only user/assistant messages; entries show all entries; message tool results summarize by default.
- [x] Derisked type design: no `FormatMode`, no id display mode, no duplicated stream record schema in `src/format/types.ts`.
- [x] Derisked maintainability requirement: comments must explicitly identify pi source for copied/adapted tree behavior.
- [x] Critiqued and revised spec: removed unsupported unknown-stream-record behavior so message formatting stays aligned with the extracted core stream types.
- [x] Incorporated reviewer feedback approved by user: context-aware stdin reading, parser validation functions, cursor handling for entry JSONL, exact defaults, exact newline/truncation/counting basics, and explicit app integration.
- [x] Incorporated second reviewer pass: moved tree filter predicates into SPEC and added positive integer validation.
- [x] Incorporated user review comments from `3ed6088`: removed `errors` tool-result mode, made failed snippets part of default `summary`, changed entries full output flag to `--full`, removed tree `--current-leaf`, removed parent id from default entry examples, expanded tree branching/cursor example, removed unknown-entry fallback types, removed separate tool-call lookup parameters, replaced assertion functions with decode functions, and specified command flags adjacent to command definitions.
- [x] Re-ran reviewer after user review comment incorporation and fixed the Stricli optional positional parameter design.
- [ ] Implement stream type extraction.
- [ ] Implement formatter modules.
- [ ] Add `pictl format` route.
- [ ] Add tests and fixtures.
