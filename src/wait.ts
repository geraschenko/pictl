/**
 * `pi-ctl wait <agent> --until turn-end|quiescent|idle:<secs>` — block until
 * the agent reaches a condition. Exit codes: 0 condition met, 1 agent dead or
 * runtime error, 2 usage error, 3 `--timeout` expired.
 *
 * - turn-end: the next `agent_end` with `willRetry === false` (a true value
 *   announces an auto-retry continuation, not a turn end). Returns immediately
 *   only when fully quiescent — a pending queued message counts as a turn
 *   that must end, which is what makes sequential `prompt; wait` race-free.
 * - quiescent: kill-style quiescence — not streaming AND pending queue empty.
 * - idle:<secs>: no socket events for N seconds, regardless of streaming
 *   state; catches turns stalled on human-facing UI, which `quiescent` never
 *   reports.
 */

import { parseArgs } from "node:util";
import {
  ensureAgentRunning,
  loadAgent,
  QuiescenceTimeoutError,
  waitQuiescent,
} from "./lifecycle.ts";
import { piSocketPath } from "./registry.ts";
import { connectWithRetry, getState, type PiSocketClient } from "./rpc.ts";
import { UsageError } from "./util.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

/** main.ts maps this to exit code 3. */
export class WaitTimeoutError extends Error {}

type WaitCondition =
  | { kind: "turn-end" }
  | { kind: "quiescent" }
  | { kind: "idle"; idleMs: number };

function parseUntil(value: string): WaitCondition {
  if (value === "turn-end") {
    return { kind: "turn-end" };
  }
  if (value === "quiescent") {
    return { kind: "quiescent" };
  }
  const idleSeconds = /^idle:(\d+)$/.exec(value)?.[1];
  if (idleSeconds !== undefined) {
    return { kind: "idle", idleMs: Number(idleSeconds) * 1000 };
  }
  throw new UsageError(
    `--until must be turn-end, quiescent, or idle:<secs> (got '${value}')`,
  );
}

async function waitTurnEnd(client: PiSocketClient): Promise<void> {
  // Registered before get_state so an agent_end landing between the state
  // check and the subscription is not missed.
  const turnEnded = new Promise<"turn-end" | "closed">((resolve) => {
    client.onEvent((event) => {
      if (event.type === "agent_end" && event.willRetry !== true) {
        resolve("turn-end");
      }
    });
    void client.waitClosed().then(() => resolve("closed"));
  });
  const state = await getState(client);
  if (!state.isStreaming && state.pendingMessageCount === 0) {
    return;
  }
  if ((await turnEnded) === "closed") {
    throw new Error("pi socket closed while waiting for turn end");
  }
}

function waitIdle(client: PiSocketClient, idleMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let idleTimer = setTimeout(resolve, idleMs);
    client.onEvent(() => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(resolve, idleMs);
    });
    void client.waitClosed().then(() => {
      clearTimeout(idleTimer);
      reject(new Error("pi socket closed while waiting for idleness"));
    });
  });
}

/**
 * Race `wait` against the --timeout deadline. The timer must be cleared after
 * the race (see the timer comment in lifecycle.ts terminatePi).
 */
async function withDeadline(
  wait: Promise<void>,
  timeoutMs: number | undefined,
): Promise<void> {
  if (timeoutMs === undefined) {
    return wait;
  }
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new WaitTimeoutError(`condition not met within ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([wait, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export async function runWait(argv: string[]): Promise<void> {
  let parsed: {
    values: { until?: string; timeout?: string };
    positionals: string[];
  };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { until: { type: "string" }, timeout: { type: "string" } },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length !== 1 || parsed.values.until === undefined) {
    throw new UsageError(
      "usage: pi-ctl wait <agent> --until turn-end|quiescent|idle:<secs> [--timeout <secs>]",
    );
  }
  const condition = parseUntil(parsed.values.until);
  const timeoutMs =
    parsed.values.timeout === undefined
      ? undefined
      : Number(parsed.values.timeout) * 1000;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs >= 0)) {
    throw new UsageError(`invalid --timeout: ${parsed.values.timeout}`);
  }

  const agent = await ensureAgentRunning(
    await loadAgent(parsed.positionals[0]!),
  );
  const client = await connectWithRetry(
    piSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    switch (condition.kind) {
      case "turn-end":
        await withDeadline(waitTurnEnd(client), timeoutMs);
        break;
      case "quiescent":
        try {
          await waitQuiescent(client, timeoutMs);
        } catch (error) {
          if (error instanceof QuiescenceTimeoutError) {
            throw new WaitTimeoutError(
              `still busy after ${timeoutMs! / 1000}s`,
            );
          }
          throw error;
        }
        break;
      case "idle":
        await withDeadline(waitIdle(client, condition.idleMs), timeoutMs);
        break;
    }
  } finally {
    client.close();
  }
}
