/**
 * autoApproveConfig.test.ts — the allowlist predicate, and the diff-preview read.
 *
 * `.claudio/auto-approve.json` is the one file whose entire job is to say *less*
 * than "ask me every time". `checkAutoApprove()` is what reads it, and the
 * approval gate consults it before raising a modal — so anything that makes this
 * function answer `true` too readily removes a confirmation the user believes is
 * still there. Nothing downstream notices: the action simply runs.
 *
 * The gate's own suite replaces this function with a fake, which is why it went
 * uncovered while the gate around it did not.
 *
 * These tests use a real temporary directory rather than a filesystem port. The
 * function's whole purpose is reading a file from a known location, and stubbing
 * that away would leave the part worth testing untested. It costs a few
 * milliseconds and no network.
 *
 * @module test/autoApproveConfig
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAutoApprove, loadOldContent } from "../src/infrastructure/adapters/autoApproveConfig";
import { WorkspaceAction, type ActionArgs } from "../src/domain/entities/workspaceAction";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let ws: string;

beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "claudio-allowlist-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

/** Write `.claudio/auto-approve.json`. A string is written verbatim, for the malformed cases. */
function allowlist(content: unknown) {
  mkdirSync(join(ws, ".claudio"), { recursive: true });
  writeFileSync(
    join(ws, ".claudio", "auto-approve.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

const args = (a: Partial<ActionArgs>) => a as ActionArgs;

const write = (path: string) => args({ action: WorkspaceAction.Write, path, content: "x" });
const bash = (cmd: string) => args({ action: WorkspaceAction.Bash, cmd });

// ─────────────────────────────────────────────────────────────────────────────
// Reading the file at all
// ─────────────────────────────────────────────────────────────────────────────

test("no allowlist means nothing is pre-approved", () => {
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("src/a.ts"), ws), false);
});

test("a malformed allowlist approves nothing rather than everything", () => {
  allowlist("{ rules: [ this is not json");
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("src/a.ts"), ws), false);
});

test("an allowlist with no rules key approves nothing", () => {
  allowlist({});
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("src/a.ts"), ws), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────────────────────

test("a rule only applies to the action it names", () => {
  allowlist({ rules: [{ action: "write", pathPattern: "^src/" }] });
  assert.equal(checkAutoApprove(WorkspaceAction.Edit, args({ action: WorkspaceAction.Edit, path: "src/a.ts" }), ws), false);
});

test("a matching path pattern pre-approves the write", () => {
  allowlist({ rules: [{ action: "write", pathPattern: "^src/generated/" }] });
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("src/generated/api.ts"), ws), true);
});

test("a path outside the pattern still asks", () => {
  allowlist({ rules: [{ action: "write", pathPattern: "^src/generated/" }] });
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("src/index.ts"), ws), false);
});

test("patterns are unanchored regexes, as written", () => {
  // Documented as a regex, so `src/` matches mid-path. Users who want the
  // anchor write the anchor — but it is worth pinning, because a rule that
  // reads like a prefix and behaves like a substring is how an allowlist
  // quietly grows.
  allowlist({ rules: [{ action: "write", pathPattern: "generated/" }] });
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("vendor/generated/x.ts"), ws), true);
});

test("a matching command pattern pre-approves the bash call", () => {
  allowlist({ rules: [{ action: "bash", cmdPattern: "^npm (test|run build)$" }] });
  assert.equal(checkAutoApprove(WorkspaceAction.Bash, bash("npm test"), ws), true);
  assert.equal(checkAutoApprove(WorkspaceAction.Bash, bash("npm publish"), ws), false);
});

test("a rule with no pattern is a deliberate blanket for that action", () => {
  // This one is intentional and must keep working: it is how a user says
  // "never ask me about python again".
  allowlist({ rules: [{ action: "python" }] });
  assert.equal(
    checkAutoApprove(WorkspaceAction.Python, args({ action: WorkspaceAction.Python, cmd: "print(1)" }), ws),
    true,
  );
});

test("any one matching rule is enough", () => {
  allowlist({ rules: [
    { action: "write", pathPattern: "^docs/" },
    { action: "write", pathPattern: "^src/generated/" },
  ] });
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("src/generated/api.ts"), ws), true);
});

test("when a rule states two patterns, both have to match", () => {
  allowlist({ rules: [{ action: "bash", pathPattern: "^scripts/", cmdPattern: "^sh " }] });

  assert.equal(
    checkAutoApprove(WorkspaceAction.Bash, args({ action: WorkspaceAction.Bash, path: "scripts/x.sh", cmd: "sh scripts/x.sh" }), ws),
    true,
  );
  assert.equal(
    checkAutoApprove(WorkspaceAction.Bash, args({ action: WorkspaceAction.Bash, path: "scripts/x.sh", cmd: "rm -rf ." }), ws),
    false,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// A constraint that cannot be checked must not be treated as satisfied
// ─────────────────────────────────────────────────────────────────────────────

test("a path pattern on an action that has no path does not approve it", () => {
  // The plausible config mistake: a path constraint written against `bash`,
  // which carries a command and never a path. Treating the unevaluable
  // constraint as satisfied turns "only under scripts/" into "every shell
  // command, no questions asked" — the exact opposite of what was written,
  // in the file whose only job is to be restrictive.
  allowlist({ rules: [{ action: "bash", pathPattern: "^scripts/" }] });
  assert.equal(checkAutoApprove(WorkspaceAction.Bash, bash("rm -rf /"), ws), false);
});

test("a command pattern on an action that has no command does not approve it", () => {
  allowlist({ rules: [{ action: "write", cmdPattern: "^npm " }] });
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("src/index.ts"), ws), false);
});

test("an unusable regex approves nothing and does not escape", () => {
  // The docstring promises to fail silently on a bad config. `new RegExp()`
  // sits outside the try that covers the read and the parse, so a typo in the
  // pattern threw straight through the approval gate and took the turn with it.
  allowlist({ rules: [{ action: "write", pathPattern: "[unclosed" }] });

  assert.doesNotThrow(() => checkAutoApprove(WorkspaceAction.Write, write("src/a.ts"), ws));
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("src/a.ts"), ws), false);
});

test("one broken rule does not disable the rules after it", () => {
  allowlist({ rules: [
    { action: "write", pathPattern: "[unclosed" },
    { action: "write", pathPattern: "^src/generated/" },
  ] });
  assert.equal(checkAutoApprove(WorkspaceAction.Write, write("src/generated/api.ts"), ws), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// loadOldContent — what the approval modal shows as the "before" side
// ─────────────────────────────────────────────────────────────────────────────

test("the previous contents of a write target are read for the diff", () => {
  writeFileSync(join(ws, "a.ts"), "before");
  assert.equal(loadOldContent(WorkspaceAction.Write, write("a.ts"), ws), "before");
});

test("a file that does not exist yet has no previous contents", () => {
  assert.equal(loadOldContent(WorkspaceAction.Write, write("new.ts"), ws), null);
});

test("only write actions have a before side", () => {
  writeFileSync(join(ws, "a.ts"), "before");
  assert.equal(loadOldContent(WorkspaceAction.Edit, args({ action: WorkspaceAction.Edit, path: "a.ts" }), ws), null);
  assert.equal(loadOldContent(WorkspaceAction.Bash, bash("ls"), ws), null);
});

test("with no workspace root nothing is read", () => {
  assert.equal(loadOldContent(WorkspaceAction.Write, write("a.ts"), undefined), null);
});

test("a path that climbs out of the workspace is not read", () => {
  assert.equal(loadOldContent(WorkspaceAction.Write, write("../../etc/hosts"), ws), null);
});

test("a sibling directory sharing the workspace's prefix is outside it", () => {
  // Same shape as the bug fixed in the approval gate: `startsWith(cwd)` accepts
  // `/tmp/ws-evil` for a workspace at `/tmp/ws`. Here it would put a file the
  // workspace has no claim on into the approval modal.
  const sibling = `${ws}-evil`;
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "secrets.txt"), "token");
  try {
    const escape = `../${ws.split("/").pop()}-evil/secrets.txt`;
    assert.equal(loadOldContent(WorkspaceAction.Write, write(escape), ws), null);
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
});

test("a very large file is truncated and says so", () => {
  writeFileSync(join(ws, "big.ts"), "y".repeat(60_000));
  const out = loadOldContent(WorkspaceAction.Write, write("big.ts"), ws)!;

  assert.equal(out.length < 60_000, true);
  assert.equal(out.endsWith("…[truncated]"), true);
});
