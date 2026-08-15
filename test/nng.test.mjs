import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDSHAKE, frameEncode, NngStreamDecoder, PAIR1_PROTO } from "../lib/nng-socket.js";

test("handshake bytes are the NNG pair1 header", () => {
  assert.deepEqual(HANDSHAKE, Buffer.from([0x00, 0x53, 0x50, 0x00, 0x00, PAIR1_PROTO, 0x00, 0x00]));
});

test("frameEncode prefixes big-endian 8-byte length", () => {
  const payload = Buffer.from([1, 2, 3]);
  const frame = frameEncode(payload);
  assert.equal(frame.length, 8 + 3);
  assert.equal(frame.readBigUInt64BE(0), 3n);
  assert.deepEqual(frame.subarray(8), payload);
});

test("decoder: handshake + one frame in a single chunk", () => {
  const frames = [];
  const dec = new NngStreamDecoder((p) => frames.push(Buffer.from(p)), () => {});
  const payload = Buffer.from("hello");
  dec.push(Buffer.concat([HANDSHAKE, frameEncode(payload)]));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], payload);
  assert.equal(dec.pending, 0);
});

test("decoder: incremental byte-by-byte feed", () => {
  const frames = [];
  const dec = new NngStreamDecoder((p) => frames.push(Buffer.from(p)), () => {});
  const payload = Buffer.from("hello world");
  const stream = Buffer.concat([HANDSHAKE, frameEncode(payload)]);
  for (const byte of stream) dec.push(Buffer.from([byte]));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], payload);
});

test("decoder: two frames back to back", () => {
  const frames = [];
  const dec = new NngStreamDecoder((p) => frames.push(Buffer.from(p)), () => {});
  const a = Buffer.from("aaa");
  const b = Buffer.from("bbb");
  dec.push(Buffer.concat([HANDSHAKE, frameEncode(a), frameEncode(b)]));
  assert.deepEqual(frames, [a, b]);
});

test("decoder: rejects an invalid handshake", () => {
  const dec = new NngStreamDecoder(() => {}, () => {});
  assert.throws(() => dec.push(Buffer.from([1, 1, 1, 1, 0, 0, 0, 0])), /handshake/);
});

test("decoder: reports the peer protocol from the handshake", () => {
  let peer = -1;
  const dec = new NngStreamDecoder(() => {}, (p) => { peer = p; });
  dec.push(HANDSHAKE);
  assert.equal(peer, PAIR1_PROTO);
});
