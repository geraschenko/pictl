/**
 * PtyScreen: a process in a pty mirrored into a headless xterm, plus the
 * screen-serialization helpers a daemon needs for tty.sock snapshots.
 */

import { SerializeAddon } from "@xterm/addon-serialize";
import xterm from "@xterm/headless";
import type { IPty } from "node-pty";
import { HIDE_CURSOR, SHOW_CURSOR } from "./ansi.ts";
import { spawnPty } from "./pty.ts";

const PTY_COLS = 80;
const PTY_ROWS = 24;

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
 * A process running in a pty, mirrored into a headless xterm so the screen
 * can be serialized for tty.sock snapshots. Survives process exit: the
 * emulator (and serializeScreen) remain valid after the process dies, so
 * the last screen — including any crash output — stays snapshotable.
 */
export class PtyScreen {
  private readonly process: IPty;
  private readonly terminal: xterm.Terminal;
  private readonly serializeAddon: SerializeAddon;
  private dataListener: ((data: string) => void) | undefined;
  private exitListener: ((exitCode: number) => void) | undefined;

  constructor(
    file: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
  ) {
    this.process = spawnPty(file, args, {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: opts.cwd,
      env: opts.env,
    });
    // allowProposedApi is required by the serialize addon.
    this.terminal = new xterm.Terminal({
      cols: PTY_COLS,
      rows: PTY_ROWS,
      allowProposedApi: true,
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);
    // The emulator write must precede listener notification: terminal.write
    // only enqueues (xterm parses asynchronously), and serializeScreen's
    // parse barrier includes exactly the output enqueued before it. A
    // listener that broadcasts and then snapshots relies on this order;
    // reversing it duplicates or drops bytes on attach under heavy streaming.
    this.process.onData((data) => {
      this.terminal.write(data);
      this.dataListener?.(data);
    });
    this.process.onExit(({ exitCode }) => this.exitListener?.(exitCode));
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  /** The emulator must track the PTY size or snapshots drift from what pi
   *  is rendering. */
  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
    this.terminal.resize(cols, rows);
  }

  /**
   * Serialize the current screen. Satisfies the ordering contract of
   * TtyServerHooks.serializeScreen: terminal.write("") is the parse barrier;
   * serializing inside its callback (not in a then() after it) keeps the
   * snapshot exactly at the barrier — xterm may parse further queued chunks
   * before a microtask runs. The serialize addon does not capture cursor
   * visibility at all, so the snapshot must append whichever sequence mirrors
   * the emulator's current state: pi normally runs cursor-hidden (omitting
   * this would show a phantom cursor), but if pi has the cursor visible at
   * snapshot time, the attacher must show it too. Preserve row coordinates:
   * pi's subsequent absolute-addressed redraws must target the same content.
   */
  serializeScreen(): Promise<string> {
    return new Promise((resolve) => {
      this.terminal.write("", () =>
        resolve(
          this.serializeAddon.serialize() +
            (isCursorHidden(this.terminal) ? HIDE_CURSOR : SHOW_CURSOR),
        ),
      );
    });
  }

  /** Output listener (single): fires after the bytes are enqueued into the
   *  emulator, so a parse barrier issued after the callback includes them. */
  onData(callback: (data: string) => void): void {
    this.dataListener = callback;
  }

  /** Exit listener (single). The emulator stays valid after exit. */
  onExit(callback: (exitCode: number) => void): void {
    this.exitListener = callback;
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }
}
