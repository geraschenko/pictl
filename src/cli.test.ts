import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { app } from "./app.ts";
import { determineTargets, runCliApp } from "./cli.ts";
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
    await mkdir(join(dir, "zzzzzz"));
    await writeFile(
      join(dir, "abcdef", "agent.json"),
      JSON.stringify({
        id: "abcdef",
        createdAt: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
        piBin: "/bin/true",
        spawnArgs: [],
        daemonPid: 99999999,
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
  assert.match(help.stdout, /^\s{2}completion\s+Manage shell completion/m);
  assert.doesNotMatch(help.stdout, /^\s{2}steer\s+interject/m);

  const completionHelp = fakeProcess();
  await runCliApp(app, ["completion", "--help"], completionHelp.proc);
  assert.equal(completionHelp.proc.exitCode, 0);
  assert.match(completionHelp.stdout, /^\s{2}install\s+Installs bash/m);
  assert.match(completionHelp.stdout, /^\s{2}uninstall\s+Uninstalls bash/m);
  assert.doesNotMatch(completionHelp.stdout, /^\s{2}complete\s+print/m);

  const helpAll = fakeProcess();
  await runCliApp(app, ["--help-all"], helpAll.proc);
  assert.match(helpAll.stdout, /^\s{2}steer\s+interject/m);
  assert.match(
    helpAll.stdout,
    /^\s{2}_daemon\s+Internal command to launch a single-agent pi daemon/m,
  );

  const completionHelpAll = fakeProcess();
  await runCliApp(app, ["completion", "--help-all"], completionHelpAll.proc);
  assert.equal(completionHelpAll.proc.exitCode, 0);
  assert.match(completionHelpAll.stdout, /^\s{2}complete\s+print/m);
});

test("representative parser behavior uses --target grammar", async () => {
  await withRegistry(async () => {
    const accepted = fakeProcess();
    await runCliApp(app, ["status", "-t", "abc", "--json"], accepted.proc);
    assert.equal(accepted.proc.exitCode, 0);

    const missingTarget = fakeProcess();
    await runCliApp(app, ["status"], missingTarget.proc);
    assert.equal(missingTarget.proc.exitCode, 2);
    assert.equal(
      missingTarget.stderr,
      "expected at least one --target <agent> (or PICTL_TARGET)\n",
    );

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
    assert.match(globalTarget.stderr, /No command registered for `-t`/);
  });
});

async function completeWords(
  words: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string[]> {
  const completion = fakeProcess(env);
  await runCliApp(
    app,
    ["completion", "complete", "--", ...words],
    completion.proc,
  );
  assert.equal(completion.proc.exitCode, 0);
  return completion.stdout.trim().split("\n").filter(Boolean);
}

test("completion command proposes routes, flags, aliases, and hidden routes", async () => {
  assert.ok((await completeWords(["pictl", "sta"])).includes("status"));
  assert.ok(
    (await completeWords(["pictl", "completion", "in"])).includes("install"),
  );

  const statusFlags = await completeWords(["pictl", "status", "-"]);
  assert.ok(statusFlags.includes("-t"));
  assert.ok(statusFlags.includes("--target"));
  assert.ok(statusFlags.includes("--json"));

  assert.ok((await completeWords(["pictl", "_d"])).includes("_daemon"));
});

test("completion command honors trailing-space completion", async () => {
  const completions = await completeWords(["pictl", "status"], {
    COMP_LINE: "pictl status ",
  });
  assert.ok(completions.includes("-t"));
  assert.ok(completions.includes("--target"));
});

test("completion command proposes target ids", async () => {
  await withRegistry(async () => {
    const longFlagCompletions = await completeWords([
      "pictl",
      "status",
      "--target",
      "ab",
    ]);
    assert.ok(longFlagCompletions.includes("abcdef"));
    assert.ok(!longFlagCompletions.includes("zzzzzz"));

    const aliasCompletions = await completeWords([
      "pictl",
      "status",
      "-t",
      "ab",
    ]);
    assert.ok(aliasCompletions.includes("abcdef"));
    assert.ok(!aliasCompletions.includes("zzzzzz"));
  });
});

test("completion command proposes known positional values", async () => {
  const completions = await completeWords(["pictl", "set-follow-up-mode"], {
    COMP_LINE: "pictl set-follow-up-mode ",
  });
  assert.ok(completions.includes("all"));
  assert.ok(completions.includes("one-at-a-time"));
});
