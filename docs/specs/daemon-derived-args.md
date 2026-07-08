# Spec: derive the daemon's parameters instead of passing them

Origin: Change 1 of docs/specs/daemon-args-and-wait-idle.md (handoff from the
clauctl Phase-1 review). Change 2 of that handoff is dropped for pictl; see the
update note there.

# SPEC

## Problem

`pictl spawn` and revival (`resume`, transparent revival) re-exec the binary as

```
_daemon --agent-dir <dir> --agent-id <id> --cwd <cwd> --pi-bin <bin>
        --ready-fd 3 [--tag <tag>] [--resume] -- <piArgs...>
```

Most of this argv is derivable and should not be passed:

- `--agent-dir` is `agentDirPath(agentId)`; the daemon inherits `PICTL_DIR`
  from its parent and derives the same path itself.
- `--resume` is derivable from disk state (see the startup state machine).
- `--cwd`, `--pi-bin`, `--tag`, and `<piArgs...>` are spawn-time configuration
  that belongs on disk, not in argv.

## Desired behavior

Target argv:

```
_daemon --agent-id <id> --ready-fd 3
```

Spawn-time configuration moves into a **transient spawn-options file**
(`spawn-options.json` in the agent dir) that `spawn` writes before launching
the daemon and the daemon reads, folds into the `agent.json` it writes, then
deletes. This preserves "the daemon is the sole `agent.json` writer". On
revival the daemon reads the same values back from `agent.json` (as it does
today).

`--ready-fd` stays: it is genuinely per-launch plumbing, not configuration.

### Startup state machine (replaces `--resume`)

| agent.json | spawn-options.json | verdict                                                   |
| ---------- | ------------------ | --------------------------------------------------------- |
| ok         | any                | revival — config from agent.json; delete stale spawn file |
| corrupt    | any                | fail startup via ready-fd                                 |
| missing    | ok                 | initial spawn — config from spawn file                    |
| missing    | missing or corrupt | fail startup via ready-fd                                 |

Rationale for the "ok/any → revival" row: it covers a daemon that crashed
between writing agent.json and deleting the spawn file. Once agent.json
exists, the first spawn got far enough that reviving from the recorded state
(including any announced sessions) is strictly safer than re-running the
initial-spawn path with possibly-stale options.

### Failure reporting

Corrupt/missing-file startup failures are reported through the existing
ready-fd channel (`signalReady({ok: false, error})`), same pattern as the
project-trust fast-fail, so the launcher prints the error instead of hanging
until a connect deadline.

## Type design

```ts
// registry.ts — additions
export function spawnOptionsPath(agentDir: string): string;

/** Field names mirror AgentRecord; the daemon folds these into agent.json. */
export interface SpawnOptions {
  cwd: string;
  piBin: string;
  spawnArgs: string[];
  tag?: string;
}

export async function writeSpawnOptions(
  agentDir: string,
  options: SpawnOptions,
): Promise<void>;

export type SpawnOptionsReadResult =
  | { kind: "ok"; options: SpawnOptions }
  | { kind: "missing" }
  | { kind: "corrupt"; error: string };

export async function readSpawnOptions(
  agentDir: string,
): Promise<SpawnOptionsReadResult>;
```

```ts
// spawn.ts — the DaemonLaunch interface is deleted
export async function launchDaemon(agentId: string): Promise<void>;
// launchDaemon derives agentDir via agentDirPath(agentId).
// spawn() writes the spawn-options file (after mkdir succeeds), then calls
// launchDaemon(agentId).
```

```ts
// daemon.ts — flags shrink; the restArgs positional and --agent-dir, --cwd,
// --pi-bin, --tag, --resume flags are removed
const daemonFlags = {
  agentId: requiredStringFlag("Agent id", "uuid"),
  readyFd: parsedFlag("Ready fd", numberParser, "int"),
};
// daemon() calls readSpawnOptions + readAgentRecord and applies the startup
// state machine; deletes the spawn file after successfully writing agent.json.
```

```ts
// lifecycle.ts — reviveAgent and resume call sites become
await launchDaemon(agent.id);
```

## Success criteria

- The `_daemon` argv is exactly `_daemon --agent-id <id> --ready-fd 3`.
- `pictl spawn` (with and without `--tag`, `--cwd`, `-- <pi args>`) works as
  today; the values land in agent.json via the spawn file.
- `pictl resume` and transparent revival work as today, reading config from
  agent.json; no spawn file is involved.
- After a successful initial spawn, `spawn-options.json` is gone from the
  agent dir.
- A daemon launched with neither file, or with a corrupt file, reports a clear
  error through the ready-fd (spawn/resume print it and fail).
- Presubmit passes.

## Edge cases

- **Crash between agent.json write and spawn-file delete**: next launch sees
  both files → revival, stale spawn file deleted (state-machine row 2).
- **Crash of `spawn` between writing the spawn file and the daemon writing
  agent.json**: the dir has no agent.json, so `pictl gc` already classifies it
  corrupt and removes it. No gc changes needed.
- **No atomic write for the spawn file**: plain `writeFile` suffices; it is
  written before the daemon launches, so there is never a concurrent reader.
- **Corrupt agent.json at daemon startup**: today the daemon silently starts
  fresh (`existing.kind !== "ok"` → new createdAt, empty sessions), but the
  path is unreachable — revival callers refuse corrupt records via
  `loadAgent` before launching, and initial spawn creates a fresh dir. The
  new fail-via-ready-fd behavior makes the daemon self-sufficient for the
  classification it now owns.

## Non-goals

- Persisting mid-session state changes (model, thinking level, ...) for
  faithful revival — deferred; see docs/thoughts/reviving-state.md.
- Change 2 of the handoff (`wait_idle` RPC) — dropped for pictl.
- Backward compatibility with in-flight daemons launched under the old argv
  (dormant agents are unaffected: their agent.json already has everything
  revival needs).

## Reporting back

When done, report the final `_daemon` argv and the `SpawnOptions` shape to the
clauctl agent so clauctl can mirror them (per the handoff doc).

# IMPLEMENTATION IDEAS

- `spawnOptionsPath` sits in registry.ts next to the other path helpers;
  update the dir-layout doc comment at the top of registry.ts to mention
  spawn-options.json.
- `readSpawnOptions` follows the `readAgentRecord` ok/missing/corrupt pattern,
  including minimal field validation (cwd/piBin strings, spawnArgs array).
- In daemon.ts, the state-machine classification happens before the
  project-trust check (which needs cwd + spawnArgs from whichever source won).
- The daemon currently reads `existing` (agent record) for
  createdAt/sessions/tag; that read merges with the state machine — one
  readAgentRecord call serves both.
- No existing test exercises the launch argv (daemon.test.ts covers only pure
  helpers; registry/cli/streaming tests don't spawn daemons), so no test
  updates are forced. registry.test.ts is the natural home for new
  read/writeSpawnOptions coverage (ok/missing/corrupt).
- Derisk findings (2026-07-04): pictl's daemon is not in the mutation path for
  session state (unlike clauctl's), so persisted-options work is deferred with
  its open questions recorded in docs/thoughts/reviving-state.md. This change
  is prerequisite-friendly: agent.json stays the single revival-config source
  read by the daemon.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] registry.ts: spawnOptionsPath, SpawnOptions, write/readSpawnOptions
- [x] spawn.ts: launchDaemon(agentId), spawn() writes spawn file
- [x] daemon.ts: shrink flags, startup state machine, spawn-file delete
- [x] lifecycle.ts: simplify launchDaemon call sites
- [x] registry.test.ts: round-trip / missing / corrupt coverage; presubmit
      passes (63 tests)
- [x] smoke test with isolated PICTL_DIR: spawn --tag (spawn file gone,
      agent.json correct) → suspend → resume (revival, new session appended,
      tag/cwd preserved) → bare `_daemon` on an empty dir fails with the
      classification error → purge
- [ ] report final shapes back for clauctl

## Implementation-Time Decisions (2026-07-04)

- **Single unconditional spawn-file delete after the first agent.json write**,
  instead of deleting the stale file at classification time on revival. One
  code path covers both the normal handoff and the stale-leftover case; a
  revival that dies before writing agent.json leaves the stale file behind,
  which is harmless (agent.json still wins next launch).
- **Classification is inline in daemon() with let-bindings**, not a separate
  pure function returning a discriminated union — a new exported type was not
  in the approved type design, and the four-row state machine reads clearly as
  a single if/else chain next to its consumers.
- `failStartup` (stderr + signalReady) extracted as a local helper in
  daemon(); the pi-socket connect failure path now reuses it, unchanged in
  behavior.
