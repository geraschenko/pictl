import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { app } from "./app.ts";
import { runCliApp } from "./cli.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "pictl-inspect-test-"));
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

function writeJson(socket: Socket, record: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(record)}\n`);
}

/** A pi.sock stand-in that only answers get_state with the given flags. */
async function withFakePiState<T>(
  agentDir: string,
  state: { isStreaming: boolean; isCompacting: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  const server: Server = createServer((socket) => {
    writeJson(socket, { type: "hello", protocol: "pi-rpc-socket", version: 1 });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() !== "") {
          const request = JSON.parse(line) as Record<string, unknown>;
          if (request.type === "get_state") {
            writeJson(socket, {
              id: request.id,
              type: "response",
              command: "get_state",
              success: true,
              data: {
                thinkingLevel: "off",
                isStreaming: state.isStreaming,
                isCompacting: state.isCompacting,
                steeringMode: "all",
                followUpMode: "all",
                sessionId: "session-1",
                autoCompactionEnabled: false,
                messageCount: 0,
                pendingMessageCount: 0,
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
    server.listen(join(agentDir, "pi.sock"), () => {
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

async function probedStatus(state: {
  isStreaming: boolean;
  isCompacting: boolean;
}): Promise<string> {
  return withFakeRegistry(async (agentId, agentDir) => {
    return withFakePiState(agentDir, state, async () => {
      const process = fakeProcess({ PICTL_TARGET: agentId });
      await runCliApp(app, ["status", "--json"], process.proc);
      assert.equal(process.proc.exitCode, 0);
      assert.equal(process.stderr, "");
      const probes = JSON.parse(process.stdout) as Array<{ status: string }>;
      assert.equal(probes.length, 1);
      return probes[0]!.status;
    });
  });
}

test("status reports idle when neither streaming nor compacting", async () => {
  assert.equal(
    await probedStatus({ isStreaming: false, isCompacting: false }),
    "idle",
  );
});

test("status reports streaming", async () => {
  assert.equal(
    await probedStatus({ isStreaming: true, isCompacting: false }),
    "streaming",
  );
});

test("status reports compacting even while streaming", async () => {
  assert.equal(
    await probedStatus({ isStreaming: true, isCompacting: true }),
    "compacting",
  );
});
