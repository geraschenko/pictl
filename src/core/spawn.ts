/**
 * `pictl spawn` — create an agent dir and daemonize pi for it.
 * Also home of launchDaemon, shared with `pictl resume`.
 */

import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { attach } from "./attach.ts";
import {
  booleanFlag,
  commandNoTarget,
  recordCommandAudit,
  restArgs,
  stringFlag,
  type InferFlags,
} from "./cli.ts";
import { resolveTargets, type CommandContext } from "./targets.ts";
import {
  agentDirPath,
  agentIdError,
  daemonLogPath,
  pictlBaseDir,
  socketPathLengthError,
  writeSpawnOptions,
} from "./registry.ts";
import { UsageError } from "./util.ts";

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * PICTL_PI_BIN wins; otherwise use the `pi` binary from the bundled
 * @geraschenko/pi-coding-agent dependency, so pictl runs the pinned pi version
 * rather than whatever `pi` happens to be on PATH. Resolved through Node's
 * module resolution (not a hardcoded node_modules/.bin path) so it follows
 * dependency hoisting. Returns an absolute path.
 */
function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PICTL_PI_BIN;
  if (fromEnv) {
    const absolute = resolve(fromEnv);
    if (!isExecutableFile(absolute)) {
      throw new Error(`PICTL_PI_BIN is not an executable file: ${absolute}`);
    }
    return absolute;
  }
  const packageRoot = resolve(
    dirname(fileURLToPath(import.meta.resolve("@geraschenko/pi-coding-agent"))),
    "..",
  );
  const { bin } = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { bin?: Record<string, string> };
  if (bin?.pi === undefined) {
    throw new Error("@geraschenko/pi-coding-agent does not declare a `pi` bin");
  }
  return join(packageRoot, bin.pi);
}

/**
 * The script Node was invoked with, re-execed for the detached daemon. Using
 * process.argv[1] (rather than a path derived from import.meta.url) keeps the
 * re-exec correct whether pictl runs from the built `dist/` (`main.js`) or from
 * `.ts` source under type-stripping (`main.ts`), where a hardcoded `./main.js`
 * would point at a nonexistent file.
 */
function mainEntryPath(): string {
  const entry = process.argv[1];
  if (entry === undefined) {
    throw new Error("cannot determine pictl entry script (process.argv[1])");
  }
  return entry;
}

async function readAll(stream: Readable): Promise<string> {
  let data = "";
  for await (const chunk of stream) {
    data += chunk.toString();
  }
  return data;
}

/**
 * Launch the per-agent daemon: detached, stdio to daemon.log, plus a pipe on
 * fd 3 that the daemon writes a one-line ready/error message to once pi's RPC
 * socket is up (or startup failed). Awaiting that pipe is what makes spawn exit
 * only after the agent is actually reachable — no fixed sleeps.
 *
 * Everything else the daemon needs it derives itself: the agent dir from the
 * id (PICTL_DIR is inherited), and the spawn-time configuration from
 * spawn-options.json (initial spawn) or agent.json (revival) — see the
 * startup classification in daemon/daemon.ts.
 */
export async function launchDaemon(agentId: string): Promise<void> {
  const agentDir = agentDirPath(agentId);
  const logFd = openSync(daemonLogPath(agentDir), "a");
  const daemonArgs = [
    mainEntryPath(),
    "_daemon",
    "--agent-id",
    agentId,
    "--ready-fd",
    "3", // readiness pipe fd
  ];
  const child = spawnChild(process.execPath, daemonArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd, "pipe"],
  });
  closeSync(logFd);
  child.unref();

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (error) =>
      reject(new Error(`failed to start daemon: ${error.message}`)),
    );
  });
  const readyData = await Promise.race([
    readAll(child.stdio[3] as Readable),
    spawnError,
  ]);

  let ready: { ok: boolean; error?: string } | undefined;
  try {
    ready =
      readyData.trim() === ""
        ? undefined
        : (JSON.parse(readyData) as { ok: boolean; error?: string });
  } catch {
    ready = undefined;
  }
  if (!ready?.ok) {
    // Daemon-reported errors already carry the log path.
    throw new Error(
      ready?.error !== undefined
        ? `daemon failed to start: ${ready.error}`
        : `daemon failed to start: exited before signaling ready (log: ${daemonLogPath(agentDir)})`,
    );
  }
}

const spawnFlags = {
  cwd: stringFlag("Working directory", "path"),
  id: stringFlag("Agent id", "uuid"),
  tag: stringFlag("Agent label", "str"),
  attach: booleanFlag("Attach this terminal to the agent after spawning"),
};

type SpawnFlags = InferFlags<typeof spawnFlags>;

export async function spawn(
  this: CommandContext,
  flags: SpawnFlags,
  ...piArgs: string[]
): Promise<void> {
  const agentId = flags.id ?? randomUUID();
  const idError = agentIdError(agentId);
  if (idError) throw new UsageError(idError);
  const cwd = resolve(flags.cwd ?? process.cwd());
  const piBin = resolvePiBin(this.env);
  const agentDir = agentDirPath(agentId);

  const pathError = socketPathLengthError(agentDir);
  if (pathError) throw new UsageError(pathError);

  await mkdir(pictlBaseDir(), { recursive: true });
  try {
    await mkdir(agentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`agent '${agentId}' already exists`);
    }
    throw error;
  }

  // spawn is audited but has no target: the agent dir only exists now, so
  // it records its own audit event instead of using the `audited` marker.
  await recordCommandAudit(this.env, this.argv, [agentDir]);

  await writeSpawnOptions(agentDir, {
    cwd,
    piBin,
    spawnArgs: piArgs,
    ...(flags.tag !== undefined && { tag: flags.tag }),
  });
  // On failure the dir is left in place so daemon.log can be inspected;
  // `pictl gc` removes dirs that never got an agent.json.
  await launchDaemon(agentId);

  if (flags.attach) {
    // attach reads its target from this.targets and takes over the terminal
    // (exiting via process.exit), so it never returns here.
    this.targets = await resolveTargets([agentId]);
    await attach.call(this);
    return;
  }
  this.process.stdout.write(`${agentId}\n`);
}

const spawnCommand = commandNoTarget<SpawnFlags, string[]>({
  common: true,
  docs: {
    brief: "start an agent, print its id",
    customUsage: [
      "[--cwd <dir>] [--id <id>] [--tag <label>] [-a] [-- <pi args...>]",
    ],
  },
  parameters: {
    flags: spawnFlags,
    aliases: { a: "attach" },
    positional: restArgs("Arguments forwarded to pi", "pi-args"),
  },
  func: spawn,
});

export const spawnRoute = {
  spawn: spawnCommand,
} as const;
