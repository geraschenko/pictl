# pi modifications

Purpose: explain the temporary pi fork changes that pictl depends on. This document is for future pictl contributors and for possible upstream pi review. It is **not** normal pictl user documentation.

Question answered: **what changed in pi, and what problems do those changes solve?**

These changes are currently implemented in the pi fork at `/home/anton/git/earendil-works/pi`, rebased on upstream pi with the pictl-relevant work in the last few commits. They are not presented here as the only right design. They are the solution used to make pictl possible. If upstream pi accepts equivalent functionality in a different shape, this document should either be rewritten around that shape or removed.

## Summary

pictl needs a pi process that is both:

- a normal interactive pi TUI for a human user; and
- a structured, multi-client control surface for scripts, agents, and tooling.

The main fork change is therefore:

```sh
pi --rpc-socket <path>
```

This runs normal interactive pi while also exposing pi's RPC protocol over a Unix domain socket. The socket is an out-of-band semantic control channel; it is not a terminal protocol and it does not replace the interactive TUI.

The fork also expands the RPC surface in small ways so external clients can observe and control the session with enough fidelity to build robust orchestration:

- socket handshake and socket-only lifecycle records;
- multi-client event broadcast with per-client command responses;
- `session_changed` visibility when the active session is replaced;
- `get_entries` and `get_tree` for durable session-entry cursors and tree visibility;
- `navigate_tree` plus `tree_navigated` so RPC clients can perform and observe `/tree`-style navigation;
- RPC image validation/resizing parity with CLI file arguments;
- additive runtime rebind listeners so interactive mode and the socket server can both survive session replacement.

## Why `--mode rpc` is not enough

Upstream pi already has `pi --mode rpc`, but that mode replaces the normal interactive interface with a JSONL stdio protocol. That is useful for headless embedding, but it does not solve pictl's problem.

pictl needs the same live agent to be usable by:

- a human in the interactive TUI;
- one or more CLI/script clients;
- other agents acting as automation clients;
- long-running supervisors that observe progress and keep cursors.

A headless-only RPC mode forces a choice between interactivity and automation. pictl needs both at the same time.

The other possible fallback would be screen scraping or keystroke injection through a PTY/tmux layer. The fork avoids that. pictl uses terminal attach only for terminal interaction, and uses pi's semantic RPC protocol for prompts, state, tree reads, waits, and durable tailing.

## `--rpc-socket` mode

`--rpc-socket <path>` starts interactive pi normally, but creates a Unix domain socket at `<path>`. Socket clients speak JSONL. Commands and response shapes are intended to match `--mode rpc` as closely as possible.

Important properties:

- The interactive TUI remains the owner of terminal rendering and extension UI.
- Multiple socket clients can connect simultaneously.
- Events are broadcast to all connected socket clients.
- Command responses are sent only to the client that issued the command.
- Socket clients do not receive other clients' raw commands or responses.
- Socket clients submit semantic RPC commands, not terminal keystrokes.
- Human submissions and socket-originated submissions enter the same session APIs in the same Node process.

`--rpc-socket` is intentionally incompatible with modes that already replace interactive operation, such as `--mode rpc`, `--mode json`, and `--print`. It requires interactive TTY stdin/stdout.

### Socket hello

Each client receives a socket-specific hello record immediately after connecting:

```json
{"type":"hello","protocol":"pi-rpc-socket","version":1}
```

Why it exists:

- lets clients verify they connected to a pi RPC socket endpoint;
- provides a place for future protocol version negotiation;
- distinguishes socket mode from plain stdio RPC framing.

### Shutdown record

On normal shutdown, the socket server sends:

```json
{"type":"shutdown"}
```

This is socket-specific. It lets connected clients distinguish orderly pi shutdown from an arbitrary transport failure when the process exits cleanly.

## Multi-client semantics

The socket server allows multiple simultaneous clients because pictl's intended use is inherently multi-party:

- a human may be attached to the TUI;
- a script may be tailing entries;
- another process may be waiting for idle;
- another agent may send a prompt or steer;
- pictl's holder may be tracking session changes for revival.

The core rule is:

- **events broadcast; responses route back to the requester.**

That keeps the protocol close to existing RPC mode. A socket client can mostly behave like a normal RPC client, with the extra awareness that events may be caused by the human or by other clients.

## Session replacement visibility: `session_changed`

Interactive pi can replace the active session while the process and socket stay alive. Examples include `/new`, `/resume`, `/fork`, `/clone`, `/import`, or socket commands such as `new_session`, `switch_session`, `fork`, and `clone`.

Without a dedicated event, non-issuing clients cannot reliably know that the process is now hosting a different session. Responses to session-replacement commands go only to the issuing client, and TUI-initiated replacements otherwise produce no RPC response at all.

The fork adds a socket-specific event:

```json
{"type":"session_changed","sessionFile":"/abs/path/to/session.jsonl","sessionId":"<id>"}
```

For in-memory sessions, `sessionFile` is omitted:

```json
{"type":"session_changed","sessionId":"<id>"}
```

Behavior:

- sent once to each new socket client immediately after `hello`;
- broadcast whenever the active session id changes;
- not emitted for in-session operations such as prompting, compaction, or tree navigation;
- emitted before events from the new session reach socket clients.

Why pictl needs it:

- the pictl holder records which pi session file an agent is currently associated with;
- dormant-agent revival needs a recent usable session file;
- polling `get_state` after every event would be both wasteful and semantically awkward, especially because token-streaming events can be frequent.

Important caveat: pi may announce a session file before it exists on disk. Session files are written lazily. Clients that persist `sessionFile` for later revival must tolerate the path being absent until the session has produced persisted content.

## Extension UI visibility: `ui_wait_start` / `ui_wait_end`

Interactive mode remains the sole owner of extension UI. Socket clients do not answer extension UI requests and do not render custom TUI components.

That means the normal stdio RPC `extension_ui_request` / `extension_ui_response` flow is not used on the socket. Instead, socket clients receive summary events when progress is blocked on human-facing extension UI.

Example start event:

```json
{
  "type": "ui_wait_start",
  "requestId": "6a9f7c54-3c68-4e31-a550-602889b7b8af",
  "request": {
    "method": "confirm",
    "title": "Run project-local agents?",
    "message": "Project agents are repo-controlled. Only continue for trusted repositories."
  }
}
```

Example end event:

```json
{
  "type": "ui_wait_end",
  "requestId": "6a9f7c54-3c68-4e31-a550-602889b7b8af",
  "request": {
    "method": "confirm",
    "title": "Run project-local agents?"
  },
  "resolution": "confirmed"
}
```

Why pictl cares:

- automation can tell the agent is blocked on human-facing UI rather than idle or crashed;
- supervisors can use inactivity/watchdog logic without pretending they can resolve the UI themselves;
- the TUI remains the single place where rich extension UI is displayed and answered.

## Durable session visibility: `get_entries` and `get_tree`

Existing RPC commands exposed current conversation messages, but not the underlying session entry tree.

That is not enough for robust orchestration:

- `get_messages` returns the current in-context path, not the full append-only session history;
- compaction can hide earlier messages from the current context;
- abandoned branches are invisible;
- events are ephemeral and cannot be used for crash recovery;
- a supervisor needs a durable cursor it can persist and resume from.

The fork adds read-only RPC commands:

```json
{"type":"get_entries"}
```

```json
{"type":"get_entries","since":"<entry-id>"}
```

```json
{"type":"get_tree"}
```

`get_entries` returns session entries in append order plus the current `leafId`. With `since`, it returns entries strictly after the specified entry id. If the entry id is not in the current session, the command returns an error.

`get_tree` returns the session tree plus the current `leafId`.

Why pictl needs this:

- `pictl tail --since <entry-id>` can be implemented as durable catch-up rather than event replay;
- workflow scripts can persist an entry cursor and resume after crashes;
- clients can detect branch movement and compaction through session structure instead of screen output.

Cursor caveat: entry ids are session-scoped. If the active session changes, an old cursor may no longer be meaningful. pictl treats that as client policy rather than trying to interweave multiple session files.

## Tree navigation over RPC: `navigate_tree` and `tree_navigated`

Interactive pi has `/tree`, which moves the current leaf within the same session. Before the fork, RPC clients could inspect a tree after `get_tree`, but could not perform the equivalent operation. The available RPC branch operations, such as `fork` and `clone`, create new sessions instead of moving within the current one.

The fork adds:

```json
{
  "type": "navigate_tree",
  "targetId": "<entry-id>",
  "summarize": true,
  "customInstructions": "optional summary instructions",
  "replaceInstructions": false,
  "label": "optional label"
}
```

Options mirror the existing interactive tree-navigation behavior where applicable.

The fork also adds a session event emitted whenever the active leaf changes within a session:

```json
{
  "type": "tree_navigated",
  "oldLeafId": "<old-entry-id-or-null>",
  "newLeafId": "<new-entry-id-or-null>",
  "summaryEntry": { }
}
```

`summaryEntry` is present only when navigation created a branch-summary entry.

Why both pieces are needed:

- RPC clients need to perform `/tree`-style navigation without creating a new session file;
- socket clients need to observe TUI-initiated `/tree` navigation;
- the interactive TUI needs to re-render if a socket client moves the tree;
- `tree_navigated` is not `session_changed`, because the session id and file do not change.

The guard against navigating while streaming or compacting lives in `AgentSession.navigateTree`, so it applies consistently to TUI, extension, stdio RPC, and socket RPC callers.

## Shared command handling

The fork factors RPC command execution into a shared command handler used by both stdio RPC mode and socket RPC mode.

Why this matters:

- `--mode rpc` and `--rpc-socket` should not drift accidentally;
- new RPC commands should usually be implemented once;
- pictl can rely on the same command semantics whether a user is testing through stdio RPC or using the interactive socket mode.

The socket transport still differs where interactive ownership requires it, especially around extension UI.

## Runtime/session rebinding

Socket mode must survive session replacement. A socket connection should not become stale merely because the human ran `/new` or `/resume`.

The fork adds additive runtime lifecycle listeners, preserving existing single-listener methods for compatibility while allowing multiple owners to observe session replacement.

Why this was needed:

- interactive mode already needs to rebind its UI/session state;
- the socket server also needs to re-subscribe to events and route future commands to the new active session;
- a last-writer-wins callback would make those two responsibilities race.

This is infrastructure for `--rpc-socket`, but it is also a useful example of the fork's bias: make the smallest change that lets interactive mode and side-channel clients coexist.

## RPC image validation parity

The fork also fixes RPC-supplied images for `prompt`, `steer`, and `follow_up`.

Before the change, images supplied through RPC bypassed pi's normal image sniffing, validation, and resizing path. A bad image could be accepted into the session and then poison future model requests because providers validate images in the full conversation history.

The fork runs RPC images through the same preparation pipeline as CLI file arguments:

- sniff actual MIME type from bytes;
- resize according to pi's auto-resize setting;
- drop unsupported or unshrinkable images;
- append a visible note to the message instead of persisting an invalid image.

This is not specific to socket mode, but pictl is an RPC client and needs RPC ingestion paths to be safe without reimplementing pi's image rules.

## Relationship to pictl

These pi changes are what let pictl stay relatively small and honest about protocol boundaries.

pictl does **not** need to:

- scrape terminal output to infer semantic state;
- inject keystrokes to send prompts;
- parse pi session files directly;
- own extension UI;
- run a patched non-interactive pi mode that humans cannot attach to.

Instead:

- pi owns the TUI and semantic session model;
- pi exposes semantic control on `pi.sock`;
- pictl owns detached PTY holding and terminal attach on `tty.sock`;
- pictl uses `get_entries` and events to build shell-friendly orchestration commands like `tail` and `wait`.

## Upstreaming posture

The intention is to upstream these changes, or upstream a better solution to the same problems.

The problems pictl needs solved are:

1. interactive pi plus structured programmatic access at the same time;
2. multiple simultaneous clients with sane event/response routing;
3. reliable session replacement visibility;
4. durable session-entry access for cursor-based orchestration;
5. RPC control over tree navigation with corresponding visibility events;
6. safe RPC image ingestion;
7. runtime lifecycle hooks that allow interactive and side-channel owners to coexist.

The exact fork implementation is not assumed to be the final upstream design. If pi maintainers prefer a different transport, event shape, lifecycle hook, or command organization that solves these problems cleanly, pictl should adapt.

If these capabilities become upstream pi behavior, this document should no longer be needed as a fork explainer.

## Source references

Current fork references:

- `docs/pi-rpc-socket-mode.md` in the pi fork: detailed socket-mode spec and implementation notes.
- `docs/rpc-session-tree-commands.md`: `get_entries` / `get_tree` motivation and spec.
- `docs/rpc-navigate-tree.md`: `navigate_tree` and `tree_navigated` motivation and spec.
- `docs/rpc-image-validation.md`: RPC image validation problem and fix.
- `packages/coding-agent/src/modes/rpc/rpc-socket-mode.ts`: socket server implementation.
- `packages/coding-agent/src/modes/rpc/rpc-command-handler.ts`: shared RPC command execution.
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`: command, response, and socket record types.
