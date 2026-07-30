/**
 * Minimal JSONL RPC client for pi's Unix-socket tee mode (`pi --rpc-socket`).
 *
 * The pi package's exported RpcClient spawns its own child process over stdio,
 * so it cannot attach to an existing socket; this client speaks the same
 * protocol over a net.Socket instead. Command/response/state/event types are
 * imported from the pi package; the hello record is not exported from its
 * index, so validateHello mirrors packages/coding-agent/src/modes/rpc/
 * rpc-types.ts in the pi repo.
 *
 * The client owns the session-state fold: it seeds from the first
 * `session_changed` after hello (never delivered as an event) and folds every
 * subsequent broadcast through `nextSessionState` at dispatch. Once subscribed,
 * it queues each event with its post-fold state for one async consumer. Events
 * before subscribe are reflected in the seed rather than replayed.
 */

import { connect, type Socket } from "node:net";
import {
  nextSessionState,
  type RpcCommand,
  type RpcResponse,
  type RpcSessionState,
  type RpcSocketBroadcastEvent,
} from "@geraschenko/pi-coding-agent";
import { LineReader } from "./line-reader.ts";
import { AsyncQueue } from "./streaming/async-queue.ts";
import type { StreamEvent, StreamSubscription } from "./streaming/driver.ts";

/** Any parsed JSONL record off the socket, before classification. Non-response
 *  records are cast to pi's RpcSocketBroadcastEvent at dispatch — the one
 *  transport-boundary cast; safe because that union is what pi sends and the
 *  fold returns state unchanged for unknown event types. */
type SocketRecord = { type: string } & Record<string, unknown>;

/** The pi RPC socket protocol version this client speaks; bump alongside
 *  protocol-affecting changes to the pi fork. A mismatched hello only warns —
 *  the protocol is additive so far. */
const PI_SOCKET_PROTOCOL_VERSION = 1;

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

interface SeedWaiter {
  resolve: (seed: RpcSessionState) => void;
  reject: (error: Error) => void;
}

export type RpcEventSubscription = StreamSubscription<
  RpcSocketBroadcastEvent,
  RpcSessionState
>;

export class PiSocketClient {
  private readonly socket: Socket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closedPromise: Promise<void>;
  private requestCounter = 0;
  private closed = false;

  /** The folded session state, seeded by the first session_changed after
   *  hello and advanced by every subsequent broadcast; undefined until the
   *  seed arrives. */
  private state: RpcSessionState | undefined;
  private seedWaiter: SeedWaiter | undefined;
  private subscribed = false;

  /** Installed by subscribe(); until then broadcasts only advance the fold. */
  private events:
    | AsyncQueue<StreamEvent<RpcSocketBroadcastEvent, RpcSessionState>>
    | undefined;

  private constructor(socket: Socket) {
    this.socket = socket;
    this.closedPromise = new Promise((resolve) => {
      socket.on("close", () => {
        this.closed = true;
        const error = new Error("pi socket closed");
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();
        this.seedWaiter?.reject(
          new Error("pi socket closed before the subscribe seed"),
        );
        this.seedWaiter = undefined;
        this.events?.close();
        resolve();
      });
    });
  }

  /**
   * Connect and consume the hello record; rejects if the path is not a pi RPC
   * socket. The seeding session_changed pi sends right after hello arrives
   * stream-ordered before all events, so the fold misses nothing.
   */
  static async connect(socketPath: string): Promise<PiSocketClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(socketPath);
      s.once("connect", () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });

    const client = new PiSocketClient(socket);
    socket.on("error", () => socket.destroy());

    let helloSeen = false;
    let resolveHello!: () => void;
    let rejectHello!: (error: Error) => void;
    const helloPromise = new Promise<void>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });

    // Byte-level splitting: a UTF-8 code point torn across TCP chunks must
    // not be decoded until its continuation bytes arrive.
    const lineReader = new LineReader();
    socket.on("data", (chunk) => {
      for (const { text } of lineReader.push(chunk)) {
        if (!helloSeen) {
          helloSeen = true;
          const error = validateHello(text);
          if (error) {
            socket.destroy();
            rejectHello(error);
          } else {
            resolveHello();
          }
        } else {
          client.dispatchLine(text);
        }
      }
    });

    socket.on("close", () => {
      if (!helloSeen) {
        rejectHello(new Error("pi socket closed before hello"));
      }
    });

    await helloPromise;
    return client;
  }

  private dispatchLine(line: string): void {
    let record: SocketRecord;
    try {
      record = JSON.parse(line) as SocketRecord;
    } catch {
      return;
    }
    if (record.type === "response") {
      const response = record as unknown as RpcResponse;
      const pending =
        response.id === undefined ? undefined : this.pending.get(response.id);
      if (pending) {
        this.pending.delete(response.id!);
        pending.resolve(response);
      }
      return;
    }
    // The first session_changed after hello seeds the fold, not an event: pi
    // sends it immediately after hello, stream-ordered before all subsequent
    // events. Later session_changed records are ordinary events (the fold
    // reseeds wholesale from their state).
    if (this.state === undefined) {
      if (record.type === "session_changed") {
        this.state = (record as unknown as { state: RpcSessionState }).state;
        this.seedWaiter?.resolve(this.state);
        this.seedWaiter = undefined;
      }
      return;
    }
    const event = record as unknown as RpcSocketBroadcastEvent;
    this.state = nextSessionState(this.state, event);
    this.events?.push({ event, state: this.state });
  }

  async request(command: RpcCommand): Promise<RpcResponse> {
    if (this.closed) {
      throw new Error("pi socket closed");
    }
    const id = `pictl-${++this.requestCounter}`;
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ ...command, id })}\n`);
    });
    if (!response.success) {
      throw new Error(`pi rejected ${command.type}: ${response.error}`);
    }
    return response;
  }

  /**
   * Atomically installs the event queue and returns the current folded seed
   * plus subsequent events paired with their post-fold state. Events observed
   * before subscription are represented by the seed rather than replayed.
   */
  async subscribe(): Promise<RpcEventSubscription> {
    if (this.subscribed) {
      throw new Error("pi socket client already subscribed");
    }
    this.subscribed = true;
    this.events = new AsyncQueue();
    if (this.state !== undefined) {
      if (this.closed) {
        this.events.close();
      }
      return { seed: this.state, events: this.events };
    }
    if (this.closed) {
      throw new Error("pi socket closed before the subscribe seed");
    }
    const seed = await new Promise<RpcSessionState>((resolve, reject) => {
      this.seedWaiter = { resolve, reject };
    });
    return { seed, events: this.events };
  }

  /** Resolves when pi closes the socket (i.e. pi has exited or shut the server down). */
  waitClosed(): Promise<void> {
    return this.closedPromise;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.socket.destroy();
  }
}

function validateHello(line: string): Error | undefined {
  try {
    const hello = JSON.parse(line) as {
      type?: string;
      protocol?: string;
      version?: number;
    };
    if (hello.type !== "hello" || hello.protocol !== "pi-rpc-socket") {
      return new Error(`not a pi RPC socket (got ${line.slice(0, 100)})`);
    }
    if (hello.version !== PI_SOCKET_PROTOCOL_VERSION) {
      process.stderr.write(
        `pictl: warning: pi socket protocol version ${hello.version}, expected ${PI_SOCKET_PROTOCOL_VERSION}\n`,
      );
    }
    return undefined;
  } catch {
    return new Error("first record on pi socket was not valid JSON");
  }
}

/**
 * Connect, retrying while the socket does not exist yet or refuses connections
 * (pi still starting, or a stale socket file). Backoff doubles from 50ms,
 * capped at 500ms; there is no event to await for "pi has bound its socket",
 * so bounded retry is the fallback.
 */
export async function connectWithRetry(
  socketPath: string,
  deadlineMs: number,
): Promise<PiSocketClient> {
  const deadline = Date.now() + deadlineMs;
  let delay = 50;
  while (true) {
    try {
      return await PiSocketClient.connect(socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "ENOENT" || code === "ECONNREFUSED";
      if (!retryable || Date.now() + delay > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 500);
    }
  }
}
