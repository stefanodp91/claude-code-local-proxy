/**
 * approvalGate.test.ts — Guards the only thing standing between a local model
 * and `write` / `edit` / `bash` / `python` on the user's filesystem.
 *
 * `ApprovalGateService.request()` is reached only for actions classified as
 * Destructive (both agent loops check `ACTION_CLASSIFICATION` first), and it
 * answers one question: ask the user, or decide without them. Five things can
 * short-circuit the prompt, and the order they are evaluated in is the whole
 * behaviour:
 *
 *   1. Plan mode      — plan-file writes pass, everything else is denied
 *   2. Auto mode      — everything passes
 *   3. Trusted files  — a previous `scope: "file"` grant on this exact path
 *   4. Allowlist      — `.claudio/auto-approve.json`
 *   5. otherwise      — delegate to the interactor (the modal)
 *
 * A bug anywhere in that chain is silent by construction: nothing downstream
 * reports "this should have asked and didn't". Which is why the suite leans on
 * asserting that the interactor was *not* consulted, as much as on the verdict.
 *
 * Note the split in how the two approval scopes are honoured, because it is not
 * obvious from this file alone: `scope: "file"` is persisted here, for the rest
 * of the session; `scope: "turn"` is handled by the callers
 * (`nativeAgentLoopService`, `textualAgentLoop`) in per-turn state, and this
 * service deliberately does nothing with it.
 *
 * @module test/approvalGate
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApprovalGateService } from "../src/application/services/approvalGateService";
import { AgentMode, ApprovalResult, ApprovalScope } from "../src/domain/types";
import { WorkspaceAction, type ActionArgs } from "../src/domain/entities/workspaceAction";
import type {
  ApprovalInteractorPort,
  ApprovalRequestParams,
  LoggerPort,
  PlanFileRepositoryPort,
  SseWriterPort,
} from "../src/domain/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const WS = "/ws";

/** What the fake user does when the modal appears. */
type Verdict = ApprovalResult;

const allow = (scope = ApprovalScope.Once): Verdict => ({ approved: true, scope });
const deny = (): Verdict => ({ approved: false, scope: ApprovalScope.Once });

interface Harness {
  gate: ApprovalGateService;
  /** Every prompt that reached the modal, in order. */
  readonly prompts: ApprovalRequestParams[];
  /** Replaces the fake user's next answer. */
  answerWith(v: Verdict): void;
  /** Paths the static allowlist approves. */
  readonly allowlisted: Set<string>;
}

/**
 * Builds a gate wired to fakes. Ports are interfaces, so these are object
 * literals rather than a mock framework — the point of having ports at all.
 */
function harness(): Harness {
  const prompts: ApprovalRequestParams[] = [];
  const allowlisted = new Set<string>();
  let verdict: Verdict = allow();

  const interactor: ApprovalInteractorPort = {
    async prompt(params) {
      prompts.push(params);
      return verdict;
    },
    resolve: () => true,
  };

  // Mirrors FsPlanFileRepository.isPlanPath for the default plans dir.
  const planFiles: PlanFileRepositoryPort = {
    plansDirRelative: ".claudio/plans",
    isPlanPath: (p) =>
      p.endsWith(".md") && (p.startsWith(".claudio/plans/") || p.includes("/.claudio/plans/")),
    buildRelPath: (f) => `.claudio/plans/${f}`,
    loadMostRecent: () => null,
  };

  const logger: LoggerPort = {
    info() {}, error() {}, warn() {}, dbg() {},
  } as unknown as LoggerPort;

  const gate = new ApprovalGateService(
    interactor,
    planFiles,
    logger,
    () => null,                                       // loadOldContent
    (_action, args) => typeof args.path === "string"  // isAutoApproved
      && allowlisted.has(args.path),
  );

  return {
    gate,
    prompts,
    allowlisted,
    answerWith(v) { verdict = v; },
  };
}

/** The gate never touches the writer; it only forwards it to the interactor. */
const writer = {} as SseWriterPort;

let h: Harness;
beforeEach(() => { h = harness(); });

/** One `request()` call, with the boilerplate collapsed. */
function ask(action: WorkspaceAction, args: ActionArgs, cwd: string = WS) {
  return h.gate.request(writer, action, args, cwd);
}

/**
 * The same, for a request that carries no workspace root — the CLI surface.
 * A separate helper on purpose: passing `undefined` to `ask()` would trigger
 * its default parameter and silently test the opposite case.
 */
function askWithoutWorkspace(action: WorkspaceAction, args: ActionArgs) {
  return h.gate.request(writer, action, args, undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan mode — the model may write its plan and nothing else
// ─────────────────────────────────────────────────────────────────────────────

test("plan mode lets the model write its plan without asking", async () => {
  h.gate.setAgentMode(AgentMode.Plan);

  const r = await ask(WorkspaceAction.Write, {
    action: WorkspaceAction.Write,
    path: ".claudio/plans/refactor.md",
    content: "# Plan",
  } as ActionArgs);

  assert.equal(r.approved, true);
  assert.equal(h.prompts.length, 0, "a plan write must not raise a modal");
});

test("plan mode denies a write outside the plans directory", async () => {
  h.gate.setAgentMode(AgentMode.Plan);

  const r = await ask(WorkspaceAction.Write, {
    action: WorkspaceAction.Write,
    path: "src/index.ts",
    content: "boom",
  } as ActionArgs);

  assert.equal(r.approved, false);
  assert.equal(h.prompts.length, 0, "plan mode denies outright, it does not ask");
});

test("plan mode denies bash even though it carries no path", async () => {
  h.gate.setAgentMode(AgentMode.Plan);

  const r = await ask(WorkspaceAction.Bash, {
    action: WorkspaceAction.Bash,
    cmd: "rm -rf .",
  } as ActionArgs);

  assert.equal(r.approved, false);
});

test("plan mode outranks the allowlist", async () => {
  // The allowlist would wave this through in ask mode. Plan mode is checked
  // first, so it must not: a plan run that quietly edits files is not a plan.
  h.allowlisted.add("src/index.ts");
  h.gate.setAgentMode(AgentMode.Plan);

  const r = await ask(WorkspaceAction.Edit, {
    action: WorkspaceAction.Edit,
    path: "src/index.ts",
  } as ActionArgs);

  assert.equal(r.approved, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto mode
// ─────────────────────────────────────────────────────────────────────────────

test("auto mode approves without consulting the user", async () => {
  h.gate.setAgentMode(AgentMode.Auto);
  h.answerWith(deny()); // would be denied if it ever reached the modal

  const r = await ask(WorkspaceAction.Bash, {
    action: WorkspaceAction.Bash,
    cmd: "npm test",
  } as ActionArgs);

  assert.equal(r.approved, true);
  assert.equal(h.prompts.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ask mode — delegation to the modal
// ─────────────────────────────────────────────────────────────────────────────

test("ask mode returns the user's verdict, both ways", async () => {
  h.answerWith(allow());
  assert.equal(
    (await ask(WorkspaceAction.Bash, { action: WorkspaceAction.Bash, cmd: "ls" } as ActionArgs)).approved,
    true,
  );

  h.answerWith(deny());
  assert.equal(
    (await ask(WorkspaceAction.Bash, { action: WorkspaceAction.Bash, cmd: "ls" } as ActionArgs)).approved,
    false,
  );

  assert.equal(h.prompts.length, 2, "every ungated action asks");
});

test("the modal is given the action, its arguments and the old content", async () => {
  // oldContent is what lets the client render a diff instead of a bare path.
  const gate = new ApprovalGateService(
    { async prompt(p) { seen = p; return allow(); }, resolve: () => true },
    { plansDirRelative: ".claudio/plans", isPlanPath: () => false, buildRelPath: (f) => f, loadMostRecent: () => null },
    { info() {}, error() {}, warn() {}, dbg() {} } as unknown as LoggerPort,
    () => "previous contents",
    () => false,
  );
  let seen: ApprovalRequestParams | undefined;

  await gate.request(writer, WorkspaceAction.Write, {
    action: WorkspaceAction.Write,
    path: "src/a.ts",
    content: "next",
  } as ActionArgs, WS);

  assert.equal(seen?.action, WorkspaceAction.Write);
  assert.equal(seen?.args.path, "src/a.ts");
  assert.equal(seen?.oldContent, "previous contents");
});

// ─────────────────────────────────────────────────────────────────────────────
// scope: "file" — the only grant this service persists
// ─────────────────────────────────────────────────────────────────────────────

test("a scope=file grant stops the same path asking again", async () => {
  const args = { action: WorkspaceAction.Write, path: "src/a.ts", content: "x" } as ActionArgs;

  h.answerWith(allow(ApprovalScope.File));
  assert.equal((await ask(WorkspaceAction.Write, args)).approved, true);

  h.answerWith(deny()); // proves the second call never reaches the modal
  assert.equal((await ask(WorkspaceAction.Write, args)).approved, true);
  assert.equal(h.prompts.length, 1);
});

test("a scope=file grant covers edit as well as write on that path", async () => {
  h.answerWith(allow(ApprovalScope.File));
  await ask(WorkspaceAction.Write, { action: WorkspaceAction.Write, path: "src/a.ts", content: "x" } as ActionArgs);

  h.answerWith(deny());
  const r = await ask(WorkspaceAction.Edit, { action: WorkspaceAction.Edit, path: "src/a.ts" } as ActionArgs);

  assert.equal(r.approved, true, "the grant is per path, not per action");
  assert.equal(h.prompts.length, 1);
});

test("a scope=file grant does not spill onto other paths", async () => {
  h.answerWith(allow(ApprovalScope.File));
  await ask(WorkspaceAction.Write, { action: WorkspaceAction.Write, path: "src/a.ts", content: "x" } as ActionArgs);

  h.answerWith(deny());
  const r = await ask(WorkspaceAction.Write, { action: WorkspaceAction.Write, path: "src/b.ts", content: "x" } as ActionArgs);

  assert.equal(r.approved, false);
  assert.equal(h.prompts.length, 2, "an unrelated file must still ask");
});

test("scope=once is not remembered", async () => {
  const args = { action: WorkspaceAction.Write, path: "src/a.ts", content: "x" } as ActionArgs;

  h.answerWith(allow(ApprovalScope.Once));
  await ask(WorkspaceAction.Write, args);

  h.answerWith(deny());
  const r = await ask(WorkspaceAction.Write, args);

  assert.equal(r.approved, false, "'just this once' must mean just this once");
  assert.equal(h.prompts.length, 2);
});

test("scope=file on a pathless action grants nothing", async () => {
  // bash carries a command, not a path — there is nothing to trust.
  h.answerWith(allow(ApprovalScope.File));
  await ask(WorkspaceAction.Bash, { action: WorkspaceAction.Bash, cmd: "ls" } as ActionArgs);

  h.answerWith(deny());
  const r = await ask(WorkspaceAction.Bash, { action: WorkspaceAction.Bash, cmd: "ls" } as ActionArgs);

  assert.equal(r.approved, false);
  assert.equal(h.prompts.length, 2);
});

test("scope=turn is left to the caller, not persisted here", async () => {
  // Both agent loops keep `allowAllThisTurn` in per-turn state. If this service
  // ever started persisting turn grants, they would outlive the turn.
  const args = { action: WorkspaceAction.Write, path: "src/a.ts", content: "x" } as ActionArgs;

  h.answerWith(allow(ApprovalScope.Turn));
  const first = await ask(WorkspaceAction.Write, args);
  assert.equal(first.scope, ApprovalScope.Turn, "the scope is passed back up for the loop to act on");

  h.answerWith(deny());
  assert.equal((await ask(WorkspaceAction.Write, args)).approved, false);
  assert.equal(h.prompts.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Workspace containment of the trusted-file grant
// ─────────────────────────────────────────────────────────────────────────────

test("a grant on a path that escapes the workspace is not remembered", async () => {
  const args = { action: WorkspaceAction.Write, path: "../outside/x.ts", content: "x" } as ActionArgs;

  h.answerWith(allow(ApprovalScope.File));
  await ask(WorkspaceAction.Write, args);

  h.answerWith(deny());
  assert.equal((await ask(WorkspaceAction.Write, args)).approved, false);
  assert.equal(h.prompts.length, 2);
});

test("a sibling directory sharing the workspace's prefix is outside it", async () => {
  // The regression: `full.startsWith("/ws")` accepts "/ws-evil/x.ts", so a
  // scope=file grant there was recorded as trusted for the whole session.
  // `safeResolvePath()` would still have refused the write, but the gate is
  // supposed to be honest on its own.
  const args = { action: WorkspaceAction.Write, path: "../ws-evil/x.ts", content: "x" } as ActionArgs;

  h.answerWith(allow(ApprovalScope.File));
  await ask(WorkspaceAction.Write, args);

  h.answerWith(deny());
  assert.equal((await ask(WorkspaceAction.Write, args)).approved, false);
  assert.equal(h.prompts.length, 2);
});

test("a trailing slash on the workspace root changes nothing", async () => {
  const args = { action: WorkspaceAction.Write, path: "src/a.ts", content: "x" } as ActionArgs;

  h.answerWith(allow(ApprovalScope.File));
  await ask(WorkspaceAction.Write, args, "/ws/");

  h.answerWith(deny());
  assert.equal((await ask(WorkspaceAction.Write, args, "/ws/")).approved, true);
  assert.equal(h.prompts.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Static allowlist (.claudio/auto-approve.json)
// ─────────────────────────────────────────────────────────────────────────────

test("an allowlisted action never reaches the modal", async () => {
  h.allowlisted.add("src/generated.ts");
  h.answerWith(deny());

  const r = await ask(WorkspaceAction.Write, {
    action: WorkspaceAction.Write,
    path: "src/generated.ts",
    content: "x",
  } as ActionArgs);

  assert.equal(r.approved, true);
  assert.equal(h.prompts.length, 0);
});

test("without a workspace root the allowlist is skipped and the user is asked", async () => {
  // The allowlist is per-workspace by definition; with no root there is no file
  // to have read it from. Failing open here would be the dangerous direction.
  h.allowlisted.add("src/generated.ts");
  h.answerWith(deny());

  const r = await askWithoutWorkspace(WorkspaceAction.Write, {
    action: WorkspaceAction.Write,
    path: "src/generated.ts",
    content: "x",
  } as ActionArgs);

  assert.equal(r.approved, false);
  assert.equal(h.prompts.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Mode transitions
// ─────────────────────────────────────────────────────────────────────────────

test("agent mode starts at ask", () => {
  assert.equal(harness().gate.agentMode, AgentMode.Ask);
});

test("leaving plan mode re-enables the normal gate rather than opening it", async () => {
  h.gate.setAgentMode(AgentMode.Plan);
  assert.equal(
    (await ask(WorkspaceAction.Write, { action: WorkspaceAction.Write, path: "src/a.ts", content: "x" } as ActionArgs)).approved,
    false,
  );

  h.gate.setAgentMode(AgentMode.Ask);
  h.answerWith(allow());
  const r = await ask(WorkspaceAction.Write, { action: WorkspaceAction.Write, path: "src/a.ts", content: "x" } as ActionArgs);

  assert.equal(r.approved, true);
  assert.equal(h.prompts.length, 1, "the first request was denied without asking; only the second asks");
});
