/*
 * `pictl tail --target <agent> [--follow] [--since <entry-id>]
 * [--until <cond>] [--events]` — session entries as JSONL on stdout, one
 * entry per line, followed by a cursor record so callers can persist their
 * place.
 */

import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import {
  commandOneTarget,
  oneTarget,
  trueFlag,
  type CommandContext,
} from "./cli.ts";
import { ensureAgentRunning } from "./lifecycle.ts";
import { piSocketPath } from "./registry.ts";
import {
  connectWithRetry,
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

type GetEntriesData = Extract<
  RpcResponse,
  { command: "get_entries"; success: true }
>["data"];

interface TailFlags {
  follow?: true;
  since?: string;
  until?: WaitCondition;
  events?: true;
}

function entriesFrom(response: RpcResponse): GetEntriesData["entries"] {
  // client.request throws on success: false, so the cast is safe here.
  return (
    response as Extract<RpcResponse, { command: "get_entries"; success: true }>
  ).data.entries;
}

function printCursorRecord(
  write: (text: string) => void,
  sessionId: string | undefined,
  entryId: string | null,
): void {
  write(
    `${JSON.stringify({
      type: "pictl_cursor",
      sessionId: sessionId ?? null,
      entryId,
    })}\n`,
  );
}

interface FollowState {
  sessionId: string | undefined;
  /** The session was replaced; the cursor belongs to the old session. */
  resyncNeeded: boolean;
  wakeArrived: boolean;
  notifyWake: (() => void) | undefined;
  /** A `--until` condition resolved; drain trailing entries and stop. */
  stopRequested: boolean;
  /** The `--until` wait rejected (e.g. socket closed); rethrow after the loop. */
  stopError: Error | undefined;
}

async function drainEntries(
  client: PiSocketClient,
  state: FollowState,
  cursor: string | undefined,
  write: (text: string) => void,
): Promise<string | undefined> {
  let response;
  try {
    response = await client.request({
      type: "get_entries",
      ...(cursor !== undefined && { since: cursor }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Entry not found")) {
      throw new Error(
        `${message}; the session may have changed (cursors are session-scoped)`,
      );
    }
    throw error;
  }
  const entries = entriesFrom(response);
  if (entries.length === 0) {
    return cursor;
  }
  for (const entry of entries) {
    write(`${JSON.stringify(entry)}\n`);
  }
  const lastEntryId = entries[entries.length - 1]!.id;
  printCursorRecord(write, state.sessionId, lastEntryId);
  return lastEntryId;
}

async function streamEvents(
  socketPath: string,
  stopCondition: WaitCondition | undefined,
  write: (text: string) => void,
): Promise<void> {
  const client = await connectWithRetry(
    socketPath,
    SOCKET_CONNECT_DEADLINE_MS,
    (event) => write(`${JSON.stringify(event)}\n`),
  );
  try {
    if (stopCondition === undefined) {
      await client.waitClosed();
      throw new Error("pi socket closed");
    }
    await applyWaitCondition(client, stopCondition, undefined);
  } finally {
    client.close();
  }
}

function handleFollowEvent(state: FollowState, event: SocketEvent): void {
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

function nextWake(state: FollowState, client: PiSocketClient): Promise<void> {
  if (state.wakeArrived || state.stopRequested) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.notifyWake = resolve;
    void client.waitClosed().then(resolve);
  });
}

export async function tail(
  this: CommandContext,
  flags: TailFlags,
): Promise<void> {
  if (flags.events === true && flags.since !== undefined) {
    throw new UsageError("--events streams raw events; --since does not apply");
  }
  const stopCondition = flags.until;
  const follow = flags.follow === true || stopCondition !== undefined;
  const agent = await ensureAgentRunning(oneTarget(this).id);
  const socketPath = piSocketPath(agent.agentDir);
  const write = (text: string): void => {
    this.process.stdout.write(text);
  };

  if (flags.events === true) {
    await streamEvents(socketPath, stopCondition, write);
    return;
  }

  const state: FollowState = {
    sessionId: undefined,
    resyncNeeded: false,
    wakeArrived: false,
    notifyWake: undefined,
    stopRequested: false,
    stopError: undefined,
  };
  const client = await connectWithRetry(
    socketPath,
    SOCKET_CONNECT_DEADLINE_MS,
    (event) => handleFollowEvent(state, event),
  );
  try {
    let cursor = await drainEntries(client, state, flags.since, write);
    if (cursor === undefined || cursor === flags.since) {
      printCursorRecord(write, state.sessionId, cursor ?? null);
    }
    if (!follow) {
      return;
    }
    if (stopCondition !== undefined) {
      void applyWaitCondition(client, stopCondition, undefined).then(
        () => {
          state.stopRequested = true;
          state.notifyWake?.();
        },
        (error: unknown) => {
          state.stopError =
            error instanceof Error ? error : new Error(String(error));
          state.stopRequested = true;
          state.notifyWake?.();
        },
      );
    }
    while (true) {
      state.wakeArrived = false;
      state.notifyWake = undefined;
      await nextWake(state, client);
      if (state.stopRequested) {
        break;
      }
      if (client.isClosed) {
        throw new Error("pi socket closed");
      }
      if (state.resyncNeeded) {
        state.resyncNeeded = false;
        cursor = await resyncToSessionTip(client, state, write);
        continue;
      }
      try {
        cursor = await drainEntries(client, state, cursor, write);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Entry not found")
        ) {
          state.resyncNeeded = true;
          continue;
        }
        throw error;
      }
    }
    if (state.stopError !== undefined) {
      throw state.stopError;
    }
    try {
      await drainEntries(client, state, cursor, write);
    } catch (error) {
      if (
        !(error instanceof Error && error.message.includes("Entry not found"))
      ) {
        throw error;
      }
    }
  } finally {
    client.close();
  }
}

const tailCommand = commandOneTarget<TailFlags>({
  common: true,
  docs: { brief: "session entries as JSONL, then a cursor record" },
  parameters: {
    flags: {
      follow: trueFlag("Follow new entries"),
      since: {
        kind: "parsed",
        parse: String,
        brief: "Start after entry id",
        optional: true,
      },
      until: {
        kind: "parsed",
        parse: parseWaitCondition,
        brief: `Follow until ${WAIT_UNTIL_USAGE}`,
        optional: true,
      },
      events: trueFlag("Stream raw events"),
    },
  },
  func: tail,
});

export const tailRoute = {
  tail: tailCommand,
} as const;

async function resyncToSessionTip(
  client: PiSocketClient,
  state: FollowState,
  write: (text: string) => void,
): Promise<string | undefined> {
  const response = await client.request({ type: "get_entries" });
  const entries = entriesFrom(response);
  const lastEntryId =
    entries.length === 0 ? undefined : entries[entries.length - 1]!.id;
  printCursorRecord(write, state.sessionId, lastEntryId ?? null);
  return lastEntryId;
}
