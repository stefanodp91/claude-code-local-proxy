/**
 * streaming.test.ts — the other end of the wire.
 *
 * The proxy's stream translator turns OpenAI SSE into Anthropic events; this is
 * what reassembles those events into the message on screen. Both sides are state
 * machines over the same protocol, and the failures rhyme: a delta appended to
 * the wrong block, a block that never closes, a stream that ends without
 * finalising the message. None of them throws. The user sees text that stops
 * mid-sentence, or a spinner that never stops, and has no way to tell which.
 *
 * The services are plain classes with constructor injection, so they are built
 * here with `new` and fakes — no TestBed, no browser. That is the boundary of
 * what `node:test` can do: this suite covers the *logic*, and no template is
 * ever rendered. See `docs/testing.md` in the extension.
 *
 * @module test/streaming
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import { StreamingService } from "../src/app/core/services/streaming.service";
import { MessageStoreService } from "../src/app/core/services/message-store.service";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** The bridge, reduced to the three streams StreamingService subscribes to. */
function bridgeFake() {
  const delta$ = new Subject<any>();
  const end$ = new Subject<void>();
  const error$ = new Subject<{ message: string }>();
  return {
    bridge: {
      onStreamDelta: () => delta$,
      onStreamEnd: () => end$,
      onStreamError: () => error$,
    } as any,
    delta$, end$, error$,
  };
}

/** A real store over a fake VS Code API — persistence is not under test here. */
function storeFake(): MessageStoreService {
  return new MessageStoreService({ postMessage() {}, getState: () => ({}), setState() {} } as any);
}

function setup() {
  const { bridge, delta$, end$, error$ } = bridgeFake();
  const store = storeFake();
  const service = new StreamingService(bridge, store);
  const send = (eventType: string, payload: Record<string, unknown> = {}) =>
    delta$.next({ eventType, ...payload });
  return { service, store, send, end$, error$ };
}

/** The assistant message currently on screen. */
const assistant = (store: MessageStoreService) =>
  store.messages().find((m: any) => m.role === "assistant") as any;

const start = () => ({ message: { id: "msg_1", model: "local-model" } });

// ─────────────────────────────────────────────────────────────────────────────
// Assembling a message
// ─────────────────────────────────────────────────────────────────────────────

test("text deltas are joined into one block, in order", async () => {
  const { store, send } = setup();

  send("message_start", start());
  send("content_block_start", { content_block: { type: "text" } });
  send("content_block_delta", { delta: { type: "text_delta", text: "Hel" } });
  send("content_block_delta", { delta: { type: "text_delta", text: "lo" } });
  send("content_block_stop", { index: 0 });
  send("message_stop");

  const msg = assistant(store);
  assert.equal(msg.contentBlocks.length, 1);
  assert.equal(msg.contentBlocks[0].text, "Hello");
});

test("thinking and text are kept apart", async () => {
  // They render differently — one is a collapsible panel. Merging them puts the
  // model's reasoning into its answer.
  const { store, send } = setup();

  send("message_start", start());
  send("content_block_start", { content_block: { type: "thinking" } });
  send("content_block_delta", { delta: { type: "thinking_delta", thinking: "hmm" } });
  send("content_block_stop", { index: 0 });
  send("content_block_start", { content_block: { type: "text" } });
  send("content_block_delta", { delta: { type: "text_delta", text: "answer" } });
  send("content_block_stop", { index: 1 });
  send("message_stop");

  const types = assistant(store).contentBlocks.map((b: any) => b.type);
  assert.equal(types.length, 2);
  assert.notEqual(types[0], types[1]);
  assert.equal(assistant(store).contentBlocks[1].text, "answer");
});

test("a tool call's arguments are accumulated across deltas", async () => {
  // The proxy sends `input_json_delta` fragments; a single one lost here is a
  // tool call the UI renders with truncated JSON.
  const { store, send } = setup();

  send("message_start", start());
  send("content_block_start", { content_block: { type: "tool_use", id: "t1", name: "workspace" } });
  send("content_block_delta", { delta: { type: "input_json_delta", partial_json: '{"action":' } });
  send("content_block_delta", { delta: { type: "input_json_delta", partial_json: '"read"}' } });
  send("content_block_stop", { index: 0 });
  send("message_stop");

  const block = assistant(store).contentBlocks[0];
  assert.match(JSON.stringify(block), /"action":"read"/);
});

test("a delta arriving before any message_start is ignored, not crashed on", async () => {
  // Out-of-order frames happen on reconnect. Nothing should be created for them.
  const { store, send } = setup();

  send("content_block_delta", { delta: { type: "text_delta", text: "orphan" } });

  assert.equal(store.messages().length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ending, one way or another
// ─────────────────────────────────────────────────────────────────────────────

test("message_stop finalises the message", async () => {
  const { store, send } = setup();

  send("message_start", start());
  send("content_block_start", { content_block: { type: "text" } });
  send("content_block_delta", { delta: { type: "text_delta", text: "done" } });
  send("message_stop");

  assert.equal(store.isStreaming(), false, "the UI would keep showing a spinner");
});

test("a stream that ends without message_stop still finalises", async () => {
  // The proxy can drop the connection mid-turn. Without this the message stays
  // "streaming" for ever and the input box stays disabled.
  const { store, send, end$ } = setup();

  send("message_start", start());
  send("content_block_start", { content_block: { type: "text" } });
  send("content_block_delta", { delta: { type: "text_delta", text: "half" } });
  end$.next();

  assert.equal(store.isStreaming(), false);
  assert.equal(assistant(store).contentBlocks[0].text, "half", "what did arrive was kept");
});

test("an error ends the turn and is attached to the message", async () => {
  const { store, send, error$ } = setup();

  send("message_start", start());
  error$.next({ message: "proxy unreachable" });

  assert.equal(store.isStreaming(), false);
  assert.match(JSON.stringify(assistant(store)), /proxy unreachable/);
});

test("a second turn starts a new message rather than extending the first", async () => {
  const { store, send } = setup();

  send("message_start", start());
  send("content_block_start", { content_block: { type: "text" } });
  send("content_block_delta", { delta: { type: "text_delta", text: "first" } });
  send("message_stop");

  send("message_start", { message: { id: "msg_2", model: "local-model" } });
  send("content_block_start", { content_block: { type: "text" } });
  send("content_block_delta", { delta: { type: "text_delta", text: "second" } });
  send("message_stop");

  const assistants = store.messages().filter((m: any) => m.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal((assistants[0] as any).contentBlocks[0].text, "first");
  assert.equal((assistants[1] as any).contentBlocks[0].text, "second");
});

// ─────────────────────────────────────────────────────────────────────────────
// What the header shows
// ─────────────────────────────────────────────────────────────────────────────

test("token usage from both ends of the turn reaches the message", async () => {
  const { store, send } = setup();

  send("message_start", { message: { id: "m", model: "local-model", usage: { input_tokens: 12 } } });
  send("message_delta", { usage: { output_tokens: 34 }, delta: { stop_reason: "end_turn" } });
  send("message_stop");

  const msg = JSON.stringify(assistant(store));
  assert.match(msg, /12/);
  assert.match(msg, /34/);
});

test("the stop reason is recorded, including the one that means truncation", async () => {
  // max_tokens is the reason a turn can end mid-word — and the same truncation
  // that produces an empty tool call on the proxy side. The UI has to be able
  // to say so.
  const { store, send } = setup();

  send("message_start", start());
  send("message_delta", { delta: { stop_reason: "max_tokens" } });
  send("message_stop");

  assert.match(JSON.stringify(assistant(store)), /max_tokens/);
});

test("unsubscribing stops the service reacting to a stream it no longer owns", async () => {
  const { service, store, send } = setup();

  service.ngOnDestroy();
  send("message_start", start());

  assert.equal(store.messages().length, 0);
});
