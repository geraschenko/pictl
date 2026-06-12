import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decodeExit,
  encodeFrame,
  encodeResize,
  type Frame,
  FrameDecoder,
  FrameType,
} from "./tty-protocol.ts";
import { TtyServer, type TtyServerHooks } from "./tty-server.ts";

interface TestClient {
  socket: Socket;
  frames: Frame[];
  /** Resolves once the client has received at least `count` frames. */
  framesReceived(count: number): Promise<void>;
  closed: Promise<void>;
}

function connectClient(socketPath: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const frames: Frame[] = [];
    const decoder = new FrameDecoder();
    const waiters: Array<{ count: number; resolve: () => void }> = [];
    socket.on("data", (chunk) => {
      frames.push(...decoder.push(chunk));
      for (const waiter of [...waiters]) {
        if (frames.length >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    });
    const closed = new Promise<void>((res) => socket.on("close", res));
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        socket,
        frames,
        framesReceived: (count) =>
          frames.length >= count
            ? Promise.resolve()
            : new Promise((res) => waiters.push({ count, resolve: res })),
        closed,
      }),
    );
  });
}

interface Harness {
  server: TtyServer;
  socketPath: string;
  inputs: string[];
  resizes: Array<{ cols: number; rows: number }>;
  /** Resolve the snapshot promise handed out by serializeScreen. */
  resolveSnapshot(snapshot: string): void;
  /** Reject the snapshot promise handed out by serializeScreen. */
  rejectSnapshot(error: Error): void;
  cleanup(): Promise<void>;
}

async function startServer(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "tty-server-test-"));
  const socketPath = join(dir, "tty.sock");
  const inputs: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  let pendingSnapshots: Array<{
    resolve: (s: string) => void;
    reject: (e: Error) => void;
  }> = [];
  const hooks: TtyServerHooks = {
    serializeScreen: () =>
      new Promise((resolve, reject) =>
        pendingSnapshots.push({ resolve, reject }),
      ),
    writeInput: (data) => inputs.push(data),
    resize: (cols, rows) => resizes.push({ cols, rows }),
  };
  const server = new TtyServer(hooks);
  await server.listen(socketPath);
  return {
    server,
    socketPath,
    inputs,
    resizes,
    resolveSnapshot: (snapshot) => {
      for (const pending of pendingSnapshots) {
        pending.resolve(snapshot);
      }
      pendingSnapshots = [];
    },
    rejectSnapshot: (error) => {
      for (const pending of pendingSnapshots) {
        pending.reject(error);
      }
      pendingSnapshots = [];
    },
    cleanup: async () => {
      await server.shutdown("test over");
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("output during snapshot serialization is buffered, not lost or reordered", async () => {
  const harness = await startServer();
  try {
    const client = await connectClient(harness.socketPath);
    // Output arrives while the snapshot is still serializing: it must reach
    // the client after the snapshot frame, in order.
    harness.server.broadcastOutput("during-1");
    harness.server.broadcastOutput("during-2");
    harness.resolveSnapshot("SNAPSHOT");
    await client.framesReceived(3);
    harness.server.broadcastOutput("after");
    await client.framesReceived(4);
    assert.deepEqual(
      client.frames.map((f) => [f.type, f.payload.toString()]),
      [
        [FrameType.snapshot, "SNAPSHOT"],
        [FrameType.output, "during-1"],
        [FrameType.output, "during-2"],
        [FrameType.output, "after"],
      ],
    );
  } finally {
    await harness.cleanup();
  }
});

test("input and resize frames reach the hooks; UTF-8 split across frames reassembles", async () => {
  const harness = await startServer();
  try {
    const client = await connectClient(harness.socketPath);
    harness.resolveSnapshot("");
    const snowman = Buffer.from("☃"); // 3 bytes
    client.socket.write(encodeFrame(FrameType.input, snowman.subarray(0, 1)));
    client.socket.write(encodeFrame(FrameType.input, snowman.subarray(1)));
    client.socket.write(encodeResize({ cols: 132, rows: 50 }));
    // input is fire-and-forget; resize lands after it on the same connection,
    // so its arrival implies the inputs arrived.
    while (harness.resizes.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(harness.inputs.join(""), "☃");
    assert.deepEqual(harness.resizes, [{ cols: 132, rows: 50 }]);
  } finally {
    await harness.cleanup();
  }
});

test("shutdown delivers an exit frame and closes connections", async () => {
  const harness = await startServer();
  const client = await connectClient(harness.socketPath);
  harness.resolveSnapshot("");
  await client.framesReceived(1);
  await harness.server.shutdown("pi exited (code 0)");
  await client.closed;
  const exitFrame = client.frames.at(-1)!;
  assert.equal(exitFrame.type, FrameType.exit);
  assert.deepEqual(decodeExit(exitFrame.payload), {
    reason: "pi exited (code 0)",
  });
});

test("a failed snapshot drops the client instead of buffering forever", async () => {
  const harness = await startServer();
  try {
    const client = await connectClient(harness.socketPath);
    harness.rejectSnapshot(new Error("serialize blew up"));
    await client.closed;
    assert.equal(client.frames.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("a client sending garbage is dropped without affecting others", async () => {
  const harness = await startServer();
  try {
    const good = await connectClient(harness.socketPath);
    const bad = await connectClient(harness.socketPath);
    harness.resolveSnapshot("");
    await Promise.all([good.framesReceived(1), bad.framesReceived(1)]);
    bad.socket.write(Buffer.from([255, 0, 0, 0, 0]));
    await bad.closed;
    harness.server.broadcastOutput("still-alive");
    await good.framesReceived(2);
    assert.equal(good.frames.at(-1)!.payload.toString(), "still-alive");
  } finally {
    await harness.cleanup();
  }
});
