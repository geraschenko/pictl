import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeExit,
  decodeResize,
  encodeExit,
  encodeFrame,
  encodeResize,
  FrameDecoder,
  FrameType,
} from "./tty-protocol.ts";

test("frame round-trips through the decoder", () => {
  const payload = Buffer.from("hello \x1b[31mworld\x1b[0m");
  const decoder = new FrameDecoder();
  const frames = decoder.push(encodeFrame(FrameType.output, payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, FrameType.output);
  assert.deepEqual(frames[0]!.payload, payload);
});

test("empty payload round-trips", () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(encodeFrame(FrameType.input, Buffer.alloc(0)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.payload.length, 0);
});

test("frames split across arbitrary chunk boundaries reassemble", () => {
  const encoded = Buffer.concat([
    encodeFrame(FrameType.snapshot, Buffer.from("screen state")),
    encodeFrame(FrameType.output, Buffer.from("more bytes")),
  ]);
  const decoder = new FrameDecoder();
  const frames = [];
  for (const byte of encoded) {
    frames.push(...decoder.push(Buffer.from([byte])));
  }
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.payload.toString(), "screen state");
  assert.equal(frames[1]!.payload.toString(), "more bytes");
});

test("multiple frames in one chunk all decode", () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(
    Buffer.concat([
      encodeFrame(FrameType.input, Buffer.from("a")),
      encodeResize({ cols: 120, rows: 40 }),
      encodeFrame(FrameType.input, Buffer.from("b")),
    ]),
  );
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((f) => f.type),
    [FrameType.input, FrameType.resize, FrameType.input],
  );
});

test("unknown frame type throws", () => {
  const decoder = new FrameDecoder();
  const bogus = Buffer.from([99, 0, 0, 0, 0]);
  assert.throws(() => decoder.push(bogus), /unknown tty frame type 99/);
});

test("resize payload round-trips", () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(encodeResize({ cols: 80, rows: 24 }));
  assert.deepEqual(decodeResize(frames[0]!.payload), { cols: 80, rows: 24 });
});

test("malformed resize payloads throw", () => {
  assert.throws(() => decodeResize(Buffer.from("not json")));
  assert.throws(() => decodeResize(Buffer.from('{"cols":0,"rows":24}')));
  assert.throws(() => decodeResize(Buffer.from('{"cols":80.5,"rows":24}')));
  assert.throws(() => decodeResize(Buffer.from('{"cols":80}')));
  assert.throws(() => decodeResize(Buffer.from('{"cols":999999,"rows":24}')));
});

test("exit payload round-trips", () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(encodeExit({ reason: "pi exited (code 0)" }));
  assert.deepEqual(decodeExit(frames[0]!.payload), {
    reason: "pi exited (code 0)",
  });
});
