/*
 * CLI ↔ RPC passthrough: one subcommand per command in pi's `RpcCommand`
 * union. This module owns the RPC command-line surface.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import {
  commandOneTarget,
  oneTarget,
  stringArg,
  trueFlag,
  type CommandContext,
} from "./cli.ts";
import { ensureAgentRunning } from "./lifecycle.ts";
import { piSocketPath } from "./registry.ts";
import { connectWithRetry, type PiSocketClient } from "./rpc.ts";
import { UsageError } from "./util.ts";
import {
  applyWaitCondition,
  parseWaitCondition,
  WAIT_UNTIL_USAGE,
  type WaitCondition,
} from "./wait.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

interface RawFlags {
  raw?: true;
}

interface ImageFlags {
  image?: readonly string[];
}

interface PromptFlags extends RawFlags, ImageFlags {
  andWait?: true;
  andWaitUntil?: WaitCondition;
  streamingBehavior?: "steer" | "follow-up";
}

interface ParentSessionFlags extends RawFlags {
  parentSession?: string;
}

interface CustomInstructionsFlags extends RawFlags {
  customInstructions?: string;
}

interface BashFlags extends RawFlags {
  excludeFromContext?: true;
}

interface OutputPathFlags extends RawFlags {
  outputPath?: string;
}

interface SinceFlags extends RawFlags {
  since?: string;
}

interface NavigateTreeFlags extends RawFlags {
  summarize?: true;
  customInstructions?: string;
  replaceInstructions?: true;
  label?: string;
}

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  what: string,
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new UsageError(
    `${what} must be one of: ${allowed.join(", ")} (got '${value}')`,
  );
}

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

const rawFlag = trueFlag("Print raw RPC response");
const imageFlag = {
  kind: "parsed",
  parse: String,
  brief: "Attach image path",
  optional: true,
  variadic: true,
} as const;

async function imagesFromFlags(
  imagePaths: readonly string[] | undefined,
): Promise<{ images?: ImageContent[] }> {
  if (imagePaths === undefined || imagePaths.length === 0) {
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
  return positional === "-" ? readStdin(context.process.stdin) : positional;
}

function promptWaitCondition(flags: PromptFlags): WaitCondition | undefined {
  return (
    flags.andWaitUntil ??
    (flags.andWait === true ? { kind: "turn-end" } : undefined)
  );
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

export async function prompt(
  this: CommandContext,
  flags: PromptFlags,
  message: string,
): Promise<void> {
  const command: RpcCommand = {
    type: "prompt",
    message: await messageFrom(this, message),
    ...(await imagesFromFlags(flags.image)),
    ...(flags.streamingBehavior !== undefined && {
      streamingBehavior:
        flags.streamingBehavior === "steer" ? "steer" : "followUp",
    }),
  };
  await sendRpc(this, command, flags.raw === true, async (client) => {
    const condition = promptWaitCondition(flags);
    if (condition !== undefined) {
      await applyWaitCondition(client, condition, undefined);
    }
  });
}

export async function steer(
  this: CommandContext,
  flags: RawFlags & ImageFlags,
  message: string,
): Promise<void> {
  await sendRpc(
    this,
    {
      type: "steer",
      message: await messageFrom(this, message),
      ...(await imagesFromFlags(flags.image)),
    },
    flags.raw === true,
  );
}

export async function followUp(
  this: CommandContext,
  flags: RawFlags & ImageFlags,
  message: string,
): Promise<void> {
  await sendRpc(
    this,
    {
      type: "follow_up",
      message: await messageFrom(this, message),
      ...(await imagesFromFlags(flags.image)),
    },
    flags.raw === true,
  );
}

async function sendSimple(
  context: CommandContext,
  flags: RawFlags,
  command: RpcCommand,
): Promise<void> {
  await sendRpc(context, command, flags.raw === true);
}

const promptCommand = commandOneTarget<PromptFlags, [string]>({
  common: true,
  docs: {
    brief:
      "send a prompt (errors while streaming without --streaming-behavior)",
  },
  parameters: {
    flags: {
      raw: rawFlag,
      andWait: trueFlag("Wait for turn end after prompting"),
      andWaitUntil: {
        kind: "parsed",
        parse: parseWaitCondition,
        brief: `Wait until ${WAIT_UNTIL_USAGE} after prompting`,
        optional: true,
      },
      streamingBehavior: {
        kind: "enum",
        values: ["steer", "follow-up"],
        brief: "Behavior while the agent is streaming",
        optional: true,
      },
      image: imageFlag,
    },
    positional: {
      kind: "tuple",
      parameters: [stringArg("Message", "message|-")],
    },
  },
  func: prompt,
});

const steerCommand = commandOneTarget<RawFlags & ImageFlags, [string]>({
  docs: { brief: "interject into the current turn" },
  parameters: {
    flags: { raw: rawFlag, image: imageFlag },
    positional: {
      kind: "tuple",
      parameters: [stringArg("Message", "message|-")],
    },
  },
  func: steer,
});

const followUpCommand = commandOneTarget<RawFlags & ImageFlags, [string]>({
  docs: { brief: "queue a message for after the current turn" },
  parameters: {
    flags: { raw: rawFlag, image: imageFlag },
    positional: {
      kind: "tuple",
      parameters: [stringArg("Message", "message|-")],
    },
  },
  func: followUp,
});

const abortCommand = commandOneTarget<RawFlags>({
  docs: { brief: "abort the current turn" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "abort" });
  },
});

const newSessionCommand = commandOneTarget<ParentSessionFlags>({
  docs: { brief: "start a fresh session" },
  parameters: {
    flags: {
      raw: rawFlag,
      parentSession: {
        kind: "parsed",
        parse: String,
        brief: "Parent session path",
        optional: true,
      },
    },
  },
  func(flags) {
    return sendSimple(this, flags, {
      type: "new_session",
      ...(flags.parentSession !== undefined && {
        parentSession: flags.parentSession,
      }),
    });
  },
});

const getStateCommand = commandOneTarget<RawFlags>({
  docs: { brief: "session state (model, streaming, pending queue, ...)" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "get_state" });
  },
});

const setModelCommand = commandOneTarget<RawFlags, [string, string]>({
  docs: { brief: "switch model" },
  parameters: {
    flags: { raw: rawFlag },
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

const cycleModelCommand = commandOneTarget<RawFlags>({
  docs: { brief: "cycle to the next model" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "cycle_model" });
  },
});

const getAvailableModelsCommand = commandOneTarget<RawFlags>({
  docs: { brief: "list models" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "get_available_models" });
  },
});

const setThinkingLevelCommand = commandOneTarget<
  RawFlags,
  [(typeof THINKING_LEVELS)[number]]
>({
  docs: { brief: "set thinking level" },
  parameters: {
    flags: { raw: rawFlag },
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg("Thinking level", "level"),
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

const cycleThinkingLevelCommand = commandOneTarget<RawFlags>({
  docs: { brief: "cycle thinking level" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "cycle_thinking_level" });
  },
});

const setSteeringModeCommand = commandOneTarget<
  RawFlags,
  ["all" | "one-at-a-time"]
>({
  docs: { brief: "how queued steering messages are delivered" },
  parameters: {
    flags: { raw: rawFlag },
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg("Mode", "all|one-at-a-time"),
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
  RawFlags,
  ["all" | "one-at-a-time"]
>({
  docs: { brief: "how queued follow-ups are delivered" },
  parameters: {
    flags: { raw: rawFlag },
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg("Mode", "all|one-at-a-time"),
          parse: (value: string) => oneOf(value, QUEUE_MODES, "follow-up mode"),
        },
      ],
    },
  },
  func(flags, mode) {
    return sendSimple(this, flags, { type: "set_follow_up_mode", mode });
  },
});

const compactCommand = commandOneTarget<CustomInstructionsFlags>({
  docs: { brief: "compact the session context" },
  parameters: {
    flags: {
      raw: rawFlag,
      customInstructions: {
        kind: "parsed",
        parse: String,
        brief: "Custom instructions",
        optional: true,
      },
    },
  },
  func(flags) {
    return sendSimple(this, flags, {
      type: "compact",
      ...(flags.customInstructions !== undefined && {
        customInstructions: flags.customInstructions,
      }),
    });
  },
});

const setAutoCompactionCommand = commandOneTarget<RawFlags, [boolean]>({
  docs: { brief: "toggle auto-compaction" },
  parameters: {
    flags: { raw: rawFlag },
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg("Enabled", "on|off"),
          parse: (value: string) => parseOnOff(value, "auto-compaction"),
        },
      ],
    },
  },
  func(flags, enabled) {
    return sendSimple(this, flags, { type: "set_auto_compaction", enabled });
  },
});

const setAutoRetryCommand = commandOneTarget<RawFlags, [boolean]>({
  docs: { brief: "toggle auto-retry of failed turns" },
  parameters: {
    flags: { raw: rawFlag },
    positional: {
      kind: "tuple",
      parameters: [
        {
          ...stringArg("Enabled", "on|off"),
          parse: (value: string) => parseOnOff(value, "auto-retry"),
        },
      ],
    },
  },
  func(flags, enabled) {
    return sendSimple(this, flags, { type: "set_auto_retry", enabled });
  },
});

const abortRetryCommand = commandOneTarget<RawFlags>({
  docs: { brief: "cancel a pending auto-retry" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "abort_retry" });
  },
});

const bashCommand = commandOneTarget<BashFlags, [string]>({
  docs: { brief: "run a shell command via the agent" },
  parameters: {
    flags: {
      raw: rawFlag,
      excludeFromContext: trueFlag("Exclude from context"),
    },
    positional: {
      kind: "tuple",
      parameters: [stringArg("Command", "command")],
    },
  },
  func(flags, command) {
    return sendSimple(this, flags, {
      type: "bash",
      command,
      ...(flags.excludeFromContext === true && { excludeFromContext: true }),
    });
  },
});

const abortBashCommand = commandOneTarget<RawFlags>({
  docs: { brief: "abort a running bash command" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "abort_bash" });
  },
});

const getSessionStatsCommand = commandOneTarget<RawFlags>({
  docs: { brief: "token/cost stats" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "get_session_stats" });
  },
});

const exportHtmlCommand = commandOneTarget<OutputPathFlags>({
  docs: { brief: "export the session as HTML" },
  parameters: {
    flags: {
      raw: rawFlag,
      outputPath: {
        kind: "parsed",
        parse: String,
        brief: "Output path",
        optional: true,
      },
    },
  },
  func(flags) {
    return sendSimple(this, flags, {
      type: "export_html",
      ...(flags.outputPath !== undefined && { outputPath: flags.outputPath }),
    });
  },
});

const switchSessionCommand = commandOneTarget<RawFlags, [string]>({
  docs: { brief: "switch to another session file" },
  parameters: {
    flags: { raw: rawFlag },
    positional: {
      kind: "tuple",
      parameters: [stringArg("Session path", "session-path")],
    },
  },
  func(flags, sessionPath) {
    return sendSimple(this, flags, { type: "switch_session", sessionPath });
  },
});

const forkCommand = commandOneTarget<RawFlags, [string]>({
  docs: { brief: "fork the session from an entry" },
  parameters: {
    flags: { raw: rawFlag },
    positional: {
      kind: "tuple",
      parameters: [stringArg("Entry id", "entry-id")],
    },
  },
  func(flags, entryId) {
    return sendSimple(this, flags, { type: "fork", entryId });
  },
});

const cloneCommand = commandOneTarget<RawFlags>({
  docs: { brief: "clone the session" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "clone" });
  },
});

const getForkMessagesCommand = commandOneTarget<RawFlags>({
  docs: { brief: "list fork points" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "get_fork_messages" });
  },
});

const getEntriesCommand = commandOneTarget<SinceFlags>({
  docs: { brief: "session entries (cursors are session-scoped)" },
  parameters: {
    flags: {
      raw: rawFlag,
      since: {
        kind: "parsed",
        parse: String,
        brief: "Entry id",
        optional: true,
      },
    },
  },
  func(flags) {
    return sendSimple(this, flags, {
      type: "get_entries",
      ...(flags.since !== undefined && { since: flags.since }),
    });
  },
});

const getTreeCommand = commandOneTarget<RawFlags>({
  docs: { brief: "session entry tree" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "get_tree" });
  },
});

const navigateTreeCommand = commandOneTarget<NavigateTreeFlags, [string]>({
  docs: { brief: "move the session leaf to another entry" },
  parameters: {
    flags: {
      raw: rawFlag,
      summarize: trueFlag("Summarize"),
      customInstructions: {
        kind: "parsed",
        parse: String,
        brief: "Custom instructions",
        optional: true,
      },
      replaceInstructions: trueFlag("Replace instructions"),
      label: { kind: "parsed", parse: String, brief: "Label", optional: true },
    },
    positional: {
      kind: "tuple",
      parameters: [stringArg("Target id", "target-id")],
    },
  },
  func(flags, targetId) {
    return sendSimple(this, flags, {
      type: "navigate_tree",
      targetId,
      ...(flags.summarize === true && { summarize: true }),
      ...(flags.customInstructions !== undefined && {
        customInstructions: flags.customInstructions,
      }),
      ...(flags.replaceInstructions === true && { replaceInstructions: true }),
      ...(flags.label !== undefined && { label: flags.label }),
    });
  },
});

const getLastAssistantTextCommand = commandOneTarget<RawFlags>({
  docs: { brief: "text of the last assistant message" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "get_last_assistant_text" });
  },
});

const setSessionNameCommand = commandOneTarget<RawFlags, [string]>({
  docs: { brief: "name the session" },
  parameters: {
    flags: { raw: rawFlag },
    positional: { kind: "tuple", parameters: [stringArg("Name", "name")] },
  },
  func(flags, name) {
    return sendSimple(this, flags, { type: "set_session_name", name });
  },
});

const getMessagesCommand = commandOneTarget<RawFlags>({
  docs: { brief: "full message history" },
  parameters: { flags: { raw: rawFlag } },
  func(flags) {
    return sendSimple(this, flags, { type: "get_messages" });
  },
});

const getCommandsCommand = commandOneTarget<RawFlags>({
  docs: { brief: "slash commands available via prompt" },
  parameters: { flags: { raw: rawFlag } },
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
