import type {
  RpcResponse,
  RpcSocketBroadcastEvent,
} from "@geraschenko/pi-coding-agent";

type RpcEventOf<T extends RpcSocketBroadcastEvent["type"]> = Extract<
  RpcSocketBroadcastEvent,
  { type: T }
>;

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

export interface StreamModelReference {
  readonly provider: string;
  readonly id: string;
}

export type StreamControl =
  | {
      readonly kind: "compaction";
      readonly event: RpcEventOf<"compaction_start" | "compaction_end">;
    }
  | {
      readonly kind: "tree_navigated";
      readonly event: RpcEventOf<"tree_navigated">;
    }
  | {
      readonly kind: "session_changed";
      readonly event: RpcEventOf<"session_changed">;
    }
  | {
      readonly kind: "queue_update";
      readonly event: RpcEventOf<"queue_update">;
    }
  | {
      readonly kind: "model_changed";
      readonly event: {
        readonly type: "model_changed";
        readonly model: StreamModelReference;
      };
    };

export type StreamControlKind = StreamControl["kind"];

export interface StreamControlRecord {
  readonly type: "control";
  readonly control: StreamControl;
}

export type MessageStreamRecord =
  | StreamMessageRecord
  | StreamControlRecord
  | StreamCursorRecord;
