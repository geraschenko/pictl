import { DEFAULT_FORMAT_WIDTH } from "../core/constants.ts";
import type { AgentMessage } from "../core/streaming/types.ts";
import { isRecord } from "../core/util.ts";
import { rawMessageSummary } from "./entries.ts";
import type { EventStreamRecord } from "./input.ts";
import { optionalStringOrNumberField, stringListField } from "./messages.ts";
import { truncateText } from "./text.ts";

/**
 * One line per event, stateless. Events that message mode wraps as controls
 * reuse the same field extraction as `formatControl`, labeled with the event
 * type; `message_end` carries the message's one-line summary, truncated to
 * the default width (events mode has no width option); a `pictl_cursor`
 * record (a finite `tail --json` run appends one) renders like message
 * mode's cursor line; every other type — including event types unknown to
 * this pictl — renders bare `[<type>]`. Payload detail beyond this is
 * `--json`'s job. Records may come from parsed JSONL, so fields are read
 * defensively despite the static type.
 */
export function formatEvent(record: EventStreamRecord): string {
  switch (record.type) {
    case "pictl_cursor":
      return `[cursor: ${record.entryId ?? "null"}]`;
    case "tree_navigated": {
      const oldLeafId = optionalStringOrNumberField(record, "oldLeafId");
      const newLeafId =
        optionalStringOrNumberField(record, "newLeafId") ?? "null";
      return oldLeafId === undefined
        ? `[tree_navigated: to ${newLeafId}]`
        : `[tree_navigated: ${oldLeafId} -> ${newLeafId}]`;
    }
    case "session_changed": {
      const state = "state" in record ? record.state : undefined;
      const detail = [
        optionalStringOrNumberField(state, "sessionId"),
        optionalStringOrNumberField(state, "sessionFile"),
      ]
        .filter((part) => part !== undefined)
        .join(" ");
      return detail === ""
        ? "[session_changed]"
        : `[session_changed: ${detail}]`;
    }
    case "queue_update":
      return `[queue_update: steering=${stringListField(record, "steering").length} follow-up=${stringListField(record, "followUp").length}]`;
    case "model_changed": {
      const model = "model" in record ? record.model : undefined;
      const provider =
        optionalStringOrNumberField(model, "provider") ?? "unknown";
      const modelId = optionalStringOrNumberField(model, "id") ?? "unknown";
      return `[model_changed: ${provider}/${modelId}]`;
    }
    case "message_end": {
      const message = "message" in record ? record.message : undefined;
      if (!isRecord(message) || typeof message.role !== "string") {
        return "[message_end]";
      }
      // An unknown role falls through rawMessageSummary's exhaustive switch
      // and yields undefined despite the declared return type.
      const summary: string | undefined = rawMessageSummary(
        message as AgentMessage,
      );
      return summary === undefined
        ? "[message_end]"
        : `[message_end] ${message.role}: ${truncateText(summary, DEFAULT_FORMAT_WIDTH)}`;
    }
    default:
      return `[${record.type}]`;
  }
}
