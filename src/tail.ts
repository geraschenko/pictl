/**
 * `pi-ctl tail <agent> [--follow] [--since <entry-id>] [--events]` — session
 * entries as JSONL on stdout, one entry per line, followed by a
 * `{"type":"pi_ctl_cursor","sessionId":...,"entryId":...}` record so callers
 * can persist their place (cursors are session-scoped: persist the sessionId
 * alongside, and expect "entry not found" after `/new`, `/resume`, fork, or
 * clone — pi-ctl does not interweave session files).
 *
 * --follow keeps the connection open and streams subsequent entries. Events
 * are only wakeups: every drain re-issues `get_entries --since <cursor>`, so
 * the session file remains the single source of truth. A session replacement
 * mid-follow quietly resyncs the cursor to the new session's tip (announced
 * by a fresh cursor record) and only entries created after the replacement
 * stream out.
 *
 * --events instead streams the raw broadcast events as JSONL (implies
 * following; entry draining and --since do not apply).
 */

import { parseArgs } from "node:util";
import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import { ensureAgentRunning, loadAgent } from "./lifecycle.ts";
import { piSocketPath } from "./registry.ts";
import {
  connectWithRetry,
  type PiSocketClient,
  type SocketEvent,
} from "./rpc.ts";
import { UsageError } from "./util.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

/**
 * Event types that fire per streamed token; waking on them would hammer
 * get_entries during a turn. Everything else (including event types this
 * code does not know about) is a wakeup — entries only materialize at
 * message/turn boundaries, so the next non-noisy event drains them.
 */
const STREAMING_NOISE_EVENTS = new Set([
  "message_update",
  "tool_execution_update",
]);

type GetEntriesData = Extract<
  RpcResponse,
  { command: "get_entries"; success: true }
>["data"];

function entriesFrom(response: RpcResponse): GetEntriesData["entries"] {
  // client.request throws on success: false, so the cast is safe here.
  return (
    response as Extract<RpcResponse, { command: "get_entries"; success: true }>
  ).data.entries;
}

function printCursorRecord(
  sessionId: string | undefined,
  entryId: string | null,
): void {
  console.log(
    JSON.stringify({
      type: "pi_ctl_cursor",
      sessionId: sessionId ?? null,
      entryId,
    }),
  );
}

/**
 * Fetch entries after `cursor`, print them, and return the advanced cursor
 * (unchanged when nothing new). The cursor is the last printed entry's id —
 * file order — not the response's leafId, which tree navigation can move
 * backwards onto an already-printed entry.
 */
async function drainEntries(
  client: PiSocketClient,
  sessionId: string | undefined,
  cursor: string | undefined,
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
    console.log(JSON.stringify(entry));
  }
  const lastEntryId = entries[entries.length - 1]!.id;
  printCursorRecord(sessionId, lastEntryId);
  return lastEntryId;
}

async function streamEvents(socketPath: string): Promise<void> {
  const client = await connectWithRetry(
    socketPath,
    SOCKET_CONNECT_DEADLINE_MS,
    (event) => console.log(JSON.stringify(event)),
  );
  await client.waitClosed();
  throw new Error("pi socket closed");
}

interface FollowState {
  sessionId: string | undefined;
  /** The session was replaced; the cursor belongs to the old session. */
  resyncNeeded: boolean;
  wakeArrived: boolean;
  notifyWake: (() => void) | undefined;
}

function handleFollowEvent(state: FollowState, event: SocketEvent): void {
  if (event.type === "session_changed") {
    const announcedSessionId = (event as { sessionId?: string }).sessionId;
    // The first session_changed (right after hello) announces the current
    // session — identity, not replacement.
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
  if (state.wakeArrived) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.notifyWake = resolve;
    void client.waitClosed().then(resolve);
  });
}

export async function runTail(argv: string[]): Promise<void> {
  let parsed: {
    values: { follow?: boolean; since?: string; events?: boolean };
    positionals: string[];
  };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        follow: { type: "boolean" },
        since: { type: "string" },
        events: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (parsed.positionals.length !== 1) {
    throw new UsageError(
      "usage: pi-ctl tail <agent> [--follow] [--since <entry-id>] [--events]",
    );
  }
  if (parsed.values.events && parsed.values.since !== undefined) {
    throw new UsageError("--events streams raw events; --since does not apply");
  }

  const agent = await ensureAgentRunning(
    await loadAgent(parsed.positionals[0]!),
  );
  const socketPath = piSocketPath(agent.agentDir);

  if (parsed.values.events) {
    await streamEvents(socketPath);
    return;
  }

  const state: FollowState = {
    sessionId: undefined,
    resyncNeeded: false,
    wakeArrived: false,
    notifyWake: undefined,
  };
  const client = await connectWithRetry(
    socketPath,
    SOCKET_CONNECT_DEADLINE_MS,
    (event) => handleFollowEvent(state, event),
  );
  try {
    let cursor = await drainEntries(client, state.sessionId, parsed.values.since);
    if (cursor === undefined || cursor === parsed.values.since) {
      // Nothing printed yet; emit the cursor record the caller persists.
      printCursorRecord(state.sessionId, cursor ?? null);
    }
    if (!parsed.values.follow) {
      return;
    }
    while (true) {
      state.wakeArrived = false;
      state.notifyWake = undefined;
      await nextWake(state, client);
      if (client.isClosed) {
        throw new Error("pi socket closed");
      }
      if (state.resyncNeeded) {
        state.resyncNeeded = false;
        cursor = await resyncToSessionTip(client, state.sessionId);
        continue;
      }
      try {
        cursor = await drainEntries(client, state.sessionId, cursor);
      } catch (error) {
        // A drain can race the session_changed broadcast: the cursor belongs
        // to the replaced session and pi reports it unknown. Resync instead
        // of dying; the next iteration handles it.
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
  } finally {
    client.close();
  }
}

/**
 * After a session replacement the old cursor is meaningless; position at the
 * new session's last entry without printing history (only entries created
 * after the replacement should stream), announcing the new position.
 */
async function resyncToSessionTip(
  client: PiSocketClient,
  sessionId: string | undefined,
): Promise<string | undefined> {
  const response = await client.request({ type: "get_entries" });
  const entries = entriesFrom(response);
  const lastEntryId =
    entries.length === 0 ? undefined : entries[entries.length - 1]!.id;
  printCursorRecord(sessionId, lastEntryId ?? null);
  return lastEntryId;
}
