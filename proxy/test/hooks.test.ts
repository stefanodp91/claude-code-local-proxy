/**
 * hooks.test.ts — user commands that run without asking.
 *
 * A hook is the one feature here whose *point* is to skip the approval modal:
 * lint after every write, run the tests after every edit. That is also what
 * makes it the most dangerous thing in the proxy, because a hook is a line in a
 * file, and files are what the model writes.
 *
 * So the trust rule, chosen deliberately and pinned here:
 *
 *   - hooks are **inert until the user trusts them once**, with the content
 *     shown, and any change to the file makes them inert again — the model's,
 *     a `git pull`'s, a colleague's;
 *   - the **trust record lives outside the workspace**, beside the proxy. If it
 *     sat in `.claudio/` the model could write it with `write` and trust itself,
 *     which would make the whole mechanism theatre;
 *   - a hook's output goes back to the model as an observation, because the
 *     point is to move deterministic work off the model and hand it the result.
 *
 * The case none of that is optional for: **a repository you clone can ship
 * hooks.** Without trust-on-change they would run on your first edit, and
 * nothing would have asked you anything.
 *
 * @module test/hooks
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsHooksRepository } from "../src/infrastructure/adapters/fsHooksRepository";
import { executeAction } from "../src/infrastructure/workspaceActions";
import { WorkspaceAction, type ActionArgs } from "../src/domain/entities/workspaceAction";

let ws: string;
let stateDir: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "claudio-hooks-"));
  stateDir = mkdtempSync(join(tmpdir(), "claudio-hooks-state-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

const HOOKS = ".claudio/hooks.json";
const trustFile = () => join(stateDir, "hooks-trust.json");

function writeHooks(hooks: Record<string, string[]>): void {
  mkdirSync(join(ws, ".claudio"), { recursive: true });
  writeFileSync(join(ws, HOOKS), JSON.stringify(hooks, null, 2));
}

const repo = () => new FsHooksRepository(HOOKS, trustFile());

const run = (args: Partial<ActionArgs>) =>
  executeAction(args as ActionArgs, ws, { hooksFile: HOOKS, hooksTrustFile: trustFile() });

// ─────────────────────────────────────────────────────────────────────────────
// Trust
// ─────────────────────────────────────────────────────────────────────────────

test("hooks that were never trusted do not run", async () => {
  // The clone case: someone else's repository, your machine, your first edit.
  writeHooks({ write: [`touch "${join(ws, "hook-ran")}"`] });

  const out = await run({ action: WorkspaceAction.Write, path: "a.txt", content: "x" });

  assert.equal(existsSync(join(ws, "hook-ran")), false, "an untrusted hook ran");
  assert.match(out.text, /hook/i, "the user was not told hooks exist and are inert");
});

test("once trusted, they run", async () => {
  writeHooks({ write: [`touch "${join(ws, "hook-ran")}"`] });
  repo().trust(ws);

  await run({ action: WorkspaceAction.Write, path: "a.txt", content: "x" });

  assert.equal(existsSync(join(ws, "hook-ran")), true);
});

test("changing the file makes them inert again", async () => {
  // The whole point of trusting the *content* rather than the path: a hooks
  // file that is edited after being trusted is a different hooks file.
  writeHooks({ write: ["true"] });
  repo().trust(ws);

  writeHooks({ write: [`touch "${join(ws, "sneaked-in")}"`] });
  const out = await run({ action: WorkspaceAction.Write, path: "a.txt", content: "x" });

  assert.equal(existsSync(join(ws, "sneaked-in")), false, "an edited hooks file kept its trust");
  assert.match(out.text, /changed|not trusted/i);
});

test("the trust record lives outside the workspace", async () => {
  // If it were inside, `write` could create it and the model could trust its
  // own hooks. This is the assertion that keeps the mechanism from being
  // theatre.
  writeHooks({ write: ["true"] });
  repo().trust(ws);

  assert.equal(existsSync(trustFile()), true);
  assert.equal(existsSync(join(ws, ".claudio", "hooks.trusted")), false);
  assert.equal(readFileSync(trustFile(), "utf-8").includes(ws), true, "keyed by workspace");
});

test("trusting one workspace does not trust another", async () => {
  writeHooks({ write: ["true"] });
  const other = mkdtempSync(join(tmpdir(), "claudio-hooks-other-"));
  try {
    mkdirSync(join(other, ".claudio"), { recursive: true });
    writeFileSync(join(other, HOOKS), JSON.stringify({ write: ["true"] }));
    repo().trust(ws);

    assert.equal(repo().status(other).trusted, false);
    assert.equal(repo().status(ws).trusted, true);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("a workspace with no hooks file is not a workspace with untrusted hooks", async () => {
  // Nothing to say, nothing to ask, no noise in the result.
  const out = await run({ action: WorkspaceAction.Write, path: "a.txt", content: "x" });

  assert.equal(out.text.includes("hook"), false);
  assert.equal(repo().status(ws).configured, false);
});

test("a malformed hooks file is reported, not silently ignored", async () => {
  // It is hand-written JSON. A typo must not mean "no hooks" without a word,
  // or the linter stops running and nobody knows why.
  mkdirSync(join(ws, ".claudio"), { recursive: true });
  writeFileSync(join(ws, HOOKS), "{ not json");

  const out = await run({ action: WorkspaceAction.Write, path: "a.txt", content: "x" });

  assert.match(out.text, /hooks.*(could not|invalid|unreadable)/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Running
// ─────────────────────────────────────────────────────────────────────────────

test("a hook's output comes back to the model", async () => {
  // The use case: the linter's complaint reaches the model, which fixes it next
  // turn without anyone typing anything.
  writeHooks({ write: ["echo 'lint: missing semicolon'"] });
  repo().trust(ws);

  const out = await run({ action: WorkspaceAction.Write, path: "a.txt", content: "x" });

  assert.match(out.text, /missing semicolon/);
  assert.match(out.text, /Written 1 chars/, "the action's own result must survive the hook's");
});

test("a hook that fails says so, and the write still happened", async () => {
  // Reporting the failure without lying about the file: it *was* written, and
  // telling a small model otherwise sends it rewriting in circles.
  writeHooks({ write: ["echo 'tests failed' >&2; exit 1"] });
  repo().trust(ws);

  const out = await run({ action: WorkspaceAction.Write, path: "a.txt", content: "x" });

  assert.match(out.text, /tests failed/);
  assert.equal(readFileSync(join(ws, "a.txt"), "utf-8"), "x");
});

test("the hook is told which file the action touched", async () => {
  writeHooks({ write: ['echo "touched:$CLAUDIO_PATH"'] });
  repo().trust(ws);

  const out = await run({ action: WorkspaceAction.Write, path: "src/a.txt", content: "x" });

  assert.match(out.text, /touched:src\/a\.txt/);
});

test("hooks are bound to the action that fired them", async () => {
  writeHooks({ edit: ["echo 'only after edit'"] });
  repo().trust(ws);

  const written = await run({ action: WorkspaceAction.Write, path: "a.txt", content: "one" });
  const edited = await run({
    action: WorkspaceAction.Edit, path: "a.txt", old_string: "one", new_string: "two",
  });

  assert.equal(written.text.includes("only after edit"), false);
  assert.match(edited.text, /only after edit/);
});

test("several hooks for one action all run, in order", async () => {
  writeHooks({ write: ["echo first", "echo second"] });
  repo().trust(ws);

  const out = await run({ action: WorkspaceAction.Write, path: "a.txt", content: "x" });

  assert.equal(out.text.indexOf("first") < out.text.indexOf("second"), true);
});

test("a failed action runs no hooks", async () => {
  // Nothing happened, so there is nothing to lint. A hook firing on a refused
  // write would run against a file that was never written.
  writeHooks({ write: [`touch "${join(ws, "hook-ran")}"`] });
  repo().trust(ws);

  await run({ action: WorkspaceAction.Write, path: "../outside.txt", content: "x" });

  assert.equal(existsSync(join(ws, "hook-ran")), false);
});

test("a hook that hangs does not hang the turn", async () => {
  // It is a user's command, and a user's command can be wrong. The turn belongs
  // to the conversation, not to the hook.
  writeHooks({ write: ["sleep 30"] });
  repo().trust(ws);
  const started = Date.now();

  const out = await run({ action: WorkspaceAction.Write, path: "a.txt", content: "x" });

  assert.equal(Date.now() - started < 20_000, true, "the hook was allowed to run to its end");
  assert.match(out.text, /timed out/i);
});
