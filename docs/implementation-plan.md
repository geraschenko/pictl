# pi-ctl: v1 implementation plan

Starting point for implementing agents. Read `design-decisions.md` first — it defines what pi-ctl is and why; this document defines what to build and in what order. Each phase is independently shippable and ends with a manual verification pause. Do not start a phase until the user has signed off on the previous one. Within a phase, follow the user's working style: small coherent changes, check in after each unit, no scope expansion without asking.

## Prerequisites

- A pi binary supporting `--rpc-socket` (the tee-mode fork: `geraschenko/pi`, branch `anton/pi-tee`; spec in that repo at `docs/pi-rpc-socket-mode.md`). Build the standalone binary from the fork: `npm run build:binary` in `packages/coding-agent` produces a self-contained `dist/pi` (bun-compiled); symlink it into a PATH directory or point `PI_CTL_PI_BIN` at it. Verify with `pi --rpc-socket /tmp/test.sock` in a terminal — it must run interactive pi and create the socket.
- pi-ctl resolves which pi binary to spawn from the `PI_CTL_PI_BIN` env var (falling back to `pi` on PATH). The resolved absolute path is recorded in `agent.json` at spawn time so dormant-agent revival uses the same binary.
- For `tail --since` and entry-cursor features (phase 3): pi must also include the `get_entries`/`get_tree` RPC commands (see `docs/rpc-session-tree-commands.md` in the pi repo). Earlier phases do not need them.
- Node.js + TypeScript toolchain. Key dependencies: `node-pty` (PTY allocation), `@xterm/headless` (detached screen state). RPC types should be imported from the pi package if its packaging allows; if pi does not publish consumable types, vendor them in a single clearly-marked module with the pi version recorded (see open questions).

## Reference protocol facts

- Connecting to `pi.sock` yields a hello record `{"type":"hello","protocol":"pi-rpc-socket","version":1}` first, then broadcast events. Commands are LF-delimited JSON; responses go only to the issuing connection; `id` is optional client-side correlation.
- The command set is defined in `packages/coding-agent/src/modes/rpc/rpc-types.ts` in the pi repo and documented in `packages/coding-agent/docs/rpc.md`.
- New clients receive future events only; catch-up is explicit (`get_state`, `get_messages`, and once available `get_entries --since`).

## Phase 1: spawn, holder, registry

Deliverables:

- `pi-ctl spawn [--cwd <dir>] [--id <id>] [-- <pi args...>]`
  - generates an agent id (random uuid; commands accept any unique prefix) unless given;
  - creates `$PI_CTL_DIR/<id>/` (default `~/.pi/agents/`);
  - daemonizes the holder (`pi-ctl _hold`, hidden entrypoint of the same binary) and prints the agent id.
- `pi-ctl _hold` (hidden): allocates a PTY (default 80×24), runs `pi --rpc-socket <dir>/pi.sock <pi args...>` in it with `PI_AGENT_ID=<id>` in the environment, pipes PTY output into an @xterm/headless instance, acts as the sole writer of `agent.json` (holder pid, pi pid, cwd, pi binary path, spawn args, created-at, plus the `sessions` history: the holder connects to its own `pi.sock` as a client and appends the current session file at startup and whenever the session is replaced), reaps pi on exit, removes the sockets on clean shutdown. The `tty.sock` server may be stubbed until phase 2, but bind it now so the directory shape is final.
- `pi-ctl list` — readdir + probe per agent (holder pid alive; `get_state` over `pi.sock` for status: idle/streaming/dormant/tombstoned). Human-readable table; `--json` for machines. Never revives dormant agents.
- `pi-ctl status <agent>` — one agent, more detail (model, session file and history, cwd, pids). Never revives.
- `pi-ctl kill <agent>` — default is polite: wait until the agent is fully quiescent (current turn finished AND queued steers/follow-ups drained: `isStreaming` false with empty pending queue), then SIGTERM pi with SIGKILL escalation, holder exits, tombstone written, directory removed. `--timeout <secs>` bounds the quiescence wait and on expiry fails *without* killing (reports the agent is still busy). `--now` first ends the current turn via RPC `abort`, then proceeds with the graceful path. `--force` SIGKILLs pi and holder with no socket interaction (for wedged agents).
- `pi-ctl suspend <agent>` — same quiescence wait, then stop the process but keep the directory; the agent goes dormant (see design-decisions.md "Agents outlive processes").
- `pi-ctl resume <agent>` — revive a dormant agent: start a new holder using the pi binary path, spawn args, and cwd from `agent.json`, resuming the most recent session in the `sessions` history. No-op on a running agent.
- `pi-ctl gc` — remove tombstoned (interrupted-kill) or corrupt agent dirs only. A dead holder is not garbage; it is a dormant agent.

Notes:

- Getting the session file path into `agent.json`: query `get_state` over `pi.sock` after pi is up (its response includes `sessionFile`). Await the socket appearing / connecting with retry — never a fixed sleep.
- Daemonization: detach the holder fully (setsid, stdio to a log file in the agent dir). The holder must survive the spawning terminal closing.
- Revival mechanism: check whether pi's CLI supports resuming a specific session file directly (e.g. a `--session`/`--resume <path>` flag); if not, start pi fresh and immediately issue `switch_session` with the recorded path over `pi.sock` — that command is guaranteed to exist.
TDC: pi's CLI support resuming a given session with `--session <path|id>`. Update this doc to reflect that.

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
- `pi-ctl wait <agent> --until turn-end|idle:<secs> [--timeout <secs>]` — turn-end waits for the next `agent_end` event (check `get_state` first: if not streaming, an idle agent satisfies turn-end immediately — decide and document); idle:N waits until no events for N seconds while not streaming. Distinct exit codes for condition-met vs timeout vs agent-dead.

Verification pause: drive a short conversation entirely from a second terminal via `pi-ctl prompt`/`wait`/`tail --since`, including killing and re-running `tail` with a persisted cursor across a compaction (`pi-ctl compact`) and confirming nothing is lost.

## Phase 4: supervisor/worker example + messaging skill

Deliverables:

- `examples/supervisor-worker.sh` — bash only, no SDK: create-or-resume two agents (persist their ids and a worker entry-cursor in a state dir), tell each the other's agent id, then loop: `wait` on the worker (turn-end or idle), drain new worker entries since cursor, format them, `prompt` the supervisor. Must be killable and re-runnable without losing its place (this is the acceptance test for the cursor design).
- A pi skill (markdown) teaching agents to use pi-ctl: discovering self via `PI_AGENT_ID`, listing/addressing peers, `prompt`/`steer`/`interrupt`-via-`abort`, spawning sub-agents, and etiquette (prefer prompt over abort; do not kill agents you did not spawn).
- README updates documenting the end-to-end example.

Verification pause: run the example, attach to the supervisor, give it a task for the worker, watch the loop relay progress; kill and resume the orchestrating script mid-task.

## Open questions (resolve with the user before or during the relevant phase)

1. **Type imports** (phase 1) — RESOLVED: `@earendil-works/pi-coding-agent` exports `RpcCommand`, `RpcResponse`, `RpcSessionState`, `SessionEntry`, `SessionTreeNode`, and `RpcClient` from its package index. Depend on the fork's package (local path or git dependency; it must be built so `dist/` types exist) and import these directly. Remaining detail: pick local-path vs git dependency with the user at phase 1 start.
2. **`wait --until turn-end` on an idle agent** (phase 3): return immediately or wait for the *next* turn to end? Proposal: flag-controlled, default wait-for-next; confirm with user.
TDC: My expectation is that if there's no active turn, then waiting until turn-end would return immediately. I would expect waiting until idle to use the same quiescence logic as `pi-ctl kill`. This does raise an important point about race conditions though. If I `pi-ctl prompt` and then `pi-ctl wait --until turn-end`, it seems like delays either in sending the prompt or between the commands could cause unexpected behavior. How do you think we should handle this? If turn-end returns immediately for an idle agent, is there even a race condition to worry about?
3. **Spawn-time pi configuration** (phase 1): system prompts, extensions, model — pass through as raw pi args after `--`, or add first-class flags? Proposal: raw pass-through only in v1.
TDC: agreed, raw pass-through.
4. **`prompt` ergonomics** (phase 3): message as argument vs stdin; whether `prompt` should optionally block until turn-end (`--wait`) for one-shot scripting. Proposal: argument + `-` for stdin; add `--wait` since it collapses the most common two-command sequence.
TDC: agreed on both.