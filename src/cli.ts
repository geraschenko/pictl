import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  formatMessageForArgumentScannerError,
  numberParser,
  run,
  text_en,
  type CommandContext as StricliCommandContext,
  type StricliProcess,
} from "@stricli/core";
import type { AgentRecord } from "./registry.ts";
import { loadAgent } from "./registry.ts";
import { runAttach } from "./attach.ts";
import { runHold } from "./holder.ts";
import { runList, runStatus } from "./inspect.ts";
import {
  runArchive,
  runGc,
  runPurge,
  runResume,
  runSuspend,
} from "./lifecycle.ts";
import { rpcCliSpecs, runRpcCliCommand } from "./rpc-commands.ts";
import { runSpawn } from "./spawn.ts";
import { runTail } from "./tail.ts";
import { UsageError } from "./util.ts";
import { runWait, WAIT_UNTIL_USAGE, WaitTimeoutError } from "./wait.ts";
import { VERSION } from "./version.ts";

export type TargetMode = "none" | "single" | "multiple";

export interface CommandContext extends StricliCommandContext {
  process: StricliProcess;
  env: NodeJS.ProcessEnv;
  targets: AgentRecord[];
}

type Flags = Record<string, unknown>;
type CommandSpec = {
  targetMode: TargetMode;
  common?: true;
  docs: { brief: string; fullDescription?: string; customUsage?: string[] };
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
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

function argvFromFlags(
  flags: Flags,
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

function rpcArgvFromFlags(
  flags: Flags,
  positionals: readonly string[],
): string[] {
  const argv = [...positionals];
  for (const [key, value] of Object.entries(flags)) {
    if (key === "target") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        argv.push(`--${key}`, String(item));
      }
    } else if (value === true) {
      argv.push(`--${key}`);
    } else if (typeof value === "string") {
      argv.push(`--${key}`, value);
    }
  }
  return argv;
}

function withTargets(spec: CommandSpec): CommandSpec["func"] {
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

function command(spec: CommandSpec) {
  return buildCommand({
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
  });
}

const stringArg = (brief: string, placeholder: string) => ({
  brief,
  placeholder,
  parse: String,
});
const restArgs = (brief: string, placeholder: string, minimum = 0) => ({
  kind: "array",
  minimum,
  parameter: { brief, placeholder, parse: String },
});

const coreSpecs = {
  spawn: {
    targetMode: "none",
    common: true,
    docs: {
      brief: "start an agent, print its id",
      customUsage: [
        "[--cwd <dir>] [--id <id>] [--tag <label>] [-- <pi args...>]",
      ],
    },
    parameters: {
      flags: {
        cwd: {
          kind: "parsed",
          parse: String,
          brief: "Working directory",
          optional: true,
        },
        id: {
          kind: "parsed",
          parse: String,
          brief: "Agent id",
          optional: true,
        },
        tag: {
          kind: "parsed",
          parse: String,
          brief: "Agent label",
          optional: true,
        },
      },
      positional: restArgs("pi arguments", "pi-arg"),
    },
    func: async (_flags: Flags, ...piArgs: string[]) =>
      runSpawn([
        ...argvFromFlags(_flags, [], ["cwd", "id", "tag"]),
        "--",
        ...piArgs,
      ]),
  },
  list: {
    targetMode: "none",
    common: true,
    docs: { brief: "list agents and their status" },
    parameters: {
      flags: {
        json: { kind: "boolean", brief: "Print JSON", optional: true },
        all: {
          kind: "boolean",
          brief: "Include archived agents",
          optional: true,
        },
        cwd: {
          kind: "parsed",
          parse: String,
          brief: "Filter by cwd",
          optional: true,
        },
      },
    },
    func: async (flags: Flags) =>
      runList(argvFromFlags(flags, ["json", "all"], ["cwd"])),
  },
  attach: {
    targetMode: "single",
    common: true,
    docs: { brief: "attach this terminal to an agent" },
    func: async function () {
      await runAttach([this.targets[0]!.id]);
    },
  },
  status: {
    targetMode: "multiple",
    common: true,
    docs: { brief: "detailed status of agents" },
    parameters: {
      flags: { json: { kind: "boolean", brief: "Print JSON", optional: true } },
    },
    func: async function (flags: Flags) {
      await runStatus([
        ...this.targets.map((t) => t.id),
        ...argvFromFlags(flags, ["json"], []),
      ]);
    },
  },
  wait: {
    targetMode: "single",
    docs: { brief: "block until the agent meets a condition" },
    parameters: {
      flags: {
        until: {
          kind: "parsed",
          parse: String,
          brief: `Wait condition (${WAIT_UNTIL_USAGE})`,
          optional: true,
        },
        timeout: {
          kind: "parsed",
          parse: String,
          brief: "Timeout in seconds",
          optional: true,
        },
      },
    },
    func: async function (flags: Flags) {
      await runWait([
        this.targets[0]!.id,
        ...argvFromFlags(flags, [], ["until", "timeout"]),
      ]);
    },
  },
  tail: {
    targetMode: "single",
    common: true,
    docs: { brief: "session entries as JSONL, then a cursor record" },
    parameters: {
      flags: {
        follow: {
          kind: "boolean",
          brief: "Follow new entries",
          optional: true,
        },
        since: {
          kind: "parsed",
          parse: String,
          brief: "Start after entry id",
          optional: true,
        },
        until: {
          kind: "parsed",
          parse: String,
          brief: `Follow until ${WAIT_UNTIL_USAGE}`,
          optional: true,
        },
        events: { kind: "boolean", brief: "Stream raw events", optional: true },
      },
    },
    func: async function (flags: Flags) {
      await runTail([
        this.targets[0]!.id,
        ...argvFromFlags(flags, ["follow", "events"], ["since", "until"]),
      ]);
    },
  },
  gc: {
    targetMode: "none",
    docs: { brief: "remove tombstoned or corrupt agent dirs" },
    func: async () => runGc([]),
  },
} satisfies Record<string, CommandSpec>;

const lifecycleSpecs = {
  suspend: {
    targetMode: "multiple",
    docs: { brief: "wait until idle, then stop" },
    parameters: {
      flags: {
        timeout: {
          kind: "parsed",
          parse: String,
          brief: "Timeout in seconds",
          optional: true,
        },
      },
    },
    func: async function (flags: Flags) {
      await runSuspend([
        ...this.targets.map((t) => t.id),
        ...argvFromFlags(flags, [], ["timeout"]),
      ]);
    },
  },
  archive: {
    targetMode: "multiple",
    common: true,
    docs: { brief: "suspend, then hide from list" },
    parameters: {
      flags: {
        timeout: {
          kind: "parsed",
          parse: String,
          brief: "Timeout in seconds",
          optional: true,
        },
      },
    },
    func: async function (flags: Flags) {
      await runArchive([
        ...this.targets.map((t) => t.id),
        ...argvFromFlags(flags, [], ["timeout"]),
      ]);
    },
  },
  resume: {
    targetMode: "multiple",
    docs: { brief: "revive dormant agents" },
    func: async function () {
      await runResume(this.targets.map((t) => t.id));
    },
  },
  purge: {
    targetMode: "multiple",
    common: true,
    docs: { brief: "wait until idle, then delete permanently" },
    parameters: {
      flags: {
        timeout: {
          kind: "parsed",
          parse: String,
          brief: "Timeout in seconds",
          optional: true,
        },
        now: { kind: "boolean", brief: "Abort first", optional: true },
        force: { kind: "boolean", brief: "Kill and delete", optional: true },
      },
    },
    func: async function (flags: Flags) {
      await runPurge([
        ...this.targets.map((t) => t.id),
        ...argvFromFlags(flags, ["now", "force"], ["timeout"]),
      ]);
    },
  },
} satisfies Record<string, CommandSpec>;

function rpcFlags(
  options:
    | Record<string, { type: "string" | "boolean"; multiple?: boolean }>
    | undefined,
) {
  const flags: Record<string, unknown> = {
    raw: { kind: "boolean", brief: "Print raw RPC response", optional: true },
  };
  for (const [name, opt] of Object.entries(options ?? {})) {
    flags[name] =
      opt.type === "boolean"
        ? { kind: "boolean", brief: name, optional: true }
        : {
            kind: "parsed",
            parse: String,
            brief: name,
            optional: true,
            ...(opt.multiple ? { variadic: true } : {}),
          };
  }
  return flags;
}

const rpcSpecs = Object.fromEntries(
  Object.entries(rpcCliSpecs).map(([name, rpcSpec]) => [
    name,
    {
      targetMode: "single" as const,
      common: name === "prompt" ? (true as const) : undefined,
      docs: { brief: rpcSpec.summary },
      parameters: {
        flags: rpcFlags(rpcSpec.options),
        positional: {
          kind: "tuple",
          parameters: rpcSpec.positionals.map((p) =>
            stringArg(p, p.replace(/[<>]/g, "")),
          ),
        },
      },
      func: async function (
        this: CommandContext,
        flags: Flags,
        ...args: string[]
      ) {
        await runRpcCliCommand(name, rpcSpec, [
          this.targets[0]!.id,
          ...rpcArgvFromFlags(flags, args),
        ]);
      },
    } satisfies CommandSpec,
  ]),
);

const internalSpecs = {
  _hold: {
    targetMode: "none",
    docs: { brief: "internal holder daemon" },
    parameters: {
      flags: {
        "agent-dir": {
          kind: "parsed",
          parse: String,
          brief: "Agent dir",
          optional: true,
        },
        "agent-id": {
          kind: "parsed",
          parse: String,
          brief: "Agent id",
          optional: true,
        },
        cwd: {
          kind: "parsed",
          parse: String,
          brief: "Working directory",
          optional: true,
        },
        "pi-bin": {
          kind: "parsed",
          parse: String,
          brief: "pi binary",
          optional: true,
        },
        resume: { kind: "boolean", brief: "Resume", optional: true },
        tag: { kind: "parsed", parse: String, brief: "Tag", optional: true },
        "ready-fd": {
          kind: "parsed",
          parse: numberParser,
          brief: "Ready fd",
          optional: true,
        },
      },
      positional: restArgs("pi arguments", "pi-arg"),
    },
    func: async (flags: Flags, ...piArgs: string[]) =>
      runHold([
        ...argvFromFlags(
          flags,
          ["resume"],
          ["agent-dir", "agent-id", "cwd", "pi-bin", "tag", "ready-fd"],
        ),
        "--",
        ...piArgs,
      ]),
  },
} satisfies Record<string, CommandSpec>;

const specs: Record<string, CommandSpec> = {
  ...coreSpecs,
  ...lifecycleSpecs,
  ...rpcSpecs,
  ...internalSpecs,
};
const routes = Object.fromEntries(
  Object.entries(specs).map(([name, spec]) => [name, command(spec)]),
);
const hideRoute = Object.fromEntries(
  Object.entries(specs)
    .filter(([, spec]) => !spec.common)
    .map(([name]) => [name, true]),
);

export const app = buildApplication(
  buildRouteMap({
    routes: routes as never,
    docs: {
      brief: "Spawn, observe, control, and attach to pi agents",
      hideRoute,
    },
  }),
  {
    name: "pictl",
    versionInfo: { currentVersion: VERSION },
    scanner: {
      caseStyle: "allow-kebab-for-camel",
      allowArgumentEscapeSequence: true,
    },
    documentation: { onlyRequiredInUsageLine: true },
    determineExitCode: (error) =>
      error instanceof WaitTimeoutError
        ? 3
        : error instanceof UsageError
          ? 2
          : 1,
    localization: {
      text: {
        ...text_en,
        formatException: errorMessage,
        exceptionWhileParsingArguments(exc) {
          return exc instanceof Error && exc.constructor.name.endsWith("Error")
            ? `pictl: ${formatMessageForArgumentScannerError(exc as never, {})}`
            : `pictl: ${errorMessage(exc)}`;
        },
        exceptionWhileRunningCommand(exc) {
          return `pictl: ${errorMessage(exc)}`;
        },
        commandErrorResult(err) {
          return `pictl: ${err.message}`;
        },
        noCommandRegisteredForInput({ input }) {
          return `pictl: unknown command: ${input}`;
        },
      },
    },
  },
);

export async function runCli(
  argv: readonly string[],
  proc: NodeJS.Process = process,
): Promise<void> {
  proc.exitCode = undefined;
  await run(app, argv, { process: proc, env: proc.env, targets: [] } as never);
  if (typeof proc.exitCode === "number" && proc.exitCode < 0) {
    proc.exitCode = 2;
  }
}
