/**
 * `pi-ctl list | status | gc` — read-only inspection of the registry.
 * None of these revive dormant agents: a dead holder is not garbage.
 */

import { access, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import {
	type AgentRecord,
	agentDir,
	isPidAlive,
	listAgentIds,
	piSocketPath,
	readAgentRecord,
	resolveAgentId,
	tombstonePath,
} from "./registry.js";
import { connectWithRetry, getState } from "./rpc.js";

const PROBE_CONNECT_DEADLINE_MS = 2_000;

export type AgentStatus = "idle" | "streaming" | "dormant" | "tombstoned" | "corrupt" | "unreachable";

export interface AgentProbe {
	id: string;  // TDC: agentId?
	status: AgentStatus;
	record?: AgentRecord;
	state?: RpcSessionState;
	error?: string;
}

// TDC: this function is duplicated in its entirety in holder.ts. Is there a common utility we can rely on or some way to share the code? Are there any other duplicated utilities? Duplication of code like this makes maintenance a nightmare, so I really want to avoid it.
async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function probeAgent(id: string): Promise<AgentProbe> {
	const dir = agentDir(id);
	if (await fileExists(tombstonePath(dir))) {
		return { id, status: "tombstoned" };
	}
	const read = await readAgentRecord(dir);
	if (read.kind !== "ok") {
		return { id, status: "corrupt", error: read.kind === "missing" ? "no agent.json" : read.error };
	}
	const record = read.record;
	if (!isPidAlive(record.holderPid)) {
		return { id, status: "dormant", record };
	}
	try {
		const client = await connectWithRetry(piSocketPath(dir), PROBE_CONNECT_DEADLINE_MS);
		try {
			const state = await getState(client);
			return { id, status: state.isStreaming ? "streaming" : "idle", record, state };
		} finally {
			client.close();
		}
	} catch (error) {
		return { id, status: "unreachable", record, error: String(error) };
	}
}

function formatTable(rows: string[][]): string {
	const widths: number[] = [];
	for (const row of rows) {
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, cell.length);
		});
	}
	return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd()).join("\n");
}

export async function runList(argv: string[]): Promise<void> {
	const { values } = parseArgs({ args: argv, options: { json: { type: "boolean", default: false } } });
	const ids = await listAgentIds();
	const probes = await Promise.all(ids.map(probeAgent));
	probes.sort((a, b) => (a.record?.createdAt ?? "").localeCompare(b.record?.createdAt ?? ""));

	if (values.json) {
		console.log(JSON.stringify(probes, null, 2));
		return;
	}
	if (probes.length === 0) {
		console.log("no agents");
		return;
	}
	const rows = [["ID", "STATUS", "CWD", "CREATED"]];
	for (const probe of probes) {
		rows.push([
			probe.id.slice(0, 8),
			probe.status,
			probe.record?.cwd ?? "-",
			probe.record?.createdAt ?? "-",
		]);
	}
	console.log(formatTable(rows));
}

export async function runStatus(argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { json: { type: "boolean", default: false } },
	});
	if (positionals.length !== 1) {
		// TDC: why not allow fetching the status of multiple agents in one request?
		throw new Error("expected exactly one agent id");
	}
	const id = await resolveAgentId(positionals[0]!);
	const probe = await probeAgent(id);

	if (values.json) {
		console.log(JSON.stringify(probe, null, 2));
		return;
	}
	console.log(`id:       ${probe.id}`);
	console.log(`status:   ${probe.status}${probe.error ? ` (${probe.error})` : ""}`);
	if (probe.record) {
		console.log(`cwd:      ${probe.record.cwd}`);
		console.log(`created:  ${probe.record.createdAt}`);
		console.log(`pi bin:   ${probe.record.piBin}`);
		console.log(`args:     ${probe.record.spawnArgs.join(" ") || "-"}`);
		console.log(`holder:   pid ${probe.record.holderPid}${isPidAlive(probe.record.holderPid) ? "" : " (dead)"}`);
		console.log(`pi:       pid ${probe.record.piPid}${isPidAlive(probe.record.piPid) ? "" : " (dead)"}`);
	}
	if (probe.state) {
		console.log(`model:    ${probe.state.model ? `${probe.state.model.provider}/${probe.state.model.id}` : "-"}`);
		console.log(`session:  ${probe.state.sessionFile ?? "(in-memory)"}`);
		console.log(`pending:  ${probe.state.pendingMessageCount} message(s)`);
	}
	if (probe.record && probe.record.sessions.length > 0) {
		console.log("sessions:");
		for (const entry of probe.record.sessions) {
			console.log(`  ${entry.confirmed ? "confirmed" : "pending  "}  ${entry.sessionFile}`);
		}
	}
}

export async function runGc(argv: string[]): Promise<void> {
	parseArgs({ args: argv, options: {} });
	const ids = await listAgentIds();
	let removed = 0;
	for (const id of ids) {
		const probe = await probeAgent(id);
		if (probe.status === "tombstoned" || probe.status === "corrupt") {
			await rm(agentDir(id), { recursive: true, force: true });
			console.log(`removed ${id} (${probe.status})`);
			removed += 1;
		}
	}
	console.log(removed === 0 ? "nothing to remove" : `removed ${removed} agent dir(s)`);
}
