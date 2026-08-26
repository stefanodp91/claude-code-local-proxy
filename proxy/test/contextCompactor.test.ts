/**
 * contextCompactor.test.ts — trimming the conversation to fit the window.
 *
 * Compaction runs exactly when a conversation has grown long, which in this
 * proxy means exactly when it is full of `tool_use` / `tool_result` pairs. Those
 * pairs are not ordinary messages: after translation to OpenAI they become an
 * assistant turn carrying `tool_calls` and the `tool` messages answering it, and
 * the backend rejects the request outright if either half is missing its
 * partner. Dropping messages by position cannot see that structure.
 *
 * So the property under test is not "the conversation got shorter". It is
 * "the conversation got shorter *and is still a valid conversation*".
 *
 * @module test/contextCompactor
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextCompactor, estimateTokens, repairToolPairing } from "../src/application/services/contextCompactor";
import { silentLogger } from "./fakes";
import type { LlmClientPort, LoggerPort } from "../src/domain/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** An LLM that returns a fixed summary, or refuses to. */
function summarizer(summary: string | null, opts: { hang?: boolean } = {}) {
  let calls = 0;
  const llm: LlmClientPort = {
    async chat() {
      calls++;
      if (opts.hang) return new Promise(() => {}); // never resolves
      if (summary === null) return { ok: false, status: 500 };
      return { ok: true, status: 200, json: { choices: [{ message: { content: summary } }] } };
    },
    async ping() { return true; },
  };
  return { llm, get calls() { return calls; } };
}

function compactor(llm: LlmClientPort, semantic = false) {
  return new ContextCompactor(llm, silentLogger as unknown as LoggerPort, {
    semanticEnabled: semantic,
    summaryMaxTokens: 512,
    summaryTimeout: 50,
  });
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const callsTool = (id: string, size = 0) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "Read", input: { path: "x".repeat(size) } }],
});
const answersTool = (id: string, result = "ok") => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: result }],
});

/** Filler wide enough to blow any budget the tests use. */
const bulk = (n: number) => user("x".repeat(n));

/**
 * The invariant the backend enforces: every tool_result answers a tool_use that
 * came earlier, and every tool_use is answered.
 */
function assertWellPaired(messages: any[]) {
  const opened = new Set<string>();
  const answered = new Set<string>();

  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") opened.add(b.id);
      if (b.type === "tool_result") {
        assert.equal(opened.has(b.tool_use_id), true,
          `tool_result ${b.tool_use_id} has no tool_use before it`);
        answered.add(b.tool_use_id);
      }
    }
  }
  for (const id of opened) {
    assert.equal(answered.has(id), true, `tool_use ${id} was never answered`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// When nothing needs to happen
// ─────────────────────────────────────────────────────────────────────────────

test("a conversation under the threshold is left alone", async () => {
  const messages = [user("hi"), assistant("hello")];
  const before = JSON.parse(JSON.stringify(messages));

  const outcome = await compactor(summarizer(null).llm).compact(messages, 100_000);

  assert.equal(outcome.compacted, false);
  assert.deepEqual(messages, before);
});

test("a budget of zero means the window is unknown, so nothing is trimmed", async () => {
  // modelInfo is null for backends that expose no metadata. Guessing a budget
  // and trimming on it would be worse than not trimming.
  const messages = [bulk(4_000), assistant("a"), user("b")];
  const outcome = await compactor(summarizer(null).llm).compact(messages, 0);

  assert.equal(outcome.compacted, false);
  assert.equal(messages.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Naive trimming
// ─────────────────────────────────────────────────────────────────────────────

test("an oversized conversation is brought under the target", async () => {
  const messages = [user("first"), ...Array.from({ length: 20 }, () => bulk(400)), user("last")];

  const outcome = await compactor(summarizer(null).llm).compact(messages, 1_000);

  assert.equal(outcome.compacted, true);
  assert.equal(estimateTokens(messages) <= 1_000 * 0.65, true, "still over the target");
});

test("the first and last messages survive", async () => {
  // The first carries the task; the last is what the model is answering.
  const messages = [user("the original request"), ...Array.from({ length: 20 }, () => bulk(400)), user("the latest turn")];

  await compactor(summarizer(null).llm).compact(messages, 1_000);

  assert.match(JSON.stringify(messages[0]), /the original request/);
  assert.match(JSON.stringify(messages.at(-1)), /the latest turn/);
});

test("the model is told that something was removed", async () => {
  // Silently shortening a conversation makes the model contradict itself about
  // things it can no longer see. A marker is the difference between amnesia and
  // knowing you have amnesia.
  const messages = [user("first"), ...Array.from({ length: 20 }, () => bulk(400)), user("last")];

  await compactor(summarizer(null).llm).compact(messages, 1_000);

  assert.match(JSON.stringify(messages), /removed|condensed|summary/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool pairing — the reason position-based trimming is not enough
// ─────────────────────────────────────────────────────────────────────────────

test("a tool result whose call was dropped is removed", () => {
  // Keep the answer without the question and the translated request carries a
  // `tool` message with no preceding `tool_calls`. The backend rejects it — a
  // 400 in place of a reply, and only ever in conversations long enough to
  // compact, which is to say the ones where a failure costs the most.
  const messages = [user("start"), answersTool("vanished"), user("last")];

  repairToolPairing(messages);

  assertWellPaired(messages);
  assert.equal(messages.length, 2);
});

test("a tool call whose answer was dropped is removed", () => {
  // The mirror image, equally fatal: OpenAI requires a reply for every
  // tool_call in an assistant message.
  const messages = [user("start"), callsTool("c1"), user("last")];

  repairToolPairing(messages);

  assertWellPaired(messages);
  assert.equal(messages.length, 2);
});

test("a mixed block keeps its text when its tool_result is removed", () => {
  // A user turn can carry both a tool_result and ordinary text. Dropping the
  // orphaned half must not take the sentence with it.
  const messages = [
    user("start"),
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "vanished", content: "r" },
        { type: "text", text: "and here is my actual question" },
      ],
    },
  ];

  repairToolPairing(messages);

  assertWellPaired(messages);
  assert.match(JSON.stringify(messages), /and here is my actual question/);
});

test("a well-formed conversation is untouched by the repair", () => {
  const messages = [user("start"), callsTool("c1"), answersTool("c1"), user("last")];
  const before = JSON.parse(JSON.stringify(messages));

  repairToolPairing(messages);

  assert.deepEqual(messages, before);
});

test("trimming that cuts through a pair leaves a valid conversation", async () => {
  // Deterministic on purpose. The call is enormous and its answer tiny, so
  // dropping exactly one message brings the total under target and stops —
  // right in the middle of the pair. Sizing the pair evenly, as the first
  // draft of this test did, makes messages drop two at a time and the orphan
  // never appears: the test passed against the bug.
  const messages = [user("start"), callsTool("c1", 8_000), answersTool("c1", "ok"), user("last")];

  const outcome = await compactor(summarizer(null).llm).compact(messages, 1_000);

  assert.equal(outcome.compacted, true, "guard: this must actually trim");
  assertWellPaired(messages);
});

// ─────────────────────────────────────────────────────────────────────────────
// The same invariant, in the shape the agent loops trim
// ─────────────────────────────────────────────────────────────────────────────

/** OpenAI shape: an assistant turn carrying tool_calls, answered by `tool`. */
const oaiCalls = (id: string) => ({
  role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name: "workspace", arguments: "{}" } }],
});
const oaiAnswers = (id: string, content = "ok") => ({ role: "tool", tool_call_id: id, content });

function assertOpenAiWellPaired(messages: any[]) {
  const opened = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) opened.add(tc.id);
    if (m.role === "tool") {
      assert.equal(opened.has(m.tool_call_id), true, `tool ${m.tool_call_id} answers nothing`);
      answered.add(m.tool_call_id);
    }
  }
  for (const id of opened) assert.equal(answered.has(id), true, `call ${id} was never answered`);
}

test("an unanswered tool_call is removed from the assistant turn", () => {
  // The agent loops compact their own OpenAI history, where the pairing has a
  // different shape entirely. A repair that only understood Anthropic blocks
  // would pass straight over this and leave the request invalid.
  const messages = [
    { role: "user", content: "go" },
    oaiCalls("c1"),
    { role: "user", content: "next" },
  ];

  repairToolPairing(messages);

  assertOpenAiWellPaired(messages);
  assert.equal(messages.length, 2, "an assistant turn with no text and no calls says nothing");
});

test("a tool message answering nothing is removed", () => {
  const messages = [{ role: "user", content: "go" }, oaiAnswers("vanished"), { role: "user", content: "next" }];

  repairToolPairing(messages);

  assertOpenAiWellPaired(messages);
  assert.equal(messages.length, 2);
});

test("an assistant turn keeps its text when its only call is dropped", () => {
  const messages = [
    { role: "user", content: "go" },
    { ...oaiCalls("c1"), content: "let me check that" },
    { role: "user", content: "next" },
  ];

  repairToolPairing(messages);

  assertOpenAiWellPaired(messages);
  assert.match(JSON.stringify(messages), /let me check that/);
});

test("a well-formed OpenAI exchange is untouched", () => {
  const messages = [{ role: "user", content: "go" }, oaiCalls("c1"), oaiAnswers("c1")];
  const before = JSON.parse(JSON.stringify(messages));

  repairToolPairing(messages);

  assert.deepEqual(messages, before);
});

// ─────────────────────────────────────────────────────────────────────────────
// Semantic compaction
// ─────────────────────────────────────────────────────────────────────────────

test("with semantic compaction on, the history is summarised instead of dropped", async () => {
  const llm = summarizer("They explored the repo and found the bug in main.ts.");
  const messages = [user("first"), ...Array.from({ length: 20 }, () => bulk(400)), user("last")];

  const outcome = await compactor(llm.llm, true).compact(messages, 1_000);

  assert.equal(llm.calls, 1);
  assert.equal(outcome.compacted, true);
  assert.match(JSON.stringify(messages), /found the bug in main\.ts/);
});

test("a summary that fails falls back to dropping, not to giving up", async () => {
  const llm = summarizer(null);
  const messages = [user("first"), ...Array.from({ length: 20 }, () => bulk(400)), user("last")];

  const outcome = await compactor(llm.llm, true).compact(messages, 1_000);

  assert.equal(llm.calls, 1);
  assert.equal(outcome.compacted, true);
  assert.equal(estimateTokens(messages) <= 1_000 * 0.65, true);
});

test("a summariser that hangs does not hang the turn", async () => {
  // It is called mid-request. Without the timeout the user waits on a backend
  // that may never answer.
  const llm = summarizer("unused", { hang: true });
  const messages = [user("first"), ...Array.from({ length: 20 }, () => bulk(400)), user("last")];

  const outcome = await compactor(llm.llm, true).compact(messages, 1_000);

  assert.equal(outcome.compacted, true, "the naive fallback still ran");
  assert.equal(estimateTokens(messages) <= 1_000 * 0.65, true);
});

test("semantic compaction also keeps the pairing intact", async () => {
  const llm = summarizer("summary of the exploration");
  const messages = [
    user("start"),
    ...Array.from({ length: 8 }, (_, i) => [callsTool(`c${i}`), answersTool(`c${i}`, "y".repeat(500))]).flat(),
    user("last"),
  ];

  await compactor(llm.llm, true).compact(messages, 1_000);

  assertWellPaired(messages);
});

// ─────────────────────────────────────────────────────────────────────────────
// The estimator
// ─────────────────────────────────────────────────────────────────────────────

test("the token estimate grows with the content", () => {
  assert.equal(estimateTokens([user("x")]) < estimateTokens([user("x".repeat(4_000))]), true);
});

test("the estimate is deliberately rough, and never zero for real content", () => {
  assert.equal(estimateTokens([user("hello")]) > 0, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Images
//
// The estimator's rule — 4 chars ≈ 1 token — is right for prose and wrong by
// two orders of magnitude for a base64 image. A 500 KB screenshot is ~683 000
// characters of payload, so the rule scores it at ~171 000 tokens: more than
// the whole loaded window, from a single attachment the model would have
// charged a few hundred tokens for. Nothing errors. The conversation is simply
// thrown away the moment the user attaches a picture.
// ─────────────────────────────────────────────────────────────────────────────

/** An Anthropic image block, as Claudio sends it. `kb` is the payload size. */
const imageMessage = (kb: number) => ({
  role: "user",
  content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(kb * 1024) } },
    { type: "text", text: "what is in this screenshot?" },
  ],
});

/** The same image after translation, as it sits in an agent loop's history. */
const oaiImageMessage = (kb: number) => ({
  role: "user",
  content: [
    { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(kb * 1024)}` } },
    { type: "text", text: "what is in this screenshot?" },
  ],
});

test("an image is not counted as if its base64 were prose", () => {
  // Both shapes, because compaction runs on both sides of the translation.
  assert.equal(estimateTokens([imageMessage(500)]) < 5_000, true);
  assert.equal(estimateTokens([oaiImageMessage(500)]) < 5_000, true);
});

test("an image still costs something — it is not free", () => {
  assert.equal(estimateTokens([imageMessage(500)]) > estimateTokens([user("what is in this screenshot?")]), true);
});

test("attaching a screenshot does not by itself discard the conversation", async () => {
  // A short exchange plus one image, against a window that fits it easily.
  const s = summarizer("summary");
  const messages = [user("hello"), assistant("hi"), imageMessage(500)];

  const outcome = await compactor(s.llm).compact(messages, 119_552);

  assert.equal(outcome.compacted, false, "compaction fired on a conversation that fits");
  assert.equal(messages.length, 3);
});

test("the summariser is never sent a base64 payload", async () => {
  // It is a text model call: the payload cannot be summarised, cannot be seen,
  // and would be the largest thing in the prompt.
  let prompt = "";
  const llm: LlmClientPort = {
    async chat(req: any) {
      prompt = req.body.messages[0].content;
      return { ok: true, status: 200, json: { choices: [{ message: { content: "summary" } }] } };
    },
    async ping() { return true; },
  };
  const messages = [user("start"), imageMessage(500), bulk(80_000), user("last"), assistant("end")];

  await compactor(llm, true).compact(messages, 20_000);

  assert.equal(prompt.includes("A".repeat(1_024)), false, "the base64 payload reached the summariser");
});
