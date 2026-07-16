# SPEC

## Problem

`pictl` exposes useful raw JSON and JSONL outputs, but coding agents often need compact, readable text views of that data. We want a new formatting layer that converts raw pictl output into concise, navigation-friendly text without changing existing pictl command output.

This spec adds `src/format/` and a new `pictl format` command family. It does not change the output of existing pictl subcommands except for one cleanup: `pictl tail --type entries` and `pictl prompt --type entries` stop emitting a trailing `pictl_cursor` record because entry records already carry the relevant entry ids.

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
- No existing pictl subcommand output changes in this spec except removing the trailing `pictl_cursor` from entry-mode `tail` and `prompt` streams.
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
--max-tool-arg-chars <num>
--max-error-lines <num>
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
--filter conversation|pi-default|pi-no-tools|pi-user-only|pi-labeled-only|pi-all
--width <num>
```

Defaults:

- timestamps hidden unless `--timestamps` is passed
- entries are shown as summaries unless `--full` is passed
- entries are unfiltered unless `--filter` is passed
- `--width 120`

### `pictl format tree`

Flags:

```bash
--filter conversation|pi-default|pi-no-tools|pi-user-only|pi-labeled-only|pi-all
--width <num>
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
79d4e93e user: Help me write a small jq-based script…
├─ ab4e0c01 assistant: [thinking] [tool: read]
│  ├─ 0eb932a9 user: What else should this script do?
│  ├─ 932a90eb assistant: maybe a barrel roll
│  └─ 2a90eb93 user: good idea
├─ d66116fb user: I prefer TypeScript over jq.
└─ * ea28b2b5 assistant: Agreed. Let's make this `pictl format`…
[cursor: ea28b2b5]
```

The current leaf line is marked with `*`. Other visible entries on the active path are marked with `•`. Tree output ends with a cursor line containing the input `leafId`.

Formatted text ends with exactly one trailing newline when there is at least one output line. Empty formatted output is the empty string.

Truncation uses the single Unicode ellipsis character `…`. Width-limited one-line summaries are truncated to fit within the configured width, including the ellipsis. For tree output, `--width` applies to the full rendered tree line, including connector/current marker, spaces, entry id, role/type prefix, and summary text. The available summary length therefore decreases as indentation/prefix length increases.

Line counts count newline-separated text lines after joining text content. Byte counts use UTF-8 byte length.

Tree indentation follows pi tree-selector semantics: consecutive visible nodes may remain at the same indentation level even when they are in a parent-child relationship. Indentation increases only at root grouping or branch points so long single-branch sessions do not drift right linearly.

## Filter behavior

Filter predicates are normative behavior for both `format entries --filter` and `format tree --filter`, not implementation hints.

- `conversation`: show message entries whose role is `user` or `assistant`, plus compaction entries. User messages are always shown. Assistant messages are shown when they have text content, have `stopReason === "aborted"`, have an error message, or are the current leaf. Thinking-only and tool-only assistant messages are hidden unless they satisfy one of those conditions. Compaction entries are shown as `[compaction: <num>k tokens]` using `tokensBefore`, matching pi's tree view.
- `pi-default`: mirror pi TreeSelector `default`: hide settings/bookkeeping entries (`label`, `custom`, `model_change`, `thinking_level_change`, `session_info`); hide assistant messages with only tool calls and no text unless current/error/aborted; otherwise show entries.
- `pi-no-tools`: mirror pi TreeSelector `no-tools`: apply `pi-default`, then also hide tool result messages.
- `pi-user-only`: mirror pi TreeSelector `user-only`: show only user message entries.
- `pi-labeled-only`: mirror pi TreeSelector `labeled-only`: show only tree nodes with a label.
- `pi-all`: mirror pi TreeSelector `all`: show every entry that passes the assistant tool-call-only suppression rule.

The `pi-*` predicates are adapted from pi's TreeSelector implementation. Source references that must appear in implementation comments near copied/adapted logic:

```text
pi repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
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

### `src/core/streaming.ts`

Existing `streamTail` and `streamPrompt` behavior changes only for entry-mode streams: `outputType === "entries"` and prompt `type === "entries"` no longer write a trailing `pictl_cursor` record. Message-mode streams keep cursor behavior unchanged.

### `src/format/types.ts`

```ts
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

import type { FilterMode } from "./filter.ts";

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

export interface TreeInput {
  readonly tree: readonly SessionTreeNode[];
  readonly leafId: string | null;
}
```

### `src/format/filter.ts`

```ts
import type { SessionEntry } from "@geraschenko/pi-coding-agent";

export const FILTER_MODES: readonly [
  "conversation",
  "pi-default",
  "pi-no-tools",
  "pi-user-only",
  "pi-labeled-only",
  "pi-all",
];

export type FilterMode = (typeof FILTER_MODES)[number];

export interface FilterNode {
  readonly entry: SessionEntry;
  readonly label?: string;
}

export function passesFilter(
  node: FilterNode,
  currentLeafId: string | null,
  filter: FilterMode,
): boolean;
```

`passesFilter` contains shared filter behavior for `format entries` and `format tree`. Pi-adapted filtering logic must keep the pi TreeSelector source comment near the implementation.

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

export function formatMessageRecords(
  records: Iterable<MessageStreamRecord>,
  options?: Partial<MessageFormatOptions>,
): string;

export function formatMessageRecord(
  record: MessageStreamRecord,
  options: MessageFormatOptions,
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

export function summarizeEntry(entry: SessionEntry, maxChars?: number): string;
```

`formatEntriesInput` and `formatEntryJsonl` call `formatEntry` for each entry in input order.

### `src/format/tree-layout.ts` and `src/format/tree.ts`

The generic tree-layout interface and its extraction from `tree.ts` are
specified by [tree-layout-extraction.md](tree-layout-extraction.md), which
supersedes this spec's original `FlatTreeNode`, `flattenTreeForFormat`, and
exported `formatTreeNodeLine` design. The current shared interface exports
`LayoutNode<P>`, `TreeGutter`, `FlatLayoutNode<P>`, `flattenVisibleTree`, and
`treePrefix` from the import-free `src/format/tree-layout.ts` module.

`src/format/tree.ts` retains the pi-specific interface:

```ts
import type { TreeFormatOptions, TreeInput } from "./types.ts";

export const DEFAULT_TREE_FORMAT_OPTIONS: TreeFormatOptions;

export function formatTreeInput(
  input: TreeInput,
  options?: Partial<TreeFormatOptions>,
): string;
```

`formatTreeInput` adapts pi session nodes to `LayoutNode<SessionTreeNode>`,
calls `flattenVisibleTree`, renders each flat node with private pi-specific
line rendering, and appends `[cursor: <leafId>]`.

Any tree flattening, filtering, connector, or entry-summary logic adapted
from pi must have explicit comments naming the source file:

```text
pi repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
```

### `src/format/input.ts`

```ts
import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import type { MessageStreamRecord } from "../core/stream-types.ts";
import type { CommandContext } from "../core/targets.ts";
import type { EntriesInput, TreeInput } from "./types.ts";

export async function readInputFile(
  context: CommandContext,
  file: string | undefined,
): Promise<string>;

export function parseJsonInput(input: string): unknown;

export function parseJsonlInput(input: string): readonly unknown[];

export function decodeMessageStreamRecord(value: unknown): MessageStreamRecord;

export function decodeSessionEntry(value: unknown): SessionEntry;

export function decodeEntriesInput(value: unknown): EntriesInput;

export function decodeTreeInput(value: unknown): TreeInput;

export function parseEntriesInput(
  input: string,
): EntriesInput | readonly SessionEntry[];

export function parseTreeInput(input: string): TreeInput;

export function parseMessageRecords(
  input: string,
): readonly MessageStreamRecord[];
```

The `decode*` functions validate unknown input and return typed values. Invalid input throws `UsageError` with a useful message so the command exits non-zero without crashing. `parseEntriesInput` requires every JSONL record to decode as `SessionEntry`; `pictl_cursor` records are invalid for entry formatting.

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
import { FILTER_MODES } from "./filter.ts";
import type { ToolResultDisplayMode } from "./types.ts";

const formatMessagesFlags = {
  toolResults: enumFlag("Tool result display (summary|none|full)", [
    "summary",
    "none",
    "full",
  ]),
  maxToolArgChars: parsedFlag(
    "Maximum tool argument characters",
    parsePositiveInteger,
    "num",
  ),
  maxErrorLines: parsedFlag(
    "Maximum failed tool result snippet lines",
    parsePositiveInteger,
    "num",
  ),
};
type FormatMessagesFlags = InferFlags<typeof formatMessagesFlags>;

export async function formatMessages(
  this: CommandContext,
  flags: FormatMessagesFlags,
  file?: string,
): Promise<void>;

const formatMessagesCommand = commandNoTarget<
  FormatMessagesFlags,
  [string | undefined]
>({
  common: true,
  docs: { brief: "format pictl message JSONL" },
  parameters: {
    flags: formatMessagesFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatMessages,
});

const formatEntriesFlags = {
  timestamps: booleanFlag("Show timestamps"),
  full: booleanFlag("Show full entry details"),
  filter: enumFlag("Entry filter", FILTER_MODES),
  width: parsedFlag("Output width", parsePositiveInteger, "num"),
};
type FormatEntriesFlags = InferFlags<typeof formatEntriesFlags>;

export async function formatEntries(
  this: CommandContext,
  flags: FormatEntriesFlags,
  file?: string,
): Promise<void>;

const formatEntriesCommand = commandNoTarget<
  FormatEntriesFlags,
  [string | undefined]
>({
  common: true,
  docs: { brief: "format pictl entries JSON or JSONL" },
  parameters: {
    flags: formatEntriesFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatEntries,
});

const formatTreeFlags = {
  filter: enumFlag("Tree filter", FILTER_MODES),
  width: parsedFlag("Output width", parsePositiveInteger, "num"),
};
type FormatTreeFlags = InferFlags<typeof formatTreeFlags>;

export async function formatTree(
  this: CommandContext,
  flags: FormatTreeFlags,
  file?: string,
): Promise<void>;

const formatTreeCommand = commandNoTarget<
  FormatTreeFlags,
  [string | undefined]
>({
  common: true,
  docs: { brief: "format pictl tree JSON" },
  parameters: {
    flags: formatTreeFlags,
    positional: {
      kind: "tuple",
      parameters: [
        { ...stringArg("Input file or - for stdin", "file"), optional: true },
      ],
    },
  },
  func: formatTree,
});

export function parsePositiveInteger(input: string): number;

export const formatRoute: RouteMap<CommandContext>;
```

Flag specs and inferred flag types are intentionally adjacent to their commands, following the existing repo convention.

`formatMessages` calls `readInputFile`, `parseMessageRecords`, and `formatMessageRecords`.

`formatEntries` calls `readInputFile`, `parseEntriesInput`, and either `formatEntriesInput` or `formatEntryJsonl` depending on parsed shape.

`formatTree` calls `readInputFile`, `parseTreeInput`, and `formatTreeInput`.

`formatRoute` is a no-target route map with subcommands `messages`, `entries`, and `tree`. `src/core/app.ts` imports `formatRoute` from `../format/command.ts` and includes it in the top-level routes as `format: formatRoute`.

## Edge cases

- Empty input behavior is subcommand-specific: `format messages` treats empty input as an empty JSONL stream and emits empty output; `format entries` treats empty input as an empty JSONL stream and emits empty output; `format tree` requires a JSON object and reports a parse error for empty input.
- Invalid JSON or JSONL should produce a command error rather than partial misleading output.
- Unknown message content blocks should not crash formatting; they should render as compact placeholders using `summarizeContentBlock`.
- Message formatting is defined for the stream record types exported from `src/core/stream-types.ts`; invalid or unsupported records should produce a command error rather than misleading output.
- Entry input that is not a valid `SessionEntry` is invalid.
- Entry JSONL input must not include `pictl_cursor` records. Entry-mode `tail` and `prompt` streams no longer emit trailing cursor records.
- Control records in message streams are rendered individually. Tree navigation controls show old and new leaf ids; session changes show session id and session file when present; queue updates show steering and follow-up queue lengths from the actual pi event fields.
- Tool call arguments may be large and must be truncated according to `maxToolArgChars`.
- Full successful tool results are printed only when `--tool-results full` is selected.
- Failed tool result snippets are printed in `summary` mode and in `full` mode; `none` mode suppresses all tool results.

## Non-goals

- Do not change output of existing pictl commands in this spec except removing the trailing `pictl_cursor` from entry-mode `tail` and `prompt` streams.
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
- Tree formatting should adapt pi's tree selector behavior where useful, but copied/adapted behavior must include explicit comments pointing to pi repo-relative source file `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`.
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
- [x] Incorporated user review comments from `c5fe426`: documented pi-style non-linear tree indentation, made tree width include the full rendered tree line, removed local absolute pi paths, added removal of trailing entry-mode cursors from `tail`/`prompt`, renamed command symbols to `formatMessages*`/`formatEntries*`/`formatTree*`, and changed numeric placeholders to `num`.
- [x] Re-ran reviewer after user review comment incorporation and fixed the Stricli optional positional parameter design.
- [x] Implement stream type extraction.
- [x] Add initial `pictl format` route/type skeleton and confirmed type structure compiles before filling formatter behavior.
- [x] Implement formatter modules.
- [x] Replace formatter stubs with full behavior.
- [x] Add tests and fixtures.
- [x] Add regression coverage for omitted trailing cursors in entry-mode prompt streams.
- [x] Run `npm run build` successfully.
- [x] Run `npm run presubmit` successfully.
- [x] Supersede the original tree type design with the generic interface in
      `tree-layout-extraction.md`.

## Implementation-Time Decisions

### Preserve raw stream final cursor behavior

Decided: only entry-mode `tail`/`prompt` streams omit the trailing `pictl_cursor`; raw and message streams keep their previous cursor behavior.

Rationale: the spec's sole allowed existing-output change is removal of entry-mode trailing cursors. Restricting the condition avoids an accidental raw-stream output change.

### Treat single-object entry input without `entries` as JSONL

Decided: `parseEntriesInput` recognizes get-entries JSON only when the parsed object has an `entries` property; otherwise it parses the input as JSONL session entries.

Rationale: JSONL entry streams are also line-oriented JSON objects and may contain a single entry. A leading `{` alone is not enough to distinguish get-entries JSON from JSONL.

### Tighten decode-time validation without duplicating runtime schemas

Decided: format input decoders validate top-level stream record shape, known session entry types, required entry fields, message roles, and recursive tree node structure, then cast to the pi SDK types.

Rationale: pictl needs useful command errors for bad formatter input, but pi does not export runtime validators for these TypeScript-only types. The local checks avoid accepting obvious non-entries such as `pictl_cursor` while keeping the schema copy small.

### Conversation tree hides tool-only assistant nodes

Decided: `--filter conversation` hides tool-only and thinking-only assistant messages unless they are the current leaf, aborted, or errored.

Rationale: the pi `/tree` view is meant to show conversation structure, not every assistant tool-dispatch step. Showing tool-only assistant nodes produced long runs of low-value rows and `(no content)` summaries.

### Tree connector recalculation uses the full flattened tree

Decided: filtered tree connector recalculation uses the full flattened tree for parent lookup and only the filtered tree for visible ids.

Rationale: using only filtered nodes made hidden intermediate entries look like roots, which removed or misaligned branch connectors.

### Mark active path entries

Decided: formatted tree output marks non-current visible active-path entries with `•` and the current leaf with `*`.

Rationale: this mirrors the useful orientation signal from pi's interactive `/tree` view while preserving the spec's copy-friendly current-leaf marker.

### Include compaction token boundaries in conversation trees

Decided: `conversation` and `pi-default` tree views include compaction entries rendered as `[compaction: <num>k tokens]` from `tokensBefore`.

Rationale: pi's `/tree` view includes these token-boundary markers, and they are important context when reading a compacted conversation branch.

### Use actual pi event fields for control records

Decided: message control formatting uses `tree_navigated.oldLeafId/newLeafId`, `session_changed.sessionId/sessionFile`, and `queue_update.steering/followUp` from pi's event types. Removed `MessageFormatState` because control coalescing was removed.

Rationale: made-up fallback fields were misleading, and once every control record is rendered individually there is no formatter state to maintain.

### Share filter predicates between entries and tree

Decided: move filter modes and `passesFilter` into `src/format/filter.ts`, rename `TreeFilterMode` to `FilterMode`, and have both `format entries --filter` and `format tree --filter` use the same predicates.

Rationale: the filter semantics should not drift between entry-list and tree views. Entries remain unfiltered by default to preserve the existing “show all entries” behavior, but `--filter` lets users request the same filtered views as tree formatting.

### Add width limiting to entries

Decided: `format entries --width` limits the full rendered entry line and defaults to 120 columns.

Rationale: entry output now has the same copyable compactness control as tree output; width applies to id/type/timestamp/full suffix as well as summary text.
