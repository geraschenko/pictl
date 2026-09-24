import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { attachHintSequence, TERMINAL_RESTORE_SEQUENCE } from "./attach.ts";

function write(terminal: xterm.Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

for (const columns of [80, 12, 1]) {
  for (const rows of [24, 1]) {
    test(`attach hint overlays only the top row (${columns}x${rows})`, async () => {
      const terminal = new xterm.Terminal({
        cols: columns,
        rows,
        allowProposedApi: true,
      });
      try {
        await write(terminal, "x".repeat(columns) + `\x1b[${rows};1H\x1b[31m`);
        await write(terminal, attachHintSequence("test", columns));
        const buffer = terminal.buffer.active;
        assert.equal(buffer.baseY, 0);
        assert.equal(buffer.cursorY, rows - 1);
        assert.equal(buffer.cursorX, 0);
        assert.equal(
          buffer.getLine(0)!.translateToString(true),
          "attached to test; detach: ctrl+]".slice(0, columns),
        );
        for (let row = 1; row < rows; row++) {
          assert.equal(buffer.getLine(row)!.translateToString(true), "");
        }
        await write(terminal, "Q");
        const cell = buffer.getLine(rows - 1)!.getCell(0)!;
        assert.equal(cell.getChars(), "Q");
        assert.equal(cell.getFgColor(), 1);
      } finally {
        terminal.dispose();
      }
    });
  }
}

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
