# Handoff: extract generic tree layout into `src/format/tree-layout.ts`

> Status: **implemented** Refactor of `src/format/tree.ts`
> with one
> deliberate internal change (parent walks become tree-edge walks; output is
> byte-identical for pi trees). Requested by clauctl (see clauctl's
> `docs/specs/format-tree.md`), which will copy the new file verbatim via
> its `scripts/sync-from-pictl.mjs` — the same scheme it already uses for
> `src/format/text.ts` and `src/core/read-input.ts` (see
> `docs/specs/read-input-extraction.md` for the precedent).

# SPEC (stable requirements)

### Problem

clauctl is building `clauctl format tree` and wants pictl's tree-rendering
geometry — flattening, active-path marking, active-branch-first ordering,
gutter/connector math, virtual root for multi-root forests, and the
visible-structure recalculation after filtering — as an exact synced copy.
That logic currently lives in `src/format/tree.ts` interleaved with
pi-specific code (entry summaries, `SessionTreeNode`/`SessionEntry` types
from `@geraschenko/pi-coding-agent`) that clauctl cannot import: its trees
carry Claude-CLI session entries with different types, filters, and
summaries.

The geometry is entry-type-agnostic except for two things:

1. It reads `node.entry.id` for identity.
2. `buildActivePath` and `recalculateVisibleStructure`'s re-attachment loop
   walk `entry.parentId`.

Point 2 is not portable even in principle: in clauctl's trees, an entry's
raw parent field and its tree edge diverge (compact-boundary nodes attach
via a different field than their `parentUuid`). In pi they coincide — tree
edges ARE `parentId` edges — so switching both walks to tree-edge walks is
behavior-identical here and correct there.

Additionally, unique node ids are a **checked precondition**:
`flattenVisibleTree` throws on a duplicate id (one Set pass while
flattening). Both consumers guarantee uniqueness — pi ids are unique, and
clauctl constructs unique layout ids (occurrence identity is
`(uuid, viaBoundary)`; its adapter emits `uuid` / `uuid@viaBoundary`
composites — clauctl commit `aee6aef`) — so the guard exists to make
adapter bugs fail loudly. Without it, the id-keyed internals silently
render garbage on duplicates: `recalculateVisibleStructure` merges
duplicated ids' child lists so each occurrence renders the union of all
occurrences' subtrees, `buildActivePath`'s last-wins map can hop between
occurrences' ancestries mid-walk, and `•`/`*` markers smear across
occurrences. The internals stay id-keyed, mirroring pi's `TreeSelector` —
staying diffable against the upstream this rendering descends from is a
design goal (see IMPLEMENTATION IDEAS); the guard is what makes that safe.
(Reference keying was considered and rejected for exactly that drift cost —
2026-07-16 work log.) Raw `parentId` walks could also cycle under clauctl
relinking. For valid forest input, tree-parent walks cannot cycle because they
follow the finite structural ancestry recorded during traversal.

### Change

Create **`src/format/tree-layout.ts`** — **import-free** (no imports at
all; clauctl copies the file verbatim with no rewriting) — containing the
generic layout:

```ts
/** Structural tree node; each consumer adapts its own node type via one O(n) map. */
export interface LayoutNode<P> {
  readonly id: string;
  readonly children: readonly LayoutNode<P>[];
  readonly payload: P;
}

export interface TreeGutter {
  readonly position: number;
  readonly show: boolean;
}

export interface FlatLayoutNode<P> {
  readonly node: LayoutNode<P>;
  readonly indent: number;
  readonly showConnector: boolean;
  readonly isLast: boolean;
  readonly gutters: readonly TreeGutter[];
  readonly isVirtualRootChild: boolean;
  readonly isOnActivePath: boolean;
  readonly isCurrentLeaf: boolean;
}

/** flattenAll → active path → filter → recalculateVisibleStructure.
 *  The predicate closes over whatever it needs (filter mode, current-leaf
 *  exemptions); pass `() => true` for the full unfiltered list. */
export function flattenVisibleTree<P>(
  roots: readonly LayoutNode<P>[],
  currentLeafId: string | null,
  passesFilter: (node: LayoutNode<P>) => boolean,
): readonly FlatLayoutNode<P>[];

export function treePrefix(flatNode: FlatLayoutNode<unknown>): string;
```

The complete private type design is:

```ts
interface FlatLayoutNodeDraft<P> {
  node: LayoutNode<P>;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  gutters: readonly TreeGutter[];
  isVirtualRootChild: boolean;
  isOnActivePath: boolean;
  isCurrentLeaf: boolean;
}

interface StackItem<P> {
  readonly node: LayoutNode<P>;
  readonly parentId: string | null;
  readonly indent: number;
  readonly justBranched: boolean;
  readonly showConnector: boolean;
  readonly isLast: boolean;
  readonly gutters: readonly TreeGutter[];
  readonly isVirtualRootChild: boolean;
}

interface FlattenAllResult<P> {
  readonly flatNodes: readonly FlatLayoutNodeDraft<P>[];
  readonly parentById: ReadonlyMap<string, string | null>;
}

function computeContainsActive<P>(
  roots: readonly LayoutNode<P>[],
  currentLeafId: string | null,
): Map<LayoutNode<P>, boolean>;

function flattenAll<P>(
  roots: readonly LayoutNode<P>[],
  currentLeafId: string | null,
): FlattenAllResult<P>;

function buildActivePath(
  parentById: ReadonlyMap<string, string | null>,
  currentLeafId: string | null,
): Set<string>;

function recalculateVisibleStructure<P>(
  visibleFlatNodes: readonly FlatLayoutNodeDraft<P>[],
  parentById: ReadonlyMap<string, string | null>,
  activePath: ReadonlySet<string>,
  currentLeafId: string | null,
): readonly FlatLayoutNode<P>[];
```

`flattenVisibleTree` calls `flattenAll`, `buildActivePath`, the injected
predicate, and `recalculateVisibleStructure`. `flattenAll` calls
`computeContainsActive`, records structural parents, and checks id uniqueness.
`buildActivePath` and `recalculateVisibleStructure` walk only `parentById`.
`treePrefix` is independent of payload and traversal.

Moved from `tree.ts` into it (generic, renamed only where shown):
`TreeGutter`, `FlatTreeNode` → `FlatLayoutNode<P>`, `computeContainsActive`,
`flattenAll`, `buildActivePath`, `recalculateVisibleStructure`,
`treePrefix`, `flattenTreeForFormat` → `flattenVisibleTree` (the name drops
the format bias: clauctl's planned TUI `/tree` — the same pipeline pi's
`TreeSelectorComponent` runs, with selection/scroll/theming on top — is an
anticipated second consumer). Internals swap `node.entry.id` /
`node.entry.parentId` for `node.id` / a tree-parent map:

- `flattenAll` records each node's tree parent in an id-keyed
  `Map<string, string | null>` while traversing. On a duplicate id it throws
  an ordinary `Error` with the exact message
  `Duplicate layout node id: <id>`. `buildActivePath` walks that map from
  `currentLeafId` instead of `entry.parentId` — line-for-line parallel to
  pi's walk, just through the tree-parent map instead of `entry.parentId`
  lookups.
- `recalculateVisibleStructure`'s "nearest visible ancestor" loop walks the
  same map instead of `entry.parentId`; everything else stays id-keyed
  exactly as in pi.
- `passesFilter` becomes the injected predicate; the pi
  `FilterNode`/`FilterMode` plumbing stays in `tree.ts`/`filter.ts`.
- The child-geometry block (`childIndent`, `connectorDisplayed`,
  `connectorPosition`, `childGutters`) duplicated between `flattenAll` and
  `recalculateVisibleStructure` stays duplicated: pi duplicates it the same
  way between its two traversals, and keeping the file diffable against pi
  outweighs the dedup.

**`src/format/tree.ts`** keeps everything pi-specific: `entrySummary`,
`formatTreeNodeLine` (marker + `entry.id` + width truncation — reads
`flatNode.node.payload`; un-export it, nothing outside `tree.ts` imports
it), `DEFAULT_TREE_FORMAT_OPTIONS`, and `formatTreeInput`. Its complete
changed type design is:

```ts
function toLayoutNode(node: SessionTreeNode): LayoutNode<SessionTreeNode>;

function formatTreeNodeLine(
  flatNode: FlatLayoutNode<SessionTreeNode>,
  options: TreeFormatOptions,
): string;
```

The retained symbols have these exact signatures:

```ts
export const DEFAULT_TREE_FORMAT_OPTIONS: TreeFormatOptions;

function entrySummary(entry: SessionEntry): string;

export function formatTreeInput(
  input: TreeInput,
  options?: Partial<TreeFormatOptions>,
): string;
```

`toLayoutNode` performs one O(n) structural map (`id` = `entry.id`, `payload` =
the whole node so `label` stays available; pictl's private implementation is
recursive). `formatTreeInput` maps roots
through `toLayoutNode`, calls `flattenVisibleTree`, and passes a predicate
wrapping `passesFilter(…, currentLeafId, filter)`. `formatTreeNodeLine` calls
shared `treePrefix` and reads the original `SessionTreeNode` through
`flatNode.node.payload`.

The following symbols leave `tree.ts`: `TreeGutter`, `FlatTreeNode`,
`FlatTreeNodeDraft`, `StackItem`, `computeContainsActive`, `flattenAll`,
`buildActivePath`, `recalculateVisibleStructure`, `treePrefix`, and
`flattenTreeForFormat`. `formatTreeNodeLine` changes from exported to private.

`src/format/filter.ts`, `input.ts`, `command.ts`: unchanged.

### Success criteria

1. The repo's full `npm run presubmit` pipeline passes with no modifications
   to existing test assertions or fixtures. The only externally consumed
   symbol is `formatTreeInput` (verified: `format.test.ts` and `command.ts`
   import nothing else from `tree.ts`), and its signature and output are
   unchanged. `format tree` output is byte-identical for all existing
   fixtures; the tree-edge walk and duplicate-id guard are invisible for pi
   trees. If any fixture output changes, that is a bug in the refactor, not
   an expectation to update.
2. `src/format/tree-layout.ts` has zero import statements and no references
   to `@geraschenko/pi-coding-agent` types.
3. `tree.ts` no longer contains layout geometry (no gutter/indent/stack
   code), only summaries, line rendering, options, and the adapter.
4. Focused tests of the public generic interface verify:
   - duplicate ids throw `Error` with the exact agreed message;
   - active-path marking and filtered-node reattachment follow structural
     edges despite deliberately contradictory parent-like payload data;
   - multi-root virtual-root and gutter geometry through `treePrefix`.
5. `docs/specs/format-command.md` no longer presents `FlatTreeNode`,
   `flattenTreeForFormat`, or exported `formatTreeNodeLine` as the current
   interface; it points to this extraction spec and the new interface.

### Preconditions and non-goals

- `roots` must describe a finite acyclic forest in which each structural node
  occurs once and every node id is unique. Duplicate ids are checked at
  runtime; cycles and shared node references are documented precondition
  violations and are not separately reference-validated.
- Any rendering or filter behavior change is a non-goal.
- Exporting the adapter or per-repo line rendering from the shared file is a
  non-goal — markers, ids, widths, and summaries stay consumer-side.
- clauctl-side work (its sync-set entry and `format tree` build against this
  file are clauctl's `docs/specs/format-tree.md`) is a non-goal.

# IMPLEMENTATION IDEAS

- The exact public API above (names, fields, signature) is **agreed with
  clauctl** — its spec quotes it verbatim. If implementation reveals a
  problem with it, stop and discuss rather than adjusting unilaterally.
- The subtle parts are the gutter math in `treePrefix`/`flattenAll` and the
  virtual-root indent handling — move them verbatim; do not simplify in the
  same change.
- **Staying structurally diffable against pi's `TreeSelector` is a design
  goal**: this rendering descends from it (see the "Adapted from pi"
  comments), and future pi changes should port as near-mechanical diffs.
  That is why internals stay id-keyed and the child-geometry duplication
  stays, and why the only structural deltas are the ones the extraction
  forces: generic `LayoutNode<P>`, the tree-parent map, the injected
  predicate, and the duplicate-id guard.
- Build the approved type structure with compiling stub implementations
  before moving layout behavior. If the approved types do not compile, stop
  and return to spec refinement rather than changing them during
  implementation.
- Use `/reviewer` for a fresh-eyes pass before finishing if the diff becomes
  larger than expected.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-16: Handoff written from the clauctl `format tree` derisk
  discussion (clauctl `docs/specs/format-tree.md`, same date). Key decisions
  inherited from there: payload-adapter `LayoutNode<P>` shape chosen over
  accessor callbacks (generic module stays dumb; adapter is one O(n) map);
  tree-edge walks replace `parentId` walks (identical for pi, required for
  clauctl's boundary-relinked trees).
- 2026-07-16 (later): `flattenTreeForFormat` renamed `flattenVisibleTree` in
  the agreed API after checking pi's `TreeSelectorComponent` — clauctl's
  planned TUI `/tree` is a second consumer of the same pipeline, so the
  name shouldn't bake in the format command.
- 2026-07-16 (review): three decisions from Anton's review. (a) Duplicate
  ids must behave — clauctl `set-context` relink boundaries will produce
  them once its `buildTree` supports relinks; internals therefore key by
  node reference, with the leaf-matching semantics stated in Problem. No
  public API change (reference keying was already blessed as an internal
  choice), but clauctl's `format-tree.md` should inherit the duplicate-id
  behavior statement. (b) `formatTreeNodeLine` gets un-exported (no
  external importers). (c) The child-geometry block duplicated between
  `flattenAll` and `recalculateVisibleStructure` is extracted into a shared
  helper in this change rather than a follow-up, so clauctl syncs the
  simplified file from the start.
- 2026-07-16 (still later): clauctl resolved its duplicate-node problem
  upstream — occurrence identity is `(uuid, viaBoundary)` and its adapter
  emits unique composite layout ids (clauctl commit `aee6aef`), so no
  consumer sends duplicate ids. The duplicate-id handling here is
  downgraded from a clauctl-correctness requirement to a robustness
  guarantee, which clauctl's spec explicitly relies on staying documented.
  Design unchanged: reference keying and the every-matching-occurrence
  semantics stay (also simpler than the id maps they replace), as do the
  pinning tests in success criterion 4.
- 2026-07-16 (pi-diffability round): Anton overturned the reference-keying
  and geometry-extraction decisions above. New criterion: the layout file
  should stay structurally diffable against pi's `TreeSelector` (the
  upstream this rendering descends from), so future pi changes port as
  near-mechanical diffs. pi is thoroughly id-keyed and duplicates the
  child-geometry block between its two traversals, so pictl keeps both.
  Duplicate-id handling becomes a checked precondition — throw on
  duplicates in `flattenVisibleTree` — which fails adapter bugs loudly at
  zero structural cost. Requires two clauctl-side notes: (a)
  `format-tree.md`'s "every-matching-occurrence semantics stays a
  robustness guarantee" sentence becomes "unique layout ids are a checked
  precondition; duplicates throw"; (b) the substructure follow-up's
  degenerate-boundary skip (a boundary's rendered chain never repeats a
  uuid) is now load-bearing for not crashing — a violation makes the
  synced layout throw rather than render oddly, so the follow-up must
  implement the skip, not just record the assumption.
- 2026-07-16 (spec refinement): Approved the complete public and private type
  design. Clarified the finite-forest precondition, exact duplicate-id error,
  O(n) adapter requirement, old-spec migration, and focused generic tests.
  Cycles and shared references remain documented precondition violations;
  only duplicate ids receive a runtime guard.
- 2026-07-16 (spec critique): Confirmed the type dependencies and success
  criteria against the current implementation and package scripts. Corrected
  the obsolete cycle claim, old section references, workflow status, and
  type-first implementation instruction. No unresolved design questions
  remain.
- [x] Approve the complete type design and critically revise the spec.
- 2026-07-16 (implementation): Added the approved type structure with stub
  implementations in `tree-layout.ts` and `tree.ts`; `npm run check` passed
  before layout behavior was moved.
- [x] Build the approved type structure with stubs and run `npm run check`.
- 2026-07-16 (implementation complete): Extracted the import-free generic
  layout module, added the pi payload adapter, and removed geometry and private
  rendering exports from `tree.ts`. Existing tree output tests remained
  byte-identical. Added focused duplicate-id, structural-parent, filtering,
  virtual-root, and gutter tests. Updated the original format-command spec to
  point to the extracted interface.
- 2026-07-16 (verification): `npm run presubmit` passed with 89 tests and
  `npm run build` passed. The first presubmit attempt only found formatting
  changes in the transient file-based implementation todo; removing that
  untracked harness artifact allowed the clean rerun to pass.
- [x] Implement the generic layout module and pi adapter.
- [x] Add focused generic layout tests without changing existing assertions.
- [x] Update `docs/specs/format-command.md` to point to the new interface.
- [x] Run `npm run presubmit` and review the final diff.
