import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parsePositiveInteger } from "./command.ts";
import { formatEntriesInput } from "./entries.ts";
import { parseEntriesInput, parseMessageRecords } from "./input.ts";
import { formatMessageRecords } from "./messages.ts";
import { formatEntriesTree } from "./tree.ts";
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

test("format messages supports get-messages JSON", async () => {
  const output = formatMessageRecords(
    parseMessageRecords(await fixture("messages.json")),
  );
  assert.equal(
    output,
    "== user ==\nHello\n\n" +
      "== assistant ==\n[thinking]\n[tool:read path: README.md]\n\n" +
      "[read:ok 1 lines, 12 bytes]\n",
  );
});

test("format messages renders control event details from real pi event fields", () => {
  const output = formatMessageRecords(
    parseMessageRecords(
      [
        {
          type: "control",
          control: {
            kind: "tree_navigated",
            event: {
              type: "tree_navigated",
              oldLeafId: "old12345",
              newLeafId: "new12345",
            },
          },
        },
        {
          type: "control",
          control: {
            kind: "session_changed",
            event: {
              type: "session_changed",
              state: {
                sessionId: "session-1",
                sessionFile: "/tmp/session.jsonl",
              },
            },
          },
        },
        {
          type: "control",
          control: {
            kind: "queue_update",
            event: {
              type: "queue_update",
              steering: ["a"],
              followUp: ["b", "c"],
            },
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    ),
  );
  assert.equal(
    output,
    "[control: tree navigated old12345 -> new12345]\n\n" +
      "[control: session changed to session-1 /tmp/session.jsonl]\n\n" +
      "[control: queue update steering=1 follow-up=2]\n",
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

test("format entries can use conversation filter", () => {
  const input = parseEntriesInput(
    [
      {
        type: "message",
        id: "user0001",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Run a tool" }],
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "tool0001",
        parentId: "user0001",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "true" },
            },
          ],
          api: "test",
          provider: "test",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "compaction",
        id: "compact1",
        parentId: "tool0001",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: "large history",
        firstKeptEntryId: "user0001",
        tokensBefore: 110123,
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  assert.equal(
    isEntriesInput(input)
      ? ""
      : formatEntriesInput({ entries: input }, { filter: "conversation" }),
    "user0001 user       Run a tool\n" +
      "compact1 compaction [compaction: 110k tokens]\n",
  );
});

test("format entries width applies to full rendered line", async () => {
  const input = parseEntriesInput(await fixture("entries.json"));
  const output = isEntriesInput(input)
    ? formatEntriesInput(input, { width: 28 })
    : "";
  const lines = output.trimEnd().split("\n");
  assert.equal(lines[0], "79d4e93e user       Help me…");
  assert.ok(lines.every((line) => [...line].length <= 28));
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

function userEntry(
  id: string,
  parentId: string | null,
  text: string,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  };
}

async function treeFixture(): Promise<EntriesInput> {
  const input = parseEntriesInput(await fixture("entries-tree.json"));
  assert.ok(isEntriesInput(input));
  return input;
}

test("format tree renders conversation branches with current leaf marker", async () => {
  assert.equal(
    formatEntriesTree(await treeFixture()),
    "• 79d4e93e user: Start\n" +
      "├─ * ea28b2b5 assistant: Second branch\n" +
      "└─ ab4e0c01 assistant: First branch\n" +
      "[cursor: ea28b2b5]\n",
  );
});

test("format tree resolves labels from label entries", async () => {
  assert.equal(
    formatEntriesTree(await treeFixture(), { filter: "pi-labeled-only" }),
    "ab4e0c01 assistant: First branch\n[cursor: ea28b2b5]\n",
  );
});

test("format tree conversation includes compaction token boundary", () => {
  const input = parseEntriesInput(
    JSON.stringify({
      entries: [
        userEntry("user0001", null, "Before compaction"),
        {
          type: "compaction",
          id: "compact1",
          parentId: "user0001",
          timestamp: "2026-01-01T00:00:01.000Z",
          summary: "large history",
          firstKeptEntryId: "user0001",
          tokensBefore: 110123,
        },
      ],
      leafId: "compact1",
    }),
  );
  assert.ok(isEntriesInput(input));
  assert.equal(
    formatEntriesTree(input),
    "• user0001 user: Before compaction\n" +
      "* compact1 [compaction: 110k tokens]\n" +
      "[cursor: compact1]\n",
  );
});

test("format tree conversation hides tool-only assistant messages", () => {
  const input = parseEntriesInput(
    JSON.stringify({
      entries: [
        userEntry("user0001", null, "Run a tool"),
        {
          type: "message",
          id: "tool0001",
          parentId: "user0001",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                arguments: { command: "true" },
              },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "toolUse",
            timestamp: 2,
          },
        },
      ],
      leafId: "user0001",
    }),
  );
  assert.ok(isEntriesInput(input));
  assert.equal(
    formatEntriesTree(input),
    "* user0001 user: Run a tool\n[cursor: user0001]\n",
  );
});

test("format tree width applies to full rendered line", async () => {
  const output = formatEntriesTree(await treeFixture(), { width: 28 });
  const treeLines = output.trimEnd().split("\n");
  assert.equal(treeLines[1], "├─ * ea28b2b5 assistant: Se…");
  assert.ok(treeLines.every((line) => [...line].length <= 28));
});

test("format tree entry JSONL uses the last entry as cursor", () => {
  const input = parseEntriesInput(
    [
      userEntry("user0001", null, "First"),
      userEntry("user0002", "user0001", "Second"),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  assert.ok(!isEntriesInput(input));
  assert.equal(
    formatEntriesTree({ entries: input }),
    "• user0001 user: First\n* user0002 user: Second\n[cursor: user0002]\n",
  );
});

test("format tree renders entries with missing parents as roots", () => {
  const input = parseEntriesInput(
    JSON.stringify(userEntry("orphan01", "gone0000", "Adrift")),
  );
  assert.ok(!isEntriesInput(input));
  assert.equal(
    formatEntriesTree({ entries: input }),
    "* orphan01 user: Adrift\n[cursor: orphan01]\n",
  );
});

test("format tree rejects duplicate entry ids", () => {
  const input = parseEntriesInput(
    [userEntry("user0001", null, "One"), userEntry("user0001", null, "Two")]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  assert.ok(!isEntriesInput(input));
  assert.throws(
    () => formatEntriesTree({ entries: input }),
    new Error("duplicate session entry id: user0001"),
  );
});

test("parseEntriesInput cross-points get-tree output at get-entries", async () => {
  await assert.rejects(
    async () => parseEntriesInput(await fixture("tree.json")),
    /looks like get-tree output; feed it get-entries output instead/u,
  );
});

test("parsePositiveInteger validates exact error message", () => {
  assert.equal(parsePositiveInteger("12"), 12);
  assert.throws(
    () => parsePositiveInteger("0"),
    /invalid positive integer value: 0/u,
  );
});
