import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  type AgentRecord,
  agentDirPath,
  resolveAgentAddress,
} from "./registry.ts";

let baseDir: string;
let workflowDir: string;

async function writeAgent(
  agentId: string,
  sessionIds: string[],
): Promise<void> {
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
    sessions: sessionIds.map((sessionId) => ({
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
    })),
  };
  await writeFile(
    join(agentDir, "agent.json"),
    `${JSON.stringify(record)}\n`,
  );
}

before(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "pi-ctl-registry-test-"));
  process.env.PI_CTL_DIR = baseDir;
  delete process.env.PI_WORKFLOW_DIR;

  await writeAgent("alpha-agent", ["session-one", "session-once"]);
  await writeAgent("beta-agent", ["session-three"]);

  workflowDir = await mkdtemp(join(tmpdir(), "pi-ctl-workflow-test-"));
  await writeFile(
    join(workflowDir, "state.json"),
    JSON.stringify({
      agents: { worker: "beta-agent", ghost: "no-such-agent" },
      cursors: { worker: "ignored-by-resolver" },
    }),
  );
});

after(async () => {
  delete process.env.PI_CTL_DIR;
  await rm(baseDir, { recursive: true, force: true });
  await rm(workflowDir, { recursive: true, force: true });
});

test("exact agent id resolves", async () => {
  assert.equal(await resolveAgentAddress("alpha-agent"), "alpha-agent");
});

test("unique agent id prefix resolves", async () => {
  assert.equal(await resolveAgentAddress("al"), "alpha-agent");
});

test("ambiguous agent id prefix errors with candidates", async () => {
  await assert.rejects(
    resolveAgentAddress(""),
    /ambiguous agent id ''.*alpha-agent/s,
  );
});

test("exact session id resolves to its hosting agent", async () => {
  assert.equal(await resolveAgentAddress("session-three"), "beta-agent");
});

test("unique session id prefix resolves", async () => {
  assert.equal(await resolveAgentAddress("session-th"), "beta-agent");
});

test("session prefix matching multiple sessions of one agent resolves", async () => {
  assert.equal(await resolveAgentAddress("session-on"), "alpha-agent");
});

test("session prefix spanning agents errors as ambiguous", async () => {
  await assert.rejects(
    resolveAgentAddress("session-"),
    /ambiguous session id 'session-'/,
  );
});

test("no match errors and names the namespaces tried", async () => {
  await assert.rejects(
    resolveAgentAddress("zzz"),
    /no agent matches 'zzz' \(tried agent ids, session ids\)/,
  );
});

test("workflow role resolves via the state file", async () => {
  assert.equal(await resolveAgentAddress("worker", workflowDir), "beta-agent");
});

test("workflow role mapping to a missing agent errors", async () => {
  await assert.rejects(
    resolveAgentAddress("ghost", workflowDir),
    /workflow role 'ghost' maps to agent 'no-such-agent'/,
  );
});

test("agent id wins over a workflow role of the same name", async () => {
  await writeFile(
    join(workflowDir, "state.json"),
    JSON.stringify({ agents: { "alpha-agent": "beta-agent" } }),
  );
  assert.equal(
    await resolveAgentAddress("alpha-agent", workflowDir),
    "alpha-agent",
  );
});

test("missing workflow state file degrades to other namespaces", async () => {
  assert.equal(
    await resolveAgentAddress("be", join(baseDir, "no-such-workflow")),
    "beta-agent",
  );
  await assert.rejects(
    resolveAgentAddress("worker", join(baseDir, "no-such-workflow")),
    /no agent matches 'worker' \(tried agent ids, workflow roles, session ids\)/,
  );
});
