/**
 * responseTranslator.test.ts — OpenAI → Anthropic, non-streaming.
 *
 * The other half of the round trip, and the path the native agent loop takes
 * whenever a backend answers a `stream: true` request with plain JSON anyway —
 * which LM Studio does more often than the flag suggests.
 *
 * Most of the risk here is in what the Anthropic SDK *refuses* rather than in
 * what looks wrong: a response with an empty content array, or a stop_reason of
 * end_turn when tool_use blocks are present, is rejected or mishandled by the
 * client rather than merely degraded.
 *
 * @module test/responseTranslator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponseTranslator } from "../src/application/responseTranslator";
import { toolManagerFake, type ToolManagerFake } from "./fakes";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** One OpenAI choice, wrapped in the envelope the translator expects. */
function reply(
  message: any,
  opts: { finish?: string; usage?: any; tools?: ToolManagerFake; thinking?: boolean } = {},
) {
  const tools = opts.tools ?? toolManagerFake();
  const translator = new ResponseTranslator(tools.manager);
  const out = translator.translate(
    {
      choices: [{ message, finish_reason: opts.finish ?? "stop" }],
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
    "local-model",
    opts.thinking ?? false,
  );
  return out;
}

const types = (r: any) => r.content.map((b: any) => b.type);

// ─────────────────────────────────────────────────────────────────────────────
// Envelope
// ─────────────────────────────────────────────────────────────────────────────

test("a response with no choices becomes an Anthropic error, not a crash", () => {
  const translator = new ResponseTranslator(toolManagerFake().manager);
  const out = translator.translate({}, "local-model", false);

  assert.equal(out.type, "error");
  assert.equal(out.error.type, "api_error");
});

test("the envelope carries the model, an id and translated usage", () => {
  const out = reply({ content: "hello" }, { usage: { prompt_tokens: 11, completion_tokens: 7 } });

  assert.equal(out.type, "message");
  assert.equal(out.role, "assistant");
  assert.equal(out.model, "local-model");
  assert.match(out.id, /^msg_/);
  assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 7 });
});

test("missing usage counts as zero rather than undefined", () => {
  assert.deepEqual(reply({ content: "hi" }).usage, { input_tokens: 0, output_tokens: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content blocks
// ─────────────────────────────────────────────────────────────────────────────

test("blocks come out in Anthropic's order: thinking, text, tools", () => {
  const out = reply(
    {
      reasoning_content: "let me think",
      content: "the answer",
      tool_calls: [{ id: "call_1", function: { name: "Read", arguments: '{"path":"a.ts"}' } }],
    },
    { thinking: true },
  );

  assert.deepEqual(types(out), ["thinking", "text", "tool_use"]);
});

test("reasoning is dropped when thinking is off", () => {
  const out = reply({ reasoning_content: "internal", content: "the answer" }, { thinking: false });
  assert.deepEqual(types(out), ["text"]);
});

test("empty reasoning does not open a thinking block", () => {
  const out = reply({ reasoning_content: "", content: "hi" }, { thinking: true });
  assert.deepEqual(types(out), ["text"]);
});

test("whitespace-only content produces no text block", () => {
  // Models pad around tool calls. An empty text block is noise in the UI.
  const out = reply({ content: "   \n  ", tool_calls: [{ id: "c1", function: { name: "Read", arguments: "{}" } }] });
  assert.deepEqual(types(out), ["tool_use"]);
});

test("an entirely empty message still yields one block", () => {
  // Anthropic rejects `content: []`. An empty text block is the valid way to
  // say "the model said nothing".
  const out = reply({});
  assert.deepEqual(out.content, [{ type: "text", text: "" }]);
});

test("tool arguments are parsed into the input object", () => {
  const out = reply({ tool_calls: [{ id: "call_1", function: { name: "Read", arguments: '{"path":"a.ts"}' } }] });

  assert.deepEqual(out.content[0], {
    type: "tool_use",
    id: "call_1",
    name: "Read",
    input: { path: "a.ts" },
  });
});

test("unparseable tool arguments are preserved rather than dropped", () => {
  // The turn is already lost; keeping the raw string gives the model something
  // to react to and the user something to read, instead of a silent `{}`.
  const out = reply({ tool_calls: [{ id: "call_1", function: { name: "Read", arguments: "{not json" } }] });

  assert.deepEqual(out.content[0].input, { _raw: "{not json" });
});

test("several tool calls keep their order and their ids", () => {
  const out = reply({
    tool_calls: [
      { id: "call_1", function: { name: "Read", arguments: "{}" } },
      { id: "call_2", function: { name: "Grep", arguments: "{}" } },
    ],
  });

  assert.deepEqual(out.content.map((b: any) => [b.id, b.name]), [["call_1", "Read"], ["call_2", "Grep"]]);
});

// ─────────────────────────────────────────────────────────────────────────────
// UseTool rewriting
// ─────────────────────────────────────────────────────────────────────────────

test("a UseTool call surfaces as the tool it stands for", () => {
  // The client must never learn that the overflow meta-tool exists — it sees
  // the real tool name and the real input, and the round trip stays honest.
  const tools = toolManagerFake();
  tools.rewriteTo = { name: "Grep", input: { pattern: "TODO" } };

  const out = reply(
    { tool_calls: [{ id: "call_1", function: { name: "UseTool", arguments: '{"tool":"Grep"}' } }] },
    { tools },
  );

  assert.deepEqual(out.content[0], {
    type: "tool_use",
    id: "call_1",
    name: "Grep",
    input: { pattern: "TODO" },
  });
});

test("a UseTool call that cannot be rewritten falls through as itself", () => {
  const tools = toolManagerFake();
  tools.rewriteTo = null;

  const out = reply(
    { tool_calls: [{ id: "call_1", function: { name: "UseTool", arguments: '{"tool":"Nope"}' } }] },
    { tools },
  );

  assert.equal(out.content[0].name, "UseTool");
  assert.deepEqual(out.content[0].input, { tool: "Nope" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stop reason
// ─────────────────────────────────────────────────────────────────────────────

test("finish_reason maps to the Anthropic stop reason", () => {
  assert.equal(reply({ content: "x" }, { finish: "stop" }).stop_reason, "end_turn");
  assert.equal(reply({ content: "x" }, { finish: "length" }).stop_reason, "max_tokens");
  assert.equal(
    reply({ tool_calls: [{ id: "c1", function: { name: "Read", arguments: "{}" } }] }, { finish: "tool_calls" }).stop_reason,
    "tool_use",
  );
});

test("tool_use blocks outrank a backend that reports 'stop'", () => {
  // Several OpenAI-compatible servers finish with "stop" even when they emitted
  // tool calls. Passing end_turn through would make the client end the turn and
  // never run the tool.
  const out = reply(
    { tool_calls: [{ id: "call_1", function: { name: "Read", arguments: "{}" } }] },
    { finish: "stop" },
  );

  assert.equal(out.stop_reason, "tool_use");
});

test("an unknown finish_reason degrades to end_turn", () => {
  assert.equal(reply({ content: "x" }, { finish: "content_filter" }).stop_reason, "end_turn");
});
