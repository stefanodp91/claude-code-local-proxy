/**
 * planExitInjection.test.ts — handing an approved plan back to the model.
 *
 * The user reads a plan, approves it, and Claudio re-runs the turn with
 * `x-plan-exit-path`. The proxy reads that file and puts it in front of the
 * model. Everything about that sentence can fail quietly:
 *
 *   - the plan is not injected → the turn runs as if no plan existed, and the
 *     model plans again, which is what the user just approved their way out of;
 *   - the plan is injected without saying what it is for → the model explains
 *     the plan back instead of carrying it out;
 *   - the path is not contained → the header names any file the process can
 *     read and its contents go into the prompt.
 *
 * All three were live in the code this suite was written against, and the third
 * is the containment mistake this repo has now made four times: `startsWith`
 * without a separator lets `/ws-evil/secret.md` pass for a workspace of `/ws`.
 *
 * @module test/planExitInjection
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlanForExit, injectPlanIntoLastUserMessage } from "../src/application/services/planExitInjection";

// ─────────────────────────────────────────────────────────────────────────────
// Reading the plan — where it may live
// ─────────────────────────────────────────────────────────────────────────────

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "claudio-plan-"));
  mkdirSync(join(ws, ".claudio", "plans"), { recursive: true });
  writeFileSync(join(ws, ".claudio", "plans", "p.md"), "# Plan\n1. do the thing\n");
  return ws;
}

test("a plan inside the workspace is read", () => {
  const ws = workspace();
  try {
    assert.match(loadPlanForExit(".claudio/plans/p.md", ws) ?? "", /do the thing/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a sibling directory that merely shares the prefix is refused", () => {
  // The exact shape `startsWith(root)` gets wrong, and the reason this project
  // keeps `relative()` as its containment rule: for a workspace of `/tmp/ws`,
  // `/tmp/ws-evil/secret.md` starts with the root and is not inside it.
  const ws = mkdtempSync(join(tmpdir(), "claudio-plan-"));
  const evil = `${ws}-evil`;
  try {
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "secret.md"), "SECRET");

    const loaded = loadPlanForExit(`../${evil.split("/").pop()}/secret.md`, ws);

    assert.equal(loaded, null, "a file outside the workspace was read into the prompt");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(evil, { recursive: true, force: true });
  }
});

test("a path climbing out of the workspace is refused", () => {
  const ws = workspace();
  try {
    assert.equal(loadPlanForExit("../../etc/hosts", ws), null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a missing plan file is null, not a thrown turn", () => {
  const ws = workspace();
  try {
    assert.equal(loadPlanForExit(".claudio/plans/gone.md", ws), null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a windows-style path from the extension still resolves", () => {
  // The header is written by the extension, which may hand back a path with
  // backslashes on Windows.
  const ws = workspace();
  try {
    assert.match(loadPlanForExit(".claudio\\plans\\p.md", ws) ?? "", /do the thing/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Putting it in front of the model
// ─────────────────────────────────────────────────────────────────────────────

const PLAN = "# Plan\n1. do the thing\n";

test("the plan goes in front of the last user message", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "do it" },
  ];

  const injected = injectPlanIntoLastUserMessage(messages, PLAN, ".claudio/plans/p.md");

  assert.equal(injected, true);
  assert.match(messages[2].content as string, /do the thing[\s\S]*do it/);
  assert.equal(messages[0].content, "first", "an earlier turn was rewritten");
});

test("the model is told the plan was approved and is to be carried out", () => {
  // Without this the model reads a plan and explains it back — measured against
  // the live model on 2026-08-27, which restated the plan and changed nothing.
  const messages = [{ role: "user", content: "do it" }];

  injectPlanIntoLastUserMessage(messages, PLAN, ".claudio/plans/p.md");

  assert.match(messages[0].content as string, /approved/i);
  assert.match(messages[0].content as string, /execute|carry out|now/i);
});

test("the plan's own path is named, so the model can re-read or update it", () => {
  const messages = [{ role: "user", content: "do it" }];

  injectPlanIntoLastUserMessage(messages, PLAN, ".claudio/plans/p.md");

  assert.match(messages[0].content as string, /\.claudio\/plans\/p\.md/);
});

test("a message made of content blocks is injected too, not skipped", () => {
  // Claudio sends an array whenever the message carries an attachment. Handling
  // only the string case means "approve the plan while a file is attached"
  // silently runs the turn with no plan at all.
  const messages = [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "do it" },
    ],
  }];

  const injected = injectPlanIntoLastUserMessage(messages as any, PLAN, ".claudio/plans/p.md");

  assert.equal(injected, true);
  const blocks = messages[0].content as any[];
  assert.equal(blocks.length, 2, "a block was added or lost");
  assert.equal(blocks[0].type, "image", "the attachment was disturbed");
  assert.match(blocks[1].text, /do the thing[\s\S]*do it/);
});

test("a block array with no text block gains one rather than losing the plan", () => {
  const messages = [{
    role: "user",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
  }];

  const injected = injectPlanIntoLastUserMessage(messages as any, PLAN, ".claudio/plans/p.md");

  assert.equal(injected, true);
  const blocks = messages[0].content as any[];
  assert.equal(blocks.length, 2);
  assert.match(blocks.find((b) => b.type === "text").text, /do the thing/);
});

test("nothing is injected when the last message is not the user's", () => {
  // Then this is not a plan-exit turn at all, and rewriting an assistant turn
  // would corrupt the history.
  const messages = [{ role: "user", content: "do it" }, { role: "assistant", content: "ok" }];

  const injected = injectPlanIntoLastUserMessage(messages, PLAN, ".claudio/plans/p.md");

  assert.equal(injected, false);
  assert.equal(messages[1].content, "ok");
});

test("an empty conversation is not a crash", () => {
  assert.equal(injectPlanIntoLastUserMessage([], PLAN, ".claudio/plans/p.md"), false);
});
