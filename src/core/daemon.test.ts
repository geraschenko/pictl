import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectTrustWouldBlock } from "./daemon.ts";

test("projectTrustWouldBlock short-circuits when an approve flag is present", () => {
  // Returns before consulting trust inputs, so the cwd is irrelevant.
  assert.equal(projectTrustWouldBlock("/nonexistent", ["--approve"]), false);
  assert.equal(projectTrustWouldBlock("/nonexistent", ["-a"]), false);
  assert.equal(projectTrustWouldBlock("/nonexistent", ["--no-approve"]), false);
});

test("projectTrustWouldBlock is false for a directory with no trust inputs", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "pictl-trust-test-"));
  try {
    assert.equal(projectTrustWouldBlock(emptyDir, []), false);
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});
