/**
 * `pi-ctl list | status | gc` — read-only inspection of the registry.
 * None of these revive dormant agents: a dead holder is not garbage.
 */

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import {
  type AgentRecord,
  agentDirPath,
  archivedPath,
  isPidAlive,
  listAgentIds,
  piSocketPath,
  readAgentRecord,
  resolveAgentId,
  tombstonePath,
} from "./registry.ts";
import { connectWithRetry, getState } from "./rpc.ts";
import { fileExists } from "./util.ts";

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

export async function probeAgent(agentId: string): Promise<AgentProbe> {
  const agentDir = agentDirPath(agentId);
  if (await fileExists(tombstonePath(agentDir))) {
    return { agentId, status: "tombstoned" };
  }
  const read = await readAgentRecord(agentDir);
  if (read.kind !== "ok") {
    return {
      agentId,
      status: "corrupt",
      error: read.kind === "missing" ? "no agent.json" : read.error,
    };
  }
  const record = read.record;
  if (!isPidAlive(record.holderPid)) {
    const status = (await fileExists(archivedPath(agentDir)))
      ? "archived"
      : "dormant";
    return { agentId, status, record };
  }
  try {
    const client = await connectWithRetry(
      piSocketPath(agentDir),
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

export async function runList(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      cwd: { type: "string" },
    },
  });
  const cwdFilter = values.cwd === undefined ? undefined : resolve(values.cwd);
  const agentIds = await listAgentIds();
  let probes = await Promise.all(agentIds.map(probeAgent));
  // Archived agents are kept but hidden unless asked for; --cwd matches the
  // agent's recorded working directory exactly (resolved).
  if (!values.all) {
    probes = probes.filter((probe) => probe.status !== "archived");
  }
  if (cwdFilter !== undefined) {
    probes = probes.filter((probe) => probe.record?.cwd === cwdFilter);
  }
  probes.sort((a, b) =>
    (a.record?.createdAt ?? "").localeCompare(b.record?.createdAt ?? ""),
  );

  if (values.json) {
    console.log(JSON.stringify(probes, null, 2));
    return;
  }
  if (probes.length === 0) {
    console.log("no agents");
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
  console.log(formatTable(rows));
}

function printProbe(probe: AgentProbe): void {
  console.log(`id:       ${probe.agentId}`);
  console.log(
    `status:   ${probe.status}${probe.error ? ` (${probe.error})` : ""}`,
  );
  if (probe.record) {
    if (probe.record.tag !== undefined) {
      console.log(`tag:      ${probe.record.tag}`);
    }
    console.log(`cwd:      ${probe.record.cwd}`);
    console.log(`created:  ${probe.record.createdAt}`);
    console.log(`pi bin:   ${probe.record.piBin}`);
    console.log(`args:     ${probe.record.spawnArgs.join(" ") || "-"}`);
    console.log(
      `holder:   pid ${probe.record.holderPid}${isPidAlive(probe.record.holderPid) ? "" : " (dead)"}`,
    );
    console.log(
      `pi:       pid ${probe.record.piPid}${isPidAlive(probe.record.piPid) ? "" : " (dead)"}`,
    );
  }
  if (probe.state) {
    console.log(
      `model:    ${probe.state.model ? `${probe.state.model.provider}/${probe.state.model.id}` : "-"}`,
    );
    console.log(`session:  ${probe.state.sessionFile ?? "(in-memory)"}`);
    console.log(`pending:  ${probe.state.pendingMessageCount} message(s)`);
  }
  if (probe.record && probe.record.sessions.length > 0) {
    console.log("sessions:");
    for (const entry of probe.record.sessions) {
      console.log(`  ${entry.sessionFile}`);
    }
  }
}

export async function runStatus(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false } },
  });
  if (positionals.length === 0) {
    throw new Error("expected at least one agent id");
  }
  const agentIds = await Promise.all(
    positionals.map((address) => resolveAgentId(address)),
  );
  const probes = await Promise.all(agentIds.map(probeAgent));

  if (values.json) {
    console.log(JSON.stringify(probes, null, 2));
    return;
  }
  probes.forEach((probe, index) => {
    if (index > 0) {
      console.log("");
    }
    printProbe(probe);
  });
}

export async function runGc(argv: string[]): Promise<void> {
  parseArgs({ args: argv, options: {} });
  const agentIds = await listAgentIds();
  let removed = 0;
  for (const agentId of agentIds) {
    const probe = await probeAgent(agentId);
    if (probe.status === "tombstoned" || probe.status === "corrupt") {
      await rm(agentDirPath(agentId), { recursive: true, force: true });
      console.log(`removed ${agentId} (${probe.status})`);
      removed += 1;
    }
  }
  console.log(
    removed === 0 ? "nothing to remove" : `removed ${removed} agent dir(s)`,
  );
}
