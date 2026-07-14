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
