/**
 * The agent registry is a directory of agent dirs: $PI_CTL_DIR/<agentId>/ with
 * agent.json (written only by the holder), pi.sock, tty.sock, holder.log,
 * and optionally a tombstone file marking the dir for gc.
 */

import { open, readdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi defers writing a new session file until the first assistant message, so
 * an announced sessionFile may not exist on disk yet. Consumers that need the
 * file (e.g. revival) must check existence themselves.
 */
export interface SessionHistoryEntry {
  sessionFile: string;
  sessionId: string;
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

/** The agent's own directory within the registry. */
export function agentDirPath(agentId: string): string {
  return join(piCtlBaseDir(), agentId);
}

export function agentJsonPath(agentDir: string): string {
  return join(agentDir, "agent.json");
}

export function piSocketPath(agentDir: string): string {
  return join(agentDir, "pi.sock");
}

export function ttySocketPath(agentDir: string): string {
  return join(agentDir, "tty.sock");
}

export function tombstonePath(agentDir: string): string {
  return join(agentDir, "tombstone");
}

export function holderLogPath(agentDir: string): string {
  return join(agentDir, "holder.log");
}

export type AgentRecordReadResult =
  | { kind: "ok"; record: AgentRecord }
  | { kind: "missing" }
  | { kind: "corrupt"; error: string };

export async function readAgentRecord(
  agentDir: string,
): Promise<AgentRecordReadResult> {
  let raw: string;
  try {
    raw = await readFile(agentJsonPath(agentDir), "utf8");
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
    return {
      kind: "corrupt",
      error: `agent.json is not valid JSON: ${String(error)}`,
    };
  }
}

/**
 * Atomic write: write + fsync a temp file, then rename over the target.
 * Without the fsync a crash shortly after rename can leave an empty file on
 * some filesystems; with it, readers see either the old or the new content.
 */
export async function writeAgentRecord(
  agentDir: string,
  record: AgentRecord,
): Promise<void> {
  const target = agentJsonPath(agentDir);
  const tmp = `${target}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(record, null, "\t")}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
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

/**
 * A workflow state file maps role names to agent ids:
 * `<workflowDir>/state.json` containing `{"agents": {"<role>": "<agentId>"}}`.
 * Other keys are ignored (workflow scripts keep their own bookkeeping there).
 * A missing or unreadable file degrades to "no roles" — role addressing is a
 * convenience layer, never a hard dependency.
 */
async function lookupWorkflowRole(
  workflowDir: string,
  role: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(workflowDir, "state.json"), "utf8");
    const state = JSON.parse(raw) as { agents?: Record<string, unknown> };
    const agentId = state.agents?.[role];
    return typeof agentId === "string" ? agentId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an agent address to an agent id. Namespaces are tried in order:
 *   1. agent id, exact or unique prefix;
 *   2. workflow role name (when a workflow dir is given via `--workflow` or
 *      `PI_WORKFLOW_DIR`), resolved through that dir's state file;
 *   3. session id, exact or unique prefix, matched against every agent's
 *      session history.
 * Ambiguity within a namespace is an error, never a guess.
 */
export async function resolveAgentAddress(
  address: string,
  workflowDir: string | undefined = process.env.PI_WORKFLOW_DIR,
): Promise<string> {
  const agentIds = await listAgentIds();
  if (agentIds.includes(address)) {
    return address;
  }
  const idMatches = agentIds.filter((agentId) => agentId.startsWith(address));
  if (idMatches.length === 1) {
    return idMatches[0]!;
  }
  if (idMatches.length > 1) {
    throw new Error(
      `ambiguous agent id '${address}', candidates:\n  ${idMatches.join("\n  ")}`,
    );
  }

  if (workflowDir !== undefined) {
    const roleAgentId = await lookupWorkflowRole(workflowDir, address);
    if (roleAgentId !== undefined) {
      if (!agentIds.includes(roleAgentId)) {
        throw new Error(
          `workflow role '${address}' maps to agent '${roleAgentId}', which does not exist`,
        );
      }
      return roleAgentId;
    }
  }

  // agentId → a matching sessionId (one per agent suffices to identify it).
  const sessionMatches = new Map<string, string>();
  for (const agentId of agentIds) {
    const read = await readAgentRecord(agentDirPath(agentId));
    if (read.kind !== "ok") {
      continue;
    }
    for (const session of read.record.sessions) {
      if (session.sessionId.startsWith(address)) {
        sessionMatches.set(agentId, session.sessionId);
      }
    }
  }
  if (sessionMatches.size === 1) {
    return sessionMatches.keys().next().value!;
  }
  if (sessionMatches.size > 1) {
    const candidates = [...sessionMatches]
      .map(([agentId, sessionId]) => `${sessionId} (agent ${agentId})`)
      .join("\n  ");
    throw new Error(
      `ambiguous session id '${address}', candidates:\n  ${candidates}`,
    );
  }

  const namespaces = [
    "agent ids",
    ...(workflowDir !== undefined ? ["workflow roles"] : []),
    "session ids",
  ];
  throw new Error(
    `no agent matches '${address}' (tried ${namespaces.join(", ")})`,
  );
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
