/**
 * `pi-ctl kill | suspend | resume` — stopping and reviving agents.
 *
 * kill and suspend share the polite path: wait for full quiescence (not
 * streaming AND pending message queue empty), SIGTERM pi, SIGKILL escalation
 * if it lingers. kill additionally tombstones and removes the directory;
 * suspend leaves it, making the agent dormant.
 */

import { rm, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	type AgentRecord,
	agentDir,
	isPidAlive,
	piSocketPath,
	readAgentRecord,
	resolveAgentId,
	tombstonePath,
} from "./registry.js";
import { connectWithRetry, getState, type PiSocketClient } from "./rpc.js";
import { launchHolder } from "./spawn.js";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;
const SIGKILL_ESCALATION_MS = 5_000;
const PROCESS_EXIT_DEADLINE_MS = 10_000;

interface LoadedAgent {
	id: string;
	dir: string;
	record: AgentRecord;
}

async function loadAgent(prefix: string): Promise<LoadedAgent> {
	const id = await resolveAgentId(prefix);
	const dir = agentDir(id);
	const read = await readAgentRecord(dir);
	if (read.kind !== "ok") {
		throw new Error(
			read.kind === "missing"
				? `agent '${id}' has no agent.json (failed spawn?); run \`pi-ctl gc\``
				: `agent '${id}' has a corrupt agent.json: ${read.error}; run \`pi-ctl gc\``,
		);
	}
	return { id, dir, record: read.record };
}

export class QuiescenceTimeoutError extends Error {}

/**
 * Wait until the agent is fully quiescent. State is re-checked only on
 * agent_end (once per turn), never per event. The waiter is registered before
 * each get_state so an agent_end landing between the two is not missed.
 */
export async function waitQuiescent(client: PiSocketClient, timeoutMs: number | undefined): Promise<void> {
	const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
	for (;;) {
		const nextAgentEnd = new Promise<"agent_end" | "closed">((resolve) => {
			client.onEvent((event) => {
				if (event.type === "agent_end") {
					resolve("agent_end");
				}
			});
			void client.waitClosed().then(() => resolve("closed"));
		});

		const state = await getState(client);
		if (!state.isStreaming && state.pendingMessageCount === 0) {
			return;
		}

		if (deadline === undefined) {
			if ((await nextAgentEnd) === "closed") {
				throw new Error("pi socket closed while waiting for quiescence");
			}
		} else {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new QuiescenceTimeoutError();
			}
			const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining));
			const winner = await Promise.race([nextAgentEnd, timeout]);
			if (winner === "timeout") {
				throw new QuiescenceTimeoutError();
			}
			if (winner === "closed") {
				throw new Error("pi socket closed while waiting for quiescence");
			}
		}
	}
}

/**
 * SIGTERM pi and wait for it to exit, observed as the RPC socket closing
 * (pi shuts its socket server down on exit). If the socket is still open
 * after the escalation window, SIGKILL.
 */
async function terminatePi(client: PiSocketClient, piPid: number): Promise<void> {
	try {
		process.kill(piPid, "SIGTERM");
	} catch {
		return;
	}
	const closed = client.waitClosed().then(() => "closed" as const);
	const escalation = new Promise<"escalate">((resolve) => setTimeout(() => resolve("escalate"), SIGKILL_ESCALATION_MS));
	if ((await Promise.race([closed, escalation])) === "escalate") {
		try {
			process.kill(piPid, "SIGKILL");
		} catch {
			// Already gone.
		}
		await closed;
	}
}

/**
 * Wait for a pid to disappear. There is no channel to a non-child process, so
 * this polls kill(pid, 0) with a short interval; SIGKILL on deadline.
 */
async function waitPidGone(pid: number, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (isPidAlive(pid)) {
		if (Date.now() > deadline) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				return;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function parseStopArgs(argv: string[], extraOptions: Record<string, { type: "boolean" }>): {
	agent: string;
	timeoutMs: number | undefined;
	flags: Record<string, boolean | undefined>;
} {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { timeout: { type: "string" }, ...extraOptions },
	});
	if (positionals.length !== 1) {
		throw new Error("expected exactly one agent id");
	}
	const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
	if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
		throw new Error(`invalid --timeout: ${values.timeout}`);
	}
	const flags: Record<string, boolean | undefined> = {};
	for (const key of Object.keys(extraOptions)) {
		flags[key] = (values as Record<string, boolean | string | undefined>)[key] as boolean | undefined;
	}
	return { agent: positionals[0]!, timeoutMs, flags };
}

/** The quiescence-wait → SIGTERM → escalate → holder-gone sequence shared by kill and suspend. */
async function stopRunningAgent(agent: LoadedAgent, timeoutMs: number | undefined, abortFirst: boolean): Promise<void> {
	const client = await connectWithRetry(piSocketPath(agent.dir), SOCKET_CONNECT_DEADLINE_MS);
	try {
		if (abortFirst) {
			await client.request({ type: "abort" });
		}
		await waitQuiescent(client, timeoutMs);
		await terminatePi(client, agent.record.piPid);
	} finally {
		client.close();
	}
	await waitPidGone(agent.record.holderPid, PROCESS_EXIT_DEADLINE_MS);
}

export async function runKill(argv: string[]): Promise<void> {
	const { agent: prefix, timeoutMs, flags } = parseStopArgs(argv, {
		now: { type: "boolean" },
		force: { type: "boolean" },
	});
	const agent = await loadAgent(prefix);

	if (flags.force) {
		for (const pid of [agent.record.piPid, agent.record.holderPid]) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		await waitPidGone(agent.record.holderPid, PROCESS_EXIT_DEADLINE_MS);
		await rm(agent.dir, { recursive: true, force: true });
		console.log(`killed ${agent.id} (forced)`);
		return;
	}

	if (isPidAlive(agent.record.holderPid)) {
		try {
			await stopRunningAgent(agent, timeoutMs, flags.now ?? false);
		} catch (error) {
			if (error instanceof QuiescenceTimeoutError) {
				throw new Error(`agent ${agent.id} is still busy after ${timeoutMs! / 1000}s; not killed`);
			}
			throw error;
		}
	}

	// Tombstone before removal so an interrupted rm leaves a gc-able dir.
	await writeFile(tombstonePath(agent.dir), `${new Date().toISOString()}\n`);
	await rm(agent.dir, { recursive: true, force: true });
	console.log(`killed ${agent.id}`);
}

export async function runSuspend(argv: string[]): Promise<void> {
	const { agent: prefix, timeoutMs } = parseStopArgs(argv, {});
	const agent = await loadAgent(prefix);

	if (!isPidAlive(agent.record.holderPid)) {
		console.log(`${agent.id} is already dormant`);
		return;
	}
	try {
		await stopRunningAgent(agent, timeoutMs, false);
	} catch (error) {
		if (error instanceof QuiescenceTimeoutError) {
			throw new Error(`agent ${agent.id} is still busy after ${timeoutMs! / 1000}s; not suspended`);
		}
		throw error;
	}
	console.log(`suspended ${agent.id}`);
}

export async function runResume(argv: string[]): Promise<void> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
	if (positionals.length !== 1) {
		throw new Error("expected exactly one agent id");
	}
	const agent = await loadAgent(positionals[0]!);

	if (isPidAlive(agent.record.holderPid)) {
		console.log(`${agent.id} is already running`);
		return;
	}
	await launchHolder({
		dir: agent.dir,
		id: agent.id,
		cwd: agent.record.cwd,
		piBin: agent.record.piBin,
		piArgs: agent.record.spawnArgs,
		resume: true,
	});
	console.log(`resumed ${agent.id}`);
}
