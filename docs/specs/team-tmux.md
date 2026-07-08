# SPEC

> **Status: implemented; acceptance test passed (2026-07-06).** This spec amends the `team` script from [docket-integration.md](docket-integration.md) (shipped, acceptance-tested). It is self-contained for the changes it makes; v1 behavior it does not mention is unchanged.

## Problem

`team` v1's non-pi tier (no `$PI_AGENT_ID`) has two limits, both observed live (2026-07-04, this repo's own sessions):

1. **Identity is fragile.** The inbox key is `process.ppid` — the invoking shell. In harnesses that give every tool call a fresh shell (Claude Code's Bash tool, verified), each call derives a *different* inbox, so multi-step `team` flows must fit inside a single shell invocation. Pipelines, subshells, and `$(team …)` mis-derive for the same reason.
2. **No push.** Non-pi managers poll. But a terminal-resident agent (pi, claude, or codex running in a tmux pane) has a perfectly good delivery channel: text typed into its pane arrives as a user message.

Both fixes live entirely inside the `team` script; pictl and docket are untouched.

## Change 1 — identity: ancestry walk

Replace the case-2 key `String(ppid)` with `String(walkToManagerPid(ppid))`:

Starting at `ppid`, **ascend past harness shells**; the key is the pid where the walk stops. Precisely, for the current pid: stop if its `comm` is not in `bash|sh|zsh|dash|fish|ksh`; stop if it is a session leader *with a controlling tty* (`sid == pid && tty_nr != 0`, both from `/proc/<pid>/stat`); stop if its parent pid is ≤ 1; otherwise ascend to its parent and repeat. If `/proc` is unreadable (non-Linux), return `ppid` unchanged — exact v1 behavior.

Why this exact rule (each clause is load-bearing, established empirically 2026-07-05):

- **Name-free.** The obvious rule — "walk until you find a `pi`/`claude`/`codex` process" — fails in precisely the harness that needs the walk: the observed ancestry was `bash → '2.1.195' (--bg-spare) → '2.1.195' (--bg-pty-host) → claude (daemon)`. The session-scoped ancestors carry a version-string name, and the only `claude`-named ancestor is a **daemon shared by all background sessions** — keying on it would merge their inboxes. Stopping at the first non-shell lands on the `--bg-spare` process: verified stable across separate tool calls, and per-session (different claude instances show different `--bg-spare` processes). (`2.1.195` *is* claude — `~/.local/bin/claude` is a symlink to `…/claude/versions/2.1.195` — which is exactly why name matching is untrustworthy: the kernel-visible name is whatever the binary happens to be called, here a version string.)
- **Interactive-shell stop (session leader + controlling tty).** A human driving `team` from an interactive shell should keep that shell as identity (per-pane, matching v1). Session leadership alone does not identify one: the daemonized harness's ephemeral tool-call bash is *also* a session leader (verified live 2026-07-06 — a leader-only stop halted the walk at the fresh shell, keeping identity per-call fragile and hiding `--bg-spare` from detection). The controlling tty is the discriminator: interactive shells are session leaders *with* a tty (`pts/N`), harness shells have `tty_nr = 0`. Walking past an interactive shell would reach the tmux *server* — one process shared by every pane (and even if reached, its comm `tmux: server` is not a shell, so the walk stops there too). Ephemeral `sh -c` wrapper shells are not session leaders and are correctly skipped either way.
- **Consequences.** Fresh-shell-per-call harnesses get a stable inbox across calls; pipelines/subshells/`$(team …)` no longer mis-derive (their extra shell layers are skipped), retiring that v1 hazard on Linux.

## Change 2 — notify: tmux tier

New `notifyHook` resolution order:

1. `$PI_AGENT_ID` set → the v1 pictl hook. **Unchanged.**
2. else, if a tmux pane is discovered (below) → the tmux hook.
3. else → no hook; the manager polls. **v1 behavior.**

### Pane discovery (notify only — never identity)

One automatic route, one explicit route (revised per user review 2026-07-06):

1. **Env route (automatic):** `$TMUX` and `$TMUX_PANE` both set in `team`'s own environment. Pane = `$TMUX_PANE`; server socket = the first comma-field of `$TMUX` (baked as `tmux -S <socket>` so the hook works from docket's daemon, whose env has no `$TMUX`).
2. **Explicit route (daemonized claude):** see "Daemonized-claude detection" below — the agent asks the user and re-runs `team start --pane <target>` (or `team start --no-notify`).

**Why not read `TMUX`/`TMUX_PANE` from ancestor environs during the walk:** an environ is a snapshot from process launch — hearsay about where the agent lives *now*. Verified hazard: the shared claude daemon's environ carried `TMUX_PANE=%146` — the pane the daemon happened to be started from long ago, which at test time was a *live, unrelated claude session*; delivering there would have injected messages into it, and the allowlist guard cannot catch that case (`pane_current_command` is `claude`). Structurally, a daemonized claude's exec ancestry runs through the daemon, not through the "window" process the user interacts with — that window is a separate client process tree connected to the daemon over IPC, so no kernel-visible link (ancestry, environ, or controlling tty — tool-call shells have none, verified `ps -o tty=` → `?`) leads from `team`'s process to the correct pane. **We therefore do not attempt automatic pane resolution for daemonized claudes** (decision 2026-07-06).

### Daemonized-claude detection

When `team` must create the docket (`start`, or a `dispatch` whose derived docket does not yet exist) and case 2 applies (no `$PI_AGENT_ID`), and the ancestry walk passed a process whose cmdline contains `--bg-spare`, and no pane is known (no env route, no explicit flag): **do not create the docket**. Exit 1 with instructions telling the agent to ask the user for the pane identifier and re-run (the printed instructions spell the command with the script's absolute path — `team` is not on `PATH`, so bare `team start` would fail if retyped literally; reviewer finding 2026-07-06):

- `team start --pane <target>` — bake the tmux hook for `<target>` (a tmux pane id like `%133` or target like `muninn:0.0`, passed verbatim as the hook's `-t` argument, default server);
- `team start --no-notify` — create the docket with no hook; the manager polls.

Once the docket exists, subsequent `start`/`dispatch` calls need no flag: the hook is installed only at docket **creation** (or re-wired by an explicit `start --pane`); flag-less calls never pass `--notify`, and docket preserves the hook in that case, so the choice — including `--no-notify` — persists with no extra state (revised per user review 2026-07-07; v1 re-installed the hook on every call, which would have silently undone `--no-notify` at the next flag-less `dispatch`). Consequences: hook text no longer auto-upgrades when team changes (the v1 pi-refresh nicety is dropped), and `--no-notify` cannot *clear* an already-installed hook. These are the **only flags `team` accepts**, `start`-only — a deliberate, narrow amendment of v1's "no flags" rule. The explicit pane is notify-only and is never inherited implicitly (nothing is read from env for it), so the v1 `DOCKET_DIR`-style leak hazard does not arise.

Tmux information is deliberately **never used for the inbox key.** A non-tmux terminal (no `$TMUX`, no `--bg-spare` ancestor) still gets a poll-only docket automatically — exact v1 behavior.

### The tmux hook

The guard/gate/paste mechanics live in a `tmux-notify` sh script shipped in the skill directory (revised per user review 2026-07-07 — originally an inline `sh` string). The baked hook is a one-line invocation by **absolute path** (docket runs hooks from its own environment, so nothing relative or PATH-based is reliable; if the skill directory moves, stale hooks fail silently and results stay pollable):

```sh
'<skill-dir>/tmux-notify' [-S '<socket>'] '<pane>'
```

The script (`<pane-target>` from `$1`; `-S <socket>` prepended to every tmux call when given; buffer name suffixed with the script's `$$` to avoid collisions):

```sh
cmd=$(tmux display-message -p -t "$target" '#{pane_current_command}') || exit 0
case "$cmd" in pi|claude|codex) ;; *) exit 0 ;; esac
prev='__sentinel__'; i=0
while [ "$i" -lt 600 ]; do
  cur=$(tmux capture-pane -p -t "$target") || exit 0
  [ "$cur" = "$prev" ] && break
  prev=$cur; i=$((i + 1)); sleep 1
done
cmd=$(tmux display-message -p -t "$target" '#{pane_current_command}') || exit 0
case "$cmd" in pi|claude|codex) ;; *) exit 0 ;; esac
docket ready | tmux load-buffer -b "team-notify-$$" -
tmux paste-buffer -p -d -b "team-notify-$$" -t "$target"
tmux send-keys -t "$target" Enter
```

- **Guard:** deliver only if the pane still runs an interactive agent: `pane_current_command` in `pi|claude|codex`. Not `node`: plain `pi` reports as `pi` (verified), and the one agent that reports `node` — a `pictl attach` client — has `$PI_AGENT_ID` set and never reaches this tier. A stale hook whose pane has dropped back to a shell is blocked here (delivering would *execute* the payload). The guard is re-checked after the quiet gate (reviewer finding 2026-07-06): the gate can wait minutes, and the initial check would be stale by delivery time.
- **Quiet gate:** full-screen `capture-pane` once per second until two consecutive captures are identical; cap 600 iterations, **deliver anyway at the cap** (decision 2026-07-06). Full-screen matters: partial captures can look static mid-turn (observed with `tail -5`), while the full screen churns every second (spinner glyph, timer, token counter — verified even during a quiet `sleep` tool call, so early fire requires the animation to repeat a frame across consecutive captures).
- **Early fire accepted** (decision 2026-07-06): if it happens, the wake lands as a queued user message — disruptive, never lost.
- **Delivery:** `load-buffer` + `paste-buffer -p` (bracketed paste; multi-line payload arrives intact and is never shell-parsed by `send-keys`), then `send-keys Enter` to submit. Verified end-to-end against a live Claude Code pane (2026-07-05): held while streaming, delivered a two-line payload as a clean user message once quiet.
- Wake payload is `docket ready`, matching the pictl tier. Every tmux failure exits the hook; a failed notify is non-fatal by docket's design (results stay ready for polling).
- **Accepted limitation:** agent subprocesses inheriting the manager's `$TMUX`/`$TMUX_PANE` (e.g. an agent launching another agent in the same pane) would discover the same pane via the env route; their wakes interleave into one pane. Same-pane nesting is not a supported topology.

## Success criteria

- A pi/claude/codex agent running **directly in a tmux pane** without `$PI_AGENT_ID` is woken — the ready menu is typed into its own session after it goes quiet — with zero configuration.
- In a **fresh-shell-per-call harness** (Linux), the inbox is stable across separate tool calls, and `$(team …)`/pipelines derive the same inbox as a plain call.
- A **daemonized claude** (a `--bg-spare` ancestor) is *stopped at docket creation* and told to ask its user for a pane, then `team start --pane <target>` wires push into that pane, or `team start --no-notify` opts into polling. No *automatic* route can pick a wrong pane (the env route reads the manager's own `$TMUX_PANE`); an explicit `--pane` is trusted as given, with the hook's pane guard as the only backstop against a mistyped target.
- A **non-tmux terminal** (no `$TMUX`, no `--bg-spare` ancestor) gets a poll-only docket automatically — exact v1 behavior.
- The pi tier (`$PI_AGENT_ID`) is byte-for-byte unchanged.

## Type Design

Approved 2026-07-06. Everything not listed (`keyHash`, `shellQuote`, the six subcommands) is untouched; `start`/`dispatch` pick up the new behavior through `resolveDocketDir`/`notifyHook`. `ensureDocket` gains `(dir, env, opts)` and installs the hook only when creating the docket or when `opts.pane` is set (revised 2026-07-07).

```ts
interface TeamEnv {
  PI_AGENT_ID?: string;
  XDG_DATA_HOME?: string;
  HOME?: string;
  TMUX?: string;       // "socket,pid,session" — socket = first comma-field
  TMUX_PANE?: string;  // e.g. "%133"
}

interface ManagerInfo {
  pid: number;        // where the walk stopped — the inbox key
  orphaned: boolean;  // walk hit parent <= 1: error, do not create a docket
  daemonized: boolean; // manager runs under a daemonized harness (current
                       // heuristic: a walked-past ancestor's cmdline contains
                       // --bg-spare)
}

// Ancestry walk (Linux /proc). Starting at startPid, ascend while the process
// is a shell (comm in bash|sh|zsh|dash|fish|ksh) that is NOT an interactive
// shell (session leader with a controlling tty: sid == pid && tty_nr != 0)
// and has a parent > 1. If /proc is unreadable (non-Linux),
// return { pid: startPid, orphaned: false, daemonized: false } (v1 behavior).
function walkToManagerPid(startPid: number): ManagerInfo;

// UNCHANGED SIGNATURE; case 2 now keys on walkToManagerPid(ppid).pid.
function resolveDocketDir(env: TeamEnv, ppid: number): string;

// Env route only: env.TMUX + env.TMUX_PANE, else undefined.
function tmuxPane(env: TeamEnv): { socket: string; pane: string } | undefined;

// One-line invocation of the skill-shipped tmux-notify script by absolute
// path, all values shellQuoted; `-S <socket>` passed when the socket is known
// (env route), omitted otherwise (explicit --pane route, default server).
function tmuxNotifyHook(socket: string | undefined, pane: string): string;

interface StartOpts {
  pane?: string;      // --pane <target>: bake the tmux hook for this target
  noNotify?: boolean; // --no-notify: create the docket with no hook
}

// Resolution order: opts.noNotify -> undefined (explicit choice beats all);
// else PI_AGENT_ID -> pictl hook (unchanged); else opts.pane -> tmux hook;
// else tmuxPane(env) -> tmux hook; else undefined (poll).
// opts comes from start's flags; {} elsewhere.
function notifyHook(env: TeamEnv, opts: StartOpts): string | undefined;

// start gains the two flags; all other subcommands take none. Docket-creating
// paths (start, and dispatch when the derived docket does not yet exist) first
// check walkToManagerPid: orphaned -> error exit 1; daemonized with no pane known
// (no opts.pane/noNotify, no env route) -> error exit 1 with re-run
// instructions (see Daemonized-claude detection).
function start(env: TeamEnv, ppid: number, opts: StartOpts): void;
```

Dependencies: `notifyHook` → `tmuxPane` + `tmuxNotifyHook` (and the existing pictl-hook path); `tmuxNotifyHook` → `shellQuote`; `resolveDocketDir` → `walkToManagerPid` + `keyHash`.

## Edge cases

- Walk reaches an orphan (parent ≤ 1): **error, exit 1** (per user review 2026-07-06) — an orphaned-shell identity would key a docket nobody can re-derive; failing loudly beats creating an inaccessible inbox.
- The shell list is pinned to `bash|sh|zsh|dash|fish|ksh`; an unlisted shell stops the walk early — the key is merely less stable, never wrong-inbox across managers.
- Multiple tmux servers: the env route carries its socket; an explicit `--pane` targets the default server.
- Pane closes mid-gate: `capture-pane` fails → hook exits → poll still works.
- Hook stickiness: flag-less `start`/`dispatch` never pass `--notify` (the hook is installed only at creation or by an explicit `start --pane`), and docket preserves the hook when `--notify` is absent — so a previously installed hook (whose guard blocks delivery if the pane is gone) or an explicit no-hook choice survives every later call.

## Non-goals

- No flags beyond `start`'s `--pane`/`--no-notify`, and no override env vars. Daemonized claudes get their pane from the user via those flags; automatic resolution for them is explicitly out (no kernel-visible link exists).
- tmux state never influences the inbox key.
- No delivery channels beyond tmux (screen, kitty, wezterm remoting, etc.).
- No ancestry walk off Linux — `/proc` unreadable degrades to v1 `ppid`, so macOS keeps fresh-shell fragility and never fires daemonized detection. **Planned follow-up (separate spec):** a portable walk via `ps -o ppid=,comm=,sess=,tty= -p <pid>`, giving macOS stable identity and daemonized detection.
- No changes to pictl, docket, dispatch mechanics, or capture semantics.

# IMPLEMENTATION IDEAS

## Evidence from the derisking prototype (2026-07-04..06)

All of this was established against live sessions on `muninn`; the prototype hook script matched the SPEC's hook shape and delivered successfully into the authoring session's own pane.

- Mid-turn, full-screen captures differ every second (`✢ Scampering… (4m 50s · ↓ 16.1k tokens)` → `✻ … (4m 51s · ↓ 16.3k …)`); idle screens are static — the gate both holds and clears in practice (cleared after 15 captures in the live run, most spent correctly holding).
- `pane_current_command` observations: `claude` for a Claude Code pane; `pi` for plain pi (its `#!/usr/bin/env node` does not leak through); `node` only under `pictl attach`.
- Ancestry in the daemonized harness: `bash → '2.1.195' --bg-spare → '2.1.195' --bg-pty-host → 'claude' daemon`; the `--bg-spare` parent was identical across separate tool calls; tool-call shells have no controlling tty.
- The daemon's environ carried a *wrong, live* pane (`%146` vs actual `%133`) — the finding that killed env-inheritance discovery and any tmux-based identity.

## Implementation notes

- `/proc` parsing: `comm` from `/proc/<pid>/comm`; `PPid` from `/proc/<pid>/status`; session id is field 6 of `/proc/<pid>/stat` — parse *after* the last `)` to survive parens in comm.
- The two baked-comment obligations from v1 (why `--streaming-behavior follow-up` at hook and dispatch assembly) stay; add a third: why the guard allowlist excludes `node`.
- `skills/team/SKILL.md` needs a small update: push now also reaches terminal-resident agents in tmux; the non-pi caveat about `$(team …)` relaxes to non-Linux/edge cases. Keep it one or two lines — the skill stays mechanism-silent.

## Acceptance test sketch

1. **Env route, live:** run `team start` with `TMUX`/`TMUX_PANE` set to the test session's own pane; dispatch a worker task; verify the hook text in the docket's `notify` file matches the SPEC shape; verify the wake is typed into the pane after quiet.
2. **Explicit route:** in a daemonized-claude session, `team start` (no flags, no docket yet) errors with the ask-the-user instructions; `team start --pane <own pane>` then creates the docket and bakes the hook; a wake lands in the pane. `team start --no-notify` on a fresh identity creates a hookless docket.
3. **Walk stability:** two *separate* harness tool calls derive the same inbox; `x=$(<skill-dir>/team start)` derives the same inbox as a plain call.
4. **Non-tmux degradation:** with no tmux env and no `--bg-spare` ancestor, `team start` installs no hook and prints the same dir across calls (via the walk); polling works.
5. **Guard:** point a hook at a pane running plain bash; complete a job; verify nothing is typed (guard exits) and the result stays takeable.
6. **pi tier regression:** with `$PI_AGENT_ID` set, the baked hook is byte-identical to v1's.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Derisked with a live prototype (2026-07-04..06): quiet gate, guard, bracketed-paste delivery all verified against a real pane; wrong-pane env hazard demonstrated; ancestry shape and stability measured. Evidence recorded under IMPLEMENTATION IDEAS.
- [x] Type design approved by user (2026-07-06).
- [x] Implement `walkToManagerPid`; key case 2 on it in `resolveDocketDir`.
- [x] **Interactive-shell amendment (found during implementation, user-approved 2026-07-06).** Live testing on a daemonized-claude session showed its ephemeral tool-call bash is itself a *session leader* (`sid == pid`), so the originally-spec'd leader-only stop halted the walk at the fresh shell: identity stayed per-call fragile and `--bg-spare` was never seen, violating the SPEC's own success criterion ("inbox stable across separate tool calls"). The distinguishing signal, verified live: the harness shell has **no controlling tty** (`tty_nr = 0` in `/proc/<pid>/stat`), while every real interactive shell is a session leader *with* a tty (`pts/N`). Amended stop rule (now in the SPEC): a shell stops the walk only if it is a session leader **with a controlling tty**. Type design unaffected. Derisk-time evidence ("tool-call shells have no controlling tty") was already on record but its interaction with the session-leader clause was missed.
- [x] Implement `tmuxPane` / `tmuxNotifyHook`; extend `notifyHook` resolution.
- [x] Update `skills/team/SKILL.md` (push for terminal-resident agents; relaxed `$(team …)` caveat — Linux-only).
- [x] Run the acceptance test; record findings (below).

## Acceptance test results (2026-07-06)

Run on the daemonized-claude session itself, with `XDG_DATA_HOME` sandboxed per case. All six sketch cases pass:

1. **Daemonized detection (explicit route):** on a fresh identity, `team start` (and by inspection `dispatch`) exits 1 with the ask-the-user instructions and creates nothing. `team start --no-notify` creates a hookless docket; a later flag-less `team start` in a *separate tool call* prints the same dir with no error (stickiness + walk stability).
2. **Walk stability:** plain, `$(team start)`, and `team start | cat` all derive the identical dir — the pipeline/subshell hazard is retired on Linux.
3. **Hook shapes:** env route (`TMUX`/`TMUX_PANE` synthetic) bakes `tmux -S <socket>` throughout; `--pane` bakes bare `tmux`; both match the SPEC block byte-for-byte modulo quoting. pi tier (`PI_AGENT_ID` set) is byte-identical to v1.
4. **Live delivery end-to-end:** scratch tmux session running a fake `pi` (a copy of `cat`, so `pane_current_command` = `pi`); `team start --pane` + real worker dispatch → on turn end the hook fired, gate cleared, and the ready menu was pasted + submitted into the pane.
5. **Guard:** a second docket pointed at a `bash` pane received a completed job's notify; nothing was typed and the result stayed listed in `team ready` and takeable. (Same run also confirmed a job whose command exits non-zero still completes, notifies, and is takeable.)
6. **Non-tmux degradation:** a manager whose parent is a non-shell process without `--bg-spare` (node harness) gets a poll-only docket, no hook, exit 0.

Incident during testing, not a bug: sandboxing `XDG_DATA_HOME` also relocates pictl's agent registry, so a worker spawned under one sandbox was invisible to another ("no agent matches"). Real usage shares one data home.

## Post-review revisions (2026-07-07, user review of the implementation)

- [x] **Hook extracted to `skills/team/tmux-notify`** (user TDC: inline bash is ugly): the baked hook is now a one-line absolute-path invocation of the skill-shipped script; SPEC updated. Re-verified: hook shapes for both routes, `sh -n`, and live end-to-end delivery through the script into a scratch pane.
- [x] **`--no-notify` now overrides `$PI_AGENT_ID`** (user TDC, resolved 2026-07-07). The naive reorder alone would have been silently undone: v1's `ensureDocket` re-installed the hook on *every* `start`/`dispatch` (an upgrade-propagation nicety with no other purpose — user confirmed dropping it), so the paired change gates `--notify` to docket creation or an explicit `start --pane`. Verified live: pi-tier creation installs the hook; a sentinel written to `notify` survives flag-less `start`; `--pane` re-wires an existing docket; `--no-notify` with `$PI_AGENT_ID` creates hookless and *stays* hookless across later flag-less pi calls. Known limits (recorded in SPEC): hook text no longer auto-upgrades; `--no-notify` cannot clear an existing hook. Note `--pane` still does *not* override `$PI_AGENT_ID` (spec'd resolution order — pi agents have the better pictl channel).
- [x] **Spool made per-docket** (user request 2026-07-07): `<dataHome>/team/messages/<hash>/` instead of one shared `messages/` pool. Kept *beside* the docket dir, not inside it, honoring v1's "docket owns its directory's layout" constraint. v1 spec annotated as partially superseded (pointer at its top).
- [x] **Reviewer round 2 (2026-07-06, fresh-context reviewer via the skill itself — the dispatch/wake/take loop worked end-to-end on the daemonized `--pane` route):** accepted three findings: (1) tmux-notify's guard was stale by delivery time — the quiet gate can wait minutes — so the guard is re-checked immediately before delivery; (2) the daemonized error's re-run instructions said bare `team start`, which fails retyped literally since `team` is not on `PATH` — now printed with the script's absolute path; (3) the SPEC's "no delivery to a wrong pane is possible in any path" overclaimed — softened (an explicit `--pane` is trusted as given). Declined: documenting `--pane`/`--no-notify` in SKILL.md's command block — deliberate progressive disclosure; the error message is the single source of truth and the Caveats bullet points to it. Speculative concerns (no `--socket` escape hatch, walk's catch-all falling back to raw ppid, shell allowlist gaps) noted as known spec'd tradeoffs.
- [x] **`team gc` added (2026-07-08, user request; no separate spec — design agreed in conversation):** global cleanup across all inboxes under `<dataHome>/team/`. Cleanup split by ownership: `docket gc` (added to docket for this, with `docket status/ready --json`; see handoff docs in the docket repo) owns all age/state policy per inbox — old taken/canceled jobs, whole-docket deletion when stale — and `team gc` loops it over every inbox, forwarding `--dry-run`/`--older-than`, then deletes spool dirs (`messages/<hash>/`) with no sibling inbox. The sibling-existence rule composes with `--dry-run` for free (docket keeps the inbox, so team keeps its spool); pre-existing orphans honor dry-run explicitly. No identity machinery — works from any shell. Not documented in SKILL.md (user decision; near-term it is run manually). Verified in a sandbox data home: dry-run reports without deleting; a real run deletes stale inbox, its spool, and a pre-existing orphan in one pass.
- **macOS assessed (question during review):** dispatch/ready/take, the pi tier, and the whole tmux notify tier (env route, flags, hook) are portable; the ancestry walk is not — no `/proc`, so identity degrades to v1 `ppid` and daemonized detection cannot fire (a daemonized claude on macOS silently gets a fragile poll-only inbox). A portable walk via `ps -o ppid=,comm=,sess=,tty=` is possible future work, spec'd separately.

## Implementation-Time Decisions (2026-07-06)

- **`ensureDocket` gained an `opts` pass-through parameter** despite the type design listing it as untouched: its callee `notifyHook` now takes `(env, opts)`, and `ensureDocket` owns the `--notify` assembly, so it must forward `opts`. Callers: `start` passes its flags; `dispatch` passes `{}`.
- **`checkDocketCreatable(dir, env, ppid, opts)` private helper** holds the orphaned/daemonized creation guard. It has two callers (`start`, `dispatch`); the alternatives were duplicating ~10 lines or moving the guard into `ensureDocket` (listed as untouched).
- **Creation checks are skipped when the docket already exists** (for `start` too, not just `dispatch`): the SPEC's "once the docket exists, subsequent `start`/`dispatch` calls need no flag" requires it — an existing docket with a flag-less `start` must not re-trigger the daemonized error.
- **`--no-notify` short-circuits before the env route** in `notifyHook`: the flag means "no hook", so it must win even when `$TMUX`/`$TMUX_PANE` are present. It does not *clear* a previously installed hook (docket only rewrites `notify` when `--notify` is passed); it only creates hookless.
- **`--pane` and `--no-notify` are mutually exclusive** (usage error): the SPEC offers them as alternatives; accepting both silently would pick one arbitrarily.
- **`daemonized` is detected on every visited pid including the stop pid** — the `--bg-spare` process is where the (amended) walk *stops*, not one it walks past.

## Decisions captured (2026-07-06 user review of the written spec)

Where these conflict with the derisk entries below, these win (the SPEC reflects them):

- **Automatic pane resolution for daemonized claudes is abandoned** (user: the "window" claude the user interacts with is a separate client tree off the daemon; no kernel-visible link reaches it). The fd/tty route is dropped entirely.
- **Explicit-flag route added**: on docket *creation* in case 2, a `--bg-spare` ancestor with no known pane is an error instructing the agent to ask the user and re-run `team start --pane <target>` or `team start --no-notify`. These are `team`'s only flags, `start`-only; hook stickiness (docket preserves `notify` unless `--notify` is passed) persists the choice with no extra state.
- **Orphaned walk (parent ≤ 1) errors** instead of keying a docket that could never be re-derived.
- Noted: `2.1.195` is claude itself (symlink target) — reinforcing, not weakening, the name-free walk rationale.
- Type design updated accordingly (ManagerInfo, StartOpts, `notifyHook(env, opts)`, `start(env, ppid, opts)`) — re-approved 2026-07-06 (user directed implementation to proceed on the updated design; `bgSpare` renamed to `daemonized` per review).

## Decisions captured (2026-07-04..06 derisk)

- tmux is for **notify only**; identity comes from the ancestry walk. Env-derived tmux values from *ancestors* are hearsay (verified wrong-pane hazard); only `team`'s own env or the user's explicit word is trusted.
- The walk is **name-free** (first non-shell or session-leader-shell ancestor), amending the original walk-until-agent-name idea, which the `'2.1.195'`/shared-daemon evidence broke.
- Daemonized harnesses get **no notify — they poll**; no override flag/env (a leaked override would wire a sub-manager's wakes into its manager's pane, echoing the v1 `DOCKET_DIR` hazard).
- Gate cap **600 s, deliver anyway** at the cap.
- **Early fire accepted**: spinner churn makes it rare; a premature wake queues as a user message, never lost.
- Guard allowlist **`pi|claude|codex`** — no `node` (only `pictl attach` presents as `node`, and it has `$PI_AGENT_ID`).
- Delivery via **bracketed paste + Enter**, payload `docket ready`, buffer name uniquified.
