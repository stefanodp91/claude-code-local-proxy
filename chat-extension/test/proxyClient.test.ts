/**
 * proxyClient.test.ts — what the extension actually puts on the wire.
 *
 * Everything the proxy decides depends on this request: the workspace header is
 * what selects the agent loop at all, the plan-exit header is what makes an
 * approved plan reach the model, and `thinking` is what turns reasoning blocks
 * on. Each of them is a header or a field that can go missing without anything
 * failing — the turn still answers, only as a different product: no agent, no
 * plan, no thinking.
 *
 * `fetch` is replaced per test rather than mocked through a framework; the port
 * is the global, and swapping it is the whole of what a fake needs to be here.
 *
 * @module test/proxyClient
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ProxyClient } from "../src/extension/proxy/proxy-client";
import type { ChatConfig } from "../src/extension/config/extension-config";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Call { url: string; init: any }
let calls: Call[] = [];
beforeEach(() => { calls = []; });

/** Answer every request with the given SSE frames. */
function respondWith(frames: string[], opts: { ok?: boolean; status?: number; body?: boolean } = {}) {
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    if (opts.ok === false) {
      return { ok: false, status: opts.status ?? 500, text: async () => "boom" } as any;
    }
    if (opts.body === false) {
      return { ok: true, status: 200, body: null } as any;
    }
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            i < frames.length
              ? { done: false, value: enc.encode(frames[i++]) }
              : { done: true, value: undefined },
          releaseLock() {},
        }),
      },
    } as any;
  }) as typeof fetch;
}

const config = (over: Partial<ChatConfig> = {}): ChatConfig => ({
  proxyHost: "127.0.0.1",
  proxyPort: 5678,
  temperature: 0.7,
  systemPrompt: "",
  enableThinking: false,
  maxTokens: 900,
  locale: "en",
  agentMode: "ask",
  modelInfo: null,
  ...over,
} as ChatConfig);

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function drain(gen: AsyncGenerator<{ event: string; data: string }>) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

const client = () => new ProxyClient("http://127.0.0.1:5678");
const message = { role: "user", content: "hi" } as any;

// ─────────────────────────────────────────────────────────────────────────────
// The request
// ─────────────────────────────────────────────────────────────────────────────

test("the workspace root travels as a header — it is what selects the agent loop", async () => {
  // Without x-workspace-root the proxy is a pure translator: no workspace tool,
  // no approval gate, no plan mode. The turn still answers, which is exactly
  // why losing this header would go unnoticed.
  respondWith([frame("message_stop", {})]);

  await drain(client().sendMessage({ messages: [message], config: config(), workspaceRoot: "/ws" }));

  assert.equal(calls[0].init.headers["x-workspace-root"], "/ws");
});

test("no workspace root means no header at all, not an empty one", async () => {
  // An empty string is truthy enough to reach the proxy and would select the
  // agent loop with a workspace of "".
  respondWith([frame("message_stop", {})]);

  await drain(client().sendMessage({ messages: [message], config: config() }));

  assert.equal("x-workspace-root" in calls[0].init.headers, false);
});

test("the plan-exit path is forwarded when there is one", async () => {
  respondWith([frame("message_stop", {})]);

  await drain(client().sendMessage({
    messages: [message], config: config(), workspaceRoot: "/ws", planExitPath: ".claudio/plans/p.md",
  }));

  assert.equal(calls[0].init.headers["x-plan-exit-path"], ".claudio/plans/p.md");
});

test("thinking is requested only when the setting says so", async () => {
  respondWith([frame("message_stop", {})]);
  await drain(client().sendMessage({ messages: [message], config: config({ enableThinking: true }) }));
  const on = JSON.parse(calls[0].init.body);

  calls = [];
  respondWith([frame("message_stop", {})]);
  await drain(client().sendMessage({ messages: [message], config: config({ enableThinking: false }) }));
  const off = JSON.parse(calls[0].init.body);

  assert.deepEqual(on.thinking, { type: "enabled" });
  assert.equal("thinking" in off, false);
});

test("an empty system prompt is left out rather than sent empty", async () => {
  respondWith([frame("message_stop", {})]);

  await drain(client().sendMessage({ messages: [message], config: config({ systemPrompt: "" }) }));

  assert.equal("system" in JSON.parse(calls[0].init.body), false);
});

test("the request always streams, and carries the configured limits", async () => {
  respondWith([frame("message_stop", {})]);

  await drain(client().sendMessage({
    messages: [message], config: config({ maxTokens: 1234, temperature: 0.2 }),
  }));

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 1234);
  assert.equal(body.temperature, 0.2);
});

test("only role and content reach the proxy — local bookkeeping stays local", async () => {
  // Conversation entries carry fields the UI needs (ids, timestamps, attachment
  // metadata). Forwarding them wastes context on every turn.
  respondWith([frame("message_stop", {})]);

  await drain(client().sendMessage({
    messages: [{ role: "user", content: "hi", id: "abc", timestamp: 123 } as any],
    config: config(),
  }));

  assert.deepEqual(JSON.parse(calls[0].init.body).messages, [{ role: "user", content: "hi" }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// The response
// ─────────────────────────────────────────────────────────────────────────────

test("events arrive parsed, in order", async () => {
  respondWith([frame("message_start", { i: 0 }), frame("content_block_delta", { i: 1 })]);

  const events = await drain(client().sendMessage({ messages: [message], config: config() }));

  assert.deepEqual(events.map((e) => e.event), ["message_start", "content_block_delta"]);
});

test("an event split across two reads survives the generator", async () => {
  const whole = frame("content_block_delta", { text: "hello" });
  respondWith([whole.slice(0, 20), whole.slice(20)]);

  const events = await drain(client().sendMessage({ messages: [message], config: config() }));

  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0].data), { text: "hello" });
});

test("a stream that ends without a blank line still yields its last event", async () => {
  respondWith(["event: last\ndata: {\"i\":9}"]);

  const events = await drain(client().sendMessage({ messages: [message], config: config() }));

  assert.deepEqual(events.map((e) => e.event), ["last"]);
});

test("an HTTP error is raised, not streamed as silence", async () => {
  // The user has to be told. An empty generator here looks like a model that
  // had nothing to say.
  respondWith([], { ok: false, status: 503 });

  await assert.rejects(
    () => drain(client().sendMessage({ messages: [message], config: config() })),
    /503/,
  );
});

test("a response with no body is an error too", async () => {
  respondWith([], { body: false });

  await assert.rejects(() => drain(client().sendMessage({ messages: [message], config: config() })));
});

// ─────────────────────────────────────────────────────────────────────────────
// Approval and mode
// ─────────────────────────────────────────────────────────────────────────────

test("approve posts the decision to the request's own endpoint", async () => {
  // The proxy blocks that turn until this arrives, so the id and the scope both
  // have to be right — a wrong id leaves the turn hanging to its timeout.
  respondWith([]);

  await client().approve("req-123", true, "turn");

  assert.match(calls[0].url, /\/v1\/messages\/req-123\/approve$/);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { approved: true, scope: "turn" });
});

test("approve defaults to the narrowest scope", async () => {
  // "once" is the safe default: a wrong default here silently widens what the
  // user agreed to.
  respondWith([]);

  await client().approve("req-1", true);

  assert.equal(JSON.parse(calls[0].init.body).scope, "once");
});

test("a failed approve does not throw at the caller", async () => {
  // The proxy auto-denies on timeout, so the recovery is to say nothing here —
  // but throwing would take down the turn's own error handling with it.
  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;

  await client().approve("req-1", true, "once");
});

test("setAgentMode returns the mode the proxy confirms, not the one asked for", async () => {
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ mode: "plan" }) } as any;
  }) as typeof fetch;

  const mode = await client().setAgentMode("plan");

  assert.equal(mode, "plan");
  assert.match(calls[0].url, /\/agent-mode$/);
});

test("a refused mode change reports undefined rather than pretending", async () => {
  globalThis.fetch = (async () => ({ ok: false, status: 400 })) as any;

  assert.equal(await client().setAgentMode("auto"), undefined);
});
