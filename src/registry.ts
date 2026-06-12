/**
 * The agent registry is a directory of agent dirs: $PI_CTL_DIR/<id>/ with
 * agent.json (written only by the holder), pi.sock, tty.sock, holder.log,
 * and optionally a tombstone file marking the dir for gc.
 */

import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionHistoryEntry {
	sessionFile: string;
	sessionId: string;
	/**
	 * pi defers writing a new session file until the first assistant message,
	 * so an announced sessionFile may not exist on disk yet. Entries start
	 * pending and are confirmed when the holder observes an assistant message
	 * in that session.
	 */
	confirmed: boolean;
}

export interface AgentRecord {
	id: string;
	createdAt: string;
	cwd: string;
	piBin: string;
	spawnArgs: string[];
	holderPid: number;
	piPid: number;
	sessions: SessionHistoryEntry[];
}

export function piCtlBaseDir(): string {
	return process.env.PI_CTL_DIR ?? join(homedir(), ".pi", "agents");
}

export function agentDir(id: string): string {
	return join(piCtlBaseDir(), id);
}

export function agentJsonPath(dir: string): string {
	return join(dir, "agent.json");
}

export function piSocketPath(dir: string): string {
	return join(dir, "pi.sock");
}

export function ttySocketPath(dir: string): string {
	return join(dir, "tty.sock");
}

export function tombstonePath(dir: string): string {
	return join(dir, "tombstone");
}

export function holderLogPath(dir: string): string {
	return join(dir, "holder.log");
}

export type AgentRecordReadResult =
	| { kind: "ok"; record: AgentRecord }
	| { kind: "missing" }
	| { kind: "corrupt"; error: string };

export async function readAgentRecord(dir: string): Promise<AgentRecordReadResult> {
	let raw: string;
	try {
		raw = await readFile(agentJsonPath(dir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing" };
		}
		return { kind: "corrupt", error: String(error) };
	}
	try {
		const record = JSON.parse(raw) as AgentRecord;
		if (typeof record.id !== "string" || !Array.isArray(record.sessions)) {
			return { kind: "corrupt", error: "agent.json missing required fields" };
		}
		return { kind: "ok", record };
	} catch (error) {
		return { kind: "corrupt", error: `agent.json is not valid JSON: ${String(error)}` };
	}
}

export async function writeAgentRecord(dir: string, record: AgentRecord): Promise<void> {
	const target = agentJsonPath(dir);
	const tmp = `${target}.tmp`;
	await writeFile(tmp, `${JSON.stringify(record, null, "\t")}\n`);
	await rename(tmp, target);
}

export async function listAgentIds(): Promise<string[]> {
	try {
		const entries = await readdir(piCtlBaseDir(), { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

/** Resolve a (possibly partial) agent id. Ambiguity is an error, never a guess. */
export async function resolveAgentId(prefix: string): Promise<string> {
	const ids = await listAgentIds();
	if (ids.includes(prefix)) {
		return prefix;
	}
	const matches = ids.filter((id) => id.startsWith(prefix));
	if (matches.length === 1) {
		return matches[0]!;
	}
	if (matches.length === 0) {
		throw new Error(`no agent matches '${prefix}'`);
	}
	throw new Error(`ambiguous agent id '${prefix}', candidates:\n  ${matches.join("\n  ")}`);
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
