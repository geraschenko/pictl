/**
 * `pi-ctl kill | suspend | resume` — stopping and reviving agents.
 *
 * kill and suspend share the polite path: wait for full quiescence (not
 * streaming AND pending message queue empty), SIGTERM pi, SIGKILL escalation
 * if it lingers. kill additionally tombstones and removes the directory;
 * suspend leaves it, making the agent dormant.
 *
 * All three accept multiple agents; ids are resolved up front (so a typo
 * aborts before anything is touched), then agents are acted on concurrently,
 * continuing past per-agent failures and reporting them at the end.
 */

import { rm, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  type AgentRecord,
  agentDirPath,
  isPidAlive,
  piSocketPath,
  readAgentRecord,
  resolveAgentId,
  tombstonePath,
} from "./registry.ts";
import { connectWithRetry, getState, type PiSocketClient } from "./rpc.ts";
import { launchHolder } from "./spawn.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;
const SIGKILL_ESCALATION_MS = 5_000;
const PROCESS_EXIT_DEADLINE_MS = 10_000;

interface LoadedAgent {
  agentId: string;
  agentDir: string;
  record: AgentRecord;
}

async function loadAgent(prefix: string): Promise<LoadedAgent> {
  const agentId = await resolveAgentId(prefix);
  const agentDir = agentDirPath(agentId);
  const read = await readAgentRecord(agentDir);
  if (read.kind !== "ok") {
    throw new Error(
      read.kind === "missing"
        ? `agent '${agentId}' has no agent.json (failed spawn?); run \`pi-ctl gc\``
        : `agent '${agentId}' has a corrupt agent.json: ${read.error}; run \`pi-ctl gc\``,
    );
  }
  return { agentId, agentDir, record: read.record };
}

function killSilently(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

export class QuiescenceTimeoutError extends Error {}

/**
 * Wait until the agent is fully quiescent. State is re-checked only on
 * agent_end (once per turn), not per event. The waiter is registered before
 * each get_state so an agent_end landing between the two is not missed.
 */
export async function waitQuiescent(
  client: PiSocketClient,
  timeoutMs: number | undefined,
): Promise<void> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (true) {
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
      // Cleared after the race; see the timer comment in terminatePi.
      let timeoutTimer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutTimer = setTimeout(() => resolve("timeout"), remaining);
      });
      const winner = await Promise.race([nextAgentEnd, timeout]);
      clearTimeout(timeoutTimer);
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
async function terminatePi(
  client: PiSocketClient,
  piPid: number,
): Promise<void> {
  try {
    process.kill(piPid, "SIGTERM");
  } catch {
    return;
  }
  const closed = client.waitClosed().then(() => "closed" as const);
  // The timer must be cleared after the race: a pending timer is an active
  // handle that keeps node's event loop (and thus the CLI process) alive
  // until it fires, even though the losing promise is discarded.
  let escalationTimer: NodeJS.Timeout | undefined;
  const escalation = new Promise<"escalate">((resolve) => {
    escalationTimer = setTimeout(
      () => resolve("escalate"),
      SIGKILL_ESCALATION_MS,
    );
  });
  const winner = await Promise.race([closed, escalation]);
  clearTimeout(escalationTimer);
  if (winner === "escalate") {
    killSilently(piPid, "SIGKILL");
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

interface StopArgs {
  agentPrefixes: string[];
  timeoutMs: number | undefined;
  flags: Record<string, boolean | undefined>;
}

function parseStopArgs(
  argv: string[],
  extraOptions: Record<string, { type: "boolean" }>,
): StopArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { timeout: { type: "string" }, ...extraOptions },
  });
  if (positionals.length === 0) {
    throw new Error("expected at least one agent id");
  }
  const timeoutMs =
    values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
  if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
    throw new Error(`invalid --timeout: ${values.timeout}`);
  }
  const flags: Record<string, boolean | undefined> = {};
  for (const key of Object.keys(extraOptions)) {
    flags[key] = (values as Record<string, boolean | string | undefined>)[
      key
    ] as boolean | undefined;
  }
  return { agentPrefixes: positionals, timeoutMs, flags };
}

/**
 * Resolve all prefixes before acting (so a typo aborts before anything is
 * touched), then run `action` on every agent concurrently — agents are
 * independent, and concurrency keeps quiescence waits from compounding.
 * Failures are collected and reported in input order.
 */
async function forEachAgent(
  prefixes: string[],
  action: (agent: LoadedAgent) => Promise<void>,
): Promise<void> {
  const agents = await Promise.all(prefixes.map(loadAgent));
  const failures = await Promise.all(
    agents.map((agent) =>
      action(agent).then(
        () => undefined,
        (error) =>
          `${agent.agentId}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ),
  );
  const messages = failures.filter((failure) => failure !== undefined);
  if (messages.length > 0) {
    throw new Error(messages.join("\n"));
  }
}

/** The quiescence-wait → SIGTERM → escalate → holder-gone sequence shared by kill and suspend. */
async function stopRunningAgent(
  agent: LoadedAgent,
  timeoutMs: number | undefined,
  abortFirst: boolean,
): Promise<void> {
  const client = await connectWithRetry(
    piSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
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

async function killOne(
  agent: LoadedAgent,
  timeoutMs: number | undefined,
  now: boolean,
  force: boolean,
): Promise<void> {
  if (force) {
    killSilently(agent.record.piPid, "SIGKILL");
    killSilently(agent.record.holderPid, "SIGKILL");
    await Promise.all([
      waitPidGone(agent.record.piPid, PROCESS_EXIT_DEADLINE_MS),
      waitPidGone(agent.record.holderPid, PROCESS_EXIT_DEADLINE_MS),
    ]);
    await rm(agent.agentDir, { recursive: true, force: true });
    console.log(`killed ${agent.agentId} (forced)`);
    return;
  }

  if (isPidAlive(agent.record.holderPid)) {
    try {
      await stopRunningAgent(agent, timeoutMs, now);
    } catch (error) {
      if (error instanceof QuiescenceTimeoutError) {
        throw new Error(`still busy after ${timeoutMs! / 1000}s; not killed`);
      }
      throw error;
    }
  }

  // Tombstone before removal so an interrupted rm leaves a gc-able dir.
  await writeFile(
    tombstonePath(agent.agentDir),
    `${new Date().toISOString()}\n`,
  );
  await rm(agent.agentDir, { recursive: true, force: true });
  console.log(`killed ${agent.agentId}`);
}

export async function runKill(argv: string[]): Promise<void> {
  const { agentPrefixes, timeoutMs, flags } = parseStopArgs(argv, {
    now: { type: "boolean" },
    force: { type: "boolean" },
  });
  await forEachAgent(agentPrefixes, (agent) =>
    killOne(agent, timeoutMs, flags.now ?? false, flags.force ?? false),
  );
}

export async function runSuspend(argv: string[]): Promise<void> {
  const { agentPrefixes, timeoutMs } = parseStopArgs(argv, {});
  await forEachAgent(agentPrefixes, async (agent) => {
    if (!isPidAlive(agent.record.holderPid)) {
      console.log(`${agent.agentId} is already dormant`);
      return;
    }
    try {
      await stopRunningAgent(agent, timeoutMs, false);
    } catch (error) {
      if (error instanceof QuiescenceTimeoutError) {
        throw new Error(
          `still busy after ${timeoutMs! / 1000}s; not suspended`,
        );
      }
      throw error;
    }
    console.log(`suspended ${agent.agentId}`);
  });
}

export async function runResume(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {},
  });
  if (positionals.length === 0) {
    throw new Error("expected at least one agent id");
  }
  await forEachAgent(positionals, async (agent) => {
    if (isPidAlive(agent.record.holderPid)) {
      console.log(`${agent.agentId} is already running`);
      return;
    }
    await launchHolder({
      agentDir: agent.agentDir,
      agentId: agent.agentId,
      cwd: agent.record.cwd,
      piBin: agent.record.piBin,
      piArgs: agent.record.spawnArgs,
      resume: true,
    });
    console.log(`resumed ${agent.agentId}`);
  });
}
