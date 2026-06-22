import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNavigateArgs } from "./navigate-tree.ts";

test("targetId only", () => {
  assert.deepEqual(parseNavigateArgs("abc123"), {
    targetId: "abc123",
    label: undefined,
    continuation: undefined,
    continuationFile: undefined,
  });
});

test("targetId is required", () => {
  assert.throws(() => parseNavigateArgs(""), /targetId is required/);
  assert.throws(() => parseNavigateArgs("   "), /targetId is required/);
  assert.throws(() => parseNavigateArgs("--label foo"), /targetId is required/);
});

test("--label is passed through", () => {
  const parsed = parseNavigateArgs("abc --label checkpoint");
  assert.equal(parsed.targetId, "abc");
  assert.equal(parsed.label, "checkpoint");
});

test("--label before targetId", () => {
  const parsed = parseNavigateArgs("--label checkpoint abc");
  assert.equal(parsed.targetId, "abc");
  assert.equal(parsed.label, "checkpoint");
});

test("--continue consumes the rest of the line verbatim", () => {
  const parsed = parseNavigateArgs("abc --continue Resume implementing X using the summary above.");
  assert.equal(parsed.targetId, "abc");
  assert.equal(parsed.continuation, "Resume implementing X using the summary above.");
});

test("--continue preserves embedded spaces, quotes, and flag-looking text", () => {
  const parsed = parseNavigateArgs(`abc --continue use "quoted" text /slash --label not-a-flag`);
  assert.equal(parsed.targetId, "abc");
  assert.equal(parsed.continuation, `use "quoted" text /slash --label not-a-flag`);
  assert.equal(parsed.label, undefined);
});

test("--continue skips exactly one separating space, preserving the rest", () => {
  const parsed = parseNavigateArgs("abc --continue   leading spaces kept");
  assert.equal(parsed.continuation, "  leading spaces kept");
});

test("--label applies before a later --continue", () => {
  const parsed = parseNavigateArgs("abc --label cp --continue go now");
  assert.equal(parsed.label, "cp");
  assert.equal(parsed.continuation, "go now");
});

test("--continue-file captures the path, not the contents", () => {
  const parsed = parseNavigateArgs("abc --continue-file /tmp/summary.md");
  assert.equal(parsed.targetId, "abc");
  assert.equal(parsed.continuationFile, "/tmp/summary.md");
  assert.equal(parsed.continuation, undefined);
});

test("--continue-file before --continue is a conflict", () => {
  assert.throws(
    () => parseNavigateArgs("abc --continue-file /tmp/x --continue go"),
    /mutually exclusive/,
  );
});

test("--continue-file after --continue is literal continuation text, not a flag", () => {
  const parsed = parseNavigateArgs("abc --continue go --continue-file /tmp/x");
  assert.equal(parsed.continuation, "go --continue-file /tmp/x");
  assert.equal(parsed.continuationFile, undefined);
});

test("empty / whitespace-only --continue is an error", () => {
  assert.throws(() => parseNavigateArgs("abc --continue"), /non-empty continuation/);
  assert.throws(() => parseNavigateArgs("abc --continue    "), /non-empty continuation/);
});

test("unknown flag fails closed", () => {
  assert.throws(() => parseNavigateArgs("abc --summarize"), /unknown flag: --summarize/);
});

test("flag missing its value fails closed", () => {
  assert.throws(() => parseNavigateArgs("abc --label"), /--label requires a value/);
  assert.throws(() => parseNavigateArgs("abc --continue-file"), /--continue-file requires a value/);
});

test("duplicate flag fails closed", () => {
  assert.throws(() => parseNavigateArgs("abc --label a --label b"), /--label given more than once/);
});

test("a second positional argument fails closed", () => {
  assert.throws(() => parseNavigateArgs("abc def"), /unexpected argument: def/);
});
