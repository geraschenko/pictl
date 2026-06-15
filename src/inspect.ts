/*
 * `pictl list | status` — read-only inspection of the registry. Neither
 * revives dormant agents: a dead holder is not garbage.
 */

import { resolve } from "node:path";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import {
  commandMultiTarget,
  commandNoTarget,
  multiTargets,
  trueFlag,
  type CommandContext,
} from "./cli.ts";
import {
  type AgentRecord,
  classifyAgentDir,
  isPidAlive,
  listAgentIds,
  piSocketPath,
} from "./registry.ts";
import { connectWithRetry, getState } from "./rpc.ts";

const PROBE_CONNECT_DEADLINE_MS = 2_000;

export type AgentStatus =
  | "idle"
  | "streaming"
  | "dormant"
  | "archived"
  | "tombstoned"
  | "corrupt"
  | "unreachable";

export interface AgentProbe {
  agentId: string;
  status: AgentStatus;
  record?: AgentRecord;
  state?: RpcSessionState;
  error?: string;
}

interface ListFlags {
  json?: true;
  all?: true;
  cwd?: string;
}

interface StatusFlags {
  json?: true;
}

export async function probeAgent(agentId: string): Promise<AgentProbe> {
  const classified = await classifyAgentDir(agentId);
  if (classified.kind === "tombstoned") {
    return { agentId, status: "tombstoned" };
  }
  if (classified.kind === "corrupt") {
    return { agentId, status: "corrupt", error: classified.error };
  }
  if (classified.kind === "archived" || classified.kind === "dormant") {
    return { agentId, status: classified.kind, record: classified.record };
  }
  const record = classified.record;
  try {
    const client = await connectWithRetry(
      piSocketPath(record.agentDir),
      PROBE_CONNECT_DEADLINE_MS,
    );
    try {
      const state = await getState(client);
      return {
        agentId,
        status: state.isStreaming ? "streaming" : "idle",
        record,
        state,
      };
    } finally {
      client.close();
    }
  } catch (error) {
    return { agentId, status: "unreachable", record, error: String(error) };
  }
}

function formatTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export async function list(
  this: CommandContext,
  flags: ListFlags,
): Promise<void> {
  const cwdFilter = flags.cwd === undefined ? undefined : resolve(flags.cwd);
  const agentIds = await listAgentIds();
  let probes = await Promise.all(agentIds.map(probeAgent));
  // Archived agents are kept but hidden unless asked for; --cwd matches the
  // agent's recorded working directory exactly (resolved).
  if (flags.all !== true) {
    probes = probes.filter((probe) => probe.status !== "archived");
  }
  if (cwdFilter !== undefined) {
    probes = probes.filter((probe) => probe.record?.cwd === cwdFilter);
  }
  probes.sort((a, b) =>
    (a.record?.createdAt ?? "").localeCompare(b.record?.createdAt ?? ""),
  );

  if (flags.json === true) {
    this.process.stdout.write(`${JSON.stringify(probes, null, 2)}\n`);
    return;
  }
  if (probes.length === 0) {
    this.process.stdout.write("no agents\n");
    return;
  }
  const rows = [["ID", "TAG", "STATUS", "CWD", "CREATED"]];
  for (const probe of probes) {
    rows.push([
      probe.agentId.slice(0, 8),
      probe.record?.tag ?? "-",
      probe.status,
      probe.record?.cwd ?? "-",
      probe.record?.createdAt ?? "-",
    ]);
  }
  this.process.stdout.write(`${formatTable(rows)}\n`);
}

function formatProbe(probe: AgentProbe): string {
  const lines = [
    `id:       ${probe.agentId}`,
    `status:   ${probe.status}${probe.error ? ` (${probe.error})` : ""}`,
  ];
  if (probe.record) {
    if (probe.record.tag !== undefined) {
      lines.push(`tag:      ${probe.record.tag}`);
    }
    lines.push(`cwd:      ${probe.record.cwd}`);
    lines.push(`created:  ${probe.record.createdAt}`);
    lines.push(`pi bin:   ${probe.record.piBin}`);
    lines.push(`args:     ${probe.record.spawnArgs.join(" ") || "-"}`);
    lines.push(
      `holder:   pid ${probe.record.holderPid}${isPidAlive(probe.record.holderPid) ? "" : " (dead)"}`,
    );
    lines.push(
      `pi:       pid ${probe.record.piPid}${isPidAlive(probe.record.piPid) ? "" : " (dead)"}`,
    );
  }
  if (probe.state) {
    lines.push(
      `model:    ${probe.state.model ? `${probe.state.model.provider}/${probe.state.model.id}` : "-"}`,
    );
    lines.push(`session:  ${probe.state.sessionFile ?? "(in-memory)"}`);
    lines.push(`pending:  ${probe.state.pendingMessageCount} message(s)`);
  }
  if (probe.record && probe.record.sessions.length > 0) {
    lines.push("sessions:");
    for (const entry of probe.record.sessions) {
      lines.push(`  ${entry.sessionFile}`);
    }
  }
  return lines.join("\n");
}

export async function status(
  this: CommandContext,
  flags: StatusFlags,
): Promise<void> {
  const probes = await Promise.all(
    multiTargets(this).map((target) => probeAgent(target.id)),
  );

  if (flags.json === true) {
    this.process.stdout.write(`${JSON.stringify(probes, null, 2)}\n`);
    return;
  }
  this.process.stdout.write(`${probes.map(formatProbe).join("\n\n")}\n`);
}

const listCommand = commandNoTarget<ListFlags>({
  common: true,
  docs: { brief: "list agents and their status" },
  parameters: {
    flags: {
      json: trueFlag("Print JSON"),
      all: trueFlag("Include archived agents"),
      cwd: {
        kind: "parsed",
        parse: String,
        brief: "Filter by cwd",
        optional: true,
      },
    },
  },
  func: list,
});

const statusCommand = commandMultiTarget<StatusFlags>({
  common: true,
  docs: { brief: "detailed status of agents" },
  parameters: {
    flags: { json: trueFlag("Print JSON") },
  },
  func: status,
});

export const listRoute = {
  list: listCommand,
} as const;

export const statusRoute = {
  status: statusCommand,
} as const;
