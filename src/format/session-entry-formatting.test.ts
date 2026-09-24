import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@geraschenko/pi-coding-agent";
import { app } from "../core/app.ts";
import { runCliApp } from "../core/cli.ts";
import type { AgentMessage } from "../core/streaming/types.ts";
import { fakeProcess } from "../core/test-util.ts";
import {
  formatEntriesInput,
  rawMessageSummary,
  summarizeEntry,
} from "./entries.ts";
import { FILTER_MODES, passesFilter } from "./filter.ts";
import { formatMessageRecords } from "./messages.ts";
import { formatEntriesTree } from "./tree.ts";

const entryBase = {
  id: "entry",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
};
const systemMessage: Extract<AgentMessage, { role: "system" }> = {
  role: "system",
  content: "",
  sections: { instructions: "Be concise", stale: null },
  toolsAdded: [
    {
      name: "read",
      description: "Read",
      parameters: { type: "object", properties: {} },
    },
  ],
  toolsRemoved: [{ name: "write" }],
  timestamp: 1,
};
const systemSummary =
  "[section: instructions] Be concise [section removed: stale] [tool added: read] [tool removed: write]";
const usageEntry: SessionEntry = {
  ...entryBase,
  type: "usage",
  kind: "cache_warm",
  provider: "test",
  model: "model",
  note: "cache refreshed",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 10,
    cacheWrite: 0,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

test("system text and section/tool-only updates render in messages, entries, trees, and events", async () => {
  assert.equal(
    rawMessageSummary({
      ...systemMessage,
      content: "Base\nprompt",
      sections: {},
      toolsAdded: [],
      toolsRemoved: [],
    }),
    "Base prompt",
  );
  assert.equal(rawMessageSummary(systemMessage), systemSummary);
  const entry: SessionEntry = {
    ...entryBase,
    type: "message",
    message: systemMessage,
  };
  assert.equal(
    formatEntriesInput({ entries: [entry] }, { width: 300 }),
    `entry system     ${systemSummary}\n`,
  );
  assert.equal(
    formatEntriesTree({ entries: [entry] }, { filter: "pi-all", width: 300 }),
    `* entry system: ${systemSummary}\n[cursor: entry]\n`,
  );
  const expectedMessage =
    "== system ==\n[section: instructions]\nBe concise\n[section removed: stale]\n[tool added: read]\n[tool removed: write]\n";
  assert.equal(
    formatMessageRecords([{ type: "message", message: systemMessage }]),
    expectedMessage,
  );
  for (const input of [
    JSON.stringify({ entries: [entry] }),
    `${JSON.stringify({ type: "message_end", message: systemMessage })}\n`,
  ]) {
    const captured = fakeProcess({}, [input]);
    await runCliApp(app, ["format", "messages"], captured.proc);
    assert.equal(captured.proc.exitCode, 0, captured.stderr);
    assert.equal(captured.stdout, expectedMessage);
  }
  const events = fakeProcess({}, [
    `${JSON.stringify({ type: "message_end", message: systemMessage })}\n`,
  ]);
  await runCliApp(app, ["format", "events"], events.proc);
  assert.equal(events.proc.exitCode, 0, events.stderr);
  assert.match(
    events.stdout,
    /\[message_end\] system: \[section: instructions\]/,
  );
});

test("system, usage, and context-edit entries reject malformed rendered fields", async () => {
  for (const entry of [
    {
      ...entryBase,
      type: "message",
      message: { ...systemMessage, sections: { invalid: 3 } },
    },
    {
      ...entryBase,
      type: "message",
      message: { ...systemMessage, toolsAdded: [null] },
    },
    { ...usageEntry, note: 42 },
    { ...entryBase, type: "context_edit", targetId: "target", replacement: {} },
  ]) {
    const captured = fakeProcess({}, [`${JSON.stringify(entry)}\n`]);
    await runCliApp(app, ["format", "entries"], captured.proc);
    assert.equal(captured.proc.exitCode, 2);
    assert.match(captured.stderr, /invalid session entry/);
  }
  const legacy = fakeProcess({}, [
    JSON.stringify({
      entries: [
        {
          ...entryBase,
          type: "message",
          message: { role: "system", content: null, timestamp: 1 },
        },
      ],
    }),
  ]);
  await runCliApp(app, ["format", "messages"], legacy.proc);
  assert.equal(legacy.proc.exitCode, 0, legacy.stderr);
  assert.equal(legacy.stdout, "== system ==\n(no content)\n");
});

test("usage is visible unfiltered but hidden by every filter, even labeled/current leaf", async () => {
  assert.equal(
    summarizeEntry(usageEntry),
    "cache_warm: test/model cache refreshed",
  );
  for (const filter of FILTER_MODES) {
    assert.equal(
      passesFilter({ entry: usageEntry, label: "warm" }, usageEntry.id, filter),
      false,
      filter,
    );
    assert.equal(formatEntriesInput({ entries: [usageEntry] }, { filter }), "");
    assert.equal(
      formatEntriesTree({ entries: [usageEntry] }, { filter }),
      "[cursor: entry]\n",
    );
  }
  const captured = fakeProcess({}, [`${JSON.stringify(usageEntry)}\n`]);
  await runCliApp(app, ["format", "entries"], captured.proc);
  assert.equal(captured.proc.exitCode, 0, captured.stderr);
  assert.equal(
    captured.stdout,
    "entry usage      cache_warm: test/model cache refreshed\n",
  );
});

test("context edits distinguish omission/replacement and follow pi bookkeeping filters", async () => {
  for (const replacement of [null, { content: "revised" }]) {
    const entry: SessionEntry = {
      ...entryBase,
      type: "context_edit",
      targetId: "target",
      replacement,
    };
    const action = replacement === null ? "omit" : "replace";
    assert.equal(summarizeEntry(entry), `${action}: target`);
    assert.equal(
      formatEntriesTree({ entries: [entry] }, { filter: "pi-all" }),
      `* entry context ${action}: target\n[cursor: entry]\n`,
    );
    for (const filter of FILTER_MODES) {
      assert.equal(
        passesFilter({ entry }, entry.id, filter),
        filter === "pi-all",
        filter,
      );
      assert.equal(
        passesFilter({ entry, label: "edit" }, null, filter),
        filter === "pi-all" || filter === "pi-labeled-only",
        filter,
      );
    }
    const captured = fakeProcess({}, [`${JSON.stringify(entry)}\n`]);
    await runCliApp(app, ["format", "entries"], captured.proc);
    assert.equal(captured.proc.exitCode, 0, captured.stderr);
    assert.equal(captured.stdout, `entry context_edit ${action}: target\n`);
  }
});
