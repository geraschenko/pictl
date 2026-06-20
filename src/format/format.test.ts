import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parsePositiveInteger } from "./command.ts";
import { formatEntriesInput } from "./entries.ts";
import {
  parseEntriesInput,
  parseMessageRecords,
  parseTreeInput,
} from "./input.ts";
import { formatMessageRecords } from "./messages.ts";
import { formatTreeInput } from "./tree.ts";
import type { EntriesInput } from "./types.ts";

function isEntriesInput(
  input: EntriesInput | readonly unknown[],
): input is EntriesInput {
  return !Array.isArray(input);
}

async function fixture(path: string): Promise<string> {
  return await readFile(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
}

test("format messages renders text, compact tool calls, summaries, and cursor", async () => {
  const output = formatMessageRecords(
    parseMessageRecords(await fixture("messages.jsonl")),
  );
  assert.equal(
    output,
    "== user ==\nHello\n\n" +
      "== assistant ==\n[thinking]\n[tool:read path: README.md]\n\n" +
      "[read:ok 1 lines, 12 bytes]\n\n" +
      "[cursor: 0eb932a9]\n",
  );
});

test("format messages includes failed result snippets in summary mode", () => {
  const output = formatMessageRecords(
    parseMessageRecords(
      '{"type":"message","message":{"role":"toolResult","toolCallId":"c","toolName":"bash","content":[{"type":"text","text":"one\\ntwo\\nthree"}],"isError":true,"timestamp":1}}\n',
    ),
    { maxErrorLines: 2 },
  );
  assert.equal(output, "[bash:error 3 lines, 13 bytes]\none\ntwo\n");
});

test("format entries supports get-entries JSON", async () => {
  const input = parseEntriesInput(await fixture("entries.json"));
  assert.equal(
    isEntriesInput(input) ? formatEntriesInput(input) : "",
    "79d4e93e user       Help me write a script\n" +
      "ab4e0c01 assistant  [thinking] [tool: read]\n",
  );
});

test("format entries rejects cursor JSONL records", () => {
  assert.throws(
    () =>
      parseEntriesInput(
        '{"type":"pictl_cursor","sessionId":"s","entryId":"e"}\n',
      ),
    /invalid session entry/u,
  );
});

test("format tree renders conversation branches with current leaf marker", async () => {
  const output = formatTreeInput(parseTreeInput(await fixture("tree.json")));
  assert.equal(
    output,
    "79d4e93e user: Start\n" +
      "├─ * ea28b2b5 assistant: Second branch\n" +
      "└─ ab4e0c01 assistant: First branch\n" +
      "[cursor: ea28b2b5]\n",
  );
});

test("format tree width applies to full rendered line", async () => {
  const output = formatTreeInput(parseTreeInput(await fixture("tree.json")), {
    width: 28,
  });
  const treeLines = output.trimEnd().split("\n");
  assert.equal(treeLines[1], "├─ * ea28b2b5 assistant: Se…");
  assert.ok(treeLines.every((line) => [...line].length <= 28));
});

test("parsePositiveInteger validates exact error message", () => {
  assert.equal(parsePositiveInteger("12"), 12);
  assert.throws(
    () => parsePositiveInteger("0"),
    /invalid positive integer value: 0/u,
  );
});
