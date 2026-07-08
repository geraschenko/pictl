# Handoff: pictl changes from clauctl Phase-1 review

Context: clauctl (`~/git/geraschenko/clauctl`) is a copy-and-diverge sibling of
pictl (`~/git/geraschenko/pictl`). During review of clauctl's Phase-1
implementation, two design improvements were agreed that apply to both tools.
pictl implements them first; clauctl will then be changed to match pictl's
final shapes as closely as possible — so prefer generic naming/structure over
pi-specific shortcuts, and report the final signatures back when done.

**Update (2026-07-04): Change 2 is dropped for pictl.** It assumed the pictl
daemon serves the RPC socket, as clauctl's daemon serves sdk.sock. In pictl,
pi.sock is bound by pi itself (`pi --rpc-socket`); the daemon is just another
client and holds no idle-state model. The pictl analog would be a `wait_idle`
request in pi's own RPC protocol (a change to the pi repo), out of scope here.
Only Change 1 proceeds.

## Change 1 — derive the daemon's parameters instead of passing them

`launchDaemon` currently re-execs the binary as:

```
_daemon --agent-dir <dir> --agent-id <id> --cwd <cwd> --pi-bin <bin>
        --ready-fd 3 [--tag <tag>] [--resume] -- <piArgs...>
```

Most of this argv is derivable and should not be passed
(`src/core/spawn.ts:36` `DaemonLaunch`, `src/core/spawn.ts:116` `daemonArgs`,
and the `_daemon` flag table in `daemon.ts`):

- `--agent-dir` is `agentDirPath(agentId)` — the daemon inherits `PICTL_DIR`
  from its parent, so it derives the same path itself.
- `--resume` is derivable from disk state (see the handoff-file scheme below):
  a transient spawn file present → initial spawn; otherwise `agent.json`
  present → revival; otherwise fail startup.
- `--cwd`, `--pi-bin`, `--tag`, and `<piArgs...>` are spawn-time configuration:
  move them into a **transient spawn file** (e.g. `spawn-options.json` in the
  agent dir) that `spawn` writes before launching the daemon and the daemon
  reads, folds into the `agent.json` it writes, then deletes. This preserves
  "the daemon is the sole `agent.json` writer". On revival the daemon reads
  the same values back from `agent.json` (as it does today).

Target argv: `_daemon --agent-id <id> --ready-fd 3`. `DaemonLaunch` shrinks to
`{ agentId, spawn-file contents already on disk }` — shape at your discretion,
but nothing that can be derived may be a parameter.

clauctl reference: `src/core/registry.ts` (`spawnOptionsPath`),
`src/core/spawn.ts`, `src/core/daemon.ts` (startup section) already implement
the spawn-file handoff (clauctl still passes `--agent-dir`/`--cwd`/`--tag`/
`--resume` redundantly; it will drop them to mirror whatever pictl lands).

## Change 2 — `wait_idle` as a daemon-side RPC

pictl's client-side `waitIdle` (`src/core/pi-socket-client.ts:245`) loops:
register an `agent_end` watcher, call `get_state`, re-check on each turn end.
Replace it with a daemon-side request:

- Add a `wait_idle` request to the pi-socket protocol. The daemon resolves the
  response when its own state model says fully idle (`!isStreaming &&
  pendingMessageCount === 0`), immediately if already idle. The daemon already
  maintains this state; nothing is sent to the pi process.
- The client's `waitIdle(client, timeoutMs)` becomes: send `wait_idle`, race
  against a locally-enforced timeout (clear the timer after the race — a
  pending timer keeps the CLI's event loop alive), throw `IdleTimeoutError`
  on timeout. Signature and call sites (`lifecycle.ts`, `until.ts`) keep their
  behavior.
- Keep `get_state` — other callers use it for inspection.

Rationale: the daemon holds the authoritative state, so a blocking request is
race-free and removes the get-state/event-watch reconstruction from the
client. clauctl already works this way (`wait-idle` in
`src/core/sdk-socket.ts` and the daemon's `whenIdle`).

## Note — pictl's copies of the shared files are canonical

clauctl now generates `src/core/generated/{cli,completion,targets,util,
version}.ts` from pictl's `src/core/` copies via a sync script
(pictl→clauctl rename, import-path rewrite, DO-NOT-MODIFY header). Treat
pictl's copies as the single source of truth: improvements to these five files
belong in pictl, and they should stay free of anything that would not survive
a mechanical `pictl→clauctl` rename.

## Constraints

- No sleeps in production or test code (event/promise-based waiting only).
- Small, coherent commits; run pictl's presubmit after each.
- When done, reply with the final `DaemonLaunch`/`_daemon` argv shape and the
  `wait_idle` request/response record shapes so clauctl can mirror them.
