// Report which terminal modes a fresh `tty.sock` client receives: those in the
// snapshot frame, and those in output frames up to a deadline after it (pi may
// still be entering its TUI when the snapshot is taken).
// Usage: node tty-modes.mjs <tty.sock> <path to dist/core/index.js>
import net from "node:net";

const [socketPath, coreIndexPath] = process.argv.slice(2);
const { FrameDecoder, FrameType, encodeHello } = await import(
  coreIndexPath
);
const REPORTED_MODES = ["?1049h", "?1000h", "?1002h", "?1004h", "?1006h", "?2004h", "?25l"];
const SNAPSHOT_DEADLINE_MS = 10_000;
const OUTPUT_AFTER_SNAPSHOT_MS = 3_000;

// Modes may be combined into one sequence (`ESC[?1002;1006h`), so match each
// parameter of every private-mode set/reset sequence.
function modesIn(text) {
  const modes = new Set();
  for (const [, params, final] of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    for (const param of params.split(";")) modes.add(`?${param}${final}`);
  }
  return modes;
}

const socket = net.connect(socketPath);
const frameDecoder = new FrameDecoder();
let snapshotText;
let outputText = "";
const snapshotDeadline = setTimeout(() => {
  console.log("FAIL no snapshot frame within", SNAPSHOT_DEADLINE_MS, "ms");
  process.exit(1);
}, SNAPSHOT_DEADLINE_MS);

function reportModes() {
  const snapshotModes = modesIn(snapshotText);
  const outputModes = modesIn(outputText);
  for (const mode of REPORTED_MODES) {
    console.log(`${mode} snapshot=${snapshotModes.has(mode)} output=${outputModes.has(mode)}`);
  }
  socket.destroy();
}

socket.on("connect", () =>
  socket.write(encodeHello({ pid: process.pid, client: "update-pi smoke" })),
);
socket.on("data", (chunk) => {
  for (const frame of frameDecoder.push(chunk)) {
    if (frame.type === FrameType.snapshot) {
      snapshotText = frame.payload.toString("utf8");
      clearTimeout(snapshotDeadline);
      // A bounded observation window, not a wait for a condition: modes pi
      // sets later arrive only as output, and nothing marks "TUI ready".
      setTimeout(reportModes, OUTPUT_AFTER_SNAPSHOT_MS);
    } else if (frame.type === FrameType.output && snapshotText !== undefined) {
      outputText += frame.payload.toString("utf8");
    }
  }
});
socket.on("error", (error) => {
  console.log("FAIL", error.message);
  process.exit(1);
});
