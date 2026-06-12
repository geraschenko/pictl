/**
 * `pi-ctl spawn` — create an agent dir and daemonize a holder for it.
 * Also home of launchHolder, shared with `pi-ctl resume`.
 */

import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants as fsConstants, openSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agentDir, holderLogPath, piCtlBaseDir } from "./registry.js";

export interface HolderLaunch {
	dir: string;
	id: string;
	cwd: string;
	piBin: string;
	piArgs: string[];
	resume: boolean;
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, fsConstants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** PI_CTL_PI_BIN wins; otherwise search PATH for `pi`. Returns an absolute path. */
export function resolvePiBin(): string {
	const fromEnv = process.env.PI_CTL_PI_BIN;
	if (fromEnv) {
		const absolute = resolve(fromEnv);
		if (!isExecutableFile(absolute)) {
			throw new Error(`PI_CTL_PI_BIN is not an executable file: ${absolute}`);
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
	throw new Error("no `pi` found on PATH (set PI_CTL_PI_BIN to point at the binary)");
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
	const logFd = openSync(holderLogPath(launch.dir), "a");
	const holdArgs = [
		mainEntryPath(),
		"_hold",
		"--dir",
		launch.dir,
		"--id",
		launch.id,
		"--cwd",
		launch.cwd,
		"--pi-bin",
		launch.piBin,
		"--ready-fd",
		"3",
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
		child.once("error", (error) => reject(new Error(`failed to start holder: ${error.message}`)));
	});
	const readyData = await Promise.race([readAll(child.stdio[3] as Readable), spawnError]);

	let ready: { ok: boolean; error?: string } | undefined;
	try {
		ready = readyData.trim() === "" ? undefined : (JSON.parse(readyData) as { ok: boolean; error?: string });
	} catch {
		ready = undefined;
	}
	if (!ready?.ok) {
		throw new Error(
			`holder failed to start: ${ready?.error ?? "exited before signaling ready"} (log: ${holderLogPath(launch.dir)})`,
		);
	}
}

export async function runSpawn(argv: string[]): Promise<void> {
	const separatorIndex = argv.indexOf("--");
	const own = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
	const piArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
	const { values } = parseArgs({
		args: own,
		options: {
			cwd: { type: "string" },
			id: { type: "string" },
		},
	});

	const id = values.id ?? randomUUID();
	const cwd = resolve(values.cwd ?? process.cwd());
	const piBin = resolvePiBin();
	const dir = agentDir(id);

	await mkdir(piCtlBaseDir(), { recursive: true });
	try {
		await mkdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`agent '${id}' already exists`);
		}
		throw error;
	}

	// On failure the dir is left in place so holder.log can be inspected;
	// `pi-ctl gc` removes dirs that never got an agent.json.
	await launchHolder({ dir, id, cwd, piBin, piArgs, resume: false });
	console.log(id);
}
