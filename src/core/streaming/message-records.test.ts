import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  RpcSocketBroadcastEvent,
  SessionEntry,
} from "@geraschenko/pi-coding-agent";
import {
  EventMessageRecordProjector,
  messageRecordsFromEntries,
} from "./message-records.ts";
import type { MessageStreamRecord } from "./types.ts";

function userEntry(
  id: string,
  parentId: string | null,
  text: string,
): SessionEntry {
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

function recordSummary(record: MessageStreamRecord): string {
  if (record.type === "message") {
    return `message:${record.message.role}`;
  }
  if (record.type === "pictl_cursor") {
    return "cursor";
  }
  if (record.control.kind === "tree_navigated") {
    return `navigate:${record.control.event.oldLeafId}->${record.control.event.newLeafId}`;
  }
  if (record.control.kind === "model_changed") {
    return `model:${record.control.event.model.provider}/${record.control.event.model.id}`;
  }
  return `control:${record.control.kind}`;
}

test("entry projection preserves append order and infers discontinuities", () => {
  const entries: SessionEntry[] = [
    userEntry("A", null, "A"),
    userEntry("B", "A", "B"),
    {
      type: "thinking_level_change",
      id: "K",
      parentId: "B",
      timestamp: "2026-01-01T00:00:01.000Z",
      thinkingLevel: "high",
    },
    userEntry("C", "A", "inactive branch message"),
    {
      type: "model_change",
      id: "D",
      parentId: "C",
      timestamp: "2026-01-01T00:00:02.000Z",
      provider: "anthropic",
      modelId: "claude-sonnet",
    },
    {
      type: "model_change",
      id: "E",
      parentId: "D",
      timestamp: "2026-01-01T00:00:03.000Z",
      provider: "anthropic",
      modelId: "claude-sonnet",
    },
  ];

  assert.deepEqual(
    Array.from(messageRecordsFromEntries(entries), recordSummary),
    [
      "message:user",
      "message:user",
      "navigate:K->A",
      "message:user",
      "model:anthropic/claude-sonnet",
      "model:anthropic/claude-sonnet",
    ],
  );
});

test("a parent discontinuity to null emits navigation before the entry", () => {
  const entries = [
    userEntry("A", null, "first"),
    userEntry("B", null, "new root"),
  ];
  assert.deepEqual(
    Array.from(messageRecordsFromEntries(entries), recordSummary),
    ["message:user", "navigate:A->null", "message:user"],
  );
});

test("the first entry never emits navigation or a model control", () => {
  const entries: SessionEntry[] = [
    {
      type: "model_change",
      id: "model-1",
      parentId: "omitted-parent",
      timestamp: "2026-01-01T00:00:00.000Z",
      provider: "openai",
      modelId: "gpt-test",
    },
    userEntry("message-1", "model-1", "hello"),
  ];
  assert.deepEqual(
    Array.from(messageRecordsFromEntries(entries), recordSummary),
    ["message:user"],
  );
});

test("canonical entry conversion projects compaction, branch, and custom summaries", () => {
  const entries: SessionEntry[] = [
    {
      type: "compaction",
      id: "compact",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "compacted history",
      firstKeptEntryId: "kept",
      tokensBefore: 123,
    },
    {
      type: "branch_summary",
      id: "branch",
      parentId: "compact",
      timestamp: "2026-01-01T00:00:01.000Z",
      fromId: "old-leaf",
      summary: "branch history",
    },
    {
      type: "custom_message",
      id: "custom",
      parentId: "branch",
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "notice",
      content: "custom context",
      display: true,
    },
  ];
  const records = Array.from(messageRecordsFromEntries(entries));
  assert.deepEqual(records.map(recordSummary), [
    "message:compactionSummary",
    "message:branchSummary",
    "message:custom",
  ]);
});

test("event projection faithfully emits direct observations", () => {
  const projector = new EventMessageRecordProjector();
  const events = [
    {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      },
    },
    {
      type: "compaction_start",
      reason: "manual",
    },
    {
      type: "session_changed",
      state: {
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "all",
        sessionId: "session-2",
        autoCompactionEnabled: false,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    },
    {
      type: "tree_navigated",
      oldLeafId: null,
      newLeafId: "new-leaf",
    },
    {
      type: "model_changed",
      model: { provider: "anthropic", id: "claude-sonnet" },
    },
    {
      type: "queue_update",
      steering: [],
      followUp: [],
    },
  ] as unknown as readonly RpcSocketBroadcastEvent[];

  assert.deepEqual(
    events.flatMap((event) => projector.project(event)).map(recordSummary),
    [
      "message:user",
      "control:compaction",
      "control:session_changed",
      "navigate:null->new-leaf",
      "model:anthropic/claude-sonnet",
      "control:queue_update",
    ],
  );
  assert.deepEqual(projector.finish(), []);
});
