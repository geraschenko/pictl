import type {
  AgentMessage,
  MessageStreamRecord,
} from "../core/streaming/types.ts";
import type { MessageFormatOptions } from "./types.ts";
import { formatSystemMessage } from "./system-message.ts";
import {
  contentBlocks,
  countLines,
  extractTextContent,
  hasContentBlock,
  oneLine,
  summarizeContentBlock,
  summarizeUnknown,
  truncateText,
} from "../core/text.ts";
import { DEFAULT_FORMAT_WIDTH } from "../core/constants.ts";
import { isRecord } from "../core/util.ts";

export const DEFAULT_MESSAGE_FORMAT_OPTIONS: MessageFormatOptions = {
  maxToolArgChars: DEFAULT_FORMAT_WIDTH,
  toolResults: "summary",
  maxErrorLines: 10,
};

/** Mirrors pi's own read-only tool set (`createReadOnlyTools`, pi
 *  repo-relative: packages/coding-agent/src/core/tools/index.ts); update on
 *  drift. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

const PREFERRED_ARG_KEYS = ["path", "file_path", "command", "pattern"];

function formatToolArguments(args: unknown, maxChars: number): string {
  if (!isRecord(args)) {
    return summarizeUnknown(args, maxChars);
  }
  const preferred = PREFERRED_ARG_KEYS.filter(
    (key) => args[key] !== undefined,
  ).map((key) => `${key}: ${String(args[key])}`);
  const text =
    preferred.length > 0 ? preferred.join(", ") : JSON.stringify(args);
  return truncateText(oneLine(text ?? "{}"), maxChars);
}

function formatToolCall(
  block: Record<string, unknown>,
  options: MessageFormatOptions,
): string {
  const name = typeof block.name === "string" ? block.name : "unknown";
  const args = formatToolArguments(block.arguments, options.maxToolArgChars);
  return args === "" ? `[tool:${name}]` : `[tool:${name} ${args}]`;
}

function formatToolResultText(
  toolName: string,
  isError: boolean,
  text: string,
  options: MessageFormatOptions,
): string | undefined {
  if (options.toolResults === "none") {
    return undefined;
  }
  const status = isError ? "error" : "ok";
  const summary = `[${toolName}:${status} ${countLines(text)} lines, ${Buffer.byteLength(text, "utf8")} bytes]`;
  if (options.toolResults === "summary" && !isError) {
    return summary;
  }
  const lines = text.split("\n");
  const snippet =
    options.toolResults === "summary"
      ? lines.slice(0, options.maxErrorLines).join("\n")
      : text;
  return snippet === "" ? summary : `${summary}\n${snippet}`;
}

export function optionalStringOrNumberField(
  event: unknown,
  field: string,
): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const value = event[field];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

export function stringListField(
  event: unknown,
  field: string,
): readonly string[] {
  if (!isRecord(event)) {
    return [];
  }
  const value = event[field];
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
    ? value
    : [];
}

function formatControl(record: MessageStreamRecord): string | undefined {
  if (record.type !== "control") {
    return undefined;
  }
  const event = record.control.event;
  switch (record.control.kind) {
    case "compaction":
      return event.type === "compaction_start"
        ? "[control: compaction started]"
        : "[control: compaction finished]";
    case "tree_navigated": {
      const oldLeafId = optionalStringOrNumberField(event, "oldLeafId");
      const newLeafId =
        optionalStringOrNumberField(event, "newLeafId") ?? "null";
      return oldLeafId === undefined
        ? `[control: tree navigated to ${newLeafId}]`
        : `[control: tree navigated ${oldLeafId} -> ${newLeafId}]`;
    }
    case "session_changed": {
      // Records may come from parsed JSONL (`pictl format`), so read the
      // state defensively despite the static type.
      const state = event.type === "session_changed" ? event.state : undefined;
      const sessionId = optionalStringOrNumberField(state, "sessionId");
      const sessionFile = optionalStringOrNumberField(state, "sessionFile");
      return `[control: session changed${sessionId === undefined ? "" : ` to ${sessionId}`}${sessionFile === undefined ? "" : ` ${sessionFile}`}]`;
    }
    case "queue_update": {
      const steeringCount = stringListField(event, "steering").length;
      const followUpCount = stringListField(event, "followUp").length;
      return `[control: queue update steering=${steeringCount} follow-up=${followUpCount}]`;
    }
    case "run_aborted":
      return "[control: run aborted]";
    case "model_changed": {
      const model = "model" in event ? event.model : undefined;
      const provider =
        optionalStringOrNumberField(model, "provider") ?? "unknown";
      const modelId = optionalStringOrNumberField(model, "id") ?? "unknown";
      return `[model: ${provider}/${modelId}]`;
    }
  }
}

/** A speaker header plus body; role-neutral records (control, cursor) carry
 *  no header and never affect header suppression. */
interface RenderedBlock {
  readonly header: string | undefined;
  readonly body: string;
}

function formatMessage(
  message: AgentMessage,
  options: MessageFormatOptions,
): RenderedBlock | undefined {
  switch (message.role) {
    case "system":
      return { header: "== system ==", body: formatSystemMessage(message) };
    case "user":
      return {
        header: "== user ==",
        body: extractTextContent(message.content),
      };
    case "assistant": {
      const lines: string[] = [];
      if (hasContentBlock(message.content, "thinking")) {
        lines.push("[thinking]");
      }
      for (const block of contentBlocks(message.content)) {
        if (isRecord(block) && block.type === "toolCall") {
          lines.push(formatToolCall(block, options));
        } else if (isRecord(block) && block.type === "text") {
          if (typeof block.text === "string" && block.text !== "") {
            lines.push(block.text);
          }
        } else if (isRecord(block) && block.type !== "thinking") {
          lines.push(summarizeContentBlock(block));
        }
      }
      if (message.stopReason === "aborted") {
        lines.push("[aborted]");
      }
      if (message.errorMessage !== undefined) {
        lines.push(`[error: ${message.errorMessage}]`);
      }
      return { header: "== assistant ==", body: lines.join("\n") };
    }
    case "toolResult": {
      const body = formatToolResultText(
        message.toolName,
        message.isError,
        extractTextContent(message.content),
        options,
      );
      // Tool results are user-role in the protocol but assistant-side
      // activity conceptually: they render headerless under an assistant
      // block, and reassert the assistant header after a user message.
      return body === undefined
        ? undefined
        : { header: "== assistant ==", body };
    }
    case "bashExecution":
      return {
        header: "== bash ==",
        body: `${message.command}\n[exit: ${message.exitCode ?? "unknown"}]${
          message.output === "" ? "" : `\n${message.output}`
        }`,
      };
    case "custom":
      return {
        header: `== custom:${message.customType} ==`,
        body: extractTextContent(message.content),
      };
    case "branchSummary":
      return {
        header: `== branchSummary:${message.fromId} ==`,
        body: message.summary,
      };
    case "compactionSummary":
      return { header: "== compactionSummary ==", body: message.summary };
  }
}

/** Consecutive read-only calls between bash calls, merged into per-tool
 *  clauses. */
interface CoalescedToolClauses {
  readonly kind: "tools";
  /** Tool name → rendered args in call order; insertion order is first
   *  appearance. */
  readonly toolArgs: Map<string, string[]>;
}

/** One bash call rendered on its own line (commands may contain the `;`/`,`
 *  clause separators, so they never merge into a clause list). */
interface CoalescedBashLine {
  readonly kind: "bash";
  readonly command: string;
  /** `"3L, 45B"` once the call's successful result is absorbed; undefined
   *  until then, or when `toolResults: "none"` asked to hide results. */
  resultSummary: string | undefined;
}

/** A run of coalesced thinking/read-only/bash activity, held back until a
 *  breaker or `end()` closes it (an open run is deliberately silent — any
 *  visible activity is itself a breaker). */
interface CoalescedRun {
  /** Read-only clause segments and bash lines in call order; a bash call
   *  closes the open clause segment so rendering preserves operation order. */
  readonly items: (CoalescedToolClauses | CoalescedBashLine)[];
  /** Read-only call ids whose successful results are absorbed silently
   *  (their summaries are the noise being removed). */
  readonly readCallIds: Set<string>;
  /** Bash call id → rendered line awaiting its result summary. */
  readonly bashLines: Map<string, CoalescedBashLine>;
  hadThinking: boolean;
  thoughtMs: number;
  thoughtComputable: boolean;
}

/** Adapted from clauctl's TUI fold (clauctl repo-relative:
 *  src/tui/transcript.ts `isFoldable`): thinking, read-only tool calls, and —
 *  unlike clauctl's fold — bash, whose commands stay visible in the run
 *  rendering; nothing else visible — no non-blank text, no abort, no error,
 *  no other block types. A message contributing neither thinking nor a call
 *  renders normally instead of opening an empty run. */
function isCoalescableAssistant(
  message: Extract<AgentMessage, { role: "assistant" }>,
): boolean {
  if (message.stopReason === "aborted" || message.errorMessage !== undefined) {
    return false;
  }
  let contributes = false;
  for (const block of contentBlocks(message.content)) {
    if (!isRecord(block)) {
      return false;
    }
    if (block.type === "thinking") {
      contributes = true;
    } else if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim() !== "") {
        return false;
      }
    } else if (block.type === "toolCall") {
      if (
        typeof block.name !== "string" ||
        (!READ_ONLY_TOOLS.has(block.name) && block.name !== "bash")
      ) {
        return false;
      }
      contributes = true;
    } else {
      return false;
    }
  }
  return contributes;
}

/** The bare value of the first preferred key; calls without one fall back to
 *  the JSON argument summary. */
function coalescedCallArg(
  block: Record<string, unknown>,
  options: MessageFormatOptions,
): string {
  const args = block.arguments;
  if (isRecord(args)) {
    for (const key of PREFERRED_ARG_KEYS) {
      if (args[key] !== undefined) {
        return truncateText(
          oneLine(String(args[key])),
          options.maxToolArgChars,
        );
      }
    }
  }
  return formatToolArguments(args, options.maxToolArgChars);
}

function toolClauses(segment: CoalescedToolClauses): string[] {
  return [...segment.toolArgs].map(([name, args]) => {
    const shown = args.filter((arg) => arg !== "");
    return shown.length === 0 ? name : `${name} ${shown.join(", ")}`;
  });
}

/** Width driving right-edge alignment: command plus summary code points (the
 *  `[bash `, ` → `, `]` parts are constant per line). */
function bashLineWidth(line: CoalescedBashLine): number {
  return [...line.command].length + [...(line.resultSummary ?? "")].length;
}

/** `[thought for 4.3s; read a, b; grep TODO]` — one summed thought clause
 *  first (durations that would round to 0.0s render in milliseconds; bare
 *  `thought` when no duration was computable), then one clause per tool name
 *  in first-appearance order — followed by one `[bash cmd → 3L, 45B]` line
 *  per bash call, padded so result summaries share a right edge within the
 *  run. Later read-only segments render as further clause lines, preserving
 *  operation order around bash calls. */
function renderRunLines(run: CoalescedRun): string {
  const leadingClauses: string[] = [];
  if (run.hadThinking) {
    const seconds = (run.thoughtMs / 1000).toFixed(1);
    leadingClauses.push(
      !run.thoughtComputable
        ? "thought"
        : seconds === "0.0"
          ? `thought for ${run.thoughtMs}ms`
          : `thought for ${seconds}s`,
    );
  }
  const items = [...run.items];
  if (items[0]?.kind === "tools") {
    leadingClauses.push(...toolClauses(items[0]));
    items.shift();
  }
  const lines: string[] = [];
  if (leadingClauses.length > 0) {
    lines.push(`[${leadingClauses.join("; ")}]`);
  }
  const rightEdge = Math.max(
    ...run.items
      .filter(
        (item): item is CoalescedBashLine =>
          item.kind === "bash" && item.resultSummary !== undefined,
      )
      .map(bashLineWidth),
    0,
  );
  for (const item of items) {
    if (item.kind === "tools") {
      lines.push(`[${toolClauses(item).join("; ")}]`);
    } else if (item.resultSummary === undefined) {
      lines.push(`[bash ${item.command}]`);
    } else {
      const padding = " ".repeat(rightEdge - bashLineWidth(item));
      lines.push(`[bash ${item.command}${padding} → ${item.resultSummary}]`);
    }
  }
  return lines.join("\n");
}

/**
 * Stateful push/end formatter: the concatenation of every `push()` and the
 * final `end()` is the stream's formatted output. Separators are emitted
 * before each block, `end()` supplies the trailing newline, so a finite
 * stream's bytes never depend on how it ends. Every formatted message path
 * (`format messages`, `tail`, `prompt`) flows through this class, making
 * byte-equality between them structural.
 *
 * Runs of thinking, read-only tool calls, and bash calls coalesce into one
 * compact block unless `toolResults` is "full" (full detail was asked for).
 * `push()` returns "" for records joining the run; the breaker's `push()` —
 * or `end()` at EOF — emits the completed block first, then the breaker's
 * own block.
 *
 * Speaker headers (`== user ==`, `== assistant ==`, …) are emitted only when
 * the speaker changes; tool results and coalesced runs count as assistant
 * output. A block containing raw (unbracketed) text forces the next headered
 * block to re-emit its header so the raw text's end stays unambiguous.
 */
export class MessageFormatter {
  private readonly options: MessageFormatOptions;
  private emittedAny = false;
  private run: CoalescedRun | undefined;
  /** Header of the last speaker-attributed block; a matching next block
   *  omits its header unless raw text forced re-emission. */
  private lastHeader: string | undefined;
  /** Set when a block rendered raw (unbracketed) text; see class docs. */
  private forceNextHeader = false;
  /** The last message timestamp seen; a thinking message's duration is its
   *  timestamp minus this (clauctl's session-file delta rule). */
  private previousTimestamp: number | undefined;

  constructor(options?: Partial<MessageFormatOptions>) {
    this.options = {
      maxToolArgChars:
        options?.maxToolArgChars ??
        DEFAULT_MESSAGE_FORMAT_OPTIONS.maxToolArgChars,
      toolResults:
        options?.toolResults ?? DEFAULT_MESSAGE_FORMAT_OPTIONS.toolResults,
      maxErrorLines:
        options?.maxErrorLines ?? DEFAULT_MESSAGE_FORMAT_OPTIONS.maxErrorLines,
    };
  }

  /** The record's rendered output including any separator; "" if the record
   *  renders nothing or joined the open coalescing run. */
  push(record: MessageStreamRecord): string {
    if (this.options.toolResults !== "full" && this.absorbIntoRun(record)) {
      return "";
    }
    let output = this.flushRun();
    const rendered = formatMessageRecord(record, this.options);
    this.trackTimestamp(record);
    if (rendered !== undefined) {
      output += this.block(rendered.header, rendered.body);
    }
    return output;
  }

  /** Flushes any open coalesced run and the trailing newline; "" when
   *  nothing was emitted. */
  end(): string {
    const flushed = this.flushRun();
    return `${flushed}${this.emittedAny ? "\n" : ""}`;
  }

  private block(header: string | undefined, body: string): string {
    const emitHeader =
      header !== undefined &&
      (this.forceNextHeader || header !== this.lastHeader);
    if (header !== undefined) {
      this.lastHeader = header;
      this.forceNextHeader = false;
    }
    if (hasRawTextLine(body)) {
      this.forceNextHeader = true;
    }
    const chunk = emitHeader ? `${header}\n${body}` : body;
    if (chunk === "") {
      return "";
    }
    const separator = this.emittedAny ? "\n\n" : "";
    this.emittedAny = true;
    return `${separator}${chunk}`;
  }

  private flushRun(): string {
    if (this.run === undefined) {
      return "";
    }
    const lines = renderRunLines(this.run);
    this.run = undefined;
    return this.block("== assistant ==", lines);
  }

  private absorbIntoRun(record: MessageStreamRecord): boolean {
    if (record.type !== "message") {
      return false;
    }
    const message = record.message;
    if (message.role === "assistant" && isCoalescableAssistant(message)) {
      const run: CoalescedRun = (this.run ??= {
        items: [],
        readCallIds: new Set(),
        bashLines: new Map(),
        hadThinking: false,
        thoughtMs: 0,
        thoughtComputable: false,
      });
      if (hasContentBlock(message.content, "thinking")) {
        run.hadThinking = true;
        if (
          typeof message.timestamp === "number" &&
          this.previousTimestamp !== undefined &&
          message.timestamp >= this.previousTimestamp
        ) {
          run.thoughtMs += message.timestamp - this.previousTimestamp;
          run.thoughtComputable = true;
        }
      }
      for (const block of contentBlocks(message.content)) {
        if (
          isRecord(block) &&
          block.type === "toolCall" &&
          typeof block.name === "string"
        ) {
          const arg = coalescedCallArg(block, this.options);
          if (block.name === "bash") {
            const line: CoalescedBashLine = {
              kind: "bash",
              command: arg,
              resultSummary: undefined,
            };
            run.items.push(line);
            if (typeof block.id === "string") {
              run.bashLines.set(block.id, line);
            }
          } else {
            const last = run.items.at(-1);
            const segment: CoalescedToolClauses =
              last?.kind === "tools"
                ? last
                : { kind: "tools", toolArgs: new Map() };
            if (segment !== last) {
              run.items.push(segment);
            }
            const args = segment.toolArgs.get(block.name) ?? [];
            args.push(arg);
            segment.toolArgs.set(block.name, args);
            if (typeof block.id === "string") {
              run.readCallIds.add(block.id);
            }
          }
        }
      }
      this.trackTimestamp(record);
      return true;
    }
    if (
      message.role === "toolResult" &&
      !message.isError &&
      this.run !== undefined
    ) {
      if (this.run.readCallIds.has(message.toolCallId)) {
        this.trackTimestamp(record);
        return true;
      }
      const bashLine = this.run.bashLines.get(message.toolCallId);
      if (bashLine !== undefined) {
        if (this.options.toolResults === "summary") {
          const text = extractTextContent(message.content);
          bashLine.resultSummary = `${countLines(text)}L, ${Buffer.byteLength(text, "utf8")}B`;
        }
        this.trackTimestamp(record);
        return true;
      }
    }
    return false;
  }

  private trackTimestamp(record: MessageStreamRecord): void {
    if (
      record.type === "message" &&
      typeof record.message.timestamp === "number"
    ) {
      this.previousTimestamp = record.message.timestamp;
    }
  }
}

export function formatMessageRecords(
  records: Iterable<MessageStreamRecord>,
  options?: Partial<MessageFormatOptions>,
): string {
  const formatter = new MessageFormatter(options);
  const chunks = Array.from(records, (record) => formatter.push(record));
  return `${chunks.join("")}${formatter.end()}`;
}

function formatMessageRecord(
  record: MessageStreamRecord,
  options: MessageFormatOptions,
): RenderedBlock | undefined {
  if (record.type === "pictl_cursor") {
    return {
      header: undefined,
      body: `[cursor: ${record.entryId ?? "null"}]`,
    };
  }
  if (record.type === "control") {
    const body = formatControl(record);
    return body === undefined ? undefined : { header: undefined, body };
  }
  return formatMessage(record.message, options);
}

/** Bracketed lines (`[...]`) are self-delimiting; any other non-blank line
 *  is raw text whose boundary with a following same-speaker block would be
 *  ambiguous without a header. */
function hasRawTextLine(body: string): boolean {
  return body
    .split("\n")
    .some(
      (line) =>
        line.trim() !== "" && !(line.startsWith("[") && line.endsWith("]")),
    );
}
