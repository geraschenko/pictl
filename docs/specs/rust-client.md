# SPEC

## Problem

Rust programs cannot currently use pictl-managed agents without shelling out
to the CLI for everything, which is unworkable for interactive and reactive
use. The motivating example is a ratatui app managing a fleet of agents: it
needs to embed a live agent terminal in a pane ("embed a pictl attach") and
show a per-agent working/idle indicator that updates without polling.

Build a Rust client crate, `pictl-rs`, that:

1. **Shells out to `pictl` for lifecycle and inspection** (spawn, list,
   status, wait, suspend, archive, resume, purge, gc) — one implementation of
   the tricky lifecycle logic, owned by the TypeScript CLI.
2. **Speaks `tty.sock` natively** — the framed attach protocol — so a TUI can
   embed an agent terminal, with a feature-gated ratatui widget.
3. **Speaks `pi.sock` natively** — the JSONL RPC/event protocol — for typed
   RPC commands and an event-driven working/idle `ActivityWatcher`.

The crate lives in a new `rust/` cargo workspace inside the pictl repo
(TypeScript stays at the repo root, Polars/Prisma-style). It depends on
[pi-rpc-rs](https://github.com/geraschenko/pi-rpc-rs) for the upstream pi RPC
types only; socket-transport and fork-record types live here until they are
eventually upstreamed into pi-rpc-rs (see
`pi-rpc-rs/docs/handoff-unknown-records.md`).

**Version context**: pi-rpc-rs 0.1.4 tracks pi 0.80.6; pictl's pi fork is on
`0.80.6-fork.0`. `pictl-rs` depends on pi-rpc-rs 0.1.4 from crates.io.

**TypeScript side change**: `probeAgent` (`src/core/inspect.ts`) currently
reports a compacting agent as "idle" because it only checks `isStreaming`.
Surface compaction: status becomes `compacting` if `state.isCompacting`, else
`streaming` if `state.isStreaming`, else `idle` — matching the Rust
`ActivityWatcher` derivation and pi's own terminology.

## Success criteria

1. `cargo check` and `cargo test` pass in `rust/` with default features and
   with `--features ratatui`.
2. Unit tests cover: `FrameCodec` round-trip (including frames split across
   reads, payload-size cap, unknown frame type), and `SocketRecord` dispatch
   (hello, response, every fork record, upstream events, and an unknown
   record type mapping to `Unknown` — never a hard error).
3. Integration test (requires `pictl` + pi on PATH; skipped otherwise): spawn
   an agent, `TtyClient::connect` receives a snapshot, input bytes produce
   output frames; `ActivityWatcher` reports `Idle`, transitions to `Streaming`
   when a prompt is sent via `PiSocketClient`, and back to `Idle`.
4. A runnable `examples/` ratatui program: renders one agent's terminal in a
   pane via `AttachPane` with an activity indicator driven by
   `ActivityWatcher`, forwards keystrokes, and resizes the pane with the
   layout.
5. `pictl list`/`status` report `compacting` for an agent that is compacting
   (TypeScript change above).

## Type design

Crate `pictl-rs` in `rust/pictl-rs/`, within a `rust/` cargo workspace.
Dependencies: `tokio`, `tokio-util` (codec), `bytes`, `serde`, `serde_json`,
`thiserror`, `pi-rpc-rs`. Feature `ratatui` additionally pulls `ratatui`,
`vt100`, `tui-term`.

```rust
// id.rs — agent ids are NOT guaranteed UUIDs (`pictl spawn --id` accepts any
// [A-Za-z0-9._-]+), so this is a newtype over String.
#[derive(Clone, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct AgentId(pub String);

// error.rs
#[derive(Debug, thiserror::Error)]
pub enum Error {
  Io(#[from] std::io::Error),
  Json(#[from] serde_json::Error),
  Protocol(String),   // framing violations, bad socket hello
  Cli { args: Vec<String>, status: Option<i32>, stderr: String },
  Rpc(String),        // RPC response with success: false
  Timeout,            // `pictl wait` exit code 3
  Closed,             // socket closed mid-operation
}
pub type Result<T> = std::result::Result<T, Error>;

// cli.rs — every method runs the pictl CLI via tokio::process.
// Inputs are &str because pictl resolves agent-id *prefixes*; parsed outputs
// carry AgentId.
pub struct Pictl { bin: PathBuf }                 // Default: "pictl" from PATH
impl Pictl {
  pub fn new() -> Self;
  pub fn with_bin(bin: PathBuf) -> Self;
  pub async fn spawn(&self, opts: &SpawnOptions) -> Result<AgentId>;
  pub async fn list(&self, all: bool) -> Result<Vec<AgentProbe>>;        // list --json [--all]
  pub async fn status(&self, targets: &[&str]) -> Result<Vec<AgentProbe>>; // status --json
  pub async fn wait(&self, target: &str, until: UntilCondition, timeout: Option<Duration>) -> Result<()>;
  pub async fn suspend(&self, targets: &[&str]) -> Result<()>;
  pub async fn archive(&self, targets: &[&str]) -> Result<()>;
  pub async fn resume(&self, targets: &[&str]) -> Result<()>;
  pub async fn purge(&self, targets: &[&str]) -> Result<()>;
  pub async fn gc(&self) -> Result<()>;
}
pub struct SpawnOptions {
  pub cwd: Option<PathBuf>,
  pub id: Option<AgentId>,
  pub tag: Option<String>,
  pub pi_args: Vec<String>,
}
pub enum UntilCondition { TurnEnd, Idle, NoActivity(Duration) }

// probe.rs — mirrors `pictl {list,status} --json` output.
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct AgentProbe {
  pub agent_id: AgentId,
  pub status: AgentStatus,
  pub record: Option<AgentRecord>,
  pub state: Option<pi_rpc_rs::types::RpcSessionState>,
  pub error: Option<String>,
}
#[derive(Deserialize)] #[serde(rename_all = "lowercase")]
pub enum AgentStatus { Idle, Streaming, Compacting, Dormant, Archived, Tombstoned, Corrupt, Unreachable }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct AgentRecord {
  pub id: AgentId,
  pub created_at: String,
  pub cwd: PathBuf,
  pub tag: Option<String>,
  pub pi_bin: PathBuf,
  pub spawn_args: Vec<String>,
  pub daemon_pid: u32,
  pub pi_pid: u32,
  pub sessions: Vec<SessionHistoryEntry>,
  pub attachments: Vec<AttachmentInfo>,
  pub agent_dir: PathBuf,
}
impl AgentRecord {
  pub fn pi_socket_path(&self) -> PathBuf;        // agent_dir/pi.sock
  pub fn tty_socket_path(&self) -> PathBuf;       // agent_dir/tty.sock
}
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct SessionHistoryEntry { pub session_file: PathBuf, pub session_id: String }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
  pub pid: u32,
  pub client: String,
  pub connected_at: String,
  pub size: Option<TtyResize>,
}

// tty.rs — the framed attach protocol: [type: u8][len: u32 BE][payload],
// payload cap 16 MiB, types input=1 resize=2 snapshot=3 output=4 exit=5 hello=6.
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
pub enum Frame {
  Input(Bytes),
  Resize(TtyResize),
  Snapshot(Bytes),
  Output(Bytes),
  Exit(TtyExit),
  Hello(TtyHello),
}
#[derive(Serialize, Deserialize)]
pub struct TtyHello { pub pid: u32, pub client: String }
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct TtyResize { pub cols: u16, pub rows: u16 }
#[derive(Serialize, Deserialize)]
pub struct TtyExit { pub reason: String }
pub struct FrameCodec;   // impl tokio_util::codec::Decoder<Item = Frame, Error = Error>
                         //    + tokio_util::codec::Encoder<Frame, Error = Error>

pub struct TtyClient { /* owned write half + reader-task handle; Drop aborts task */ }
pub struct TtyEvents { /* unbounded rx fed by the reader task */ }
pub enum TtyEvent {
  Snapshot(Bytes),
  Output(Bytes),
  Exit { reason: String },
}
impl TtyClient {
  /// Connects and sends hello { pid: std::process::id(), client: client_name }.
  /// Retries with backoff until `deadline` elapses (like pictl's TS
  /// connectWithRetry): the socket may not exist yet right after spawn.
  /// A reader task drains the socket eagerly into TtyEvents (the tty server
  /// has no write backpressure, so a client must never stop reading).
  pub async fn connect(tty_sock: impl AsRef<Path>, client_name: &str, deadline: Duration) -> Result<(TtyClient, TtyEvents)>;
  pub async fn input(&mut self, bytes: &[u8]) -> Result<()>;
  pub async fn resize(&mut self, size: TtyResize) -> Result<()>;
}
impl TtyEvents {
  pub async fn next(&mut self) -> Option<Result<TtyEvent>>;  // None = disconnected
}

// socket.rs — pi.sock JSONL client. Public now; expected to move into
// pi-rpc-rs when it grows a transport abstraction.
pub struct PiSocketClient { /* write half + pending-request map + reader task; Drop aborts */ }
pub struct SocketEvents { /* unbounded rx of all non-response records */ }
impl PiSocketClient {
  /// Validates the server banner {"type":"hello","protocol":"pi-rpc-socket","version":1}.
  /// Wrong protocol is Error::Protocol; an unexpected version is tolerated.
  /// Retries with backoff until `deadline` elapses (like pictl's TS
  /// connectWithRetry): the socket may not exist yet right after spawn.
  pub async fn connect(pi_sock: impl AsRef<Path>, deadline: Duration) -> Result<(PiSocketClient, SocketEvents)>;
  /// Assigns a request id, correlates the response, Err(Error::Rpc) on success: false.
  pub async fn request(&self, kind: RpcCommandKind) -> Result<RpcResponseKind>;
  pub async fn get_state(&self) -> Result<RpcSessionState>;   // request(GetState) unwrapped
}
impl SocketEvents {
  pub async fn next(&mut self) -> Option<SocketRecord>;       // None = disconnected
}

pub struct SocketHello { pub protocol: String, pub version: u64 }
/// One JSONL record. Dispatch on "type" handles socket/fork records BEFORE
/// delegating to pi_rpc_rs::RpcEvent (whose deserializer errors on them),
/// and unrecognized types become Unknown — never a hard error. The fork
/// variants here are the list of what to eventually upstream to pi-rpc-rs.
pub enum SocketRecord {
  Hello(SocketHello),
  Response(pi_rpc_rs::types::RpcResponse),
  SessionChanged { session_id: String, session_file: Option<PathBuf> },
  Shutdown,
  UiWaitStart { request_id: String, request: serde_json::Value },
  UiWaitEnd { request_id: String, request: serde_json::Value, resolution: serde_json::Value },
  TreeNavigated { old_leaf_id: Option<String>, new_leaf_id: Option<String> },
  Event(pi_rpc_rs::types::RpcEvent),
  Unknown(serde_json::Value),
}

// status.rs — event-driven working/idle over an owned PiSocketClient
// connection (one socket per watcher; the server supports multiple clients).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentActivity { Streaming, Compacting, Idle, Disconnected }
pub struct ActivityWatcher { /* watch::Receiver + task handle; Drop aborts */ }
impl ActivityWatcher {
  pub async fn connect(pi_sock: impl AsRef<Path>, deadline: Duration) -> Result<ActivityWatcher>;
  pub fn current(&self) -> AgentActivity;
  pub async fn changed(&mut self) -> AgentActivity;   // resolves on next transition
}
// Derived from get_state, re-evaluated on agent_start / agent_end /
// compaction_start / compaction_end events (event-triggered, never polling):
//   Compacting ⇔ is_compacting
//   Streaming  ⇔ is_streaming || pending_message_count > 0 (when not Compacting)
//                (waitIdle's "not idle"; queued-but-not-yet-streaming counts
//                as Streaming — a Pending state may be added later)
//   Idle       ⇔ otherwise
//   Disconnected on socket close (terminal — callers reconnect by making a
//   new watcher). Initial value from get_state at connect.

// pane.rs (feature = "ratatui") — embeddable terminal pane. The reader task
// applies frames directly to the vt100 parser, so an unrendered pane still
// drains its socket and stays current.
pub enum PaneState { Connected, Exited { reason: String }, Disconnected }
pub struct AttachPane { /* TtyClient + Arc<Mutex<vt100::Parser>> + state/generation watch */ }
impl AttachPane {
  pub async fn connect(tty_sock: impl AsRef<Path>, client_name: &str, initial: TtyResize, deadline: Duration) -> Result<AttachPane>;
  pub async fn input(&mut self, bytes: &[u8]) -> Result<()>;
  /// The app calls this when its layout rect changes; rendering never sends
  /// resize (Widget::render is sync and pure).
  pub async fn resize(&mut self, size: TtyResize) -> Result<()>;
  pub async fn changed(&mut self);                    // redraw hint: screen or state advanced
  pub fn state(&self) -> PaneState;
  pub fn with_screen<R>(&self, f: impl FnOnce(&vt100::Screen) -> R) -> R;
}
impl ratatui::widgets::Widget for &AttachPane;        // via tui_term::PseudoTerminal
```

## Concrete examples

Fleet indicator:

```rust
let pictl = Pictl::new();
let agents = pictl.list(false).await?;
let mut watchers = Vec::new();
for probe in &agents {
  let record = probe.record.as_ref().unwrap();
  watchers.push(ActivityWatcher::connect(record.pi_socket_path()).await?);
}
// In the render loop: watchers[i].current() → paint ● (Streaming) / ♻ (Compacting) / ○ (Idle).
// In the event loop: select! over watchers[i].changed() → request redraw.
```

Embedded attach pane:

```rust
let mut pane = AttachPane::connect(
  record.tty_socket_path(), "my-fleet-app", TtyResize { cols: 80, rows: 24 },
).await?;
// Event loop: crossterm key events → pane.input(bytes); layout change →
// pane.resize(size); pane.changed() → redraw; frame.render_widget(&pane, rect).
```

## Edge cases

- **Unknown socket records** (fork evolution, future pi versions) become
  `SocketRecord::Unknown` and never error or close the connection.
- **Socket hello**: wrong `protocol` fails `connect`; an unexpected `version`
  is tolerated (matching pictl, which warns and continues).
- **tty backpressure**: the daemon writes without backpressure, so reader
  tasks must drain sockets unconditionally; backlog is bounded only by client
  memory (unbounded channels — an accepted trade-off, mirroring the daemon).
- **PTY sizing**: the server sizes the PTY to the elementwise min across all
  attached clients (tmux-style), so an embedded pane coexists with a
  concurrent full-screen `pictl attach`; the pane just reports its own size.
- **UTF-8 split mid-character across output frames**: payloads are `Bytes`;
  the vt100 parser consumes partial sequences correctly.
- **`pending_message_count` is `f64`** in pi-rpc-rs types; idle compares
  `== 0.0`.
- **`pictl wait` timeout** (exit code 3) maps to `Error::Timeout`; other
  nonzero exits map to `Error::Cli`.
- **`Pictl::wait` on a dormant/archived agent** returns immediately (pictl
  treats any condition as already met for a process that is doing nothing).

## Non-goals (v1)

- No fleet-wide/registry watching (inotify), no detection of newly spawned or
  externally spawned agents, no status for dormant/archived agents beyond
  `Pictl::status` on demand — only live agents the caller explicitly tracks.
- No reconnection inside `ActivityWatcher`/`TtyClient`; `Disconnected` is
  terminal and the caller reconnects.
- No full-terminal-takeover attach (that is `pictl attach`).
- No native registry logic (no reading `$PICTL_DIR`/`agent.json` directly);
  discovery goes through `pictl {list,status} --json`.
- No wrappers for `attach` (replaced by `TtyClient`), `tail` (replaced by
  `SocketEvents`), `format`, `completion`, internal daemon routes, or RPC
  passthrough subcommands (replaced by `PiSocketClient`).
- No per-command RPC convenience methods (pi-rpc-rs `impl_rpc_methods` style);
  `request(RpcCommandKind)` is the surface.
- No typed payloads for `ui_wait_*` beyond `serde_json::Value`.
- No transport abstraction work in pi-rpc-rs itself (tracked in
  `pi-rpc-rs/docs/handoff-unknown-records.md`).

# IMPLEMENTATION IDEAS

## Protocol facts (verified against pictl source)

- `tty.sock` framing: `[type: u8][payloadLength: u32 BE][payload]`, cap
  16 MiB (`src/core/tty-protocol.ts`). Client→server: hello (required first
  frame; JSON `{pid, client}`), input (raw bytes), resize (JSON
  `{cols, rows}`, validated 1–10,000). Server→client: snapshot
  (xterm-serialized ANSI, sent once after connect), output (raw PTY bytes),
  exit (JSON `{reason}`). Input/resize before hello is a protocol violation
  and drops the client (`tty-server.ts:258-285`).
- Snapshot ordering is handled server-side: output relayed to a connecting
  client is buffered until its snapshot is sent, so client-side handling is
  simply "feed snapshot, then outputs, into one parser".
- `pi.sock`: JSONL. Server banner
  `{"type":"hello","protocol":"pi-rpc-socket","version":1}` arrives first.
  Requests carry a client-chosen `id` (use a `pictl-rs-<counter>` scheme;
  pictl uses `pictl-<counter>`); responses have `type: "response"` and echo
  the id, routed only to the requester. Events are broadcast to all clients.
- The full agent event stream is broadcast (including `agent_start` /
  `agent_end`), which is what makes the poll-free indicator possible.
- `pictl status --json` / `list --json` serialize `AgentProbe[]` including
  `record.agentDir`; socket paths are `agentDir/pi.sock`, `agentDir/tty.sock`
  by convention (`registry.ts:90-95`).
- CLI target syntax: agents are passed as `-t/--target <agent>` flags
  (variadic for multi-target commands), not positionals (`targets.ts`).
  `wait` syntax: `pictl wait --target <agent> --until
  turn-end|idle|no-activity:<secs> [--timeout <secs>]`; `no-activity` seconds
  may be fractional, so `UntilCondition::NoActivity(Duration)` serializes as
  fractional seconds. `spawn` forwards pi args after `--`.
- Feature-dep versions verified 2026-07-11: tui-term 0.3.4 (ratatui 0.30
  ecosystem: ratatui-core 0.1 / ratatui-widgets 0.3; vt100 0.16 behind its
  `unstable-backend-vt100` optional dep) — all current and compatible.

## Design decisions and rationale (from derisk discussion)

- **Reader tasks everywhere**: the daemon's `socket.write` ignores
  backpressure (`tty-server.ts:148`), so a non-draining client grows daemon
  memory. Every socket gets a tokio reader task that drains into an unbounded
  channel (or, for `AttachPane`, directly into the parser).
- **Rendering vs. resize**: `Widget::render` stays sync/pure; resize is an
  explicit async call by the app when its layout changes. Avoids hidden async
  work in render.
- **`SocketRecord` dispatch order matters**: pi-rpc-rs's `RpcEvent`
  deserializer hard-errors on fork records, and its `session_*` prefix
  routing would misparse `session_changed` (bug noted in
  `pi-rpc-rs/docs/handoff-unknown-records.md`). Dispatch socket/fork record
  types by exact `type` string first, then try `RpcEvent`, then `Unknown`.
- **No per-command RPC wrappers in v1** (decided in review): pi-rpc-rs
  already has the full method surface (`impl_rpc_methods.rs` on `PiSession`);
  duplicating it in pictl-rs would mean tracking every pi bump twice and
  becomes throwaway when the socket client upstreams. If `request` + match
  proves painful in real use, that is evidence for prioritizing the pi-rpc-rs
  transport abstraction (which would share those methods across transports),
  not for wrappers here.
- **One socket per `ActivityWatcher`**: simpler than multiplexing watchers
  onto a shared client; the server supports many clients. A fleet app that
  also wants RPC on the same agent opens a second connection.
- **tui-term** provides the `vt100::Screen` → ratatui `Buffer` rendering;
  chosen over hand-rolling the cell mapping.
- **Repo layout precedent**: Polars/Prisma keep the primary language at the
  root with the secondary in a subdirectory; moving TS into `ts/` would churn
  npm packaging for no functional gain.

## Sketches

- `FrameCodec` with `tokio_util::codec::{FramedRead, FramedWrite}`; decoder
  errors (unknown type, oversize) are unrecoverable → surface `Err` then end
  the stream, matching the TS `FrameDecoder` contract.
- `PiSocketClient::request` correlation: `Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>`;
  the reader task routes `type == "response"` by id, everything else to
  `SocketEvents`. Writer half behind a `tokio::Mutex` so `request` takes
  `&self` and calls can overlap.
- `ActivityWatcher` internals: `watch::channel(AgentActivity)`; task loop:
  initial `get_state`, then on `AgentStart` set Streaming, on `AgentEnd` /
  `CompactionStart` / `CompactionEnd` re-run `get_state` and re-derive, on
  stream end set Disconnected and exit.
- `AttachPane::changed` via a `watch::Receiver<u64>` generation counter
  bumped by the reader task on every applied frame or state change.
- Test strategy (agreed in review): pictl has no fake-pi harness, and a real
  pi needs provider API keys to stream. So (1) protocol-level tests run
  against in-test mock servers implementing the tty.sock / pi.sock wire
  protocols (we control both ends; always run in CI); (2) the real
  end-to-end test (spawn via pictl, prompt, watch Streaming→Idle) is
  `#[ignore]` by default and run manually when pictl + pi + keys are
  available, with `PICTL_DIR` pointed at a tempdir so it never touches the
  real registry.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [ ] `rust/` workspace + `pictl-rs` crate skeleton (compiles with stubs)
- [ ] `FrameCodec` + tty protocol types + unit tests
- [ ] `TtyClient`/`TtyEvents` with reader task
- [ ] `SocketRecord` dispatch + unit tests
- [ ] `PiSocketClient`/`SocketEvents`
- [ ] `ActivityWatcher`
- [ ] TypeScript: surface `compacting` in `probeAgent` (inspect.ts) + test
- [ ] `Pictl` CLI wrapper + probe types
- [ ] `AttachPane` + `Widget` impl (feature `ratatui`)
- [ ] Integration test (gated on pictl availability)
- [ ] ratatui example
