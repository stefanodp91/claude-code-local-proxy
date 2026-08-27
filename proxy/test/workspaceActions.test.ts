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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { executeAction, safeResolvePath, savePlot, saveFigure, runShell, type ActionOutcome } from "../src/infrastructure/workspaceActions";
import { WorkspaceAction, type ActionArgs } from "../src/domain/entities/workspaceAction";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let ws: string;

beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "claudio-actions-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

/** Run an action against the temp workspace and read the text it produced. */
async function run(args: Partial<ActionArgs>): Promise<string> {
  return (await runOutcome(args)).text;
}

/** The full outcome — text plus any image. */
function runOutcome(args: Partial<ActionArgs>): Promise<ActionOutcome> {
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

test("`**/` matches a file in the root as well as one in a subdirectory", async () => {
  // Found by watching the model work: it asked for `**/util.js`, got "(no files
  // matched)" for a file sitting in the workspace root, concluded the file did
  // not exist and wrote its answer around a guess. In every glob convention it
  // knows, `**/` means "zero or more directories" — including none.
  put("util.js", "");
  put("src/util.js", "");

  const out = await run({ action: WorkspaceAction.Glob, pattern: "**/util.js" });

  assert.match(out, /^util\.js$/m, "the file in the root was missed");
  assert.match(out, /src\/util\.js/);
});

test("`**/*.ts` reaches the root too", async () => {
  put("a.ts", "");
  put("deep/nested/b.ts", "");

  const out = await run({ action: WorkspaceAction.Glob, pattern: "**/*.ts" });

  assert.match(out, /^a\.ts$/m);
  assert.match(out, /deep\/nested\/b\.ts/);
});

test("a pattern without `**` still stays in the root", async () => {
  // The other half of the rule: fixing `**/` must not turn `*.ts` into a
  // recursive search, or every listing becomes the whole tree.
  put("a.ts", "");
  put("src/b.ts", "");

  const out = await run({ action: WorkspaceAction.Glob, pattern: "*.ts" });

  assert.match(out, /a\.ts/);
  assert.equal(out.includes("src/b.ts"), false, "a single star crossed a directory boundary");
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

test("an edit that would change nothing is refused, not reported as done", async () => {
  // Seen in the wild on Path B, 2026-08-27. The tag parser stops attributes at
  // the first double quote, so `old_string="const label = \"hello world\""`
  // arrives truncated to `const label = ` — and so does new_string. The two are
  // then identical, `replace()` writes the file back unchanged, the action
  // answers "Replaced 1 occurrence", and the model tells the user the edit
  // landed. It did not. A write path that reports success while changing
  // nothing is the worst shape a failure takes here.
  put("quoted.ts", 'const label = "hello world";\n');

  const out = await run({
    action: WorkspaceAction.Edit,
    path: "quoted.ts",
    old_string: "const label = ",
    new_string: "const label = ",
  });

  assert.match(out, /identical|nothing to replace|no changes/i);
  assert.equal(readFileSync(join(ws, "quoted.ts"), "utf-8"), 'const label = "hello world";\n');
});

test("an ordinary edit still reports what it did", async () => {
  // The guard must not swallow the normal case.
  put("a.ts", "const x = 1;\n");

  const out = await run({
    action: WorkspaceAction.Edit, path: "a.ts", old_string: "1", new_string: "2",
  });

  assert.match(out, /Replaced 1 occurrence/);
  assert.equal(readFileSync(join(ws, "a.ts"), "utf-8"), "const x = 2;\n");
});

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

test("bash does not block the event loop while it runs", async () => {
  // The property, stated as a property: with `spawnSync` this timer cannot
  // fire, because nothing else in the process runs until the command exits.
  // Every other bash test passes either way, which is why this one exists.
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);

  try {
    await run({ action: WorkspaceAction.Bash, cmd: "sleep 0.4" });
  } finally {
    clearInterval(timer);
  }

  assert.equal(ticks >= 5, true, `the event loop was blocked — only ${ticks} tick(s) in 400 ms`);
});

test("a command that outruns its timeout is killed and says so", async () => {
  // 30 s is the shipped ceiling and no test can wait for it, so the timeout is
  // a parameter here. Without a kill the promise never settles and the turn
  // hangs — the worst shape this failure could take.
  const started = Date.now();
  const out = await runShell("sleep 5", ws, 150);

  assert.match(out, /timed out after/);
  assert.equal(Date.now() - started < 3_000, true, "it waited for the command instead of killing it");
});

test("output past the cap is truncated, and says it was", async () => {
  // `spawn` has no maxBuffer: unbounded output is now this code's problem, and
  // an 8 000-character promise is what the model can actually read.
  const out = await run({ action: WorkspaceAction.Bash, cmd: "seq 1 200000" });

  assert.match(out, /output truncated/);
  assert.equal(out.length < 9_000, true, `truncation let ${out.length} chars through`);
});

// ─────────────────────────────────────────────────────────────────────────────
// executeAction never throws
// ─────────────────────────────────────────────────────────────────────────────

test("an unknown action lists the ones that exist", async () => {
  const out = await run({ action: "teleport" });

  assert.match(out, /unknown action 'teleport'/);
  assert.match(out, /read/, "the model needs to be told what it may use instead");
});

test("every failure comes back as text the model can act on", async () => {
  // The contract executeAction documents. A throw here propagates into the
  // agent loop and ends the turn, where text is just another observation.
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
    const out = await runOutcome(args);
    assert.equal(typeof out.text, "string", `${JSON.stringify(args)} did not return text`);
    assert.equal(out.image, undefined, `${JSON.stringify(args)} produced an image`);
  }
});

test("an action that draws nothing carries no image", async () => {
  // The picture is the exception, not the shape of every result: only a python
  // figure sets it, and a caller that finds one attaches it to the model.
  put("a.txt", "hello");

  const out = await runOutcome({ action: WorkspaceAction.Read, path: "a.txt" });

  assert.equal(out.text, "hello");
  assert.equal(out.image, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Saving a figure
//
// A plot the model can see is still a plot the user cannot: the image travels
// inside the conversation, not to the screen. Writing it into the workspace is
// what puts it somewhere a person can open — and it is a file write, so it is
// contained and it reports its own failures rather than swallowing them.
// ─────────────────────────────────────────────────────────────────────────────

const PNG_BASE64 = Buffer.from("not really a png, but bytes are bytes").toString("base64");

test("a figure is written under the configured directory", () => {
  const out = savePlot(PNG_BASE64, ws, ".claudio/plots");

  assert.equal("error" in out, false, `savePlot failed: ${(out as any).error}`);
  const { relPath } = out as { relPath: string };
  assert.match(relPath, /^\.claudio\/plots\/plot-\d{8}-\d{6}(-\d+)?\.png$/);
  assert.equal(
    readFileSync(join(ws, relPath)).toString("base64"),
    PNG_BASE64,
    "the bytes on disk are not the bytes that came back from python",
  );
});

test("a second figure does not overwrite the first", () => {
  // Two plots in the same second is the ordinary case: the model draws, looks,
  // redraws. A name derived from the clock alone would lose the first one.
  const a = savePlot(PNG_BASE64, ws, ".claudio/plots") as { relPath: string };
  const b = savePlot(PNG_BASE64, ws, ".claudio/plots") as { relPath: string };

  assert.notEqual(a.relPath, b.relPath);
  assert.equal(existsSync(join(ws, a.relPath)), true);
  assert.equal(existsSync(join(ws, b.relPath)), true);
});

test("a plot directory outside the workspace is refused", () => {
  // The same containment every other write goes through. A misconfigured
  // PYTHON_PLOT_DIR must not be a way out of the workspace.
  //
  // The escape target is named after this workspace: `ws` sits in the shared
  // temp directory, so a fixed name would be a file one run leaves behind and
  // the next one trips over — including the run that reintroduces the bug on
  // purpose, which is exactly when the mess gets made.
  const escape = `../escaped-${basename(ws)}`;

  const out = savePlot(PNG_BASE64, ws, escape);

  assert.equal("error" in out, true, "an escaping plot directory was accepted");
  assert.equal(existsSync(join(ws, escape)), false);
});

test("a directory that cannot be created comes back as an error, not a throw", () => {
  // A file where the directory should be. The figure is lost; the turn is not.
  put(".claudio/plots", "i am a file");

  const out = savePlot(PNG_BASE64, ws, ".claudio/plots");

  assert.equal("error" in out, true);
  assert.match((out as { error: string }).error, /.+/, "the failure came back with no reason");
});

test("a figure that cannot be saved says so, and is still shown to the model", async () => {
  // Losing the file is a small failure; losing it quietly is the failure this
  // project is made of. The image must survive it either way.
  put(".claudio/plots", "i am a file");

  const { image, error } = saveFigure(PNG_BASE64, ws, ".claudio/plots");

  assert.match(error ?? "", /.+/, "the figure vanished without a word");
  assert.equal(image.data, PNG_BASE64);
  assert.equal(image.savedPath, undefined);
});

test("saving disabled means no path and no complaint", async () => {
  // An empty PYTHON_PLOT_DIR is a choice, not a failure.
  const { image, error } = saveFigure(PNG_BASE64, ws, "");

  assert.equal(error, undefined);
  assert.equal(image.savedPath, undefined);
  assert.equal(image.data, PNG_BASE64);
});
