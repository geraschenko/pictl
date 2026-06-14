import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  type AgentRecord,
  agentDirPath,
  resolveAgentId,
  writeAgentRecord,
} from "./registry.ts";

let baseDir: string;

async function writeAgent(agentId: string): Promise<void> {
  const agentDir = agentDirPath(agentId);
  await mkdir(agentDir, { recursive: true });
  const record: AgentRecord = {
    id: agentId,
    createdAt: "2026-06-12T00:00:00.000Z",
    cwd: "/tmp",
    piBin: "pi",
    spawnArgs: [],
    holderPid: 1,
    piPid: 1,
    sessions: [],
    agentDir,
  };
  await writeAgentRecord(record);
}

before(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "pictl-registry-test-"));
  process.env.PICTL_DIR = baseDir;

  await writeAgent("alpha-agent");
  await writeAgent("beta-agent");
});

after(async () => {
  delete process.env.PICTL_DIR;
  await rm(baseDir, { recursive: true, force: true });
});

test("exact agent id resolves", async () => {
  assert.equal(await resolveAgentId("alpha-agent"), "alpha-agent");
});

test("unique agent id prefix resolves", async () => {
  assert.equal(await resolveAgentId("al"), "alpha-agent");
});

test("ambiguous agent id prefix errors with candidates", async () => {
  await assert.rejects(
    resolveAgentId(""),
    /ambiguous agent id ''.*alpha-agent/s,
  );
});

test("no match errors", async () => {
  await assert.rejects(resolveAgentId("zzz"), /no agent matches 'zzz'/);
});
