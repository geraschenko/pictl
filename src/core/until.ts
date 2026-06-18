/*
 * The `--until` condition engine: parsing condition strings and blocking on a
 * pi.sock client until the condition holds. Shared by the `wait` command,
 * `tail --until`, and `prompt --and-wait-until`.
 *
 * - turn-end: the next `agent_end` with `willRetry === false` (a true value
 *   announces an auto-retry continuation, not a turn end). Returns immediately
 *   only when fully idle — a pending queued message counts as a turn that must
 *   end, which is what makes sequential `prompt; wait` race-free.
 * - idle: not streaming AND pending queue empty (the common condition, so it
 *   gets the short name).
 * - no-activity:<secs>: no socket events for N seconds, regardless of streaming
 *   state; catches turns stalled on human-facing UI, which `idle` never reports.
 *   N may be fractional (e.g. `no-activity:0.5`).
 * 
 * TDC: why not include "killed" here to mean "until this process or the pi process dies"? Basically, why have StreamUntil as a separate type from UntilCondition? It seems perfectly sensible to say --until killed for wait, tail, and prompt.
 */

import { IdleTimeoutError, waitIdle } from "./lifecycle.ts";
import { getState, type PiSocketClient } from "./pi-socket-client.ts";
import { UsageError } from "./util.ts";

export const UNTIL_COMPLETIONS = ["turn-end", "idle", "no-activity:"] as const;

/** app.ts maps this to exit code 3. */
export class UntilTimeoutError extends Error {}

export type UntilCondition =
  | { kind: "turn-end" }
  | { kind: "idle" }
  | { kind: "no-activity"; idleMs: number };

export const UNTIL_USAGE = "turn-end|idle|no-activity:<secs>";

export function parseUntilCondition(value: string): UntilCondition {
  if (value === "turn-end") {
    return { kind: "turn-end" };
  }
  if (value === "idle") {
    return { kind: "idle" };
  }
  const noActivitySeconds = /^no-activity:(\d+(?:\.\d+)?)$/.exec(value)?.[1];
  if (noActivitySeconds !== undefined) {
    return { kind: "no-activity", idleMs: Number(noActivitySeconds) * 1000 };
  }
  throw new UsageError(`--until must be ${UNTIL_USAGE} (got '${value}')`);
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

function waitNoActivity(client: PiSocketClient, idleMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let idleTimer = setTimeout(resolve, idleMs);
    client.onEvent(() => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(resolve, idleMs);
    });
    void client.waitClosed().then(() => {
      clearTimeout(idleTimer);
      reject(new Error("pi socket closed while waiting for inactivity"));
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
      () =>
        reject(
          new UntilTimeoutError(
            `condition not met within ${timeoutMs / 1000}s`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    await Promise.race([wait, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/** Block on the already-connected client until `condition` holds (or timeout). */
export async function applyUntilCondition(
  client: PiSocketClient,
  condition: UntilCondition,
  timeoutMs: number | undefined,
): Promise<void> {
  switch (condition.kind) {
    case "turn-end":
      await withDeadline(waitTurnEnd(client), timeoutMs);
      return;
    case "idle":
      try {
        await waitIdle(client, timeoutMs);
      } catch (error) {
        if (error instanceof IdleTimeoutError) {
          throw new UntilTimeoutError(`still busy after ${timeoutMs! / 1000}s`);
        }
        throw error;
      }
      return;
    case "no-activity":
      await withDeadline(waitNoActivity(client, condition.idleMs), timeoutMs);
      return;
  }
}
