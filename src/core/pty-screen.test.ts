import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { PtyScreen } from "./pty-screen.ts";
import { attachHintSequence } from "./attach.ts";

function write(terminal: xterm.Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

for (const alternateScreen of [false, true]) {
  test(
    `snapshot preserves redraw coordinates (alternate screen: ${alternateScreen})`,
    { timeout: 5_000 },
    async () => {
      const fixture =
        (alternateScreen ? "\x1b[?1049h" : "") +
        "\x1b[1;1Hconversation\x1b[21;1Htop border\x1b[22;1Hinput" +
        "\x1b[23;1Hbottom border\x1b[24;1Hfooter\x1b[22;6H";
      const screen = new PtyScreen(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(fixture)})`],
        { cwd: process.cwd(), env: { TERM: "xterm-256color" } },
      );
      const terminal = new xterm.Terminal({
        cols: 80,
        rows: 24,
        allowProposedApi: true,
      });
      try {
        await new Promise<void>((resolve) => screen.onExit(() => resolve()));
        await write(
          terminal,
          (await screen.serializeScreen()) + attachHintSequence("test", 80),
        );
        const line = (row: number): string =>
          terminal.buffer.active
            .getLine(terminal.buffer.active.baseY + row - 1)!
            .translateToString(true);
        assert.equal(line(22), "input");
        assert.equal(line(23), "bottom border");
        assert.equal(line(24), "footer");
        assert.equal(terminal.buffer.active.cursorY, 21);
        assert.equal(terminal.buffer.active.cursorX, 5);

        // Pi's alternate-screen renderer addresses changed rows absolutely.
        await write(terminal, "\x1b[22;1H\x1b[2Kinput: hello");
        assert.equal(line(22), "input: hello");
        assert.equal(line(23), "bottom border");
        assert.equal(line(24), "footer");
      } finally {
        screen.kill();
        terminal.dispose();
      }
    },
  );
}
