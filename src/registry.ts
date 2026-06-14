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
  /** Optional label set at spawn (`--tag`); non-unique, for grouping. */
  tag?: string;
  piBin: string;
  spawnArgs: string[];
  holderPid: number;
  piPid: number;
  sessions: SessionHistoryEntry[];
  /**
   * The agent's own directory. Derived from the path, not persisted: populated
   * by readAgentRecord and stripped by writeAgentRecord (see there).
   */
  agentDir: string;
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

/**
 * Marks an agent as archived: a dormant agent the user is done with, hidden
 * from `list` by default but kept and revivable. A marker file (not a field in
 * holder-owned agent.json) so the CLI can set it without racing the holder.
 */
export function archivedPath(agentDir: string): string {
  return join(agentDir, "archived");
}

/** Serializes dormant-agent revival; holds the reviving process's pid. */
export function reviveLockPath(agentDir: string): string {
  return join(agentDir, "revive.lock");
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
    record.agentDir = agentDir;
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
 *
 * agentDir is derived from the path (readAgentRecord repopulates it), so it is
 * stripped here rather than duplicated into the file.
 */
export async function writeAgentRecord(
  agentDir: string,  // TDC: remove this arg; get it out of record instead.
  record: AgentRecord,
): Promise<void> {
  const { agentDir: _derived, ...persisted } = record;
  const target = agentJsonPath(agentDir);
  const tmp = `${target}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(persisted, null, "\t")}\n`);
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
 * Resolve an agent id, exact or as a unique prefix — to a full agent id. An
 * ambiguous prefix is an error listing the candidates, never a guess.
 */
export async function resolveAgentId(agentIdPrefix: string): Promise<string> {
  const agentIds = await listAgentIds();
  if (agentIds.includes(agentIdPrefix)) {
    return agentIdPrefix;
  }
  const matches = agentIds.filter((agentId) => agentId.startsWith(agentIdPrefix));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous agent id '${agentIdPrefix}', candidates:\n  ${matches.join("\n  ")}`,
    );
  }
  throw new Error(`no agent matches '${agentIdPrefix}'`);
}

/** Resolve an agent id and read its record (with agentDir populated). */
export async function loadAgent(agentIdPrefix: string): Promise<AgentRecord> {
  const agentId = await resolveAgentId(agentIdPrefix);
  const read = await readAgentRecord(agentDirPath(agentId));
  if (read.kind !== "ok") {
    throw new Error(
      read.kind === "missing"
        ? `agent '${agentId}' has no agent.json (failed spawn?); run \`pi-ctl gc\``
        : `agent '${agentId}' has a corrupt agent.json: ${read.error}; run \`pi-ctl gc\``,
    );
  }
  return read.record;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
