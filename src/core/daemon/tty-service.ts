/**
 * The tty.sock attach service: the TtyServer bound to pi's screen, with
 * attach auditing (the shared auditAttachEvent in audit.ts) hanging off the
 * attach/detach hooks. Every TtyServer hook targets the screen or the audit
 * trail, so this wiring lives together as one unit; daemon.ts sees only
 * start, shutdown, and the record-facing attachment callback it can persist.
 * Unlike clauctl's twin, the screen is caller-owned — pi is the agent
 * itself, not a disposable view — so there is no process lifecycle here and
 * teardown is single-phase.
 */

import { auditAttachEvent } from "../audit.ts";
import { PtyScreen } from "../pty-screen.ts";
import { ttySocketPath } from "../registry.ts";
import { TtyServer, type AttachmentInfo } from "../tty-server.ts";

export interface TtyServiceOptions {
  agentDir: string;
  /** Caller-owned: daemon.ts creates pi's PTY (the record needs piPid, and
   *  pi's exit drives daemon shutdown) and keeps its lifecycle. The service
   *  wires the screen's output, input, resize, and serialize to tty.sock,
   *  claiming the screen's single onData listener slot. */
  piScreen: PtyScreen;
  /** Evaluated once by daemon.ts (the audit toggle is frozen at daemon
   *  start by convention; see auditing-and-attach-tracking.md). */
  auditEnabled: boolean;
  /** Must not throw and must not re-enter shutdown — TtyServer invokes its
   *  hooks synchronously and unguarded. May fire before startTtyService
   *  resolves: the socket accepts connections between bind and chmod. */
  onAttachmentsChanged(attachments: AttachmentInfo[]): void;
  /** Must not throw (called from the audit failure path). */
  log(message: string): void;
}

export interface TtyService {
  /** Exit frames to attachers + close. Suppresses attachment hooks
   *  synchronously: no onAttachmentsChanged fires after this is called. */
  shutdown(reason: string): Promise<void>;
}

/**
 * Bind tty.sock for the given screen. If listen rejects (it can fail at its
 * chmod step, after binding), the server is shut down — best-effort, and the
 * original listen error is rethrown even if that cleanup also fails — so a
 * rejected startTtyService leaves no accepting server, and the caller needs
 * no handle to clean up with. The service does not kill or dispose the
 * caller-owned screen; its onData listener remains installed after failure
 * or shutdown (PtyScreen has no unsubscribe), which is harmless — the
 * screen's lifetime ends with the daemon's.
 */
export async function startTtyService(
  opts: TtyServiceOptions,
): Promise<TtyService> {
  const ttyServer = new TtyServer({
    serializeScreen: () => opts.piScreen.serializeScreen(),
    writeInput: (data) => opts.piScreen.write(data),
    // The size itself is computed by TtyServer (min across attached clients).
    resize: (cols, rows) => opts.piScreen.resize(cols, rows),
    onAttach: (info) =>
      auditAttachEvent(
        opts.agentDir,
        opts.auditEnabled,
        "attach",
        info,
        opts.log,
      ),
    onDetach: (info) =>
      auditAttachEvent(
        opts.agentDir,
        opts.auditEnabled,
        "detach",
        info,
        opts.log,
      ),
    onAttachmentsChanged: opts.onAttachmentsChanged,
  });

  opts.piScreen.onData((data) => ttyServer.broadcastOutput(data));

  try {
    await ttyServer.listen(ttySocketPath(opts.agentDir));
  } catch (error) {
    // listen can reject after binding (its chmod step), so the already-bound
    // server must be shut down, not just the error rethrown.
    try {
      await ttyServer.shutdown("tty service failed to start");
    } catch {
      // Best-effort; the listen error below is the one that matters.
    }
    throw error;
  }

  return {
    shutdown: (reason) => ttyServer.shutdown(reason),
  };
}
