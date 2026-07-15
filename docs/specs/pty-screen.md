# PtyScreen — factor the pty + emulator mirror out of daemon.ts

# SPEC

## Problem statement

daemon.ts contains ~50 lines of subtle-invariant code that is not
pictl-specific: spawning a process in a pty, mirroring its output into a
headless xterm, and serializing the screen for tty.sock snapshots (parse
barrier, hint-row reservation, cursor-visibility repair). clauctl is about
to need exactly this code for its daemon-hosted `_tui` renderer, and clauctl
syncs its shared files verbatim from `pictl/src/core/` (the canonical
copies) via its `scripts/sync-from-pictl.mjs`. Today that code can't sync
because it is inlined in pictl's daemon.

Extract it into a new shareable module, `src/core/pty-screen.ts`, and
refactor daemon.ts to use it. **Pure refactor: no behavior change.**

## Success criteria

- `src/core/pty-screen.ts` exists, contains the PtyScreen class plus the
  moved helpers, and — like tty-protocol.ts and ansi.ts — is free of
  pictl-specific imports (it may import `./pty.ts` and `./ansi.ts`, which
  are themselves in clauctl's shared set; it must not import registry,
  lifecycle, tty-server, etc.).
- daemon.ts no longer touches node-pty or @xterm directly; it constructs a
  PtyScreen for pi and wires it to TtyServer.
- All existing tests pass unchanged in behavior; the `hintRoomSequence`
  tests move with the function (daemon.test.ts → pty-screen.test.ts).
- Attach behavior is byte-identical: snapshot ordering (barrier), hint-row
  logic, cursor visibility, min-size resize, SIGTERM forwarding.

## Type design

```ts
// src/core/pty-screen.ts

/**
 * A process running in a pty, mirrored into a headless xterm so the screen
 * can be serialized for tty.sock snapshots. Survives process exit: the
 * emulator (and serializeScreen) remain valid after the process dies, so
 * the last screen — including any crash output — stays snapshotable.
 */
export class PtyScreen {
  constructor(
    file: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
  );
  readonly pid: number;
  write(data: string): void;                 // → pty input
  resize(cols: number, rows: number): void;  // → pty and emulator, together
  /**
   * Serialize the current screen: parse barrier + SerializeAddon +
   * hintRoomSequence + cursor-visibility suffix. Satisfies the ordering
   * contract of TtyServerHooks.serializeScreen.
   */
  serializeScreen(): Promise<string>;
  /** Output listener; fires after the bytes are enqueued into the emulator
   *  (xterm parses asynchronously — do NOT wait for parse completion), so a
   *  parse barrier issued after the callback includes them (the ordering the
   *  TtyServer buffering contract depends on). */
  onData(callback: (data: string) => void): void;
  onExit(callback: (exitCode: number) => void): void;
  kill(signal?: string): void;
}

/** Moved from daemon.ts unchanged (with its design-note comment). */
export function hintRoomSequence(terminal: xterm.Terminal): string;
```

Moves into pty-screen.ts (module-private): `PTY_COLS = 80`,
`PTY_ROWS = 24`, `isCursorHidden`. The constructor is today's daemon.ts
code: `spawnPty(file, args, { name: "xterm-256color", cols, rows, cwd,
env })` + `new xterm.Terminal({ cols, rows, allowProposedApi: true })` +
`SerializeAddon`, with the pty's onData writing to the emulator before
notifying `onData` listeners.

daemon.ts after the refactor:

```ts
const piScreen = new PtyScreen(
  options.piBin,
  ["--rpc-socket", piSocketPath(agentDir), ...sessionArgs, ...options.spawnArgs],
  { cwd: options.cwd, env: ptyEnv(agentId, this.env) },
);
// record.piPid = piScreen.pid
// TtyServer hooks: serializeScreen/writeInput/resize delegate to piScreen
// piScreen.onData((data) => ttyServer.broadcastOutput(data))
// piScreen.onExit(({...}) => ... cleanupAndExit as today)
// signal forwarding: piScreen.kill("SIGTERM")
```

`ptyEnv` stays in daemon.ts — the env content (PICTL_ID,
PI_SKIP_VERSION_CHECK) is pi policy, not pty mechanics.

## Edge cases / invariants to preserve

- **Parse-barrier placement**: serialization must happen inside the
  `terminal.write("")` callback, not in a `.then()` after it — xterm may
  parse further queued chunks before a microtask runs. Keep the existing
  comment.
- **onData ordering**: emulator write happens before listener notification
  (today: `terminal.write(data)` then `ttyServer.broadcastOutput(data)`).
  Reversing it breaks snapshot exactness under heavy streaming. Note
  `terminal.write(data)` only _enqueues_ — the listener must be notified
  immediately after, not from a write-completion callback; deferring the
  broadcast until parse completion would change output timing.
- **Nothing tears down the emulator on exit** — see the class doc.
- **node-pty onExit payload** is `{ exitCode, signal }`; the class exposes
  just `exitCode` (all daemon.ts uses today).

## Non-goals

- Any behavior change, however small.
- Restart/respawn logic (that is clauctl's TuiHost, built on top of this).
- Changing TtyServer or the tty protocol.

## Open question (deferred, no action here)

serializeScreen bakes in hintRoomSequence, which the design-note comment in
the code identifies as attach-client policy rather than snapshot mechanics.
Both current consumers (pictl attach, clauctl's `_tui`) use a hint row, so
hardcoding it is fine today, but a future consumer without a hint line would
need it made optional (a serializeScreen parameter, or per-client in the tty
protocol). Revisit when such a consumer appears.

# IMPLEMENTATION IDEAS

- This is mostly a cut-and-paste refactor; the design risk is losing one of
  the ordering invariants above. Move the comments along with the code —
  they document non-obvious constraints (barrier, hint-row policy note,
  isCursorHidden's internal-API guard).
- `hintRoomSequence` stays exported (its tests exercise it directly).
  daemon.test.ts's `hintRoomSequence` tests move to pty-screen.test.ts
  verbatim; `projectTrustWouldBlock` tests stay in daemon.test.ts.
- Downstream (context, no action here): clauctl adds `pty-screen.ts` and
  `pty-screen.test.ts` to its SHARED_FILES and syncs them.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [x] Create src/core/pty-screen.ts (PtyScreen, hintRoomSequence,
      isCursorHidden, PTY_COLS/ROWS moved from daemon.ts)
- [x] Refactor daemon.ts to construct/wire PtyScreen
- [x] Move hintRoomSequence tests → pty-screen.test.ts
- [x] Presubmit green (86 tests pass)

## Implementation-Time Decisions

- **Underlying pty handlers are registered in the constructor**, with the
  daemon's callbacks stored as single-listener fields (`dataListener` /
  `exitListener`) that the pty handlers forward to. This makes the
  emulator-write-before-notify ordering structural (a listener can never be
  called before the emulator write) instead of depending on the caller's
  handler body. Equivalence with the old code: no await separates PtyScreen
  construction from the daemon's onData registration, so no pty data can
  arrive in the gap; an exit during the awaits before onExit registration was
  dropped by node-pty before (no handler attached yet) and is dropped by the
  undefined-listener check now.
- **The moved comments keep their pi-specific wording** (hintRoomSequence,
  cursor-visibility rationale, resize drift note) per the "moved unchanged"
  instruction, even though the module is generic. Genericizing them is left
  for whenever the hint-row open question is revisited.
- **The size-comment split**: "emulator must track the PTY size" moved onto
  PtyScreen.resize (it's pty-screen mechanics); "size computed by TtyServer
  (min across clients)" stayed on the daemon's resize hook (it's wiring
  context).
- **treefmt reformatted three untouched files** (rust-client.md,
  passive-state-tracker.md, pictl-rs/Cargo.toml) — pre-existing formatter
  drift, included so presubmit's --fail-on-change passes.
