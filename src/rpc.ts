/**
 * Minimal JSONL RPC client for pi's Unix-socket tee mode (`pi --rpc-socket`).
 *
 * The pi package's exported RpcClient spawns its own child process over stdio,
 * so it cannot attach to an existing socket; this client speaks the same
 * protocol over a net.Socket instead. Command/response/state types are
 * imported from the pi package; the socket-transport record types below are
 * not exported from its index, so they mirror
 * packages/coding-agent/src/modes/rpc/rpc-types.ts in the pi repo.
 */

import { connect, type Socket } from "node:net";
import type {
  RpcCommand,
  RpcResponse,
  RpcSessionState,
} from "@earendil-works/pi-coding-agent";

export interface SessionChangedEvent {
  type: "session_changed";
  sessionFile?: string;
  sessionId: string;
}

/** Any broadcast record that is not a response: agent events, session events, side-channel events. */
export type SocketEvent = { type: string } & Record<string, unknown>;

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

export class PiSocketClient {
  private readonly socket: Socket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners: Array<(event: SocketEvent) => void> = [];
  private readonly closedPromise: Promise<void>;
  private requestCounter = 0;
  private closed = false;

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
        resolve();
      });
    });
  }

  /**
   * Connect and consume the hello record; rejects if the path is not a pi RPC
   * socket. An event listener passed here is registered before any record is
   * dispatched — pi sends `session_changed` immediately after `hello`, often
   * in the same chunk, so registering via onEvent() after connect would lose it.
   */
  static async connect(
    socketPath: string,
    onEvent?: (event: SocketEvent) => void,
  ): Promise<PiSocketClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(socketPath);
      s.once("connect", () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });

    const client = new PiSocketClient(socket);
    if (onEvent) {
      client.eventListeners.push(onEvent);
    }
    socket.on("error", () => socket.destroy());

    let helloSeen = false;
    let resolveHello!: () => void;
    let rejectHello!: (error: Error) => void;
    const helloPromise = new Promise<void>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() !== "") {
          if (!helloSeen) {
            helloSeen = true;
            const error = validateHello(line);
            if (error) {
              socket.destroy();
              rejectHello(error);
            } else {
              resolveHello();
            }
          } else {
            client.dispatchLine(line);
          }
        }
        newlineIndex = buffer.indexOf("\n");
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
    let record: SocketEvent;
    try {
      record = JSON.parse(line) as SocketEvent;
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
    for (const listener of this.eventListeners) {
      listener(record);
    }
  }

  async request(command: RpcCommand): Promise<RpcResponse> {
    if (this.closed) {
      throw new Error("pi socket closed");
    }
    const id = `pi-ctl-${++this.requestCounter}`;
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ ...command, id })}\n`);
    });
    if (!response.success) {
      throw new Error(`pi rejected ${command.type}: ${response.error}`);
    }
    return response;
  }

  onEvent(listener: (event: SocketEvent) => void): void {
    this.eventListeners.push(listener);
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
    if (hello.version !== 1) {
      process.stderr.write(
        `pi-ctl: warning: pi socket protocol version ${hello.version}, expected 1\n`,
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
  onEvent?: (event: SocketEvent) => void,
): Promise<PiSocketClient> {
  const deadline = Date.now() + deadlineMs;
  let delay = 50;
  while (true) {
    try {
      return await PiSocketClient.connect(socketPath, onEvent);
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

/**
 * Free function rather than a PiSocketClient method to keep the client purely
 * transport-level. Serves programmatic state checks (quiescence waits in
 * lifecycle.ts, status probes in inspect.ts); the CLI passthrough in
 * rpc-commands.ts builds its commands from its own spec table instead.
 */
export async function getState(
  client: PiSocketClient,
): Promise<RpcSessionState> {
  const response = await client.request({ type: "get_state" });
  return (
    response as Extract<RpcResponse, { command: "get_state"; success: true }>
  ).data;
}
