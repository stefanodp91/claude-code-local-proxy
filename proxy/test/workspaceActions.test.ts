/**
 * workspaceActions.test.ts — the filesystem and shell backend.
 *
 * Where the model's intentions become changes on disk. Two properties carry
 * most of the weight:
 *
 *   - `safeResolvePath()` is the real containment boundary. Two *other* places
 *     in this codebase got that check wrong (the approval gate and the diff
 *     preview, both fixed on this branch) and both times this one was right.
 *     Nothing pinned it, which is the only reason to be nervous about it.
 *   - `executeAction()` promises never to throw. Every failure is a string the
 *     model reads and can react to. A thrown error instead takes down the turn.
 *
 * Real temporary directories throughout. The point of these functions is
 * touching the filesystem, and a fake one would test the fake.
 *
 * @module test/workspaceActions
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAction, safeResolvePath } from "../src/infrastructure/workspaceActions";
import { WorkspaceAction, type ActionArgs } from "../src/domain/entities/workspaceAction";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let ws: string;

beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "claudio-actions-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

/** Run an action against the temp workspace. */
function run(args: Partial<ActionArgs>): Promise<string> {
  return executeAction(args as ActionArgs, ws);
}

function put(relPath: string, content: string) {
  const full = join(ws, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

const read = (relPath: string) => readFileSync(join(ws, relPath), "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// safeResolvePath — the containment boundary
// ─────────────────────────────────────────────────────────────────────────────

test("a path inside the workspace resolves", () => {
  assert.equal(safeResolvePath("src/a.ts", ws), join(ws, "src/a.ts"));
});

test("the workspace root itself resolves", () => {
  assert.equal(safeResolvePath(".", ws), ws);
});

test("an absolute path is refused before it is resolved", () => {
  assert.equal(safeResolvePath("/etc/passwd", ws), null);
});

test("a home-relative path is refused", () => {
  assert.equal(safeResolvePath("~/.ssh/id_rsa", ws), null);
});

test("climbing out of the workspace is refused", () => {
  assert.equal(safeResolvePath("../../etc/passwd", ws), null);
  assert.equal(safeResolvePath("src/../../outside.txt", ws), null);
});

test("a sibling directory sharing the workspace's prefix is outside it", () => {
  // The check other places in this codebase got wrong twice: `startsWith(cwd)`
  // without the separator accepts `/tmp/ws-evil` for a workspace at `/tmp/ws`.
  // This one appends the separator and is correct — pinned so it stays that way.
  assert.equal(safeResolvePath(`../${ws.split("/").pop()}-evil/secrets`, ws), null);
});

test("a trailing slash on the workspace root does not lock the model out", () => {
  // The root arrives from the X-Workspace-Root header. `resolved.startsWith(cwd + "/")`
  // compares against `/ws//` when the caller sends `/ws/`, so every path in the
  // workspace reads as an escape and every action fails with "outside the
  // workspace root" — a total, and totally confusing, failure.
  assert.equal(safeResolvePath("src/a.ts", `${ws}/`), join(ws, "src/a.ts"));
});

// ─────────────────────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────────────────────

test("list puts directories first, then files, alphabetically", () => {
  put("b.ts", ""); put("a.ts", ""); mkdirSync(join(ws, "zdir")); mkdirSync(join(ws, "adir"));

  return run({ action: WorkspaceAction.List }).then((out) => {
    assert.deepEqual(out.split("\n"), ["[dir]  adir", "[dir]  zdir", "[file] a.ts", "[file] b.ts"]);
  });
});

test("an empty directory says so rather than returning nothing", async () => {
  assert.equal(await run({ action: WorkspaceAction.List }), "(empty directory)");
});

test("listing outside the workspace is an error the model can read", async () => {
  const out = await run({ action: WorkspaceAction.List, path: "../.." });
  assert.match(out, /outside the workspace root/);
});

// ─────────────────────────────────────────────────────────────────────────────
// read
// ─────────────────────────────────────────────────────────────────────────────

test("read returns the file", async () => {
  put("a.ts", "contents");
  assert.equal(await run({ action: WorkspaceAction.Read, path: "a.ts" }), "contents");
});

test("read on a directory points at list instead", async () => {
  mkdirSync(join(ws, "src"));
  assert.match(await run({ action: WorkspaceAction.Read, path: "src" }), /use action='list'/);
});

test("a missing file is an error, not an exception", async () => {
  assert.match(await run({ action: WorkspaceAction.Read, path: "nope.ts" }), /cannot access/);
});

test("read without a path says which argument is missing", async () => {
  assert.match(await run({ action: WorkspaceAction.Read }), /'path' is required/);
});

test("a large file is truncated and says where", async () => {
  put("big.ts", "z".repeat(60_000));
  const out = await run({ action: WorkspaceAction.Read, path: "big.ts" });

  assert.equal(out.length < 60_000, true);
  assert.match(out, /\[file truncated at 50000 bytes\]$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// write
// ─────────────────────────────────────────────────────────────────────────────

test("write creates the file and any missing parent directories", async () => {
  const out = await run({ action: WorkspaceAction.Write, path: "src/deep/a.ts", content: "hello" });

  assert.equal(read("src/deep/a.ts"), "hello");
  assert.match(out, /Written 5 chars/);
});

test("write refuses to leave the workspace", async () => {
  const out = await run({ action: WorkspaceAction.Write, path: "../escape.ts", content: "x" });
  assert.match(out, /outside the workspace root/);
});

test("write with no content is refused rather than truncating the file", async () => {
  put("a.ts", "keep me");
  assert.match(await run({ action: WorkspaceAction.Write, path: "a.ts" }), /'content' is required/);
  assert.equal(read("a.ts"), "keep me");
});

// ─────────────────────────────────────────────────────────────────────────────
// edit
// ─────────────────────────────────────────────────────────────────────────────

test("edit replaces the first occurrence only", async () => {
  put("a.ts", "x = 1; x = 2;");
  const out = await run({ action: WorkspaceAction.Edit, path: "a.ts", old_string: "x", new_string: "y" });

  assert.equal(read("a.ts"), "y = 1; x = 2;");
  assert.match(out, /Replaced 1 occurrence/);
});

test("edit leaves the file alone when old_string is not there", async () => {
  put("a.ts", "original");
  const out = await run({ action: WorkspaceAction.Edit, path: "a.ts", old_string: "absent", new_string: "y" });

  assert.equal(read("a.ts"), "original");
  assert.match(out, /not found .* no changes made/);
});

test("a dollar sign in the replacement stays a dollar sign", async () => {
  // String.prototype.replace treats $$, $&, $` and $' in the *replacement* as
  // patterns, so an edit that inserts shell or Makefile text silently wrote
  // something other than what the model asked for: "$$" collapsed to "$",
  // "$&" expanded to the text being replaced, "$'" to everything after it.
  // Nothing errors — the file is simply wrong, and the model is told the edit
  // succeeded.
  put("Makefile", "\tPID=PLACEHOLDER\n");
  await run({
    action: WorkspaceAction.Edit,
    path: "Makefile",
    old_string: "PLACEHOLDER",
    new_string: "$$(echo $&)",
  });

  assert.equal(read("Makefile"), "\tPID=$$(echo $&)\n");
});

test("edit reports which argument is missing", async () => {
  put("a.ts", "x");
  assert.match(await run({ action: WorkspaceAction.Edit, path: "a.ts", new_string: "y" }), /'old_string' is required/);
  assert.match(await run({ action: WorkspaceAction.Edit, path: "a.ts", old_string: "x" }), /'new_string' is required/);
});

test("an edit that deletes text is a normal edit", async () => {
  put("a.ts", "keep DROP keep");
  await run({ action: WorkspaceAction.Edit, path: "a.ts", old_string: " DROP", new_string: "" });
  assert.equal(read("a.ts"), "keep keep");
});

// ─────────────────────────────────────────────────────────────────────────────
// grep and glob
// ─────────────────────────────────────────────────────────────────────────────

test("grep reports file and line for each hit", async () => {
  put("src/a.ts", "one\nTARGET\nthree");
  const out = await run({ action: WorkspaceAction.Grep, pattern: "TARGET" });

  assert.match(out, /a\.ts/);
  assert.match(out, /2/);
});

test("grep says plainly when it finds nothing", async () => {
  put("a.ts", "nothing here");
  const out = await run({ action: WorkspaceAction.Grep, pattern: "ABSENT_NEEDLE" });

  assert.equal(/ABSENT_NEEDLE/.test(out) || /no match/i.test(out), true, `unhelpful: ${out}`);
});

test("glob walks subdirectories", async () => {
  put("src/deep/a.ts", ""); put("src/b.ts", ""); put("c.js", "");
  const out = await run({ action: WorkspaceAction.Glob, pattern: "**/*.ts" });

  assert.match(out, /a\.ts/);
  assert.match(out, /b\.ts/);
  assert.equal(out.includes("c.js"), false);
});

test("glob understands brace alternation", async () => {
  put("a.ts", ""); put("b.js", ""); put("c.md", "");
  const out = await run({ action: WorkspaceAction.Glob, pattern: "*.{ts,js}" });

  assert.match(out, /a\.ts/);
  assert.match(out, /b\.js/);
  assert.equal(out.includes("c.md"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// bash
// ─────────────────────────────────────────────────────────────────────────────

test("bash runs in the workspace root", async () => {
  put("marker.txt", "");
  assert.match(await run({ action: WorkspaceAction.Bash, cmd: "ls" }), /marker\.txt/);
});

test("stderr is labelled, not merged into stdout", async () => {
  const out = await run({ action: WorkspaceAction.Bash, cmd: "echo out; echo err >&2" });

  assert.match(out, /out/);
  assert.match(out, /\[stderr\]\nerr/);
});

test("a non-zero exit code is reported", async () => {
  assert.match(await run({ action: WorkspaceAction.Bash, cmd: "exit 3" }), /exit code 3/);
});

test("a silent success says so rather than returning nothing", async () => {
  assert.equal(await run({ action: WorkspaceAction.Bash, cmd: "true" }), "(no output)");
});

test("bash without a command is an error", async () => {
  assert.match(await run({ action: WorkspaceAction.Bash }), /'cmd' is required/);
});

// ─────────────────────────────────────────────────────────────────────────────
// executeAction never throws
// ─────────────────────────────────────────────────────────────────────────────

test("an unknown action lists the ones that exist", async () => {
  const out = await run({ action: "teleport" });

  assert.match(out, /unknown action 'teleport'/);
  assert.match(out, /read/, "the model needs to be told what it may use instead");
});

test("every failure comes back as a string the model can act on", async () => {
  // The contract executeAction documents. A throw here propagates into the
  // agent loop and ends the turn, where a string is just another observation.
  const attempts: Partial<ActionArgs>[] = [
    { action: WorkspaceAction.Read, path: "missing" },
    { action: WorkspaceAction.Read, path: "/etc/passwd" },
    { action: WorkspaceAction.Edit, path: "missing", old_string: "a", new_string: "b" },
    { action: WorkspaceAction.Write, path: "../out", content: "x" },
    { action: WorkspaceAction.Glob },
    { action: WorkspaceAction.Grep },
    { action: WorkspaceAction.List, path: "nope" },
    {},
  ];

  for (const args of attempts) {
    const out = await run(args);
    assert.equal(typeof out, "string", `${JSON.stringify(args)} did not return a string`);
  }
});
