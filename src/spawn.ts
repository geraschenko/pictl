/**
 * `pictl spawn` — create an agent dir and daemonize a holder for it.
 * Also home of launchHolder, shared with `pictl resume`.
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
import { parseArgs } from "node:util";
import { agentDirPath, holderLogPath, pictlBaseDir } from "./registry.ts";
import { splitAtDoubleDash } from "./util.ts";

export interface HolderLaunch {
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
export function resolvePiBin(): string {
  const fromEnv = process.env.PICTL_PI_BIN;
  if (fromEnv) {
    const absolute = resolve(fromEnv);
    if (!isExecutableFile(absolute)) {
      throw new Error(`PICTL_PI_BIN is not an executable file: ${absolute}`);
    }
    return absolute;
  }
  for (const pathDir of (process.env.PATH ?? "").split(delimiter)) {
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
 * Daemonize a holder: detached, stdio to holder.log, plus a pipe on fd 3 that
 * the holder writes a one-line ready/error message to once pi's RPC socket is
 * up (or startup failed). Awaiting that pipe is what makes spawn exit only
 * after the agent is actually reachable — no fixed sleeps.
 */
export async function launchHolder(launch: HolderLaunch): Promise<void> {
  const logFd = openSync(holderLogPath(launch.agentDir), "a");
  const holdArgs = [
    mainEntryPath(),
    "_hold",
    "--agent-dir",
    launch.agentDir,
    "--agent-id",
    launch.agentId,
    "--cwd",
    launch.cwd,
    "--pi-bin",
    launch.piBin,
    "--ready-fd",
    "3",
    ...(launch.tag !== undefined ? ["--tag", launch.tag] : []),
    ...(launch.resume ? ["--resume"] : []),
    "--",
    ...launch.piArgs,
  ];
  const child = spawnChild(process.execPath, holdArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd, "pipe"],
  });
  closeSync(logFd);
  child.unref();

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (error) =>
      reject(new Error(`failed to start holder: ${error.message}`)),
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
    // Holder-reported errors already carry the log path.
    throw new Error(
      ready?.error !== undefined
        ? `holder failed to start: ${ready.error}`
        : `holder failed to start: exited before signaling ready (log: ${holderLogPath(launch.agentDir)})`,
    );
  }
}

export async function runSpawn(argv: string[]): Promise<void> {
  const { ownArgs, passthroughArgs: piArgs } = splitAtDoubleDash(argv);
  const { values } = parseArgs({
    args: ownArgs,
    options: {
      cwd: { type: "string" },
      id: { type: "string" },
      tag: { type: "string" },
    },
  });

  const agentId = values.id ?? randomUUID();
  const cwd = resolve(values.cwd ?? process.cwd());
  const piBin = resolvePiBin();
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

  // On failure the dir is left in place so holder.log can be inspected;
  // `pictl gc` removes dirs that never got an agent.json.
  await launchHolder({
    agentDir,
    agentId,
    cwd,
    piBin,
    piArgs,
    resume: false,
    tag: values.tag,
  });
  console.log(agentId);
}
