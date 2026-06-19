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
- Message formatting summarizes successful tool results by default. Failed tool result snippets are shown when `--tool-results errors` is selected. `--tool-results full` prints full tool results, successful or failed.
TDC: I want to see short snippets for failed tool results by default, so we only need summary|none|full.
- Entry formatting shows all entries by default, including model changes, thinking level changes, compactions, branch summaries, labels, custom entries, messages, tool results, and any future entry type with valid base fields.
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
--tool-results summary|errors|none|full
--max-tool-arg-chars <count>
--max-error-lines <count>
```

Defaults:

- `--tool-results summary`
- `--max-tool-arg-chars 120`
- `--max-error-lines 10`

### `pictl format entries`

Flags:

```bash
--timestamps
--messages summary|full
```
TDC: --messages is a confusing flag name, because it cognitively overlaps with `pictl format messages`. Let's make the default to show summaries and use --full to show full entries.

Defaults:

- timestamps hidden unless `--timestamps` is passed
- `--messages summary`

### `pictl format tree`

Flags:

```bash
--filter conversation|pi-default|pi-no-tools|pi-user-only|pi-labeled-only|pi-all
--current-leaf <entry-id>
--width <columns>
```
TDC: what does --current-leaf do? It's confusing that this exists, since _display_ can't set the current leaf.

Defaults:

- `--filter conversation`
- current leaf taken from input `leafId` when present
- `--width 120`

## Examples

Message stream input:

```jsonl
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"toolCall","name":"read","arguments":{"path":"README.md"}}]}}
{"type":"message","message":{"role":"toolResult","toolName":"read","content":[{"type":"text","text":"large output"}],"isError":false}}
```

Formatted message output shape:

```text
== user ==
Hello

== assistant ==
[thinking]
[tool:read path: README.md]
[read:ok 1 lines, 12 bytes]
```
TDC: note that when the stream/file includes a cursor at the end, message formatting should also include the entry id from that cursor at the end.

Entry output shape:

TDC: let's no show parentId by default
```text
79d4e93e user       Help me write a small jq-based script...
ab4e0c01 assistant  [thinking] [tool: read]
0eb932a9 toolResult read ok, 63 lines, 2953 bytes
```

Tree output shape:
TDC: this needs elaboration. You need to show an example where there's branching
```text
79d4e93e user: Help me write a small jq-based script...
ab4e0c01 assistant: [thinking] [tool: read]
```
TDC: Since this always comes from get-tree, we always get a leafId. That leafId should be include at the end of the tree output as a cursor, or I guess we can use a little pointer or "*" or ">" or something.

Formatted text ends with exactly one trailing newline when there is at least one output line. Empty formatted output is the empty string.

Truncation uses the single Unicode ellipsis character `…`. Width-limited one-line summaries are truncated to fit within the configured width, including the ellipsis.

Line counts count newline-separated text lines after joining text content. Byte counts use UTF-8 byte length.

Entry rows display `null` parent ids as `root`.

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

export interface UnknownSessionEntry {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp?: string;
  readonly [key: string]: unknown;
}

export type FormatSessionEntry = SessionEntry | UnknownSessionEntry;

// TDC: why are both of these needed? Why exactly do we even have a type for unknown session entries? If something doesn't conform to SessionEntry, shouldn't we just do our best to display it somehow? But the expectation is that all entries _will_ conform to SessionEntry, right? If not, we should probably emit an error or have non-zero exit code, because somebody is using this for something other than entries. I guess `tail --type entries` does return a pictl_cursor at the end, so we have to tolerate that. Maybe it _shouldn't_ return a pictl_cursor at the end, since the entries already have the relevant cursor information. That sounds cleanest to me.
export function isKnownSessionEntry(entry: FormatSessionEntry): entry is SessionEntry;

export function isUnknownSessionEntry(
  entry: FormatSessionEntry,
): entry is UnknownSessionEntry;

// isKnownSessionEntry returns true only for entries whose type is a current
// known SessionEntry variant and whose shape is valid for that variant.
// isUnknownSessionEntry returns true only for entries with valid base fields
// (type, id, parentId) whose type is not a current known SessionEntry variant.
// A malformed entry using a known type string is invalid input, not an
// UnknownSessionEntry.
export type ToolResultDisplayMode = "summary" | "errors" | "none" | "full";

export interface MessageFormatOptions {
  readonly maxToolArgChars: number;
  readonly toolResults: ToolResultDisplayMode;
  readonly maxErrorLines: number;
}

export interface EntryFormatOptions {
  readonly timestamps: boolean;
  readonly messages: "summary" | "full";
}

/**
 * Tree filter modes.
 *
 * `conversation` is pictl-specific and means only user and assistant message
 * entries are shown.
 *
 * `pi-*` modes are intentionally aligned with pi's TreeSelector FilterMode from:
 * /home/anton/git/earendil-works/pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts
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
  readonly currentLeafId: string | null | undefined;
  readonly width: number;
}

export interface EntriesInput {
  readonly entries: readonly FormatSessionEntry[];
  readonly leafId?: string | null;
}

export interface TreeInput {
  readonly tree: readonly SessionTreeNode[];
  readonly leafId?: string | null;
}

export interface ToolCallInfo {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
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

`formatMessageRecords` calls `formatMessageRecord` for each record and joins emitted strings.

### `src/format/entries.ts`

```ts
import type { EntriesInput, EntryFormatOptions, FormatSessionEntry, ToolCallInfo } from "./types.ts";

export const DEFAULT_ENTRY_FORMAT_OPTIONS: EntryFormatOptions;

export function formatEntriesInput(
  input: EntriesInput,
  options?: Partial<EntryFormatOptions>,
): string;

export function formatEntryJsonl(
  entries: Iterable<FormatSessionEntry>,
  options?: Partial<EntryFormatOptions>,
): string;

export function formatEntry(
  entry: FormatSessionEntry,
  options: EntryFormatOptions,
  // TDC: tool calls are _separate_ from the entry? That doesn't look right. tool calls are part of the `content` of an entry. Why are we passing both the entry and the tool calls separately?
  toolCalls: ReadonlyMap<string, ToolCallInfo>,
): string;
```

`formatEntriesInput` and `formatEntryJsonl` materialize entries in input order, build the tool-call lookup map from assistant tool-call content blocks, then call `formatEntry` for each entry.

### `src/format/tree.ts`

```ts
import type { SessionTreeNode } from "@geraschenko/pi-coding-agent";
import type { ToolCallInfo, TreeFilterMode, TreeFormatOptions, TreeInput } from "./types.ts";

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
  currentLeafId: string | null | undefined,
  filter: TreeFilterMode,
): readonly FlatTreeNode[];

export function formatTreeNodeLine(
  flatNode: FlatTreeNode,
  options: TreeFormatOptions,
  // TDC: again, why are we passing tool calls separately? They're in the `node` already. This doesn't make sense to me.
  toolCalls: ReadonlyMap<string, ToolCallInfo>,
): string;
```

`formatTreeInput` builds the tool-call lookup map from assistant tool-call content blocks, calls `flattenTreeForFormat`, then calls `formatTreeNodeLine` for each flat node.
TDC: what is this tool-call lookup map? The toolResult message already has the name of the tool called and the result. What else do you need?

Any tree flattening, filtering, connector, or entry-summary logic adapted from pi must have explicit comments naming the source file:

```text
/home/anton/git/earendil-works/pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts
```

### `src/format/input.ts`

```ts
import type { MessageStreamRecord, StreamCursorRecord } from "../core/stream-types.ts";
import type { CommandContext } from "../core/targets.ts";
import type { EntriesInput, FormatSessionEntry, TreeInput } from "./types.ts";

export async function readInputFile(
  context: CommandContext,
  file: string | undefined,
): Promise<string>;

export function parseJsonInput(input: string): unknown;

export function parseJsonlInput(input: string): readonly unknown[];

// TDC: I'm confused about these assertions. If we see something that's not the form it should be, we should return non-zero exit status and emit a useful error, but probably should not crash. Where do you intend to use these assertions?
export function assertMessageStreamRecord(
  value: unknown,
): asserts value is MessageStreamRecord;

export function assertStreamCursorRecord(
  value: unknown,
): asserts value is StreamCursorRecord;

export function assertFormatSessionEntry(
  value: unknown,
): asserts value is FormatSessionEntry;

export function assertEntriesInput(value: unknown): asserts value is EntriesInput;

export function assertTreeInput(value: unknown): asserts value is TreeInput;

export function parseEntriesInput(input: string): EntriesInput | readonly FormatSessionEntry[];

export function parseTreeInput(input: string): TreeInput;

export function parseMessageRecords(input: string): readonly MessageStreamRecord[];
```

### `src/format/command.ts`

```ts
import type { RouteMap } from "@stricli/core";
import type { CommandContext } from "../core/targets.ts";
import type { ToolResultDisplayMode, TreeFilterMode } from "./types.ts";

// TDC: follow the convention in the rest of the repo. Everything related to a command should be as close together as possible in code, so flag interfaces go right next to the command definition. Do not put all the flag interfaces first followed by all command definitions.
export interface MessageFormatFlags {
  readonly toolResults?: ToolResultDisplayMode;
  readonly maxToolArgChars?: number;
  readonly maxErrorLines?: number;
}

export interface EntryFormatFlags {
  readonly timestamps: boolean;
  readonly messages?: "summary" | "full";
}

export interface TreeFormatFlags {
  readonly filter?: TreeFilterMode;
  readonly currentLeaf?: string;
  readonly width?: number;
}

export async function formatMessagesCommand(
  this: CommandContext,
  flags: MessageFormatFlags,
  file?: string,
): Promise<void>;

export async function formatEntriesCommand(
  this: CommandContext,
  flags: EntryFormatFlags,
  file?: string,
): Promise<void>;

export async function formatTreeCommand(
  this: CommandContext,
  flags: TreeFormatFlags,
  file?: string,
): Promise<void>;

export const formatRoute: RouteMap<CommandContext>;
```

`formatMessagesCommand` calls `readInputFile`, `parseMessageRecords`, and `formatMessageRecords`.

`formatEntriesCommand` calls `readInputFile`, `parseEntriesInput`, and either `formatEntriesInput` or `formatEntryJsonl` depending on parsed shape.

`formatTreeCommand` calls `readInputFile`, `parseTreeInput`, and `formatTreeInput`.

`formatRoute` is a no-target route map with subcommands `messages`, `entries`, and `tree`. `src/core/app.ts` imports `formatRoute` from `../format/command.ts` and includes it in the top-level routes as `format`.

## Edge cases

- Empty input behavior is subcommand-specific: `format messages` treats empty input as an empty JSONL stream and emits empty output; `format entries` treats empty input as an empty JSONL stream and emits empty output; `format tree` requires a JSON object and reports a parse error for empty input.
- Invalid JSON or JSONL should produce a command error rather than partial misleading output.
- Unknown message content blocks should not crash formatting; they should render as compact placeholders using `summarizeContentBlock`.
- Unknown future entry types with valid base fields should be represented compactly by entry id, parent id, type, and a compact JSON summary. Malformed entries using known entry type names are invalid input and should produce a command error.
- Message formatting is defined for the stream record types exported from `src/core/stream-types.ts`; invalid or unsupported records should produce a command error rather than misleading output.
- Entry JSONL input may include `pictl_cursor` records from bounded `pictl tail --type entries`; these cursor records are ignored.
- Repeated noisy control records in message streams may be coalesced only for `queue_update` records with identical rendered text and repeated `compaction_start` records. Session changes, tree navigation, and compaction end records are always shown.
- Tool call arguments may be large and must be truncated according to `maxToolArgChars`.
- Full successful tool results are printed only when `--tool-results full` is selected.
- Failed tool result snippets are printed when `--tool-results errors` is selected. Full tool results, successful or failed, are printed when `--tool-results full` is selected.

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
- [x] Incorporated reviewer feedback approved by user: context-aware stdin reading, parser assertion functions, cursor handling for entry JSONL, shared tool-call info, exact defaults, exact newline/truncation/counting basics, tree tool-call lookup, and explicit app integration.
- [x] Incorporated second reviewer pass: resolved tool-result wording, moved tree filter predicates into SPEC, added positive integer validation, and replaced entry assertions with `FormatSessionEntry` so unknown entry types render compactly.
- [x] Incorporated third reviewer pass: added `isKnownSessionEntry`/`isUnknownSessionEntry` guards for safe narrowing, made normalized tree width non-optional, defined exact conversation assistant predicate, and specified empty input behavior per subcommand.
- [x] Incorporated fourth reviewer pass: clarified that unknown entry fallback applies only to unrecognized future entry type strings with valid base fields; malformed known-type entries are invalid input.
- [ ] Implement stream type extraction.
- [ ] Implement formatter modules.
- [ ] Add `pictl format` route.
- [ ] Add tests and fixtures.
