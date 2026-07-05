# Derisking experiment: which mutable session state survives pictl revival, and what does pi broadcast?

> **RESOLVED (2026-07-04).** See [`FINDINGS.md`](./FINDINGS.md) — pi restores
> all seven candidate fields on its own (session file for model / thinking /
> name; global settings.json for the rest); pictl needs no persisted-options
> machinery. Drivers: `run-e1e2.sh` (variants: suspend, sigkill,
> settings-wipe), `run-e3.sh`; evidence in `artifacts*/`. This README is the
> pre-experiment brief, kept for methodology.

> Modeled on clauctl's `docs/derisk/resume-persistence/`. Origin:
> `docs/thoughts/reviving-state.md` (the four empirical questions there are
> what this experiment answers).

## Why this matters

pictl revives a dead agent by re-running pi with `--session <latest file>`
plus the original `spawnArgs` (daemon.ts `revivalSessionArgs`). Any state a
user or RPC client changed mid-session — model, thinking level, steering
mode, follow-up mode, auto-compaction, auto-retry, session name — reverts on
revival unless pi restores it from the session file.

clauctl solved the equivalent problem with "record the args of every
state-mutating control call as you make it" — but that discipline **does not
transfer**: clauctl's daemon *is* the SDK client issuing mutations, while
pictl's daemon is not in the mutation path at all. RPC clients (`pictl
set-model`, ...) connect straight to pi.sock, and an attached user mutates
state through pi's TUI over the PTY with no RPC command record. The daemon
can only learn of mutations from pi's **broadcast socket events** (it already
folds `session_changed` into agent.json; that machinery would extend
naturally).

So for each mutable field the verdict is one of:

- **session-restored** — `pi --session` brings it back on its own; pictl
  needs to do nothing.
- **event-observable** — pi broadcasts a socket event on mutation (including
  TUI-driven mutation); the daemon can fold the value into agent.json and
  revival can re-apply it (via RPC after restart, or a pi flag).
- **neither** — the fix belongs in **pi** (persist it in the session file or
  broadcast an event), not in pictl. Deliverable: a concrete list to take to
  pi.

## Static priors (types-only read, pi version pinned in pictl's node_modules)

From `session-manager.d.ts`, `agent-session.d.ts`, `rpc-types.d.ts`:

- Session entry types exist for **model** (`model_change`), **thinking
  level** (`thinking_level_change`), and **session name** (`session_info`);
  `SessionContext` carries `model` + `thinkingLevel`. Prior: these three are
  session-restored.
- No session entry types for **steering mode**, **follow-up mode**,
  **auto-compaction**, **auto-retry**. Prior: not session-restored.
- Broadcast events (`RpcSocketBroadcastEvent`) include
  `thinking_level_changed` and `session_info_changed` but **nothing** for
  model, steering mode, follow-up mode, auto-compaction, auto-retry. Prior:
  only thinking level and session name are event-observable (redundantly with
  session restore, if that holds).
- `RpcSessionState` (get_state) reports `model`, `thinkingLevel`,
  `steeringMode`, `followUpMode`, `autoCompactionEnabled`, `sessionName` —
  but **no auto-retry field**. Auto-retry may be unobservable end-to-end;
  measuring it needs a behavioral probe or is itself a pi gap to report.
- `steeringMode`/`followUpMode` exist as **settings defaults**
  (settings.json). Open sub-question: does `set_steering_mode` write
  settings (then revival picks it up from settings, not the session), or is
  it runtime-only?

Priors are hypotheses to verify, not results — the whole point is that
`.d.ts` shapes don't prove runtime behavior (e.g. does `--session` actually
re-apply the *latest* `model_change` entry? do the typed events actually get
broadcast on the socket, and for TUI-driven changes too?).

## Candidate fields

Everything mutable via pictl's RPC passthrough (`rpc-commands.ts`) that is
plausibly persistent session state:

| field           | mutated via                                  | prior: session-restored? | prior: event on mutation?  | readable via get_state? |
| --------------- | -------------------------------------------- | ------------------------ | -------------------------- | ----------------------- |
| model           | `set_model`, `cycle_model`                   | yes (`model_change`)     | none typed                 | yes                     |
| thinking level  | `set_thinking_level`, `cycle_thinking_level` | yes (`thinking_level_change`) | `thinking_level_changed` | yes                  |
| session name    | `set_session_name`                           | yes (`session_info`)     | `session_info_changed`     | yes                     |
| steering mode   | `set_steering_mode`                          | no entry type            | none typed                 | yes                     |
| follow-up mode  | `set_follow_up_mode`                         | no entry type            | none typed                 | yes                     |
| auto-compaction | `set_auto_compaction`                        | no entry type            | none typed                 | yes                     |
| auto-retry      | `set_auto_retry`                             | no entry type            | none typed                 | **no**                  |

Excluded: `switch_session`/`fork`/`clone`/`new_session` (session rotation —
already covered by `session_changed` handling), transient actions (`abort`,
`compact`, `bash`, ...), read-only commands.

## Experiment shape

No bespoke socket harness: pictl itself provides the RPC interface, the
passive event stream, and the real revival path, so the whole thing is a
shell script driving pictl (run against scratch `PICTL_DIR` /
`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`).

**E1+E2 — restore-on-revival and RPC-driven event observability (one
scripted run).**

1. `pictl spawn` an agent; `pictl tail -f --type raw > events.jsonl &`
   — a passive second socket connection logging every broadcast record for
   the rest of the run (`streamRaw` prints all non-response records; this is
   exactly the daemon's vantage point, and untyped/undocumented events would
   show up here too).
2. `pictl prompt` one trivial turn so a session file exists on disk (pi
   defers writing the file until the first assistant message).
3. Record `pictl get-state` (defaults baseline).
4. Change every candidate field to a non-default via pictl RPC commands
   (`set-model`, `set-thinking-level`, `set-steering-mode`,
   `set-follow-up-mode`, `set-auto-compaction`, `set-auto-retry`,
   `set-session-name`); mutate model (or thinking level) **twice** so the
   session file shows whether the latest entry wins. Record
   `pictl get-state` again to confirm the mutations took (auto-retry: only
   via the `set-auto-retry` response — get_state has no field for it).
5. Copy the session file aside (forensics: which entries landed).
6. `pictl suspend` the agent (the tail from step 1 ends here — that's its
   natural `killed` stop condition).
7. `pictl get-state` — this transparently revives the agent
   (`ensureAgentRunning`), i.e. it exercises the real revival path, then
   reads the state in one step. Diff against the step-4 recording: per
   field, restored or reverted?

E1's verdicts come from the step-7 diff; E2's from `events.jsonl` — per
field, did any broadcast record carrying the new value reach the passive
observer?

**E1b — crash variant (cheap re-run).** suspend is graceful (idle-wait +
SIGTERM), so pi may flush state on clean shutdown that a crash would lose.
Repeat E1 once but SIGKILL the pi/daemon pids (from agent.json) instead of
suspending, then revive via `pictl resume`/get-state. Same-verdicts confirms
the suspend results generalize to crash revival.

**E3 — event observability, TUI-driven.**

The daemon's hard case: an attached user changes state via pi's TUI, no RPC
command involved. With the same raw tail running, `pictl attach` and drive
the cheapest mutations with clear key bindings (thinking level cycle is the
natural probe; model cycle if cheap). If TUI-driven and RPC-driven mutations
broadcast identically, E2's answers generalize; if not, that's a headline
finding. (Scripting keystrokes through attach is fiddly — doing this part
manually in a second terminal is fine; record the events.jsonl slice.)

**Settings sub-probe (piggybacks on E1).** After `set-steering-mode` /
`set-follow-up-mode`, diff the scratch settings.json: does the RPC write
settings (making the mode revival-safe via config rather than session), or
is it runtime-only?

## What to capture (in this directory)

- The driver script(s) (shell scripts around pictl commands).
- `events.jsonl` (E2/E3) and the before/after `get-state` dumps (E1).
- The session file(s) from the scratch session dir, if small.
- `FINDINGS.md` — implementation-facing per-field table:

  | field | session-restored? | event-observable (RPC / TUI)? | verdict |
  | ----- | ----------------- | ----------------------------- | ------- |

  with verdict ∈ {nothing to do, daemon folds event into agent.json +
  re-apply on revival, pi gap (file an issue / patch pi)}.

- `WORK-LOG.md` — progress and surprises.

## Constraints

- **Do not pollute the real `~/.pi` or the real pictl registry.** Every
  command in the run sets `PICTL_DIR`, `PI_CODING_AGENT_DIR`, and
  `PI_CODING_AGENT_SESSION_DIR` to scratch dirs inside this folder (or
  `/tmp/pictl-option-derisk/`); the daemon and pi inherit them. E1 needs one
  real assistant turn, so copy `auth.json` + `models.json` from the real
  agent dir into the scratch dir (never symlink settings.json — the settings
  sub-probe mutates it).
- **pictl spawns its pinned pi automatically** — record `pi --version` (the
  pinned binary) in FINDINGS.md; all conclusions are version-scoped.
- Real turns cost credits: one cheap-model turn per run is enough (the turn
  exists only to force the session file to disk). Everything else is
  RPC-only.
- No sleeps: pictl commands already block on their responses; the tail's
  stop condition is the suspend itself.

## Report back (evidence-first)

The filled per-field table plus a one-paragraph conclusion: **the set pictl
can ignore** (session-restored), **the set the daemon must track via events**
(with the exact event shapes to fold into agent.json and how revival
re-applies them), and **the set that needs pi changes** (the concrete ask per
field: session entry vs broadcast event — per reviving-state.md Q4, that's
where the fix belongs, not in pictl). Flag anything version-fragile, and
explicitly resolve the auto-retry observability gap (or report it as a pi
gap in its own right).
