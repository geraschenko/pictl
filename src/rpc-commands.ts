/**
 * CLI ↔ RPC passthrough: one subcommand per command in pi's `RpcCommand`
 * union (full mirror — omissions need a very good reason). This is the only
 * module that should need editing when pi's RPC surface changes; the
 * subcommand table and usage text in main.ts are generated from it.
 *
 * Every subcommand takes the agent as its first positional, builds the typed
 * RPC command from the rest, sends it over the agent's pi.sock, and prints
 * the response's data as JSON (`--json` for the raw response record).
 *
 * Not mirrored: the `images` field on prompt/steer/follow_up (no good CLI
 * shape for inline image content in v1).
 */

import { parseArgs } from "node:util";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { loadAgent } from "./lifecycle.ts";
import { isPidAlive, piSocketPath } from "./registry.ts";
import { connectWithRetry } from "./rpc.ts";
import { UsageError } from "./util.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

type FlagValues = Record<
  string,
  string | boolean | Array<string | boolean> | undefined
>;

interface RpcCliSpec {
  /** Usage names for required positionals after `<agent>`, e.g. ["<message>"]. */
  positionals: string[];
  /** Usage text for optional flags, e.g. "[--since <entry-id>]". */
  flagsUsage?: string;
  summary: string;
  options?: Record<string, { type: "string" | "boolean" }>;
  /** Positional arity is validated by the runner; enum-valued args validate here. */
  build: (positionals: string[], values: FlagValues) => RpcCommand;
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

const RPC_CLI_SPECS: Record<string, RpcCliSpec> = {
  prompt: {
    positionals: ["<message>"],
    flagsUsage: "[--streaming-behavior steer|follow-up]",
    summary: "send a prompt (errors while streaming without --streaming-behavior)",
    options: { "streaming-behavior": { type: "string" } },
    build: ([message], values) => ({
      type: "prompt",
      message: message!,
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
  },
  steer: {
    positionals: ["<message>"],
    summary: "interject into the current turn",
    build: ([message]) => ({ type: "steer", message: message! }),
  },
  "follow-up": {
    positionals: ["<message>"],
    summary: "queue a message for after the current turn",
    build: ([message]) => ({ type: "follow_up", message: message! }),
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
    flagsUsage: "[--instructions <text>]",
    summary: "compact the session context",
    options: { instructions: { type: "string" } },
    build: (_positionals, values) => ({
      type: "compact",
      ...(typeof values.instructions === "string" && {
        customInstructions: values.instructions,
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
    flagsUsage: "[--output <path>]",
    summary: "export the session as HTML",
    options: { output: { type: "string" } },
    build: (_positionals, values) => ({
      type: "export_html",
      ...(typeof values.output === "string" && {
        outputPath: values.output,
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
      "[--summarize] [--instructions <text>] [--replace-instructions] [--label <text>]",
    summary: "move the session leaf to another entry",
    options: {
      summarize: { type: "boolean" },
      instructions: { type: "string" },
      "replace-instructions": { type: "boolean" },
      label: { type: "string" },
    },
    build: ([targetId], values) => ({
      type: "navigate_tree",
      targetId: targetId!,
      ...(values.summarize === true && { summarize: true }),
      ...(typeof values.instructions === "string" && {
        customInstructions: values.instructions,
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
  const parts = [`pi-ctl ${cliName} <agent>`, ...spec.positionals];
  if (spec.flagsUsage) {
    parts.push(spec.flagsUsage);
  }
  return parts.join(" ");
}

function printResponse(response: RpcResponse, rawJson: boolean): void {
  if (rawJson) {
    console.log(JSON.stringify(response));
    return;
  }
  const data = (response as { data?: unknown }).data;
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function runRpcCliCommand(
  cliName: string,
  spec: RpcCliSpec,
  argv: string[],
): Promise<void> {
  let parsed: { values: FlagValues; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { ...(spec.options ?? {}), json: { type: "boolean" } },
    });
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : String(error)}\nusage: ${cliInvocation(cliName, spec)}`,
    );
  }
  const [agentPrefix, ...commandPositionals] = parsed.positionals;
  if (
    agentPrefix === undefined ||
    commandPositionals.length !== spec.positionals.length
  ) {
    throw new UsageError(`usage: ${cliInvocation(cliName, spec)}`);
  }
  const command = spec.build(commandPositionals, parsed.values);

  const agent = await loadAgent(agentPrefix);
  if (!isPidAlive(agent.record.holderPid)) {
    // TODO(phase 3): transparently revive dormant agents here.
    throw new Error(
      `agent '${agent.agentId}' is dormant; run \`pi-ctl resume ${agent.agentId}\``,
    );
  }
  const client = await connectWithRetry(
    piSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    const response = await client.request(command);
    printResponse(response, parsed.values.json === true);
  } finally {
    client.close();
  }
}

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
    const invocation = cliInvocation(cliName, spec).replace(/^pi-ctl /, "");
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
