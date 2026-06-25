/*
 * CLI ↔ RPC passthrough: one subcommand per command in pi's `RpcCommand`
 * union (full mirror — omissions need a very good reason). This is the only
 * module that should need editing when pi's RPC surface changes; the
 * subcommand table and usage text in main.ts are generated from it.
 *
 * Every subcommand takes the agent as --target, builds the typed RPC command
 * from the rest, sends it over the agent's pi.sock, and prints the response's
 * data as JSON (`--raw` for the raw response record).
 *
 * Flag names mirror pi's RpcCommand field names (kebab-cased) so users who
 * know the RPC surface can map them without guessing.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { RpcCommand, RpcResponse } from "@geraschenko/pi-coding-agent";
import {
  booleanFlag,
  commandOneTarget,
  completeChoices,
  enumFlag,
  parsedFlag,
  stringArg,
  stringFlag,
  variadicStringFlag,
  type InferFlags,
} from "./cli.ts";
import { oneTarget, type CommandContext } from "./targets.ts";
import { ensureAgentRunning } from "./lifecycle.ts";
import { piSocketPath } from "./registry.ts";
import { connectWithRetry, type PiSocketClient } from "./pi-socket-client.ts";
import { oneOf, UsageError } from "./util.ts";
import {
  parseStreamOutputType,
  parseStreamUntil,
  promptDetached,
  streamPrompt,
  STREAM_OUTPUT_TYPES,
  STREAM_UNTIL_USAGE,
} from "./streaming.ts";
import { makeRecordWriter } from "../format/record-writer.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

function parseOnOff(value: string, what: string): boolean {
  return oneOf(value, ["on", "off"], what) === "on";
}

const QUEUE_MODES = ["all", "one-at-a-time"] as const;

/**
 * Mirrors pi's ThinkingLevel union. Validated here because pi does not
 * reject unknown levels — it silently clamps them (a typo would set "off").
 * Clamping of valid levels to model capabilities stays pi-side.
 */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/**
 * pi-ai's ImageContent. Derived from the prompt command's `images` field
 * rather than imported: the coding-agent package index does not re-export
 * it, and @earendil-works/pi-ai is a transitive dependency that does not
 * resolve from pictl's node_modules.
 */
type ImageContent = NonNullable<
  Extract<RpcCommand, { type: "prompt" }>["images"]
>[number];

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const rawFlag = {
  raw: booleanFlag("Print raw RPC response"),
};
type RawFlag = InferFlags<typeof rawFlag>;

const imageFlag = {
  image: variadicStringFlag("Attach image path", "path"),
};

const rawImageFlags = {
  ...rawFlag,
  ...imageFlag,
};
type RawImageFlags = InferFlags<typeof rawImageFlags>;

async function imagesFromFlags(
  imagePaths: readonly string[],
): Promise<{ images?: ImageContent[] }> {
  if (imagePaths.length === 0) {
    return {};
  }
  const images = await Promise.all(
    imagePaths.map(async (imagePath): Promise<ImageContent> => {
      const extension = extname(imagePath).slice(1).toLowerCase();
      const mimeType = IMAGE_MIME_TYPES[extension];
      if (mimeType === undefined) {
        throw new UsageError(
          `--image ${imagePath}: unsupported extension; expected one of: ${Object.keys(IMAGE_MIME_TYPES).join(", ")}`,
        );
      }
      let data: Buffer;
      try {
        data = await readFile(imagePath);
      } catch (error) {
        throw new Error(
          `--image ${imagePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { type: "image", data: data.toString("base64"), mimeType };
    }),
  );
  return { images };
}

async function readStdin(
  stdin: AsyncIterable<Buffer | string>,
): Promise<string> {
  let data = "";
  for await (const chunk of stdin) {
    data += chunk.toString();
  }
  return data.replace(/\n$/, "");
}

async function messageFrom(
  context: CommandContext,
  positional: string,
): Promise<string> {
  if (positional !== "-") {
    return positional;
  }
  // Reading prompt text from stdin is Node-specific; Stricli's process type
  // intentionally only models portable stdio.
  return readStdin((context.process as NodeJS.Process).stdin);
}

function printResponse(
  context: CommandContext,
  response: RpcResponse,
  raw: boolean,
): void {
  if (raw) {
    context.process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }
  const data = (response as { data?: unknown }).data;
  if (data !== undefined) {
    context.process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
}

async function sendRpc(
  context: CommandContext,
  command: RpcCommand,
  raw: boolean,
  afterResponse?: (client: PiSocketClient) => Promise<void>,
): Promise<void> {
  const agent = await ensureAgentRunning(oneTarget(context).id);
  const client = await connectWithRetry(
    piSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    const response = await client.request(command);
    printResponse(context, response, raw);
    if (afterResponse) {
      await afterResponse(client);
    }
  } finally {
    client.close();
  }
}

const promptFlags = {
  ...imageFlag,
  type: parsedFlag(
    "Output type (messages|entries|raw)",
    parseStreamOutputType,
    "type",
    completeChoices(STREAM_OUTPUT_TYPES),
  ),
  detach: booleanFlag("Send the prompt and return immediately"),
  json: booleanFlag("Emit JSONL instead of formatted output"),
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
  streamingBehavior: enumFlag("Behavior while the agent is streaming", [
    "steer",
    "follow-up",
  ]),
};
type PromptFlags = InferFlags<typeof promptFlags>;

export async function prompt(
  this: CommandContext,
  flags: PromptFlags,
  message: string,
): Promise<void> {
  const streamingBehavior =
    flags.streamingBehavior === undefined
      ? undefined
      : flags.streamingBehavior === "steer"
        ? "steer"
        : "followUp";
  if (flags.detach) {
    if (flags.until !== undefined) {
      throw new UsageError("--detach cannot be combined with --until");
    }
    if (flags.timeout !== undefined) {
      throw new UsageError("--detach cannot be combined with --timeout");
    }
    const { images } = await imagesFromFlags(flags.image);
    await promptDetached(this, {
      message: await messageFrom(this, message),
      images,
      streamingBehavior,
    });
    return;
  }
  const type = flags.type ?? "messages";
  const { images } = await imagesFromFlags(flags.image);
  await streamPrompt(this, {
    type,
    writer: makeRecordWriter(this, type, flags.json),
    until: flags.until ?? { kind: "turn-end" },
    timeoutMs: flags.timeout === undefined ? undefined : flags.timeout * 1000,
    message: await messageFrom(this, message),
    images,
    streamingBehavior,
  });
}

const promptCommand = commandOneTarget<PromptFlags, [string]>({
  common: true,
  docs: { brief: "send a prompt and stream the agent's activity" },
  parameters: {
    flags: promptFlags,
    aliases: { d: "detach" },
    positional: {
      kind: "tuple",
      parameters: [stringArg("Message", "message|-")],
    },
  },
  func: prompt,
});

export async function steer(
  this: CommandContext,
  flags: RawImageFlags,
  message: string,
): Promise<void> {
  await sendRpc(
    this,
    {
      type: "steer",
      message: await messageFrom(this, message),
      ...(await imagesFromFlags(flags.image)),
    },
    flags.raw,
  );
}

const steerCommand = commandOneTarget<RawImageFlags, [string]>({
  docs: { brief: "interject into the current turn" },
  parameters: {
    flags: rawImageFlags,
    positional: {
      kind: "tuple",
      parameters: [stringArg("Message", "message|-")],
    },
  },
  func: steer,
});

export async function followUp(
  this: CommandContext,
  flags: RawImageFlags,
  message: string,
): Promise<void> {
  await sendRpc(
    this,
    {
      type: "follow_up",
      message: await messageFrom(this, message),
      ...(await imagesFromFlags(flags.image)),
    },
    flags.raw,
  );
}

const followUpCommand = commandOneTarget<RawImageFlags, [string]>({
  docs: { brief: "queue a message for after the current turn" },
  parameters: {
    flags: rawImageFlags,
    positional: {
      kind: "tuple",
      parameters: [stringArg("Message", "message|-")],
    },
  },
  func: followUp,
});

async function sendSimple(
  context: CommandContext,
  flags: RawFlag,
  command: RpcCommand,
): Promise<void> {
  await sendRpc(context, command, flags.raw);
}

const abortCommand = commandOneTarget<RawFlag>({
  docs: { brief: "abort the current turn" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "abort" });
  },
});

const newSessionFlags = {
  ...rawFlag,
  parentSession: stringFlag("Parent session path", "path"),
};
type NewSessionFlags = InferFlags<typeof newSessionFlags>;

const newSessionCommand = commandOneTarget<NewSessionFlags>({
  docs: { brief: "start a fresh session" },
  parameters: { flags: newSessionFlags },
  func(flags) {
    return sendSimple(this, flags, {
      type: "new_session",
      ...(flags.parentSession !== undefined && {
        parentSession: flags.parentSession,
      }),
    });
  },
});

const getStateCommand = commandOneTarget<RawFlag>({
  docs: { brief: "session state (model, streaming, pending queue, ...)" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "get_state" });
  },
});

const setModelCommand = commandOneTarget<RawFlag, [string, string]>({
  docs: { brief: "switch model" },
  parameters: {
    flags: rawFlag,
    positional: {
      kind: "tuple",
      parameters: [
        stringArg("Provider", "provider"),
        stringArg("Model id", "model-id"),
      ],
    },
  },
  func(flags, provider, modelId) {
    return sendSimple(this, flags, { type: "set_model", provider, modelId });
  },
});

const cycleModelCommand = commandOneTarget<RawFlag>({
  docs: { brief: "cycle to the next model" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "cycle_model" });
  },
});

const getAvailableModelsCommand = commandOneTarget<RawFlag>({
  docs: { brief: "list models" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "get_available_models" });
  },
});

const setThinkingLevelCommand = commandOneTarget<
  RawFlag,
  [(typeof THINKING_LEVELS)[number]]
>({
  docs: { brief: "set thinking level" },
  parameters: {
    flags: rawFlag,
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg(
            "Thinking level",
            "level",
            completeChoices(THINKING_LEVELS),
          ),
          parse: (value: string) =>
            oneOf(value, THINKING_LEVELS, "thinking level"),
        },
      ],
    },
  },
  func(flags, level) {
    return sendSimple(this, flags, { type: "set_thinking_level", level });
  },
});

const cycleThinkingLevelCommand = commandOneTarget<RawFlag>({
  docs: { brief: "cycle thinking level" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "cycle_thinking_level" });
  },
});

const setSteeringModeCommand = commandOneTarget<
  RawFlag,
  ["all" | "one-at-a-time"]
>({
  docs: { brief: "how queued steering messages are delivered" },
  parameters: {
    flags: rawFlag,
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg(
            "Mode",
            "all|one-at-a-time",
            completeChoices(QUEUE_MODES),
          ),
          parse: (value: string) => oneOf(value, QUEUE_MODES, "steering mode"),
        },
      ],
    },
  },
  func(flags, mode) {
    return sendSimple(this, flags, { type: "set_steering_mode", mode });
  },
});

const setFollowUpModeCommand = commandOneTarget<
  RawFlag,
  ["all" | "one-at-a-time"]
>({
  docs: { brief: "how queued follow-ups are delivered" },
  parameters: {
    flags: rawFlag,
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg(
            "Mode",
            "all|one-at-a-time",
            completeChoices(QUEUE_MODES),
          ),
          parse: (value: string) => oneOf(value, QUEUE_MODES, "follow-up mode"),
        },
      ],
    },
  },
  func(flags, mode) {
    return sendSimple(this, flags, { type: "set_follow_up_mode", mode });
  },
});

const compactFlags = {
  ...rawFlag,
  customInstructions: stringFlag("Custom instructions", "str"),
};
type CompactFlags = InferFlags<typeof compactFlags>;

const compactCommand = commandOneTarget<CompactFlags>({
  docs: { brief: "compact the session context" },
  parameters: { flags: compactFlags },
  func(flags) {
    return sendSimple(this, flags, {
      type: "compact",
      ...(flags.customInstructions !== undefined && {
        customInstructions: flags.customInstructions,
      }),
    });
  },
});

const setAutoCompactionCommand = commandOneTarget<RawFlag, [boolean]>({
  docs: { brief: "toggle auto-compaction" },
  parameters: {
    flags: rawFlag,
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg("Enabled", "on|off", completeChoices(["on", "off"])),
          parse: (value: string) => parseOnOff(value, "auto-compaction"),
        },
      ],
    },
  },
  func(flags, enabled) {
    return sendSimple(this, flags, { type: "set_auto_compaction", enabled });
  },
});

const setAutoRetryCommand = commandOneTarget<RawFlag, [boolean]>({
  docs: { brief: "toggle auto-retry of failed turns" },
  parameters: {
    flags: rawFlag,
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg("Enabled", "on|off", completeChoices(["on", "off"])),
          parse: (value: string) => parseOnOff(value, "auto-retry"),
        },
      ],
    },
  },
  func(flags, enabled) {
    return sendSimple(this, flags, { type: "set_auto_retry", enabled });
  },
});

const abortRetryCommand = commandOneTarget<RawFlag>({
  docs: { brief: "cancel a pending auto-retry" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "abort_retry" });
  },
});

const bashFlags = {
  ...rawFlag,
  excludeFromContext: booleanFlag("Exclude from context"),
};
type BashFlags = InferFlags<typeof bashFlags>;

const bashCommand = commandOneTarget<BashFlags, [string]>({
  docs: { brief: "run a shell command via the agent" },
  parameters: {
    flags: bashFlags,
    positional: {
      kind: "tuple",
      parameters: [stringArg("Command", "command")],
    },
  },
  func(flags, command) {
    return sendSimple(this, flags, {
      type: "bash",
      command,
      ...(flags.excludeFromContext && { excludeFromContext: true }),
    });
  },
});

const abortBashCommand = commandOneTarget<RawFlag>({
  docs: { brief: "abort a running bash command" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "abort_bash" });
  },
});

const getSessionStatsCommand = commandOneTarget<RawFlag>({
  docs: { brief: "token/cost stats" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "get_session_stats" });
  },
});

const exportHtmlFlags = {
  ...rawFlag,
  outputPath: stringFlag("Output path", "path"),
};
type ExportHtmlFlags = InferFlags<typeof exportHtmlFlags>;

const exportHtmlCommand = commandOneTarget<ExportHtmlFlags>({
  docs: { brief: "export the session as HTML" },
  parameters: { flags: exportHtmlFlags },
  func(flags) {
    return sendSimple(this, flags, {
      type: "export_html",
      ...(flags.outputPath !== undefined && { outputPath: flags.outputPath }),
    });
  },
});

const switchSessionCommand = commandOneTarget<RawFlag, [string]>({
  docs: { brief: "switch to another session file" },
  parameters: {
    flags: rawFlag,
    positional: {
      kind: "tuple",
      parameters: [stringArg("Session path", "session-path")],
    },
  },
  func(flags, sessionPath) {
    return sendSimple(this, flags, { type: "switch_session", sessionPath });
  },
});

const forkCommand = commandOneTarget<RawFlag, [string]>({
  docs: { brief: "fork the session from an entry" },
  parameters: {
    flags: rawFlag,
    positional: {
      kind: "tuple",
      parameters: [stringArg("Entry id", "entry-id")],
    },
  },
  func(flags, entryId) {
    return sendSimple(this, flags, { type: "fork", entryId });
  },
});

const cloneCommand = commandOneTarget<RawFlag>({
  docs: { brief: "clone the session" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "clone" });
  },
});

const getForkMessagesCommand = commandOneTarget<RawFlag>({
  docs: { brief: "list fork points" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "get_fork_messages" });
  },
});

const getEntriesFlags = {
  ...rawFlag,
  since: stringFlag("Entry id", "entry-id"),
};
type GetEntriesFlags = InferFlags<typeof getEntriesFlags>;

const getEntriesCommand = commandOneTarget<GetEntriesFlags>({
  docs: { brief: "session entries (cursors are session-scoped)" },
  parameters: { flags: getEntriesFlags },
  func(flags) {
    return sendSimple(this, flags, {
      type: "get_entries",
      ...(flags.since !== undefined && { since: flags.since }),
    });
  },
});

const getTreeCommand = commandOneTarget<RawFlag>({
  docs: { brief: "session entry tree" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "get_tree" });
  },
});

const navigateTreeFlags = {
  ...rawFlag,
  summarize: booleanFlag("Summarize"),
  customInstructions: stringFlag("Custom instructions", "str"),
  replaceInstructions: booleanFlag("Replace instructions"),
  label: stringFlag("Label", "str"),
};
type NavigateTreeFlags = InferFlags<typeof navigateTreeFlags>;

const navigateTreeCommand = commandOneTarget<NavigateTreeFlags, [string]>({
  docs: { brief: "move the session leaf to another entry" },
  parameters: {
    flags: navigateTreeFlags,
    positional: {
      kind: "tuple",
      parameters: [stringArg("Target id", "target-id")],
    },
  },
  func(flags, targetId) {
    return sendSimple(this, flags, {
      type: "navigate_tree",
      targetId,
      ...(flags.summarize && { summarize: true }),
      ...(flags.customInstructions !== undefined && {
        customInstructions: flags.customInstructions,
      }),
      ...(flags.replaceInstructions && { replaceInstructions: true }),
      ...(flags.label !== undefined && { label: flags.label }),
    });
  },
});

const getLastAssistantTextCommand = commandOneTarget<RawFlag>({
  docs: { brief: "text of the last assistant message" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "get_last_assistant_text" });
  },
});

const setSessionNameCommand = commandOneTarget<RawFlag, [string]>({
  docs: { brief: "name the session" },
  parameters: {
    flags: rawFlag,
    positional: { kind: "tuple", parameters: [stringArg("Name", "name")] },
  },
  func(flags, name) {
    return sendSimple(this, flags, { type: "set_session_name", name });
  },
});

const getMessagesCommand = commandOneTarget<RawFlag>({
  docs: { brief: "full message history" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "get_messages" });
  },
});

const getCommandsCommand = commandOneTarget<RawFlag>({
  docs: { brief: "slash commands available via prompt" },
  parameters: { flags: rawFlag },
  func(flags) {
    return sendSimple(this, flags, { type: "get_commands" });
  },
});

export const rpcRoutes = {
  prompt: promptCommand,
  steer: steerCommand,
  "follow-up": followUpCommand,
  abort: abortCommand,
  "new-session": newSessionCommand,
  "get-state": getStateCommand,
  "set-model": setModelCommand,
  "cycle-model": cycleModelCommand,
  "get-available-models": getAvailableModelsCommand,
  "set-thinking-level": setThinkingLevelCommand,
  "cycle-thinking-level": cycleThinkingLevelCommand,
  "set-steering-mode": setSteeringModeCommand,
  "set-follow-up-mode": setFollowUpModeCommand,
  compact: compactCommand,
  "set-auto-compaction": setAutoCompactionCommand,
  "set-auto-retry": setAutoRetryCommand,
  "abort-retry": abortRetryCommand,
  bash: bashCommand,
  "abort-bash": abortBashCommand,
  "get-session-stats": getSessionStatsCommand,
  "export-html": exportHtmlCommand,
  "switch-session": switchSessionCommand,
  fork: forkCommand,
  clone: cloneCommand,
  "get-fork-messages": getForkMessagesCommand,
  "get-entries": getEntriesCommand,
  "get-tree": getTreeCommand,
  "navigate-tree": navigateTreeCommand,
  "get-last-assistant-text": getLastAssistantTextCommand,
  "set-session-name": setSessionNameCommand,
  "get-messages": getMessagesCommand,
  "get-commands": getCommandsCommand,
} as const;
