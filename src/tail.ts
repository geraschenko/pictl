// TDC: you deleted this entire description. Don't do that. Please _update_ the description to be accurate instead, or maybe add a description about streaming end conditions to the top of streaming.ts and refer to that here.
/*
 * `pictl tail --target <agent> [--follow] [--since <entry-id>]
 * [--until <cond>] [--events]` — session entries as JSONL on stdout, one
 * entry per line, followed by a cursor record so callers can persist their
 * place (cursors are session-scoped: persist the sessionId alongside, and
 * expect "entry not found" after `/new`, `/resume`, fork, or clone — pictl does
 * not interweave session files).
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

import {
  booleanFlag,
  commandOneTarget,
  completeChoices,
  parsedFlag,
  type CommandContext,
  type InferFlags,
} from "./cli.ts";
import {
  normalizeFollowUntil,
  parseStreamOutputType,
  parseStreamUntil,
  streamTail,
  STREAM_OUTPUT_TYPES,
  STREAM_UNTIL_USAGE,
  type StreamOutputType,
} from "./streaming.ts";
import { UsageError } from "./util.ts";

function parseLimit(input: string): number {
  const limit = Number(input);
  if (!(Number.isInteger(limit) && limit >= 0)) {
    throw new UsageError(`invalid -n value: ${input}`);
  }
  return limit;
}

const tailFlags = {
  type: parsedFlag(
    "Output type (messages|entries|raw)",
    parseStreamOutputType,
    "type",
    completeChoices(STREAM_OUTPUT_TYPES),
  ),
  // TDC: why was since changed from stringFlag to parsedFlag?
  since: parsedFlag("Start after entry id", String, "entry-id"),
  n: parsedFlag("Number of historical output units", parseLimit, "count"),
  follow: booleanFlag("Follow new output"),
  until: parsedFlag(
    `Stream until ${STREAM_UNTIL_USAGE}`,
    parseStreamUntil,
    "cond",
  ),
  timeout: parsedFlag(
    "Timeout in seconds",
    (input: string): number => {
      const seconds = Number(input);
      if (!(Number.isFinite(seconds) && seconds >= 0)) {
        throw new UsageError(`invalid seconds value: ${input}`);
      }
      return seconds;
    },
    "secs",
  ),
};

type TailFlags = InferFlags<typeof tailFlags>;

export async function tail(
  this: CommandContext,
  flags: TailFlags,
): Promise<void> {
  const outputType: StreamOutputType = flags.type ?? "messages";
  if (outputType === "raw" && flags.n !== undefined) {
    throw new UsageError("-n is not supported with --type raw");
  }
  await streamTail(this, {
    outputType,
    since: flags.since,
    limit: flags.n,
    until: normalizeFollowUntil({ follow: flags.follow, until: flags.until }),
    timeoutMs: flags.timeout === undefined ? undefined : flags.timeout * 1000,
  });
}

const tailCommand = commandOneTarget<TailFlags>({
  common: true,
  docs: { brief: "stream session activity as JSONL" },
  parameters: { flags: tailFlags, aliases: { f: "follow" } },
  func: tail,
});

export const tailRoute = {
  tail: tailCommand,
} as const;
