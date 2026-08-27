/**
 * sseParser.test.ts — the seam every streamed token passes through.
 *
 * The parser sees whatever the network hands it: an event split across two TCP
 * chunks, three events in one, a chunk that ends mid-word. Every failure here
 * is silent by construction — a dropped event is a missing paragraph in the
 * answer, and a mis-buffered one is text that never arrives at all. Nothing
 * throws, and the user simply gets less than the model said.
 *
 * @module test/sseParser
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SseParser } from "../src/extension/proxy/sse-parser";

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test("a whole event in one chunk comes out whole", () => {
  const parser = new SseParser();

  const events = parser.feed(frame("message_start", { type: "message_start" }));

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "message_start");
  assert.deepEqual(JSON.parse(events[0].data), { type: "message_start" });
});

test("several events in one chunk all come out, in order", () => {
  const parser = new SseParser();

  const events = parser.feed(
    frame("a", { i: 1 }) + frame("b", { i: 2 }) + frame("c", { i: 3 }),
  );

  assert.deepEqual(events.map((e) => e.event), ["a", "b", "c"]);
});

test("an event split across chunks is not lost", () => {
  // The realistic case: a frame straddling a chunk boundary. Emitting the half
  // would corrupt the JSON; forgetting it drops a token.
  const parser = new SseParser();
  const whole = frame("content_block_delta", { text: "hello" });
  const cut = whole.length - 12;

  const first = parser.feed(whole.slice(0, cut));
  const second = parser.feed(whole.slice(cut));

  assert.deepEqual(first, []);
  assert.equal(second.length, 1);
  assert.deepEqual(JSON.parse(second[0].data), { text: "hello" });
});

test("one character at a time still yields exactly one event", () => {
  // The extreme of the same property, and the cheapest way to prove the buffer
  // is not being cleared between reads.
  const parser = new SseParser();
  const whole = frame("done", { ok: true });
  let events: { event: string; data: string }[] = [];

  for (const ch of whole) events = events.concat(parser.feed(ch));

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "done");
});

test("a trailing partial event stays buffered until it is complete", () => {
  const parser = new SseParser();

  const first = parser.feed(frame("a", { i: 1 }) + "event: b\ndata: {\"i\":2}");
  const second = parser.feed("\n\n");

  assert.deepEqual(first.map((e) => e.event), ["a"]);
  assert.deepEqual(second.map((e) => e.event), ["b"]);
});

test("flush emits what is left when the stream ends without a blank line", () => {
  // A backend that closes the connection after the last frame, without the
  // trailing separator, would otherwise lose that frame entirely.
  const parser = new SseParser();
  parser.feed("event: last\ndata: {\"i\":9}");

  const flushed = parser.flush();

  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].event, "last");
});

test("flush on an empty buffer yields nothing, and can be called twice", () => {
  const parser = new SseParser();

  assert.deepEqual(parser.flush(), []);
  parser.feed(frame("a", {}));
  assert.deepEqual(parser.flush(), [], "the buffer was not cleared by feed()");
});

test("a data-only frame is kept — the event name is optional", () => {
  // The proxy always names its events, but the SSE spec does not require it and
  // a `data:`-only keepalive must not be turned into a null.
  const parser = new SseParser();

  const events = parser.feed("data: {\"ping\":1}\n\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "");
  assert.deepEqual(JSON.parse(events[0].data), { ping: 1 });
});

test("blank blocks and comments produce no events", () => {
  const parser = new SseParser();

  const events = parser.feed("\n\n: keepalive\n\n");

  assert.deepEqual(events, []);
});
