import assert from "node:assert/strict";
import { test } from "node:test";
import { determineTargets } from "./targets.ts";
import { UsageError } from "./util.ts";

test("determineTargets implements target precedence and cardinality", () => {
  assert.deepEqual(determineTargets("none", [], { PICTL_TARGET: "env" }), []);
  assert.deepEqual(
    determineTargets("single", ["flag"], { PICTL_TARGET: "env" }),
    ["flag"],
  );
  assert.deepEqual(determineTargets("single", [], { PICTL_TARGET: "env" }), [
    "env",
  ]);
  assert.deepEqual(
    determineTargets("multiple", ["a", "b"], { PICTL_TARGET: "env" }),
    ["a", "b"],
  );
  assert.deepEqual(determineTargets("multiple", [], { PICTL_TARGET: "env" }), [
    "env",
  ]);
  assert.throws(() => determineTargets("single", ["a", "b"], {}), UsageError);
  assert.throws(() => determineTargets("single", [], {}), UsageError);
  assert.throws(() => determineTargets("multiple", [], {}), UsageError);
});
