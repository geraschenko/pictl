# Format Tree from Entries

Follow-up to
[respond-stringify-hardening-handoff.md](respond-stringify-hardening-handoff.md)
(the clauctl crash class). The daemon-side pieces (respond() hardening,
get_tree depth limit) land in the **pi** repo; this spec covers pictl's
client-side share of the change.

# SPEC

## Problem

pi's `get_tree` RPC returns a _nested_ `SessionTreeNode[]` — one nesting
level per entry on a mostly-linear session. `JSON.stringify` overflows the
call stack near depth ~5000, so pi is changing `get_tree` to return an error
on deep sessions, telling clients to use `get_entries` and build the tree
themselves. pictl must not depend on the nested shape: `format tree` only
accepts nested `get_tree` output (`TreeInput`), and its processing
(`decodeTreeNode`, `toLayoutNode`) is recursive — the same latent overflow.

`get_tree` is strictly a convenience around `get_entries`: pi entries carry
`parentId` natively, so the flat entries _are_ the tree. No relink algorithm
is needed (unlike clauctl).

## What we want

1. **`format tree` accepts `get_entries` output** (`{entries, leafId}`) and
   raw session-entry JSONL, via the existing `parseEntriesInput`. Support
   for nested `get_tree` documents is removed.
2. **The tree is built in-memory from the flat parent relation**, with all
   traversals iterative. The generic flat→layout logic lives in a new
   shared file, `src/format/flat-tree.ts`, that clauctl can add to its
   `sync-from-pictl.mjs` format sync set.
3. **The `get-tree` RPC passthrough command stays** (full-mirror policy in
   rpc-commands.ts). pi's future "too deeply nested" error prints like any
   other RPC error; nothing in pictl calls `get_tree` internally.

## Success criteria

- `pictl get-entries -t <agent> | pictl format tree` renders the tree.
- `pictl format tree < <session>.jsonl` renders the tree with the cursor on
  the last entry (pi's own load rule).
- Old `get_tree` output fed to `format tree` produces a UsageError pointing
  at `get-entries`.
- No recursion over session-length structures remains in pictl code
  (`decodeTreeNode` and `toLayoutNode` are deleted).
- `flat-tree.ts` is self-contained next to `tree-layout.ts` (imports only
  from within the shared set), ready for clauctl's sync list.
- All existing tests pass (updated where behavior changed).

## Type design

```ts
// src/format/flat-tree.ts — NEW shared file (generic; no pi types).

import type { LayoutNode } from "./tree-layout.ts";

/** Child id → parent id (null = root). Iteration order = input order. */
export type ParentMap = ReadonlyMap<string, string | null>;

/** Nested LayoutNode roots from a flat parent relation. Iterative, two
 *  passes (create shells, then link), so no parent-precedes-child ordering
 *  assumption. An id whose parent is not a key of the map becomes a root —
 *  matches pi's getTree(): orphaned entries are returned as roots. */
export function toLayoutTree<P>(
  parentMap: ParentMap,
  payloadOf: (id: string) => P,
): LayoutNode<P>[];
```

```ts
// src/format/tree.ts — reworked. Recursive toLayoutNode deleted.

/** Replaces formatTreeInput. Layout payload is FilterNode ({entry, label?});
 *  passesFilter is unchanged. Cursor: input.leafId if present (null renders
 *  as [cursor: null]); when absent (raw JSONL input), the last entry's id —
 *  pi's own on-load leaf rule (SessionManager._buildIndex). */
export function formatEntriesTree(
  input: EntriesInput,
  options?: Partial<TreeFormatOptions>,
): string;

// Non-exported helpers (pi-specific, so not in flat-tree.ts):
//   entryParentMap(entries: readonly SessionEntry[]): ParentMap
//     — id → parentId. THROWS (plain Error, not UsageError — it signals
//     file corruption, not bad usage) on a duplicate entry id: a Map
//     would silently collapse the duplicate and hide on-disk corruption.
//     The layout's duplicate-id check remains as backstop.
//   resolveLabels(entries: readonly SessionEntry[]): Map<string, string>
//     — targetId → label; latest label entry wins, empty/absent label
//     clears (mirrors pi SessionManager._buildIndex).
```

```ts
// src/format/types.ts — TreeInput deleted (with its SessionTreeNode
// import). EntriesInput unchanged: already {entries, leafId?}.
```

```ts
// src/format/input.ts — decodeTreeNode, decodeTreeInput, parseTreeInput
// deleted. parseEntriesInput gains one cross-pointing case: a JSON object
// with a `tree` array → UsageError "looks like get-tree output; feed it
// get-entries output instead". This also applies to `format entries`
// (same parser) — the message fits both commands.
```

```ts
// src/format/command.ts — formatTree switches to parseEntriesInput; a bare
// entry array wraps as {entries}. Brief: "format pictl get-entries output
// or entry JSONL".
```

## Edge cases

- **Orphaned entries** (parentId not present in the file, e.g. a truncated
  or hand-edited session): rendered as extra roots, matching pi's
  `getTree()` documented behavior.
- **Duplicate entry ids**: `entryParentMap` throws loudly (corrupt file).
- **Empty input**: `parseEntriesInput` already returns `[]`; `format tree`
  prints just `[cursor: null]`.
- **`leafId` naming an id absent from entries**: the cursor line still
  prints it; no node is marked (same tolerance as today's layout, which
  only matches ids it sees).
- **Label entries targeting missing ids**: resolved labels for absent
  targets are simply never looked up; no error.

## Non-goals

- pi-side changes (respond() hardening, get_tree depth error): separate
  handoff in the pi repo.
- No pictl daemon changes: pictl's daemon is a TTY frame server with no
  JSON respond() path; the handoff doc's presumption did not hold.
- `get-tree` passthrough command: stays as-is (RPC full mirror).
- Generic `treeChildren`/`pathToLeaf` in flat-tree.ts: excluded. pictl has
  no consumer (`flattenVisibleTree` derives the active path internally),
  and clauctl's versions are entangled with its ref/entry types; the
  generic residue is a trivial loop not worth shared-file coupling.
- clauctl's refactor onto the synced `flat-tree.ts`: separate work in the
  clauctl repo.
- `tree-layout.ts`: unchanged (already iterative).

# IMPLEMENTATION IDEAS

- **Empirical findings** (from clauctl and pi source):
  - `JSON.stringify` overflows near depth ~5000 (Node 23); `JSON.parse`
    survives 6000+ — the producer dies first, which is why pi's daemon is
    the crash site and pictl's decode was only latent.
  - pi `SessionManager._buildIndex`: on load, `leafId` ends as the last
    entry's id; labels resolve latest-wins with falsy label clearing.
    `formatEntriesTree`'s JSONL-cursor rule and `resolveLabels` mirror this
    exactly.
  - pi's `get_entries` response is already `{entries, leafId}` — the
    snapshot shape clauctl had to invent exists in pi today.
- **toLayoutTree two-pass**: pass 1 creates `{id, children: [], payload}`
  shells for every ParentMap key; pass 2 links each shell into its parent's
  (mutable) children array, or into the roots list when the parent id is
  null/absent. Structural typing satisfies the readonly `LayoutNode`
  interface. Same approach as clauctl's implementation.
- **Payload callback vs Map**: `payloadOf: (id: string) => P` keeps
  flat-tree.ts free of any opinion about entry storage; pictl passes a
  closure over its byId map.
- **Sync-set readiness**: flat-tree.ts imports only `./tree-layout.ts`
  (within the format sync set), so clauctl's import-rewriting rule keeps it
  `./`-relative. Adding it to clauctl's SYNC_SETS is a one-line change
  there.
- **Test fixtures**: format.test.ts's tree tests read `fixtures/tree.json`
  (nested get_tree output); replace with a get-entries-shaped fixture
  covering branching, labels, and orphans. `fixtures/entries.json` exists
  but serves `format entries`; extend or add rather than repurpose blindly.
- **Docs audit result** (critique pass): `skills/pictl/rpc-details.md`
  mentions get-tree only in the passthrough command listing (stays);
  `tree-navigation.md` never uses it as a data source;
  `docs/design-decisions.md` remains accurate. No doc changes needed
  beyond the `format tree` brief.
- **Order of work**: flat-tree.ts + tests → tree.ts rework + tests →
  input.ts/types.ts/command.ts + tests + fixtures. Each step compiles and
  passes tests before the next.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] flat-tree.ts: `ParentMap`, `toLayoutTree` + tests (stub compiled
      first per type-driven workflow, then implemented).
- [x] tree.ts: `formatEntriesTree`, `entryParentMap`, `resolveLabels`;
      delete `formatTreeInput`/`toLayoutNode`; port tests.
- [x] types.ts/input.ts: delete `TreeInput`, `decodeTreeNode`,
      `decodeTreeInput`, `parseTreeInput`; cross-pointing UsageError.
- [x] command.ts: `format tree` via `parseEntriesInput`; brief.
- [x] Fixtures: new `fixtures/entries-tree.json` (branching + label entry);
      new tests for JSONL cursor, orphan roots, duplicate ids, label
      resolution, cross-pointing error.
- [x] End-to-end: 6000-entry linear JSONL renders through the CLI (the
      depth that overflowed clauctl); get-entries envelope via file and
      stdin renders; `{entries: [], leafId: null}` prints `[cursor: null]`.
      Presubmit green (97 tests).

## Implementation-Time Decisions

- **`parseEntriesInput` error propagation improved**: previously the whole
  decode ran inside `try { JSON.parse(...) } catch {}`, so a malformed
  `{entries: [...]}` document swallowed its decode error and fell through
  to JSONL parsing, yielding a misleading error. Now only `JSON.parse` is
  guarded; decode errors (and the new cross-pointing UsageError, which the
  old shape would have swallowed) propagate.
- **`fixtures/tree.json` kept, not deleted**: repurposed as the negative
  input for the cross-pointing test (real nested get_tree shape).
- **Known limitation — parent cycles**: `toLayoutTree` silently drops
  nodes in a parent cycle (they are unreachable from any root). Impossible
  in a pi-written file (append-only, parent precedes child); guarding
  would need an extra reachability pass. Left unguarded.
- **`parseJsonInput` removed from core/read-input.ts** (owner request,
  review round 1): it became unused in both pictl and clauctl when
  `parseTreeInput` (its only consumer) was deleted. clauctl's generated
  copy updates on its next `sync-from-pictl.mjs` run — noted in the
  clauctl handoff doc.
