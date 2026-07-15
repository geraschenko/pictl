# Handoff: extract format-agnostic input helpers into `src/core/read-input.ts`

> Status: **ready to implement.** Small mechanical refactor, no behavior
> change. Requested by clauctl (see clauctl's `docs/specs/format.md`), which
> will copy the new file verbatim via its `scripts/sync-from-pictl.mjs` —
> the same generated-file scheme it already uses for `src/core/{cli,targets,
> util,…}.ts`.

## SPEC (stable requirements)

### Problem

clauctl is building its own `format` command and wants to reuse pictl's
input plumbing — read a file arg or stdin, parse JSON/JSONL with useful
errors — as an exact synced copy rather than a hand-maintained fork. Those
helpers currently live in `src/format/input.ts`, mixed with pictl-specific
decoders (`decodeMessageStreamRecord`, `decodeSessionEntry`, …) that import
pi types clauctl doesn't have. The generic helpers must move to their own
file so the sync can copy a whole file unchanged.

The file lives in `src/core/`, not `src/format/`: clauctl's sync script
sources exclusively from `src/core/` and only rewrites sibling imports
within the shared set, so a core placement needs just a SHARED_FILES entry
on the clauctl side. It also fits semantically (CLI input plumbing, like
cli.ts/util.ts) and lets `src/core/rpc-commands.ts` reuse `readStdin`
without a core→format import.

### Change

Create `src/core/read-input.ts` and move these from `src/format/input.ts`,
verbatim (no signature or behavior changes):

- `export async function readStdin(stdin): Promise<string>` (was a private
  helper of `readInputFile`; exported so rpc-commands.ts can reuse it)
- `export async function readInputFile(context, file): Promise<string>`
- `export function parseJsonInput(input: string): unknown`
- `export function parseJsonlInput(input: string): readonly unknown[]`

`readStdin` stays **raw** — it returns stdin exactly as received. Stripping
the trailing newline is prompt-text policy, not stdin mechanics (same
layering as ptyEnv staying in daemon.ts), and trimming only the stdin
branch of `readInputFile` would make `format x.jsonl` and
`cat x.jsonl | format -` yield different strings.

Update importers:

- `src/format/input.ts` — import `parseJsonInput`/`parseJsonlInput` from
  `../core/read-input.ts` (it uses both).
- `src/format/command.ts` — import `readInputFile` from
  `../core/read-input.ts`.
- `src/core/rpc-commands.ts` — delete its near-duplicate `readStdin`;
  import the shared one and apply `.replace(/\n$/, "")` at the `messageFrom`
  call site, with a comment noting the trailing newline is the shell's, not
  the prompt's. This is the one intentional dedupe; the trim location keeps
  its behavior byte-identical.

### Hard constraint (why this file must stay "clean")

clauctl's sync script does textual `pictl→clauctl` renames and rewrites
relative imports; it can only handle imports of node builtins and of the
already-shared core set. `read-input.ts` must therefore import **only**:

- node builtins (`node:fs/promises`),
- `./targets.ts` (for `CommandContext`),
- `./util.ts` (for `UsageError`).

No pi types, no format files. Leave a short header comment on the new file
recording this constraint so future edits don't break the sync (no existing
pictl file documents the shared-set rule, so this comment is the first).

### Success criteria

- `readInputFile`, `parseJsonInput`, `parseJsonlInput` behave identically
  (same exports, same `UsageError` messages, JSONL errors still carry line
  numbers); `pictl prompt -` still strips exactly one trailing newline.
- `src/core/read-input.ts` imports nothing beyond the three sources above.
- Existing tests pass unchanged; no other files change behavior.

### Non-goals

- Any change to the pictl-specific decoders in `input.ts`.
- Adding clauctl-side anything to pictl — clauctl's sync script changes live
  in clauctl (SHARED_FILES gains `read-input.ts`).
- Making `readStdin` trim for format consumers — see the raw-stdin rationale
  above; don't "helpfully" unify the trim into the shared helper.

## WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-14: Handoff written from the clauctl `format` spec discussion.
- 2026-07-14: Spec revised before implementation: the file moves to
  `src/core/` (clauctl's sync only sources from src/core, and rpc-commands
  can then reuse readStdin without a core→format import), `readStdin` is
  exported and stays raw, and rpc-commands' near-duplicate (which trimmed
  one trailing newline) is deduped by moving the trim to its `messageFrom`
  call site.
- 2026-07-14: Implemented.
  - [x] `src/core/read-input.ts` created with the sync-constraint header;
        imports only node:fs/promises, ./targets.ts, ./util.ts.
  - [x] `src/format/input.ts` — moved helpers deleted; imports
        parseJsonInput/parseJsonlInput from ../core/read-input.ts.
  - [x] `src/format/command.ts` — imports readInputFile from
        ../core/read-input.ts.
  - [x] `src/core/rpc-commands.ts` — local readStdin deleted; shared one
        imported, `.replace(/\n$/, "")` applied in messageFrom with a
        trailing-newline comment.
  - [x] Presubmit green (86 tests pass).
