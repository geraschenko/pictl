import {
  ArgumentScannerError,
  buildCommand,
  formatMessageForArgumentScannerError,
  run,
  text_en,
  type Aliases,
  type Command,
  type CommandContext as StricliCommandContext,
  type CommandFunction,
  type FlagParametersForType,
  type StricliProcess,
  type TypedCommandParameters,
  type TypedPositionalParameters,
} from "@stricli/core";
import type { Application } from "@stricli/core";
import type { AgentRecord } from "./registry.ts";
import { loadAgent } from "./registry.ts";
import { UsageError } from "./util.ts";

// TDC: Don't define our out stdout/stdin/process types. cast as the node types in functions that need it, with comments explaining why.
export interface PictlStdout {
  write(str: string | Uint8Array): void;
  rows: number;
  columns: number;
  isTTY: boolean;
  on(event: "resize", listener: () => void): this;
}

export interface PictlStdin extends AsyncIterable<Buffer | string> {
  isTTY: boolean;
  setRawMode(mode: boolean): this;
  resume(): this;
  pause(): this;
  on(event: "data", listener: (chunk: Buffer) => void): this;
}

export interface PictlProcess extends StricliProcess {
  stdout: PictlStdout;
  stdin: PictlStdin;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  pid: number;
  execPath: string;
  exit(code?: number): never;
  kill(pid: number, signal?: NodeJS.Signals | number): true;
  on(event: "SIGTERM" | "SIGINT", listener: () => void): this;
}

export interface CommandContext extends StricliCommandContext {
  process: PictlProcess;
  env: NodeJS.ProcessEnv;
  /** Empty for targetMode none; length 1 for single; length >= 1 for multiple. */
  targets: AgentRecord[];
}

type CommandRoute = Command<CommandContext> & { common?: true };

type CommandFlagsConstraint<T> = Readonly<Partial<Record<keyof T, unknown>>>;

type Parameters<
  FLAGS extends CommandFlagsConstraint<FLAGS>,
  ARGS extends readonly unknown[],
> = {
  flags?: FlagParametersForType<FLAGS, CommandContext>;
  aliases?: Aliases<keyof FLAGS & string>;
  positional?: TypedPositionalParameters<ARGS, CommandContext>;
};

interface CommandSpec<
  FLAGS extends CommandFlagsConstraint<FLAGS>,
  ARGS extends readonly unknown[],
> {
  /** Marker field: commands are hidden from default help unless marked common. */
  common?: true;
  docs: {
    brief: string;
    fullDescription?: string;
    customUsage?: readonly string[];
  };
  parameters?: Parameters<FLAGS, ARGS>;
  func: CommandFunction<FLAGS, ARGS, CommandContext>;
}

const targetFlag = {
  kind: "parsed",
  parse: String,
  brief: "Target agent id or unique prefix",
  placeholder: "agent",
  optional: true,
} as const;

const singleTargetFlags = {
  target: targetFlag,
} satisfies FlagParametersForType<{ target?: string }, CommandContext>;

const multiTargetFlags = {
  target: { ...targetFlag, variadic: true },
} satisfies FlagParametersForType<
  { target?: readonly string[] },
  CommandContext
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function determineTargets(
  targetMode: "none" | "single" | "multiple",
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

export function oneTarget(context: CommandContext): AgentRecord {
  const target = context.targets[0];
  if (target === undefined || context.targets.length !== 1) {
    throw new Error(`internal error: expected exactly one target`);
  }
  return target;
}

export function multiTargets(context: CommandContext): readonly AgentRecord[] {
  if (context.targets.length === 0) {
    throw new Error(`internal error: expected at least one target`);
  }
  return context.targets;
}

export function trueFlag(brief: string) {
  return {
    kind: "parsed",
    parse(input: string): true {
      if (input === "" || input === "true") {
        return true;
      }
      throw new UsageError("flag does not accept a value");
    },
    inferEmpty: true,
    brief,
    optional: true,
  } as const;
}

export function secondsFlag(brief = "Timeout in seconds") {
  return {
    kind: "parsed",
    parse(input: string): number {
      const seconds = Number(input);
      if (!(Number.isFinite(seconds) && seconds >= 0)) {
        throw new UsageError(`invalid seconds value: ${input}`);
      }
      return seconds;
    },
    brief,
    optional: true,
  } as const;
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

function markCommon(
  command: Command<CommandContext>,
  common: true | undefined,
): CommandRoute {
  return Object.assign(command, { common });
}

export function commandNoTarget<
  FLAGS extends CommandFlagsConstraint<FLAGS> = Record<never, never>,
  ARGS extends readonly unknown[] = [],
>(spec: CommandSpec<FLAGS, ARGS>): CommandRoute {
  return markCommon(
    buildCommand<FLAGS, ARGS, CommandContext>({
      func: async function (this: CommandContext, flags: FLAGS, ...args: ARGS) {
        this.targets = [];
        await spec.func.call(this, flags, ...args);
      },
      parameters: (spec.parameters ?? {}) as TypedCommandParameters<
        FLAGS,
        ARGS,
        CommandContext
      >,
      docs: spec.docs,
    }),
    spec.common,
  );
}

export function commandOneTarget<
  FLAGS extends CommandFlagsConstraint<FLAGS> = Record<never, never>,
  ARGS extends readonly unknown[] = [],
>(spec: CommandSpec<FLAGS, ARGS>): CommandRoute {
  type AugmentedFlags = FLAGS & { target?: string };
  return markCommon(
    buildCommand<AugmentedFlags, ARGS, CommandContext>({
      func: async function (
        this: CommandContext,
        flags: AugmentedFlags,
        ...args: ARGS
      ) {
        const { target, ...commandFlags } = flags;
        this.targets = await resolveTargets(
          determineTargets(
            "single",
            target === undefined ? [] : [target],
            this.env,
          ),
        );
        await spec.func.call(this, commandFlags as FLAGS, ...args);
      },
      parameters: {
        flags: { ...singleTargetFlags, ...(spec.parameters?.flags ?? {}) },
        aliases: { t: "target", ...(spec.parameters?.aliases ?? {}) },
        ...(spec.parameters?.positional === undefined
          ? {}
          : { positional: spec.parameters.positional }),
      } as unknown as TypedCommandParameters<
        AugmentedFlags,
        ARGS,
        CommandContext
      >,
      docs: spec.docs,
    }),
    spec.common,
  );
}

export function commandMultiTarget<
  FLAGS extends CommandFlagsConstraint<FLAGS> = Record<never, never>,
  ARGS extends readonly unknown[] = [],
>(spec: CommandSpec<FLAGS, ARGS>): CommandRoute {
  type AugmentedFlags = FLAGS & { target?: readonly string[] };
  return markCommon(
    buildCommand<AugmentedFlags, ARGS, CommandContext>({
      func: async function (
        this: CommandContext,
        flags: AugmentedFlags,
        ...args: ARGS
      ) {
        const { target, ...commandFlags } = flags;
        this.targets = await resolveTargets(
          determineTargets("multiple", target ?? [], this.env),
        );
        await spec.func.call(this, commandFlags as FLAGS, ...args);
      },
      parameters: {
        flags: { ...multiTargetFlags, ...(spec.parameters?.flags ?? {}) },
        aliases: { t: "target", ...(spec.parameters?.aliases ?? {}) },
        ...(spec.parameters?.positional === undefined
          ? {}
          : { positional: spec.parameters.positional }),
      } as unknown as TypedCommandParameters<
        AugmentedFlags,
        ARGS,
        CommandContext
      >,
      docs: spec.docs,
    }),
    spec.common,
  );
}

export const cliLocalization = {
  text: {
    ...text_en,
    formatException: errorMessage,
    exceptionWhileParsingArguments(exc: unknown) {
      return exc instanceof ArgumentScannerError
        ? `pictl: ${formatMessageForArgumentScannerError(exc, {})}`
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
  proc: PictlProcess = process,
): Promise<void> {
  proc.exitCode = undefined;
  await run(app, argv, { process: proc, env: proc.env, targets: [] });
  if (typeof proc.exitCode === "number" && proc.exitCode < 0) {
    proc.exitCode = 2;
  }
}
