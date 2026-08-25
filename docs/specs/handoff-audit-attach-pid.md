# Handoff: decouple `auditAttachEvent` from tty-server's `AttachmentInfo`

Written 2026-08-24 by a clauctl agent. Small, self-contained change to
`src/core/audit.ts`; a clauctl spec depends on it landing.

## Why

clauctl syncs `audit.ts` verbatim from pictl (clauctl
`scripts/sync-from-pictl.mjs`; the file lands as
`src/core/generated/audit.ts`). clauctl is about to remove its tty.sock
stack entirely — `clauctl attach` will run the TUI directly as an sdk.sock
client (clauctl `docs/specs/attach-direct-tui.md`) — which removes
`tty-server.ts` from clauctl's sync manifest. That breaks `audit.ts`'s one
dependency on it:

```ts
import { type AttachmentInfo } from "./tty-server.ts";   // audit.ts:12
```

`auditAttachEvent` only ever reads `info.pid` (audit.ts:222), so the
dependency is incidental. clauctl will keep calling `auditAttachEvent` —
with attachments observed via sdk.sock subscription instead of tty.sock —
passing `{ pid }`.

## The change

In `src/core/audit.ts`:

1. Delete the `AttachmentInfo` import (line 12).
2. Narrow the parameter to what the function uses:

```ts
export function auditAttachEvent(
  agentDir: string,
  enabled: boolean,
  event: "attach" | "detach",
  info: { pid: number },
  log: (message: string) => void,
): void;
```

Body unchanged. Keep the doc comment's substance, but reword it to be
caller-neutral about _how_ the daemon observed the attach (in pictl it is
the tty.sock hooks; in clauctl it will be sdk.sock subscriptions) — e.g.
"Fire-and-forget attach/detach audit for the daemon's attach hooks: …".

No pictl call-site changes needed: both call sites
(`src/core/daemon/tty-service.ts:60` and `:68`) pass an `AttachmentInfo`,
which satisfies `{ pid: number }` structurally. `tty-server.ts` itself, its
`AttachmentInfo` export, and `registry.ts`'s use of it are all unchanged —
this touches only `auditAttachEvent`'s signature.

## Validation

```sh
npm run presubmit
```

(Known quirk: the first presubmit after edits can fail on treefmt's
`--fail-on-change` reformat; re-run it.)

## After landing

Tell the requester (or note in the commit) that clauctl should re-run
`node scripts/sync-from-pictl.mjs` to pick it up; the clauctl spec's
implementation is blocked on that resync.
