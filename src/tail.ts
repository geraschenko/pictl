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
