import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  type AgentRecord,
  agentDirPath,
  agentIdError,
  agentJsonPath,
  readAgentRecord,
  readSpawnOptions,
  resolveAgentId,
  socketPathLengthError,
  type SpawnOptions,
  spawnOptionsPath,
  writeAgentRecord,
  writeSpawnOptions,
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
    attachments: [],
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
  assert.equal(
    socketPathLengthError(agentDirOfLength(94), "darwin"),
    undefined,
  );
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

test("agentIdError: accepts uuids and friendly ids", () => {
  assert.equal(agentIdError("c8b2e994-6872-425d-bfe7-b24b7987696d"), undefined);
  assert.equal(agentIdError("my_agent.1"), undefined);
});

test("agentIdError: rejects path traversal and separators", () => {
  for (const bad of ["..", ".", "../foo", "a/b", "a\\b", "", "with space"]) {
    assert.ok(agentIdError(bad), `expected '${bad}' to be rejected`);
  }
});

test("spawn options round-trip, with and without tag", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pictl-spawn-options-"));
  try {
    const withTag: SpawnOptions = {
      cwd: "/tmp",
      piBin: "/usr/bin/pi",
      spawnArgs: ["--approve"],
      tag: "web",
    };
    await writeSpawnOptions(agentDir, withTag);
    assert.deepEqual(await readSpawnOptions(agentDir), {
      kind: "ok",
      options: withTag,
    });

    const withoutTag: SpawnOptions = {
      cwd: "/tmp",
      piBin: "/usr/bin/pi",
      spawnArgs: [],
    };
    await writeSpawnOptions(agentDir, withoutTag);
    assert.deepEqual(await readSpawnOptions(agentDir), {
      kind: "ok",
      options: withoutTag,
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("readAgentRecord: a pre-attachment-tracking record reads as []", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pictl-agent-record-"));
  try {
    await writeFile(
      agentJsonPath(agentDir),
      JSON.stringify({
        id: "old-agent",
        createdAt: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
        piBin: "pi",
        spawnArgs: [],
        daemonPid: 1,
        piPid: 1,
        sessions: [],
      }),
    );
    const read = await readAgentRecord(agentDir);
    assert.equal(read.kind, "ok");
    assert.deepEqual((read as { record: AgentRecord }).record.attachments, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("readSpawnOptions: missing file", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pictl-spawn-options-"));
  try {
    assert.deepEqual(await readSpawnOptions(agentDir), { kind: "missing" });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("readSpawnOptions: invalid JSON and missing fields are corrupt", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pictl-spawn-options-"));
  try {
    await writeFile(spawnOptionsPath(agentDir), "not json");
    const invalid = await readSpawnOptions(agentDir);
    assert.equal(invalid.kind, "corrupt");
    assert.match((invalid as { error: string }).error, /not valid JSON/);

    await writeFile(spawnOptionsPath(agentDir), `{"cwd": "/tmp"}`);
    const incomplete = await readSpawnOptions(agentDir);
    assert.equal(incomplete.kind, "corrupt");
    assert.match((incomplete as { error: string }).error, /required fields/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
