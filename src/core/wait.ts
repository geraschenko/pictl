/*
 * `pictl wait --target <agent> --until turn-end|idle|no-activity:<secs>` —
 * block until the agent reaches a condition. Exit codes: 0 condition met,
 * 1 runtime error, 2 usage error, 3 `--timeout` expired.
 *
 * The condition grammar lives in until-engine.ts and the pi semantics in
 * until.ts (shared with `tail --until` and streaming `prompt --until`).
 *
 * A dormant or archived agent is reported as having met any of these conditions
 * immediately — its process is doing nothing — and is never revived: revival
 * would only produce a guaranteed-idle agent (pi never resumes mid-turn work).
 */

import {
  commandOneTarget,
  completeChoices,
  requiredParsedFlag,
  secondsFlag,
  type InferFlags,
} from "./cli.ts";
import { oneTarget, type CommandContext } from "./targets.ts";
import { isPidAlive, piSocketPath } from "./registry.ts";
import { connectWithRetry } from "./pi-socket-client.ts";
import {
  parseUntilCondition,
  secondsToTimerMs,
  UntilTimeoutError,
  UNTIL_COMPLETIONS,
  UNTIL_USAGE,
} from "./until-engine.ts";
import { runStream } from "./streaming/driver.ts";
import { untilMetAtSeed, untilMetByEvent, untilQuietMs } from "./until.ts";
import { SOCKET_CONNECT_DEADLINE_MS } from "./constants.ts";

const waitFlags = {
  until: requiredParsedFlag(
    `Wait condition (${UNTIL_USAGE})`,
    parseUntilCondition,
    "cond",
    completeChoices(UNTIL_COMPLETIONS),
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
    const result = await runStream(
      client,
      {
        onSeed: (seed) => untilMetAtSeed(flags.until, seed),
        onEvent: (event, state) => untilMetByEvent(flags.until, event, state),
        quietMs: untilQuietMs(flags.until),
      },
      flags.timeout === undefined ? undefined : secondsToTimerMs(flags.timeout),
    );
    if (result.outcome === "closed") {
      throw new Error("pi socket closed before condition met");
    }
    if (result.outcome === "timeout") {
      throw new UntilTimeoutError(`condition not met within ${flags.timeout}s`);
    }
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
