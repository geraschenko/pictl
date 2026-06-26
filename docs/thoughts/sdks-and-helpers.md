# SDKs and helper utilities

`pictl` is currently a CLI utility. That should remain one of its primary jobs, but shelling out to a CLI may not be the best interface for scripting multi-agent workflows.

People may want to orchestrate agents from TypeScript, Python, Rust, or other languages. They can always spawn `pictl`, but that is awkward for long-lived clients, streaming output, interactive panes, and higher-level message processing.

This note is exploratory. It is not a commitment to maintain SDKs in many languages.

## Possible layers

A useful split may be:

1. **Protocol** — documented socket/RPC/event/message shapes.
2. **Canonical library** — the implementation used by the CLI, probably TypeScript at first.
3. **CLI** — the user-facing command-line wrapper over the same library.
4. **Thin language clients** — small clients in other languages if/when there is demand.
5. **Stream/helper utilities** — reusable transforms and formatters for agents, humans, and TUIs.

The maintenance burden probably stays lowest if the protocol is clear and stable enough that most languages can implement thin clients without needing a full port of every `pictl` feature.

## Protocol first

The important artifact may be the control protocol, not any single SDK package.

A protocol-first approach would mean documenting:

- how to discover or select a target;
- how to connect to its sockets;
- what requests and responses look like;
- what event, entry, and message records look like;
- cursor semantics;
- error shapes;
- compatibility/version expectations.

Then `pictl` becomes the CLI face of that protocol, and the TypeScript implementation can be the reference client rather than the only practical client.

## Canonical TypeScript library

Because `pictl` itself is TypeScript, the first reusable SDK-like surface should probably be extracted from the CLI implementation rather than built separately.

Possible responsibilities:

- target resolution;
- socket connection management;
- RPC request/response handling;
- long-lived clients attached to `pi.sock`;
- tail cursors;
- event/entry/message stream normalization;
- prompt-and-tail stop conditions;
- formatting message streams for agents or humans.

Open concern: too much helper logic in the TypeScript library may make other language clients feel second-class. Too little helper logic may force every CLI command to reimplement stream handling ad hoc.

## Other language clients

Python, Rust, and other clients may initially be intentionally thin:

- connect to `pi.sock`;
- make RPC calls;
- stream events, entries, or messages;
- track cursors;
- expose low-level typed records.

That may be enough for serious workflows without committing to full feature parity with the CLI or TypeScript library.

Possible support levels:

1. **Documented protocol only** — users write their own clients.
2. **Blessed minimal clients** — tiny packages for common languages.
3. **Full SDK parity** — rich helpers in every supported language.

The third option sounds expensive and should probably not be promised early.

## Message stream helpers

A major ergonomic need is not just raw access to messages, but presentable summaries or transcripts for other agents.

Examples:

- format all messages in a worker agent since the supervisor last checked in;
- produce an agent-readable digest with roles, tool calls, errors, and cursor metadata;
- convert entries/events into message-shaped records while preserving enough ids to resume;
- produce compact human-readable progress logs;
- separate raw records from presentation-oriented formats.

This overlaps with the `prompt --and-tail` / `tail` stream-level questions. Ideally, the CLI and SDKs would share the same stream transforms rather than each growing their own formatting rules.

## TTY socket helpers

Each agent exposes separate sockets for separate concerns:

- `pi.sock` for RPC, events, entries, and messages;
- `tty.sock` for TTY-related interactive traffic.

That existing socket split already suggests that TTY helpers should be separate from message-stream helpers, even if they share target resolution and connection plumbing.

Rust `ratatui` is a useful motivating example: an app may want a pane that connects to an agent interactively through `tty.sock`, while another pane or background task reads structured state through `pi.sock`.

Potential helper responsibilities around `tty.sock`:

- connect to the TTY socket;
- pump bytes bidirectionally;
- handle resize events;
- expose terminal output in a form a TUI can render;
- decide whether terminal decoding belongs in `pictl` utilities at all or should be left to existing terminal crates/libraries.

## Open questions

- What protocol stability can `pictl` realistically promise while pi internals are still changing?
- Should there be an explicit protocol version handshake?
- Is TypeScript the only official SDK initially, or just the implementation language of the CLI?
- Which helper transforms are core enough to belong in the canonical library?
- Should Python/Rust clients be generated from a schema, handwritten, or deferred?
- Where should message presentation formats live: protocol docs, CLI formatters, SDK helpers, or all of these?
- How much target discovery logic should non-TypeScript clients duplicate?
- What is the minimum useful `tty.sock` helper API for TUI authors?
- Should `pictl` expose libraries under this package, or should SDKs be separate packages once the shape is clearer?
