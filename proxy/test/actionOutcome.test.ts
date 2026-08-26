/**
 * actionOutcome.test.ts — putting an action's image in front of the model.
 *
 * A `python` action that draws a plot produces a PNG. Until now its base64 was
 * returned as the tool result *string*: tens of thousands of tokens of
 * unreadable text, charged in full, teaching the model nothing. This module is
 * where an image stops being text.
 *
 * The shape matters more than it looks. An OpenAI-compatible backend accepts an
 * image inside a *user* message and not inside a `role: "tool"` one, and it
 * expects every tool result of an assistant turn to follow that turn without
 * anything wedged in between. So the image cannot go where the result goes, and
 * it cannot go straight after the result that produced it either — it goes after
 * all of them. Get that wrong and the backend rejects the request; get it
 * silently wrong and it rejects only the turns that drew a picture.
 *
 * @module test/actionOutcome
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendNativeToolResults,
  buildObservationMessage,
} from "../src/application/services/actionOutcome";
import type { ActionOutcome } from "../src/domain/entities/workspaceAction";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const PAYLOAD = "iVBORw0KGgo".repeat(400);

const withImage = (text = "figure"): ActionOutcome => ({
  text,
  image: { media_type: "image/png", data: PAYLOAD },
});
const textOnly = (text = "ok"): ActionOutcome => ({ text });

/** The assistant turn a batch of tool results answers. */
const assistantCalls = (...ids: string[]) => ({
  role: "assistant",
  content: null,
  tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "workspace", arguments: "{}" } })),
});

const imagePartsOf = (message: any): any[] =>
  Array.isArray(message?.content) ? message.content.filter((p: any) => p.type === "image_url") : [];

// ─────────────────────────────────────────────────────────────────────────────
// Path A — the native loop
// ─────────────────────────────────────────────────────────────────────────────

test("a tool result never carries the image itself", () => {
  // `role: "tool"` takes a string. An array there is rejected by the backend,
  // and the rejection would only ever happen on a turn that drew something.
  const messages: any[] = [assistantCalls("c1")];

  appendNativeToolResults(messages, [{ id: "c1", outcome: withImage() }], true);

  const toolMsg = messages.find((m) => m.role === "tool");
  assert.equal(typeof toolMsg.content, "string");
  assert.equal(toolMsg.content.includes(PAYLOAD), false, "the payload leaked into the tool result");
});

test("the image reaches the model as an image, in a user message", () => {
  const messages: any[] = [assistantCalls("c1")];

  appendNativeToolResults(messages, [{ id: "c1", outcome: withImage() }], true);

  const last = messages[messages.length - 1];
  assert.equal(last.role, "user");
  assert.deepEqual(imagePartsOf(last), [
    { type: "image_url", image_url: { url: `data:image/png;base64,${PAYLOAD}` } },
  ]);
});

test("the tool result says the image exists, so the model knows to look", () => {
  const messages: any[] = [assistantCalls("c1")];

  appendNativeToolResults(messages, [{ id: "c1", outcome: withImage() }], true);

  const toolMsg = messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /image/i);
});

test("images come after every tool result, not next to the one that made them", () => {
  // Two calls in one assistant turn, the first of which drew something. An
  // image message wedged between the two tool results orphans the second.
  const messages: any[] = [assistantCalls("c1", "c2")];

  appendNativeToolResults(
    messages,
    [{ id: "c1", outcome: withImage() }, { id: "c2", outcome: textOnly() }],
    true,
  );

  assert.deepEqual(messages.map((m) => m.role), ["assistant", "tool", "tool", "user"]);
  assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), ["c1", "c2"]);
});

test("several images ride in one user message, in call order", () => {
  const messages: any[] = [assistantCalls("c1", "c2")];

  appendNativeToolResults(
    messages,
    [{ id: "c1", outcome: withImage("first") }, { id: "c2", outcome: withImage("second") }],
    true,
  );

  assert.equal(messages.filter((m) => m.role === "user").length, 1);
  assert.equal(imagePartsOf(messages[messages.length - 1]).length, 2);
});

test("no image, no extra message", () => {
  const messages: any[] = [assistantCalls("c1")];

  appendNativeToolResults(messages, [{ id: "c1", outcome: textOnly() }], true);

  assert.deepEqual(messages.map((m) => m.role), ["assistant", "tool"]);
});

test("a text-only model is told the image exists and is not sent it", () => {
  // Sending an image_url to a text model is a rejected request; saying nothing
  // leaves it answering about a picture it was never given.
  const messages: any[] = [assistantCalls("c1")];

  appendNativeToolResults(messages, [{ id: "c1", outcome: withImage() }], false);

  assert.deepEqual(messages.map((m) => m.role), ["assistant", "tool"]);
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /image/i);
  assert.equal(toolMsg.content.includes(PAYLOAD), false);
});

test("the notice names the size, because the model is choosing what to do next", () => {
  const messages: any[] = [assistantCalls("c1")];

  appendNativeToolResults(messages, [{ id: "c1", outcome: withImage() }], true);

  assert.match(messages.find((m) => m.role === "tool").content, /image\/png/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Path B — the textual loop
// ─────────────────────────────────────────────────────────────────────────────

test("Path B carries the image in the observation itself", () => {
  // The observation already is a user turn, so there is nowhere else to put it.
  const msg = buildObservationMessage(withImage(), true);

  assert.equal(msg.role, "user");
  assert.equal(imagePartsOf(msg).length, 1);
  const text = msg.content.find((p: any) => p.type === "text").text;
  assert.match(text, /<observation>[\s\S]*<\/observation>/);
});

test("Path B without an image keeps the observation a plain string", () => {
  const msg = buildObservationMessage(textOnly("ok"), true);

  assert.equal(typeof msg.content, "string");
  assert.equal(msg.content, "<observation>\nok\n</observation>");
});

test("Path B on a text-only model describes the image instead of attaching it", () => {
  const msg = buildObservationMessage(withImage(), false);

  assert.equal(typeof msg.content, "string");
  assert.match(msg.content, /image/i);
  assert.equal(msg.content.includes(PAYLOAD), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The wiring
//
// These assertions read the shipped source rather than a fake, because the
// failure they guard against is the one this project keeps meeting: a helper
// that is correct, tested, and called by nobody. A loop that shapes its own
// tool result, or a call site that never resolves the vision flag, leaves every
// test above passing and the feature doing nothing.
// ─────────────────────────────────────────────────────────────────────────────

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");

test("neither loop shapes a tool result on its own", () => {
  for (const rel of [
    "../src/application/services/nativeAgentLoopService.ts",
    "../src/application/textualAgentLoop.ts",
  ]) {
    const src = source(rel);
    assert.equal(
      /push\(\s*\{\s*role:\s*"tool"/.test(src),
      false,
      `${rel} pushes a tool message directly`,
    );
    assert.match(src, /actionOutcome/, `${rel} does not go through the shared shaping`);
  }
});

test("both paths resolve vision capability from the loaded model", () => {
  // Path A through the server's model poll, Path B through the use case.
  for (const rel of [
    "../src/infrastructure/server.ts",
    "../src/application/useCases/handleChatMessageUseCase.ts",
  ]) {
    assert.match(source(rel), /type === "vlm"/, `${rel} never asks whether the model can see`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The file on disk
// ─────────────────────────────────────────────────────────────────────────────

test("the notice names the file the figure was saved to", () => {
  // The model can see the image; the user can only open the file. The path is
  // how the two are the same picture.
  const messages: any[] = [assistantCalls("c1")];
  const outcome: ActionOutcome = {
    text: "",
    image: { media_type: "image/png", data: PAYLOAD, savedPath: ".claudio/plots/plot-20260827-120000.png" },
  };

  appendNativeToolResults(messages, [{ id: "c1", outcome }], true);

  assert.match(messages.find((m) => m.role === "tool").content, /\.claudio\/plots\/plot-20260827-120000\.png/);
});

test("a text-only model still gets told where the figure is", () => {
  // This is the whole of what it can act on, so losing the path here would
  // leave `python` drawing into a void.
  const messages: any[] = [assistantCalls("c1")];
  const outcome: ActionOutcome = {
    text: "",
    image: { media_type: "image/png", data: PAYLOAD, savedPath: ".claudio/plots/plot-20260827-120000.png" },
  };

  appendNativeToolResults(messages, [{ id: "c1", outcome }], false);

  const toolMsg = messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /\.claudio\/plots\/plot-20260827-120000\.png/);
  assert.equal(toolMsg.content.includes(PAYLOAD), false);
});
