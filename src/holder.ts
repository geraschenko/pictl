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
	// TDC: what's dir? How is it different from cwd? It looks like it's the PI_CTL_DIR ... we need to use a clearer name. [Later edit:] oooh, I see this is actually the _agent's_ directory within PI_CTL_DIR, so maybe "agentDir"?
	dir: string;
	id: string;  // TDC: should this be agentId? Again, I want to have names I can immediately understand. Propose an update to my CLAUDE.md to make it clear that I want to be able to read code without having to jump around to figure out what the hell cryptic variable names mean.
	cwd: string;
	piBin: string;
	resume: boolean;
	readyFd: number | undefined;
	piArgs: string[];
}

function parseHoldArgs(argv: string[]): HoldArgs {
	const separatorIndex = argv.indexOf("--");
	const ownArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
	const piArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
	const { values } = parseArgs({
		args: ownArgs,
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
	// TDC: this is confusing. You're iterating through all the sessions, looking for the most recent one which is confirmed and exists. Then if you don't find one, you entertain non-confirmed sessions? Doesn't that seem wrong? If the most recent session is not confirmed but the session file exists, does it really matter what the older sessions are? Don't uncritically agree with me. Make an argument. But this behavior doesn't match expectations or the function description above.
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
	const { dir, id } = args;  // TDC: "agentDir, agentId"?

	// TDC: rather than creating them as mutable, can you do something like `const { createdAt, sessions } = if (existing.kind === "ok") { ... } else { ... }`?
	let createdAt = new Date().toISOString();
	let sessions: SessionHistoryEntry[] = [];
	const existing = await readAgentRecord(dir);
	if (existing.kind === "ok") {
		createdAt = existing.record.createdAt;
		sessions = existing.record.sessions;
	}

	// A SIGKILLed predecessor leaves stale socket files behind, and pi refuses
	// to bind an existing path. Launchers guarantee no live holder for this dir.
	// TDC: why await serially? Can we await the pair together?
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

	// TDC: what do we need allowProposedApi for?
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
	// TDC: just to check my understanding, there's currently no data flow from `terminal` to `ttyServer`, but ultimately we'll direct an ansi stream between the two. Is that correct?
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
	process.on("SIGINT", () => piProcess.kill("SIGTERM"));  // TDC: why not SIGINT?

	let currentSessionId: string | undefined;
	const handleEvent = (event: SocketEvent): void => {
		if (event.type === "session_changed") {
			const changed = event as unknown as SessionChangedEvent;  // TDC: explain this "as X as Y" syntax to me. Why not just "as Y"? Is this like casting to void*?
			currentSessionId = changed.sessionId;
			if (!changed.sessionFile) {
				// TDC: isn't this wrong? If the session changed from one ephemeral session to another (or somehow changed from a persistent session to an ephemeral one), we should still update the sessionId, no?
				return;
			}
			const last = record.sessions[record.sessions.length - 1];
			if (last && last.sessionId === changed.sessionId) {
				// TDC: I don't want to duplicate sessions at all. So if the new id matches *any* of the old ones, I want to remove the old entry and append the new one. Note that this makes the push unconditional ... the only thing that's conditional is the removal of duplicates from the list of sessions. However, I think if the new session id matches the most recent confirmed one, we should set confirmed to true immediately, or perhaps if the new session matches the latest one, we should adopt its value of confirmed? What do you think?
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
				entry.confirmed = true;  // TDC: this is wild to me. Didn't we declare `entry` to be const? How is mutating it like this okay? Educate me on typescript.
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
