# Work log

## 2026-07-04

- Drafted README from the reviving-state.md questions plus a types-only read
  of the pinned pi package (session entry types, broadcast event union,
  RpcSessionState shape). Noticed statically that `get_state` has no
  auto-retry field.
- Simplified the plan (Anton's suggestion): no bespoke socket harness — pictl
  itself is the harness (`spawn` / `tail -f --type raw` / RPC passthrough /
  `suspend` / transparent revival via `get-state`). E1+E2 collapse into one
  scripted run.
- Pre-run pipeline check: spawn + get-state + get-available-models against
  scratch dirs worked first try. Default state without settings.json:
  claude-opus-4-8, thinking medium, both queue modes one-at-a-time,
  auto-compaction on.
- **Run 1 (suspend):** all fields RESTORED — but two surprises:
  - RPC mutations write settings.json (`defaultModel`, `steeringMode`,
    `followUpMode`, `compaction.enabled`, `retry.enabled`), so "restored" was
    ambiguous between session-file and settings mechanisms.
  - Thinking-level test confounded: claude-3-5-haiku (non-reasoning) clamped
    `high -> off` and wrote a `thinking_level_change: off` entry. Discarded
    this run's artifacts; re-ran with reasoning models only
    (claude-3-7-sonnet -> claude-opus-4-5).
- Added `settings-wipe` variant to separate the mechanisms: delete
  settings.json between suspend and revive. Result: model/thinking/name
  survive (session file); steering/follow-up/auto-compaction revert
  (settings-only).
- **sigkill variant:** identical to suspend — persistence happens at mutation
  time, not shutdown.
- **E3 (TUI-driven):** scripted `pictl attach` under node-pty, sent shift+tab
  (thinking cycle) and ctrl+p (model cycle). Same broadcast behavior as RPC:
  thinking emits `thinking_level_changed`, model emits nothing. Bonus
  finding: the TUI thinking cycle also writes `defaultThinkingLevel` to
  settings, which the RPC command does not.
- Post-hoc review (Anton's question) caught that the "real turn" in every
  run actually errored: `No API key for provider: anthropic` (the OAuth
  entry copied from the real auth.json was not accepted in the scratch env).
  Verified this is harmless: the errored turn still produced an assistant
  message, so the session file was written — the turn's only purpose — and
  all measured behavior is config-layer. Noted in FINDINGS.md. Lesson:
  should have checked prompt-output.txt instead of assuming the turn
  succeeded.
- Wrote FINDINGS.md. Bottom line: pi already restores all seven fields;
  pictl needs no persisted-options machinery; the settings-backed fields are
  global (cross-agent) rather than per-agent, which is a pi design property,
  not a pictl bug to fix.
