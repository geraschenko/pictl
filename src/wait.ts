/*
 * `pictl wait --target <agent> --until turn-end|idle|no-activity:<secs>` —
 * block until the agent reaches a condition. Exit codes: 0 condition met,
 * 1 runtime error, 2 usage error, 3 `--timeout` expired.
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
 * The shared condition parser/applier (`parseWaitCondition`/`applyWaitCondition`)
 * is reused by `tail --until` and `prompt --and-wait-until`.
 *
 * A dormant or archived agent is reported as having met any of these conditions
 * immediately — its process is doing nothing — and is never revived: revival
 * would only produce a guaranteed-idle agent (pi never resumes mid-turn work).
 */

import {
  commandOneTarget,
  oneTarget,
  requiredParsedFlag,
  secondsFlag,
  type CommandContext,
  type InferFlags,
} from "./cli.ts";
import { IdleTimeoutError, waitIdle } from "./lifecycle.ts";
import { isPidAlive, piSocketPath } from "./registry.ts";
import { connectWithRetry, getState, type PiSocketClient } from "./rpc.ts";
import { UsageError } from "./util.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

/** main.ts maps this to exit code 3. */
export class WaitTimeoutError extends Error {}

export type WaitCondition =
  | { kind: "turn-end" }
  | { kind: "idle" }
  | { kind: "no-activity"; idleMs: number };

export const WAIT_UNTIL_USAGE = "turn-end|idle|no-activity:<secs>";

export function parseWaitCondition(value: string): WaitCondition {
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
  throw new UsageError(`--until must be ${WAIT_UNTIL_USAGE} (got '${value}')`);
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
          new WaitTimeoutError(`condition not met within ${timeoutMs / 1000}s`),
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
export async function applyWaitCondition(
  client: PiSocketClient,
  condition: WaitCondition,
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
          throw new WaitTimeoutError(`still busy after ${timeoutMs! / 1000}s`);
        }
        throw error;
      }
      return;
    case "no-activity":
      await withDeadline(waitNoActivity(client, condition.idleMs), timeoutMs);
      return;
  }
}

const waitFlags = {
  until: requiredParsedFlag(
    `Wait condition (${WAIT_UNTIL_USAGE})`,
    parseWaitCondition,
    "cond",
  ),
  timeout: secondsFlag(),
};

type WaitFlags = InferFlags<typeof waitFlags>;

export async function wait(
  this: CommandContext,
  flags: WaitFlags,
): Promise<void> {
  const agent = oneTarget(this);
  if (!isPidAlive(agent.daemonPid)) {
    // Dormant/archived: the process is doing nothing, so the condition is
    // already met. Don't revive — a revived agent is guaranteed idle anyway.
    return;
  }
  const client = await connectWithRetry(
    piSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    await applyWaitCondition(
      client,
      flags.until,
      flags.timeout === undefined ? undefined : flags.timeout * 1000,
    );
  } finally {
    client.close();
  }
}

const waitCommand = commandOneTarget<WaitFlags>({
  docs: { brief: "block until the agent meets a condition" },
  parameters: { flags: waitFlags },
  func: wait,
});

export const waitRoute = {
  wait: waitCommand,
} as const;
