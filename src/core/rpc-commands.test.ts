import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { RpcCommand } from "@geraschenko/pi-coding-agent";
import { app } from "./app.ts";
import type { AuditCommandEvent } from "./audit.ts";
import { runCliApp } from "./cli.ts";
import { auditLogPath } from "./registry.ts";
import { fakeProcess } from "./test-util.ts";

test("clear-queue, max thinking, and queued-input dispositions route typed requests and audit mutations", async () => {
  const previousRegistry = process.env.PICTL_DIR;
  const registryDir = await mkdtemp(join(tmpdir(), "pictl-rpc-"));
  const agentId = "agent-1";
  const agentDir = join(registryDir, agentId);
  const requests: RpcCommand[] = [];
  const cleared = { steering: ["steer me"], followUp: ["next turn"] };
  const server = createServer((socket) => {
    socket.write(
      `${JSON.stringify({ type: "hello", protocol: "pi-rpc-socket", version: 1 })}\n`,
    );
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const command = JSON.parse(line) as RpcCommand;
      requests.push(command);
      socket.write(
        `${JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          ...(command.type === "clear_queue" ? { data: cleared } : {}),
          ...(command.type === "steer" || command.type === "follow_up"
            ? { data: { disposition: "queued" } }
            : {}),
        })}\n`,
      );
    });
  });
  try {
    process.env.PICTL_DIR = registryDir;
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "agent.json"),
      JSON.stringify({
        id: agentId,
        createdAt: "2026-01-01T00:00:00.000Z",
        cwd: registryDir,
        piBin: "/bin/true",
        spawnArgs: [],
        daemonPid: process.pid,
        piPid: process.pid,
        sessions: [],
      }),
    );
    server.listen(join(agentDir, "pi.sock"));
    await once(server, "listening");

    for (const raw of [false, true]) {
      const captured = fakeProcess();
      await runCliApp(
        app,
        ["clear-queue", "-t", agentId, ...(raw ? ["--raw"] : [])],
        captured.proc,
      );
      assert.equal(captured.proc.exitCode, 0, captured.stderr);
      const request = requests.at(-1)!;
      assert.deepEqual(request, { id: request.id, type: "clear_queue" });
      assert.deepEqual(
        JSON.parse(captured.stdout),
        raw
          ? {
              id: request.id,
              type: "response",
              command: "clear_queue",
              success: true,
              data: cleared,
            }
          : cleared,
      );
    }
    const thinking = fakeProcess();
    await runCliApp(
      app,
      ["set-thinking-level", "-t", agentId, "max"],
      thinking.proc,
    );
    assert.equal(thinking.proc.exitCode, 0, thinking.stderr);
    const request = requests.at(-1)!;
    assert.deepEqual(request, {
      id: request.id,
      type: "set_thinking_level",
      level: "max",
    });

    const invalid = fakeProcess();
    await runCliApp(
      app,
      ["set-thinking-level", "-t", agentId, "typo"],
      invalid.proc,
    );
    assert.equal(invalid.proc.exitCode, 2);
    assert.equal(requests.length, 3);
    const auditEvents = (await readFile(auditLogPath(agentDir), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuditCommandEvent);
    assert.deepEqual(
      auditEvents.map((event) => event.argv),
      [
        ["clear-queue", "-t", agentId],
        ["clear-queue", "-t", agentId, "--raw"],
        ["set-thinking-level", "-t", agentId, "max"],
      ],
    );

    // pi reports how queued input was dispatched; pictl prints it like any
    // other response data.
    for (const [subcommand, type] of [
      ["steer", "steer"],
      ["follow-up", "follow_up"],
    ] as const) {
      const captured = fakeProcess();
      await runCliApp(app, [subcommand, "-t", agentId, "hi"], captured.proc);
      assert.equal(captured.proc.exitCode, 0, captured.stderr);
      assert.equal(requests.at(-1)!.type, type);
      assert.deepEqual(JSON.parse(captured.stdout), { disposition: "queued" });
    }
  } finally {
    if (previousRegistry === undefined) delete process.env.PICTL_DIR;
    else process.env.PICTL_DIR = previousRegistry;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(registryDir, { recursive: true, force: true });
  }
});

test("clear-queue help and thinking completion expose the new inputs", async () => {
  const help = fakeProcess();
  await runCliApp(app, ["clear-queue", "--help"], help.proc);
  assert.equal(help.proc.exitCode, 0, help.stderr);
  assert.match(help.stdout, /--target/);
  assert.match(help.stdout, /--raw/);
  const completion = fakeProcess({ COMP_LINE: "pictl set-thinking-level " });
  await runCliApp(
    app,
    ["completion", "complete", "--", "pictl", "set-thinking-level"],
    completion.proc,
  );
  assert.equal(completion.proc.exitCode, 0, completion.stderr);
  assert.ok(completion.stdout.trim().split("\n").includes("max"));
  const routes = fakeProcess();
  await runCliApp(
    app,
    ["completion", "complete", "--", "pictl", "clear-"],
    routes.proc,
  );
  assert.equal(routes.proc.exitCode, 0, routes.stderr);
  assert.ok(routes.stdout.trim().split("\n").includes("clear-queue"));
});
