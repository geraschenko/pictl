# Daemon restructure: composition root + tty-service

Replaces `clauctl-daemon-architecture-lessons.md` (the provisional handoff
from clauctl's daemon-architecture refactor). What ported back is this
restructure; what didn't is recorded under Non-goals and Related work.

# SPEC

## Problem

`src/core/daemon.ts` mixes composition-root responsibilities (startup
classification, record ownership, lifecycle, signals) with ~50 lines of
inline tty/audit plumbing: TtyServer construction, the `auditAttachEvent`
closure, and the screen→server output wire. clauctl extracted exactly this
seam as `src/core/daemon/tty-service.ts`
(`../clauctl/src/core/daemon/tty-service.ts`); pictl and clauctl should stay
structurally aligned — same seam, same names — so future sharing stays cheap
and drift stays visible on inspection.

There is also a real defect in the current wiring: if `ttyServer.listen`
rejects (it can fail at its chmod step, after binding), the exception
escapes `daemon()` with pi left running, the server possibly bound, and no
cleanup.

## What we want

A `src/core/daemon/` directory mirroring clauctl's structure:

- `daemon.ts` — the composition root. Contains only: CLI entry (flags,
  command registration), startup classification, record ownership +
  serialized writes, pi's PTY lifecycle (spawn, signals, exit), module
  wiring, teardown.
- `tty-service.ts` — the tty.sock attach service: TtyServer construction,
  attach auditing, the screen→server output wire, socket listen, shutdown.
  daemon.ts imports neither `TtyServer` nor the audit event functions —
  its permitted "wiring" for this seam is constructing `TtyServiceOptions`
  (record-facing callbacks, the once-evaluated audit toggle) and holding
  the `TtyService` handle for teardown.

Deliberate divergence from clauctl: clauctl's service _owns_ its process
(TuiHost, a disposable view with crash-loop respawn ⇒ two-phase teardown).
In pictl, pi _is_ the agent — daemon.ts constructs `PtyScreen` early (the
record needs `piPid`; pi's exit drives daemon shutdown) — so the service
takes the screen as a caller-owned dependency and exposes only `shutdown`.

Shared files (`tty-server.ts`, `pty-screen.ts`, `audit.ts`, …) stay flat in
`src/core/`: clauctl's sync script reads them from there. `tty-service.ts`
is deliberately NOT shared — the per-repo differences (process ownership,
teardown shape) are semantic, and an injected screen abstraction just to
enable verbatim sync is not worth the indirection.

## Success criteria

- `src/core/daemon/daemon.ts` and `src/core/daemon/tty-service.ts` exist
  with the responsibilities above; `rg 'TtyServer|auditAttachEvent|recordAuditEvent|resolveCallerSourceForPid' src/core/daemon/daemon.ts`
  returns nothing.
- A rejected `startTtyService` leaves no accepting server behind and no way
  for attachment hooks to fire afterward (`TtyServer.shutdown` suppresses
  hooks synchronously); daemon.ts responds by killing pi and running its
  normal cleanup path (mirroring the pi-socket connect-failure path), which
  also removes the `tty.sock` file — socket-file removal stays daemon.ts's
  job, unchanged.
- Behavior is otherwise unchanged: same audit records, same
  attachment-record updates, same shutdown ordering (tty shutdown → clear
  attachments → drain write queue → remove sockets → exit).
- Each of the two modules carries a header comment stating its
  responsibility and why the seam is where it is.
- Importers updated: `app.ts` (the only production importer, for
  `internalRoutes`); `daemon.test.ts` moves alongside `daemon.ts`. A comment
  in `spawn.ts:108` references the daemon.ts path and gets updated.
- clauctl's sync surface: no file in the sync script's `SHARED_FILES` list
  moves; the one approved change is additive — `auditAttachEvent` moves into
  `audit.ts` (already shared) so clauctl can drop its identical copy on its
  next sync.
- `docs/specs/clauctl-daemon-architecture-lessons.md` is deleted; this spec
  replaces it.
- Presubmit green after every implementation step.

## Type design

```ts
// src/core/daemon/tty-service.ts
import { PtyScreen } from "../pty-screen.ts";
import { type AttachmentInfo } from "../tty-server.ts";

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
export function startTtyService(opts: TtyServiceOptions): Promise<TtyService>;
```

Internal to the service (not on the interface): the TtyServer hook wiring
and `piScreen.onData((data) => ttyServer.broadcastOutput(data))`. The audit
composition itself — resolve the caller source, record the event,
never-fatal with log-on-failure — is
`auditAttachEvent(agentDir, enabled, event, info, log)` in `audit.ts`
(shared; clauctl's tty-service carries an identical closure today and can
call this instead after a sync). The two adaptations from the old daemon.ts
closure: logging via the `log` callback instead of `proc.stdout.write`, and
the enablement check against a boolean evaluated once instead of
`auditEnabled(this.env)` per event.

In `daemon.ts`:

```ts
let ttyService: TtyService | undefined;
// cleanupAndExit: `await ttyService?.shutdown(...)` replaces
// `await ttyServer.shutdown(...)`; everything else unchanged.

try {
  ttyService = await startTtyService({
    agentDir,
    piScreen,
    auditEnabled: auditEnabled(this.env),
    onAttachmentsChanged: (attachments) => {
      record.attachments = attachments;
      queueRecordWrite();
    },
    log: (message) => proc.stdout.write(`[daemon] ${message}\n`),
  });
} catch (error) {
  failStartup(`could not bind tty socket: ${String(error)}`);
  piScreen.kill("SIGKILL");
  cleanupAndExit(1);
  return;
}
```

`cleanupAndExit` must therefore be defined before the `startTtyService`
call (it closes over `ttyService`, which may still be undefined — hence the
optional chaining).

## Edge cases

- **Listen rejection after binding**: TtyServer's `listen` chmods the socket
  after binding (`tty-server.ts:85,93`); the failure path must `shutdown`
  the already-bound server, not just rethrow (clauctl hit exactly this).
- **Attach during the bind→chmod window**: the socket accepts connections
  before `startTtyService` resolves, so a fast attacher can generate audit
  records and attachment-record writes before a startup failure. Accepted:
  audit records are append-only history, and the daemon's failure path runs
  `cleanupAndExit`, which clears the attachment list.
- **`recordAuditEvent` failures are never fatal**: logged via `opts.log`,
  otherwise ignored (unchanged behavior). This guarantee assumes the
  documented non-throwing callback contracts above.
- **auditEnabled per-event → once**: currently evaluated per attach event
  from `this.env`. Equivalence rests on the documented convention that the
  audit toggle is frozen at daemon start (auditing-and-attach-tracking.md),
  not on env immutability.
- **Shutdown finality**: `TtyService.shutdown` delegates to
  `TtyServer.shutdown`, which suppresses hooks synchronously, so the
  attachment-clear in `cleanupAndExit` remains final (no update can be
  enqueued after it).

## Non-goals

- No shared/synced `tty-service.ts` and no `TtyScreen` abstraction; the two
  repos keep name-and-shape parity only.
- No other behavior changes: startup classification, record writes, signal
  handling, pi-socket connection, and shutdown ordering are untouched.
- No new process-level tests for tty-service (clauctl shipped the same
  module without them; smoke coverage instead — see Test plan).
- No state-fold work: pi-side eventing and the `nextSessionState` fold are
  separate efforts (see Related work).
- `pi-socket-client.ts` and all `SHARED_FILES` stay in `src/core/`.

## Related work

- **State-as-shared-fold** (the other transferable finding from clauctl's
  refactor): derisked field-by-field in
  `docs/thoughts/passive-state-tracker.md` ("Derisking findings",
  2026-07-15); the pi-side work (missing events + the fold shipped in the pi
  package) is handed off in `../../earendil-works/pi/docs/handoff-rpc-state-fold.md`.
  A pictl client adoption spec should follow once pi ships both.
- **clauctl's spec**: `../clauctl/docs/specs/daemon-architecture.md` — the
  origin of the seam, the composition-root criterion, and the
  header-comment-rationale convention applied here.

# IMPLEMENTATION IDEAS

## Step ordering (each presubmit-green)

1. **Add** `src/core/daemon/tty-service.ts`, fully implemented, nothing
   importing it yet. Should be green as an independent step; if an
   unused-export lint fires, fold steps 1–2 into one change instead.
2. **Atomic cutover**: move `daemon.ts` + `daemon.test.ts` to
   `src/core/daemon/` (relative imports gain one `../`), replace the inline
   TtyServer/audit/onData wiring with `startTtyService`, add the
   listen-failure catch, hoist `cleanupAndExit` above the call, update
   `app.ts` and the `spawn.ts:108` comment.
3. Docs: delete `clauctl-daemon-architecture-lessons.md`; update
   `auditing-and-attach-tracking.md` (it states that `src/core/daemon.ts`
   implements the attach hooks — retarget to `tty-service.ts`, plus the
   frozen-at-start `auditEnabled` wording if needed); leave historical
   phase/feature specs' `daemon.ts` references untouched.

## Notes

- Wiring order today: PtyScreen → record → writeQueue/audit/ttyServer →
  `writeAgentRecord` → rm spawn-options → `listen` → `cleanupAndExit` def →
  `onExit`/signals → pi-socket connect. The cutover keeps this order except
  `cleanupAndExit` moves before the tty start (see Type design).
  Pre-existing defect, out of scope: `PtyScreen.onExit` does not replay an
  exit that fired before the listener was registered (`pty-screen.ts:102`),
  so a pi exit during the listen await is lost, and cleanup happens only via
  a later failure (typically the 30s pi-socket connect deadline).
- The spec-process lessons from the clauctl refactor (transition tables in
  specs, presubmit-green step ordering, reviewer critic loop primed with the
  codebase-design skill) are process, not code; they're embodied in this
  spec rather than re-documented.

## Test plan

- Existing `daemon.test.ts` (`projectTrustWouldBlock`) moves and passes
  unchanged.
- Smoke after step 2: spawn → attach (renders pi's screen: serialize +
  resize wires) → type into pi and observe the echo (input + output wires)
  → detach → SIGTERM; verify attach/detach audit records and
  attachment-list updates in agent.json; verify a clean shutdown clears
  attachments. This covers ordinary wiring end-to-end.
- Listen-failure path: **code-reviewed only, honestly stated** — the
  post-bind (chmod) failure cannot be provoked from outside without an
  injectable listen fake, and a pre-bind failure (e.g. a directory at the
  socket path) exercises a different branch. Automating it means an
  injection seam in TtyServer or the service — declined as a scope change,
  same call clauctl made (its tty-service failure cleanup is also untested;
  documented gap there too).
- No fake-screen interface tests for the service: `piScreen` is typed as the
  concrete `PtyScreen` (private state, no unsubscribe), so a fake needs
  either the rejected screen abstraction or a real PTY harness; TtyServer's
  hook mechanics are already covered by `tty-server.test.ts`, and the
  service's wiring is covered by the smoke above. Known gap, accepted.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Derisk (2026-07-16): three questions resolved — adopt the
      listen-failure cleanup (behavior change, in scope); this spec replaces
      the lessons doc entirely; `onData` wiring lives inside the service.
      Type design approved.
- [x] Reviewer round 1 (pictl reviewer 8db8ea8e): adopted — accurate screen
      contract ("untouched" was false: the service claims the single onData
      slot, no unsubscribe exists); non-throwing/no-reentry callback
      contracts on TtyServiceOptions; hooks-may-fire-before-resolve
      (bind→chmod window) documented with the partial-startup side-effect
      policy; error policy (original listen error rethrown even if cleanup
      fails); corrected the startup-order note (PtyScreen.onExit loses, not
      delays, a pre-registration exit); explicit docs list for step 3
      (auditing-and-attach-tracking.md names daemon.ts as the hook
      implementer); strengthened failed-start criterion (no accepting
      server, hooks silenced, socket file removed by daemon cleanup);
      honest test claims for the listen-failure path. Declined — injectable
      listen seam and fake-screen interface tests (scope changes; same gaps
      clauctl documented; smoke covers ordinary wiring).
- [x] Reviewer round 2: smoke steps expanded to actually exercise the
      claimed wires (attach/serialize/resize, typed input/echo). Approved,
      no remaining spec blockers.
- [x] Step 1 (2026-07-16): added `src/core/daemon/tty-service.ts`, fully
      implemented, nothing importing it. No unused-export lint fired;
      presubmit green.
- [x] Step 2 (2026-07-16): atomic cutover. `git mv`ed `daemon.ts` +
      `daemon.test.ts` into `src/core/daemon/`, relative imports gained one
      `../`; inline TtyServer/audit/onData wiring replaced by
      `startTtyService` in a try/catch (failure path: `failStartup` +
      SIGKILL pi + `cleanupAndExit(1)`); `cleanupAndExit` hoisted above the
      tty start, `ttyService?.shutdown` via optional chaining; composition
      root header comment added; `app.ts` import and `spawn.ts` comment
      updated. The success-criteria `rg` is clean and presubmit green.
- [x] Smoke (2026-07-16, scripted PTY driver): spawn from source → attach
      (snapshot rendered, hint shown) → typed a marker into pi and saw the
      echo → detach → re-attach → SIGTERM the daemon. Verified: attach/detach
      audit records with daemon-computed source; `attachments` in agent.json
      populated (with size) while attached, `[]` after shutdown; exit frame
      ("agent exited: pi exited (code 0)") delivered to the attached client;
      both socket files removed.
- [x] Step 3 (2026-07-16): deleted
      `clauctl-daemon-architecture-lessons.md`; auditing-and-attach-tracking
      retargeted (hook implementer is now `daemon/tty-service.ts`,
      once-evaluated audit toggle tied to the frozen-at-spawn edge case,
      `PICTL_ID` ref updated to `ptyEnv` in `daemon/daemon.ts`); historical
      work-log/spec references left as-is.
- [x] Post-review amendment (2026-07-16, user-approved): `auditAttachEvent`
      moved from a tty-service closure to an exported function in `audit.ts`
      — it is audit-domain logic (source resolution + record + never-fatal
      policy) duplicated verbatim in clauctl's tty-service, and `audit.ts`
      is in `SHARED_FILES`, so clauctl can adopt it on its next sync. Takes
      `AttachmentInfo` (type-only import from tty-server.ts, itself shared;
      same precedent as registry.ts) and the once-evaluated `enabled`
      boolean, so callers cannot forget the toggle check. Spec's sync-surface
      criterion and type-design section amended accordingly.

## Implementation-Time Decisions

- **daemon.ts header avoids the audited identifier names**: the
  success-criteria `rg` for `TtyServer` etc. is meant to prove no wiring
  leaked back in, so the composition-root header says "attach server"
  instead of naming the class — keeping the criterion checkable as written.
- **Smoke-driver gotcha, recorded for future smokes**: a client attaching
  from a 0×0 PTY (python `pty.fork()` default) is dropped immediately —
  its initial resize frame makes `piScreen.resize(0, 0)` throw, and
  TtyServer's frame handler drops the client on hook exceptions. Setting
  TIOCSWINSZ before attaching fixes the driver; not a regression (same
  hook path as before the restructure).
