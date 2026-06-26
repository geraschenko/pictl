/*
 * `pictl tail --target <agent> [--type messages|entries|raw] [--since <entry-id>]
 * [-n <count>] [--follow|-f] [--until <cond>] [--json]` streams activity from
 * one agent and emits a final `pictl_cursor` record for bounded streams.
 *
 * Output is human-readable by default; `--json` emits JSONL (for piping into
 * `pictl format`). Message mode is the default. It prints historical
 * message-shaped records, then optionally follows append-only message/control
 * events. Entry mode drains real session entries with `get_entries --since
 * <cursor>` on socket wakeups. Raw mode prints future socket records directly
 * (always as JSON); it has no historical backlog, so `-n` and `--since` do not
 * apply.
 *
 * `--follow`/`-f` is sugar for `--until killed` and conflicts with explicit
 * `--until`. Finite `--until` conditions stop the stream, drain trailing output
 * where applicable, and then write one final cursor.
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
  normalizeFollowUntil,
  parseStreamOutputType,
  parseStreamUntil,
  streamTail,
  STREAM_OUTPUT_TYPES,
  STREAM_UNTIL_USAGE,
  type StreamOutputType,
} from "./streaming.ts";
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
    until: normalizeFollowUntil({ follow: flags.follow, until: flags.until }),
    timeoutMs: flags.timeout === undefined ? undefined : flags.timeout * 1000,
  });
}

const tailCommand = commandOneTarget<TailFlags>({
  common: true,
  docs: { brief: "stream session activity" },
  parameters: { flags: tailFlags, aliases: { f: "follow", n: "n" } },
  func: tail,
});

export const tailRoute = {
  tail: tailCommand,
} as const;
