import {
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@geraschenko/pi-coding-agent";
import type { SocketEvent } from "./socket-event.ts";
import type { MessageStreamRecord } from "./types.ts";

export class EventMessageRecordProjector {
  project(event: SocketEvent): readonly MessageStreamRecord[] {
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
      case "agent_settled":
        return event.aborted
          ? [{ type: "control", control: { kind: "run_aborted", event } }]
          : [];
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_update":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
      case "entry_appended":
      case "steering_mode_changed":
      case "follow_up_mode_changed":
      case "auto_compaction_changed":
      case "session_info_changed":
      case "thinking_level_changed":
      case "auto_retry_start":
      case "auto_retry_end":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      case "bash_execution_update":
      case "ui_wait_start":
      case "ui_wait_end":
      case "extension_error":
      case "pictl_unknown_event":
        return [];
    }
  }

  finish(): readonly MessageStreamRecord[] {
    return [];
  }
}

export class EntryMessageRecordProjector {
  private previousEntryId: string | undefined;

  project(entry: SessionEntry): readonly MessageStreamRecord[] {
    const records: MessageStreamRecord[] = [];
    const previousEntryId = this.previousEntryId;
    const isFirstEntry = previousEntryId === undefined;
    if (previousEntryId !== undefined && entry.parentId !== previousEntryId) {
      records.push({
        type: "control",
        control: {
          kind: "tree_navigated",
          event: {
            type: "tree_navigated",
            oldLeafId: previousEntryId,
            newLeafId: entry.parentId,
          },
        },
      });
    }

    if (entry.type === "model_change") {
      if (!isFirstEntry) {
        records.push({
          type: "control",
          control: {
            kind: "model_changed",
            event: {
              type: "model_changed",
              model: { provider: entry.provider, id: entry.modelId },
            },
          },
        });
      }
    } else {
      for (const message of sessionEntryToContextMessages(entry)) {
        records.push({ type: "message", message });
      }
    }
    this.previousEntryId = entry.id;
    return records;
  }
}

export function* messageRecordsFromEntries(
  entries: Iterable<SessionEntry>,
): IterableIterator<MessageStreamRecord> {
  const projector = new EntryMessageRecordProjector();
  for (const entry of entries) {
    yield* projector.project(entry);
  }
}
