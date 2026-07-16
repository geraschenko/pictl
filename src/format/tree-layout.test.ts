import assert from "node:assert/strict";
import { test } from "node:test";
import type { LayoutNode } from "./tree-layout.ts";
import { flattenVisibleTree, treePrefix } from "./tree-layout.ts";

test("flattenVisibleTree rejects duplicate node ids", () => {
  const duplicate: LayoutNode<null> = {
    id: "duplicate",
    children: [],
    payload: null,
  };
  const roots: readonly LayoutNode<null>[] = [
    duplicate,
    { id: "duplicate", children: [], payload: null },
  ];

  assert.throws(
    () => flattenVisibleTree(roots, null, () => true),
    new Error("Duplicate layout node id: duplicate"),
  );
});

test("flattenVisibleTree uses structural edges for active paths and filtering", () => {
  interface Payload {
    readonly rawParentId: string | null;
  }

  const leaf: LayoutNode<Payload> = {
    id: "leaf",
    children: [],
    payload: { rawParentId: null },
  };
  const hidden: LayoutNode<Payload> = {
    id: "hidden",
    children: [leaf],
    payload: { rawParentId: "unrelated" },
  };
  const sibling: LayoutNode<Payload> = {
    id: "sibling",
    children: [],
    payload: { rawParentId: "also-unrelated" },
  };
  const root: LayoutNode<Payload> = {
    id: "root",
    children: [hidden, sibling],
    payload: { rawParentId: "not-a-root" },
  };

  const flat = flattenVisibleTree(
    [root],
    "leaf",
    (node) => node.id !== "hidden",
  );

  assert.deepEqual(
    flat.map((node) => ({
      id: node.node.id,
      active: node.isOnActivePath,
      current: node.isCurrentLeaf,
      prefix: treePrefix(node),
    })),
    [
      { id: "root", active: true, current: false, prefix: "" },
      { id: "leaf", active: true, current: true, prefix: "├─ " },
      { id: "sibling", active: false, current: false, prefix: "└─ " },
    ],
  );
});

test("treePrefix preserves virtual-root and nested gutter geometry", () => {
  const node = (
    id: string,
    children: readonly LayoutNode<null>[] = [],
  ): LayoutNode<null> => ({ id, children, payload: null });
  const roots = [
    node("root-1", [
      node("branch", [node("branch-a"), node("branch-b")]),
      node("root-1-last"),
    ]),
    node("root-2"),
  ];

  const flat = flattenVisibleTree(roots, null, () => true);

  assert.deepEqual(
    flat.map((item) => ({
      id: item.node.id,
      virtualRoot: item.isVirtualRootChild,
      prefix: treePrefix(item),
    })),
    [
      { id: "root-1", virtualRoot: true, prefix: "" },
      { id: "branch", virtualRoot: false, prefix: "   ├─ " },
      { id: "branch-a", virtualRoot: false, prefix: "│     ├─ " },
      { id: "branch-b", virtualRoot: false, prefix: "│     └─ " },
      { id: "root-1-last", virtualRoot: false, prefix: "   └─ " },
      { id: "root-2", virtualRoot: true, prefix: "" },
    ],
  );
});
