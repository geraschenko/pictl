/**
 * `pictl _daemon` — the per-agent daemon. One per agent. It owns the PTY that pi
 * runs in, maintains detached screen state via @xterm/headless, and is the
 * sole writer of agent.json. It connects to its own pi.sock as a client to
 * track session replacements.
 */

import { closeSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { numberParser } from "@stricli/core";
import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@geraschenko/pi-coding-agent";
import {
  commandNoTarget,
  parsedFlag,
  requiredStringFlag,
  type InferFlags,
} from "./cli.ts";
import { type CommandContext } from "./targets.ts";
import {
  type AgentRecord,
  agentDirPath,
  daemonLogPath,
  piSocketPath,
  readAgentRecord,
  readSpawnOptions,
  type SessionHistoryEntry,
  type SpawnOptions,
  spawnOptionsPath,
  ttySocketPath,
  writeAgentRecord,
} from "./registry.ts";
import {
  auditEnabled,
  recordAuditEvent,
  resolveCallerSourceForPid,
} from "./audit.ts";
import { connectWithRetry, type SocketEvent } from "./pi-socket-client.ts";
import { PtyScreen } from "./pty-screen.ts";
import { TtyServer, type AttachmentInfo } from "./tty-server.ts";
import { fileExists } from "./util.ts";

const RPC_CONNECT_DEADLINE_MS = 30_000;

const daemonFlags = {
  agentId: requiredStringFlag("Agent id", "uuid"),
  readyFd: parsedFlag("Ready fd", numberParser, "int"),
};

type DaemonFlags = InferFlags<typeof daemonFlags>;

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
    // Spawner already gone; the daemon runs on regardless.
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
  env.PICTL_ID = agentId;
  // pictl pins pi to its bundled dependency, so pi's self-update check only
  // ever reports an update the user cannot act on. Suppress just that check
  // (narrower than PI_OFFLINE, which would also disable extension-update
  // checks and telemetry).
  env.PI_SKIP_VERSION_CHECK = "1";
  return env;
}

/**
 * The one socket event whose payload the daemon reads structurally (to track
 * session rotation below). Every other event is forwarded opaquely as a bare
 * SocketEvent, so only this one earns a typed shape, narrowed via the guard.
 */
interface SessionChangedEvent {
  type: "session_changed";
  sessionFile?: string;
  sessionId: string;
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
  if (!hasTrustRequiringProjectResources(cwd)) {
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

async function daemon(this: CommandContext, flags: DaemonFlags): Promise<void> {
  const { agentId } = flags;
  const agentDir = agentDirPath(agentId);
  // _daemon is a Node daemon and needs pid/signals/exit; Stricli's process type
  // intentionally only models portable stdio, so use Node's process here.
  const proc = this.process as NodeJS.Process;

  const failStartup = (message: string): void => {
    proc.stderr.write(`[daemon] ${message}\n`);
    signalReady(flags.readyFd, { ok: false, error: message });
  };

  // Classify the launch from disk state: an agent.json means revival (config
  // read back from it, including any stale spawn-options.json left by a
  // daemon that died mid-handoff); otherwise a spawn-options.json means
  // initial spawn. See docs/specs/daemon-derived-args.md.
  const existing = await readAgentRecord(agentDir);
  const spawnFile = await readSpawnOptions(agentDir);
  let resume: boolean;
  let options: SpawnOptions;
  let createdAt: string;
  let sessions: SessionHistoryEntry[];
  if (existing.kind === "ok") {
    resume = true;
    const record = existing.record;
    options = {
      cwd: record.cwd,
      piBin: record.piBin,
      spawnArgs: record.spawnArgs,
      ...(record.tag !== undefined && { tag: record.tag }),
    };
    createdAt = record.createdAt;
    sessions = record.sessions;
  } else if (existing.kind === "corrupt") {
    failStartup(`cannot classify launch: ${existing.error}`);
    return;
  } else if (spawnFile.kind === "ok") {
    resume = false;
    options = spawnFile.options;
    createdAt = new Date().toISOString();
    sessions = [];
  } else {
    failStartup(
      spawnFile.kind === "corrupt"
        ? `cannot classify launch: ${spawnFile.error}`
        : `neither agent.json nor spawn-options.json in ${agentDir} ` +
            `(_daemon is internal; use pictl spawn)`,
    );
    return;
  }

  // pi would sit on its interactive trust dialog forever in a headless PTY;
  // detect that deterministically and fail fast instead of hanging.
  if (projectTrustWouldBlock(options.cwd, options.spawnArgs)) {
    const message =
      `pi would block on the project-trust prompt in ${options.cwd}; ` +
      `pass --[no-]approve (pictl spawn -- --approve) or trust/distrust ` +
      `the directory once interactively by running pi there.`;
    failStartup(message);
    return;
  }

  // A SIGKILLed predecessor leaves stale socket files behind, and pi refuses
  // to bind an existing path. Launchers guarantee no live daemon for this dir.
  await Promise.all([
    rm(piSocketPath(agentDir), { force: true }),
    rm(ttySocketPath(agentDir), { force: true }),
  ]);

  const sessionArgs = resume ? await revivalSessionArgs(sessions) : [];
  const piScreen = new PtyScreen(
    options.piBin,
    [
      "--rpc-socket",
      piSocketPath(agentDir),
      ...sessionArgs,
      ...options.spawnArgs,
    ],
    { cwd: options.cwd, env: ptyEnv(agentId, this.env) },
  );

  const record: AgentRecord = {
    id: agentId,
    createdAt,
    cwd: options.cwd,
    ...(options.tag !== undefined && { tag: options.tag }),
    piBin: options.piBin,
    spawnArgs: options.spawnArgs,
    daemonPid: proc.pid,
    piPid: piScreen.pid,
    sessions,
    attachments: [],
    agentDir,
  };

  // agent.json writes are serialized through this chain; session and
  // attachment events can arrive faster than a write completes.
  let writeQueue: Promise<void> = Promise.resolve();
  const queueRecordWrite = (): void => {
    writeQueue = writeQueue.then(
      () => writeAgentRecord(record),
      () => writeAgentRecord(record),
    );
  };

  // Attach auditing never kills the daemon: failures are logged (stdout goes
  // to daemon.log) and otherwise ignored.
  const auditAttachEvent = (
    event: "attach" | "detach",
    info: AttachmentInfo,
  ): void => {
    if (!auditEnabled(this.env)) {
      return;
    }
    const { source, manager } = resolveCallerSourceForPid(info.pid);
    const auditRecord = {
      ts: new Date().toISOString(),
      source,
      event,
      pid: info.pid,
    };
    void recordAuditEvent(agentDir, auditRecord, manager).catch((error) =>
      proc.stdout.write(`[daemon] ${event} audit failed: ${String(error)}\n`),
    );
  };

  const ttyServer = new TtyServer({
    serializeScreen: () => piScreen.serializeScreen(),
    writeInput: (data) => piScreen.write(data),
    // The size itself is computed by TtyServer (min across attached clients).
    resize: (cols, rows) => piScreen.resize(cols, rows),
    onAttach: (info) => auditAttachEvent("attach", info),
    onDetach: (info) => auditAttachEvent("detach", info),
    onAttachmentsChanged: (attachments) => {
      record.attachments = attachments;
      queueRecordWrite();
    },
  });

  piScreen.onData((data) => ttyServer.broadcastOutput(data));

  await writeAgentRecord(record);
  // The handoff is complete once the options are in agent.json; force also
  // covers revival, where any spawn file present is a stale leftover.
  await rm(spawnOptionsPath(agentDir), { force: true });

  await ttyServer.listen(ttySocketPath(agentDir));

  let exiting = false;
  const cleanupAndExit = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    void (async () => {
      // shutdown() suppresses tty hooks synchronously, so no attachment
      // updates can be enqueued after this point; the clear below is final.
      await ttyServer.shutdown(`pi exited (code ${code})`);
      // Clean shutdown clears the attachment list; a crash leaves stale
      // entries, which readers must ignore for non-running agents. Queued
      // (not written directly) so it serializes behind in-flight writes.
      record.attachments = [];
      queueRecordWrite();
      await writeQueue.catch(() => undefined);
      await Promise.all([
        rm(piSocketPath(agentDir), { force: true }),
        rm(ttySocketPath(agentDir), { force: true }),
      ]);
      proc.exit(code);
    })();
  };

  piScreen.onExit((exitCode) => {
    proc.stdout.write(`[daemon] pi exited with code ${exitCode}\n`);
    cleanupAndExit(exitCode);
  });
  // Any termination request to the daemon means "shut the agent down":
  // forward as SIGTERM so pi exits cleanly. Forwarding SIGINT verbatim would
  // be wrong — interactive pi treats it as "abort the current turn" and
  // keeps running, leaving a daemon that was asked to die still alive.
  proc.on("SIGTERM", () => piScreen.kill("SIGTERM"));
  proc.on("SIGINT", () => piScreen.kill("SIGTERM"));

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
    signalReady(flags.readyFd, { ok: true });
  } catch (error) {
    failStartup(
      `could not connect to pi socket: ${String(error)} ` +
        `(log: ${daemonLogPath(agentDir)})`,
    );
    piScreen.kill("SIGKILL");
    cleanupAndExit(1);
  }
}

const daemonCommand = commandNoTarget<DaemonFlags>({
  docs: { brief: "Internal command to launch a single-agent pi daemon" },
  parameters: { flags: daemonFlags },
  func: daemon,
});

export const internalRoutes = {
  _daemon: daemonCommand,
} as const;
