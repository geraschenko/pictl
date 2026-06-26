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
  type SessionHistoryEntry,
} from "./registry.ts";

// until-conditions
export {
  applyUntilCondition,
  UntilTimeoutError,
  type UntilCondition,
} from "./until.ts";
