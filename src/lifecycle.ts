/**
 * `pi-ctl suspend | archive | purge | resume` — stopping and reviving agents.
 *
 * suspend, archive, and purge share the polite path: wait for full quiescence
 * (not streaming AND pending message queue empty), SIGTERM pi, SIGKILL
 * escalation if it lingers. suspend leaves the agent dormant; archive also
 * marks it hidden from `list`; purge tombstones and removes the directory (the
 * only destructive command). resume revives a dormant or archived agent.
 *
 * All accept multiple agents; ids are resolved up front (so a typo aborts
 * before anything is touched), then agents are acted on concurrently,
 * continuing past per-agent failures and reporting them at the end.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  type AgentRecord,
  archivedPath,
  holderLogPath,
  isPidAlive,
  loadAgent,
  piSocketPath,
  reviveLockPath,
  tombstonePath,
} from "./registry.ts";
import { connectWithRetry, getState, type PiSocketClient } from "./rpc.ts";
import { launchHolder } from "./spawn.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;
const SIGKILL_ESCALATION_MS = 5_000;
const PROCESS_EXIT_DEADLINE_MS = 10_000;

const REVIVAL_WAIT_DEADLINE_MS = 10_000;
const REVIVAL_LOCK_POLL_MS = 100;

/** Set or clear an agent's archived marker (see registry.archivedPath). */
async function setArchived(agentDir: string, archived: boolean): Promise<void> {
  if (archived) {
    await writeFile(archivedPath(agentDir), `${new Date().toISOString()}\n`);
  } else {
    await rm(archivedPath(agentDir), { force: true });
  }
}

/**
 * Revive `agent` via launchHolder, serialized through an O_EXCL lock file.
 * Two concurrent revivals of the same agent must not both launch holders: the
 * second holder's stale-socket cleanup would delete the first's live pi.sock.
 * The loser waits for the winner instead of spawning. launchHolder returns
 * only once pi.sock is up, so holding the lock across it is the readiness
 * barrier. As with waitPidGone, there is no cross-process event channel for
 * "the lock file went away", so the loser polls.
 */
async function reviveAgent(agent: AgentRecord): Promise<AgentRecord> {
  const lockPath = reviveLockPath(agent.agentDir);
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return await awaitConcurrentRevival(agent, lockPath);
  }

  try {
    // Re-read under the lock: another process may have completed a revival
    // between our dormancy check and the lock acquisition.
    agent = await loadAgent(agent.id);
    if (isPidAlive(agent.holderPid)) {
      return agent;
    }
    process.stderr.write(`pi-ctl: reviving dormant agent ${agent.id}\n`);
    // Reviving an archived agent — including implicitly, by sending it a
    // command — un-archives it.
    await setArchived(agent.agentDir, false);
    await launchHolder({
      agentDir: agent.agentDir,
      agentId: agent.id,
      cwd: agent.cwd,
      piBin: agent.piBin,
      piArgs: agent.spawnArgs,
      resume: true,
    });
    return await loadAgent(agent.id);
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function awaitConcurrentRevival(
  agent: AgentRecord,
  lockPath: string,
): Promise<AgentRecord> {
  const deadline = Date.now() + REVIVAL_WAIT_DEADLINE_MS;
  while (true) {
    let lockContent: string;
    try {
      lockContent = await readFile(lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
    const lockHolderPid = Number(lockContent.trim());
    if (lockHolderPid > 0 && !isPidAlive(lockHolderPid)) {
      throw new Error(
        `stale revival lock for '${agent.id}' (process ${lockHolderPid} is gone); remove ${lockPath} and retry`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for a concurrent revival of '${agent.id}' (lock: ${lockPath})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, REVIVAL_LOCK_POLL_MS));
  }
  agent = await loadAgent(agent.id);
  if (!isPidAlive(agent.holderPid)) {
    throw new Error(
      `concurrent revival of '${agent.id}' failed; see ${holderLogPath(agent.agentDir)}`,
    );
  }
  return agent;
}

/**
 * The transparent-revival entry point for commands that need the agent's
 * pi.sock (RPC passthrough, attach). list/status/gc never revive by design.
 */
export async function ensureAgentRunning(
  agentIdPrefix: string,
): Promise<AgentRecord> {
  const agent = await loadAgent(agentIdPrefix);
  if (isPidAlive(agent.holderPid)) {
    return agent;
  }
  return await reviveAgent(agent);
}

function killSilently(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

// TDC: We still have references to "quiescence". Do an audit for the old quiescent/idle terminology, and let's fix it.
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
  action: (agent: AgentRecord) => Promise<void>,
): Promise<void> {
  const agents = await Promise.all(prefixes.map(loadAgent));
  const failures = await Promise.all(
    agents.map((agent) =>
      action(agent).then(
        () => undefined,
        (error) =>
          `${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
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
  agent: AgentRecord,
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
    await terminatePi(client, agent.piPid);
  } finally {
    client.close();
  }
  await waitPidGone(agent.holderPid, PROCESS_EXIT_DEADLINE_MS);
}

async function purgeOne(
  agent: AgentRecord,
  timeoutMs: number | undefined,
  now: boolean,
  force: boolean,
): Promise<void> {
  if (force) {
    killSilently(agent.piPid, "SIGKILL");
    killSilently(agent.holderPid, "SIGKILL");
    await Promise.all([
      waitPidGone(agent.piPid, PROCESS_EXIT_DEADLINE_MS),
      waitPidGone(agent.holderPid, PROCESS_EXIT_DEADLINE_MS),
    ]);
    await rm(agent.agentDir, { recursive: true, force: true });
    console.log(`purged ${agent.id} (forced)`);
    return;
  }

  if (isPidAlive(agent.holderPid)) {
    try {
      await stopRunningAgent(agent, timeoutMs, now);
    } catch (error) {
      if (error instanceof QuiescenceTimeoutError) {
        throw new Error(`still busy after ${timeoutMs! / 1000}s; not purged`);
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
  console.log(`purged ${agent.id}`);
}

export async function runPurge(argv: string[]): Promise<void> {
  const { agentPrefixes, timeoutMs, flags } = parseStopArgs(argv, {
    now: { type: "boolean" },
    force: { type: "boolean" },
  });
  await forEachAgent(agentPrefixes, (agent) =>
    purgeOne(agent, timeoutMs, flags.now ?? false, flags.force ?? false),
  );
}

export async function runSuspend(argv: string[]): Promise<void> {
  const { agentPrefixes, timeoutMs } = parseStopArgs(argv, {});
  await forEachAgent(agentPrefixes, async (agent) => {
    if (!isPidAlive(agent.holderPid)) {
      console.log(`${agent.id} is already dormant`);
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
    console.log(`suspended ${agent.id}`);
  });
}

/**
 * Stop a running agent (like suspend) and mark it archived so `list` hides it
 * by default; the record and its sessions are kept and any resume (explicit or
 * implicit) clears the flag. The deliberate destructive path is `purge`.
 */
export async function runArchive(argv: string[]): Promise<void> {
  const { agentPrefixes, timeoutMs } = parseStopArgs(argv, {});
  await forEachAgent(agentPrefixes, async (agent) => {
    if (isPidAlive(agent.holderPid)) {
      try {
        await stopRunningAgent(agent, timeoutMs, false);
      } catch (error) {
        if (error instanceof QuiescenceTimeoutError) {
          throw new Error(
            `still busy after ${timeoutMs! / 1000}s; not archived`,
          );
        }
        throw error;
      }
    }
    await setArchived(agent.agentDir, true);
    console.log(`archived ${agent.id}`);
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
    await setArchived(agent.agentDir, false);
    if (isPidAlive(agent.holderPid)) {
      console.log(`${agent.id} is already running`);
      return;
    }
    await launchHolder({
      agentDir: agent.agentDir,
      agentId: agent.id,
      cwd: agent.cwd,
      piBin: agent.piBin,
      piArgs: agent.spawnArgs,
      resume: true,
    });
    console.log(`resumed ${agent.id}`);
  });
}
