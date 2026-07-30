import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { app } from "../core/app.ts";
import { runCliApp } from "../core/cli.ts";
import type { MessageStreamRecord } from "../core/streaming/types.ts";
import { fakeProcess } from "../core/test-util.ts";
import { parsePositiveInteger } from "./command.ts";
import { formatEntriesInput } from "./entries.ts";
import {
  decodeFormatInput,
  messageRecordsOf,
  parseEntriesInput,
} from "./input.ts";
import { formatMessageRecords, MessageFormatter } from "./messages.ts";
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

/** Collects the streaming message-record view of a whole input string. */
async function parseMessageRecords(
  input: string,
): Promise<readonly MessageStreamRecord[]> {
  const records: MessageStreamRecord[] = [];
  for await (const record of messageRecordsOf(
    await decodeFormatInput([input]),
  )) {
    records.push(record);
  }
  return records;
}

test("format messages coalesces the read run and renders text and cursor", async () => {
  const output = formatMessageRecords(
    await parseMessageRecords(await fixture("messages.jsonl")),
  );
  assert.equal(
    output,
    "== user ==\nHello\n\n" +
      "[thought for 1ms; read README.md]\n\n" +
      "[cursor: 0eb932a9]\n",
  );
});

test("format messages --tool-results full renders every record", async () => {
  const output = formatMessageRecords(
    await parseMessageRecords(await fixture("messages.jsonl")),
    { toolResults: "full" },
  );
  assert.equal(
    output,
    "== user ==\nHello\n\n" +
      "== assistant ==\n[thinking]\n[tool:read path: README.md]\n\n" +
      "[read:ok 1 lines, 12 bytes]\nlarge output\n\n" +
      "[cursor: 0eb932a9]\n",
  );
});

function messageJsonl(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function userMessageRecord(text: string, timestamp?: number): unknown {
  return {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      ...(timestamp !== undefined && { timestamp }),
    },
  };
}

function assistantRecord(content: unknown[], timestamp?: number): unknown {
  return {
    type: "message",
    message: {
      role: "assistant",
      content,
      stopReason: "toolUse",
      ...(timestamp !== undefined && { timestamp }),
    },
  };
}

function toolResultRecord(
  toolCallId: string,
  toolName: string,
  text: string,
  timestamp?: number,
  isError = false,
): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text }],
      isError,
      ...(timestamp !== undefined && { timestamp }),
    },
  };
}

test("coalescing groups tools by first appearance and sums thinking time", async () => {
  const input = messageJsonl([
    userMessageRecord("go", 1000),
    assistantRecord(
      [
        { type: "thinking", thinking: "..." },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      3000,
    ),
    toolResultRecord("call-1", "read", "ok", 3500),
    assistantRecord(
      [
        { type: "thinking", thinking: "..." },
        {
          type: "toolCall",
          id: "call-2",
          name: "grep",
          arguments: { pattern: "TODO" },
        },
        {
          type: "toolCall",
          id: "call-3",
          name: "read",
          arguments: { path: "b.ts" },
        },
      ],
      5800,
    ),
    toolResultRecord("call-2", "grep", "ok", 5900),
    toolResultRecord("call-3", "read", "ok", 6000),
    userMessageRecord("done", 7000),
  ]);
  assert.equal(
    formatMessageRecords(await parseMessageRecords(input)),
    "== user ==\ngo\n\n" +
      "[thought for 4.3s; read a.ts, b.ts; grep TODO]\n\n" +
      "== user ==\ndone\n",
  );
});

test("coalescing renders bare thought when no duration is computable", async () => {
  const input = messageJsonl([
    assistantRecord([{ type: "thinking", thinking: "..." }]),
  ]);
  assert.equal(
    formatMessageRecords(await parseMessageRecords(input)),
    "[thought]\n",
  );
});

test("a failed tool result breaks the run and renders normally", async () => {
  const input = messageJsonl([
    assistantRecord([
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "a.ts" },
      },
    ]),
    toolResultRecord("call-1", "read", "boom", undefined, true),
  ]);
  assert.equal(
    formatMessageRecords(await parseMessageRecords(input)),
    "[read a.ts]\n\n[read:error 1 lines, 4 bytes]\nboom\n",
  );
});

test("non-read-only calls do not coalesce", async () => {
  const input = messageJsonl([
    assistantRecord([
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "true" },
      },
    ]),
  ]);
  assert.equal(
    formatMessageRecords(await parseMessageRecords(input)),
    "== assistant ==\n[tool:bash command: true]\n",
  );
});

test("MessageFormatter holds a run back and flushes it with the breaker's block", async () => {
  const records = await parseMessageRecords(await fixture("messages.jsonl"));
  const formatter = new MessageFormatter();
  const chunks = records.map((record) => formatter.push(record));
  const endChunk = formatter.end();
  assert.deepEqual(chunks, [
    "== user ==\nHello",
    "",
    "",
    "\n\n[thought for 1ms; read README.md]\n\n[cursor: 0eb932a9]",
  ]);
  assert.equal(endChunk, "\n");
  assert.equal(chunks.join("") + endChunk, formatMessageRecords(records));
});

test("MessageFormatter renders nothing for an empty stream", () => {
  const formatter = new MessageFormatter();
  assert.equal(formatter.end(), "");
});

test("format messages supports get-messages JSON", async () => {
  const output = formatMessageRecords(
    await parseMessageRecords(await fixture("messages.json")),
  );
  assert.equal(
    output,
    "== user ==\nHello\n\n[thought for 1ms; read README.md]\n",
  );
});

test("format messages supports append-ordered get-entries JSON", async () => {
  const output = formatMessageRecords(
    await parseMessageRecords(await fixture("entries.json")),
  );
  assert.equal(
    output,
    "== user ==\nHelp me write a script\n\n" +
      "[thought for 1ms; read README.md]\n",
  );
});

test("format messages ignores leafId and retains inactive-branch entries", async () => {
  const input = JSON.stringify({
    entries: [
      userEntry("A", null, "root"),
      userEntry("B", "A", "active leaf"),
      userEntry("C", "A", "inactive branch"),
    ],
    leafId: "B",
  });
  assert.equal(
    formatMessageRecords(await parseMessageRecords(input)),
    "== user ==\nroot\n\n" +
      "== user ==\nactive leaf\n\n" +
      "[control: tree navigated B -> A]\n\n" +
      "== user ==\ninactive branch\n",
  );
});

test("format messages delegates legacy null content normalization to Pi", async () => {
  const input = JSON.stringify({
    entries: [
      {
        type: "message",
        id: "legacy",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: null, timestamp: 1 },
      },
      {
        type: "custom_message",
        id: "custom",
        parentId: "legacy",
        timestamp: "2026-01-01T00:00:01.000Z",
        customType: "notice",
        content: null,
        display: true,
      },
    ],
    leafId: "custom",
  });
  const records = await parseMessageRecords(input);
  assert.deepEqual(records[0], {
    type: "message",
    message: { role: "user", content: [], timestamp: 1 },
  });
  assert.deepEqual(records[1], {
    type: "message",
    message: {
      role: "custom",
      customType: "notice",
      content: [],
      display: true,
      details: undefined,
      timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
    },
  });
  assert.equal(
    formatMessageRecords(records),
    "== user ==\n\n\n== custom:notice ==\n\n",
  );
});

test("format messages renders control event details from real pi event fields", async () => {
  const output = formatMessageRecords(
    await parseMessageRecords(
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
            kind: "tree_navigated",
            event: {
              type: "tree_navigated",
              oldLeafId: null,
              newLeafId: "only-new-leaf",
            },
          },
        },
        {
          type: "control",
          control: {
            kind: "model_changed",
            event: {
              type: "model_changed",
              model: {
                provider: "anthropic",
                id: "claude-sonnet",
              },
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
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    ),
  );
  assert.equal(
    output,
    "[control: tree navigated old12345 -> new12345]\n\n" +
      "[control: tree navigated to only-new-leaf]\n\n" +
      "[model: anthropic/claude-sonnet]\n\n" +
      "[control: session changed to session-1 /tmp/session.jsonl]\n\n" +
      "[control: queue update steering=1 follow-up=2]\n",
  );
});

test("format messages rejects invalid get-entries metadata", async () => {
  await assert.rejects(
    async () => await parseMessageRecords('{"entries":[],"leafId":42}'),
    /invalid entries input: invalid leafId/u,
  );
});

test("format messages includes failed result snippets in summary mode", async () => {
  const output = formatMessageRecords(
    await parseMessageRecords(
      '{"type":"message","message":{"role":"toolResult","toolCallId":"c","toolName":"bash","content":[{"type":"text","text":"one\\ntwo\\nthree"}],"isError":true,"timestamp":1}}\n',
    ),
    { maxErrorLines: 2 },
  );
  assert.equal(output, "[bash:error 3 lines, 13 bytes]\none\ntwo\n");
});

test("format messages accepts raw entry JSONL like the entries document", async () => {
  const document = await fixture("entries.json");
  // Trailing newline matters: the streaming decoder drops a torn final line.
  const entryJsonl = (JSON.parse(document) as { entries: unknown[] }).entries
    .map((entry) => `${JSON.stringify(entry)}\n`)
    .join("");
  assert.equal(
    formatMessageRecords(await parseMessageRecords(entryJsonl)),
    formatMessageRecords(await parseMessageRecords(document)),
  );
});

test("streaming decode cross-points a mid-stream shape change by record number", async () => {
  const messageLine =
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}}';
  const entryLine = JSON.stringify(userEntry("A", null, "hello"));
  await assert.rejects(
    async () => await parseMessageRecords(`${messageLine}\n${entryLine}\n`),
    /record 2 looks like session-entry output; use `pictl format entries`/u,
  );
});

test("streaming validation errors carry the record number, counting blank lines", async () => {
  const messageLine =
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}}';
  const badLine = '{"type":"message","message":{"role":"nope"}}';
  await assert.rejects(
    async () => await parseMessageRecords(`${messageLine}\n\n${badLine}\n`),
    /record 3: invalid session entry: invalid message role nope/u,
  );
});

test("format messages writes each record's block as it arrives", async () => {
  const lines = (await fixture("messages.jsonl"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `${line}\n`);
  const proc = fakeProcess({}, lines);
  await runCliApp(app, ["format", "messages"], proc.proc);
  assert.equal(proc.proc.exitCode, 0);
  assert.equal(proc.stderr, "");
  assert.deepEqual(proc.stdoutChunks, [
    "== user ==\nHello",
    "\n\n[thought for 1ms; read README.md]\n\n[cursor: 0eb932a9]",
    "\n",
  ]);
});

test("format messages renders nothing for blank input", async () => {
  const proc = fakeProcess({}, ["\n  \n"]);
  await runCliApp(app, ["format", "messages"], proc.proc);
  assert.equal(proc.proc.exitCode, 0);
  assert.equal(proc.stdout, "");
});

test("format messages projects event input through the daemon's conversion", async () => {
  const proc = fakeProcess({}, [
    '{"type":"agent_start"}\n',
    '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}}\n',
    '{"type":"pictl_cursor","sessionId":"s","entryId":"e"}\n',
  ]);
  await runCliApp(app, ["format", "messages"], proc.proc);
  assert.equal(proc.proc.exitCode, 0);
  assert.equal(proc.stderr, "");
  assert.equal(proc.stdout, "== user ==\nhi\n\n[cursor: e]\n");
});

test("format entries cross-points socket-event input at format events", async () => {
  const proc = fakeProcess({}, ['{"type":"agent_start"}\n']);
  await runCliApp(app, ["format", "entries"], proc.proc);
  assert.equal(proc.proc.exitCode, 2);
  assert.match(
    proc.stderr,
    /input looks like socket events; use `pictl format events`/u,
  );
});

test("format entries cross-points message input at format messages", async () => {
  const proc = fakeProcess({}, [
    '{"type":"pictl_cursor","sessionId":"s","entryId":"e"}\n',
  ]);
  await runCliApp(app, ["format", "entries"], proc.proc);
  assert.equal(proc.proc.exitCode, 2);
  assert.match(
    proc.stderr,
    /input looks like message output; use `pictl format messages`/u,
  );
});

test("format events renders control-kind fields, message summaries, cursors, and bare types", async () => {
  const events = [
    { type: "agent_start" },
    { type: "tree_navigated", oldLeafId: "old12345", newLeafId: "new12345" },
    { type: "tree_navigated", oldLeafId: null, newLeafId: "new12345" },
    { type: "queue_update", steering: ["a"], followUp: [] },
    {
      type: "model_changed",
      model: { provider: "anthropic", id: "claude-sonnet" },
    },
    {
      type: "session_changed",
      state: { sessionId: "session-1", sessionFile: "/tmp/s.jsonl" },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sure — looking now" }],
        stopReason: "stop",
      },
    },
    { type: "totally_new_event", payload: { anything: true } },
    { type: "pictl_cursor", sessionId: "s", entryId: "leaf1234" },
  ];
  const proc = fakeProcess(
    {},
    events.map((event) => `${JSON.stringify(event)}\n`),
  );
  await runCliApp(app, ["format", "events"], proc.proc);
  assert.equal(proc.proc.exitCode, 0);
  assert.equal(proc.stderr, "");
  assert.equal(
    proc.stdout,
    "[agent_start]\n" +
      "[tree_navigated: old12345 -> new12345]\n" +
      "[tree_navigated: to new12345]\n" +
      "[queue_update: steering=1 follow-up=0]\n" +
      "[model_changed: anthropic/claude-sonnet]\n" +
      "[session_changed: session-1 /tmp/s.jsonl]\n" +
      "[message_end] assistant: Sure — looking now\n" +
      "[totally_new_event]\n" +
      "[cursor: leaf1234]\n",
  );
});

test("format events accepts a cursor-only stream but cross-points real messages", async () => {
  const cursorLine = '{"type":"pictl_cursor","sessionId":"s","entryId":"e"}\n';
  const cursorOnly = fakeProcess({}, [cursorLine]);
  await runCliApp(app, ["format", "events"], cursorOnly.proc);
  assert.equal(cursorOnly.proc.exitCode, 0);
  assert.equal(cursorOnly.stdout, "[cursor: e]\n");

  const withMessage = fakeProcess({}, [
    cursorLine,
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}}\n',
  ]);
  await runCliApp(app, ["format", "events"], withMessage.proc);
  assert.equal(withMessage.proc.exitCode, 2);
  assert.match(
    withMessage.stderr,
    /input looks like message output; use `pictl format messages`/u,
  );
});

test("format events cross-points entry input at format entries", async () => {
  const proc = fakeProcess({}, [
    `${JSON.stringify(userEntry("A", null, "hi"))}\n`,
  ]);
  await runCliApp(app, ["format", "events"], proc.proc);
  assert.equal(proc.proc.exitCode, 2);
  assert.match(
    proc.stderr,
    /input looks like session-entry output; use `pictl format entries`/u,
  );
});

test("format entries streams entry JSONL and accepts the document form", async () => {
  const jsonlProc = fakeProcess({}, [
    `${JSON.stringify(userEntry("user0001", null, "First"))}\n`,
  ]);
  await runCliApp(app, ["format", "entries"], jsonlProc.proc);
  assert.equal(jsonlProc.proc.exitCode, 0);
  assert.equal(jsonlProc.stdout, "user0001 user       First\n");

  const documentProc = fakeProcess({}, [await fixture("entries.json")]);
  await runCliApp(app, ["format", "entries"], documentProc.proc);
  assert.equal(documentProc.proc.exitCode, 0);
  assert.equal(
    documentProc.stdout,
    "79d4e93e user       Help me write a script\n" +
      "ab4e0c01 assistant  [thinking] [tool: read]\n",
  );
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
