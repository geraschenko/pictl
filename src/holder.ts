/**
 * `pi-ctl _hold` — the holder daemon. One per agent. It owns the PTY that pi
 * runs in, maintains detached screen state via @xterm/headless, and is the
 * sole writer of agent.json. It connects to its own pi.sock as a client to
 * track session replacements (never polling get_state per event).
 */

import { closeSync, writeSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { parseArgs } from "node:util";
import xterm from "@xterm/headless";
import pty from "node-pty";
import {
	type AgentRecord,
	holderLogPath,
	piSocketPath,
	readAgentRecord,
	type SessionHistoryEntry,
	ttySocketPath,
	writeAgentRecord,
} from "./registry.js";
import { connectWithRetry, type SessionChangedEvent, type SocketEvent } from "./rpc.js";

const PTY_COLS = 80;
const PTY_ROWS = 24;
const RPC_CONNECT_DEADLINE_MS = 30_000;

interface HoldArgs {
	dir: string;
	id: string;
	cwd: string;
	piBin: string;
	resume: boolean;
	readyFd: number | undefined;
	piArgs: string[];
}

function parseHoldArgs(argv: string[]): HoldArgs {
	const separatorIndex = argv.indexOf("--");
	const own = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
	const piArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
	const { values } = parseArgs({
		args: own,
		options: {
			dir: { type: "string" },
			id: { type: "string" },
			cwd: { type: "string" },
			"pi-bin": { type: "string" },
			resume: { type: "boolean", default: false },
			"ready-fd": { type: "string" },
		},
	});
	if (!values.dir || !values.id || !values.cwd || !values["pi-bin"]) {
		throw new Error("_hold requires --dir, --id, --cwd, --pi-bin");
	}
	return {
		dir: values.dir,
		id: values.id,
		cwd: values.cwd,
		piBin: values["pi-bin"],
		resume: values.resume ?? false,
		readyFd: values["ready-fd"] === undefined ? undefined : Number(values["ready-fd"]),
		piArgs,
	};
}

function signalReady(readyFd: number | undefined, message: { ok: boolean; error?: string }): void {
	if (readyFd === undefined) {
		return;
	}
	try {
		writeSync(readyFd, `${JSON.stringify(message)}\n`);
		closeSync(readyFd);
	} catch {
		// Spawner already gone; the holder runs on regardless.
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Pick the session to revive: the most recent confirmed entry whose file
 * exists; failing that (ENOENT backstop), the most recent entry of any kind
 * whose file exists — a pending entry with a file on disk just means this
 * holder never witnessed an assistant message; the file is ground truth.
 */
async function revivalSessionArgs(sessions: SessionHistoryEntry[]): Promise<string[]> {
	const newestFirst = [...sessions].reverse();
	for (const wantConfirmed of [true, false]) {
		for (const entry of newestFirst) {
			if (wantConfirmed && !entry.confirmed) {
				continue;
			}
			if (await fileExists(entry.sessionFile)) {
				return ["--session", entry.sessionFile];
			}
		}
	}
	return [];
}

function ptyEnv(agentId: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	env.PI_AGENT_ID = agentId;
	return env;
}

export async function runHold(argv: string[]): Promise<void> {
	const args = parseHoldArgs(argv);
	const { dir, id } = args;

	let createdAt = new Date().toISOString();
	let sessions: SessionHistoryEntry[] = [];
	const existing = await readAgentRecord(dir);
	if (existing.kind === "ok") {
		createdAt = existing.record.createdAt;
		sessions = existing.record.sessions;
	}

	// A SIGKILLed predecessor leaves stale socket files behind, and pi refuses
	// to bind an existing path. Launchers guarantee no live holder for this dir.
	await rm(piSocketPath(dir), { force: true });
	await rm(ttySocketPath(dir), { force: true });

	const sessionArgs = args.resume ? await revivalSessionArgs(sessions) : [];
	const piProcess = pty.spawn(args.piBin, ["--rpc-socket", piSocketPath(dir), ...sessionArgs, ...args.piArgs], {
		name: "xterm-256color",
		cols: PTY_COLS,
		rows: PTY_ROWS,
		cwd: args.cwd,
		env: ptyEnv(id),
	});

	const terminal = new xterm.Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });
	piProcess.onData((data) => terminal.write(data));

	const record: AgentRecord = {
		id,
		createdAt,
		cwd: args.cwd,
		piBin: args.piBin,
		spawnArgs: args.piArgs,
		holderPid: process.pid,
		piPid: piProcess.pid,
		sessions,
	};
	await writeAgentRecord(dir, record);

	// agent.json writes are serialized through this chain; session events can
	// arrive faster than a write completes.
	let writeQueue: Promise<void> = Promise.resolve();
	const queueRecordWrite = (): void => {
		writeQueue = writeQueue.then(
			() => writeAgentRecord(dir, record),
			() => writeAgentRecord(dir, record),
		);
	};

	// Stub until phase 2; bound now so the directory shape is final.
	const ttyServer: Server = createServer((socket) => {
		socket.end();
	});
	await new Promise<void>((resolve, reject) => {
		ttyServer.once("error", reject);
		ttyServer.listen(ttySocketPath(dir), resolve);
	});

	let exiting = false;
	const cleanupAndExit = (code: number): void => {
		if (exiting) {
			return;
		}
		exiting = true;
		void writeQueue
			.catch(() => undefined)
			.then(async () => {
				ttyServer.close();
				await rm(piSocketPath(dir), { force: true });
				await rm(ttySocketPath(dir), { force: true });
				process.exit(code);
			});
	};

	piProcess.onExit(({ exitCode }) => {
		console.log(`[holder] pi exited with code ${exitCode}`);
		cleanupAndExit(exitCode);
	});
	process.on("SIGTERM", () => piProcess.kill("SIGTERM"));
	process.on("SIGINT", () => piProcess.kill("SIGTERM"));

	let currentSessionId: string | undefined;
	const handleEvent = (event: SocketEvent): void => {
		if (event.type === "session_changed") {
			const changed = event as unknown as SessionChangedEvent;
			currentSessionId = changed.sessionId;
			if (!changed.sessionFile) {
				return;
			}
			const last = record.sessions[record.sessions.length - 1];
			if (last && last.sessionId === changed.sessionId) {
				return;
			}
			record.sessions.push({ sessionFile: changed.sessionFile, sessionId: changed.sessionId, confirmed: false });
			queueRecordWrite();
			return;
		}
		if (event.type === "message_end") {
			const message = event.message as { role?: string } | undefined;
			if (message?.role !== "assistant") {
				return;
			}
			const entry = record.sessions.find((s) => s.sessionId === currentSessionId && !s.confirmed);
			if (entry) {
				entry.confirmed = true;
				queueRecordWrite();
			}
		}
	};

	try {
		await connectWithRetry(piSocketPath(dir), RPC_CONNECT_DEADLINE_MS, handleEvent);
		signalReady(args.readyFd, { ok: true });
	} catch (error) {
		const message = `could not connect to pi socket: ${String(error)} (log: ${holderLogPath(dir)})`;
		console.error(`[holder] ${message}`);
		signalReady(args.readyFd, { ok: false, error: message });
		piProcess.kill("SIGKILL");
		cleanupAndExit(1);
	}
}
