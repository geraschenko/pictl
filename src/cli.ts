import {
  buildCommand,
  formatMessageForArgumentScannerError,
  run,
  text_en,
  type CommandContext as StricliCommandContext,
  type CommandFunction,
  type StricliProcess,
} from "@stricli/core";
import type { Application } from "@stricli/core";
import type { AgentRecord } from "./registry.ts";
import { loadAgent } from "./registry.ts";
import { UsageError } from "./util.ts";

export type TargetMode = "none" | "single" | "multiple";

export interface CommandContext extends StricliCommandContext {
  process: StricliProcess;
  env: NodeJS.ProcessEnv;
  /** Empty for targetMode none; length 1 for single; length >= 1 for multiple. */
  targets: AgentRecord[];
}

// TDC: Doesn't having a totally generic Flags undermine the point of stricli's strict typing? Should each command have its own flags struct which is convertible to this type?
export type Flags = Readonly<Record<string, unknown>>;

export interface CommandSpec {
  targetMode: TargetMode;
  /** Marker field: commands are hidden from default help unless marked common. */
  common?: true;
  docs: {
    brief: string;
    fullDescription?: string;
    customUsage?: readonly string[];
  };
  parameters?: {
    flags?: Record<string, unknown>;
    aliases?: Record<string, string>;
    positional?: unknown;
  };
  func: (
    this: CommandContext,
    flags: Flags,
    ...args: string[]
  ) => Promise<void> | void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function determineTargets(
  targetMode: TargetMode,
  flagTargets: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  switch (targetMode) {
    case "none":
      if (flagTargets.length > 0) {
        throw new UsageError("this command does not accept --target");
      }
      return [];
    case "single": {
      if (flagTargets.length > 1) {
        throw new UsageError("expected at most one --target");
      }
      const target = flagTargets[0] ?? env.PICTL_TARGET;
      if (target === undefined || target === "") {
        throw new UsageError("expected --target <agent> (or PICTL_TARGET)");
      }
      return [target];
    }
    case "multiple": {
      if (flagTargets.length > 0) {
        return [...flagTargets];
      }
      if (env.PICTL_TARGET !== undefined && env.PICTL_TARGET !== "") {
        return [env.PICTL_TARGET];
      }
      throw new UsageError(
        "expected at least one --target <agent> (or PICTL_TARGET)",
      );
    }
  }
}

export async function resolveTargets(
  targetInputs: readonly string[],
): Promise<AgentRecord[]> {
  return await Promise.all(targetInputs.map((target) => loadAgent(target)));
}

function targetFlag(mode: TargetMode): Record<string, unknown> {
  if (mode === "none") {
    return {};
  }
  return {
    target: {
      kind: "parsed",
      parse: String,
      brief: "Target agent id or unique prefix",
      placeholder: "agent",
      optional: true,
      variadic: mode === "multiple" ? true : false,
    },
  };
}

function withTargets(
  spec: CommandSpec,
): CommandFunction<Flags, string[], CommandContext> {
  return async function (
    this: CommandContext,
    flags: Flags,
    ...args: string[]
  ) {
    const rawTargets = flags.target;
    const flagTargets = Array.isArray(rawTargets)
      ? rawTargets.map(String)
      : rawTargets === undefined
        ? []
        : [String(rawTargets)];
    this.targets = await resolveTargets(
      determineTargets(spec.targetMode, flagTargets, this.env),
    );
    await spec.func.call(this, flags, ...args);
  };
}

export function command(spec: CommandSpec) {
  return Object.assign(
    buildCommand({
      func: withTargets(spec) as never,
      parameters: {
        flags: {
          ...targetFlag(spec.targetMode),
          ...(spec.parameters?.flags ?? {}),
        } as never,
        aliases: {
          ...(spec.targetMode === "none" ? {} : { t: "target" }),
          ...(spec.parameters?.aliases ?? {}),
        } as never,
        ...(spec.parameters?.positional === undefined
          ? {}
          : { positional: spec.parameters.positional }),
      } as never,
      docs: spec.docs,
    }),
    { common: spec.common },
  );
}

// TDC: What the fuck?! Why are you defining a function to *undo* the whole thing we're trying to do.
export function argvFromFlags(
  flags: Readonly<Record<string, unknown>>,  // TDC: Flags? Why not use the types you define?
  booleanNames: string[],
  stringNames: string[],
): string[] {
  const argv: string[] = [];
  for (const name of booleanNames) {
    if (flags[name] === true) {
      argv.push(`--${name}`);
    }
  }
  for (const name of stringNames) {
    const value = flags[name];
    if (value !== undefined) {
      argv.push(`--${name}`, String(value));
    }
  }
  return argv;
}

export function restArgs(brief: string, placeholder: string, minimum = 0) {
  return {
    kind: "array",
    minimum,
    parameter: { brief, placeholder, parse: String },
  } as const;
}

export function stringArg(brief: string, placeholder: string) {
  return { brief, placeholder, parse: String } as const;
}

export const cliLocalization = {
  text: {
    ...text_en,
    formatException: errorMessage,
    exceptionWhileParsingArguments(exc: unknown) {
      return exc instanceof Error && exc.constructor.name.endsWith("Error")
        ? `pictl: ${formatMessageForArgumentScannerError(exc as never, {})}`
        : `pictl: ${errorMessage(exc)}`;
    },
    exceptionWhileRunningCommand(exc: unknown) {
      return `pictl: ${errorMessage(exc)}`;
    },
    commandErrorResult(err: Error) {
      return `pictl: ${err.message}`;
    },
    noCommandRegisteredForInput({ input }: { input: string }) {
      return `pictl: unknown command: ${input}`;
    },
  },
};

export async function runCliApp(
  app: Application<CommandContext>,
  argv: readonly string[],
  proc: NodeJS.Process = process,
): Promise<void> {
  proc.exitCode = undefined;
  await run(app, argv, { process: proc, env: proc.env, targets: [] } as never);
  if (typeof proc.exitCode === "number" && proc.exitCode < 0) {
    proc.exitCode = 2;
  }
}
