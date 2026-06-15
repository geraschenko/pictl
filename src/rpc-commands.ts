/**
 * CLI ↔ RPC passthrough: one subcommand per command in pi's `RpcCommand`
 * union (full mirror — omissions need a very good reason). This is the only
 * module that should need editing when pi's RPC surface changes; the
 * subcommand table and usage text in main.ts are generated from it.
 *
 * Every subcommand takes the agent as its first positional, builds the typed
 * RPC command from the rest, sends it over the agent's pi.sock, and prints
 * the response's data as JSON (`--raw` for the raw response record).
 *
 * Flag names mirror pi's RpcCommand field names (kebab-cased) so users who
 * know the RPC surface can map them without guessing.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
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

type FlagValues = Record<
  string,
  string | boolean | Array<string | boolean> | undefined
>;

export interface RpcCliSpec {
  /** Usage names for required positionals after `<agent>`, e.g. ["<message>"]. */
  positionals: string[];
  /** Usage text for optional flags, e.g. "[--since <entry-id>]". */
  flagsUsage?: string;
  summary: string;
  options?: Record<string, { type: "string" | "boolean"; multiple?: boolean }>;
  /** Positional arity is validated by the runner; enum-valued args validate here. */
  build: (
    positionals: string[],
    values: FlagValues,
  ) => RpcCommand | Promise<RpcCommand>;
  /** Runs after the response is printed, on the same connection (e.g. prompt --wait). */
  afterResponse?: (client: PiSocketClient, values: FlagValues) => Promise<void>;
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

const IMAGE_OPTION = { image: { type: "string", multiple: true } } as const;
const IMAGE_FLAG_USAGE = "[--image <path>]...";

/** Read `--image` paths (repeatable) into pi's inline base64 image content. */
async function imagesFromFlags(
  values: FlagValues,
): Promise<{ images?: ImageContent[] }> {
  const imagePaths = values.image;
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    return {};
  }
  const images = await Promise.all(
    imagePaths.map(async (imagePath): Promise<ImageContent> => {
      const extension = extname(String(imagePath)).slice(1).toLowerCase();
      const mimeType = IMAGE_MIME_TYPES[extension];
      if (mimeType === undefined) {
        throw new UsageError(
          `--image ${imagePath}: unsupported extension; expected one of: ${Object.keys(IMAGE_MIME_TYPES).join(", ")}`,
        );
      }
      let data: Buffer;
      try {
        data = await readFile(String(imagePath));
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

/** `prompt -` and friends read the message from stdin. */
async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk.toString();
  }
  // Strip a single trailing newline, matching shell `$(...)` capture so
  // `echo msg | pictl prompt -` sends "msg", not "msg\n".
  return data.replace(/\n$/, "");
}

function messageFrom(positional: string): string | Promise<string> {
  return positional === "-" ? readStdin() : positional;
}

/** The wait condition for `prompt --and-wait[-until]`, or undefined for neither. */
function promptWaitCondition(values: FlagValues): WaitCondition | undefined {
  const until = values["and-wait-until"];
  if (typeof until === "string") {
    return parseWaitCondition(until);
  }
  return values["and-wait"] === true ? { kind: "turn-end" } : undefined;
}

const RPC_CLI_SPECS: Record<string, RpcCliSpec> = {
  prompt: {
    positionals: ["<message|->"],
    flagsUsage: `[--and-wait | --and-wait-until ${WAIT_UNTIL_USAGE}] [--streaming-behavior steer|follow-up] ${IMAGE_FLAG_USAGE}`,
    summary:
      "send a prompt (errors while streaming without --streaming-behavior)",
    options: {
      "and-wait": { type: "boolean" },
      "and-wait-until": { type: "string" },
      "streaming-behavior": { type: "string" },
      ...IMAGE_OPTION,
    },
    build: async ([message], values) => ({
      type: "prompt",
      message: await messageFrom(message!),
      ...(await imagesFromFlags(values)),
      ...(typeof values["streaming-behavior"] === "string" && {
        streamingBehavior:
          oneOf(
            values["streaming-behavior"],
            ["steer", "follow-up"],
            "--streaming-behavior",
          ) === "steer"
            ? ("steer" as const)
            : ("followUp" as const),
      }),
    }),
    // --and-wait[-until] blocks until the prompted turn meets the condition, on
    // this same connection so it is race-free by construction. Default is
    // turn-end; --and-wait-until takes wait's full vocabulary.
    afterResponse: async (client, values) => {
      const condition = promptWaitCondition(values);
      if (condition !== undefined) {
        await applyWaitCondition(client, condition, undefined);
      }
    },
  },
  steer: {
    positionals: ["<message|->"],
    flagsUsage: IMAGE_FLAG_USAGE,
    summary: "interject into the current turn",
    options: { ...IMAGE_OPTION },
    build: async ([message], values) => ({
      type: "steer",
      message: await messageFrom(message!),
      ...(await imagesFromFlags(values)),
    }),
  },
  "follow-up": {
    positionals: ["<message|->"],
    flagsUsage: IMAGE_FLAG_USAGE,
    summary: "queue a message for after the current turn",
    options: { ...IMAGE_OPTION },
    build: async ([message], values) => ({
      type: "follow_up",
      message: await messageFrom(message!),
      ...(await imagesFromFlags(values)),
    }),
  },
  abort: {
    positionals: [],
    summary: "abort the current turn",
    build: () => ({ type: "abort" }),
  },
  "new-session": {
    positionals: [],
    flagsUsage: "[--parent-session <path>]",
    summary: "start a fresh session",
    options: { "parent-session": { type: "string" } },
    build: (_positionals, values) => ({
      type: "new_session",
      ...(typeof values["parent-session"] === "string" && {
        parentSession: values["parent-session"],
      }),
    }),
  },
  "get-state": {
    positionals: [],
    summary: "session state (model, streaming, pending queue, ...)",
    build: () => ({ type: "get_state" }),
  },
  "set-model": {
    positionals: ["<provider>", "<model-id>"],
    summary: "switch model",
    build: ([provider, modelId]) => ({
      type: "set_model",
      provider: provider!,
      modelId: modelId!,
    }),
  },
  "cycle-model": {
    positionals: [],
    summary: "cycle to the next model",
    build: () => ({ type: "cycle_model" }),
  },
  "get-available-models": {
    positionals: [],
    summary: "list models",
    build: () => ({ type: "get_available_models" }),
  },
  "set-thinking-level": {
    positionals: ["<level>"],
    summary: "set thinking level",
    build: ([level]) => ({
      type: "set_thinking_level",
      level: oneOf(level!, THINKING_LEVELS, "thinking level"),
    }),
  },
  "cycle-thinking-level": {
    positionals: [],
    summary: "cycle thinking level",
    build: () => ({ type: "cycle_thinking_level" }),
  },
  "set-steering-mode": {
    positionals: ["<all|one-at-a-time>"],
    summary: "how queued steering messages are delivered",
    build: ([mode]) => ({
      type: "set_steering_mode",
      mode: oneOf(mode!, QUEUE_MODES, "steering mode"),
    }),
  },
  "set-follow-up-mode": {
    positionals: ["<all|one-at-a-time>"],
    summary: "how queued follow-ups are delivered",
    build: ([mode]) => ({
      type: "set_follow_up_mode",
      mode: oneOf(mode!, QUEUE_MODES, "follow-up mode"),
    }),
  },
  compact: {
    positionals: [],
    flagsUsage: "[--custom-instructions <text>]",
    summary: "compact the session context",
    options: { "custom-instructions": { type: "string" } },
    build: (_positionals, values) => ({
      type: "compact",
      ...(typeof values["custom-instructions"] === "string" && {
        customInstructions: values["custom-instructions"],
      }),
    }),
  },
  "set-auto-compaction": {
    positionals: ["<on|off>"],
    summary: "toggle auto-compaction",
    build: ([enabled]) => ({
      type: "set_auto_compaction",
      enabled: parseOnOff(enabled!, "auto-compaction"),
    }),
  },
  "set-auto-retry": {
    positionals: ["<on|off>"],
    summary: "toggle auto-retry of failed turns",
    build: ([enabled]) => ({
      type: "set_auto_retry",
      enabled: parseOnOff(enabled!, "auto-retry"),
    }),
  },
  "abort-retry": {
    positionals: [],
    summary: "cancel a pending auto-retry",
    build: () => ({ type: "abort_retry" }),
  },
  bash: {
    positionals: ["<command>"],
    flagsUsage: "[--exclude-from-context]",
    summary: "run a shell command via the agent",
    options: { "exclude-from-context": { type: "boolean" } },
    build: ([command], values) => ({
      type: "bash",
      command: command!,
      ...(values["exclude-from-context"] === true && {
        excludeFromContext: true,
      }),
    }),
  },
  "abort-bash": {
    positionals: [],
    summary: "abort a running bash command",
    build: () => ({ type: "abort_bash" }),
  },
  "get-session-stats": {
    positionals: [],
    summary: "token/cost stats",
    build: () => ({ type: "get_session_stats" }),
  },
  "export-html": {
    positionals: [],
    flagsUsage: "[--output-path <path>]",
    summary: "export the session as HTML",
    options: { "output-path": { type: "string" } },
    build: (_positionals, values) => ({
      type: "export_html",
      ...(typeof values["output-path"] === "string" && {
        outputPath: values["output-path"],
      }),
    }),
  },
  "switch-session": {
    positionals: ["<session-path>"],
    summary: "switch to another session file",
    build: ([sessionPath]) => ({
      type: "switch_session",
      sessionPath: sessionPath!,
    }),
  },
  fork: {
    positionals: ["<entry-id>"],
    summary: "fork the session from an entry",
    build: ([entryId]) => ({ type: "fork", entryId: entryId! }),
  },
  clone: {
    positionals: [],
    summary: "clone the session",
    build: () => ({ type: "clone" }),
  },
  "get-fork-messages": {
    positionals: [],
    summary: "list fork points",
    build: () => ({ type: "get_fork_messages" }),
  },
  "get-entries": {
    positionals: [],
    flagsUsage: "[--since <entry-id>]",
    summary: "session entries (cursors are session-scoped)",
    options: { since: { type: "string" } },
    build: (_positionals, values) => ({
      type: "get_entries",
      ...(typeof values.since === "string" && { since: values.since }),
    }),
  },
  "get-tree": {
    positionals: [],
    summary: "session entry tree",
    build: () => ({ type: "get_tree" }),
  },
  "navigate-tree": {
    positionals: ["<target-id>"],
    flagsUsage:
      "[--summarize] [--custom-instructions <text>] [--replace-instructions] [--label <text>]",
    summary: "move the session leaf to another entry",
    options: {
      summarize: { type: "boolean" },
      "custom-instructions": { type: "string" },
      "replace-instructions": { type: "boolean" },
      label: { type: "string" },
    },
    build: ([targetId], values) => ({
      type: "navigate_tree",
      targetId: targetId!,
      ...(values.summarize === true && { summarize: true }),
      ...(typeof values["custom-instructions"] === "string" && {
        customInstructions: values["custom-instructions"],
      }),
      ...(values["replace-instructions"] === true && {
        replaceInstructions: true,
      }),
      ...(typeof values.label === "string" && { label: values.label }),
    }),
  },
  "get-last-assistant-text": {
    positionals: [],
    summary: "text of the last assistant message",
    build: () => ({ type: "get_last_assistant_text" }),
  },
  "set-session-name": {
    positionals: ["<name>"],
    summary: "name the session",
    build: ([name]) => ({ type: "set_session_name", name: name! }),
  },
  "get-messages": {
    positionals: [],
    summary: "full message history",
    build: () => ({ type: "get_messages" }),
  },
  "get-commands": {
    positionals: [],
    summary: "slash commands available via prompt",
    build: () => ({ type: "get_commands" }),
  },
};

function cliInvocation(cliName: string, spec: RpcCliSpec): string {
  const parts = [`pictl ${cliName} <agent>`, ...spec.positionals];
  if (spec.flagsUsage) {
    parts.push(spec.flagsUsage);
  }
  return parts.join(" ");
}

function printResponse(response: RpcResponse, raw: boolean): void {
  if (raw) {
    console.log(JSON.stringify(response));
    return;
  }
  const data = (response as { data?: unknown }).data;
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

export async function runRpcCliCommand(
  cliName: string,
  spec: RpcCliSpec,
  argv: string[],
): Promise<void> {
  let parsed: { values: FlagValues; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        ...(spec.options ?? {}),
        raw: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : String(error)}\nusage: ${cliInvocation(cliName, spec)}`,
    );
  }
  const [agentIdPrefix, ...commandPositionals] = parsed.positionals;
  if (
    agentIdPrefix === undefined ||
    commandPositionals.length !== spec.positionals.length
  ) {
    throw new UsageError(`usage: ${cliInvocation(cliName, spec)}`);
  }
  const command = await spec.build(commandPositionals, parsed.values);

  const agent = await ensureAgentRunning(agentIdPrefix);
  const client = await connectWithRetry(
    piSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    const response = await client.request(command);
    printResponse(response, parsed.values.raw === true);
    if (spec.afterResponse) {
      await spec.afterResponse(client, parsed.values);
    }
  } finally {
    client.close();
  }
}

export const rpcCliSpecs = RPC_CLI_SPECS;

export function rpcCommandHandlers(): Record<
  string,
  (argv: string[]) => Promise<void>
> {
  return Object.fromEntries(
    Object.entries(RPC_CLI_SPECS).map(([cliName, spec]) => [
      cliName,
      (argv: string[]) => runRpcCliCommand(cliName, spec, argv),
    ]),
  );
}

/**
 * Usage lines for main.ts, aligned like the hand-written command table.
 * Summaries align to the longest invocation that fits the cap; a rare
 * outlier (navigate-tree) overflows rather than stretching every line.
 */
export function rpcCommandUsage(): string {
  const alignmentCapColumns = 60;
  const rows = Object.entries(RPC_CLI_SPECS).map(([cliName, spec]) => {
    const invocation = cliInvocation(cliName, spec).replace(/^pictl /, "");
    return [invocation, spec.summary] as const;
  });
  const width = Math.max(
    ...rows
      .map(([invocation]) => invocation.length)
      .filter((length) => length <= alignmentCapColumns),
  );
  return rows
    .map(([invocation, summary]) =>
      invocation.length <= width
        ? `  ${invocation.padEnd(width + 2)}${summary}`
        : `  ${invocation}  ${summary}`,
    )
    .join("\n");
}
