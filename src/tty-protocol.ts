/**
 * Framing for the holder's tty.sock attach protocol, shared by the holder
 * (server) and `pi-ctl attach` (client). Binary frames — raw PTY output is
 * high-volume, so no JSONL/base64:
 *
 *   [type: u8][payloadLength: u32 BE][payload]
 *
 * Client → server: `input` (raw terminal input bytes), `resize` (JSON).
 * Server → client: `snapshot` (serialized screen state, sent once on
 * connect), `output` (raw PTY output bytes), `exit` (JSON, the agent is
 * shutting down).
 *
 * Keep this file free of pi-ctl-specific imports: it defines the wire
 * protocol and nothing else.
 */

// TDC: FrameType exported as both value and type is kind of confusing, isn't it? Is this normal?
export const FrameType = {
  input: 1,
  resize: 2,
  snapshot: 3,
  output: 4,
  exit: 5,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const FRAME_TYPE_VALUES = new Set<number>(Object.values(FrameType));
const HEADER_LENGTH = 5;  // TDC: why 5? I think this is 1 byte for frame type and 4 bytes for payload size, but we should be explicit about where the 5 comes from.

export interface Frame {
  type: FrameType;
  payload: Buffer;
}

export interface ResizePayload {
  cols: number;
  rows: number;
}

export interface ExitPayload {
  reason: string;
}

export function encodeFrame(type: FrameType, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(HEADER_LENGTH);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function encodeResize(resize: ResizePayload): Buffer {
  return encodeFrame(FrameType.resize, Buffer.from(JSON.stringify(resize)));
}

/** Throws on malformed payloads; the receiver should drop the connection. */
export function decodeResize(payload: Buffer): ResizePayload {
  const parsed = JSON.parse(payload.toString("utf8")) as Partial<ResizePayload>;
  if (!isValidDimension(parsed.cols) || !isValidDimension(parsed.rows)) {
    throw new Error(`invalid resize payload: ${payload.toString("utf8")}`);
  }
  return { cols: parsed.cols, rows: parsed.rows };
}

const MAX_DIMENSION = 10_000;

function isValidDimension(value: number | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_DIMENSION
  );
}

export function encodeExit(exit: ExitPayload): Buffer {
  return encodeFrame(FrameType.exit, Buffer.from(JSON.stringify(exit)));
}

export function decodeExit(payload: Buffer): ExitPayload {
  const parsed = JSON.parse(payload.toString("utf8")) as Partial<ExitPayload>;
  return { reason: typeof parsed.reason === "string" ? parsed.reason : "" };
}

/**
 * Incremental frame parser: feed socket chunks in, get complete frames out.
 * Throws on an unknown frame type; the connection is then unrecoverable
 * (framing is lost) and the caller should destroy it.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    while (this.buffer.length >= HEADER_LENGTH) {
      const type = this.buffer.readUInt8(0);
      if (!FRAME_TYPE_VALUES.has(type)) {
        throw new Error(`unknown tty frame type ${type}`);
      }
      const payloadLength = this.buffer.readUInt32BE(1);
      if (this.buffer.length < HEADER_LENGTH + payloadLength) {
        // TDC: when would this happen? This encoding/decoding scheme seems kind of dodgy, the sort of thing buffer overflow security stories are made of. What do you think?
        break;
      }
      frames.push({
        type: type as FrameType,
        payload: this.buffer.subarray(
          HEADER_LENGTH,
          HEADER_LENGTH + payloadLength,
        ),
      });
      this.buffer = this.buffer.subarray(HEADER_LENGTH + payloadLength);
    }
    return frames;
  }
}
