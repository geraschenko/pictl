/**
 * `pi-ctl _hold` — the holder daemon. One per agent. It owns the PTY that pi
 * runs in, maintains detached screen state via @xterm/headless, and is the
 * sole writer of agent.json. It connects to its own pi.sock as a client to
 * track session replacements (never polling get_state per event).
 */

import { closeSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { SerializeAddon } from "@xterm/addon-serialize";
import xterm from "@xterm/headless";
import pty from "node-pty";
import {
  type AgentRecord,
  holderLogPath,
  piSocketPath,
  readAgentRecord,
  type SessionHistoryEntry,
  ttySocketPath,
  writeAgentRecord,
} from "./registry.ts";
import {
  connectWithRetry,
  type SessionChangedEvent,
  type SocketEvent,
} from "./rpc.ts";
import { TtyServer } from "./tty-server.ts";
import { fileExists, splitAtDoubleDash } from "./util.ts";

const PTY_COLS = 80;
const PTY_ROWS = 24;
const RPC_CONNECT_DEADLINE_MS = 30_000;

interface HoldArgs {
  agentDir: string;
  agentId: string;
  cwd: string;
  piBin: string;
  resume: boolean;
  readyFd: number | undefined;
  piArgs: string[];
}

function parseHoldArgs(argv: string[]): HoldArgs {
  const { ownArgs, passthroughArgs } = splitAtDoubleDash(argv);
  const { values } = parseArgs({
    args: ownArgs,
    options: {
      "agent-dir": { type: "string" },
      "agent-id": { type: "string" },
      cwd: { type: "string" },
      "pi-bin": { type: "string" },
      resume: { type: "boolean", default: false },
      "ready-fd": { type: "string" },
    },
  });
  if (
    !values["agent-dir"] ||
    !values["agent-id"] ||
    !values.cwd ||
    !values["pi-bin"]
  ) {
    throw new Error("_hold requires --agent-dir, --agent-id, --cwd, --pi-bin");
  }
  return {
    agentDir: values["agent-dir"],
    agentId: values["agent-id"],
    cwd: values.cwd,
    piBin: values["pi-bin"],
    resume: values.resume ?? false,
    readyFd:
      values["ready-fd"] === undefined ? undefined : Number(values["ready-fd"]),
    piArgs: passthroughArgs,
  };
}

function signalReady(
  readyFd: number | undefined,
  message: { ok: boolean; error?: string },
): void {
  if (readyFd === undefined) {
    return;
  }
  try {
    writeSync(readyFd, `${JSON.stringify(message)}\n`);
    closeSync(readyFd);
  } catch {
    // Spawner already gone; the holder runs on regardless.
  }
}

/**
 * Pick the session to revive: the most recent entry whose file exists on
 * disk. pi defers writing a session file until the first assistant message,
 * so newer entries may have no file yet — skip those.
 */
async function revivalSessionArgs(
  sessions: SessionHistoryEntry[],
): Promise<string[]> {
  for (const entry of [...sessions].reverse()) {
    if (await fileExists(entry.sessionFile)) {
      return ["--session", entry.sessionFile];
    }
  }
  return [];
}

function ptyEnv(agentId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.PI_AGENT_ID = agentId;
  return env;
}

/**
 * The serialize addon does not capture cursor visibility (DECTCEM), and pi
 * runs cursor-hidden, so a raw snapshot would show a phantom cursor on
 * attach. The public `terminal.modes` API lacks DECTCEM too; the internal
 * core service is the only place xterm tracks it. Guarded so an xterm
 * internals change degrades to "cursor visible", not a crash.
 */
function cursorVisibilitySequence(terminal: xterm.Terminal): string {
  const core = (
    terminal as unknown as {
      _core?: { coreService?: { isCursorHidden?: boolean } };
    }
  )._core;
  return core?.coreService?.isCursorHidden ? "\x1b[?25l" : "\x1b[?25h";
}

function isSessionChangedEvent(
  event: SocketEvent,
): event is SocketEvent & SessionChangedEvent {
  return event.type === "session_changed";
}

export async function runHold(argv: string[]): Promise<void> {
  const args = parseHoldArgs(argv);
  const { agentDir, agentId } = args;

  const existing = await readAgentRecord(agentDir);
  const createdAt =
    existing.kind === "ok"
      ? existing.record.createdAt
      : new Date().toISOString();
  const sessions = existing.kind === "ok" ? existing.record.sessions : [];

  // A SIGKILLed predecessor leaves stale socket files behind, and pi refuses
  // to bind an existing path. Launchers guarantee no live holder for this dir.
  await Promise.all([
    rm(piSocketPath(agentDir), { force: true }),
    rm(ttySocketPath(agentDir), { force: true }),
  ]);

  const sessionArgs = args.resume ? await revivalSessionArgs(sessions) : [];
  const piProcess = pty.spawn(
    args.piBin,
    ["--rpc-socket", piSocketPath(agentDir), ...sessionArgs, ...args.piArgs],
    {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: args.cwd,
      env: ptyEnv(agentId),
    },
  );

  // allowProposedApi is required by the serialize addon.
  const terminal = new xterm.Terminal({
    cols: PTY_COLS,
    rows: PTY_ROWS,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);

  const ttyServer = new TtyServer({
    // terminal.write("") is the parse barrier; serializing inside its
    // callback (not in a then() after it) keeps the snapshot exactly at the
    // barrier — xterm may parse further queued chunks before a microtask runs.
    serializeScreen: () =>
      new Promise((resolve) => {
        terminal.write("", () =>
          resolve(
            serializeAddon.serialize() + cursorVisibilitySequence(terminal),
          ),
        );
      }),
    writeInput: (data) => piProcess.write(data),
    // Last-writer-wins: every resize is applied. The emulator must track the
    // PTY size or snapshots drift from what pi is rendering.
    resize: (cols, rows) => {
      piProcess.resize(cols, rows);
      terminal.resize(cols, rows);
    },
  });

  piProcess.onData((data) => {
    terminal.write(data);
    ttyServer.broadcastOutput(data);
  });

  const record: AgentRecord = {
    id: agentId,
    createdAt,
    cwd: args.cwd,
    piBin: args.piBin,
    spawnArgs: args.piArgs,
    holderPid: process.pid,
    piPid: piProcess.pid,
    sessions,
  };
  await writeAgentRecord(agentDir, record);

  // agent.json writes are serialized through this chain; session events can
  // arrive faster than a write completes.
  let writeQueue: Promise<void> = Promise.resolve();
  const queueRecordWrite = (): void => {
    writeQueue = writeQueue.then(
      () => writeAgentRecord(agentDir, record),
      () => writeAgentRecord(agentDir, record),
    );
  };

  await ttyServer.listen(ttySocketPath(agentDir));

  let exiting = false;
  const cleanupAndExit = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    void writeQueue
      .catch(() => undefined)
      .then(async () => {
        await ttyServer.shutdown(`pi exited (code ${code})`);
        await Promise.all([
          rm(piSocketPath(agentDir), { force: true }),
          rm(ttySocketPath(agentDir), { force: true }),
        ]);
        process.exit(code);
      });
  };

  piProcess.onExit(({ exitCode }) => {
    console.log(`[holder] pi exited with code ${exitCode}`);
    cleanupAndExit(exitCode);
  });
  // Any termination request to the holder means "shut the agent down":
  // forward as SIGTERM so pi exits cleanly. Forwarding SIGINT verbatim would
  // be wrong — interactive pi treats it as "abort the current turn" and
  // keeps running, leaving a holder that was asked to die still alive.
  process.on("SIGTERM", () => piProcess.kill("SIGTERM"));
  process.on("SIGINT", () => piProcess.kill("SIGTERM"));

  const handleEvent = (event: SocketEvent): void => {
    if (!isSessionChangedEvent(event)) {
      return;
    }
    // In-memory sessions (no file) are not recorded; they cannot be revived.
    if (event.sessionFile === undefined) {
      return;
    }
    // The history is duplicate-free: re-announcing a known session moves it
    // to the end (most recent).
    const previousIndex = record.sessions.findIndex(
      (s) => s.sessionId === event.sessionId,
    );
    if (previousIndex !== -1) {
      record.sessions.splice(previousIndex, 1);
    }
    record.sessions.push({
      sessionFile: event.sessionFile,
      sessionId: event.sessionId,
    });
    queueRecordWrite();
  };

  try {
    await connectWithRetry(
      piSocketPath(agentDir),
      RPC_CONNECT_DEADLINE_MS,
      handleEvent,
    );
    signalReady(args.readyFd, { ok: true });
  } catch (error) {
    const message = `could not connect to pi socket: ${String(error)} (log: ${holderLogPath(agentDir)})`;
    console.error(`[holder] ${message}`);
    signalReady(args.readyFd, { ok: false, error: message });
    piProcess.kill("SIGKILL");
    cleanupAndExit(1);
  }
}
