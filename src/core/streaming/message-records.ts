import {
  sessionEntryToContextMessages,
  type RpcSocketBroadcastEvent,
  type SessionEntry,
} from "@geraschenko/pi-coding-agent";
import type { MessageStreamRecord } from "./types.ts";

export class EventMessageRecordProjector {
  project(event: RpcSocketBroadcastEvent): readonly MessageStreamRecord[] {
    switch (event.type) {
      case "message_end":
        return [{ type: "message", message: event.message }];
      case "compaction_start":
      case "compaction_end":
        return [{ type: "control", control: { kind: "compaction", event } }];
      case "tree_navigated":
        return [
          { type: "control", control: { kind: "tree_navigated", event } },
        ];
      case "session_changed":
        return [
          { type: "control", control: { kind: "session_changed", event } },
        ];
      case "queue_update":
        return [{ type: "control", control: { kind: "queue_update", event } }];
      case "model_changed":
        return [{ type: "control", control: { kind: "model_changed", event } }];
      default:
        return [];
    }
  }

  finish(): readonly MessageStreamRecord[] {
    return [];
  }
}

export function* messageRecordsFromEntries(
  entries: Iterable<SessionEntry>,
): IterableIterator<MessageStreamRecord> {
  let previousEntryId: string | undefined;
  for (const entry of entries) {
    const isFirstEntry = previousEntryId === undefined;
    if (previousEntryId !== undefined && entry.parentId !== previousEntryId) {
      yield {
        type: "control",
        control: {
          kind: "tree_navigated",
          event: {
            type: "tree_navigated",
            oldLeafId: previousEntryId,
            newLeafId: entry.parentId,
          },
        },
      };
    }

    if (entry.type === "model_change") {
      if (!isFirstEntry) {
        yield {
          type: "control",
          control: {
            kind: "model_changed",
            event: {
              type: "model_changed",
              model: { provider: entry.provider, id: entry.modelId },
            },
          },
        };
      }
    } else {
      for (const message of sessionEntryToContextMessages(entry)) {
        yield { type: "message", message };
      }
    }
    previousEntryId = entry.id;
  }
}
