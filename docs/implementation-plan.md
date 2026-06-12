# pi-ctl: v1 implementation plan

Starting point for implementing agents. Read `design-decisions.md` first — it defines what pi-ctl is and why; this document defines what to build and in what order. Each phase is independently shippable and ends with a manual verification pause. Do not start a phase until the user has signed off on the previous one. Within a phase, follow the user's working style: small coherent changes, check in after each unit, no scope expansion without asking.

## Prerequisites

- A pi binary supporting `--rpc-socket` (the tee-mode fork: `geraschenko/pi`, branch `anton/pi-tee`; spec in that repo at `docs/pi-rpc-socket-mode.md`). Build the standalone binary from the fork: `npm run build:binary` in `packages/coding-agent` produces a self-contained `dist/pi` (bun-compiled); symlink it into a PATH directory or point `PI_CTL_PI_BIN` at it. Verify with `pi --rpc-socket /tmp/test.sock` in a terminal — it must run interactive pi and create the socket.
- pi-ctl resolves which pi binary to spawn from the `PI_CTL_PI_BIN` env var (falling back to `pi` on PATH). The resolved absolute path is recorded in `agent.json` at spawn time so dormant-agent revival uses the same binary.
- For `tail --since` and entry-cursor features (phase 3): pi must also include the `get_entries`/`get_tree` RPC commands. The user's installed fork binary already includes them; if working against a different pi build, verify before phase 3.
- For the holder's `sessions` history (phase 1): pi must broadcast a `session_changed` event (`{type, sessionFile?, sessionId}`; `sessionFile` absent for in-memory sessions) when the active session is replaced, and send the same event to each new connection immediately after its `hello` record (so a client tracks the session through one code path, no `get_state` needed). This was added to the fork as part of tee mode (handoff spec: `/tmp/pi-session-changed.md`; as of 2026-06-11 in progress — verify it has landed in the installed binary before implementing session-history tracking, and sequence that part of the holder last if needed; everything else in phase 1 is independent of it).
- Node.js + TypeScript toolchain. Key dependencies: `node-pty` (PTY allocation), `@xterm/headless` (detached screen state). RPC and session types are imported from the pi package via a **local-path dependency** on the fork checkout: `"@earendil-works/pi-coding-agent": "file:../../earendil-works/pi/packages/coding-agent"` (adjust the relative path to the actual checkout location). The fork's `dist/` must be built for the types to resolve — `npm run build` in `packages/coding-agent` does this (and `npm run build:binary` includes it). Import `RpcCommand`, `RpcResponse`, `RpcSessionState`, `SessionEntry`, `SessionTreeNode`, `RpcClient` from the package index; never hand-mirror them.

## Reference protocol facts

- Connecting to `pi.sock` yields a hello record `{"type":"hello","protocol":"pi-rpc-socket","version":1}` first, then (once the `session_changed` fork change lands) a per-connection `session_changed` event describing the current session, then broadcast events. Commands are LF-delimited JSON; responses go only to the issuing connection; `id` is optional client-side correlation.
- The command set is defined in `packages/coding-agent/src/modes/rpc/rpc-types.ts` in the pi repo and documented in `packages/coding-agent/docs/rpc.md`.
- New clients receive future events only; catch-up is explicit (`get_state`, `get_messages`, and once available `get_entries --since`).

## Phase 1: spawn, holder, registry

Deliverables:

- Step zero: a node-pty smoke test — verify `npm install` compiles the native addon on this machine (needs `make`/`g++`/`python3`) and that a PTY can be allocated, before writing any real code. This is the most likely environment failure.
- `pi-ctl spawn [--cwd <dir>] [--id <id>] [-- <pi args...>]`
  - generates an agent id (random uuid; commands accept any unique prefix) unless given; an ambiguous prefix is an error listing the candidates (docker-style), never a guess;
  - creates `$PI_CTL_DIR/<id>/` (default `~/.pi/agents/`);
  - daemonizes the holder (`pi-ctl _hold`, hidden entrypoint of the same binary) and prints the agent id.
- `pi-ctl _hold` (hidden): allocates a PTY (default 80×24), runs `pi --rpc-socket <dir>/pi.sock <pi args...>` in it with `PI_AGENT_ID=<id>` in the environment, pipes PTY output into an @xterm/headless instance, acts as the sole writer of `agent.json` (holder pid, pi pid, cwd, pi binary path, spawn args, created-at, plus the `sessions` history: the holder connects to its own `pi.sock` as a client and appends on each `session_changed` event — the first arrives right after `hello` and describes the current session, so one code path covers startup and replacements; never poll `get_state` per event. Caveat: pi defers writing a new session file until the first assistant message, so the announced path may not exist yet; append it as *pending* and mark it confirmed on the first assistant message in that session. Events without `sessionFile` (in-memory sessions) are not recorded), reaps pi on exit, removes the sockets on clean shutdown. The `tty.sock` server may be stubbed until phase 2, but bind it now so the directory shape is final.
- `pi-ctl list` — readdir + probe per agent (holder pid alive; `get_state` over `pi.sock` for status: idle/streaming/dormant/tombstoned). Human-readable table; `--json` for machines. Never revives dormant agents.
- `pi-ctl status <agent>` — one agent, more detail (model, session file and history, cwd, pids). Never revives.
- `pi-ctl kill <agent>` — default is polite: wait until the agent is fully quiescent (current turn finished AND queued steers/follow-ups drained: `isStreaming` false with empty pending queue), then SIGTERM pi with SIGKILL escalation, holder exits, tombstone written, directory removed. `--timeout <secs>` bounds the quiescence wait and on expiry fails *without* killing (reports the agent is still busy); the default is to wait forever (Ctrl-C is the escape hatch). `--now` first ends the current turn via RPC `abort`, then proceeds with the graceful path. `--force` SIGKILLs pi and holder with no socket interaction (for wedged agents).
- `pi-ctl suspend <agent>` — same quiescence wait, then stop the process but keep the directory; the agent goes dormant (see design-decisions.md "Agents outlive processes").
- `pi-ctl resume <agent>` — revive a dormant agent: start a new holder using the pi binary path, spawn args, and cwd from `agent.json`, resuming the most recent session in the `sessions` history. No-op on a running agent.
- `pi-ctl gc` — remove tombstoned (interrupted-kill) or corrupt agent dirs only. A dead holder is not garbage; it is a dormant agent.

Notes:

- Getting the session file path into `agent.json`: the `session_changed` event received right after `hello` carries it (`get_state` remains the fallback if the holder runs against a pi predating the event). Await the socket appearing / connecting with retry — never a fixed sleep.
- Daemonization: detach the holder fully (setsid, stdio to a log file in the agent dir). The holder must survive the spawning terminal closing.
- Revival mechanism: pi's CLI resumes a specific session via `--session <path|id>`, so revival is `pi --rpc-socket <dir>/pi.sock --session <most recent confirmed entry in sessions history> <recorded spawn args...>`. Skip pending entries (their file was never flushed); as an ENOENT backstop, fall back to the next most recent entry whose file exists, and start without `--session` if none do.

Verification pause: spawn an agent and confirm `list` shows it running; kill -9 the holder and confirm `list` reports it dormant and `resume` revives it on the same session; round-trip `suspend`/`resume`; `kill` removes it; `gc` cleans a hand-tombstoned dir and leaves a dormant one alone.

## Phase 2: attach

Deliverables:

- Holder side: `tty.sock` serves a minimal framed protocol: client sends resize messages and raw input bytes; server sends a screen-state snapshot on connect (serialized from @xterm/headless — use the serialize addon) followed by raw PTY output. Multiple simultaneous clients; resize is last-writer-wins, applied as PTY resize (node-pty `resize()`, which delivers SIGWINCH).
- `pi-ctl attach <agent>`: put the local terminal in raw mode, connect, send initial resize, render snapshot, proxy bytes both ways. Detach keybinding (suggest `ctrl-\`; in raw mode it is received as a byte, not SIGQUIT) restores the terminal and exits. Also handle the agent dying mid-attach (restore terminal, report).
- When the last attacher disconnects, the PTY keeps its last size.

Verification pause: spawn an agent, attach from two terminals simultaneously, interact with pi's TUI normally (including a `/` command), resize, detach/reattach and confirm the screen restores correctly, then kill the originating terminal and confirm the agent survives.

## Phase 3: RPC passthrough, tail, wait

Deliverables:

- One module (e.g. `src/rpc-commands.ts`) mapping CLI subcommands → RPC commands. This is the **only** file that should need editing when pi's RPC surface changes; keep everything else generic. Cover the full command set: `prompt`, `steer`, `follow-up`, `abort`, `get-state`, `set-model`, `cycle-model`, `get-available-models`, `set-thinking-level`, `compact`, `set-auto-compaction`, `bash`, `get-session-stats`, `export-html`, `fork`, `clone`, `get-fork-messages`, `get-last-assistant-text`, `set-session-name`, `get-messages`, `get-commands`, and (once the pi-side change lands) `get-entries` / `get-tree`.
- Shared connection helper: connect to `<dir>/pi.sock`, validate the hello record, warn on pi version mismatch, send command, await the response, print result (`--json` for raw).
- Agent addressing: positional `<agent-id>` accepting any unique prefix; session ids (or prefixes) resolve to the hosting agent via the `sessions` histories in `agent.json`; if `PI_WORKFLOW_DIR` is set or `--workflow <dir>` given, also accept role names resolved through that workflow's state file. (Resolution only — workflow dir layout is otherwise out of scope for v1; keep the resolver tiny and tolerant.)
- Dormant-agent revival: every command that needs the socket transparently revives a dormant agent (equivalent to an implicit `pi-ctl resume`) before proceeding. `list`/`status`/`gc` never revive.
- `pi-ctl tail <agent> [--follow] [--since <entry-id>] [--events]` — without `--follow`, dump entries from `get_entries` (since cursor if given) as JSONL and exit, printing the final entry id so callers can persist a cursor; with `--follow`, additionally stay connected and stream subsequent entries (use events as wakeups, re-drain `get_entries --since` to emit — never treat events as the data source).
- `pi-ctl wait <agent> --until turn-end|quiescent|idle:<secs> [--timeout <secs>]` — distinct exit codes for condition-met vs timeout vs agent-dead. Semantics:
  - `turn-end`: return when the in-flight **or pending** turn ends (`agent_end`). Returns immediately only if the agent is fully quiescent (`isStreaming` false AND empty pending queue). Treating an accepted-but-not-yet-started prompt as "a turn that must end" is what makes the sequential `pi-ctl prompt X; pi-ctl wait X --until turn-end` pattern race-free: `prompt` only exits after the RPC accepts the message, so at `wait` time the agent is provably not quiescent. Implementer note: verify pi has no window where a message is accepted but visible neither as streaming nor as pending; if one exists, prefer `prompt --wait` plumbing (below) and document the limitation.
  - `quiescent`: full kill-style quiescence — not streaming and pending queue drained.
  - `idle:<secs>`: no session events for N seconds, regardless of streaming state. This intentionally differs from `quiescent`: it catches turns stalled mid-flight (e.g. blocked on human-facing extension UI, visible as `ui_wait_start` with no progress), which the supervisor pattern needs.
- `pi-ctl prompt` ergonomics: message as positional argument, `-` to read from stdin; `--wait` blocks until the prompted turn ends, implemented on a single connection (send prompt, await `agent_end` on the same subscription) — race-free by construction and the recommended one-shot form.

Verification pause: drive a short conversation entirely from a second terminal via `pi-ctl prompt`/`wait`/`tail --since`, including killing and re-running `tail` with a persisted cursor across a compaction (`pi-ctl compact`) and confirming nothing is lost.

## Phase 4: supervisor/worker example + messaging skill

Deliverables:

- `examples/supervisor-worker.sh` — bash only, no SDK: create-or-resume two agents (persist their ids and a worker entry-cursor in a state dir), tell each the other's agent id, then loop: `wait` on the worker (turn-end or idle), drain new worker entries since cursor, format them, `prompt` the supervisor. Must be killable and re-runnable without losing its place (this is the acceptance test for the cursor design).
- A pi skill (markdown) teaching agents to use pi-ctl: discovering self via `PI_AGENT_ID`, listing/addressing peers, `prompt`/`steer`/`interrupt`-via-`abort`, spawning sub-agents, and etiquette (prefer prompt over abort; do not kill agents you did not spawn).
- README updates documenting the end-to-end example.

Verification pause: run the example, attach to the supervisor, give it a task for the worker, watch the loop relay progress; kill and resume the orchestrating script mid-task.

## Work log

Each phase is implemented by a fresh agent; this section (plus the docs generally) is the only context that carries across phases. Update it at every check-in with environment facts, resolved decisions, and discovered constraints.

### 2026-06-11: pre-phase-1 discussion (no code yet)

- Environment verified: fork checkout at `/home/anton/git/earendil-works/pi` on branch `anton/pi-tee` with `dist/` built; `pi` on PATH is `~/bin/pi`, a symlink into that dist, version 0.79.1, supports `--rpc-socket`; Node v23.11.1, npm 11.11.0. The `file:` dependency path from this repo is therefore `file:../../earendil-works/pi/packages/coding-agent`.
- Protocol facts verified in the fork source: `RpcSessionState` includes `pendingMessageCount` and `sessionFile`/`sessionId`, so the kill/suspend quiescence check ("not streaming AND pending queue empty") is fully supported.
- Gap found and resolved pi-side: no broadcast event existed for session replacement (TUI `/new`/`/resume` invisible to socket clients; polling `get_state` per event is a non-starter since events fire per streamed token). A `session_changed` broadcast event is being added to the fork's tee mode (spec handed off in `/tmp/pi-session-changed.md`); see Prerequisites. In pi's source the hook point is `rpc-socket-mode.ts`'s rebind path (`runtimeHost.addRebindSessionListener`).
- Decisions: node + npm + plain tsc, ESM, `bin` entry, `npm link` for dev (rationale in design-decisions.md "Toolchain"); `kill` waits forever by default; ambiguous id prefixes error with the candidate list; phase 1 starts with a node-pty native-build smoke test.
- Caveat from the pi-side `session_changed` work: pi defers writing a new session file until the first assistant message, and `sessionFile` is optional (in-memory sessions). Hence the pending/confirmed `sessions`-entry semantics in design-decisions.md and the revival fallback rules above.
- Decided: pi will also send `session_changed` to each new connection immediately after `hello`, so the holder tracks sessions through a single event-driven code path (no startup `get_state` needed for this). As of 2026-06-11 the pi-side work has NOT landed; verify it is in the installed binary (connect to a socket and look for the post-hello event) before implementing the holder's session tracking, and sequence that piece last within phase 1.

### 2026-06-11: phase 1 step zero (scaffolding + smoke tests)

- `session_changed` LANDED pi-side (pi repo commit d4a93289, binary rebuilt) and verified against the installed `~/bin/pi`: a raw socket client receives `hello` then immediately `{"type":"session_changed","sessionFile":...,"sessionId":...}`. The phase-1 sequencing caveat is moot; the holder's session tracking is unblocked.
- Scaffolding created: `package.json` (ESM, `bin` → `dist/main.js`, deps node-pty / @xterm/headless / `file:` dep on the fork package; note `@types/node` pinned `^22` — there is no v23 line on npm), `tsconfig.json` (nodenext, strict, `src` → `dist`), stub `src/main.ts`.
- Smoke tests passed: `npm install` builds node-pty's native addon (`build/Release/pty.node`); a PTY allocates and runs a command; `tsc --noEmit` resolves type imports from `@earendil-works/pi-coding-agent`.
- Gotcha: ESM scripts must run from the project dir (or be inside it) for `node_modules` resolution — `/tmp` scripts can't import node-pty.

## Open questions (resolve with the user before or during the relevant phase)

1. **Type imports** (phase 1) — RESOLVED: local-path dependency on the fork's `packages/coding-agent` (see Prerequisites). The package index exports everything needed; the fork's `dist/` must be built.
2. **`wait` semantics** — RESOLVED: see the `pi-ctl wait` deliverable in phase 3. `turn-end` returns immediately only when fully quiescent and treats pending queued messages as a turn that must end (this is what makes sequential `prompt; wait` race-free); `quiescent` is kill-style quiescence; `idle:<secs>` is event silence, which also catches turns stalled on human-facing UI.
3. **Spawn-time pi configuration** (phase 1) — RESOLVED: raw pass-through of pi args after `--` only; no first-class flags in v1.
4. **`prompt` ergonomics** (phase 3) — RESOLVED: message as argument, `-` for stdin; `--wait` blocks until the prompted turn ends, implemented on a single connection (send prompt, then await `agent_end` on the same subscription) so it is race-free by construction and is the recommended one-shot form.
