import assert from "node:assert/strict";
import { test } from "node:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import xterm from "@xterm/headless";
import {
  ENABLE_SGR_MOUSE_ENCODING,
  ENABLE_SGR_PIXEL_MOUSE_ENCODING,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "./ansi.ts";
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

// Pins the assumption behind PtyScreen's `isCursorHidden`: when this fails,
// the serialize addon reproduces cursor visibility itself and the workaround
// (and this test) can go.
test("the serialize addon omits cursor visibility", async () => {
  const terminal = new xterm.Terminal({
    cols: 80,
    rows: 24,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  await write(terminal, `hidden${HIDE_CURSOR}`);
  assert.ok(!serializeAddon.serialize().includes(HIDE_CURSOR));
});

for (const cursorSequence of [HIDE_CURSOR, SHOW_CURSOR]) {
  test(
    `snapshot ends with the cursor visibility the process left (${JSON.stringify(cursorSequence)})`,
    { timeout: 5_000 },
    async () => {
      const screen = new PtyScreen(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(`text${cursorSequence}`)})`,
        ],
        { cwd: process.cwd(), env: { TERM: "xterm-256color" } },
      );
      await new Promise<void>((resolve) => screen.onExit(() => resolve()));
      assert.ok((await screen.serializeScreen()).endsWith(cursorSequence));
    },
  );
}

// Pins the assumption behind PtyScreen's `mouseEncodingSequence`: when this
// fails, the serialize addon reproduces the mouse encoding itself and the
// workaround (and this test) can go.
test("the serialize addon omits the mouse encoding", async () => {
  const terminal = new xterm.Terminal({
    cols: 80,
    rows: 24,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  await write(terminal, `\x1b[?1002h${ENABLE_SGR_MOUSE_ENCODING}`);
  const snapshot = serializeAddon.serialize();
  assert.ok(snapshot.includes("\x1b[?1002h"));
  assert.ok(!snapshot.includes(ENABLE_SGR_MOUSE_ENCODING));
});

for (const [encodingName, encodingSequence, expected] of [
  ["sgr", ENABLE_SGR_MOUSE_ENCODING, ENABLE_SGR_MOUSE_ENCODING],
  [
    "sgr-pixels",
    ENABLE_SGR_PIXEL_MOUSE_ENCODING,
    ENABLE_SGR_PIXEL_MOUSE_ENCODING,
  ],
  ["default", `${ENABLE_SGR_MOUSE_ENCODING}\x1b[?1006l`, undefined],
] as const) {
  test(
    `snapshot reproduces the mouse encoding the process left (${encodingName})`,
    { timeout: 5_000 },
    async () => {
      const screen = new PtyScreen(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(`\x1b[?1002h${encodingSequence}text`)})`,
        ],
        { cwd: process.cwd(), env: { TERM: "xterm-256color" } },
      );
      await new Promise<void>((resolve) => screen.onExit(() => resolve()));
      const snapshot = await screen.serializeScreen();
      for (const sequence of [
        ENABLE_SGR_MOUSE_ENCODING,
        ENABLE_SGR_PIXEL_MOUSE_ENCODING,
      ]) {
        assert.equal(snapshot.includes(sequence), sequence === expected);
      }
    },
  );
}
