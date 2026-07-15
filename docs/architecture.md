# architecture

Purpose: explain how pictl works under the hood for contributors, AI agents, and future client authors. This is a **working design document**, not final user-facing documentation.

Question answered: **how does pictl work?**

## Big picture

pictl turns an interactive pi process into an agent that can be controlled through stable local protocols while remaining attachable as a terminal UI.

The main pieces are:

- a pi process, running normally in a PTY;
- a per-agent pictl daemon, launched as `pictl _daemon`;
- `pi.sock`, owned by pi, exposing pi's RPC protocol;
- `tty.sock`, owned by the daemon, exposing terminal attach;
- `PICTL_DIR`, a filesystem registry of agent directories;
- `pictl`, the CLI, which acts as the "shell SDK" for these protocols.

There is no central pictl daemon. Each agent has its own daemon process.

## Spawn flow

`pictl spawn` runs a daemon process which does these things:

- creates `$PICTL_DIR/<agent-id>/`, the "registry entry" for this agent
- runs `pi --rpc-socket <agent-dir>/pi.sock` inside a PTY
- serves `<agent-dir>/tty.sock`, which allows interactive attaching with `pictl attach`
- maintains terminal screen state for the PTY (resizes to the minimim dimensions of all attached clients)
- owns all metadata in `<agent-dir>/agent.json`, keeping it up to date (this is mainly just the mapping between agent id and pi session id, and the PIDs of pi and the daemon itself)

The daemon is solving roughly the same category of problem as tmux or persistent IDE terminals: a background process owns the terminal session, and frontends can connect and disconnect.

## The two sockets

The core protocol boundary is the split between `pi.sock` and `tty.sock`.

### `pi.sock`: semantic pi RPC

`pi.sock` is created and owned by pi. It is enabled by the pi-side `--rpc-socket` modification; see [`pi-modifications.md`](pi-modifications.md) for the pi-side changes.

The protocol is intended to be pi's normal RPC protocol over a Unix domain socket, with one socket-specific prelude: a hello record with protocol/version information. After that, clients send the usual pi RPC commands as JSONL.

This document does not re-document the pi RPC command surface. The working source reference is [`rpc-types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts). The pictl-specific architectural point is that `pi.sock` is for semantic operations, not terminal rendering.

### `tty.sock`: terminal attach

`tty.sock` is created and owned by the pictl daemon.

It exists because pi's RPC socket is not a terminal protocol. `pictl attach` needs a way to render the TUI, send keystrokes, handle resizes, and receive a current screen snapshot. That is a byte-stream terminal problem, not a semantic RPC problem.

The daemon therefore exposes a separate framed protocol on `tty.sock` for:

- client identification (a `hello` frame, the required first client frame);
- initial screen snapshot;
- PTY output;
- user input;
- terminal resize messages;
- daemon-exit notification.

The daemon tracks helloed clients as the agent's live attachments (in
`agent.json`) and records attach/detach events in the audit log; see
[`docs/specs/auditing-and-attach-tracking.md`](specs/auditing-and-attach-tracking.md).

The working definition of this protocol is [`src/core/tty-protocol.ts`](../src/core/tty-protocol.ts).

This separation is intentional. `pi.sock` is for meaning; `tty.sock` is for terminal bytes. Keeping them separate avoids forcing pi to know about remote terminal attach, and avoids overloading the RPC protocol with high-volume TTY data.

## Stable protocols, early implementation

The intention is that `pi.sock` and `tty.sock` are the stable integration points.

The project is still early, so details may change, but the architectural direction is:

- for semantic control over agents, prefer `pictl` as the shell SDK over `pi.sock`;
- for terminal attach, clients that need native terminal integration should speak to `tty.sock` directly.

pictl is meant to expose the full useful interface of `pi.sock` while centralizing registry lookup, daemon spawning, dormant-agent revival, conversion from events to durable session-entry streams, and wait/stop-condition logic. Other language SDKs for semantic agent control may simply wrap pictl to get a native feel in that language, as the Rust client's `Pictl` type does.

However, a rich terminal client cannot faithfully treat `pictl attach` as a reusable bidirectional byte-stream API. `pictl attach` assumes it owns a real local TTY: it switches raw mode, renders to stdout, handles resize signals, implements a detach key, restores terminal state, and exits the process on completion. A client could spawn it inside a PTY, but that is controlling another terminal frontend, not speaking the attach protocol. Native terminal clients should use `tty.sock`.

## `PICTL_DIR` as the registry

pictl persists the registry under `PICTL_DIR`, defaulting to the per-OS user data directory (via [`env-paths`](https://www.npmjs.com/package/env-paths), e.g. `~/.local/share/pictl` on Linux, `~/Library/Application Support/pictl` on macOS). The registry is the directory tree itself:

```text
$PICTL_DIR/
  <agent-id>/
    agent.json
    pi.sock
    tty.sock
    daemon.log
    audit.jsonl / sources.jsonl
    archive / tombstone / other marker files
```

There is no central registry daemon and no central index file. Commands discover agents by reading directories and probing processes or sockets.

`agent.json` is daemon-owned metadata. Its exact schema is not important for this document and is expected to evolve; the working source reference is [`src/core/registry.ts`](../src/core/registry.ts). The important invariants are:

- the daemon is the only writer;
- CLI commands do not use `agent.json` for locking or multi-process coordination;
- it records enough information to inspect, suspend, revive, and otherwise interact with the agent, including the pids of the daemon and pi processes;
- it records which pi sessions have been associated with this pictl agent, so a dormant agent can resume a useful session.

The actual session contents are pi's responsibility, not pictl's. `agent.json` records the association between a pictl agent and pi session files/ids; it does not record session messages.

Agent ids are also distinct from pi session ids. A single run of the pi binary can be associated with multiple pi sessions, for example after `/new`, `/resume`, `/fork`, or `/clone`. The pictl agent id names the long-lived controllable agent slot; pi session ids name conversation/session state within pi.

Marker files such as archive or tombstone markers represent CLI-owned lifecycle state that should not race with daemon ownership of `agent.json`.

## Lifecycle model

An agent is more than a running process. It is the agent directory plus its recorded lineage and metadata.

Important states:

- **idle/streaming**: daemon and pi processes are running; sockets should be reachable.
- **dormant**: agent directory exists, but the daemon/pi processes are gone.
- **archived**: dormant and hidden from normal `pictl list` (but visible with `--all`).
- **purged**: agent directory removed permanently.

For dormant/archived agents, running any command that requires interacting with `pi.sock` or `tty.sock` will automatically respawn the pi and daemon processes, returning them to idle/streaming status. Revival is serialized per agent so two clients do not race to start separate daemons for the same directory. Same for archiving and purging.

## pictl as the shell SDK

pictl is meant to be the language-neutral shell interface to this system.

- humans can use it directly, either non-interactively or with `pictl attach`
- agents can use it to spawn or discover other agents, communicate with them, and send RPC commands. There's a draft skill in [skills/pictl](../skills/pictl/). Note that allowing an agent to call `navigate-tree` on _itself_ requires special attention; see [extensions/navigate-tree.ts](../extensions/navigate-tree.ts) if you want to do that.
- scripts can use it directly. Typescript interaction with pi should probably happen through extensions, but non-typescript languages can shell out to `pictl` to get easy access to the RPC interface. Ideally _every_ RPC interaction can be cleanly mediated by `pictl`, but if it turns out that's infeasible, clients could shell out to (or duplicate) `pictl` agent management commands and talk to `pi.sock` directly for RPC interactions.
- direct `tty.sock` clients can bypass it when they need native terminal integration. The Rust client [`rust/pictl-rs`](../rust/pictl-rs/) works this way: lifecycle and inspection shell out to the `pictl` CLI, while the attach protocol and the RPC/event protocol are spoken natively over the agent's sockets. Its `ratatui` feature provides an embeddable attach-pane widget.

The design goal is that anything a human can do by hand should have a corresponding scriptable operation, without making the underlying agent less interactive or less attachable. Every pi RPC command has a corresponding pictl subcommand.

## Reference material

- exact `tty.sock` frame protocol: [`src/core/tty-protocol.ts`](../src/core/tty-protocol.ts);
- exact `agent.json` schema: [`src/core/registry.ts`](../src/core/registry.ts);
- pi RPC command reference: [`rpc-types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts);
- session-entry cursor semantics: entry ids within append-only pi session files are suitable durable cursors;
