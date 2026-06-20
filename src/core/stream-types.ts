import type { RpcResponse } from "@geraschenko/pi-coding-agent";
import type { SocketEvent } from "./pi-socket-client.ts";

export type GetMessagesData = Extract<
  RpcResponse,
  { command: "get_messages"; success: true }
>["data"];

export type AgentMessage = GetMessagesData["messages"][number];

export interface StreamCursorRecord {
  readonly type: "pictl_cursor";
  readonly sessionId: string | null;
  readonly entryId: string | null;
}

export interface StreamMessageRecord {
  readonly type: "message";
  readonly message: AgentMessage;
}

export type StreamControlKind =
  | "compaction"
  | "tree_navigated"
  | "session_changed"
  | "queue_update";

export interface StreamControlRecord {
  readonly type: "control";
  readonly control: {
    readonly kind: StreamControlKind;
    readonly event: SocketEvent;
  };
}

export type MessageStreamRecord =
  | StreamMessageRecord
  | StreamControlRecord
  | StreamCursorRecord;
