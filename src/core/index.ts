/**
 * Programmatic access to a pictl-managed fleet of pi agents: discover agents in
 * the registry, connect to their `pi.sock`/`tty.sock`, make RPC calls, and wait
 * on turn/idle conditions.
 *
 * This exposes only CLI-independent primitives: things that take a socket path,
 * a PiSocketClient, or an agent id. The CLI command bodies (`streamPrompt`,
 * `streamTail`, `promptDetached`) and the flag-parsing/usage helpers stay out of
 * the surface — they are coupled to the Stricli command context and to argument
 * parsing, not to anything an SDK consumer would call. See
 * docs/thoughts/sdks-and-helpers.md for the layering this follows. `main.ts`
 * remains the CLI bin entry and does not depend on this file.
 *
 * @packageDocumentation
 */

// pi.sock client
export { PiSocketClient, connectWithRetry } from "./pi-socket-client.ts";

// tty.sock protocol
export {
  FrameType,
  MAX_PAYLOAD_BYTES,
  encodeFrame,
  encodeHello,
  decodeHello,
  encodeResize,
  decodeResize,
  encodeExit,
  decodeExit,
  FrameDecoder,
  type Frame,
  type HelloPayload,
  type ResizePayload,
  type ExitPayload,
} from "./tty-protocol.ts";
export { type AttachmentInfo } from "./tty-server.ts";

// registry / agent discovery
export {
  loadAgent,
  listAgentIds,
  piSocketPath,
  ttySocketPath,
  type AgentRecord,
  type SessionHistoryEntry,
} from "./registry.ts";

// until-conditions and the stream driver they run on
export {
  parseUntilCondition,
  UntilTimeoutError,
  type UntilCondition,
} from "./until-engine.ts";
export {
  runStream,
  type StreamClient,
  type StreamHandler,
  type StreamResult,
} from "./stream-driver.ts";
export {
  isIdle,
  untilMetAtSeed,
  untilMetByEvent,
  untilQuietMs,
} from "./until.ts";
