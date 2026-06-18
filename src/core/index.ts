/*
 * Public entry point for pictl-core.
 *
 * This is a PROVISIONAL first cut of the SDK surface, organized by the
 * canonical-library responsibilities in docs/thoughts/sdks-and-helpers.md. It
 * is expected to be pruned substantially once export-visualization tooling
 * lands. `main.ts` remains the CLI bin entry and does not depend on this file.
 */

// pi.sock client
export {
  PiSocketClient,
  connectWithRetry,
  getState,
  type SocketEvent,
} from "./pi-socket-client.ts";

// tty.sock protocol
export {
  FrameType,
  MAX_PAYLOAD_BYTES,
  encodeFrame,
  encodeResize,
  decodeResize,
  encodeExit,
  decodeExit,
  FrameDecoder,
  type Frame,
  type ResizePayload,
  type ExitPayload,
} from "./tty-protocol.ts";

// registry / agent discovery
export {
  loadAgent,
  listAgentIds,
  piSocketPath,
  ttySocketPath,
  type AgentRecord,
} from "./registry.ts";

// stream consumption
export {
  streamTail,
  streamPrompt,
  parseStreamOutputType,
  parsePromptType,
  parseStreamUntil,
  normalizeFollowUntil,
  STREAM_OUTPUT_TYPES,
  PROMPT_TYPES,
  STREAM_UNTIL_USAGE,
  type StreamOutputType,
  type PromptType,
  type StreamUntil,
  type PromptStreamOptions,
} from "./streaming.ts";

// until-conditions
export {
  parseUntilCondition,
  applyUntilCondition,
  UntilTimeoutError,
  UNTIL_USAGE,
  type UntilCondition,
} from "./until.ts";
