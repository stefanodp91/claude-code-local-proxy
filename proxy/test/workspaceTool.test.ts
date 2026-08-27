/**
 * workspaceTool.test.ts — the static snapshot Path B leans on.
 *
 * When the model cannot call tools, this summary is *all* it knows about the
 * workspace: the top-level listing, what `package.json` calls the project, and
 * the start of the README, injected into every system prompt of the turn. A
 * summary that quietly comes back empty does not fail anything — it produces a
 * model that answers about a project it cannot see, confidently.
 *
 * So the properties under test are "it says what is there" and, just as much,
 * "it says so when it cannot".
 *
 * @module test/workspaceTool
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceContextSummary } from "../src/application/workspaceTool";

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "claudio-wstool-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

const put = (rel: string, content: string) => {
  const full = join(ws, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
};

// ─────────────────────────────────────────────────────────────────────────────
// What it can see
// ─────────────────────────────────────────────────────────────────────────────

test("the top level is listed, with directories marked as such", async () => {
  put("index.ts", "");
  mkdirSync(join(ws, "src"));

  const summary = buildWorkspaceContextSummary(ws);

  assert.match(summary, /\[file\] index\.ts/);
  assert.match(summary, /\[dir\] src/);
});

test("package.json is read for what the project calls itself", async () => {
  put("package.json", JSON.stringify({ name: "demo", description: "a demo project" }));

  const summary = buildWorkspaceContextSummary(ws);

  assert.match(summary, /name="demo"/);
  assert.match(summary, /description="a demo project"/);
});

test("a monorepo says it is one", async () => {
  // `workspaces` changes where the model should look for code, so it is worth
  // the two lines it costs.
  put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));

  assert.match(buildWorkspaceContextSummary(ws), /workspaces:.*packages\/\*/);
});

test("the README is included, and a long one is cut with a marker", async () => {
  put("README.md", "# demo\n" + "x".repeat(5_000));

  const summary = buildWorkspaceContextSummary(ws);

  assert.match(summary, /# demo/);
  assert.match(summary, /\[truncated\]/);
  assert.equal(summary.length < 3_000, true, `the summary was ${summary.length} chars`);
});

test("a lowercase readme.md is found too", async () => {
  put("readme.md", "# lowercase");

  assert.match(buildWorkspaceContextSummary(ws), /# lowercase/);
});

// ─────────────────────────────────────────────────────────────────────────────
// What it cannot see, and says so
// ─────────────────────────────────────────────────────────────────────────────

test("a workspace that cannot be listed says so rather than coming back empty", async () => {
  // The failure this guards: an unreadable or missing root produced an empty
  // string, which is injected into the prompt as nothing at all. The model is
  // then told about a workspace it was never shown, and answers anyway.
  const summary = buildWorkspaceContextSummary(join(ws, "does-not-exist"));

  assert.notEqual(summary.trim(), "");
  assert.match(summary, /could not|unavailable|unreadable/i);
});

test("a malformed package.json does not cost the rest of the summary", async () => {
  put("package.json", "{ not json");
  put("index.ts", "");

  const summary = buildWorkspaceContextSummary(ws);

  assert.match(summary, /\[file\] index\.ts/);
});

test("no package.json and no README is still a useful summary", async () => {
  put("main.py", "");

  const summary = buildWorkspaceContextSummary(ws);

  assert.match(summary, /\[file\] main\.py/);
  assert.equal(summary.includes("package.json:"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// What it costs
// ─────────────────────────────────────────────────────────────────────────────

test("a crowded top level is capped, and says how much it left out", async () => {
  // This goes into every system prompt of a Path B turn, and the context window
  // is the scarce resource in this project. An uncapped listing of a directory
  // with hundreds of entries spends the conversation's budget on file names.
  for (let i = 0; i < 500; i++) put(`file-${i}.txt`, "");

  const summary = buildWorkspaceContextSummary(ws);

  assert.match(summary, /more entr/i);
  assert.equal(summary.length < 6_000, true, `the listing alone was ${summary.length} chars`);
});
