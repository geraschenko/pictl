import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditEnabled,
  recordAuditEvent,
  resolveCallerSource,
  resolveCallerSourceForPid,
  type AuditCommandEvent,
  type SourceRecord,
} from "./audit.ts";
import { auditLogPath, sourcesLogPath } from "./registry.ts";

// The /proc-walk tests are Linux-only; elsewhere the code degrades to the
// "process:<pid>" fallback, covered by the dead-pid test.
const hasProc = existsSync("/proc/self/stat");

test("auditEnabled is false only for PICTL_AUDIT=0 or off", () => {
  assert.equal(auditEnabled({}), true);
  assert.equal(auditEnabled({ PICTL_AUDIT: "1" }), true);
  assert.equal(auditEnabled({ PICTL_AUDIT: "on" }), true);
  assert.equal(auditEnabled({ PICTL_AUDIT: "0" }), false);
  assert.equal(auditEnabled({ PICTL_AUDIT: "off" }), false);
});

test("a PI_AGENT_ID caller resolves to a pictl source with no manager", () => {
  assert.deepEqual(resolveCallerSource("agent-1", 12345), {
    source: "pictl:agent-1",
  });
});

test("an unreadable pid falls back to a process source", () => {
  // pid 2^22 is above Linux's maximum pid, so /proc/<pid> never exists.
  const deadPid = 2 ** 22 + 1;
  assert.deepEqual(resolveCallerSource(undefined, deadPid), {
    source: `process:${deadPid}`,
  });
});

test(
  "the ancestry walk stops at the first non-shell process",
  { skip: !hasProc },
  () => {
    // The test process itself (node) is not a shell, so a walk starting there
    // stops immediately and reports it as the manager.
    const { source, manager } = resolveCallerSource(undefined, process.pid);
    assert.ok(manager !== undefined);
    assert.equal(manager.pid, process.pid);
    assert.equal(source, `${manager.comm}:${process.pid}`);
    assert.ok(manager.cmdline.length > 0);
  },
);

/** A child that stays alive until its stdin is closed (no timers involved). */
function spawnStdinWaiter(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const child = spawn(command, args, {
    env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

async function withChild<T>(
  childPromise: Promise<ChildProcess>,
  fn: (child: ChildProcess) => T,
): Promise<T> {
  const child = await childPromise;
  try {
    return fn(child);
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
}

test(
  "the ancestry walk skips non-interactive shells",
  { skip: !hasProc },
  async () => {
    // A bash child blocked on `read` is a non-interactive shell (no controlling
    // tty of its own session), so the walk ascends past it to this process.
    await withChild(
      spawnStdinWaiter("bash", ["-c", "read line"], process.env),
      (child) => {
        const { source, manager } = resolveCallerSource(undefined, child.pid!);
        assert.ok(manager !== undefined);
        assert.equal(manager.pid, process.pid);
        assert.equal(source, `${manager.comm}:${process.pid}`);
      },
    );
  },
);

test(
  "resolveCallerSourceForPid reads PI_AGENT_ID from the target's environ",
  { skip: !hasProc },
  async () => {
    await withChild(
      spawnStdinWaiter(process.execPath, ["-e", "process.stdin.resume()"], {
        ...process.env,
        PI_AGENT_ID: "environ-test",
      }),
      (child) => {
        assert.deepEqual(resolveCallerSourceForPid(child.pid!), {
          source: "pictl:environ-test",
        });
      },
    );
  },
);

test(
  "resolveCallerSourceForPid walks from the target's parent",
  { skip: !hasProc },
  async () => {
    const env = { ...process.env };
    delete env.PI_AGENT_ID;
    await withChild(
      spawnStdinWaiter(process.execPath, ["-e", "process.stdin.resume()"], env),
      (child) => {
        const { source, manager } = resolveCallerSourceForPid(child.pid!);
        assert.ok(manager !== undefined);
        assert.equal(manager.pid, process.pid);
        assert.equal(source, `${manager.comm}:${process.pid}`);
      },
    );
  },
);

async function withAgentDir<T>(
  fn: (agentDir: string) => Promise<T>,
): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), "pictl-audit-test-"));
  try {
    return await fn(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

function readJsonl(raw: string): unknown[] {
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

test("recordAuditEvent appends events and dedups source records", async () => {
  await withAgentDir(async (agentDir) => {
    const manager = { pid: 42, comm: "claude", cmdline: ["claude", "--flag"] };
    const event = (argv: string[]): AuditCommandEvent => ({
      ts: "2026-07-08T00:00:00.000Z",
      source: "claude:42",
      argv,
    });
    await recordAuditEvent(agentDir, event(["prompt", "hi"]), manager);
    await recordAuditEvent(agentDir, event(["abort"]), manager);

    const events = readJsonl(
      await readFile(auditLogPath(agentDir), "utf8"),
    ) as AuditCommandEvent[];
    assert.deepEqual(
      events.map((e) => e.argv),
      [["prompt", "hi"], ["abort"]],
    );
    assert.ok(events.every((e) => e.source === "claude:42"));

    const sources = readJsonl(
      await readFile(sourcesLogPath(agentDir), "utf8"),
    ) as SourceRecord[];
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.source, "claude:42");
    assert.equal(sources[0]!.comm, "claude");
    assert.deepEqual(sources[0]!.cmdline, ["claude", "--flag"]);
    assert.ok(!Number.isNaN(Date.parse(sources[0]!.firstSeen)));
  });
});

test("recordAuditEvent records each distinct source once", async () => {
  await withAgentDir(async (agentDir) => {
    await recordAuditEvent(
      agentDir,
      { ts: "t", source: "claude:1", argv: ["abort"] },
      { pid: 1, comm: "claude", cmdline: ["claude"] },
    );
    await recordAuditEvent(
      agentDir,
      { ts: "t", source: "codex:2", argv: ["abort"] },
      { pid: 2, comm: "codex", cmdline: ["codex"] },
    );
    const sources = readJsonl(
      await readFile(sourcesLogPath(agentDir), "utf8"),
    ) as SourceRecord[];
    assert.deepEqual(
      sources.map((s) => s.source),
      ["claude:1", "codex:2"],
    );
  });
});

test("recordAuditEvent without a manager writes no sources.jsonl", async () => {
  await withAgentDir(async (agentDir) => {
    await recordAuditEvent(agentDir, {
      ts: "t",
      source: "pictl:agent-1",
      argv: ["steer", "hey"],
    });
    assert.equal(existsSync(sourcesLogPath(agentDir)), false);
    const events = readJsonl(await readFile(auditLogPath(agentDir), "utf8"));
    assert.equal(events.length, 1);
  });
});
