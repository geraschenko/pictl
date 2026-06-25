import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  type AgentRecord,
  agentDirPath,
  resolveAgentId,
  socketPathLengthError,
  writeAgentRecord,
} from "./registry.ts";

/** An agentDir of exactly `len` ASCII bytes. tty.sock adds 9, the NUL 1 more. */
function agentDirOfLength(len: number): string {
  return "/" + "a".repeat(len - 1);
}

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
    daemonPid: 1,
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

test("socketPathLengthError: a short path fits on both platforms", () => {
  const dir = agentDirOfLength(40);
  assert.equal(socketPathLengthError(dir, "linux"), undefined);
  assert.equal(socketPathLengthError(dir, "darwin"), undefined);
});

test("socketPathLengthError: Linux boundary is 108 bytes", () => {
  // agentDir 98 + "/tty.sock" 9 + NUL 1 = 108 = limit.
  assert.equal(socketPathLengthError(agentDirOfLength(98), "linux"), undefined);
  assert.match(
    socketPathLengthError(agentDirOfLength(99), "linux") ?? "",
    /too long.*109 bytes.*limit is 108/s,
  );
});

test("socketPathLengthError: macOS boundary is 104 bytes", () => {
  // agentDir 94 + 9 + 1 = 104 = limit.
  assert.equal(socketPathLengthError(agentDirOfLength(94), "darwin"), undefined);
  assert.match(
    socketPathLengthError(agentDirOfLength(95), "darwin") ?? "",
    /too long.*105 bytes.*limit is 104/s,
  );
});

test("socketPathLengthError: a path that fits Linux can overflow macOS", () => {
  const dir = agentDirOfLength(96);
  assert.equal(socketPathLengthError(dir, "linux"), undefined);
  assert.ok(socketPathLengthError(dir, "darwin"));
});

test("socketPathLengthError: counts bytes, not characters", () => {
  // 90 two-byte chars = 180 bytes, well over either limit despite 90 "chars".
  const dir = "/" + "é".repeat(90);
  assert.ok(socketPathLengthError(dir, "linux"));
});

test("socketPathLengthError: message names the path and a remedy", () => {
  const msg = socketPathLengthError(agentDirOfLength(200), "linux") ?? "";
  assert.match(msg, /tty\.sock/);
  assert.match(msg, /--id|PICTL_DIR/);
});
