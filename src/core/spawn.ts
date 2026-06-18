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
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  commandNoTarget,
  restArgs,
  stringFlag,
  type InferFlags,
} from "./cli.ts";
import { type CommandContext } from "./targets.ts";
import { agentDirPath, daemonLogPath, pictlBaseDir } from "./registry.ts";

interface DaemonLaunch {
  agentDir: string;
  agentId: string;
  cwd: string;
  piBin: string;
  piArgs: string[];
  resume: boolean;
  /** Set only on initial spawn; revival preserves the recorded tag. */
  tag?: string;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** PICTL_PI_BIN wins; otherwise search PATH for `pi`. Returns an absolute path. */
function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PICTL_PI_BIN;
  if (fromEnv) {
    const absolute = resolve(fromEnv);
    if (!isExecutableFile(absolute)) {
      throw new Error(`PICTL_PI_BIN is not an executable file: ${absolute}`);
    }
    return absolute;
  }
  for (const pathDir of (env.PATH ?? "").split(delimiter)) {
    if (pathDir === "") {
      continue;
    }
    const candidate = join(pathDir, "pi");
    if (isAbsolute(candidate) && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "no `pi` found on PATH (set PICTL_PI_BIN to point at the binary)",
  );
}

function mainEntryPath(): string {
  return fileURLToPath(new URL("./main.js", import.meta.url));
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
 */
export async function launchDaemon(launch: DaemonLaunch): Promise<void> {
  const logFd = openSync(daemonLogPath(launch.agentDir), "a");
  const daemonArgs = [
    mainEntryPath(),
    "_daemon",
    "--agent-dir",
    launch.agentDir,
    "--agent-id",
    launch.agentId,
    "--cwd",
    launch.cwd,
    "--pi-bin",
    launch.piBin,
    "--ready-fd",
    "3", // readiness pipe fd
    ...(launch.tag !== undefined ? ["--tag", launch.tag] : []),
    ...(launch.resume ? ["--resume"] : []),
    "--",
    ...launch.piArgs,
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
        : `daemon failed to start: exited before signaling ready (log: ${daemonLogPath(launch.agentDir)})`,
    );
  }
}

const spawnFlags = {
  cwd: stringFlag("Working directory", "path"),
  id: stringFlag("Agent id", "uuid"),
  tag: stringFlag("Agent label", "str"),
};

type SpawnFlags = InferFlags<typeof spawnFlags>;

export async function spawn(
  this: CommandContext,
  flags: SpawnFlags,
  ...piArgs: string[]
): Promise<void> {
  const agentId = flags.id ?? randomUUID();
  const cwd = resolve(flags.cwd ?? process.cwd());
  const piBin = resolvePiBin(this.env);
  const agentDir = agentDirPath(agentId);

  await mkdir(pictlBaseDir(), { recursive: true });
  try {
    await mkdir(agentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`agent '${agentId}' already exists`);
    }
    throw error;
  }

  // On failure the dir is left in place so daemon.log can be inspected;
  // `pictl gc` removes dirs that never got an agent.json.
  await launchDaemon({
    agentDir,
    agentId,
    cwd,
    piBin,
    piArgs,
    resume: false,
    tag: flags.tag,
  });
  this.process.stdout.write(`${agentId}\n`);
}

const spawnCommand = commandNoTarget<SpawnFlags, string[]>({
  common: true,
  docs: {
    brief: "start an agent, print its id",
    customUsage: [
      "[--cwd <dir>] [--id <id>] [--tag <label>] [-- <pi args...>]",
    ],
  },
  parameters: {
    flags: spawnFlags,
    positional: restArgs("Arguments forwarded to pi", "pi-args"),
  },
  func: spawn,
});

export const spawnRoute = {
  spawn: spawnCommand,
} as const;
