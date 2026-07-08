> **RESOLVED (2026-07-04)** by `docs/derisk/option-persistence/FINDINGS.md`:
> the premise below is false at pi 0.80.2-fork.2. pi itself restores all
> mutable fields on `--session` revival — model / thinking level / session
> name from the session file, steering mode / follow-up mode /
> auto-compaction / auto-retry from global settings.json (written at
> mutation time, even for TUI-driven changes). pictl needs no
> persisted-options machinery. Caveat: the settings-backed fields are global
> user preferences shared across agents, not per-agent state.

I think agent.json currently doesn't have enough information for the revived agent to have exactly the same state as before it was killed. Specifically, if things like the model, thinking level, etc changed over the course of the session, reusing the original command used to spawn the agent is wrong.

## Notes from the daemon-args derisk (2026-07-04)

clauctl solved this with a `persistedOptions` field in its agent record: the
daemon records the arguments of every state-mutating control call as it makes
it (`queueRecordWrite` in clauctl's `src/core/daemon.ts`), and re-passes the
merged options on respawn. The empirical study behind it is
`~/git/geraschenko/clauctl/docs/derisk/resume-persistence/FINDINGS.md`.

That discipline does not transfer directly to pictl, because pictl's daemon is
not in the mutation path. clauctl's daemon _is_ the SDK client issuing the
control calls; in pictl, mutations bypass the daemon entirely:

- RPC clients (`pictl model`, `pictl thinking`, ...) connect straight to
  pi.sock, which pi itself serves.
- An attached user can change model/thinking/etc through pi's own TUI over the
  PTY, with no RPC record at all.

The daemon can only learn about these mutations if pi broadcasts corresponding
socket events (it already broadcasts `session_changed`, which the daemon folds
into agent.json — that machinery would extend naturally).

Empirical questions for a resume-persistence-style derisk against pi:

1. Does `pi --session <file>` already restore model / thinking level /
   steering mode / follow-up mode / auto-compaction / auto-retry from the
   session file? Whatever it restores needs no pictl-side persistence.
2. For fields it does not restore: does pi emit socket events on mutation
   (including TUI-driven mutation) that the daemon could observe? What are
   they?
3. Which mutating RPC commands need covering? Candidates from pictl's
   passthrough table (`rpc-commands.ts`): `set_model`, `cycle_model`,
   `set_thinking_level`, `cycle_thinking_level`, `set_steering_mode`,
   `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`,
   `set_session_name`.
4. For anything neither restored by `--session` nor observable via events, the
   fix likely belongs in pi (persist it in the session file or broadcast an
   event), not in pictl.

The daemon-args change (docs/specs/daemon-derived-args.md) is a
prerequisite-friendly step: it makes agent.json the single revival-config
source read by the daemon, which is exactly the mechanism a future
persisted-options field would extend.
