# SPEC

> **Status: implemented; acceptance test passed (2026-07-03).** This spec is self-contained: it carries every fact needed to implement the `team` skill without re-reading `docket.md` or prior conversation. Name (`team`), the full command surface, packaging (not packaged with pictl; script lives in the skill dir), and script form (single dependency-free Node script) are all confirmed. No open questions remain.
>
> **Partially superseded by [team-tmux.md](team-tmux.md) (2026-07-07):** non-pi identity now comes from an ancestry walk (not raw `ppid`); notify gained a tmux tier and `team start --pane`/`--no-notify` flags; hooks are installed only at docket creation (the install/refresh-on-every-call behavior described below is gone); messages spool per-docket at `<dataHome>/team/messages/<hash>/`.

## Problem

pictl's phase 4 calls for a supervisor/worker example and a skill teaching an agent to orchestrate peers. We deliver that as a **team** skill: a _manager_ agent spins up worker agents (raw `pictl spawn`) and sends them **async messages**, and is _woken_ when results are ready rather than polling. The deterministic plumbing — running the async work, buffering output, notifying at opportune moments, letting the owner take results — is provided by the standalone [`docket`](../../../docket/docs/specs/docket.md) tool (already built and globally installed). pictl supplies only the glue: the dispatched commands are `pictl prompt`s and the notify hook uses `pictl wait`/`pictl prompt`.

The skill is a **new sibling** to the existing `skills/pictl/` skill (we are _not_ overhauling `skills/pictl/SKILL.md` now). It documents fresh-context review as one worked use of the team pattern; `skills/pictl/reviewer.md` **stays** (user decision at implementation time — see work log), so nothing under `skills/pictl/` changes.

### Why a wrapper script (`team`) at all

docket's interface is string-command-based, and that creates exactly two frictions the manager agent should not carry:

1. **Docket-directory resolution.** docket resolves its directory _only_ from `--docket <dir>` or `$DOCKET_DIR` — there is **no** cwd/ancestor discovery and no global lookup (docket.md). And an agent's shell env does **not** persist across its separate command invocations, so "export `DOCKET_DIR` once" does not work. Without help, the manager would have to retype the docket dir on _every_ call.
2. **Two-layer-shell quoting.** A dispatched task message would otherwise pass through docket's `sh -c` _and_ the inner `pictl prompt` arg parsing, so any quote/`$`/backtick in the message breaks it.

`team` exists solely to erase these two frictions and to hide docket entirely (the skill is about talking to a team, not about docket). Everything docket already does ergonomically is exposed as a thin passthrough that only injects the resolved dir. Spawning workers stays raw `pictl` — it touches no docket and needs no roster.

### The key idea: the manager's identity determines its inbox

Each manager owns exactly one docket (its inbox for all worker replies). The docket **directory is derived from the manager's identity**, so every `team` call — and a _restarted_ pi manager — recovers the same inbox with zero env and zero memory. Identity resolution (see Type Design → `resolveDocketDir`):

1. `$PICTL_ID` set → key = `$PICTL_ID`; the docket is at `<dataHome>/team/<hash(key)>`; **notify (push) is wired.**
2. else → key = `String(ppid)` — the pid of the parent process that invokes `team`, i.e. the agent's session process; docket at `<dataHome>/team/<hash(key)>`; **notify is NOT wired** — the manager polls `team ready`/`team take` manually.

Presence of `$PICTL_ID` decides _both_ the key source and whether push is wired — one signal, no mode flag. `<dataHome>` = `$XDG_DATA_HOME` or `~/.local/share`.

There is deliberately **no override** — no `--docket` flag and no `$DOCKET_DIR` respect. The inbox is _always_ derived from identity; an escape hatch would undermine exactly the wrapping `team` exists to provide, and honoring `$DOCKET_DIR` would be an active hazard: docket sets `DOCKET_DIR` for dispatched jobs and notify hooks, and env inherits through spawns, so a leaked `DOCKET_DIR` would glue an agent to its _manager's_ inbox — a team member couldn't make its own team, breaking the decentralized/nested-teams success criterion. For debugging or inspecting _another_ manager's inbox, use raw `docket --docket <dir>` (`team start` prints the dir).

**Why `ppid`, not the helper's own pid, not cwd, not git state.** The helper's own pid is fresh on every invocation. cwd and git state can change over a session (the agent may `cd` or switch branches), silently splitting the inbox. The **parent pid is invariant for the whole session** — verified empirically: across two separate command invocations the helper's own pid changed but `$PPID` was identical, pointing at the persistent host/session process. This gives a non-pictl manager (e.g. Claude Code, no `$PICTL_ID`) a stable, session-scoped inbox for free. It is _not_ resumable across a restart of the session process — which is correct, since a non-pictl manager has no cross-restart identity and none was requested.

**Accepted limitation of case 2 (v1, robustness level (a)):** the implementation reads **`process.ppid`** plainly. This is correct when the per-call `sh -c "team …"` **exec's** the helper (a single simple command with optional redirections — the normal case). If the agent wraps a `team` call in a **pipeline, subshell, or command substitution** (`team ready | …`, `id=$(team dispatch …)`), the extra fork makes `process.ppid` point at the ephemeral per-call shell, deriving a _different_ inbox. For read-only calls this is a harmless stray empty docket; for `dispatch` it is **not** harmless — the job lands in an inbox nobody checks. The skill prose therefore says: under the fallback, invoke `team` only as a plain simple command; never capture its stdout via `$(…)` (job ids are visible via `team status`/`team ready` anyway).

## The wiring (concrete)

Every value interpolated into a `sh -c` command string (agent ids, the message-file path) is wrapped with `shellQuote` (see Type Design) — the message _content_ never passes through a shell, but the path and ids do.

**Notify hook** (baked by `team` when `$PICTL_ID` is set; `<ID>` = `shellQuote($PICTL_ID)`):

```
pictl wait -t <ID> --until no-activity:1; docket ready | pictl prompt -t <ID> --streaming-behavior follow-up -
```

- docket runs the hook via `sh -c` with `DOCKET_DIR` set in its environment, so the bare `docket ready` inside the hook resolves the docket without a flag (docket.md).
- `no-activity:1` gate: the manager is woken only once it has been quiet for 1s, so the inbox never barges in mid-turn (it may converse with one worker, self-summarize, _then_ receive the rest).
- `--streaming-behavior follow-up` on the inject: after the gate clears, the manager may begin a new turn before the prompt lands; a plain prompt would bounce with "busy", so the wake is queued as a follow-up. **Put this reason in a comment where the hook string is assembled.**
- `;` (not `&&`) between the two halves is deliberate: if the quiet-gate wait fails for a transient reason, we still attempt delivery. If the manager is truly gone, the prompt fails too, and a failed notify is non-fatal by docket's design (the results stay ready for taking).
- Wake payload is `docket ready` (actionable items only); the manager runs `team status` itself for full context.

**Dispatched command** (what `team dispatch <worker> <msg>` runs; `<W>` = `shellQuote(worker)`, `<F>` = `shellQuote(absolute message file team just wrote)`):

```
pictl prompt -t <W> --streaming-behavior follow-up - < <F>
```

- docket runs dispatched commands via `sh -c` with **stdin connected to `/dev/null`** (docket.md). So `pictl prompt … -` alone would read EOF. The `< <F>` redirect _inside the dispatched string_ re-opens stdin from the message file — this is why `dispatch` must spool the message to a file. The message content is never parsed by any shell (it only ever arrives via the file), which is what defeats the two-layer-shell quoting hazard.
- `--streaming-behavior follow-up`: without it, a prompt to a worker that is mid-turn is **rejected** by the pi RPC, so dispatching a second task to a busy worker would produce a docket job containing an immediate pictl error instead of queued work. With it, the message is queued as a follow-up; on an idle worker the flag is a no-op (it only governs behavior while streaming). This makes `team dispatch` a true per-worker async message queue. **Put this reason in a comment where the dispatch string is assembled.**
- **Busy-worker capture semantics** (verified against pi's agent-session: the agent loop drains queued follow-ups _before_ emitting `agent_end`, and pictl's `turn-end` waits for the next `agent_end`): the reply is never truncated — the capture always runs through the end of the queued follow-up's work. But the stream records every message event from the moment the dispatch connects, so a busy-worker capture also includes the **tail of the worker's in-flight turn** (and, if several dispatches queue on one worker, their replies interleave into each capture). Extra context, never lost replies. The skill prose notes that dispatching to a busy worker yields a reply embedded in surrounding turn output.
- `pictl prompt` reads the prompt from stdin, **blocks until the worker's turn ends, and streams the worker's full reply to stdout**. docket captures that stdout as the job's result. So `team take <id>` yields the worker's reply — no `tail --since`/cursor-drain machinery is involved. Note the captured output _ends with_ pictl's formatted `[cursor: …]` line (default `prompt` output writes a final cursor record); we keep it — it is harmless and feeds the future `tail --since` experiment.
- Capture is plain `pictl prompt` output (already equivalent to `pictl prompt --json | pictl format messages`). _Future experiment (not v1):_ record a cursor and use `pictl tail --since` instead — it would additionally capture turns driven by **someone else** talking to the same worker, which a self-issued `prompt` cannot see.

## The `team` command surface

All subcommands resolve the docket dir via `resolveDocketDir` (above). `start` and `dispatch` ensure the docket exists first (idempotent); the rest require it to already exist (docket errors otherwise).

**CLI grammar:** `team <subcommand> [args]` — no flags. Unknown flags, unknown subcommands, and wrong arity are usage errors. **Error policy:** fail fast — usage errors print to stderr and exit 2 (matching the docket/pictl convention); other setup/runtime errors exit 1 (including `$XDG_DATA_HOME`/`$HOME` both unset — `<dataHome>` is always needed); when a `docket`/`pictl` child fails, its stderr passes through and `team` exits with the child's exit code. The message spool lives at `<dataHome>/team/messages/`, not inside the docket dir — docket owns that directory's layout. **Environment assumption:** `docket` and `pictl` must be on `PATH` both where `team` runs and in the environment docket's daemon uses for dispatched commands and notify hooks.

**Shared inboxes are unsupported.** Each manager's inbox is derived from its own identity; there is no way (and no reason) to point `team` at someone else's.

- `team start` — ensure the docket exists (`docket init <dir>`), install/refresh the notify hook iff `$PICTL_ID` is set, and **print the docket dir**. Idempotent. Explicit setup entry point; also handy for the manager/debugger to learn its inbox path.
- `team dispatch <worker> [<message>|-]` — read the message from the arg or (if `-`/omitted) stdin; write it to an absolute message file; ensure the docket; run `docket dispatch "pictl prompt -t <W> --streaming-behavior follow-up - < <F>"` (`<W>`/`<F>` shell-quoted, see wiring); print the docket job id. `<worker>` is a pi agent id (from a prior `pictl spawn`).
- `team ready` — passthrough to `docket ready` (with resolved `--docket`). The ready menu.
- `team take <id>` — passthrough to `docket take <id>`. Prints one worker's reply; marks it taken. Accepts a unique id prefix.
- `team status` — passthrough to `docket status`. Full context incl. still-running jobs.
- `team cancel <id>` — passthrough to `docket cancel <id>`. **Stops the local wait, not the worker's turn**; to stop the worker itself use raw `pictl abort -t <worker>`.

What stays **raw pictl** in the skill prose (not wrapped): `pictl spawn` a worker (any cwd/worktree/repo), converse with a worker directly, `pictl abort`.

## docket facts the implementation relies on (so this spec stands alone)

- `docket init [dir] [--notify <cmd>]` creates the dir (creating `<dir>` itself; ensure its parent exists first) and prints the **absolute** path. Re-init on an existing docket is **idempotent**: layout ensured; `notify` is rewritten **only when `--notify` is given**, otherwise preserved. Refuses to adopt a non-empty directory that lacks the `.docket` marker.
- Every non-`init` subcommand needs `--docket <dir>` or `$DOCKET_DIR`; **no discovery**. `dispatch` does **not** auto-init.
- `dispatch` returns immediately, printing the job id; the job survives the launching process; on completion docket marks it ready and runs the notify hook, **coalescing** bursts so notifies never overlap.
- Dispatched command + notify hook run via `sh -c`, with `DOCKET_DIR` set, **stdin `/dev/null`**, **cwd inherited from the `dispatch` call**.
- `take` prints captured stdout always, adds stderr if non-empty and exit code if non-zero; atomic; errors on running/canceled/unknown/already-taken.
- `cancel` tears down a **running** job's process tree (best-effort; a real completion outranks the cancel).

## Success criteria

- A manager can dispatch ongoing work to worker pi agents (spawned in any cwd) over time — not one static batch — and, when it is not mid-thought, be woken with a `ready` menu, then take results in the order it chooses.
- **Decentralized:** no privileged main agent. Any agent can own a docket and also be a worker for others; graphs of agents fall out; no "team" registry.
- **Resumable (pi case):** killing and restarting the orchestration mid-flight loses neither completed-untaken results nor in-flight jobs (the phase-4 acceptance test). Guaranteed because the pi manager's inbox is derived from `$PICTL_ID`.
- **Graceful degradation:** a non-pictl manager (no `$PICTL_ID`) uses the _same_ commands; it simply isn't pushed and polls `team ready`/`team take`. Its inbox is session-scoped (`ppid`-derived).
- The skill folds fresh-context review in as one documented use of the pattern (`reviewer.md` kept alongside it, per user decision).

## Type Design

Language: **Node** — deliberately _not_ bash, because the wrapper exists precisely to avoid shell-quoting hazards, and reintroducing bash would recreate them. Since the skill is not packaged with pictl (see Packaging), the script is dependency-free (no stricli) with plain arg parsing; the decomposition below still applies. `env` and `ppid` are threaded as explicit parameters (functional style; injectable in tests; matches docket's convention of not reading `process.env`/globals directly).

```ts
interface TeamEnv {
  PICTL_ID?: string;
  XDG_DATA_HOME?: string;
  HOME?: string;
}

// dataHome = env.XDG_DATA_HOME ?? join(env.HOME, ".local/share")
// join(dataHome, "team", hash(env.PICTL_ID ?? String(ppid))). No override.
function resolveDocketDir(env: TeamEnv, ppid: number): string;

// Filesystem-safe, short, deterministic (e.g. sha256 hex, first 16 chars).
function keyHash(key: string): string;

// POSIX single-quoting, exactly: "'" + s.replaceAll("'", "'\\''") + "'".
// Applied to EVERY value interpolated into a sh -c command string:
// agent ids and the message-file path.
function shellQuote(s: string): string;

// The notify hook string (above), or undefined when env.PICTL_ID is absent.
function notifyHook(env: TeamEnv): string | undefined;

// `docket init <dir> [--notify <hook>]`. Creates dir's parent if needed.
// Passes --notify only when notifyHook(env) is defined (so non-pi never installs a hook,
// and pi re-runs keep the hook current). Idempotent.
function ensureDocket(dir: string, env: TeamEnv): void;

// Subcommands. Each resolves the dir; `start`/`dispatch` call ensureDocket, the rest require it.
function start(env: TeamEnv, ppid: number): void;
function dispatch(worker: string, message: string, env: TeamEnv, ppid: number): void;
function ready(env: TeamEnv, ppid: number): void;
function take(id: string, env: TeamEnv, ppid: number): void;
function status(env: TeamEnv, ppid: number): void;
function cancel(id: string, env: TeamEnv, ppid: number): void;
```

Dependencies: `start`/`dispatch` → `ensureDocket` → `notifyHook`; all six → `resolveDocketDir` → `keyHash`; `dispatch` and `notifyHook` → `shellQuote`. `dispatch` creates `<dataHome>/team/messages/` recursively if needed, writes an absolute message file there (e.g. `<randomUUID>.txt`), then execs `docket dispatch "pictl prompt -t <W> --streaming-behavior follow-up - < <F>" --docket <dir>` (`<W>`/`<F>` shell-quoted). Passthroughs exec `docket <sub> [id] --docket <dir>` inheriting stdio. Message files are not deleted in v1 (they must outlive the detached, possibly long-running `pictl prompt`); GC is future work — the skill prose warns long-running managers that spooled messages accumulate.

## Non-goals

- No changes to pictl's CLI surface or `PICTL_DIR` layout. Needing either signals we have stopped _using_ pictl as a component — stop and reconsider.
- docket is specified/built separately; this doc does not design docket.
- No membership/roster of workers, no "teams" data structure. The manager addresses workers by the ids `pictl spawn` returns.
- No cross-restart resumability for the non-pictl (case 3) manager.
- The richer `take`-menu interaction beyond "wake with the ready list; take by id" is deferred.
- Cursor + `pictl tail --since` capture is a future experiment, not v1.

# IMPLEMENTATION IDEAS

## Skill shape

- New **sibling skill** directory (working name `skills/team/`) with a `SKILL.md` whose leading word is **team**: an agent spins up workers with `pictl spawn`, sends async work with `team dispatch`, and is woken (pi) or polls (non-pi) via `team ready`/`take`. docket is not mentioned to the agent — it is the hidden backend.
- Fold the reviewer workflow in as a worked example ("dispatch a fresh-context reviewer, take its critique, act on it"). `skills/pictl/reviewer.md` is kept (user decision, 2026-07-03).
- Do **not** touch anything under `skills/pictl/` (router overhaul deferred).

## Packaging (RESOLVED 2026-07-03)

**The skill is not packaged with pictl at all.** It is an experimental skill that _uses_ pictl, not a component of pictl — so package.json `files`, npm `bin` naming, and the build's exec-bit machinery are all irrelevant. The `team` script lives inside the skill dir (`skills/team/team`) and is invoked by path from the skill prose.

Consequence for the implementation form: with no package/build step available, the wrapper is a **single dependency-free executable Node script** (`#!/usr/bin/env node`, exec bit set in git) — no stricli, no TS compilation; plain arg parsing (the six subcommands are trivial). The Type Design's function decomposition and signatures are unchanged; only the CLI layer differs from pictl/docket's stricli convention.

## Acceptance test

1. Manager `M` (pi) runs `team start` — inits its inbox, installs the notify hook.
2. `M` `pictl spawn`s workers (possibly different cwds) and `team dispatch`es several tasks over time.
3. As each worker finishes, `M` is woken — but only once quiet — with the `ready` menu, and `team take`s results in its chosen order.
4. Kill and restart the orchestration mid-flight; confirm no completed-untaken result and no in-flight job is lost (`M`'s inbox re-derives from `$PICTL_ID`).
5. A fresh-context reviewer dispatched the same way returns a critique `M` takes and acts on (the `reviewer.md` replacement path).
6. Non-pi degradation: with `$PICTL_ID` unset, `team start`/`dispatch`/`ready`/`take` operate on a `ppid`-derived inbox with no notify; the same commands work by polling.
7. Busy-worker dispatch: dispatch a second task to a worker that is mid-turn; confirm the job queues (no error capture), its `take` contains the queued reply (possibly preceded by the in-flight turn's tail), and nothing is truncated.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] docket implemented and globally installed (`../../../docket/docs/specs/docket.md`); integration facts re-verified against it (stdin `/dev/null`, cwd inheritance, dir resolution, idempotent init). **Unblocked.**
- [x] Design complete for the `team` skill + wrapper (identity→inbox derivation, graceful degradation, command surface, type design). Recorded here.
- [x] Confirmed: name `team`, full front-end surface, and that direct-conversation echo is a non-issue (only dispatched turns are captured). Only packaging remains open before coding.
- [x] Packaging resolved (2026-07-03): **not packaged with pictl** — experimental skill that uses pictl; script lives at `skills/team/team`, invoked by path. Consequently the script form is decided: a dependency-free single Node script (no stricli/TS build), plain arg parsing. No open questions remain.
- [x] Fresh-context reviewer round (2026-07-03): spec revised per findings — see "Decisions captured (2026-07-03 reviewer round)".
- [x] Implement the `team` script (`skills/team/team`): `resolveDocketDir`/`keyHash`/`shellQuote`/`notifyHook`/`ensureDocket` + six subcommands; exec bit set (on disk; recorded in git at add time).
- [x] Write `skills/team/SKILL.md`; fold in the reviewer example. **User decision (2026-07-03): `skills/pictl/reviewer.md` is NOT removed** — it stays alongside the team skill, so no `skills/pictl/` files change at all.
- [x] Run the acceptance test; all 7 steps pass — see "Acceptance test results" below.

## Implementation-Time Decisions (2026-07-03)

- **ESM, not CJS**: the repo's `package.json` has `"type": "module"`, so the extensionless script is parsed as ESM; `require` throws. Top-level `import`s (also the repo convention).
- **`ensureDocket` suppresses `docket init`'s stdout** (stderr still passes through): `init` prints the docket path, which would pollute `dispatch`'s contract of printing only the job id. `start` prints the dir itself from `resolveDocketDir` (same absolute path — `dataHome` is resolved).
- **Flag rejection vs the `-` message placeholder**: any argument starting with `-` is a usage error, except the literal `-` in `dispatch`'s message slot. A message that itself starts with a dash must come via stdin (noted implicitly by the usage error's hint).
- **`ChildExit` error class** carries a failed child's exit code to the single top-level handler, which distinguishes usage errors (2), child failures (child's code), and runtime errors (1).
- **`keyHash`** = sha256 hex, first 16 chars, per the spec's suggestion.
- **SKILL.md audited against the writing-great-skills guidance** (user request): the description was rewritten from a mechanics summary to trigger phrasing, one trigger per branch (delegate/parallelize work; async message + collect; fresh-context review). Deliberately _not_ done: disclosing the review worked-example to a sibling file — the spec folds it into the skill as a worked example, the file is not sprawl at ~77 lines, and the example teaches the dispatch pattern to every branch.
- **SKILL.md refined after a dispatched fresh-context review** (which was itself acceptance step 5): invocation-by-path made explicit (script not on PATH); "one worker = one serial queue, spawn one worker per parallel task"; `team start` described as optional (dispatch auto-creates the inbox); non-pi caveat now notes ids are always recoverable via `status`/`ready` and that `$(…)` is safe when `$PICTL_ID` is set.

## Live-use iteration (2026-07-04)

The skill was exercised for real by a non-pi manager (this Claude Code session) running the reviewer workflow through `team` itself, converging to reviewer approval in three rounds. Changes from the iteration:

- **SKILL.md**: added "The loop" section with an explicit completion criterion (every dispatched job taken and accounted for; workers archived); executable examples now invoke `<skill-dir>/team` (agents copy examples literally — bare `team` fails since the script is not on `PATH`); one-line non-pi "plain simple command" warning placed directly under the Commands block; PATH caveat framed as error diagnosis ("error mentioning `docket` → backend missing from `PATH`").
- **Script**: `dispatch` rejects an empty message (usage error) — under a harness, omitted message + stdin at `/dev/null` would otherwise silently dispatch an empty task. Usage text documents that omitted/`-` message reads stdin.
- Rejected with recorded reasons: `TEAM=…` env-var examples (env does not persist across an agent's command invocations — the very trap this design avoids), naming the backend as a first-class prerequisite, signal-name diagnostics, description trimming, moving the busy-worker note, disclosing the review example to a linked file.
- **Fallback-scope finding**: in Claude Code-style harnesses every Bash tool call is a fresh parent process, so the ppid-derived inbox is stable only _within_ one call; multi-step team flows must run in a single shell invocation there. Recorded here as a known limit of case 2; a tmux-based identity/notify extension is being explored in a separate spec.

## Acceptance test results (2026-07-03)

All steps performed against real spawned agents (since archived); inboxes isolated via `XDG_DATA_HOME` pointing at a scratch dir.

1. **start**: pi-identity inbox created; `notify` file contains exactly the spec'd hook string (quoted id, `no-activity:1`, `;`, follow-up inject). Idempotent; same dir on re-run.
2. **dispatch over time**: two workers, two dispatches; job ids printed; `status` showed both running.
3. **Quiet-gated wake + chosen-order take**: the manager's transcript shows the ready menu injected as new user turns only after it went idle. Both results taken in reverse dispatch order via unique id prefixes; `ready` empties.
4. **Restart resumability**: results and in-flight jobs collected from a _different_ shell with only `$PICTL_ID` set — the inbox re-derives; nothing lost.
5. **Fresh-context reviewer path**: a read-only reviewer dispatched via `team` reviewed `SKILL.md`, its critique was taken and acted on (edits above), and a follow-up dispatch returned "APPROVED".
6. **Non-pi degradation**: with `$PICTL_ID` unset, the ppid-derived inbox worked by polling. The documented `$(team …)` hazard reproduced live: a `take` inside command substitution derived a different inbox and failed loudly ("not a docket") — for reads it errors rather than silently misbehaving.
7. **Busy-worker dispatch**: second dispatch to a mid-turn worker queued (job stayed `running`, no error capture). Both captures contained both replies — the first ran through the drained follow-up (queued follow-ups drain before `agent_end`), the second included the in-flight turn's tail — exactly the documented interleaving; nothing truncated.

Observed capture detail (harmless, worth knowing): captures may include formatted `[control: session changed …]` and `[control: queue update steering=N follow-up=N]` lines in addition to the trailing `[cursor: …]` line.

Additional probes beyond the 7 steps:

- **Quote-hostility**: with `PICTL_ID="it's a 'test' $id \`x\`"`the notify hook was correctly single-quoted, and a message containing`$(hostname)`, backticks, and mixed quotes round-tripped verbatim through spool →`sh -c`→`pictl prompt`.
- **Failed notify is non-fatal** (confirmed live): that fake manager id meant the hook's `pictl wait`/`prompt` failed on every completion; the result stayed ready and was taken by polling.
- **Error paths**: `cancel` on a ready job and `take` on a nonexistent inbox propagate docket's stderr and exit code; `XDG_DATA_HOME`+`HOME` both unset exits 1 with a clear message; all usage errors exit 2.

## Decisions captured (2026-06-28 discussion)

- Reframed away from "main agent is the loop" and from tag-based "teams": the abstraction is a per-owner **inbox** (docket) addressed by manager identity, cwd-agnostic. An agent can be a worker for many owners and own its own docket — graphs, no teams.
- The loop is _code_ (docket), never an agent; agents reason, code does deterministic plumbing.
- Push (wake the owner) is the goal for pi owners; pull is the graceful degradation for non-pictl owners. We will not cripple the pi design for the non-pictl case.
- The relay's cursor/drain machinery collapses because `pictl prompt` already blocks-and-captures a turn; docket multiplexes _processes_, not cursors.

## Decisions captured (2026-07-02, post-docket-build)

- Skill is a **new sibling** to `skills/pictl/` about communicating with a **team**; leading word "team"; docket is the hidden backend. `skills/pictl/SKILL.md` overhaul deferred. Still replaces the reviewer workflow.
- Dropped "secretary" (implies decision-making) for **team** (dumb queue / talking to your workers). The wrapper must **not** be named `docket` — that collides with the CLI it drives (PATH shadowing; the same verb meaning two different things).
- **Manager identity determines the inbox dir**: `--docket`/`$DOCKET_DIR` verbatim; else `$PICTL_ID` (notify wired); else `String(ppid)` (no notify). One signal (`$PICTL_ID`) picks both the key and whether push is wired.
- `ppid` chosen over the helper's own pid (fresh per call), cwd, and git state (both can change mid-session). Parent pid verified invariant across separate invocations.
- Robustness level **(a)**: read `$PPID` plainly; a piped/subshelled `team` call yields a harmless stray empty inbox; prose says don't pipe `team`.
- Notify gate `no-activity:1`; wake payload `docket ready`; inject `--streaming-behavior follow-up` (gate→inject busy race; document at the hook).
- `dispatch` spools the message to an absolute file and dispatches `pictl prompt -t <worker> - < <file>` — required because docket gives dispatched commands stdin `/dev/null`; also defeats two-layer-shell quoting.
- Capture: plain `pictl prompt`. Future experiment: cursor + `pictl tail --since` (captures other agents' turns with the worker).
- `team cancel` stops the _wait_, not the worker; `pictl abort -t <worker>` stops the worker.
- Wrapper implemented in **Node** (not bash), to avoid the very quoting hazards it exists to remove. Spawning workers stays raw `pictl`.
- Review confirmations (2bbf177): name = **team**; **full** front-end surface; direct-conversation echo **confirmed** a non-issue (only dispatched turns are captured); docket-graduation is out of scope for this spec.
- Packaging (2026-07-03): **not packaged with pictl** — an experimental skill that _uses_ pictl. Script at `skills/team/team`, invoked by path; dependency-free single Node script (no stricli/TS build) decided as the consequence.

## Decisions captured (2026-07-03 reviewer round)

Where these conflict with earlier decision entries above, these win (the SPEC section reflects them):

- Dispatched command gains `--streaming-behavior follow-up`: without it a prompt to a mid-turn worker is rejected by the pi RPC, so a second dispatch to a busy worker would capture an immediate error instead of queuing. No-op on idle workers.
- Added `shellQuote`; every interpolated token in `sh -c` strings (agent ids, message-file path) is quoted. Message _content_ still never passes through a shell.
- Kept the trailing formatted `[cursor: …]` line in captured output — "no cursors" only ever meant no `tail --since` drain machinery; the cursor line is harmless and feeds that future experiment.
- ppid-fallback caveat strengthened: implementation uses `process.ppid`; pipelines, subshells, _and command substitution_ mis-derive the inbox, and a mis-derived `dispatch` loses work (not harmless). Prose: plain simple commands only; never `$(team …)` under the fallback.
- CLI grammar pinned: `--docket <dir>` recognized anywhere in argv; unknown flags/subcommands/arity are usage errors. Error policy: fail fast to stderr — usage errors exit 2, runtime errors exit 1; child failures propagate the child's exit code; error if `$XDG_DATA_HOME` and `$HOME` both unset.
- Notify hook keeps `;` (not `&&`) deliberately: attempt delivery even if the quiet-gate wait fails; a failed notify is non-fatal (results stay ready).
- Shared inboxes declared unsupported in v1; last `team start` with `$PICTL_ID` wins the notify hook.
- PATH assumption documented: `docket` and `pictl` must be on PATH where `team` runs and where docket's daemon runs hooks/jobs.
- Busy-worker capture semantics verified against pi's agent-session (round 2): queued follow-ups drain _before_ `agent_end`, so a busy-worker dispatch is never truncated; the capture does include the tail of the in-flight turn (and interleaves when several dispatches queue on one worker). Documented, not designed away — extra context, never lost replies.
- `dispatch` always requires `<dataHome>` for its message spool, even with explicit `--docket` (we never spool into the docket dir — docket owns that layout). Usage errors exit 2, matching docket/pictl; runtime errors exit 1; child exit codes propagate. `shellQuote` pinned to exact POSIX single-quoting.

## Decisions captured (2026-07-03 user review)

Where these conflict with earlier decision entries above, these win (the SPEC section reflects them):

- **Removed the `--docket`/`$DOCKET_DIR` override entirely** (former resolution case 1). The inbox is always identity-derived; an escape hatch undermines the wrapping `team` exists to provide, and honoring `$DOCKET_DIR` would be a hazard — docket sets it for jobs/hooks and env inherits through spawns, so a leaked `DOCKET_DIR` would glue an agent to its manager's inbox: a team member couldn't make its own team. Debugging/inspection of another manager's inbox uses raw `docket --docket <dir>`; `team start` prints the dir. Consequences: `team` takes no flags at all; the shared-inbox caveat collapses to "unsupported, no way to express it"; `TeamEnv` drops `DOCKET_DIR`; all signatures drop the `flags` parameter; `<dataHome>` is unconditionally required.
