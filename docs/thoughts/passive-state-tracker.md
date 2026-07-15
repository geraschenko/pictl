# Passive session-state tracker

Both clients currently derive an agent's working/idle status by calling
`get_state` whenever a boundary event arrives: the TypeScript side in
`src/core/inspect.ts` and the Rust side in
`rust/pictl-rs/src/activity_watcher/mod.rs`. The events themselves
(`agent_start`, `agent_end`, `compaction_start`, `compaction_end`) tell us
_that_ something changed but not the whole next state (queued message counts,
compaction inside a turn), so each boundary costs a request/response
round-trip on pi.sock. With many watchers or chatty agents that's wasteful,
and it's also a race window: the state we fetch may already reflect a later
event than the one we're reacting to.

## Proposal

Inspect the pi source to understand exactly how the fields of
`RpcSessionState` are managed:

- `is_streaming`, `is_compacting`
- `pending_message_count`, `message_count`
- `model`, `thinking_level`, `steering_mode`, `follow_up_mode`
- `session_id` / `session_file` / `session_name`, `auto_compaction_enabled`

For each field, determine which RPC events (and which of our own commands'
responses) change it, and whether the event stream carries enough information
to reproduce the transition. Then write a **state tracker**: call `get_state`
once at connect, and afterwards fold the event stream into a locally
maintained `RpcSessionState` — no further polling.

The tracker should be implemented in both TypeScript and Rust, and must be
the same folding logic in both (single source of truth per language, shared
test vectors if practical). Consumers then read state locally:

- The Rust `AgentActivity` enum / `ActivityWatcher` derivation is replaced by
  a struct that owns the tracked `RpcSessionState` and exposes a convenience
  method for the current agent status (streaming / compacting / idle).
- The TypeScript probe (`inspect.ts`) reads the same tracked state instead of
  issuing `get_state` per check.

## Open questions

- Is the event stream actually sufficient? E.g. does an event fire when a
  queued steering message is consumed (`pending_message_count` decrement), or
  when the model/thinking level changes from inside the session? Any field
  that can change without an observable event forces either a documented
  staleness caveat or a targeted `get_state` refresh on just those paths.
- Ordering guarantees: events and responses arrive on the same socket in
  server order, so folding should be race-free — verify this holds in pi's
  implementation.
- Versioning: the folding logic encodes pi's internal state machine, so it
  can silently drift when pi changes. A cheap safeguard: in debug builds (or
  a test mode), occasionally issue `get_state` and assert it matches the
  folded state.

## Derisking findings (2026-07-15, pi 0.80.6-fork.0)

Source inspection of the shipped pi dist (unminified JS + .d.ts; file refs
under `node_modules/@geraschenko/pi-coding-agent/`). Verdict: **the fold is
possible for about half the fields as-is; the rest change with no socket
event and need pi-side event additions (we control the fork) or targeted
refreshes.**

Foldable exactly today:

- `isStreaming` — `agent_start` → true, `agent_settled` → false. NOT
  `agent_end`: retries/continuations keep the run active; only
  `agent_settled` means idle (`dist/core/agent-session.js:783,793-800`).
- `thinkingLevel` — `thinking_level_changed{level}` carries the value;
  `setThinkingLevel` is the single funnel, incl. model-switch re-clamping
  (`agent-session.js:1327-1341`).
- `sessionName` — `session_info_changed{name}`; `setSessionName` is the only
  writer (`agent-session.js:2301-2306`).
- `sessionId` / `sessionFile` — `session_changed`; sent per client at connect
  and broadcast on session replacement (`rpc-socket-mode.js:157-158,183-189`).
- `pendingMessageCount` — `queue_update{steering[],followUp[]}` carries full
  arrays (emitted on enqueue, consumption, and clear;
  `agent-session.js:319,326,1067,1083,1196`). Caveat: `sendCustomMessage`
  steering bypasses these arrays entirely.
- `isCompacting` — `compaction_start`/`compaction_end` pair on every
  manual/auto path including error/abort. Exception: `navigate_tree` branch
  summarization sets the compacting flag with no compaction events — only
  `tree_navigated` fires, at the end (`agent-session.js:638-642,2358,2490`).

Not foldable — change with NO socket event:

- `model` — `set_model`/`cycle_model` (any client, or TUI Ctrl+P / `/model`)
  emit only the extension-runner `model_select`, never a socket broadcast
  (`agent-session.js:1231-1240,1252,1284,1307`); registry refresh also swaps
  it silently (`1868-1878`).
- `steeringMode` / `followUpMode` — setters write agent + settings, no emit
  (`agent-session.js:1395-1406`); `/reload` re-syncs silently (`2107`).
- `autoCompactionEnabled` — a settings write, no emit (`1790-1792`).
- `messageCount` — worst field: bash results push to `state.messages` with
  no event at all (`agent-session.js:2261,2287-2293`); compaction replaces
  messages wholesale (`1488,1734`) and `compaction_end` carries no count;
  retry/overflow drop the trailing error message (`1606,1759,2162-2165`);
  `tree_navigated` rebuilds messages but carries only leaf ids (`2470`).

Ordering: per-client, responses and events share one FIFO with in-order
writes, and `_emit` enqueues synchronously at emit time — so a fold over
events alone is race-free (`rpc-socket-mode.js:74-134`;
`agent-session.js:266-269`). But a `get_state` response can be up to ~one
microtask stale relative to events already on the wire (the async handler
inserts a microtask between snapshot and enqueue,
`rpc-socket-mode.js:206-215`), and concurrent commands' responses are not
serialized (`160-162`). All value-carrying events are absolute (not deltas),
so re-applying an event already reflected in the snapshot is harmless.

Connect/cross-client: pi sends only `hello` + `session_changed` on connect —
no snapshot, so the initial `get_state` stays. All session events broadcast
to every client regardless of originator (TUI and RPC share one
`AgentSession`, `dist/main.js:673-699`) — but the silent mutations above are
silent for everyone, including TUI-user changes.

Path to a complete fold (pi-side, in our fork): broadcast `model_select` and
add `steering_mode_changed` / `follow_up_mode_changed` /
`auto_compaction_changed` events; either event bash-result message appends
and put the new message count on state-rewriting events (`compaction_end`,
`tree_navigated`), or drop `messageCount` from the tracked state if no
consumer needs it. Interim recipe without pi changes: fold the exact fields,
refresh on `session_changed` (mandatory — resets nearly everything),
`compaction_end`, and `tree_navigated`, and accept documented staleness on
the four silent fields.
