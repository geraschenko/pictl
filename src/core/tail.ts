/*
 * `pictl tail --target <agent> [--type messages|entries|raw] [--since <entry-id>]
 * [-n <count>] [--until <cond>] [--json]` streams activity from one agent:
 * historical output first (per `-n`/`--since`), then it follows new events
 * until `--until` is met (emitting a final `pictl_cursor` record) or, without
 * `--until`, until pi closes the socket (exit 1).
 *
 * Output is human-readable by default; `--json` emits JSONL (for piping into
 * `pictl format`). Message mode is the default. It prints historical
 * message-shaped records, then follows append-only message/control events.
 * Entry mode drains real session entries with `get_entries --since <cursor>`
 * per socket event. Raw mode prints future socket records directly (always as
 * JSON); it has no historical backlog, so `-n` and `--since` do not apply.
 */

import {
  booleanFlag,
  commandOneTarget,
  completeChoices,
  parsedFlag,
  stringFlag,
  type InferFlags,
} from "./cli.ts";
import { type CommandContext } from "./targets.ts";
import {
  parseStreamOutputType,
  streamTail,
  STREAM_OUTPUT_TYPES,
  type StreamOutputType,
} from "./streaming.ts";
import {
  parseUntilCondition,
  secondsToTimerMs,
  UNTIL_USAGE,
} from "./until-engine.ts";
import { makeRecordWriter } from "../format/record-writer.ts";
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
  since: stringFlag("Start after entry id", "entry-id"),
  n: parsedFlag("Number of historical output units", parseLimit, "count"),
  until: parsedFlag(`Stream until ${UNTIL_USAGE}`, parseUntilCondition, "cond"),
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
  json: booleanFlag("Emit JSONL instead of formatted output"),
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
    writer: makeRecordWriter(this, outputType, flags.json),
    since: flags.since,
    limit: flags.n,
    until: flags.until,
    timeoutMs:
      flags.timeout === undefined ? undefined : secondsToTimerMs(flags.timeout),
  });
}

const tailCommand = commandOneTarget<TailFlags>({
  common: true,
  docs: { brief: "stream session activity" },
  parameters: { flags: tailFlags, aliases: { n: "n" } },
  func: tail,
});

export const tailRoute = {
  tail: tailCommand,
} as const;
