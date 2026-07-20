import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import type {
  RpcSessionState,
  RpcSocketBroadcastEvent,
} from "@geraschenko/pi-coding-agent";
import { PiSocketClient } from "./pi-socket-client.ts";

function seedState(sessionId: string): RpcSessionState {
  return {
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    sessionId,
    autoCompactionEnabled: false,
    messageCount: 0,
    pendingMessageCount: 0,
  } as RpcSessionState;
}

interface FakePiServer {
  socketPath: string;
  /** Send a broadcast record on the (single) accepted connection. */
  send(record: Record<string, unknown>): void;
  close(): Promise<void>;
}

/**
 * A fake pi socket: sends hello + the seeding session_changed on connect and
 * answers every request with a bare success response. Awaiting a request
 * after send() is the ordering barrier tests use — the response is written
 * after the sent records, and the stream is processed in order — so no test
 * ever sleeps to "let events arrive".
 */
async function startFakePiServer(): Promise<FakePiServer> {
  const dir = await mkdtemp(join(tmpdir(), "pictl-socket-client-test-"));
  const socketPath = join(dir, "pi.sock");
  let connection: Socket | undefined;
  const writeJson = (record: Record<string, unknown>): void => {
    connection!.write(`${JSON.stringify(record)}\n`);
  };
  const server: Server = createServer((socket) => {
    connection = socket;
    writeJson({ type: "hello", protocol: "pi-rpc-socket", version: 1 });
    writeJson({ type: "session_changed", state: seedState("session-1") });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() !== "") {
          const request = JSON.parse(line) as { type: string; id?: string };
          writeJson({
            id: request.id,
            type: "response",
            command: request.type,
            success: true,
          });
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
  return {
    socketPath,
    send: writeJson,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Barrier: resolves only after every record sent before it is dispatched. */
async function flush(client: PiSocketClient): Promise<void> {
  await client.request({ type: "get_state" });
}

test("client owns the fold: pre-subscribe events advance the returned state and are not replayed", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    try {
      server.send({ type: "agent_start" });
      await flush(client);
      const delivered: RpcSocketBroadcastEvent[] = [];
      const seed = await client.subscribe((event) => delivered.push(event));
      // agent_start is reflected in the state, not replayed as an event.
      assert.equal(seed.isStreaming, true);
      assert.equal(seed.sessionId, "session-1");
      assert.deepEqual(delivered, []);
    } finally {
      client.close();
    }
  } finally {
    await server.close();
  }
});

test("each event is delivered paired with its post-fold state", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    try {
      const pairs: Array<{
        type: string;
        isStreaming: boolean;
        isCompacting: boolean;
      }> = [];
      await client.subscribe((event, state) =>
        pairs.push({
          type: event.type,
          isStreaming: state.isStreaming,
          isCompacting: state.isCompacting,
        }),
      );
      server.send({ type: "agent_start" });
      server.send({ type: "compaction_start", reason: "manual" });
      server.send({ type: "agent_settled" });
      await flush(client);
      assert.deepEqual(pairs, [
        { type: "agent_start", isStreaming: true, isCompacting: false },
        { type: "compaction_start", isStreaming: true, isCompacting: true },
        { type: "agent_settled", isStreaming: false, isCompacting: true },
      ]);
    } finally {
      client.close();
    }
  } finally {
    await server.close();
  }
});

test("a later session_changed reseeds the fold and is delivered as an event", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    try {
      const pairs: Array<{ type: string; sessionId: string }> = [];
      await client.subscribe((event, state) =>
        pairs.push({ type: event.type, sessionId: state.sessionId }),
      );
      server.send({ type: "session_changed", state: seedState("session-2") });
      await flush(client);
      assert.deepEqual(pairs, [
        { type: "session_changed", sessionId: "session-2" },
      ]);
    } finally {
      client.close();
    }
  } finally {
    await server.close();
  }
});

test("a second subscribe throws", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    try {
      await client.subscribe(() => {});
      assert.throws(() => client.subscribe(() => {}), /already subscribed/);
    } finally {
      client.close();
    }
  } finally {
    await server.close();
  }
});
