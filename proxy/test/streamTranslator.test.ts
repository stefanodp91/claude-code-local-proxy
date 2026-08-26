/**
 * streamTranslator.test.ts — OpenAI SSE → Anthropic SSE.
 *
 * The state machine every streamed turn passes through, on both surfaces. It is
 * the one place in the proxy where being *almost* right is worse than being
 * wrong: the Anthropic SDK is a parser, and a block index that does not line up,
 * or a `content_block_delta` with no matching `start`, breaks the client rather
 * than degrading the answer. None of that is visible in a type, and none of it
 * shows up in a smoke test that only reads the final text.
 *
 * The tests drive the machine through explicit chunk boundaries, because the
 * boundaries are half the behaviour: a `data:` line split across two network
 * reads has to survive, and a usage-only chunk arriving after `finish_reason`
 * has to still reach the final `message_delta`.
 *
 * @module test/streamTranslator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamTranslator } from "../src/application/streamTranslator";
import { silentLogger, toolManagerFake, type ToolManagerFake } from "./fakes";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

interface Event {
  type: string;
  data: any;
}

/** Feeds `chunks` through the translator verbatim and returns the events out. */
async function run(chunks: string[], opts: { thinking?: boolean; tools?: ToolManagerFake } = {}) {
  const tools = opts.tools ?? toolManagerFake();
  const translator = new StreamTranslator(tools.manager, silentLogger);

  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });

  const out = translator.translate(upstream, "local-model", opts.thinking ?? false);

  const decoder = new TextDecoder();
  let raw = "";
  const reader = out.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }

  return parse(raw);
}

/** Turns the Anthropic SSE wire format back into objects. */
function parse(raw: string): Event[] {
  const events: Event[] = [];
  for (const frame of raw.split("\n\n")) {
    const line = frame.trim();
    if (!line) continue;
    const [eventLine, dataLine] = line.split("\n");
    events.push({
      type: eventLine.replace("event: ", ""),
      data: JSON.parse(dataLine.replace("data: ", "")),
    });
  }
  return events;
}

/** One OpenAI SSE chunk carrying a delta. */
function delta(d: any, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: finish }] })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

const typesOf = (events: Event[]) => events.map((e) => e.type);

/** Every (index, event) pair for the content-block lifecycle, in order. */
function blockTrace(events: Event[]) {
  return events
    .filter((e) => e.type.startsWith("content_block"))
    .map((e) => `${e.type.replace("content_block_", "")}#${e.data.index}`);
}

/**
 * Asserts the block lifecycle is well formed: every delta sits inside a
 * start/stop pair for its own index, and nothing is left open. This is the
 * invariant the SDK actually depends on.
 */
function assertWellFormed(events: Event[]) {
  const open = new Set<number>();
  const seen = new Set<number>();
  for (const e of events) {
    const i = e.data.index;
    if (e.type === "content_block_start") {
      assert.equal(open.has(i), false, `index ${i} started while already open`);
      assert.equal(seen.has(i), false, `index ${i} reused after being closed`);
      open.add(i);
      seen.add(i);
    } else if (e.type === "content_block_delta") {
      assert.equal(open.has(i), true, `delta on index ${i} with no open block`);
    } else if (e.type === "content_block_stop") {
      assert.equal(open.has(i), true, `stop on index ${i} which was not open`);
      open.delete(i);
    }
  }
  assert.deepEqual([...open], [], "blocks left open at the end of the stream");
}

// ─────────────────────────────────────────────────────────────────────────────
// Message lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test("a plain text turn produces the full Anthropic event sequence", async () => {
  const events = await run([delta({ content: "hello" }), delta({}, "stop"), DONE]);

  assert.deepEqual(typesOf(events), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(events[0].data.message.model, "local-model");
  assert.equal(events[2].data.delta.text, "hello");
  assertWellFormed(events);
});

test("message_start is emitted once, however many deltas arrive", async () => {
  const events = await run([
    delta({ content: "a" }), delta({ content: "b" }), delta({ content: "c" }),
    delta({}, "stop"), DONE,
  ]);

  assert.equal(events.filter((e) => e.type === "message_start").length, 1);
  assert.equal(
    events.filter((e) => e.type === "content_block_delta").map((e) => e.data.delta.text).join(""),
    "abc",
  );
});

test("the final events are emitted once even when [DONE] follows finish_reason", async () => {
  const events = await run([delta({ content: "hi" }), delta({}, "stop"), DONE]);

  assert.equal(events.filter((e) => e.type === "message_delta").length, 1);
  assert.equal(events.filter((e) => e.type === "message_stop").length, 1);
});

test("a stream that ends without finish_reason still closes cleanly", async () => {
  const events = await run([delta({ content: "hi" }), DONE]);

  assert.equal(typesOf(events).at(-1), "message_stop");
  assertWellFormed(events);
});

// ─────────────────────────────────────────────────────────────────────────────
// Chunk boundaries
// ─────────────────────────────────────────────────────────────────────────────

test("a data line split across two reads is reassembled", async () => {
  // The network decides where chunks end, not the backend. Splitting mid-JSON
  // is normal and must not lose the delta.
  const whole = delta({ content: "split me" });
  const cut = Math.floor(whole.length / 2);

  const events = await run([whole.slice(0, cut), whole.slice(cut), delta({}, "stop"), DONE]);

  assert.equal(
    events.filter((e) => e.type === "content_block_delta").map((e) => e.data.delta.text).join(""),
    "split me",
  );
});

test("several events arriving in one read are all processed", async () => {
  const events = await run([delta({ content: "a" }) + delta({ content: "b" }) + delta({}, "stop") + DONE]);

  assert.equal(
    events.filter((e) => e.type === "content_block_delta").map((e) => e.data.delta.text).join(""),
    "ab",
  );
});

test("a malformed data line is skipped rather than killing the stream", async () => {
  const events = await run([
    "data: {not json\n\n",
    delta({ content: "still here" }),
    delta({}, "stop"),
    DONE,
  ]);

  assert.equal(typesOf(events).at(-1), "message_stop");
  assert.equal(events.some((e) => e.data?.delta?.text === "still here"), true);
});

test("non-data lines are ignored", async () => {
  const events = await run([": keep-alive\n\n", "event: ping\n\n", delta({ content: "x" }), delta({}, "stop"), DONE]);

  assert.equal(typesOf(events)[0], "message_start");
  assertWellFormed(events);
});

// ─────────────────────────────────────────────────────────────────────────────
// Thinking
// ─────────────────────────────────────────────────────────────────────────────

test("reasoning opens a thinking block at index 0 and text follows at index 1", async () => {
  const events = await run(
    [delta({ reasoning_content: "hmm" }), delta({ content: "answer" }), delta({}, "stop"), DONE],
    { thinking: true },
  );

  assert.deepEqual(blockTrace(events), ["start#0", "delta#0", "stop#0", "start#1", "delta#1", "stop#1"]);
  assertWellFormed(events);
});

test("with no reasoning the text block takes index 0", async () => {
  const events = await run([delta({ content: "answer" }), delta({}, "stop"), DONE], { thinking: true });
  assert.deepEqual(blockTrace(events), ["start#0", "delta#0", "stop#0"]);
});

test("reasoning is discarded entirely when thinking is off", async () => {
  const events = await run(
    [delta({ reasoning_content: "internal" }), delta({ content: "answer" }), delta({}, "stop"), DONE],
    { thinking: false },
  );

  assert.equal(events.some((e) => e.data?.delta?.type === "thinking_delta"), false);
  assert.deepEqual(blockTrace(events), ["start#0", "delta#0", "stop#0"]);
});

test("reasoning arriving after text does not corrupt the block indices", async () => {
  // Reasoning normally comes first, and the machine was written assuming it
  // always does — it pinned thinking to index 0 unconditionally. A backend that
  // emits a line of text before its reasoning would then get a thinking block
  // opened on top of the live text block, and the text deltas that followed
  // would land on an index that was never started.
  const events = await run(
    [delta({ content: "one moment" }), delta({ reasoning_content: "hmm" }), delta({ content: "answer" }), delta({}, "stop"), DONE],
    { thinking: true },
  );

  assertWellFormed(events);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool calls
// ─────────────────────────────────────────────────────────────────────────────

test("a tool call streams as start, incremental json, stop", async () => {
  const events = await run([
    delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"pa' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
    delta({}, "tool_calls"),
    DONE,
  ]);

  const start = events.find((e) => e.type === "content_block_start")!;
  assert.equal(start.data.content_block.type, "tool_use");
  assert.equal(start.data.content_block.name, "Read");
  assert.deepEqual(start.data.content_block.input, {}, "input arrives as deltas, not up front");

  assert.equal(
    events.filter((e) => e.data?.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join(""),
    '{"path":"a.ts"}',
  );
  assertWellFormed(events);
});

test("text before a tool call is closed before the tool block opens", async () => {
  const events = await run([
    delta({ content: "let me look" }),
    delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{}" } }] }),
    delta({}, "tool_calls"),
    DONE,
  ]);

  assert.deepEqual(blockTrace(events), ["start#0", "delta#0", "stop#0", "start#1", "delta#1", "stop#1"]);
});

test("two tool calls get separate blocks", async () => {
  const events = await run([
    delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{}" } }] }),
    delta({ tool_calls: [{ index: 1, id: "call_2", function: { name: "Grep", arguments: "{}" } }] }),
    delta({}, "tool_calls"),
    DONE,
  ]);

  const names = events
    .filter((e) => e.type === "content_block_start")
    .map((e) => [e.data.index, e.data.content_block.name]);
  assert.deepEqual(names, [[0, "Read"], [1, "Grep"]]);
  assertWellFormed(events);
});

test("whitespace padding around tool calls is dropped", async () => {
  // Models routinely emit a stray newline next to a tool call. Forwarding it
  // opens a text block that renders as an empty bubble in the client.
  const events = await run([
    delta({ content: "\n" }),
    delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{}" } }] }),
    delta({ content: "  " }),
    delta({}, "tool_calls"),
    DONE,
  ]);

  assert.equal(events.some((e) => e.data?.content_block?.type === "text"), false);
  assertWellFormed(events);
});

// ─────────────────────────────────────────────────────────────────────────────
// UseTool — deferred emission
// ─────────────────────────────────────────────────────────────────────────────

test("a UseTool call emits nothing until its arguments are complete", async () => {
  // The real tool name only exists inside the accumulated arguments, so the
  // block cannot be announced while it is still arriving. The client must never
  // see the meta-tool.
  const tools = toolManagerFake();
  tools.rewriteTo = { name: "Grep", input: { pattern: "TODO" } };

  const events = await run(
    [
      delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "UseTool", arguments: '{"tool":"Gr' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'ep"}' } }] }),
      delta({}, "tool_calls"),
      DONE,
    ],
    { tools },
  );

  assert.equal(events.some((e) => JSON.stringify(e.data).includes("UseTool")), false);

  // What was handed to rewriteUseToolCall matters more than what came back:
  // the real one JSON.parses this string, so an accumulation bug shows up here
  // and nowhere else. A fake that ignores the argument hides it completely.
  assert.deepEqual(tools.rewriteCalls, ['{"tool":"Grep"}']);

  const start = events.find((e) => e.type === "content_block_start")!;
  assert.equal(start.data.content_block.name, "Grep");
  assert.equal(
    events.find((e) => e.data?.delta?.type === "input_json_delta")!.data.delta.partial_json,
    '{"pattern":"TODO"}',
  );
  assertWellFormed(events);
});

test("a UseTool call that cannot be rewritten is emitted as itself", async () => {
  // Better a tool call the client rejects than a block that never arrives.
  const tools = toolManagerFake();
  tools.rewriteTo = null;

  const events = await run(
    [
      delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "UseTool", arguments: '{"tool":"Nope"}' } }] }),
      delta({}, "tool_calls"),
      DONE,
    ],
    { tools },
  );

  const start = events.find((e) => e.type === "content_block_start")!;
  assert.equal(start.data.content_block.name, "UseTool");
  assert.equal(
    events.find((e) => e.data?.delta?.type === "input_json_delta")!.data.delta.partial_json,
    '{"tool":"Nope"}',
  );
  assertWellFormed(events);
});

test("regression: a UseTool call delivered in one chunk is not doubled", async () => {
  // The first delta carries the id *and* the arguments, which is the common
  // shape. Registration used to seed `arguments` with that first fragment and
  // the accumulator then appended it a second time, so the string reaching
  // rewriteUseToolCall was '{"tool":"Grep"}{"tool":"Grep"}' — invalid JSON.
  // The parse failed, the rewrite returned null, and the client received an
  // unusable `UseTool` block. Nothing logged an error; the overflow path simply
  // stopped working, and only on models low enough on tools to need it.
  const tools = toolManagerFake();
  tools.rewriteTo = { name: "Grep", input: {} };

  await run(
    [
      delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "UseTool", arguments: '{"tool":"Grep"}' } }] }),
      delta({}, "tool_calls"),
      DONE,
    ],
    { tools },
  );

  assert.deepEqual(tools.rewriteCalls, ['{"tool":"Grep"}']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Stop reason and usage
// ─────────────────────────────────────────────────────────────────────────────

test("finish_reason maps onto the final message_delta", async () => {
  const stop = async (finish: string, d: any = {}) => {
    const events = await run([delta(d), delta({}, finish), DONE]);
    return events.find((e) => e.type === "message_delta")!.data.delta.stop_reason;
  };

  assert.equal(await stop("stop", { content: "x" }), "end_turn");
  assert.equal(await stop("length", { content: "x" }), "max_tokens");
  assert.equal(
    await stop("tool_calls", { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{}" } }] }),
    "tool_use",
  );
});

test("tool calls outrank a backend that finishes with 'stop'", async () => {
  const events = await run([
    delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{}" } }] }),
    delta({}, "stop"),
    DONE,
  ]);

  assert.equal(events.find((e) => e.type === "message_delta")!.data.delta.stop_reason, "tool_use");
});

test("usage from a choices-less chunk still reaches message_delta", async () => {
  // LM Studio sends usage in its own trailing chunk, after finish_reason. The
  // machine defers the final events to [DONE] precisely so this is not lost —
  // reporting output_tokens: 0 on every turn would be silent and wrong.
  const events = await run([
    delta({ content: "hi" }),
    delta({}, "stop"),
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 12 } })}\n\n`,
    DONE,
  ]);

  assert.equal(events.find((e) => e.type === "message_delta")!.data.usage.output_tokens, 12);
});

test("absent usage reports zero rather than undefined", async () => {
  const events = await run([delta({ content: "hi" }), delta({}, "stop"), DONE]);
  assert.equal(events.find((e) => e.type === "message_delta")!.data.usage.output_tokens, 0);
});
