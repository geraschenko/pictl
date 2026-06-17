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

At a high level, `pictl spawn` does this:

```text
pictl spawn
  -> create $PICTL_DIR/<agent-id>/
  -> launch pictl _daemon for that agent
       -> allocate a PTY
       -> run pi --rpc-socket <agent-dir>/pi.sock inside the PTY
       -> maintain terminal screen state
       -> serve <agent-dir>/tty.sock
       -> write daemon-owned metadata to agent.json
```

The user sees only the agent id. The implementation detail is that the agent is not just a pi process: it is a pi process plus a daemon that owns the PTY and attach machinery.

## Why the daemon exists

pi itself owns the interactive TUI and the semantic RPC protocol. That is not enough for detached, reattachable operation.

The daemon exists because someone must hold the PTY master while no human terminal is attached. Without that process, the interactive pi TUI would be tied to the terminal that launched it. The daemon also needs to keep enough terminal state to let a later `pictl attach` render the current screen instead of starting from a blank terminal.

Daemon responsibilities:

- allocate and hold the PTY master;
- run pi in that PTY;
- pass `--rpc-socket <agent-dir>/pi.sock` to pi;
- keep a headless terminal model of the PTY output;
- serve attach clients on `tty.sock`;
- manage terminal resizing across attach clients;
- write daemon-owned lifecycle metadata to `agent.json`;
- clean up sockets on shutdown.

This is roughly the same category of problem solved by tmux or persistent IDE terminals: a background process owns the terminal session, and frontends can connect and disconnect.

## The two sockets

The core protocol boundary is the split between `pi.sock` and `tty.sock`.

### `pi.sock`: semantic pi RPC

`pi.sock` is created and owned by pi. It is enabled by the pi-side `--rpc-socket` modification.

It is essentially pi's normal RPC protocol over a Unix domain socket, with an initial hello record describing the socket protocol. After that, clients send JSONL RPC commands and receive responses. Broadcast events let connected clients observe activity.

This socket is for semantic operations:

- prompt;
- steer;
- follow up;
- abort;
- inspect state;
- change model/settings;
- inspect session entries or trees;
- switch/fork/clone sessions.

pictl's RPC subcommands are CLI wrappers around this socket. Other clients may also talk to it directly.

### `tty.sock`: terminal attach

`tty.sock` is created and owned by the pictl daemon.

It exists because pi's RPC socket is not a terminal protocol. `pictl attach` needs a way to render the TUI, send keystrokes, handle resizes, and receive a current screen snapshot. That is a byte-stream terminal problem, not a semantic RPC problem.

The daemon therefore exposes a separate framed protocol on `tty.sock` for:

- initial screen snapshot;
- PTY output;
- user input;
- terminal resize messages;
- daemon-exit notification.

This separation is intentional. `pi.sock` is for meaning; `tty.sock` is for terminal bytes. Keeping them separate avoids forcing pi to know about remote terminal attach, and avoids overloading the RPC protocol with high-volume TTY data.

## Stable protocols, early implementation

The intention is that `pi.sock` and `tty.sock` are the stable integration points.

The project is still early, so details may change, but the architectural direction is that clients should be able to build on these sockets directly. Examples:

- Rust terminal applications may need native `tty.sock` support to attach to a pictl agent.
- TypeScript, Python, Bash, or Rust workflows may choose either to shell out to pictl or speak `pi.sock` directly.
- Scripts that do not need terminal rendering can use pictl as a shell SDK over `pi.sock`.
- Clients that need terminal rendering must speak `tty.sock` or use `pictl attach`.

## `PICTL_DIR` as the registry

pictl persists agent state under `PICTL_DIR`, defaulting to a directory under the user's pi state directory.

The registry is the directory tree itself:

```text
$PICTL_DIR/
  <agent-id>/
    agent.json
    pi.sock
    tty.sock
    holder.log / daemon log
    archive / tombstone / other marker files
```

There is no central registry daemon and no central index file. Commands discover agents by reading directories and probing processes or sockets.

`agent.json` is daemon-owned metadata. Its exact schema is not important for this document and is expected to evolve. The important invariants are:

- the daemon is the writer;
- CLI commands treat it as metadata, not as a coordination database;
- it records enough information to inspect, suspend, and revive the agent;
- it records session history observed from pi so a dormant agent can resume a useful session.

Marker files such as archive or tombstone markers represent CLI-owned lifecycle state that should not race with daemon ownership of `agent.json`.

## Lifecycle model

An agent is more than a running process. It is the agent directory plus its recorded lineage and metadata.

Important states:

- **running**: daemon and pi process exist; sockets should be reachable;
- **dormant**: agent directory exists, but the daemon/pi process is gone;
- **archived**: dormant or stopped agent hidden from normal `pictl list`;
- **purged**: agent directory removed permanently.

Commands that need `pi.sock` can revive a dormant agent by launching a new daemon using the metadata in `agent.json`. Inspection commands such as `list`, `status`, and `gc` should not revive agents as a side effect.

Revival is serialized per agent so two clients do not race to start separate daemons for the same directory.

## pictl as the shell SDK

pictl is not just an end-user CLI. It is also the language-neutral shell interface to the agent system.

That means:

- humans can use it directly;
- scripts can shell out to it;
- agents can learn it as a tool;
- richer SDKs can be layered on top later;
- direct socket clients can bypass it when they need lower-level access.

The design goal is that anything a human can do by hand should have a corresponding scriptable operation, without making the underlying agent less interactive or less attachable.

## Open questions / future reference material

This document should eventually link to more specific references rather than contain every detail itself:

- exact `tty.sock` frame protocol;
- exact `agent.json` schema;
- pi RPC command reference;
- session-entry cursor semantics;
- examples of direct clients in Rust/TypeScript/Python;
- how version compatibility is negotiated or checked.
