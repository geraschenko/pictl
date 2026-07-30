import type {
  AgentMessage,
  MessageStreamRecord,
} from "../core/streaming/types.ts";
import type { MessageFormatOptions } from "./types.ts";
import {
  contentBlocks,
  countLines,
  extractTextContent,
  hasContentBlock,
  oneLine,
  summarizeContentBlock,
  summarizeUnknown,
  truncateText,
} from "./text.ts";
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
    case "model_changed": {
      const model = "model" in event ? event.model : undefined;
      const provider =
        optionalStringOrNumberField(model, "provider") ?? "unknown";
      const modelId = optionalStringOrNumberField(model, "id") ?? "unknown";
      return `[model: ${provider}/${modelId}]`;
    }
  }
}

function formatMessage(
  message: AgentMessage,
  options: MessageFormatOptions,
): string {
  switch (message.role) {
    case "user":
      return `== user ==\n${extractTextContent(message.content)}`;
    case "assistant": {
      const lines = ["== assistant =="];
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
      return lines.join("\n");
    }
    case "toolResult": {
      const text = extractTextContent(message.content);
      return (
        formatToolResultText(
          message.toolName,
          message.isError,
          text,
          options,
        ) ?? ""
      );
    }
    case "bashExecution":
      return `== bash ==\n${message.command}\n[exit: ${message.exitCode ?? "unknown"}]${
        message.output === "" ? "" : `\n${message.output}`
      }`;
    case "custom":
      return `== custom:${message.customType} ==\n${extractTextContent(message.content)}`;
    case "branchSummary":
      return `== branchSummary:${message.fromId} ==\n${message.summary}`;
    case "compactionSummary":
      return `== compactionSummary ==\n${message.summary}`;
  }
}

/** A run of coalesced thinking/read-only activity, held back until a breaker
 *  or `end()` closes it (an open run is deliberately silent — any visible
 *  activity is itself a breaker). */
interface CoalescedRun {
  /** Tool name → rendered args in call order; insertion order is first
   *  appearance. */
  readonly toolArgs: Map<string, string[]>;
  /** Call ids whose successful results are absorbed silently (their
   *  summaries are the noise being removed). */
  readonly callIds: Set<string>;
  hadThinking: boolean;
  thoughtMs: number;
  thoughtComputable: boolean;
}

/** Adapted from clauctl's TUI fold (clauctl repo-relative:
 *  src/tui/transcript.ts `isFoldable`): thinking and read-only tool calls
 *  only, nothing visible — no non-blank text, no abort, no error, no other
 *  block types. A message contributing neither thinking nor a call renders
 *  normally instead of opening an empty run. */
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
      if (typeof block.name !== "string" || !READ_ONLY_TOOLS.has(block.name)) {
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

/** `[thought for 4.3s; read a, b; grep TODO]` — one summed thought clause
 *  first (durations that would round to 0.0s render in milliseconds; bare
 *  `thought` when no duration was computable), then one clause per tool name
 *  in first-appearance order. */
function renderRunLine(run: CoalescedRun): string {
  const clauses: string[] = [];
  if (run.hadThinking) {
    const seconds = (run.thoughtMs / 1000).toFixed(1);
    clauses.push(
      !run.thoughtComputable
        ? "thought"
        : seconds === "0.0"
          ? `thought for ${run.thoughtMs}ms`
          : `thought for ${seconds}s`,
    );
  }
  for (const [name, args] of run.toolArgs) {
    const shown = args.filter((arg) => arg !== "");
    clauses.push(shown.length === 0 ? name : `${name} ${shown.join(", ")}`);
  }
  return `[${clauses.join("; ")}]`;
}

/**
 * Stateful push/end formatter: the concatenation of every `push()` and the
 * final `end()` is the stream's formatted output. Separators are emitted
 * before each block, `end()` supplies the trailing newline, so a finite
 * stream's bytes never depend on how it ends. Every formatted message path
 * (`format messages`, `tail`, `prompt`) flows through this class, making
 * byte-equality between them structural.
 *
 * Runs of thinking and read-only tool calls coalesce into one line unless
 * `toolResults` is "full" (full detail was asked for). `push()` returns ""
 * for records joining the run; the breaker's `push()` — or `end()` at EOF —
 * emits the completed line first, then the breaker's own block.
 */
export class MessageFormatter {
  private readonly options: MessageFormatOptions;
  private emittedAny = false;
  private run: CoalescedRun | undefined;
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
    const chunk = formatMessageRecord(record, this.options);
    this.trackTimestamp(record);
    if (chunk !== undefined && chunk !== "") {
      output += this.block(chunk);
    }
    return output;
  }

  /** Flushes any open coalesced run and the trailing newline; "" when
   *  nothing was emitted. */
  end(): string {
    const flushed = this.flushRun();
    return `${flushed}${this.emittedAny ? "\n" : ""}`;
  }

  private block(chunk: string): string {
    const separator = this.emittedAny ? "\n\n" : "";
    this.emittedAny = true;
    return `${separator}${chunk}`;
  }

  private flushRun(): string {
    if (this.run === undefined) {
      return "";
    }
    const line = renderRunLine(this.run);
    this.run = undefined;
    return this.block(line);
  }

  private absorbIntoRun(record: MessageStreamRecord): boolean {
    if (record.type !== "message") {
      return false;
    }
    const message = record.message;
    if (message.role === "assistant" && isCoalescableAssistant(message)) {
      const run = (this.run ??= {
        toolArgs: new Map(),
        callIds: new Set(),
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
          const args = run.toolArgs.get(block.name) ?? [];
          args.push(coalescedCallArg(block, this.options));
          run.toolArgs.set(block.name, args);
          if (typeof block.id === "string") {
            run.callIds.add(block.id);
          }
        }
      }
      this.trackTimestamp(record);
      return true;
    }
    if (
      message.role === "toolResult" &&
      !message.isError &&
      this.run !== undefined &&
      this.run.callIds.has(message.toolCallId)
    ) {
      this.trackTimestamp(record);
      return true;
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
): string | undefined {
  if (record.type === "pictl_cursor") {
    return `[cursor: ${record.entryId ?? "null"}]`;
  }
  if (record.type === "control") {
    return formatControl(record);
  }
  return formatMessage(record.message, options);
}
