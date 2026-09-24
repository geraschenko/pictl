# Factor the tty.sock protocol out into its own repo

The tty.sock protocol (`src/core/tty-protocol.ts`, served by
`src/core/tty-server.ts`, spoken by `src/core/attach.ts`) is a generic
utility: attach any number of terminals to a server-side pty over a unix
socket, with a serialized-screen snapshot on attach. Nothing about it is
pictl-specific, and it is about to have a second implementation site —
clauctl syncs these files verbatim (via `scripts/sync-from-pictl.mjs` in the
clauctl repo) and speaks the identical protocol.

A survey of existing tools (tmux control mode, wezterm mux, ttyd/GoTTY,
dtach/abduco/screen, asciinema ALiS, SSH-over-unix-socket) found no de-facto
standard to adopt: every tool in this space hand-rolls a bespoke socket
protocol, and none has maintained client libraries in both TypeScript and
Rust. Notably, almost none of them has our snapshot-on-attach feature
(asciinema's ALiS spec is the exception, and it is view-only). So the
protocol stays ours — but it should eventually live in a `tty-sock` repo
containing:

- the protocol specification as a document, not just source code;
- the TypeScript server and client (what is now tty-protocol.ts,
  tty-server.ts, and the client half of attach.ts);
- clients (and possibly servers) in other languages — Rust first. The
  framing maps directly onto `tokio_util::codec` (a ~50-line custom
  `Decoder`), and the snapshot payload is already cross-language: it is an
  ANSI byte stream (xterm.js SerializeAddon output) that any terminal
  emulator (e.g. Rust's `vt100` or `wezterm-term`) can replay.

## Hardening to do at factoring time (or sooner)

- **Protocol version in the hello frame.** Today version mismatches are only
  detectable as decode failures. Add a version field (or an ALiS-style
  magic-bytes + version prefix on the connection) so servers can reject or
  adapt to old clients explicitly. This is a wire change; the cheapest time
  is before independent implementations exist.
- **Written frame spec.** The byte-level framing ([type: u8][len: u32 BE]
  [payload], 16 MB cap), the JSON payload schemas (hello/resize/exit), the
  hello-first requirement, the min-size multi-attacher rule, and the
  snapshot-then-buffered-output ordering guarantee all live only in source
  comments today. A second-language implementer needs them in one document.
