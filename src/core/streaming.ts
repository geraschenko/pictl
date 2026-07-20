import type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  RpcSocketBroadcastEvent,
} from "@geraschenko/pi-coding-agent";
import type {
  MessageStreamRecord,
  StreamCursorRecord,
} from "./stream-types.ts";
import { oneTarget, type CommandContext } from "./targets.ts";
import { ensureAgentRunning } from "./lifecycle.ts";
import { piSocketPath } from "./registry.ts";
import { connectWithRetry, type PiSocketClient } from "./pi-socket-client.ts";
import { oneOf, UsageError } from "./util.ts";
import type { UntilCondition } from "./until-engine.ts";
import { untilMetAtSeed, untilMetByEvent, untilQuietMs } from "./until.ts";
import { runStream, type StreamHandler } from "./stream-driver.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

/** Per-delta events that can never produce a new session entry; the
 *  incremental entries drain skips them (one drain per token would spam
 *  RPCs). They still reach the until checkers and the quiet timer. */
const ENTRY_DELTA_EVENTS = new Set(["message_update", "tool_execution_update"]);

export const STREAM_OUTPUT_TYPES = ["messages", "entries", "raw"] as const;
export type StreamOutputType = (typeof STREAM_OUTPUT_TYPES)[number];

interface StreamOptions {
  outputType: StreamOutputType;
  writer: RecordWriter;
  since: string | undefined;
  limit: number | undefined;
  /** undefined = follow until the socket closes. */
  until: UntilCondition | undefined;
  timeoutMs: number | undefined;
}

export interface PromptStreamOptions {
  type: StreamOutputType;
  writer: RecordWriter;
  until: UntilCondition;
  timeoutMs: number | undefined;
  message: string;
  images: Extract<RpcCommand, { type: "prompt" }>["images"] | undefined;
  streamingBehavior: "steer" | "followUp" | undefined;
}

/**
 * The output seam for the streaming engine. Concrete implementations and the
 * `type`+`json` → writer factory live in `src/format/record-writer.ts`; the
 * command layer injects one. Keeping only the interface here keeps the engine
 * free of any `format` import (dependency inversion).
 */
export interface RecordWriter {
  writeRecord(record: unknown): void;
}

type GetEntriesData = Extract<
  RpcResponse,
  { command: "get_entries"; success: true }
>["data"];

export function parseStreamOutputType(input: string): StreamOutputType {
  return oneOf(input, STREAM_OUTPUT_TYPES, "--type");
}

async function getEntries(
  client: PiSocketClient,
  since: string | undefined,
): Promise<GetEntriesData> {
  const response = await client.request({
    type: "get_entries",
    ...(since !== undefined && { since }),
  });
  return (
    response as Extract<RpcResponse, { command: "get_entries"; success: true }>
  ).data;
}

async function writeFinalCursor(
  client: PiSocketClient,
  writer: RecordWriter,
  sessionId: string | undefined,
): Promise<void> {
  // TODO: it's strange that RpcSessionState doesn't have leafId. Consider changing that in our pi fork (and perhaps upstreaming).
  const entries = await getEntries(client, undefined);
  const record: StreamCursorRecord = {
    type: "pictl_cursor",
    sessionId: sessionId ?? null,
    entryId: entries.leafId,
  };
  writer.writeRecord(record);
}

function messageRecordFromEvent(
  event: RpcSocketBroadcastEvent,
): MessageStreamRecord | undefined {
  if (event.type === "message_end") {
    return { type: "message", message: event.message };
  }
  if (event.type === "compaction_start" || event.type === "compaction_end") {
    return { type: "control", control: { kind: "compaction", event } };
  }
  if (event.type === "tree_navigated") {
    return { type: "control", control: { kind: "tree_navigated", event } };
  }
  if (event.type === "session_changed") {
    return { type: "control", control: { kind: "session_changed", event } };
  }
  if (event.type === "queue_update") {
    return { type: "control", control: { kind: "queue_update", event } };
  }
  return undefined;
}

function limitedTail<T>(
  items: readonly T[],
  limit: number | undefined,
): readonly T[] {
  return limit === undefined ? items : items.slice(-limit);
}

async function emitHistoricalMessages(
  client: PiSocketClient,
  writer: RecordWriter,
  since: string | undefined,
  limit: number | undefined,
): Promise<void> {
  if (since === undefined) {
    const response = await client.request({ type: "get_messages" });
    const messages = (
      response as Extract<
        RpcResponse,
        { command: "get_messages"; success: true }
      >
    ).data.messages;
    for (const message of limitedTail(messages, limit)) {
      writer.writeRecord({ type: "message", message });
    }
    return;
  }
  const { entries } = await getEntries(client, since);
  const messages = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  for (const message of limitedTail(messages, limit)) {
    writer.writeRecord({ type: "message", message });
  }
}

/** Emit every entry after `cursor` and return the new cursor. `get_entries
 *  since` is incremental server-side, so each drain sends only new entries.
 *  Serves tail's entries history and the per-event drains of both streams. */
async function drainEntries(
  client: PiSocketClient,
  writer: RecordWriter,
  cursor: string | undefined,
  limit: number | undefined,
): Promise<string | undefined> {
  const { entries } = await getEntries(client, cursor);
  let nextCursor = cursor;
  for (const entry of limitedTail(entries, limit)) {
    writer.writeRecord(entry);
    nextCursor = entry.id;
  }
  return nextCursor;
}

/**
 * Build the mode's StreamHandler and drive it over the subscribed event
 * stream. The handler composes its output emission with the until checkers:
 * without `until` both hooks return false (follow until close). Prompt
 * streams pass checkSeed=false — the seed predates the prompt, so an idle
 * pre-prompt seed must not satisfy `turn-end`/`idle`.
 *
 * Returns the settling state (the one delivered with the satisfying event).
 * Throws "pi socket closed" when the socket closes before the condition is
 * met — which for follow mode (no condition) is the normal exit path.
 */
async function runModeStream(options: {
  client: PiSocketClient;
  outputType: StreamOutputType;
  writer: RecordWriter;
  until: UntilCondition | undefined;
  timeoutMs: number | undefined;
  checkSeed: boolean;
  /** Entries mode: continue the incremental drain after this cursor
   *  (undefined = from the session start); unused for other modes. */
  entriesSince?: string | undefined;
}): Promise<RpcSessionState> {
  const { client, writer, until } = options;
  const metAtSeed = (seed: RpcSessionState): boolean =>
    options.checkSeed && until !== undefined && untilMetAtSeed(until, seed);
  const metByEvent = (
    event: RpcSocketBroadcastEvent,
    state: RpcSessionState,
  ): boolean => until !== undefined && untilMetByEvent(until, event, state);
  const quietMs = until === undefined ? undefined : untilQuietMs(until);

  let handler: StreamHandler<RpcSocketBroadcastEvent, RpcSessionState>;
  if (options.outputType === "messages") {
    handler = {
      onSeed: metAtSeed,
      onEvent: (event, state) => {
        const record = messageRecordFromEvent(event);
        if (record !== undefined) {
          writer.writeRecord(record);
        }
        return metByEvent(event, state);
      },
      quietMs,
    };
  } else if (options.outputType === "entries") {
    let cursor = options.entriesSince;
    let lastSessionId: string | undefined;
    handler = {
      onSeed: (seed) => {
        lastSessionId = seed.sessionId;
        return metAtSeed(seed);
      },
      onEvent: async (event, state) => {
        // Entry cursors are session-scoped: a session replacement
        // invalidates ours, so restart the drain from the new session's
        // beginning.
        if (state.sessionId !== lastSessionId) {
          lastSessionId = state.sessionId;
          cursor = undefined;
        }
        if (!ENTRY_DELTA_EVENTS.has(event.type)) {
          cursor = await drainEntries(client, writer, cursor, undefined);
        }
        return metByEvent(event, state);
      },
      quietMs,
    };
  } else {
    handler = {
      onSeed: metAtSeed,
      onEvent: (event, state) => {
        writer.writeRecord(event);
        return metByEvent(event, state);
      },
      quietMs,
    };
  }

  const result = await runStream(client, handler, options.timeoutMs);
  if (result.outcome === "closed") {
    throw new Error("pi socket closed");
  }
  return result.state;
}

async function connectForContext(
  context: CommandContext,
): Promise<PiSocketClient> {
  const agent = await ensureAgentRunning(oneTarget(context).id);
  return await connectWithRetry(
    piSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
}

function buildPromptCommand(options: {
  message: string;
  images: Extract<RpcCommand, { type: "prompt" }>["images"] | undefined;
  streamingBehavior: "steer" | "followUp" | undefined;
}): RpcCommand {
  return {
    type: "prompt",
    message: options.message,
    ...(options.images !== undefined && { images: options.images }),
    ...(options.streamingBehavior !== undefined && {
      streamingBehavior: options.streamingBehavior,
    }),
  };
}

/**
 * Fire-and-forget: connect, send the prompt, close. No writer and no streaming
 * — `--detach` has no output to shape.
 */
export async function promptDetached(
  context: CommandContext,
  options: {
    message: string;
    images: Extract<RpcCommand, { type: "prompt" }>["images"] | undefined;
    streamingBehavior: "steer" | "followUp" | undefined;
  },
): Promise<void> {
  const client = await connectForContext(context);
  try {
    await client.request(buildPromptCommand(options));
  } finally {
    client.close();
  }
}

/**
 * Stream a prompt until its condition is met. The stream starts before the
 * prompt RPC is awaited — runModeStream subscribes synchronously inside the
 * call — so a turn that finishes faster than the CLI could otherwise
 * subscribe cannot slip its events past the stream: ordering, not buffering.
 */
export async function streamPrompt(
  context: CommandContext,
  options: PromptStreamOptions,
): Promise<void> {
  const writer = options.writer;
  const client = await connectForContext(context);
  try {
    // Entries mode drains past the pre-prompt leaf, so the incremental
    // drains emit exactly the entries the prompt produces.
    // TODO: This behavior actually isn't quite right. What we'd like to do (for all `--type`s) is to _start_ streaming at the prompt message itself, whereever it gets inserted. In the case where the assistant is idle before the prompt, this gives the right behavior, but if the assistant is busy, then I'd like to figure out where the prompt gets inserted (based on --streaming-behavior and steering_mode/followup_mode, possibly requiring string-matching of content, particularly if the modes are all-at-once) and start the stream there. This will probably require a change to pi.
    const entriesSince =
      options.type === "entries"
        ? (await getEntries(client, undefined)).entries.at(-1)?.id
        : undefined;
    const streamPromise = runModeStream({
      client,
      outputType: options.type,
      writer,
      until: options.until,
      timeoutMs: options.timeoutMs,
      checkSeed: false,
      entriesSince,
    });
    // Mark handled while the prompt RPC is in flight: the stream can reject
    // first (e.g. `--timeout 0`), which must not raise an unhandled
    // rejection before the await below attaches.
    streamPromise.catch(() => undefined);
    try {
      await client.request(buildPromptCommand(options));
    } catch (error) {
      // The stream only settles once the socket closes; close it so the
      // prompt failure surfaces instead of hanging.
      client.close();
      await streamPromise.catch(() => undefined);
      throw error;
    }
    const state = await streamPromise;
    // Entries already include entryId, so a cursor is redundant.
    if (options.type !== "entries") {
      await writeFinalCursor(client, writer, state.sessionId);
    }
  } finally {
    client.close();
  }
}

export async function streamTail(
  context: CommandContext,
  options: StreamOptions,
): Promise<void> {
  if (options.outputType === "raw" && options.limit !== undefined) {
    throw new UsageError("-n is not supported with --type raw");
  }
  if (options.outputType === "raw" && options.since !== undefined) {
    throw new UsageError("--since is not supported with --type raw");
  }
  const writer = options.writer;
  const client = await connectForContext(context);
  try {
    let entriesSince: string | undefined;
    if (options.outputType === "messages") {
      await emitHistoricalMessages(
        client,
        writer,
        options.since,
        options.limit,
      );
    } else if (options.outputType === "entries") {
      // The follow drains continue from the cursor the history drain ends on.
      entriesSince = await drainEntries(
        client,
        writer,
        options.since,
        options.limit,
      );
    }
    const state = await runModeStream({
      client,
      outputType: options.outputType,
      writer,
      until: options.until,
      timeoutMs: options.timeoutMs,
      checkSeed: true,
      entriesSince,
    });
    // Entries already include entryId, so a cursor is redundant; without
    // --until the stream only ends by socket close (thrown above), so a
    // cursor is written exactly when a condition settled the stream.
    if (options.outputType !== "entries" && options.until !== undefined) {
      await writeFinalCursor(client, writer, state.sessionId);
    }
  } finally {
    client.close();
  }
}
