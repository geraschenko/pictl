/*
 * pictl's instantiation of the until-engine over pi's RPC socket protocol,
 * consumed through runStream (stream-driver.ts) by `wait`, `tail --until`,
 * streaming `prompt --until`, and lifecycle's polite stop. The grammar and
 * generic checkers live in until-engine.ts.
 *
 * Condition semantics under pi's protocol:
 * - turn-end: the next `agent_end` event with `willRetry !== true` (a true
 *   value announces an auto-retry continuation, not a turn end). Met at the
 *   seed only when idle — a pending queued message counts as a turn that
 *   must end, which is what makes sequential `prompt; wait` race-free.
 * - idle: `isIdle` on the post-fold state. The fold clears `isStreaming` on
 *   `agent_settled` (no automatic retry, compaction, or queued continuation
 *   will run), so idle waits out retries and in-run compaction.
 * - no-activity:<secs>: no socket event for N seconds, regardless of
 *   streaming state; catches turns stalled on human-facing UI, which `idle`
 *   never reports. N may be fractional (e.g. `no-activity:0.5`). Enforced by
 *   the stream driver's quiet timer, never by an event.
 */

import type {
  RpcSessionState,
  RpcSocketBroadcastEvent,
} from "@geraschenko/pi-coding-agent";
import { makeUntilCheckers } from "./until-engine.ts";

/** Compacting counts as working, even when triggered manually on an
 *  otherwise idle agent. */
export function isIdle(state: RpcSessionState): boolean {
  return (
    !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0
  );
}

export const { untilMetAtSeed, untilMetByEvent, untilQuietMs } =
  makeUntilCheckers<RpcSocketBroadcastEvent, RpcSessionState>({
    isIdle,
    // pi's socket always sends the session-layer agent_end (which carries
    // willRetry); the core variant without it exists only in the type union
    // and counts as a turn end.
    isTurnEnd: (event) =>
      event.type === "agent_end" &&
      (!("willRetry" in event) || event.willRetry !== true),
  });
