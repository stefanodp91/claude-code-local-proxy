/**
 * systemPromptBuilder.test.ts — what every workspace request is prefixed with.
 *
 * The single injection point for everything the model is told before it sees the
 * user's message: the working directory, plan mode's constraints, the textual
 * tool manual on Path B, and now cross-session memory. Nothing downstream can
 * tell whether a section was injected or silently skipped — the model simply
 * behaves as if it never knew.
 *
 * @module test/systemPromptBuilder
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SystemPromptBuilder } from "../src/application/services/systemPromptBuilder";
import { AgentMode } from "../src/domain/types";
import { WORKSPACE_TOOL_DEF } from "../src/domain/entities/workspaceAction";
import { TEXTUAL_TOOL_MANUAL } from "../src/application/textualAgentLoop";
import { PromptKey } from "../src/domain/ports";
import type {
  MemoryRepositoryPort, TodoRepositoryPort, SkillRepositoryPort,
  PlanFileRepositoryPort, PromptRepositoryPort,
} from "../src/domain/ports";
import type { ExistingPlan } from "../src/domain/entities/existingPlan";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const WS = "/tmp/some/project";

/** Templates that echo their parameters, so a test can see what was passed. */
function prompts(): PromptRepositoryPort {
  return {
    preload: async () => {},
    get: (key: PromptKey, params: Record<string, string> = {}) =>
      `[${key}]` + Object.entries(params).map(([k, v]) => `\n${k}=${v}`).join(""),
  } as unknown as PromptRepositoryPort;
}

function planFiles(mostRecent: ExistingPlan | null = null): PlanFileRepositoryPort {
  return {
    plansDirRelative: ".claudio/plans",
    isPlanPath: (p) => p.startsWith(".claudio/plans/"),
    buildRelPath: (f) => `.claudio/plans/${f}`,
    loadMostRecent: () => mostRecent,
  };
}

function memory(content: string | null): MemoryRepositoryPort {
  return { relativePath: ".claudio/MEMORY.md", load: () => content };
}

function todo(content: string | null): TodoRepositoryPort {
  return { relativePath: ".claudio/TODO.md", load: () => content };
}

function skills(...names: string[]): SkillRepositoryPort {
  return { list: () => names.map((n) => ({ name: n, description: `what ${n} is for` })) };
}

const builder = (
  mem: MemoryRepositoryPort = memory(null),
  plans = planFiles(),
  list: TodoRepositoryPort = todo(null),
  available: SkillRepositoryPort = skills(),
) => new SystemPromptBuilder(prompts(), plans, mem, list, available);

// ─────────────────────────────────────────────────────────────────────────────
// The basics
// ─────────────────────────────────────────────────────────────────────────────

test("the working directory reaches the template", () => {
  const out = builder().build(WS, AgentMode.Ask, false);

  assert.match(out, /\[agent-base\]/);
  assert.match(out, /cwd=\/tmp\/some\/project/);
  assert.match(out, /cwdBase=project/);
});

test("plan mode uses a different template entirely", () => {
  const out = builder().build(WS, AgentMode.Plan, false);
  assert.match(out, /\[plan-mode\]/);
  assert.equal(out.includes("[agent-base]"), false);
});

test("auto mode is prompted like ask mode", () => {
  // Auto changes what the approval gate does, not what the model is told.
  assert.match(builder().build(WS, AgentMode.Auto, false), /\[agent-base\]/);
});

test("the textual tool manual is appended only on Path B", () => {
  assert.equal(builder().build(WS, AgentMode.Ask, false).includes("<action"), false);
  assert.match(builder().build(WS, AgentMode.Ask, true), /<action name="read"/);
});

test("an existing plan is offered back in plan mode", () => {
  const plans = planFiles({
    relPath: ".claudio/plans/p.md", absPath: "/tmp/some/project/.claudio/plans/p.md",
    mtimeRelative: "2 hours ago", content: "# The plan",
  });
  const out = builder(memory(null), plans).build(WS, AgentMode.Plan, false);

  assert.match(out, /# The plan/);
  assert.match(out, /2 hours ago/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-session memory
// ─────────────────────────────────────────────────────────────────────────────

test("memory is injected when the file has something in it", () => {
  const out = builder(memory("The user prefers tabs. The build script is flaky.")).build(WS, AgentMode.Ask, false);

  assert.match(out, /The user prefers tabs/);
  assert.match(out, /flaky/);
});

test("no memory file means no memory section at all", () => {
  // Not an empty heading, not "(no memories yet)" — nothing. Every token spent
  // on an empty section is a token taken from the conversation, on a model
  // whose window is the scarce resource in this whole project.
  const out = builder(memory(null)).build(WS, AgentMode.Ask, false);

  assert.equal(out.includes("memory-section"), false);
  assert.equal(out.includes("memorySection="), true, "the placeholder still resolves, to nothing");
  assert.match(out, /memorySection=\s*(\n|$)/);
});

test("the skills on offer are listed, so the model knows what it may load", () => {
  // The index and nothing else: a name and a line each. The bodies arrive only
  // when the model asks, which is the whole point — a skill always in the prompt
  // is just a longer prompt.
  const out = builder(memory(null), planFiles(), todo(null), skills("commit-style", "release"))
    .build(WS, AgentMode.Ask, false);

  assert.match(out, /skills-section/);
  assert.match(out, /commit-style/);
  assert.match(out, /release/);
});

test("a workspace with no skills gets no skills section", () => {
  const out = builder(memory(null), planFiles(), todo(null), skills()).build(WS, AgentMode.Ask, false);

  assert.equal(out.includes("skills-section"), false);
  assert.match(out, /skillsSection=\s*(\n|$)/, "the placeholder still resolves, to nothing");
});

test("the list the model was keeping is carried into the next turn's prompt", () => {
  // This is the whole feature: a task list is only worth writing if it comes
  // back. What the model wrote last turn is what stops the fourth step of six
  // from vanishing.
  const out = builder(memory(null), planFiles(), todo("- [x] read\n- [ ] change")).build(WS, AgentMode.Ask, false);

  assert.match(out, /todo-section/);
  assert.match(out, /- \[ \] change/);
  assert.match(out, /todoPath=\.claudio\/TODO\.md/, "the model must know where to write it back");
});

test("no list means no todo section at all", () => {
  // Found by a negative control coming back green: nothing covered this, and
  // the reasoning is the same as for memory — an empty heading is spent on
  // every request of the turn to say there is nothing to say.
  const out = builder(memory(null), planFiles(), todo(null)).build(WS, AgentMode.Ask, false);

  assert.equal(out.includes("todo-section"), false);
  assert.match(out, /todoSection=\s*(\n|$)/, "the placeholder still resolves, to nothing");
});

test("the list reaches plan mode too", () => {
  const out = builder(memory(null), planFiles(), todo("- [ ] step")).build(WS, AgentMode.Plan, false);

  assert.match(out, /todo-section/);
});

test("the model is told where the memory lives, so it can update it", () => {
  // There is no new action for this: the model writes the file through the
  // ordinary `write`, which means it passes the approval gate like any other
  // write. Telling it the path is the whole mechanism.
  const out = builder(memory("something remembered")).build(WS, AgentMode.Ask, false);

  assert.match(out, /\.claudio\/MEMORY\.md/);
});

test("memory reaches plan mode too", () => {
  // Planning is exactly when knowing what was decided last week matters most.
  const out = builder(memory("We chose Postgres over SQLite in March.")).build(WS, AgentMode.Plan, false);

  assert.match(out, /Postgres/);
});

test("memory is injected on both paths", () => {
  const withMemory = builder(memory("remembered"));

  assert.match(withMemory.build(WS, AgentMode.Ask, false), /remembered/);
  assert.match(withMemory.build(WS, AgentMode.Ask, true), /remembered/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The templates on disk, not the fakes above
// ─────────────────────────────────────────────────────────────────────────────

test("every parameter the builder passes has a placeholder in the real template", async () => {
  // The tests above use a prompt repository that echoes its parameters, which
  // proves the builder computes them and proves nothing about whether the
  // shipped templates use them. A parameter with no `{{placeholder}}` is simply
  // dropped: no error, no warning, and a feature that quietly never happens.
  // That is how this would have shipped — the memory section was wired end to
  // end and absent from agent-base.md.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const seen: Record<string, string[]> = {};
  const recording: PromptRepositoryPort = {
    preload: async () => {},
    get: (key: PromptKey, params: Record<string, string> = {}) => {
      seen[key] = Object.keys(params);
      return "";
    },
  } as unknown as PromptRepositoryPort;

  const b = new SystemPromptBuilder(
    recording, planFiles(), memory("x"), todo("- [ ] a"), skills("commit-style"),
  );
  b.build(WS, AgentMode.Ask, false);
  b.build(WS, AgentMode.Plan, false);

  for (const [key, params] of Object.entries(seen)) {
    const template = readFileSync(join("prompts", "en_US", `${key}.md`), "utf-8");
    for (const name of params) {
      assert.equal(
        template.includes(`{{${name}}}`),
        true,
        `prompts/en_US/${key}.md never uses {{${name}}}, so the builder computes it for nothing`,
      );
    }
  }
});

test("every action the tool schema offers is named in the instructions that reach the model", async () => {
  // Derived from the artefacts, not from a list written here: the schema on one
  // side, what the model is actually told on the other. The prompt is where the
  // model learns what it may do, and it had fallen behind the schema — `python`
  // was implemented, exposed in the tool definition, and named nowhere. A model
  // that reads its instructions then concludes the action does not exist, which
  // is what one did: "there's no dedicated `python` action, but `bash` can
  // execute it", followed by a tool call written as plain text.
  //
  // Checked per artefact rather than against their concatenation. Joining them
  // first is how this test passed while Path B's manual was still missing
  // `python`: agent-base.md named it, so the union did too.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const read = (k: string) => readFileSync(join("prompts", "en_US", `${k}.md`), "utf-8");

  const advertised: string[] =
    (WORKSPACE_TOOL_DEF.function.parameters.properties.action as any).enum;
  assert.equal(advertised.length > 0, true, "the schema advertises no actions at all");

  // `exit_plan_mode` is a control action that only exists in plan mode, and
  // Path B does not implement it — its manual must not offer it.
  const executable = advertised.filter((a) => a !== "exit_plan_mode");

  const pathA = `${read("agent-base")}\n${read("plan-mode")}`;
  for (const action of advertised) {
    assert.equal(
      pathA.includes(action),
      true,
      `the schema offers '${action}' and Path A's prompts never mention it — the model is being told it does not exist`,
    );
  }

  // Path B's manual is not a prompt file but a constant in the loop, and it had
  // drifted the same way. Same rule, different artefact.
  for (const action of executable) {
    assert.equal(
      TEXTUAL_TOOL_MANUAL.includes(action),
      true,
      `the schema offers '${action}' and TEXTUAL_TOOL_MANUAL never teaches it — Path B cannot use it`,
    );
  }
});
