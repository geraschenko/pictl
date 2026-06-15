/**
 * `pictl _hold` — the holder daemon. One per agent. It owns the PTY that pi
 * runs in, maintains detached screen state via @xterm/headless, and is the
 * sole writer of agent.json. It connects to its own pi.sock as a client to
 * track session replacements (never polling get_state per event).
 */

import { closeSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { numberParser } from "@stricli/core";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  getAgentDir,
  hasProjectTrustInputs,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import xterm from "@xterm/headless";
import pty from "node-pty";
import { cursorTo, cursorToRow, HIDE_CURSOR, SHOW_CURSOR } from "./ansi.ts";
import {
  commandNoTarget,
  restArgs,
  trueFlag,
  type CommandContext,
} from "./cli.ts";
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
import { fileExists } from "./util.ts";

const PTY_COLS = 80;
const PTY_ROWS = 24;
const RPC_CONNECT_DEADLINE_MS = 30_000;

interface HoldFlags {
  agentDir: string;
  agentId: string;
  cwd: string;
  piBin: string;
  resume?: true;
  tag?: string;
  readyFd?: number;
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

function ptyEnv(
  agentId: string,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.PI_AGENT_ID = agentId;
  return env;
}

/**
 * Whether the emulated terminal's cursor is currently hidden (DECTCEM). The
 * public `terminal.modes` API lacks DECTCEM; the internal core service is the
 * only place xterm tracks it. Guarded so an xterm internals change degrades
 * to "cursor visible", not a crash.
 */
function isCursorHidden(terminal: xterm.Terminal): boolean {
  const core = (
    terminal as unknown as {
      _core?: { coreService?: { isCursorHidden?: boolean } };
    }
  )._core;
  return core?.coreService?.isCursorHidden ?? false;
}

/**
 * Make the bottom row available for the attach client's hint line. When pi's
 * content reaches the bottom row, append a one-line scroll and re-park the
 * cursor one row higher, so pi's relative redraws stay aligned with the
 * scrolled content and the hint gets a row of its own below everything pi
 * drew. When the bottom row is already empty, the hint can use it as is.
 */
export function hintRoomSequence(terminal: xterm.Terminal): string {
  const buffer = terminal.buffer.active;
  const bottomLine = buffer.getLine(buffer.baseY + terminal.rows - 1);
  if (
    bottomLine === undefined ||
    bottomLine.translateToString().trim() === ""
  ) {
    return "";
  }
  // cursorY is 0-based relative to the visible screen, so as a 1-based row it
  // is cursorY + 1 before the scroll and cursorY after it.
  const parkedRow = Math.max(1, buffer.cursorY);
  const parkedCol = buffer.cursorX + 1;
  return `${cursorToRow(terminal.rows)}\n${cursorTo(parkedRow, parkedCol)}`;
}

function isSessionChangedEvent(
  event: SocketEvent,
): event is SocketEvent & SessionChangedEvent {
  return event.type === "session_changed";
}

/** pi flags that decide trust without prompting (`--approve`/`--no-approve`). */
const TRUST_OVERRIDE_FLAGS = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
]);

/**
 * Whether interactive pi would block on its "Trust project folder?" dialog in
 * this cwd — determined the same way pi does (`resolveProjectTrusted`), so a
 * spawn or revival that would otherwise hang until the connect deadline fails
 * fast instead. pi prompts only when the cwd has trust inputs, no trust flag
 * was passed, no decision is stored, and the global default is "ask"; any
 * other case proceeds (trusted or pi exits on its own) and is not our concern.
 */
export function projectTrustWouldBlock(cwd: string, piArgs: string[]): boolean {
  if (piArgs.some((arg) => TRUST_OVERRIDE_FLAGS.has(arg))) {
    return false;
  }
  if (!hasProjectTrustInputs(cwd)) {
    return false;
  }
  const agentDir = getAgentDir();
  if (new ProjectTrustStore(agentDir).get(cwd) !== null) {
    return false;
  }
  return (
    SettingsManager.create(cwd, agentDir).getDefaultProjectTrust() === "ask"
  );
}

export async function hold(
  this: CommandContext,
  flags: HoldFlags,
  ...piArgs: string[]
): Promise<void> {
  const args = { ...flags, resume: flags.resume === true, piArgs };
  const { agentDir, agentId } = args;
  const proc = this.process;

  const existing = await readAgentRecord(agentDir);
  const createdAt =
    existing.kind === "ok"
      ? existing.record.createdAt
      : new Date().toISOString();
  const sessions = existing.kind === "ok" ? existing.record.sessions : [];
  // First spawn carries --tag; revival preserves whatever was recorded.
  const tag = existing.kind === "ok" ? existing.record.tag : args.tag;

  // pi would sit on its interactive trust dialog forever in a headless PTY;
  // detect that deterministically and fail fast instead of hanging.
  if (projectTrustWouldBlock(args.cwd, args.piArgs)) {
    const message =
      `pi would block on the project-trust prompt in ${args.cwd}; ` +
      `pass --[no-]approve (pictl spawn -- --approve) or trust/distrust ` +
      `the directory once interactively by running pi there.`;
    proc.stderr.write(`[holder] ${message}\n`);
    signalReady(args.readyFd, { ok: false, error: message });
    return;
  }

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
      env: ptyEnv(agentId, this.env),
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
    // The serialize addon does not capture cursor visibility at all, so the
    // snapshot must append whichever sequence mirrors the emulator's current
    // state: pi normally runs cursor-hidden (omitting this would show a
    // phantom cursor), but if pi has the cursor visible at snapshot time, the
    // attacher must show it too.
    serializeScreen: () =>
      new Promise((resolve) => {
        terminal.write("", () =>
          resolve(
            serializeAddon.serialize() +
              hintRoomSequence(terminal) +
              (isCursorHidden(terminal) ? HIDE_CURSOR : SHOW_CURSOR),
          ),
        );
      }),
    writeInput: (data) => piProcess.write(data),
    // The emulator must track the PTY size or snapshots drift from what pi
    // is rendering. The size itself is computed by TtyServer (min across
    // attached clients).
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
    ...(tag !== undefined && { tag }),
    piBin: args.piBin,
    spawnArgs: args.piArgs,
    holderPid: proc.pid,
    piPid: piProcess.pid,
    sessions,
    agentDir,
  };
  await writeAgentRecord(record);

  // agent.json writes are serialized through this chain; session events can
  // arrive faster than a write completes.
  let writeQueue: Promise<void> = Promise.resolve();
  const queueRecordWrite = (): void => {
    writeQueue = writeQueue.then(
      () => writeAgentRecord(record),
      () => writeAgentRecord(record),
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
        proc.exit(code);
      });
  };

  piProcess.onExit(({ exitCode }) => {
    proc.stdout.write(`[holder] pi exited with code ${exitCode}\n`);
    cleanupAndExit(exitCode);
  });
  // Any termination request to the holder means "shut the agent down":
  // forward as SIGTERM so pi exits cleanly. Forwarding SIGINT verbatim would
  // be wrong — interactive pi treats it as "abort the current turn" and
  // keeps running, leaving a holder that was asked to die still alive.
  proc.on("SIGTERM", () => piProcess.kill("SIGTERM"));
  proc.on("SIGINT", () => piProcess.kill("SIGTERM"));

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
    const message =
      `could not connect to pi socket: ${String(error)} ` +
      `(log: ${holderLogPath(agentDir)})`;
    proc.stderr.write(`[holder] ${message}\n`);
    signalReady(args.readyFd, { ok: false, error: message });
    piProcess.kill("SIGKILL");
    cleanupAndExit(1);
  }
}

const holdCommand = commandNoTarget<HoldFlags, string[]>({
  docs: { brief: "internal holder daemon" },
  parameters: {
    flags: {
      agentDir: { kind: "parsed", parse: String, brief: "Agent dir" },
      agentId: { kind: "parsed", parse: String, brief: "Agent id" },
      cwd: { kind: "parsed", parse: String, brief: "Working directory" },
      piBin: { kind: "parsed", parse: String, brief: "pi binary" },
      resume: trueFlag("Resume"),
      tag: { kind: "parsed", parse: String, brief: "Tag", optional: true },
      readyFd: {
        kind: "parsed",
        parse: numberParser,
        brief: "Ready fd",
        optional: true,
      },
    },
    positional: restArgs("pi arguments", "pi-arg"),
  },
  func: hold,
});

export const internalRoutes = {
  _hold: holdCommand,
} as const;
