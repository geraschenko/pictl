/**
 * `pi-ctl attach <agent>` — connect the local terminal to an agent's PTY via
 * the holder's tty.sock: raw-mode stdin, snapshot render, then bidirectional
 * byte proxying until the detach keybinding.
 */

import { connect, type Socket } from "node:net";
import { parseArgs } from "node:util";
import {
  agentDirPath,
  isPidAlive,
  readAgentRecord,
  resolveAgentId,
  ttySocketPath,
} from "./registry.ts";
import {
  encodeFrame,
  encodeResize,
  decodeExit,
  FrameDecoder,
  FrameType,
} from "./tty-protocol.ts";

/** The only definition of the detach key. 0x1d is ctrl+] as a raw-mode byte. */
const DETACH_KEY = 0x1d;
export const DETACH_KEY_NAME = "ctrl+]";

/**
 * Undo what an attach session may have left in the local terminal: pi runs
 * cursor-hidden with bracketed paste on, and output may end mid-SGR.
 * (show cursor, bracketed paste off, SGR reset)
 */
const TERMINAL_RESTORE_SEQUENCE = "\x1b[?25h\x1b[?2004l\x1b[0m";

/** Render the snapshot from the holder's emulator origin: home, clear. */
const CLEAR_SCREEN_SEQUENCE = "\x1b[H\x1b[2J";

/**
 * pi leaves the cursor at its editor line with the footer drawn below it;
 * printing there would leave the footer as ghost text around the shell
 * prompt. Park the cursor on the last row so the exit message and the prompt
 * land below everything pi drew.
 */
function cursorToLastRow(): string {
  return `\x1b[${process.stdout.rows};1H`;
}

export async function runAttach(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {},
  });
  if (positionals.length !== 1) {
    throw new Error("expected exactly one agent id");
  }
  const agentId = await resolveAgentId(positionals[0]!);
  const agentDir = agentDirPath(agentId);
  const read = await readAgentRecord(agentDir);
  if (read.kind !== "ok") {
    throw new Error(
      `agent ${agentId} has no readable agent.json (${read.kind})`,
    );
  }
  // TODO(phase 3): transparently revive dormant agents instead of erroring.
  if (!isPidAlive(read.record.holderPid)) {
    throw new Error(
      `agent ${agentId} is dormant; run \`pi-ctl resume ${agentId}\``,
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("attach requires stdin and stdout to be a terminal");
  }

  const socket = await connectToTty(ttySocketPath(agentDir), agentId);
  console.log(`attached to ${agentId}; detach: ${DETACH_KEY_NAME}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const finish = (exitCode: number, message: string): never => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(
      `${cursorToLastRow()}${TERMINAL_RESTORE_SEQUENCE}\r\n${message}\n`,
    );
    socket.destroy();
    process.exit(exitCode);
  };

  const sendResize = (): void => {
    socket.write(
      encodeResize({
        cols: process.stdout.columns,
        rows: process.stdout.rows,
      }),
    );
  };
  sendResize();
  process.stdout.on("resize", sendResize);

  const frameDecoder = new FrameDecoder();
  socket.on("data", (chunk) => {
    try {
      for (const frame of frameDecoder.push(chunk)) {
        switch (frame.type) {
          case FrameType.snapshot:
            process.stdout.write(CLEAR_SCREEN_SEQUENCE);
            process.stdout.write(frame.payload);
            break;
          case FrameType.output:
            process.stdout.write(frame.payload);
            break;
          case FrameType.exit:
            finish(0, `agent exited: ${decodeExit(frame.payload).reason}`);
            break;
          default:
            throw new Error(
              `unexpected server-to-client frame type ${frame.type}`,
            );
        }
      }
    } catch (error) {
      finish(1, `attach protocol error: ${String(error)}`);
    }
  });
  socket.on("close", () => finish(1, "connection to agent holder lost"));
  socket.on("error", () => socket.destroy());

  process.stdin.on("data", (chunk: Buffer) => {
    const detachIndex = chunk.indexOf(DETACH_KEY);
    if (detachIndex === -1) {
      socket.write(encodeFrame(FrameType.input, chunk));
      return;
    }
    const beforeDetach = chunk.subarray(0, detachIndex);
    if (beforeDetach.length > 0) {
      socket.write(encodeFrame(FrameType.input, beforeDetach));
    }
    finish(0, `detached from ${agentId}`);
  });

  // The proxy now runs entirely on the event handlers above; every path out
  // goes through finish() and process.exit.
  return new Promise<never>(() => {});
}

async function connectToTty(
  socketPath: string,
  agentId: string,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", (error) =>
      reject(
        new Error(
          `cannot connect to agent ${agentId}'s tty socket: ${String(error)}`,
        ),
      ),
    );
  });
}
