/**
 * The holder's tty.sock server: speaks the framed attach protocol from
 * tty-protocol.ts to any number of simultaneous clients. PTY/xterm specifics
 * stay in the holder and arrive here as hooks, so this module is pure
 * connection management.
 */

import { createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  decodeResize,
  encodeExit,
  encodeFrame,
  FrameDecoder,
  FrameType,
} from "./tty-protocol.ts";

const EXIT_FLUSH_DEADLINE_MS = 1_000;

export interface TtyServerHooks {
  /**
   * Serialize the current screen state. MUST synchronously enqueue a parse
   * barrier behind all PTY output written to the emulator so far, and resolve
   * with a snapshot that includes exactly that output: broadcastOutput data
   * relayed to a connecting client is buffered from the moment its connection
   * arrives, so output parsed before the barrier must be in the snapshot and
   * output written after it must not be (it reaches the client via the
   * buffer). Any other ordering duplicates or drops bytes on attach during
   * heavy streaming.
   */
  serializeScreen(): Promise<string>;
  writeInput(data: string): void;
  resize(cols: number, rows: number): void;
}

interface AttachClient {
  socket: Socket;
  /** Output relayed before the snapshot was sent; null once flushed. */
  pendingOutput: Buffer[] | null;
}

export class TtyServer {
  readonly server: Server;
  private readonly hooks: TtyServerHooks;
  private readonly clients = new Set<AttachClient>();

  constructor(hooks: TtyServerHooks) {
    this.hooks = hooks;
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, resolve);
    });
  }

  /** Relay PTY output to every attached client. */
  broadcastOutput(data: string): void {
    if (this.clients.size === 0) {
      return;
    }
    const payload = Buffer.from(data);
    for (const client of this.clients) {
      if (client.pendingOutput !== null) {
        client.pendingOutput.push(payload);
      } else {
        client.socket.write(encodeFrame(FrameType.output, payload));
      }
    }
  }

  /**
   * Tell every client the agent is going away, then close. The exit frame is
   * best-effort: flushing is bounded because a client that has stopped
   * reading (with a full kernel buffer) must not block holder shutdown — its
   * socket dying when the holder exits carries the same information.
   */
  async shutdown(reason: string): Promise<void> {
    this.server.close();
    const exitFrame = encodeExit({ reason });
    const flushes = [...this.clients].map(
      (client) =>
        new Promise<void>((resolve) => client.socket.end(exitFrame, resolve)),
    );
    let flushDeadline: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(flushes),
      new Promise<void>((resolve) => {
        flushDeadline = setTimeout(resolve, EXIT_FLUSH_DEADLINE_MS);
      }),
    ]);
    clearTimeout(flushDeadline);
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
  }

  private handleConnection(socket: Socket): void {
    const client: AttachClient = { socket, pendingOutput: [] };
    this.clients.add(client);
    const dropClient = (): void => {
      this.clients.delete(client);
      socket.destroy();
    };
    socket.on("close", dropClient);
    socket.on("error", dropClient);

    // Buffering (registration above) and the serialize parse barrier must be
    // enqueued in the same synchronous step — see TtyServerHooks.
    void this.hooks.serializeScreen().then((snapshot) => {
      if (client.pendingOutput === null || socket.destroyed) {
        return;
      }
      socket.write(encodeFrame(FrameType.snapshot, Buffer.from(snapshot)));
      for (const payload of client.pendingOutput) {
        socket.write(encodeFrame(FrameType.output, payload));
      }
      client.pendingOutput = null;
    });

    // Input bytes are UTF-8 that may split mid-character across frames;
    // StringDecoder reassembles (node-pty accepts only strings).
    const inputDecoder = new StringDecoder("utf8");
    const frameDecoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      try {
        for (const frame of frameDecoder.push(chunk)) {
          switch (frame.type) {
            case FrameType.input:
              this.hooks.writeInput(inputDecoder.write(frame.payload));
              break;
            case FrameType.resize: {
              const { cols, rows } = decodeResize(frame.payload);
              this.hooks.resize(cols, rows);
              break;
            }
            default:
              throw new Error(
                `unexpected client-to-server frame type ${frame.type}`,
              );
          }
        }
      } catch {
        dropClient();
      }
    });
  }
}
