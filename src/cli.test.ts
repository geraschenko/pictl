import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { determineTargets, runCliApp } from "./cli.ts";
import { app } from "./main.ts";
import { UsageError } from "./util.ts";

test("determineTargets implements target precedence and cardinality", () => {
  assert.deepEqual(determineTargets("none", [], { PICTL_TARGET: "env" }), []);
  assert.deepEqual(
    determineTargets("single", ["flag"], { PICTL_TARGET: "env" }),
    ["flag"],
  );
  assert.deepEqual(determineTargets("single", [], { PICTL_TARGET: "env" }), [
    "env",
  ]);
  assert.deepEqual(
    determineTargets("multiple", ["a", "b"], { PICTL_TARGET: "env" }),
    ["a", "b"],
  );
  assert.deepEqual(determineTargets("multiple", [], { PICTL_TARGET: "env" }), [
    "env",
  ]);
  assert.throws(() => determineTargets("single", ["a", "b"], {}), UsageError);
  assert.throws(() => determineTargets("single", [], {}), UsageError);
  assert.throws(() => determineTargets("multiple", [], {}), UsageError);
});

function fakeProcess(env: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  const proc = {
    env,
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
      },
    },
    exitCode: undefined as number | undefined,
  };
  return {
    proc: proc as unknown as NodeJS.Process,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function withRegistry<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const old = process.env.PICTL_DIR;
  const dir = await mkdtemp(join(tmpdir(), "pictl-test-"));
  process.env.PICTL_DIR = dir;
  try {
    await mkdir(join(dir, "abcdef"));
    await writeFile(
      join(dir, "abcdef", "agent.json"),
      JSON.stringify({
        id: "abcdef",
        createdAt: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
        piBin: "/bin/true",
        spawnArgs: [],
        holderPid: 99999999,
        piPid: 99999998,
        sessions: [],
      }),
    );
    return await fn(dir);
  } finally {
    if (old === undefined) {
      delete process.env.PICTL_DIR;
    } else {
      process.env.PICTL_DIR = old;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("help and version print key lines", async () => {
  const version = fakeProcess();
  await runCliApp(app, ["--version"], version.proc);
  assert.equal(version.proc.exitCode, 0);
  assert.equal(version.stdout.trim(), "0.1.0");

  const help = fakeProcess();
  await runCliApp(app, ["--help"], help.proc);
  assert.match(help.stdout, /COMMANDS/);
  assert.match(help.stdout, /^\s{2}prompt\s+send a prompt/m);
  assert.doesNotMatch(help.stdout, /^\s{2}steer\s+interject/m);

  const helpAll = fakeProcess();
  await runCliApp(app, ["--help-all"], helpAll.proc);
  assert.match(helpAll.stdout, /^\s{2}steer\s+interject/m);
  assert.match(helpAll.stdout, /^\s{2}_hold\s+internal holder daemon/m);
});

test("representative parser behavior uses --target grammar", async () => {
  await withRegistry(async () => {
    const accepted = fakeProcess();
    const oldLog = console.log;
    console.log = () => undefined;
    try {
      await runCliApp(app, ["status", "-t", "abc", "--json"], accepted.proc);
    } finally {
      console.log = oldLog;
    }
    assert.equal(accepted.proc.exitCode, 0);

    const oldPositional = fakeProcess();
    await runCliApp(app, ["status", "abc", "--json"], oldPositional.proc);
    assert.equal(oldPositional.proc.exitCode, 2);
    assert.match(oldPositional.stderr, /Too many arguments/);

    const noTargetCommand = fakeProcess();
    await runCliApp(app, ["list", "-t", "abc"], noTargetCommand.proc);
    assert.equal(noTargetCommand.proc.exitCode, 2);

    const globalTarget = fakeProcess();
    await runCliApp(app, ["-t", "abc", "prompt", "hello"], globalTarget.proc);
    assert.equal(globalTarget.proc.exitCode, 2);
    assert.match(globalTarget.stderr, /unknown command: -t/);
  });
});
