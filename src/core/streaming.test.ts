import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { app } from "./app.ts";
import { runCliApp } from "./cli.ts";

type JsonRecord = Record<string, unknown>;

interface CapturedProcess {
  proc: NodeJS.Process;
  stdout: string;
  stderr: string;
}

function fakeProcess(env: NodeJS.ProcessEnv = {}): CapturedProcess {
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

async function withFakeRegistry<T>(
  fn: (agentId: string, agentDir: string) => Promise<T>,
): Promise<T> {
  const old = process.env.PICTL_DIR;
  const dir = await mkdtemp(join(tmpdir(), "pictl-streaming-test-"));
  const agentId = "agent-1";
  const agentDir = join(dir, agentId);
  process.env.PICTL_DIR = dir;
  try {
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "agent.json"),
      JSON.stringify({
        id: agentId,
        createdAt: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
        piBin: "/bin/true",
        spawnArgs: [],
        daemonPid: process.pid,
        piPid: process.pid,
        sessions: [],
      }),
    );
    return await fn(agentId, agentDir);
  } finally {
    if (old === undefined) {
      delete process.env.PICTL_DIR;
    } else {
      process.env.PICTL_DIR = old;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function jsonlLines(output: string): JsonRecord[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      return JSON.parse(line) as JsonRecord;
    });
}

function writeJson(socket: Socket, record: JsonRecord): void {
  socket.write(`${JSON.stringify(record)}\n`);
}

async function withFakePiSocket<T>(
  agentDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const socketPath = join(agentDir, "pi.sock");
  const sessionId = "session-1";
  const userMessage = {
    role: "user",
    content: [
      { type: "text", text: "What is the name of the parent directory?" },
    ],
    timestamp: 1,
  };
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: ".worktrees" }],
    timestamp: 2,
  };
  const entries: Array<{
    type: "message";
    id: string;
    parentId: string | null;
    timestamp: string;
    message: typeof userMessage | typeof assistantMessage;
  }> = [
    {
      type: "message",
      id: "user-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: userMessage,
    },
  ];
  let leafId = "user-entry";
  let promptAccepted = false;
  let agentEnded = false;

  const server: Server = createServer((socket) => {
    writeJson(socket, { type: "hello", protocol: "pi-rpc-socket", version: 1 });
    writeJson(socket, { type: "session_changed", sessionId });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() !== "") {
          const request = JSON.parse(line) as JsonRecord;
          const id = request.id as string | undefined;
          if (request.type === "prompt") {
            promptAccepted = true;
            writeJson(socket, {
              id,
              type: "response",
              command: "prompt",
              success: true,
            });
            writeJson(socket, { type: "message_end", message: userMessage });
            setTimeout(() => {
              entries.push({
                type: "message",
                id: "assistant-entry",
                parentId: "user-entry",
                timestamp: "2026-01-01T00:00:01.000Z",
                message: assistantMessage,
              });
              leafId = "assistant-entry";
              agentEnded = true;
              writeJson(socket, {
                type: "message_end",
                message: assistantMessage,
              });
              writeJson(socket, {
                type: "agent_end",
                messages: [userMessage, assistantMessage],
                willRetry: false,
              });
            }, 10);
          } else if (request.type === "get_state") {
            writeJson(socket, {
              id,
              type: "response",
              command: "get_state",
              success: true,
              data: {
                thinkingLevel: "off",
                isStreaming: promptAccepted && !agentEnded,
                isCompacting: false,
                steeringMode: "all",
                followUpMode: "all",
                sessionId,
                autoCompactionEnabled: false,
                messageCount: entries.length,
                pendingMessageCount: 0,
              },
            });
          } else if (request.type === "get_entries") {
            const since = request.since as string | undefined;
            const sinceIndex =
              since === undefined
                ? -1
                : entries.findIndex((entry) => entry.id === since);
            writeJson(socket, {
              id,
              type: "response",
              command: "get_entries",
              success: true,
              data: {
                entries: entries.slice(sinceIndex + 1),
                leafId,
              },
            });
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("prompt streams assistant response and final cursor after prompt completion", async () => {
  await withFakeRegistry(async (agentId, agentDir) => {
    await withFakePiSocket(agentDir, async () => {
      const process = fakeProcess({ PICTL_TARGET: agentId });
      await runCliApp(
        app,
        ["prompt", "What is the name of the parent directory?"],
        process.proc,
      );

      assert.equal(process.proc.exitCode, 0);
      assert.equal(process.stderr, "");
      assert.deepEqual(jsonlLines(process.stdout), [
        {
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "What is the name of the parent directory?",
              },
            ],
            timestamp: 1,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: ".worktrees" }],
            timestamp: 2,
          },
        },
        {
          type: "pictl_cursor",
          sessionId: "session-1",
          entryId: "assistant-entry",
        },
      ]);
    });
  });
});

test("streaming flag validation rejects ambiguous or unsupported combinations", async () => {
  await withFakeRegistry(async (agentId) => {
    const followUntil = fakeProcess({ PICTL_TARGET: agentId });
    await runCliApp(
      app,
      ["tail", "--follow", "--until", "idle"],
      followUntil.proc,
    );
    assert.equal(followUntil.proc.exitCode, 2);
    assert.match(
      followUntil.stderr,
      /--follow\/-f cannot be combined with --until/,
    );

    const rawLimit = fakeProcess({ PICTL_TARGET: agentId });
    await runCliApp(app, ["tail", "--type", "raw", "-n", "1"], rawLimit.proc);
    assert.equal(rawLimit.proc.exitCode, 2);
    assert.match(rawLimit.stderr, /-n is not supported with --type raw/);

    const rawSince = fakeProcess({ PICTL_TARGET: agentId });
    await runCliApp(
      app,
      ["tail", "--type", "raw", "--since", "abc"],
      rawSince.proc,
    );
    assert.equal(rawSince.proc.exitCode, 2);
    assert.match(rawSince.stderr, /--since is not supported with --type raw/);

    const detachTimeout = fakeProcess({ PICTL_TARGET: agentId });
    await runCliApp(
      app,
      ["prompt", "--type", "detach", "--timeout", "1", "hello"],
      detachTimeout.proc,
    );
    assert.equal(detachTimeout.proc.exitCode, 2);
    assert.match(
      detachTimeout.stderr,
      /--type detach cannot be combined with --timeout/,
    );
  });
});
