# Findings: which mutable session state survives pictl revival?

> Implementation-facing summary. Methodology and priors: [README.md](./README.md);
> raw evidence: `artifacts*/`; drivers: `run-e1e2.sh`, `run-e3.sh`. All results
> are for pi **0.80.2-fork.2** (the pictl-pinned package) and are version-scoped.

## TL;DR

**Revival restores every candidate field with zero pictl-side work — but
through two different mechanisms with very different guarantees:**

- **Session-file restore** (per-agent, revival-faithful): model, thinking
  level, session name. The latest entry wins (model was mutated twice; the
  second value came back).
- **Global-settings restore** (shared across ALL agents in the pi agent dir):
  steering mode, follow-up mode, auto-compaction, auto-retry. pi writes
  settings.json at mutation time, and a revived pi reads current settings.
  This is _coincidentally_ faithful for a single agent but is **not per-agent
  state**: another agent (or the user running bare pi) changing the same
  setting between suspend and revival changes what comes back (proven by the
  settings-wipe variant: wipe settings.json before revival and exactly these
  fields revert).

No daemon-side event folding is needed for fidelity today. The
`reviving-state.md` premise ("agent.json doesn't have enough information")
is **false for all seven candidate fields** at this pi version.

## Per-field table

| field           | mutated via                         | restored on revival? | mechanism                | broadcast event on mutation (RPC / TUI)                  |
| --------------- | ----------------------------------- | -------------------- | ------------------------ | -------------------------------------------------------- |
| model           | `set_model`, TUI ctrl+p             | yes (latest wins)    | session file + settings¹ | **none / none**                                          |
| thinking level  | `set_thinking_level`, TUI shift+tab | yes                  | session file + settings² | `thinking_level_changed` / same                          |
| session name    | `set_session_name`                  | yes                  | session file             | `session_info_changed` / (untested, no TUI binding used) |
| steering mode   | `set_steering_mode`                 | yes                  | **settings only**        | **none**                                                 |
| follow-up mode  | `set_follow_up_mode`                | yes                  | **settings only**        | **none**                                                 |
| auto-compaction | `set_auto_compaction`               | yes                  | **settings only**        | **none**                                                 |
| auto-retry      | `set_auto_retry`                    | presumed³            | **settings only**        | **none**                                                 |

¹ `set_model` writes both a `model_change` session entry and
`defaultProvider`/`defaultModel` to settings.json. With settings wiped, the
session entry alone restored the model — the session file is sufficient.
² RPC `set_thinking_level` writes only the session entry; the TUI shift+tab
cycle _also_ writes `defaultThinkingLevel` to settings. Either path restores.
³ `set_auto_retry` writes `retry.enabled` to settings.json, the same
mechanism as the three fields above, but there is **no way to read auto-retry
state back**: `get_state` has no field for it (a pi API gap worth reporting
regardless). Restore is inferred from the mechanism, not observed.

## Evidence highlights

- **Suspend vs crash: identical.** The SIGKILL variant (pi and daemon killed
  with no chance to flush) restored everything the graceful suspend did —
  session entries and settings are written at mutation time, not shutdown.
- **Settings-wipe variant** (delete settings.json between suspend and
  revive): model/thinking/name survived (session-restored); steering mode,
  follow-up mode, auto-compaction reverted to defaults (settings-only).
- **Event observability is poor and that's OK.** Across every RPC mutation
  and the TUI probes, a passive socket observer (the daemon's exact vantage
  point, via `pictl tail --type raw`) saw only two config events:
  `{type: "thinking_level_changed", level}` and
  `{type: "session_info_changed", name}`. Model, steering, follow-up,
  auto-compaction, auto-retry mutations broadcast nothing. TUI-driven and
  RPC-driven mutations broadcast identically (E3).
- **Non-reasoning-model clamp (gotcha found en route):** switching to
  `claude-3-5-haiku` clamped thinking `high -> off` and appended a
  `thinking_level_change: off` session entry. Thinking level is not
  independent state across model changes; revival replays whatever the
  session file last recorded, clamps included.
- **Session file is deferred:** an agent that mutates state but never
  completes an assistant turn has no session file; for such an agent only the
  settings-backed fields would survive revival (edge case, zero real-world
  weight since revival without a session file also has no conversation to
  lose... except entries recorded before the first turn).
- **The forcing turn actually errored** (`[error: No API key for provider:
  anthropic]` — the anthropic OAuth entry in the copied auth.json was not
  accepted in the scratch env). This turned out not to matter: an errored
  turn still appends an assistant message, so pi wrote the session file,
  which is the only thing the turn existed to cause. No finding here depends
  on a successful completion — everything measured is config-layer — and as
  a bonus the runs cost zero credits. If a future re-run wants a clean
  successful turn, supply a working API key in the scratch auth.json.

## What this means for pictl

1. **No persisted-options work is needed** for revival fidelity of these
   fields. `docs/thoughts/reviving-state.md` can be resolved: pi already
   persists everything, split across the session file and settings.json.
2. **The settings-backed fields are global, not per-agent.** A
   `pictl set-steering-mode` on one agent silently changes the default for
   every future pi/pictl session in the same `PI_CODING_AGENT_DIR`, and
   revival fidelity for those fields depends on nothing else touching
   settings.json in the interim. If per-agent fidelity for
   steering/follow-up/auto-compaction/auto-retry ever matters, the fix
   belongs in pi (per-session persistence), not pictl — but note this is
   pi's _designed_ behavior (these are user preferences, not session state).
3. **Do not build revival machinery on the event stream.** Only two of seven
   fields broadcast events; the daemon cannot observe the rest. Fortunately
   it doesn't need to.
4. **pi gaps worth reporting upstream:** auto-retry state is not readable via
   `get_state`; model changes broadcast no event (a passive observer like a
   status UI can't see them without polling).

## Version-fragility watch items

- The session-file vs settings split per field is undocumented pi behavior;
  re-check on pi upgrades (cheap: re-run `run-e1e2.sh` and
  `run-e1e2.sh settings-wipe`).
- The RPC-vs-TUI asymmetry on `defaultThinkingLevel` (TUI persists it to
  settings, RPC doesn't) suggests these write paths are maintained
  separately in pi and could drift.
