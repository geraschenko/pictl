/**
 * `pictl tail <agent> [--follow] [--since <entry-id>] [--until <cond>]
 * [--events]` — session entries as JSONL on stdout, one entry per line,
 * followed by a `{"type":"pictl_cursor","sessionId":...,"entryId":...}` record
 * so callers can persist their place (cursors are session-scoped: persist the
 * sessionId alongside, and expect "entry not found" after `/new`, `/resume`,
 * fork, or clone — pictl does not interweave session files).
 *
 * --follow keeps the connection open and streams subsequent entries. Events
 * are only wakeups: every drain re-issues `get_entries --since <cursor>`, so
 * the session file remains the single source of truth. A session replacement
 * mid-follow quietly resyncs the cursor to the new session's tip (announced
 * by a fresh cursor record) and only entries created after the replacement
 * stream out.
 *
 * --until <cond> stops following once a wait condition holds (turn-end|idle|
 * no-activity:<secs>) and exits 0; in entry mode it drains any trailing entries
 * first. It implies --follow.
 *
 * --events instead streams the raw broadcast events as JSONL (implies
 * following; entry draining and --since do not apply). --until still applies —
 * events stream until the condition holds.
 */

import { parseArgs } from "node:util";
import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import { argvFromFlags, command } from "./cli.ts";
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
      type: "pictl_cursor",
      sessionId: sessionId ?? null,
      entryId,
    }),
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

/**
 * Fetch entries after `cursor`, print them, and return the advanced cursor
 * (unchanged when nothing new). The cursor is the last printed entry's id —
 * file order — not the response's leafId, which tree navigation can move
 * backwards onto an already-printed entry.
 *
 * Takes the state rather than a sessionId snapshot: the per-connection
 * session_changed event may still be in flight when the drain starts, but pi
 * sends it before any response, so by the time the response resolves the
 * state carries the session id.
 */
async function drainEntries(
  client: PiSocketClient,
  state: FollowState,
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
  printCursorRecord(state.sessionId, lastEntryId);
  return lastEntryId;
}

async function streamEvents(
  socketPath: string,
  stopCondition: WaitCondition | undefined,
): Promise<void> {
  const client = await connectWithRetry(
    socketPath,
    SOCKET_CONNECT_DEADLINE_MS,
    (event) => console.log(JSON.stringify(event)),
  );
  try {
    if (stopCondition === undefined) {
      await client.waitClosed();
      throw new Error("pi socket closed");
    }
    // Events keep printing via the connect callback; this watches the same
    // connection for the stop condition and returns 0 when it holds.
    await applyWaitCondition(client, stopCondition, undefined);
  } finally {
    client.close();
  }
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
  if (state.wakeArrived || state.stopRequested) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.notifyWake = resolve;
    void client.waitClosed().then(resolve);
  });
}

export const tailCommand = command({
  targetMode: "single",
  common: true,
  docs: { brief: "session entries as JSONL, then a cursor record" },
  parameters: {
    flags: {
      follow: { kind: "boolean", brief: "Follow new entries", optional: true },
      since: {
        kind: "parsed",
        parse: String,
        brief: "Start after entry id",
        optional: true,
      },
      until: {
        kind: "parsed",
        parse: String,
        brief: `Follow until ${WAIT_UNTIL_USAGE}`,
        optional: true,
      },
      events: { kind: "boolean", brief: "Stream raw events", optional: true },
    },
  },
  func: async function (flags) {
    await runTail([
      this.targets[0]!.id,
      ...argvFromFlags(flags, ["follow", "events"], ["since", "until"]),
    ]);
  },
});

export async function runTail(argv: string[]): Promise<void> {
  let parsed: {
    values: {
      follow?: boolean;
      since?: string;
      until?: string;
      events?: boolean;
    };
    positionals: string[];
  };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        follow: { type: "boolean" },
        since: { type: "string" },
        until: { type: "string" },
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
      `usage: pictl tail <agent> [--follow] [--since <entry-id>] [--until ${WAIT_UNTIL_USAGE}] [--events]`,
    );
  }
  if (parsed.values.events && parsed.values.since !== undefined) {
    throw new UsageError("--events streams raw events; --since does not apply");
  }
  // --until implies --follow: it only makes sense while streaming.
  const stopCondition =
    parsed.values.until === undefined
      ? undefined
      : parseWaitCondition(parsed.values.until);
  const follow = parsed.values.follow === true || stopCondition !== undefined;

  const agent = await ensureAgentRunning(parsed.positionals[0]!);
  const socketPath = piSocketPath(agent.agentDir);

  if (parsed.values.events) {
    await streamEvents(socketPath, stopCondition);
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
    let cursor = await drainEntries(client, state, parsed.values.since);
    if (cursor === undefined || cursor === parsed.values.since) {
      // Nothing printed yet; emit the cursor record the caller persists.
      printCursorRecord(state.sessionId, cursor ?? null);
    }
    if (!follow) {
      return;
    }
    if (stopCondition !== undefined) {
      // Run the stop condition alongside the drain loop. When it resolves we
      // wake the loop, which breaks after a final drain of trailing entries.
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
        cursor = await resyncToSessionTip(client, state);
        continue;
      }
      try {
        cursor = await drainEntries(client, state, cursor);
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
    if (state.stopError !== undefined) {
      throw state.stopError;
    }
    // The agent_end that satisfied the condition may have produced entries the
    // loop has not drained yet. Best-effort final drain; a session swap racing
    // the stop leaves nothing for us to print, so ignore a stale cursor.
    try {
      await drainEntries(client, state, cursor);
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

/**
 * After a session replacement the old cursor is meaningless; position at the
 * new session's last entry without printing history (only entries created
 * after the replacement should stream), announcing the new position.
 */
async function resyncToSessionTip(
  client: PiSocketClient,
  state: FollowState,
): Promise<string | undefined> {
  const response = await client.request({ type: "get_entries" });
  const entries = entriesFrom(response);
  const lastEntryId =
    entries.length === 0 ? undefined : entries[entries.length - 1]!.id;
  printCursorRecord(state.sessionId, lastEntryId ?? null);
  return lastEntryId;
}
