/**
 * requestTranslator.test.ts — Anthropic → OpenAI request translation.
 *
 * Half of the round trip both surfaces cross on every single request. The
 * translation is pure and synchronous, which makes it cheap to test and easy
 * to get subtly wrong: most of what can break here produces a request the
 * backend still accepts, and a reply that is merely worse.
 *
 * The two orderings below are the ones that actually matter on the wire:
 * tool results must precede the user text that follows them, and image parts
 * must precede their caption. Both are load-bearing for OpenAI-compatible
 * backends and neither is visible in a type.
 *
 * @module test/requestTranslator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestTranslator } from "../src/application/requestTranslator";
import { configFake, modelInfoFake, toolManagerFake } from "./fakes";
import type { AnthropicRequest, LoadedModelInfo } from "../src/domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function translate(body: Partial<AnthropicRequest>, modelInfo: LoadedModelInfo | null = modelInfoFake()) {
  const tools = toolManagerFake();
  const translator = new RequestTranslator(modelInfo, tools.manager, configFake());
  const out = translator.translate({
    model: "claude-sonnet-4",
    max_tokens: 1024,
    messages: [],
    ...body,
  } as AnthropicRequest);
  return { ...out, tools };
}

/** The messages array minus the system prompt, which most tests do not set. */
function conversation(req: { messages: any[] }) {
  return req.messages.filter((m) => m.role !== "system");
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

test("a string system prompt becomes a system message", () => {
  const { request } = translate({ system: "be brief" as any });
  assert.deepEqual(request.messages[0], { role: "system", content: "be brief" });
});

test("system prompt blocks are joined, and non-text blocks dropped", () => {
  const { request } = translate({
    system: [
      { type: "text", text: "first" },
      { type: "image", source: { type: "base64" } },
      { type: "text", text: "second" },
    ] as any,
  });
  assert.deepEqual(request.messages[0], { role: "system", content: "first\n\nsecond" });
});

test("no system prompt means no system message", () => {
  const { request } = translate({ messages: [{ role: "user", content: "hi" }] as any });
  assert.equal(request.messages.some((m: any) => m.role === "system"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Message content
// ─────────────────────────────────────────────────────────────────────────────

test("tool results are emitted before the user text that accompanies them", () => {
  // OpenAI requires every tool message to follow the assistant tool_calls it
  // answers. A user text block sent first would break that adjacency.
  const { request } = translate({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "and now explain it" },
        { type: "tool_result", tool_use_id: "call_1", content: "42" },
      ],
    }] as any,
  });

  assert.deepEqual(conversation(request), [
    { role: "tool", tool_call_id: "call_1", content: "42" },
    { role: "user", content: "and now explain it" },
  ]);
});

test("tool result content given as blocks is flattened to text", () => {
  const { request } = translate({
    messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call_1",
        content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }],
      }],
    }] as any,
  });

  assert.equal(conversation(request)[0].content, "line one\nline two");
});

test("images become data URIs, ahead of their caption", () => {
  const { request } = translate({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
      ],
    }] as any,
  });

  assert.deepEqual(conversation(request)[0], {
    role: "user",
    content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
      { type: "text", text: "what is this?" },
    ],
  });
});

test("an image with no caption produces no empty text part", () => {
  const { request } = translate({
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } }],
    }] as any,
  });

  assert.equal(conversation(request)[0].content.length, 1);
});

test("assistant tool_use becomes tool_calls with stringified arguments", () => {
  const { request } = translate({
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.ts" } },
      ],
    }] as any,
  });

  assert.deepEqual(conversation(request)[0], {
    role: "assistant",
    content: "let me look",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "Read", arguments: '{"path":"a.ts"}' },
    }],
  });
});

test("a tool_use with no input still sends valid JSON", () => {
  // `arguments` is a string the backend will JSON.parse. `undefined` there
  // becomes the literal "undefined" and takes the parse down with it.
  const { request } = translate({
    messages: [{
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "Ping" }],
    }] as any,
  });

  assert.equal(conversation(request)[0].tool_calls[0].function.arguments, "{}");
});

test("an assistant turn that is only tool calls carries null content", () => {
  const { request } = translate({
    messages: [{
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }],
    }] as any,
  });

  assert.equal(conversation(request)[0].content, null);
});

test("thinking blocks are dropped in both directions", () => {
  // The model produces its own reasoning; replaying ours wastes context and,
  // on some backends, confuses the chat template.
  const { request } = translate({
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "thinking", thinking: "why" }, { type: "text", text: "go on" }] },
    ] as any,
  });

  assert.deepEqual(conversation(request), [
    { role: "assistant", content: "ok" },
    { role: "user", content: "go on" },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tools and tool choice
// ─────────────────────────────────────────────────────────────────────────────

test("tool definitions are reshaped from input_schema to parameters", () => {
  const schema = { type: "object", properties: { path: { type: "string" } } };
  const { request } = translate({
    tools: [{ name: "Read", description: "read a file", input_schema: schema }] as any,
  });

  assert.deepEqual(request.tools, [{
    type: "function",
    function: { name: "Read", description: "read a file", parameters: schema },
  }]);
});

test("a request with no tools sends no tools key at all", () => {
  const { request, tools } = translate({ tools: [] as any });
  assert.equal("tools" in request, false);
  assert.equal(tools.selections.length, 0, "ToolManager is not consulted for an empty set");
});

test("tool_choice auto and none map straight across", () => {
  assert.equal(translate({ tool_choice: { type: "auto" } as any }).request.tool_choice, "auto");
  assert.equal(translate({ tool_choice: { type: "none" } as any }).request.tool_choice, "none");
});

test("a named tool_choice degrades to required, and the name reaches ToolManager", () => {
  // LM Studio rejects the {type:"function",function:{name}} form, so the name
  // cannot be enforced on the wire. It is not lost, though: ToolManager scores
  // that tool to the top of the selection instead.
  const { request, tools } = translate({
    tools: [{ name: "Read", input_schema: {} }] as any,
    tool_choice: { type: "tool", name: "Read" } as any,
  });

  assert.equal(request.tool_choice, "required");
  assert.equal(tools.selections[0].forced, "Read");
});

test("tool_choice 'any' currently maps to auto — see PLAN.md before changing", () => {
  // Anthropic's "any" means *some* tool must be called; OpenAI spells that
  // "required", which this backend does support — the probe itself uses it.
  // Mapping it to "auto" leaves the model free to answer in prose instead.
  // Recorded as an open question in PLAN.md § Fase 2 rather than changed here,
  // because forcing a tool call is exactly the kind of pressure some local
  // models handle badly, and that trade-off is not this suite's to make.
  assert.equal(
    translate({ tool_choice: { type: "any" } as any }).request.tool_choice,
    "auto",
    "if this now says 'required', the open question was settled — update PLAN.md and delete this note",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Model limits and parameters
// ─────────────────────────────────────────────────────────────────────────────

test("max_tokens is capped to the loaded model's ceiling", () => {
  // Claude Code asks for 32000+; a small local model asked to produce that
  // much will happily loop until it does.
  const { request } = translate({ max_tokens: 32_000 }, modelInfoFake({ maxTokensCap: 2048 }));
  assert.equal(request.max_tokens, 2048);
});

test("a request already under the cap is left alone", () => {
  const { request } = translate({ max_tokens: 100 }, modelInfoFake({ maxTokensCap: 2048 }));
  assert.equal(request.max_tokens, 100);
});

test("with no model info the configured fallback caps instead", () => {
  const { request } = translate({ max_tokens: 32_000 }, null);
  assert.equal(request.max_tokens, 4096);
});

test("a cap of zero means uncapped", () => {
  const { request } = translate({ max_tokens: 32_000 }, modelInfoFake({ maxTokensCap: 0 }));
  assert.equal(request.max_tokens, 32_000);
});

test("the request is addressed to the loaded model, not the one Claude Code named", () => {
  const { request } = translate({ model: "claude-sonnet-4" }, modelInfoFake({ id: "qwen/qwen3.8-27b" }));
  assert.equal(request.model, "qwen/qwen3.8-27b");
});

test("optional parameters appear only when the client sent them", () => {
  const bare = translate({}).request;
  assert.equal("temperature" in bare, false);
  assert.equal("top_p" in bare, false);
  assert.equal("stop" in bare, false);

  const full = translate({ temperature: 0, top_p: 0.9, stop_sequences: ["END"] } as any).request;
  assert.equal(full.temperature, 0, "zero is a value, not an absence");
  assert.equal(full.top_p, 0.9);
  assert.deepEqual(full.stop, ["END"]);
});

test("streaming is on by default and usage is always requested", () => {
  // A decision with a client-visible edge, confirmed against the running proxy:
  // a request that omits `stream` comes back as SSE, not JSON, because the
  // default is applied here and the response path follows it. Every client this
  // proxy serves streams, so the default is the useful one — but a client that
  // omits the field expecting a JSON body gets an event stream. Documented in
  // docs/architecture.md rather than left to be discovered.
  const { request } = translate({});
  assert.equal(request.stream, true);
  assert.deepEqual(request.stream_options, { include_usage: true });

  assert.equal(translate({ stream: false }).request.stream, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Thinking
// ─────────────────────────────────────────────────────────────────────────────

test("enable_thinking is sent explicitly, both true and false, when the model supports it", () => {
  // Not "omit when off": an explicit false is what lets a client actually
  // suppress reasoning on backends that honour the flag, saving the tokens.
  const info = modelInfoFake({ supportsThinking: true });

  assert.equal(translate({ thinking: { type: "enabled" } } as any, info).request.enable_thinking, true);
  assert.equal(translate({ thinking: { type: "adaptive" } } as any, info).request.enable_thinking, true);
  assert.equal(translate({ thinking: { type: "disabled" } } as any, info).request.enable_thinking, false);
  assert.equal(translate({}, info).request.enable_thinking, false);
});

test("a model without thinking support never sees the parameter", () => {
  const { request } = translate(
    { thinking: { type: "enabled" } } as any,
    modelInfoFake({ supportsThinking: false }),
  );
  assert.equal("enable_thinking" in request, false);
});
