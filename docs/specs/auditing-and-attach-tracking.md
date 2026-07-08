# SPEC

## Problem

There is no record of who is mutating an agent, and no way to tell whether
somebody is interactively attached to it. Both matter when several parties
(humans, claude instances, pi agents, scripts) work with the same agent: an
audit trail explains how an agent got into its current state, and live attach
state is important context for scripted operations (e.g. `navigate-tree` from
a script while a human is watching).

This spec addresses `docs/thoughts/auditing.md` and
`docs/thoughts/attach-tracking.md`. Remove those files on completion of this
spec.

1. **Auditing**: every audited pictl CLI command targeting an agent appends a
   JSONL event to `<agent-dir>/audit.jsonl`, attributed to a *caller source* —
   a stable identifier for the managing process (a pi agent id, a claude
   instance, an interactive shell). Metadata describing each observed
   pid-based source is kept in `<agent-dir>/sources.jsonl`.
2. **Attach tracking**: the daemon tracks tty.sock clients. Clients identify
   themselves with a new `hello` frame; the daemon maintains the current
   attachment list in `agent.json` and records attach/detach events in the
   audit log.

Auditing is cooperative, not a security boundary: all parties are same-user
(sockets are 0600), and a same-user process can always talk to pi.sock
directly. The goal is understanding, not enforcement.

## Definitions

**Caller source** (`CallerSource`): a string identifying who a command or
attachment came from.

- `pictl:<agent-id>` — the caller has `PI_AGENT_ID` in its environment, i.e.
  it is (a descendant of) a pictl-managed pi agent. Stable across that
  agent's process restarts.
- `<comm>:<pid>` — otherwise, the *manager process* found by walking up the
  `/proc` ancestry past shells (adapted from `walkToManagerPid` in
  `skills/team/team`): starting from the caller's parent, ascend while the
  process is a shell (`bash`, `sh`, `zsh`, `dash`, `fish`, `ksh`), stopping
  at the first non-shell process or at an interactive shell (session leader
  with a controlling tty). `<comm>` is that process's `/proc/<pid>/comm`;
  examples: `claude:12345`, `codex:4242`, `bash:9876`. This makes many
  commands issued through one claude instance's bash tool (fresh shell per
  call) share one source.
- `process:<pid>` — fallback when `/proc` is unavailable (non-Linux): the
  caller's parent pid, with no metadata.

**Audited command**: a pictl CLI route marked `audited: true`. The audited
routes are exactly:

- RPC passthroughs: `prompt`, `steer`, `follow-up`, `abort`, `new-session`,
  `set-model`, `cycle-model`, `set-thinking-level`, `cycle-thinking-level`,
  `set-steering-mode`, `set-follow-up-mode`, `compact`,
  `set-auto-compaction`, `set-auto-retry`, `abort-retry`, `bash`,
  `abort-bash`, `switch-session`, `fork`, `clone`, `navigate-tree`,
  `set-session-name`
- Lifecycle: `spawn`, `resume`, `suspend`, `archive`, `purge`

Not audited: `get-*`, `export-html`, `wait`, `tail`, `list`, `status`, `gc`,
`format`, `completion`, and `attach` (attach is recorded by the daemon as
attach/detach events instead — one implementation that also covers
non-pictl tty.sock clients).

## Success criteria

- `pictl prompt -t a1 "hi"` from an interactive shell appends
  `{"ts":"...","source":"bash:9876","argv":["prompt","-t","a1","hi"]}` to
  `<agent-dir>/audit.jsonl`, and (first time only) a line
  `{"source":"bash:9876","firstSeen":"...","comm":"bash","cmdline":[...]}` to
  `<agent-dir>/sources.jsonl`.
- The same command issued via a claude instance's bash tool is attributed to
  `claude:<claude-pid>`; multiple commands through the same claude instance
  share that source.
- The same command issued from a pictl-managed pi agent's bash tool is
  attributed to `pictl:<agent-id>` and adds no sources.jsonl line.
- Audit events record *attempts*: one line per audited invocation, written
  after target resolution and before the command executes, with no outcome
  field. A multi-target command writes one line per target's agent dir.
- Read-only commands (`get-state`, `tail`, ...) write nothing.
- `PICTL_AUDIT=off` (or `0`) disables audit writes by the process that would
  write them: the CLI honors the invoking environment, the daemon honors its
  own (spawn-time) environment for attach/detach events. Everything else
  behaves identically.
- `pictl attach` sends a `hello` frame; while attached, the agent's
  `agent.json` contains
  `attachments: [{pid, client, connectedAt, size?}]`, updated on hello,
  resize, and disconnect. On disconnect the entry is removed.
- Attach and detach append `{"ts":"...","source":"...","event":"attach",
  "pid":...}` / `"event":"detach"` lines to audit.jsonl, with source computed
  by the daemon from the hello-reported pid.
- A tty.sock client whose first client-to-server frame is not `hello` is
  disconnected (no backward compatibility with old attach clients).
- Concurrent appenders (multiple CLI processes, the daemon) never corrupt
  the JSONL files.

## Type design

### `src/core/audit.ts` (new module)

```ts
/** "pictl:<agent-id>" | "<comm>:<pid>" | "process:<pid>" — see Definitions. */
export type CallerSource = string;

export interface ManagerInfo {
  pid: number;
  comm: string;
  cmdline: string[];
}

/**
 * piAgentId wins ("pictl:<id>", no manager); else walk /proc ancestry from
 * ppid ("<comm>:<pid>" with manager metadata); else fallback
 * ("process:<ppid>", no manager).
 */
export function resolveCallerSource(
  piAgentId: string | undefined,
  ppid: number,
): { source: CallerSource; manager?: ManagerInfo };

/**
 * The same resolution for another live process (the daemon's view of a
 * tty.sock client): PI_AGENT_ID from /proc/<pid>/environ, walk from that
 * pid's ppid (from /proc/<pid>/stat). Falls back to "process:<pid>" when
 * /proc is unavailable.
 */
export function resolveCallerSourceForPid(
  pid: number,
): { source: CallerSource; manager?: ManagerInfo };

export interface AuditCommandEvent {
  ts: string;
  source: CallerSource;
  argv: string[];
}

export interface AuditAttachEvent {
  ts: string;
  source: CallerSource;
  event: "attach" | "detach";
  pid: number;
}

export type AuditEvent = AuditCommandEvent | AuditAttachEvent;

export interface SourceRecord {
  source: CallerSource;
  firstSeen: string;
  comm: string;
  cmdline: string[];
}

/** False when env.PICTL_AUDIT is "0" or "off"; true otherwise. */
export function auditEnabled(env: NodeJS.ProcessEnv): boolean;

/**
 * Append event to <agentDir>/audit.jsonl (O_APPEND). If manager is present
 * and its source has no line in <agentDir>/sources.jsonl yet, append a
 * SourceRecord. Callers check auditEnabled first.
 */
export async function recordAuditEvent(
  agentDir: string,
  event: AuditEvent,
  manager?: ManagerInfo,
): Promise<void>;
```

Internal (not exported): the shell-skipping ancestry walk adapted from
`skills/team/team` `walkToManagerPid`, and `/proc` readers (`comm`, `stat`,
`cmdline`, `environ`).

### `src/core/registry.ts`

```ts
export function auditLogPath(agentDir: string): string;   // <agentDir>/audit.jsonl
export function sourcesLogPath(agentDir: string): string; // <agentDir>/sources.jsonl

export interface AgentRecord {
  // ...existing fields...
  /**
   * Live tty.sock attachments. Daemon-owned: reset to [] on daemon startup,
   * kept in sync while running, cleared on clean shutdown. Optional because
   * agent.json files written before this feature lack it. Meaningless
   * unless the daemon is alive (a crash leaves stale entries) — readers must
   * ignore it for non-running agents.
   */
  attachments?: AttachmentInfo[];
}
```

`AttachmentInfo` is defined in `tty-server.ts` (it is the server's view of a
client) and type-imported here; the reverse import would couple the
intentionally pictl-free tty-server to the registry.

### `src/core/tty-protocol.ts`

```ts
export const FrameType = {
  input: 1,
  resize: 2,
  snapshot: 3,
  output: 4,
  exit: 5,
  hello: 6, // client → server, required first client frame
} as const;

export interface HelloPayload {
  pid: number;
  /** Free-form client description, e.g. "pictl attach". */
  client: string;
}

export function encodeHello(hello: HelloPayload): Buffer;
/** Throws on malformed payloads; the receiver should drop the connection. */
export function decodeHello(payload: Buffer): HelloPayload;
```

`attach.ts` sends `hello` immediately after connect, before its initial
`resize`.

### `src/core/tty-server.ts`

```ts
export interface AttachmentInfo {
  pid: number;
  client: string;
  connectedAt: string; // ISO 8601, like AgentRecord.createdAt
  size?: ResizePayload;
}

export interface TtyServerHooks {
  // ...existing serializeScreen/writeInput/resize...
  /** A client completed hello. */
  onAttach(info: AttachmentInfo): void;
  /** A helloed client disconnected. */
  onDetach(info: AttachmentInfo): void;
  /** Attachment list changed (hello, resize, or disconnect). The array is a
   * fresh snapshot; implementations may keep it but must not mutate it. */
  onAttachmentsChanged(attachments: AttachmentInfo[]): void;
}
```

`AttachClient` gains `hello?: HelloPayload` and `connectedAt`. A client that
sends `input` or `resize` before `hello`, or a malformed `hello`, is dropped.
Clients that never hello are invisible to hooks; they still receive the
snapshot and output until dropped — the snapshot-on-connect server-to-client
flow is unchanged, and tracking begins at hello. A client that never sends
any frame can thus observe passively without appearing in `attachments`:
accepted, attach tracking is cooperative, not enforcement.

Hooks are synchronous and fire-and-forget from tty-server's perspective;
implementations wrap their own async work. `dropClient` is registered on
both `close` and `error`, and `destroy()` re-triggers `close`, so `onDetach`
must fire only when `clients.delete(client)` returns true and the client had
helloed. `shutdown()` bypasses `dropClient` and emits no detach hooks — the
daemon's exit is itself the boundary.

### `src/core/cli.ts` and `src/core/targets.ts`

```ts
interface CommandSpec<FLAGS, ARGS> {
  // ...existing common/docs/parameters/func...
  /** Marker: write an audit event to each target before func runs. */
  audited?: true;
}

export interface CommandContext extends StricliCommandContext {
  // ...existing process/env/targets...
  /** CLI argv as passed to runCliApp (subcommand and args, verbatim). */
  argv: readonly string[];
}
```

`commandOneTarget` / `commandMultiTarget` wrappers: after `resolveTargets`,
if `spec.audited` and `auditEnabled(env)`, call
`resolveCallerSource(env.PI_AGENT_ID, process.ppid)` once and
`recordAuditEvent` for each target's agentDir, then invoke `spec.func`.
`runCliApp` stores argv on the context.

`spawn` (a no-target command; the agent dir does not exist until
mid-command) calls `recordAuditEvent` itself right after creating the agent
dir.

### Daemon (`src/core/daemon.ts`)

Implements the three new hooks:

- `onAttach`/`onDetach`: when `auditEnabled(process.env)`,
  `resolveCallerSourceForPid(hello.pid)` and `recordAuditEvent`. Computing
  the source daemon-side keeps foreign tty.sock clients trivial (they report
  only their pid) and identity logic in one implementation. Failures are
  logged to daemon.log and otherwise ignored — attach auditing never kills
  the daemon.
- `onAttachmentsChanged`: update `record.attachments` and `writeAgentRecord`.

On startup the daemon writes `attachments: []`; on clean shutdown it clears
the list.

## Edge cases

- **Concurrent writers**: audit.jsonl and sources.jsonl are opened with
  append flag (`"a"`); each event is a single `write` of one line, which is
  atomic for O_APPEND writes of this size on local filesystems.
- **sources.jsonl duplicate lines**: dedup is read-before-append; two
  concurrent first observations of the same source can both append. Readers
  dedup by `source`; duplicates are harmless.
- **comm is not a clean token**: `/proc/<pid>/comm` is arbitrary (≤15 bytes,
  may contain spaces or colons). The pid after the *last* `:` in a source
  string is still unambiguous; sources.jsonl carries the full cmdline.
- **PID recycling**: a `<comm>:<pid>` source is only meaningful near its
  observation time; sources.jsonl's `firstSeen` plus captured metadata is the
  durable record. Accepted.
- **argv contains prompt text**: intended — the audit log should show what
  was done. No redaction. With stdin input (`pictl prompt -`), argv records
  the literal `-`, not the piped text: long inputs stay out of the log, and
  the content is in the session file if ever needed.
- **purge**: writes its audit line, then deletes the agent dir including the
  logs. The audit trail dies with the agent. Accepted. Auditing purge still
  pays off exactly when it's interesting: purge waits for idle and can fail
  ("still busy; not purged"), and it's multi-target, so a failed target keeps
  its dir — and with it the record of the attempted purge.
- **Audit write failures**: in the CLI, errors propagate and fail the
  command loudly (a missing agent dir means the command could not have
  worked anyway). In the daemon, attach-audit failures are logged to
  daemon.log and otherwise ignored.
- **Stale attachments after daemon crash**: readers must ignore
  `attachments` unless the agent is `running`.
- **Daemon audit toggle is frozen at spawn**: the daemon's environment is
  captured when the agent is spawned/revived, so `PICTL_AUDIT=off` at spawn
  time disables attach/detach auditing for that daemon's whole lifetime,
  regardless of later CLI settings.
- **Implicit revival**: sending an audited command to a dormant agent
  revives it via `ensureAgentRunning`; only the command itself is audited,
  with no separate `resume` line. Accepted — the command line explains the
  revival.
- **Non-Linux**: no `/proc`; CLI sources degrade to `process:<ppid>` and
  attach sources to `process:<pid>` (the hello pid), with no sources.jsonl
  metadata. Attach tracking in agent.json (pid, client, size) still works —
  it needs no `/proc`.

## Non-goals

- No security or enforcement; auditing is cooperative and bypassable.
- No auditing of direct pi.sock clients that are not the pictl CLI.
- No log rotation or retention policy; logs die with the agent dir.
- No outcome/duration recording; attempts only.
- No attachment history in agent.json (history lives in audit.jsonl).
- No verification of hello-reported pids.
- No CLI command to view/format the audit log (can be added later).

# IMPLEMENTATION IDEAS

- **Why the CLI writes audit records (not the daemon)**: RPC commands go
  straight from the CLI to pi.sock (`rpc-commands.ts` `sendRpc`); the daemon
  never sees them. Routing RPC through the daemon just for auditing would be
  a large rearchitecture for no security gain (same-user can bypass
  regardless).
- **Choke point**: `commandOneTarget`/`commandMultiTarget` in `cli.ts` is
  where targets are resolved for every agent-targeted command; each route
  still opts in with `audited: true`, and `spawn` (no-target) is
  special-cased.
- **Ancestry walk**: adapt `walkToManagerPid` from `skills/team/team:57`
  (shell-name set, stat parsing after the last `)`, interactive-shell stop
  rule requiring session leadership *and* a controlling tty). The
  `--bg-spare`/`daemonized` detection is team-specific and not needed here.
  The skill is a standalone script and cannot import from src/, so the logic
  is duplicated knowingly; consider extracting later if a third user appears.
- **PI_AGENT_ID**: set for pi processes by the daemon (`daemon.ts:97`) and
  inherited by their bash subprocesses, which is how pictl invocations from
  a pi agent's tools get the `pictl:` source.
- **Reading a peer's env**: `/proc/<pid>/environ` is the exec-time
  environment — exactly the inherited env we want, readable same-user.
- **Why a hello frame instead of SO_PEERCRED**: Node does not expose
  SO_PEERCRED without a native addon. Self-reported pids are fine for a
  cooperative mechanism.
- **agent.json write frequency**: attach/detach/resize each trigger an
  atomic `writeAgentRecord`. Resize storms during a drag are brief and
  writes are cheap (temp file + rename); no debouncing needed.
- **Timestamps**: `new Date().toISOString()` everywhere (`ts`, `firstSeen`,
  `connectedAt`).

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

*Work log entries go here*
