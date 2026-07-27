import type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  RpcSocketBroadcastEvent,
} from "@geraschenko/pi-coding-agent";
import { EventMessageRecordProjector } from "./message-records.ts";
import type { StreamCursorRecord } from "./types.ts";
import { oneTarget, type CommandContext } from "../targets.ts";
import { ensureAgentRunning } from "../lifecycle.ts";
import { piSocketPath } from "../registry.ts";
import { connectWithRetry, type PiSocketClient } from "../pi-socket-client.ts";
import { oneOf, UsageError } from "../util.ts";
import type { UntilCondition } from "../until-engine.ts";
import { untilMetAtSeed, untilMetByEvent, untilQuietMs } from "../until.ts";
import { runStream, type StreamHandler, type StreamResult } from "./driver.ts";

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

function writeFinalCursor(
  writer: RecordWriter,
  sessionId: string | undefined,
  entries: GetEntriesData | undefined,
): void {
  if (entries === undefined) {
    throw new Error("stream stopped without a final cursor snapshot");
  }
  const record: StreamCursorRecord = {
    type: "pictl_cursor",
    sessionId: sessionId ?? null,
    entryId: entries.leafId,
  };
  writer.writeRecord(record);
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
 * Returns the successful `done` or `timeout` result. Throws "pi socket
 * closed" when transport close wins before the condition — which for follow
 * mode (no condition or timeout) is the normal exit path.
 */
interface ModeStreamResult {
  readonly stream: StreamResult<RpcSessionState>;
  readonly cutoffEntries: GetEntriesData | undefined;
}

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
}): Promise<ModeStreamResult> {
  const { client, writer, until } = options;
  let cutoffEntries: GetEntriesData | undefined;
  const captureCutoffEntries =
    options.outputType === "entries"
      ? undefined
      : async (): Promise<void> => {
          cutoffEntries = await getEntries(client, undefined);
        };
  const metAtSeed = (seed: RpcSessionState): boolean =>
    options.checkSeed && until !== undefined && untilMetAtSeed(until, seed);
  const metByEvent = (
    event: RpcSocketBroadcastEvent,
    state: RpcSessionState,
  ): boolean => until !== undefined && untilMetByEvent(until, event, state);
  const quietMs = until === undefined ? undefined : untilQuietMs(until);

  let handler: StreamHandler<RpcSocketBroadcastEvent, RpcSessionState>;
  if (options.outputType === "messages") {
    const projector = new EventMessageRecordProjector();
    handler = {
      onSeed: metAtSeed,
      onEvent: (event, state) => {
        for (const record of projector.project(event)) {
          writer.writeRecord(record);
        }
        return metByEvent(event, state);
      },
      onStop: captureCutoffEntries,
      onEnd: () => {
        for (const record of projector.finish()) {
          writer.writeRecord(record);
        }
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
      onStop: captureCutoffEntries,
      quietMs,
    };
  }

  const result = await runStream(client, handler, options.timeoutMs);
  if (result.outcome === "closed") {
    throw new Error("pi socket closed");
  }
  return { stream: result, cutoffEntries };
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
    // Mark handled while the prompt RPC is in flight: a handler can reject
    // first, which must not raise an unhandled rejection before the await
    // below attaches.
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
    const result = await streamPromise;
    // Entries already include entryId, so a cursor is redundant.
    if (options.type !== "entries") {
      writeFinalCursor(
        writer,
        result.stream.state.sessionId,
        result.cutoffEntries,
      );
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
    if (options.timeoutMs === 0) {
      if (options.outputType !== "entries") {
        const subscription = await client.subscribe();
        subscription.events.cancel();
        writeFinalCursor(
          writer,
          subscription.seed.sessionId,
          await getEntries(client, undefined),
        );
      }
      return;
    }
    const result = await runModeStream({
      client,
      outputType: options.outputType,
      writer,
      until: options.until,
      timeoutMs: options.timeoutMs,
      checkSeed: true,
      entriesSince,
    });
    // Entries already include entryId, so a cursor is redundant. A timed
    // finite observation always emits a resumable cursor for message/raw.
    if (
      options.outputType !== "entries" &&
      (options.until !== undefined || result.stream.outcome === "timeout")
    ) {
      writeFinalCursor(
        writer,
        result.stream.state.sessionId,
        result.cutoffEntries,
      );
    }
  } finally {
    client.close();
  }
}
