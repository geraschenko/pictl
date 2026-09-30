import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord } from "./util.ts";

test("isRecord accepts objects but excludes null, arrays, and primitives", () => {
  for (const value of [
    {},
    { entries: [] },
    { 0: "value" },
    Object.create(null),
  ]) {
    assert.equal(isRecord(value), true);
  }
  for (const value of [null, undefined, [], [1], "text", 0, false]) {
    assert.equal(isRecord(value), false);
  }
  assert.equal(isRecord(Object.assign([], { type: "text" })), false);
});
