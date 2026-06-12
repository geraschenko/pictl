/**
 * `pi-ctl _hold` — the holder daemon. One per agent. It owns the PTY that pi
 * runs in, maintains detached screen state via @xterm/headless, and is the
 * sole writer of agent.json. It connects to its own pi.sock as a client to
 * track session replacements (never polling get_state per event).
 */

import { closeSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
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
import { fileExists, splitAtDoubleDash } from "./util.js";

const PTY_COLS = 80;
const PTY_ROWS = 24;
const RPC_CONNECT_DEADLINE_MS = 30_000;

interface HoldArgs {
	agentDir: string;
	agentId: string;
	cwd: string;
	piBin: string;
	resume: boolean;
	readyFd: number | undefined;
	piArgs: string[];
}

function parseHoldArgs(argv: string[]): HoldArgs {
	const { ownArgs, passthroughArgs } = splitAtDoubleDash(argv);
	const { values } = parseArgs({
		args: ownArgs,
		options: {
			"agent-dir": { type: "string" },
			"agent-id": { type: "string" },
			cwd: { type: "string" },
			"pi-bin": { type: "string" },
			resume: { type: "boolean", default: false },
			"ready-fd": { type: "string" },
		},
	});
	if (!values["agent-dir"] || !values["agent-id"] || !values.cwd || !values["pi-bin"]) {
		throw new Error("_hold requires --agent-dir, --agent-id, --cwd, --pi-bin");
	}
	return {
		agentDir: values["agent-dir"],
		agentId: values["agent-id"],
		cwd: values.cwd,
		piBin: values["pi-bin"],
		resume: values.resume ?? false,
		readyFd: values["ready-fd"] === undefined ? undefined : Number(values["ready-fd"]),
		piArgs: passthroughArgs,
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

/**
 * Pick the session to revive: the most recent entry whose file exists on
 * disk. Existence is the only criterion — the confirmed flag predicts whether
 * the file was ever flushed, but at revival time the disk is ground truth,
 * and an unconfirmed-but-existing newer session is still the session the
 * agent was most recently on.
 */
async function revivalSessionArgs(sessions: SessionHistoryEntry[]): Promise<string[]> {
	for (const entry of [...sessions].reverse()) {
		if (await fileExists(entry.sessionFile)) {
			return ["--session", entry.sessionFile];
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

function isSessionChangedEvent(event: SocketEvent): event is SocketEvent & SessionChangedEvent {
	return event.type === "session_changed";
}

export async function runHold(argv: string[]): Promise<void> {
	const args = parseHoldArgs(argv);
	const { agentDir, agentId } = args;

	const existing = await readAgentRecord(agentDir);
	const createdAt = existing.kind === "ok" ? existing.record.createdAt : new Date().toISOString();
	const sessions = existing.kind === "ok" ? existing.record.sessions : [];

	// A SIGKILLed predecessor leaves stale socket files behind, and pi refuses
	// to bind an existing path. Launchers guarantee no live holder for this dir.
	await Promise.all([rm(piSocketPath(agentDir), { force: true }), rm(ttySocketPath(agentDir), { force: true })]);

	const sessionArgs = args.resume ? await revivalSessionArgs(sessions) : [];
	const piProcess = pty.spawn(args.piBin, ["--rpc-socket", piSocketPath(agentDir), ...sessionArgs, ...args.piArgs], {
		name: "xterm-256color",
		cols: PTY_COLS,
		rows: PTY_ROWS,
		cwd: args.cwd,
		env: ptyEnv(agentId),
	});

	const terminal = new xterm.Terminal({ cols: PTY_COLS, rows: PTY_ROWS });
	piProcess.onData((data) => terminal.write(data));

	const record: AgentRecord = {
		id: agentId,
		createdAt,
		cwd: args.cwd,
		piBin: args.piBin,
		spawnArgs: args.piArgs,
		holderPid: process.pid,
		piPid: piProcess.pid,
		sessions,
	};
	await writeAgentRecord(agentDir, record);

	// agent.json writes are serialized through this chain; session events can
	// arrive faster than a write completes.
	let writeQueue: Promise<void> = Promise.resolve();
	const queueRecordWrite = (): void => {
		writeQueue = writeQueue.then(
			() => writeAgentRecord(agentDir, record),
			() => writeAgentRecord(agentDir, record),
		);
	};

	// Stub until phase 2. Attach will work like this: on connect, a snapshot of
	// `terminal`'s screen state is serialized to the client, after which raw
	// PTY output bytes are relayed (from piProcess.onData, not from `terminal`)
	// and client input bytes go to piProcess.write.
	const ttyServer: Server = createServer((socket) => {
		socket.end();
	});
	await new Promise<void>((resolve, reject) => {
		ttyServer.once("error", reject);
		ttyServer.listen(ttySocketPath(agentDir), resolve);
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
				await Promise.all([
					rm(piSocketPath(agentDir), { force: true }),
					rm(ttySocketPath(agentDir), { force: true }),
				]);
				process.exit(code);
			});
	};

	piProcess.onExit(({ exitCode }) => {
		console.log(`[holder] pi exited with code ${exitCode}`);
		cleanupAndExit(exitCode);
	});
	// Any termination request to the holder means "shut the agent down":
	// forward as SIGTERM so pi exits cleanly. Forwarding SIGINT verbatim would
	// be wrong — interactive pi treats it as "abort the current turn" and
	// keeps running, leaving a holder that was asked to die still alive.
	process.on("SIGTERM", () => piProcess.kill("SIGTERM"));
	process.on("SIGINT", () => piProcess.kill("SIGTERM"));

	let currentSessionId: string | undefined;
	const handleEvent = (event: SocketEvent): void => {
		if (isSessionChangedEvent(event)) {
			// Track the active session id even for in-memory sessions; only the
			// durable history below is limited to sessions with a file.
			currentSessionId = event.sessionId;
			if (event.sessionFile === undefined) {
				return;
			}
			// The history is duplicate-free: re-announcing a known session moves
			// it to the end (most recent) and keeps its confirmed status — being
			// re-announced does not change whether an assistant message was ever
			// observed in it.
			const previousIndex = record.sessions.findIndex((s) => s.sessionId === event.sessionId);
			const confirmed = previousIndex === -1 ? false : record.sessions[previousIndex]!.confirmed;
			if (previousIndex !== -1) {
				record.sessions.splice(previousIndex, 1);
			}
			record.sessions.push({ sessionFile: event.sessionFile, sessionId: event.sessionId, confirmed });
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
		await connectWithRetry(piSocketPath(agentDir), RPC_CONNECT_DEADLINE_MS, handleEvent);
		signalReady(args.readyFd, { ok: true });
	} catch (error) {
		const message = `could not connect to pi socket: ${String(error)} (log: ${holderLogPath(agentDir)})`;
		console.error(`[holder] ${message}`);
		signalReady(args.readyFd, { ok: false, error: message });
		piProcess.kill("SIGKILL");
		cleanupAndExit(1);
	}
}
