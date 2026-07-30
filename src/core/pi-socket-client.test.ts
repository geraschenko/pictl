import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import type { RpcSessionState } from "@geraschenko/pi-coding-agent";
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
  /** Write raw bytes, for tests that control chunk boundaries. */
  sendRaw(bytes: Buffer): void;
  closeConnection(): void;
  close(): Promise<void>;
}

/**
 * A fake pi socket: sends hello + the seeding session_changed on connect and
 * answers every request with a bare success response. Awaiting a request
 * after send() is the ordering barrier tests use — the response is written
 * after the sent records, and the stream is processed in order — so no test
 * ever sleeps to "let events arrive".
 */
async function startFakePiServer(
  sendInitialSeed = true,
): Promise<FakePiServer> {
  const dir = await mkdtemp(join(tmpdir(), "pictl-socket-client-test-"));
  const socketPath = join(dir, "pi.sock");
  let connection: Socket | undefined;
  const writeJson = (record: Record<string, unknown>): void => {
    connection!.write(`${JSON.stringify(record)}\n`);
  };
  const server: Server = createServer((socket) => {
    connection = socket;
    writeJson({ type: "hello", protocol: "pi-rpc-socket", version: 1 });
    if (sendInitialSeed) {
      writeJson({ type: "session_changed", state: seedState("session-1") });
    }
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
    sendRaw: (bytes) => connection!.write(bytes),
    closeConnection: () => connection!.destroy(),
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

test("pre-subscribe events advance the seed and are not replayed", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    try {
      server.send({ type: "agent_start" });
      await flush(client);
      const subscription = await client.subscribe();
      assert.equal(subscription.seed.isStreaming, true);
      assert.equal(subscription.seed.sessionId, "session-1");

      server.send({ type: "agent_settled" });
      await flush(client);
      const next = await subscription.events[Symbol.asyncIterator]().next();
      assert.equal(next.done, false);
      assert.equal(next.value?.event.type, "agent_settled");
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
      const subscription = await client.subscribe();
      const iterator = subscription.events[Symbol.asyncIterator]();
      server.send({ type: "agent_start" });
      server.send({ type: "compaction_start", reason: "manual" });
      server.send({ type: "agent_settled" });
      await flush(client);
      const streamEvents = await Promise.all([
        iterator.next(),
        iterator.next(),
        iterator.next(),
      ]);
      const pairs = streamEvents.map(({ value }) => ({
        type: value!.event.type,
        isStreaming: value!.state.isStreaming,
        isCompacting: value!.state.isCompacting,
      }));
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

test("a UTF-8 code point split across socket chunks survives intact", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    try {
      const subscription = await client.subscribe();
      const iterator = subscription.events[Symbol.asyncIterator]();
      const note = "liftoff \u{1f680}";
      const torn = Buffer.from(
        `${JSON.stringify({ type: "agent_settled", note })}\n`,
      );
      // Split inside the rocket's 4-byte encoding. The first write carries a
      // complete record ahead of the torn prefix; receiving that record
      // proves the prefix arrived in an earlier chunk than its continuation,
      // so the tear cannot be papered over by kernel coalescing.
      const splitAt = torn.indexOf(Buffer.from("\u{1f680}")) + 2;
      server.sendRaw(
        Buffer.concat([
          Buffer.from('{"type":"agent_start"}\n'),
          torn.subarray(0, splitAt),
        ]),
      );
      assert.equal((await iterator.next()).value!.event.type, "agent_start");
      server.sendRaw(torn.subarray(splitAt));
      await flush(client);
      const next = await iterator.next();
      assert.equal(next.done, false);
      assert.equal((next.value!.event as { note?: string }).note, note);
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
      const subscription = await client.subscribe();
      server.send({ type: "session_changed", state: seedState("session-2") });
      await flush(client);
      const next = await subscription.events[Symbol.asyncIterator]().next();
      assert.equal(next.done, false);
      assert.deepEqual(
        {
          type: next.value!.event.type,
          sessionId: next.value!.state.sessionId,
        },
        { type: "session_changed", sessionId: "session-2" },
      );
    } finally {
      client.close();
    }
  } finally {
    await server.close();
  }
});

test("events arriving around seed resolution remain queued in wire order", async () => {
  const server = await startFakePiServer(false);
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    try {
      const subscriptionPromise = client.subscribe();
      server.send({ type: "session_changed", state: seedState("session-1") });
      server.send({ type: "agent_start" });
      server.send({ type: "agent_settled" });
      await flush(client);
      const subscription = await subscriptionPromise;
      const iterator = subscription.events[Symbol.asyncIterator]();
      const first = await iterator.next();
      const second = await iterator.next();
      assert.deepEqual(
        [first.value!.event.type, second.value!.event.type],
        ["agent_start", "agent_settled"],
      );
    } finally {
      client.close();
    }
  } finally {
    await server.close();
  }
});

test("iterator return drops queued events without closing the socket", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    try {
      const subscription = await client.subscribe();
      server.send({ type: "agent_start" });
      await flush(client);
      const iterator = subscription.events[Symbol.asyncIterator]();
      assert.equal((await iterator.return!()).done, true);
      assert.equal((await iterator.next()).done, true);
      assert.equal(client.isClosed, false);
      await flush(client);
    } finally {
      client.close();
    }
  } finally {
    await server.close();
  }
});

test("socket close drains queued events before ending the iterable", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    const subscription = await client.subscribe();
    server.send({ type: "agent_start" });
    server.send({ type: "agent_settled" });
    await flush(client);
    server.closeConnection();
    await client.waitClosed();
    const iterator = subscription.events[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value!.event.type, "agent_start");
    assert.equal((await iterator.next()).value!.event.type, "agent_settled");
    assert.equal((await iterator.next()).done, true);
  } finally {
    await server.close();
  }
});

test("a seed established before close remains subscribable", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    await flush(client);
    server.closeConnection();
    await client.waitClosed();
    const subscription = await client.subscribe();
    assert.equal(subscription.seed.sessionId, "session-1");
    assert.equal(
      (await subscription.events[Symbol.asyncIterator]().next()).done,
      true,
    );
  } finally {
    await server.close();
  }
});

test("socket close before seed rejects subscription with the client-owned error", async () => {
  const server = await startFakePiServer(false);
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    const subscriptionPromise = client.subscribe();
    server.closeConnection();
    await assert.rejects(
      subscriptionPromise,
      new Error("pi socket closed before the subscribe seed"),
    );
  } finally {
    await server.close();
  }
});

test("a second subscribe throws", async () => {
  const server = await startFakePiServer();
  try {
    const client = await PiSocketClient.connect(server.socketPath);
    try {
      await client.subscribe();
      await assert.rejects(client.subscribe(), /already subscribed/u);
    } finally {
      client.close();
    }
  } finally {
    await server.close();
  }
});
