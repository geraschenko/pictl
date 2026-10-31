import type { RpcSocketBroadcastEvent } from "@geraschenko/pi-coding-agent";

/** Any JSON record pi broadcasts, as received on the wire. */
export type RawSocketEvent = Readonly<
  { type: string } & Record<string, unknown>
>;

/** A received event whose type is newer than this pictl. Its raw `type`
 *  can't be the discriminant: a `string` there would stop `type` from
 *  narrowing the known events. */
export interface UnknownSocketEvent {
  readonly type: "pictl_unknown_event";
  readonly rawEvent: RawSocketEvent;
}

/** A pi socket event as pictl received it, classified by its `type` alone;
 *  payloads are unvalidated. */
export type SocketEvent = RpcSocketBroadcastEvent | UnknownSocketEvent;

/** Runtime mirror of `RpcSocketBroadcastEvent["type"]`; the Record type makes
 *  tsc enforce exact agreement with the pi union. */
const EVENT_TYPE_MARKERS: Record<RpcSocketBroadcastEvent["type"], true> = {
  agent_start: true,
  agent_end: true,
  agent_settled: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  bash_execution_update: true,
  queue_update: true,
  compaction_start: true,
  compaction_end: true,
  entry_appended: true,
  model_changed: true,
  steering_mode_changed: true,
  follow_up_mode_changed: true,
  auto_compaction_changed: true,
  tree_navigated: true,
  session_info_changed: true,
  thinking_level_changed: true,
  auto_retry_start: true,
  auto_retry_end: true,
  summarization_retry_scheduled: true,
  summarization_retry_attempt_start: true,
  summarization_retry_finished: true,
  ui_wait_start: true,
  ui_wait_end: true,
  session_changed: true,
  extension_error: true,
};
const EVENT_TYPES = new Set<string>(Object.keys(EVENT_TYPE_MARKERS));

/** Classify a received wire record by its `type`; the inverse of `rawSocketEvent`. */
export function socketEvent(rawEvent: RawSocketEvent): SocketEvent {
  return EVENT_TYPES.has(rawEvent.type)
    ? (rawEvent as unknown as RpcSocketBroadcastEvent)
    : { type: "pictl_unknown_event", rawEvent };
}

/** The wire record `event` was classified from: what `--json` prints. */
export function rawSocketEvent(
  event: SocketEvent,
): RpcSocketBroadcastEvent | RawSocketEvent {
  return event.type === "pictl_unknown_event" ? event.rawEvent : event;
}
