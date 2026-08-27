/**
 * todo.test.ts — the list the model keeps for itself.
 *
 * A 27B model loses the thread on a long task: it does three of five steps, then
 * answers as if it had done all five. A todo list is the cheapest fix — not
 * because the model needs a UI, but because writing the plan down and reading it
 * back next turn is what keeps the fourth step from vanishing.
 *
 * Two decisions in it are worth pinning:
 *
 *   - **The action takes no path.** It writes one configured file inside
 *     `.claudio/` and nothing else, which is what makes it safe to auto-approve.
 *     A `todo` that could name its target would be a `write` without a modal.
 *   - **An empty list injects nothing.** Same rule as memory: an empty heading
 *     costs tokens on every request of the turn and teaches the model nothing,
 *     and on these models the context window is the scarce resource.
 *
 * @module test/todo
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { executeAction } from "../src/infrastructure/workspaceActions";
import { FsWorkspaceFileRepository } from "../src/infrastructure/adapters/fsWorkspaceFileRepository";
import { WorkspaceAction, ACTION_CLASSIFICATION, ActionClass, type ActionArgs } from "../src/domain/entities/workspaceAction";

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "claudio-todo-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

const TODO = ".claudio/TODO.md";

const run = (args: Partial<ActionArgs>, todoFile = TODO) =>
  executeAction(args as ActionArgs, ws, { todoFile });

const onDisk = () => readFileSync(join(ws, TODO), "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// Keeping the list
// ─────────────────────────────────────────────────────────────────────────────

test("the list is written where the prompt says it lives", async () => {
  const out = await run({
    action: WorkspaceAction.Todo,
    content: "- [x] read the file\n- [ ] change it\n- [ ] run the tests\n",
  });

  assert.match(onDisk(), /change it/);
  assert.match(out.text, /todo/i);
});

test("writing the list creates the directory it lives in", async () => {
  // First use in a fresh workspace: `.claudio/` does not exist yet.
  await run({ action: WorkspaceAction.Todo, content: "- [ ] first" });

  assert.equal(existsSync(join(ws, TODO)), true);
});

test("the list is replaced, not appended to", async () => {
  // The model rewrites the whole list each time — that is how it thinks about
  // it, and appending would grow a file nobody prunes.
  await run({ action: WorkspaceAction.Todo, content: "- [ ] one" });
  await run({ action: WorkspaceAction.Todo, content: "- [x] one\n- [ ] two" });

  assert.equal(onDisk().includes("- [ ] one\n- [x] one"), false);
  assert.match(onDisk(), /- \[x\] one\n- \[ \] two/);
});

test("the model is told what it now has, without being sent the list back", async () => {
  // Echoing the whole list into the tool result doubles its cost on every
  // update, and the model has just written it — it knows.
  const out = await run({
    action: WorkspaceAction.Todo,
    content: "- [x] a\n- [ ] b\n- [ ] c",
  });

  assert.match(out.text, /3/, "the model should be told how many items it has");
  assert.equal(out.text.includes("- [ ] b"), false, "the list was echoed back");
});

test("a todo with no content is an error, not an emptied list", async () => {
  // A model that calls the action wrongly must not wipe the list it was keeping.
  await run({ action: WorkspaceAction.Todo, content: "- [ ] keep me" });

  const out = await run({ action: WorkspaceAction.Todo });

  assert.match(out.text, /required/i);
  assert.match(onDisk(), /keep me/);
});

test("with the list switched off the action says so and writes nothing", async () => {
  // `TODO_FILE=""` disables it, the way `MEMORY_FILE=""` disables memory.
  const out = await run({ action: WorkspaceAction.Todo, content: "- [ ] x" }, "");

  assert.match(out.text, /disabled|not enabled/i);
  assert.equal(existsSync(join(ws, ".claudio")), false);
});

test("a todo file configured outside the workspace is refused", async () => {
  // Named after this workspace, because `ws` lives in the shared temp directory:
  // a fixed name is a file the *negative control* leaves behind — the control
  // removes the containment check, so it really does write there — and every
  // later run then trips over it. Second time in this repo; the first was the
  // same test for the plot directory.
  const escape = `../escape-${basename(ws)}.md`;

  const out = await run({ action: WorkspaceAction.Todo, content: "- [ ] x" }, escape);

  assert.match(out.text, /Error/);
  assert.equal(existsSync(join(ws, escape)), false);
});

test("the action carries no path, which is why it needs no approval", async () => {
  // The safety argument, as an assertion rather than a comment: it writes one
  // configured file and cannot be pointed anywhere else, so it is auto-approved
  // like a read. If it ever grows a `path`, this test is the thing that should
  // stop it.
  assert.equal(ACTION_CLASSIFICATION[WorkspaceAction.Todo], ActionClass.ReadOnly);

  const out = await run({
    action: WorkspaceAction.Todo,
    content: "- [ ] x",
    path: "../../etc/passwd",
  } as Partial<ActionArgs>);

  assert.match(onDisk(), /- \[ \] x/, "the list did not go where it belongs");
  assert.equal(existsSync(join(ws, "..", "..", "etc", "passwd")), false);
  assert.equal(out.text.includes("passwd"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Reading it back
// ─────────────────────────────────────────────────────────────────────────────

const repo = (rel = TODO, max = 4_000) => new FsWorkspaceFileRepository(rel, max);

test("the list comes back for the next turn's prompt", async () => {
  mkdirSync(join(ws, ".claudio"), { recursive: true });
  writeFileSync(join(ws, TODO), "- [ ] still to do\n");

  assert.match(repo().load(ws) ?? "", /still to do/);
});

test("no list means nothing to inject, not an empty heading", async () => {
  assert.equal(repo().load(ws), null);
});

test("a list of whitespace is no list", async () => {
  mkdirSync(join(ws, ".claudio"), { recursive: true });
  writeFileSync(join(ws, TODO), "   \n\n");

  assert.equal(repo().load(ws), null);
});

test("a list that has grown too long is truncated, not dropped", async () => {
  // It goes into every request of the turn. A model that pasted a file into its
  // own todo list must not push the conversation out of the window.
  mkdirSync(join(ws, ".claudio"), { recursive: true });
  writeFileSync(join(ws, TODO), "x".repeat(9_000));

  const loaded = repo(TODO, 4_000).load(ws) ?? "";

  assert.equal(loaded.length < 4_200, true, `it injected ${loaded.length} characters`);
  assert.match(loaded, /truncated/i);
});

test("a configured path outside the workspace loads nothing", async () => {
  assert.equal(repo("../../secrets.md").load(ws), null);
});
