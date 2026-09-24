import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { TERMINAL_RESTORE_SEQUENCE } from "./attach.ts";

for (const [mode, tracking] of [
  [9, "x10"],
  [1000, "vt200"],
  [1002, "drag"],
  [1003, "any"],
] as const) {
  test(`attach cleanup disables mouse tracking mode ${mode}`, async () => {
    const terminal = new xterm.Terminal({ allowProposedApi: true });
    try {
      await new Promise<void>((resolve) =>
        terminal.write(`\x1b[?${mode}h`, resolve),
      );
      assert.equal(terminal.modes.mouseTrackingMode, tracking);
      await new Promise<void>((resolve) =>
        terminal.write(TERMINAL_RESTORE_SEQUENCE, resolve),
      );
      assert.equal(terminal.modes.mouseTrackingMode, "none");
    } finally {
      terminal.dispose();
    }
  });
}
