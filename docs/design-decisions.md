# pi-ctl: design decisions

This document records the design decisions behind pi-ctl and their rationale. It is the reference for future brainstorming and design sessions: when proposing changes, check them against these decisions, and either stay consistent or explicitly revisit the decision with the user. The implementation plan for v1 lives in `implementation-plan.md`.

## What pi-ctl is

pi-ctl is a CLI for spawning, observing, controlling, and attaching to a fleet of [pi](https://github.com/earendil-works/pi) coding-agent instances. It is the foundation for a workflow system in which agents supervise, spawn, and message other agents, and in which humans can attach interactively to any agent at any time.

It builds on pi's "tee" mode (`pi --rpc-socket <path>`, branch `anton/pi-tee` in the pi fork; spec at `docs/pi-rpc-socket-mode.md` in the pi repo): normal interactive pi that also exposes the RPC JSONL protocol over a Unix domain socket, with events broadcast to all connected clients.

## Philosophy

- **Workflows are code, not config.** The project exists to encourage continuous harness engineering: after working through a problem with an interactive agent, the learnings should be encodable as a script, skill, or workflow that both humans and agents can run next time. Workflows are written in general-purpose languages, never YAML/JSON config.
- **The wire protocol and the CLI are the language-agnostic layer.** Anyone can orchestrate from bash, Python, Rust, or TypeScript by shelling out to pi-ctl or speaking JSONL to the sockets directly. Language-specific SDKs are ergonomic conveniences layered on top, not requirements.
- **Any agent can be attached to.** Workers are never sealed boxes. A human can `pi-ctl attach <agent>` to any running agent and get the full interactive pi TUI. This is the key differentiator from sealed-subagent designs.
- **Simplest encoding first.** The supervisor/worker pattern must be expressible as a short bash script over pi-ctl before any SDK exists. The SDK graduates scripts that need real concurrency; it does not gatekeep basic orchestration.

## Architecture layers

1. **Wire protocol** — pi's RPC JSONL over Unix socket (`--rpc-socket`). Already implemented on the pi fork.
2. **pi-ctl** (this repo) — agent lifecycle (spawn/list/kill/attach), registry, and a CLI surface mirroring essentially the full RPC command set, plus orchestration primitives (`tail`, `wait`).
3. **Workflow SDK** (future, separate effort) — a TypeScript library (`Workflow.open(...)`, `wf.agent(...)`, trigger composition) built on the same registry and sockets. pi-rpc-rs remains the Rust client and proof of language neutrality.
4. **Drivers** (future, out of scope) — long-lived processes that spawn workflows from external events (issue trackers, webhooks, cron). These sit above the system; their concerns (queueing, dedup, restart policy) must not leak into layers 2–3.

## Toolchain: node + npm + plain tsc

pi-ctl runs on Node (not bun) and builds with plain `tsc` (not tsup or a bundler). Rationale: node-pty is a native C++ addon built against Node's ABI, and the holder depends on exactly the areas where bun's Node compatibility is weakest (PTY handling, signals, detached child processes) — pi can ship as a bun-compiled binary because it doesn't allocate PTYs; pi-ctl holds PTYs for a living. tsup/bundling is a contained, non-breaking optimization later if CLI startup latency ever matters in tight shell loops; it skips type-checking and can't inline native addons anyway. Package shape: ESM (`"type": "module"`), `tsc` emits `src/` → `dist/`, a `bin` entry exposes `pi-ctl`, `npm link` for development. The holder re-invokes itself via `process.execPath` + entry script, so `_hold` works regardless of how the CLI was invoked.

## Language: TypeScript

pi-ctl is TypeScript. Reasons: pi is TypeScript, so RPC types can be **imported from the pi package rather than hand-mirrored** (compile-time compatibility checking — contrast pi-rpc-rs, which maintains a hand-tracked compatibility table); npm distribution; agents read/write TS workflows fluently; node-pty + @xterm/headless are the proven stack for the attach architecture.

Caveat: until tee mode is upstreamed, pi-ctl depends on the pi _fork_ (geraschenko/pi, branch `anton/pi-tee`) both at runtime (the installed pi binary must support `--rpc-socket`) and for type imports. See open questions in the implementation plan.

## Process model: one holder daemon per agent

Each spawned agent is held by a small **holder daemon** — a hidden entrypoint of the pi-ctl binary itself (`pi-ctl _hold`), daemonized by `pi-ctl spawn`. One holder per pi instance; there is no central daemon. The holder:

- allocates a PTY via node-pty and runs `pi --rpc-socket <agent-dir>/pi.sock` inside it (the PTY satisfies pi's interactive-TTY requirement — **no pi modifications needed** for background operation);
- feeds PTY output into a headless terminal emulator (@xterm/headless) to maintain screen state while detached;
- serves attach clients on `<agent-dir>/tty.sock`;
- is the agent's lifecycle anchor: parent of the pi process, knows liveness, writes `agent.json`, cleans up the agent directory's sockets on exit.

Why this design: a TUI needs someone to hold the PTY master and remember the screen at all times; tmux is exactly that service, and this replaces the tmux dependency with a few hundred lines following the architecture VS Code uses for terminal persistence/reconnect (node-pty + xterm-headless + screen serialization on reattach).

Holder/CLI version skew is acceptable: the sockets carry stable protocols, so a newer pi-ctl can manage agents held by an older holder. A holder restart implies an agent restart, so skew is short-lived anyway.

## Attach semantics

- `pi-ctl attach <agent>`: raw-mode the local terminal, connect to `tty.sock`, send local terminal size, receive the serialized current screen, then proxy bytes bidirectionally until the detach keybinding.
- Multiple simultaneous attachers are allowed; resize policy is last-resize-wins (forwarded as PTY ioctl + SIGWINCH; pi's TUI redraws on resize, which also backstops any emulator serialization imperfections).
- Detached agents keep their last size; agents that have never been attached use a default (80×24).

## Registry: the directory is the registry

No central index file or registry daemon (lock-contention and staleness magnets). Convention:

- Root: `$PI_CTL_DIR`, defaulting to `~/.pi/agents/` (nests under pi's existing `~/.pi/`).
- Per agent: `$PI_CTL_DIR/<agent-id>/` containing:
  - `agent.json` — see authority split below;
  - `pi.sock` — pi's RPC socket;
  - `tty.sock` — the holder's attach socket.
- `agent.json` authority split:
  - Authoritative for holder-owned facts the socket cannot provide: holder pid, pi pid, cwd, the pi binary path and spawn args used (needed for revival), created-at.
  - Session facts (current session file, model, streaming state) are queried live over `pi.sock` whenever the agent is running. `agent.json` additionally records `sessions` — the history of session files this agent has hosted, most recent last. The holder maintains it by connecting to its own `pi.sock` as a client and appending on the `session_changed` event, which every connection receives once immediately after `hello` (describing the current session) and thereafter whenever the session is replaced (`/new`, `/resume`, `switch_session`) — one code path covers startup and replacement. This event was added to pi's tee mode specifically for this: responses to `new_session`/`switch_session` go only to the issuing connection, TUI-initiated switches are otherwise invisible to socket clients, and polling `get_state` per broadcast event is a non-starter (events fire per streamed token). This history enables dormant-agent revival and agent↔session mapping.
  - `sessions` entry semantics: each entry is `{sessionFile, sessionId}`. pi defers writing a new session file until the first assistant message, so a `session_changed` event may announce a path that does not exist on disk yet; entries are recorded regardless, and consumers that need the file check existence themselves. (An earlier design tracked a `confirmed` flag predicting file existence; the disk is ground truth, so checking it directly where it matters made the flag dead weight, and it was removed.) The history is duplicate-free: re-announcing a known session id moves its entry to the end (most recent). The event's `sessionFile` is also optional (pi can run without session persistence); in-memory sessions never enter the history. Revival resumes the most recent entry whose file exists on disk and starts fresh if no entry's file exists.
  - Single-writer rule: only the holder writes `agent.json`; CLI commands treat it as read-only.
- Agent ids are random uuids, deliberately independent of pi session ids. They cannot _be_ session ids because agent ≠ session: one agent hosts many sessions over its lifetime (`/new`, `/resume`, `switch_session` replace the session while the sockets survive), and the agent directory must exist before pi starts — i.e. before any session id exists.
- Name resolution: any unique prefix of an agent id addresses it (tmux/docker style). Session ids work as a secondary resolver: pi-ctl can map a session id or prefix to the agent that hosts (or last hosted) it, and list an agent's session history, via the `sessions` histories in `agent.json`.
- `pi-ctl list` = readdir + per-agent probe (holder pid alive, then `get_state` over `pi.sock`). Statuses: running (idle/streaming), dormant, tombstoned — see "Agents outlive processes" below.
- Working directories are tracked in `agent.json`: agents default to the spawner's cwd, but workflows may spawn agents into worktrees, so cwd is per-agent data, not an assumption.

## Agents outlive processes

An agent is its directory plus its session lineage; the holder/pi process is ephemeral. There is no reason to keep an idle agent's process running.

- **Dormant**: directory present, no holder process. Not an error state. Any pi-ctl command that needs the socket (prompt, attach, wait, ...) transparently revives the agent first: a new holder is started from the pi binary, spawn args, and cwd recorded in `agent.json`, resuming the most recent session in the `sessions` history. `pi-ctl resume <agent>` revives explicitly; `list`/`status` report dormancy without reviving.
- **Suspended on purpose**: `pi-ctl suspend <agent>` gracefully stops the process (same quiescence rules as `kill`) but keeps the directory — the agent goes dormant. Holders may additionally auto-suspend after a configurable idle period (optional; not required for v1).
- **Killed**: `pi-ctl kill` is the only way an agent ceases to exist — graceful shutdown, tombstone marker written, directory removed. Consequently `pi-ctl gc` does NOT reap crashed agents (a dead holder just means dormant); it only removes tombstoned directories left by interrupted kills and unreadably corrupt ones.

## Workflows hold references; agents are global

An agent can participate in multiple workflows simultaneously (e.g. a worker mid-task spawns an adversarial-review workflow), and workflows have variable membership (e.g. DAG decomposition spawning a variable number of parallel task agents). Therefore:

- The agent registry is flat and global; agent identity is the agent id.
- A workflow is a directory whose state maps role names → agent ids. Workflows are _views/groupings over_ agents, not containers of them. Killing a workflow does not necessarily kill its agents (per-workflow policy).
- Spawned agents receive `PI_AGENT_ID` (self-identification, needed by the inter-agent messaging skill) and optionally `PI_WORKFLOW_DIR` as a _default name-resolution context_, not an identity. `pi-ctl prompt reviewer "..."` resolves through the workflow context; `pi-ctl prompt <agent-id> "..."` addresses globally; `--workflow <dir>` selects a non-default context. The exact workflow-dir layout is not finalized — design it with the SDK, not in pi-ctl v1.

## Catch-up is cursor-based over session entries, not event channels

Events over the socket are ephemeral wakeups, never the source of truth. Orchestrator catch-up uses **session entry ids as durable cursors**:

- pi sessions are append-only entry trees (`id`/`parentId`); compaction is itself an appended entry (`type: "compaction"`), so pre-compaction history and abandoned branches persist.
- pi's RPC is being extended (separate change, intended for upstream; see `docs/rpc-session-tree-commands.md` in the pi repo) with `get_entries` (optional `since: entryId`, append order, returns `leafId`) and `get_tree`. pi-ctl uses these rather than parsing pi's session files — we do not break pi's storage abstraction.
- This makes crash-resume correct by construction: on restart, drain from the persisted cursor and nothing is missed.
- Compaction and `/tree` jumps are deliberately **client policy, not mechanism**: a drain shows all new entries (including compaction entries and entries on new branches), `leafId` reveals branch moves, and the client decides what that means (e.g. whether a supervisor sees raw pre-compaction messages or the compaction summary).

## CLI surface

- pi-ctl is **the same binary for humans and agents**. Agents learn it via a skill; there is no separate agent-facing tool.
- pi-ctl mirrors essentially the entire RPC command set (`prompt`, `steer`, `follow-up`, `abort`, `set-model`, `set-thinking-level`, `compact`, `get-state`, `fork`, `get-messages`, `get-entries`, `get-tree`, ...). The CLI-subcommand → RPC-command mapping lives in **one isolated module**, so a pi RPC change is a one-file diff (the discipline pi-rpc-rs applies to its types module).
- Orchestration primitives that make shell workflows viable without an SDK:
  - `pi-ctl tail <agent> [--follow] [--since <entry-id>]` — session entries/events as JSONL on stdout; a subscription is a long-running child process.
  - `pi-ctl wait <agent> --until <condition> [--timeout <secs>]` — block until turn-end / idle / etc.; exit code communicates the outcome.
- A version check at connect (pi's socket `hello` record plus `pi --version`) guards runtime skew between pi-ctl and the installed pi.

## Deferred / out of scope

- **Capability scoping** (e.g. preventing a worker from interrupting its supervisor): future work, expected to be enforced via pre-tool hooks / extensions on the spawned agent, not by pi-ctl.
- **Issue-tracker-style drivers**: built on top later; a ~50-line script once spawn/prompt/wait are solid.
- **The TypeScript workflow SDK**: built after pi-ctl, on top of it, once the bash-level supervisor/worker example has stress-tested the CLI surface.
- **Remote-rendered pi UI**: explicitly rejected. Attach is byte-level PTY proxying; pi remains the sole owner of its TUI and extension UI (consistent with the tee-mode spec's non-goals).
- **Windows**: Unix sockets + PTYs; Linux/macOS only for now.
