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
  type TypedFlagParameter,
  type TypedPositionalParameters,
} from "@stricli/core";
import type { Application } from "@stricli/core";
import type { AgentRecord } from "./registry.ts";
import { loadAgent } from "./registry.ts";
import { UsageError } from "./util.ts";

type RuntimeProcess = StricliProcess & { env?: NodeJS.ProcessEnv };

export interface CommandContext extends StricliCommandContext {
  process: StricliProcess;
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

// This symbol is never created at runtime. It is a "phantom" property used
// only by TypeScript so a Stricli flag parameter can remember the value type
// it will produce after parsing.
declare const flagValue: unique symbol;

export type CliFlag<T, PARAMETER> = PARAMETER & {
  readonly [flagValue]: T;
};

export type InferFlagValue<F> = F extends {
  readonly [flagValue]: infer T;
}
  ? T
  : never;

// Optional object properties are different from required properties whose value
// can be undefined. This helper finds the flags whose phantom value includes
// undefined so InferFlags can turn `string | undefined` into `name?: string`.
export type OptionalFlagKeys<F extends Record<string, unknown>> = {
  readonly [K in keyof F]: undefined extends InferFlagValue<F[K]> ? K : never;
}[keyof F];

export type RequiredFlagKeys<F extends Record<string, unknown>> = Exclude<
  keyof F,
  OptionalFlagKeys<F>
>;

// Derive the implementation-facing flags object from a flag-spec object:
// - booleanFlag(...) becomes `name: boolean`
// - variadicStringFlag(...) becomes `name: readonly string[]`
// - stringFlag(...) becomes `name?: string`
// The runtime flag specs remain ordinary Stricli parameters; the phantom type
// information only exists to make this mapped type possible.
export type InferFlags<F extends Record<string, unknown>> = {
  readonly [K in RequiredFlagKeys<F>]: InferFlagValue<F[K]>;
} & {
  readonly [K in OptionalFlagKeys<F>]?: Exclude<
    InferFlagValue<F[K]>,
    undefined
  >;
};

export function defineFlags<const F extends Record<string, unknown>>(
  flags: F,
): F {
  return flags;
}

// The helper bodies use casts because Stricli's TypedFlagParameter is a
// conditional type: TypeScript cannot prove that a generic object literal is
// the right branch for every T. Keeping the casts here centralizes that
// unsafety; command modules still receive checked, inferred flag types.
export function booleanFlag(
  brief: string,
): CliFlag<boolean, TypedFlagParameter<boolean, CommandContext>> {
  return {
    kind: "boolean",
    brief,
    default: false,
  } as unknown as CliFlag<boolean, TypedFlagParameter<boolean, CommandContext>>;
}

export function stringFlag(
  brief: string,
  placeholder?: string,
): CliFlag<
  string | undefined,
  TypedFlagParameter<string | undefined, CommandContext>
> {
  return {
    kind: "parsed",
    parse: String,
    brief,
    ...(placeholder === undefined ? {} : { placeholder }),
    optional: true,
  } as unknown as CliFlag<
    string | undefined,
    TypedFlagParameter<string | undefined, CommandContext>
  >;
}

export function variadicStringFlag(
  brief: string,
  placeholder?: string,
): CliFlag<
  readonly string[],
  TypedFlagParameter<readonly string[], CommandContext>
> {
  return {
    kind: "parsed",
    parse: String,
    brief,
    ...(placeholder === undefined ? {} : { placeholder }),
    variadic: true,
    default: [],
  } as unknown as CliFlag<
    readonly string[],
    TypedFlagParameter<readonly string[], CommandContext>
  >;
}

export function enumFlag<const VALUES extends readonly [string, ...string[]]>(
  brief: string,
  values: VALUES,
): CliFlag<
  VALUES[number] | undefined,
  TypedFlagParameter<VALUES[number] | undefined, CommandContext>
> {
  return {
    kind: "enum",
    values,
    brief,
    optional: true,
  } as unknown as CliFlag<
    VALUES[number] | undefined,
    TypedFlagParameter<VALUES[number] | undefined, CommandContext>
  >;
}

export function parsedFlag<T>(
  brief: string,
  parse: (input: string) => T,
  placeholder?: string,
): CliFlag<T | undefined, TypedFlagParameter<T | undefined, CommandContext>> {
  return {
    kind: "parsed",
    parse,
    brief,
    ...(placeholder === undefined ? {} : { placeholder }),
    optional: true,
  } as unknown as CliFlag<
    T | undefined,
    TypedFlagParameter<T | undefined, CommandContext>
  >;
}

export function requiredParsedFlag<T>(
  brief: string,
  parse: (input: string) => T,
  placeholder?: string,
): CliFlag<T, TypedFlagParameter<T, CommandContext>> {
  return {
    kind: "parsed",
    parse,
    brief,
    ...(placeholder === undefined ? {} : { placeholder }),
  } as unknown as CliFlag<T, TypedFlagParameter<T, CommandContext>>;
}

export function requiredStringFlag(
  brief: string,
  placeholder?: string,
): CliFlag<string, TypedFlagParameter<string, CommandContext>> {
  return requiredParsedFlag(brief, String, placeholder);
}

export function secondsFlag(brief = "Timeout in seconds") {
  return parsedFlag(brief, (input: string): number => {
    const seconds = Number(input);
    if (!(Number.isFinite(seconds) && seconds >= 0)) {
      throw new UsageError(`invalid seconds value: ${input}`);
    }
    return seconds;
  });
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
  proc: RuntimeProcess = process,
): Promise<void> {
  proc.exitCode = undefined;
  await run(app, argv, {
    process: proc,
    env: proc.env ?? process.env,
    targets: [],
  });
  if (typeof proc.exitCode === "number" && proc.exitCode < 0) {
    proc.exitCode = 2;
  }
}
