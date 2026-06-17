import type { RpcCommand, RpcResponse } from "@geraschenko/pi-coding-agent";
import type { CommandContext } from "./cli.ts";
import { oneTarget } from "./cli.ts";
import { ensureAgentRunning } from "./lifecycle.ts";
import { piSocketPath } from "./registry.ts";
import {
  connectWithRetry,
  getState,
  type PiSocketClient,
  type SocketEvent,
} from "./rpc.ts";
import { UsageError } from "./util.ts";
import {
  applyWaitCondition,
  parseWaitCondition,
  WAIT_UNTIL_USAGE,
  type WaitCondition,
} from "./wait.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;
const STREAMING_NOISE_EVENTS = new Set([
  "message_update",
  "tool_execution_update",
]);

export const STREAM_OUTPUT_TYPES = ["messages", "entries", "raw"] as const;
export type StreamOutputType = (typeof STREAM_OUTPUT_TYPES)[number];

export const PROMPT_TYPES = ["messages", "entries", "raw", "detach"] as const;
export type PromptType = (typeof PROMPT_TYPES)[number];

export type StreamUntil =
  | WaitCondition
  | { kind: "killed" }
  | { kind: "prompt-complete" };

export interface StreamCursorRecord {
  type: "pictl_cursor";
  sessionId: string | null;
  entryId: string | null;
}

export interface StreamMessageRecord {
  type: "message";
  message: AgentMessage;
}

export type StreamControlKind =
  | "compaction"
  | "tree_navigated"
  | "session_changed"
  | "queue_update";

export interface StreamControlRecord {
  type: "control";
  control: {
    kind: StreamControlKind;
    event: SocketEvent;
  };
}

export type MessageStreamRecord =
  | StreamMessageRecord
  | StreamControlRecord
  | StreamCursorRecord;

export type EntryStreamRecord =
  | Extract<
      RpcResponse,
      { command: "get_entries"; success: true }
    >["data"]["entries"][number]
  | StreamCursorRecord;

export type RawStreamRecord = SocketEvent;

export interface StreamOptions {
  outputType: StreamOutputType;
  since: string | undefined;
  limit: number | undefined;
  until: StreamUntil | undefined;
  timeoutMs: number | undefined;
}

export interface PromptStreamOptions {
  type: PromptType;
  until: StreamUntil;
  timeoutMs: number | undefined;
  message: string;
  images: Extract<RpcCommand, { type: "prompt" }>["images"] | undefined;
  streamingBehavior: "steer" | "followUp" | undefined;
}

export type TailStreamOptions = StreamOptions;

export interface JsonlWriter {
  writeRecord(record: unknown): void;
}

interface StreamState {
  sessionId: string | undefined;
  resyncNeeded: boolean;
  wakeArrived: boolean;
  notifyWake: (() => void) | undefined;
  stopRequested: boolean;
  stopError: Error | undefined;
}

type GetEntriesData = Extract<
  RpcResponse,
  { command: "get_entries"; success: true }
>["data"];

type GetMessagesData = Extract<
  RpcResponse,
  { command: "get_messages"; success: true }
>["data"];

type AgentMessage = GetMessagesData["messages"][number];
type SessionEntry = GetEntriesData["entries"][number];

class StdoutJsonlWriter implements JsonlWriter {
  private readonly context: CommandContext;

  constructor(context: CommandContext) {
    this.context = context;
  }

  writeRecord(record: unknown): void {
    this.context.process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  what: string,
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new UsageError(
    `${what} must be one of: ${allowed.join(", ")} (got '${value}')`,
  );
}

export function parseStreamOutputType(input: string): StreamOutputType {
  return oneOf(input, STREAM_OUTPUT_TYPES, "--type");
}

export function parsePromptType(input: string): PromptType {
  return oneOf(input, PROMPT_TYPES, "--type");
}

export const STREAM_UNTIL_USAGE = `${WAIT_UNTIL_USAGE}|killed`;

export function parseStreamUntil(input: string): StreamUntil {
  if (input === "killed") {
    return { kind: "killed" };
  }
  return parseWaitCondition(input);
}

export function normalizeFollowUntil(input: {
  follow: boolean;
  until: StreamUntil | undefined;
}): StreamUntil | undefined {
  if (input.follow && input.until !== undefined) {
    throw new UsageError("--follow/-f cannot be combined with --until");
  }
  return input.follow ? { kind: "killed" } : input.until;
}

function entriesFrom(response: RpcResponse): GetEntriesData["entries"] {
  return (
    response as Extract<RpcResponse, { command: "get_entries"; success: true }>
  ).data.entries;
}

function leafIdFrom(response: RpcResponse): string | null {
  return (
    response as Extract<RpcResponse, { command: "get_entries"; success: true }>
  ).data.leafId;
}

function messagesFrom(response: RpcResponse): GetMessagesData["messages"] {
  return (
    response as Extract<RpcResponse, { command: "get_messages"; success: true }>
  ).data.messages;
}

async function getEntries(
  client: PiSocketClient,
  since: string | undefined,
): Promise<GetEntriesData> {
  const response = await client.request({
    type: "get_entries",
    ...(since !== undefined && { since }),
  });
  return {
    entries: entriesFrom(response),
    leafId: leafIdFrom(response),
  };
}

export async function writeFinalCursor(
  client: PiSocketClient,
  writer: JsonlWriter,
): Promise<StreamCursorRecord> {
  const state = await getState(client);
  const entries = await getEntries(client, undefined);
  const record: StreamCursorRecord = {
    type: "pictl_cursor",
    sessionId: state.sessionId ?? null,
    entryId: entries.leafId,
  };
  writer.writeRecord(record);
  return record;
}

function handleSessionEvent(state: StreamState, event: SocketEvent): void {
  if (event.type === "session_changed") {
    const announcedSessionId = (event as { sessionId?: string }).sessionId;
    if (state.sessionId === undefined) {
      state.sessionId = announcedSessionId;
    } else if (announcedSessionId !== state.sessionId) {
      state.sessionId = announcedSessionId;
      state.resyncNeeded = true;
    }
  }
  if (STREAMING_NOISE_EVENTS.has(event.type)) {
    return;
  }
  state.wakeArrived = true;
  state.notifyWake?.();
}

function nextWake(state: StreamState, client: PiSocketClient): Promise<void> {
  if (state.wakeArrived || state.stopRequested) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.notifyWake = resolve;
    void client.waitClosed().then(resolve);
  });
}

function newStreamState(): StreamState {
  return {
    sessionId: undefined,
    resyncNeeded: false,
    wakeArrived: false,
    notifyWake: undefined,
    stopRequested: false,
    stopError: undefined,
  };
}

function isFiniteUntil(until: StreamUntil | undefined): boolean {
  return until !== undefined && until.kind !== "killed";
}

async function waitForUntil(
  client: PiSocketClient,
  until: StreamUntil,
  timeoutMs: number | undefined,
): Promise<void> {
  if (until.kind === "killed") {
    await client.waitClosed();
    throw new Error("pi socket closed");
  }
  if (until.kind === "prompt-complete") {
    await applyWaitCondition(client, { kind: "turn-end" }, timeoutMs);
    return;
  }
  await applyWaitCondition(client, until, timeoutMs);
}

function startStopWatcher(
  client: PiSocketClient,
  state: StreamState,
  until: StreamUntil | undefined,
  timeoutMs: number | undefined,
): void {
  if (until === undefined || until.kind === "killed") {
    return;
  }
  void waitForUntil(client, until, timeoutMs).then(
    () => {
      state.stopRequested = true;
      state.notifyWake?.();
    },
    (error: unknown) => {
      state.stopError = error instanceof Error ? error : new Error(String(error));
      state.stopRequested = true;
      state.notifyWake?.();
    },
  );
}

function messageRecordFromEvent(event: SocketEvent): MessageStreamRecord | undefined {
  if (event.type === "message_end") {
    return {
      type: "message",
      message: (event as unknown as { message: AgentMessage }).message,
    };
  }
  if (
    event.type === "compaction_start" ||
    event.type === "compaction_end"
  ) {
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

async function streamMessages(
  client: PiSocketClient,
  writer: JsonlWriter,
  until: StreamUntil | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  const state = newStreamState();
  client.onEvent((event) => {
    const record = messageRecordFromEvent(event);
    if (record !== undefined) {
      writer.writeRecord(record);
      state.wakeArrived = true;
      state.notifyWake?.();
    }
  });
  startStopWatcher(client, state, until, timeoutMs);
  if (until === undefined) {
    return;
  }
  if (until.kind === "killed") {
    await waitForUntil(client, until, timeoutMs);
    return;
  }
  while (!state.stopRequested) {
    state.wakeArrived = false;
    state.notifyWake = undefined;
    await nextWake(state, client);
    if (client.isClosed) {
      throw new Error("pi socket closed");
    }
  }
  if (state.stopError !== undefined) {
    throw state.stopError;
  }
}

function limitedTail<T>(items: readonly T[], limit: number | undefined): readonly T[] {
  return limit === undefined ? items : items.slice(-limit);
}

function messageFromEntry(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  return undefined;
}

async function emitHistoricalMessages(
  client: PiSocketClient,
  writer: JsonlWriter,
  since: string | undefined,
  limit: number | undefined,
): Promise<void> {
  if (since === undefined) {
    const response = await client.request({ type: "get_messages" });
    for (const message of limitedTail(messagesFrom(response), limit)) {
      writer.writeRecord({ type: "message", message });
    }
    return;
  }
  const { entries } = await getEntries(client, since);
  const messages = entries
    .map((entry) => messageFromEntry(entry))
    .filter((message) => message !== undefined);
  for (const message of limitedTail(messages, limit)) {
    writer.writeRecord({ type: "message", message });
  }
}

async function drainEntries(
  client: PiSocketClient,
  writer: JsonlWriter,
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

async function streamEntries(
  client: PiSocketClient,
  writer: JsonlWriter,
  since: string | undefined,
  limit: number | undefined,
  until: StreamUntil | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  const state = newStreamState();
  client.onEvent((event) => handleSessionEvent(state, event));
  let cursor = await drainEntries(client, writer, since, limit);
  if (until === undefined) {
    return;
  }
  startStopWatcher(client, state, until, timeoutMs);
  if (until.kind === "killed") {
    while (true) {
      state.wakeArrived = false;
      state.notifyWake = undefined;
      await nextWake(state, client);
      if (client.isClosed) {
        throw new Error("pi socket closed");
      }
      if (state.resyncNeeded) {
        state.resyncNeeded = false;
        cursor = undefined;
      }
      cursor = await drainEntries(client, writer, cursor, undefined);
    }
  }
  while (!state.stopRequested) {
    state.wakeArrived = false;
    state.notifyWake = undefined;
    await nextWake(state, client);
    if (client.isClosed) {
      throw new Error("pi socket closed");
    }
    if (state.resyncNeeded) {
      state.resyncNeeded = false;
      cursor = undefined;
    }
    cursor = await drainEntries(client, writer, cursor, undefined);
  }
  if (state.stopError !== undefined) {
    throw state.stopError;
  }
  await drainEntries(client, writer, cursor, undefined);
}

async function streamRaw(
  client: PiSocketClient,
  writer: JsonlWriter,
  until: StreamUntil | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  client.onEvent((event) => writer.writeRecord(event));
  if (until === undefined || until.kind === "killed") {
    await waitForUntil(client, { kind: "killed" }, timeoutMs);
    return;
  }
  await waitForUntil(client, until, timeoutMs);
}

async function connectForContext(context: CommandContext): Promise<PiSocketClient> {
  const agent = await ensureAgentRunning(oneTarget(context).id);
  return await connectWithRetry(
    piSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
}

export async function streamPrompt(
  context: CommandContext,
  options: PromptStreamOptions,
): Promise<void> {
  const writer = new StdoutJsonlWriter(context);
  const client = await connectForContext(context);
  try {
    const command: RpcCommand = {
      type: "prompt",
      message: options.message,
      ...(options.images !== undefined && { images: options.images }),
      ...(options.streamingBehavior !== undefined && {
        streamingBehavior: options.streamingBehavior,
      }),
    };
    if (options.type === "detach") {
      await client.request(command);
      return;
    }
    const initialEntryCursor =
      options.type === "entries"
        ? (await getEntries(client, undefined)).entries.at(-1)?.id
        : undefined;
    const streamPromise =
      options.type === "messages"
        ? streamMessages(client, writer, options.until, options.timeoutMs)
        : options.type === "entries"
          ? streamEntries(
              client,
              writer,
              initialEntryCursor,
              undefined,
              options.until,
              options.timeoutMs,
            )
          : streamRaw(client, writer, options.until, options.timeoutMs);
    await client.request(command);
    await streamPromise;
    if (isFiniteUntil(options.until)) {
      await writeFinalCursor(client, writer);
    }
  } finally {
    client.close();
  }
}

export async function streamTail(
  context: CommandContext,
  options: TailStreamOptions,
): Promise<void> {
  if (options.outputType === "raw" && options.limit !== undefined) {
    throw new UsageError("-n is not supported with --type raw");
  }
  if (options.outputType === "raw" && options.since !== undefined) {
    throw new UsageError("--since is not supported with --type raw");
  }
  const writer = new StdoutJsonlWriter(context);
  const client = await connectForContext(context);
  try {
    const until =
      options.outputType === "raw" && options.until === undefined
        ? { kind: "killed" as const }
        : options.until;
    if (options.outputType === "messages") {
      await emitHistoricalMessages(client, writer, options.since, options.limit);
      await streamMessages(client, writer, until, options.timeoutMs);
    } else if (options.outputType === "entries") {
      await streamEntries(
        client,
        writer,
        options.since,
        options.limit,
        until,
        options.timeoutMs,
      );
    } else {
      await streamRaw(client, writer, until, options.timeoutMs);
    }
    if (until === undefined || isFiniteUntil(until)) {
      await writeFinalCursor(client, writer);
    }
  } finally {
    client.close();
  }
}
