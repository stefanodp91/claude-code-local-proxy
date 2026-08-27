/**
 * skills.test.ts — instructions the model loads only when it needs them.
 *
 * The context window is the scarce resource in this project, so a skill is not
 * "more prompt": it is prompt the model *asks for*. What sits in every request
 * is an index — a name and a line each — and the body arrives only when the
 * model calls `skill`.
 *
 * Three decisions the suite pins rather than a comment arguing them:
 *
 *   - **The model chooses.** No keyword triggers. It reached for `todo` on a
 *     six-step task and not on a three-step one; the same judgment is what
 *     selects a skill, and if it turns out not to, that is a measurement to make
 *     rather than a mechanism to add now.
 *   - **A skill's scripts run through the ordinary actions**, so they pass the
 *     approval gate like any other command. A private execution channel would be
 *     a second route, unsupervised — the same reason memory is written through
 *     the ordinary gated `write`.
 *   - **Two homes, the workspace wins.** Global skills are the ones you keep;
 *     the project's own override them by name, because the project is the thing
 *     under review.
 *
 * @module test/skills
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSkillRepository } from "../src/infrastructure/adapters/fsSkillRepository";
import { executeAction } from "../src/infrastructure/workspaceActions";
import { WorkspaceAction, WORKSPACE_TOOL_DEF, type ActionArgs } from "../src/domain/entities/workspaceAction";

let ws: string;
let globalDir: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "claudio-skills-"));
  globalDir = mkdtempSync(join(tmpdir(), "claudio-global-skills-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(globalDir, { recursive: true, force: true });
});

/** Write a skill into the workspace (`.claudio/skills/<name>/SKILL.md`). */
function workspaceSkill(name: string, body: string, files: Record<string, string> = {}): void {
  const dir = join(ws, ".claudio", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
}

/** Write a skill into the global directory. */
function globalSkill(name: string, body: string): void {
  const dir = join(globalDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

const repo = () => new FsSkillRepository(".claudio/skills", globalDir);
const run = (args: Partial<ActionArgs>) =>
  executeAction(args as ActionArgs, ws, { skillsDir: ".claudio/skills", globalSkillsDir: globalDir });

const SKILL = `---
name: commit-style
description: how commit messages are written in this repository
---

Write the reason, not the diff. The subject is imperative and under 60 characters.
`;

// ─────────────────────────────────────────────────────────────────────────────
// The index — what every request pays for
// ─────────────────────────────────────────────────────────────────────────────

test("a skill is listed by name and by what it is for", () => {
  // The index is in every request of every turn. One line each is the budget,
  // and the description is the only thing the model has to choose on.
  workspaceSkill("commit-style", SKILL);

  const listed = repo().list(ws);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "commit-style");
  assert.match(listed[0].description, /commit messages/);
});

test("a skill with no front matter is still listed, described by its first line", () => {
  // Skills are written by hand. One that forgets the header must not vanish
  // from the index without a word.
  workspaceSkill("review", "# Review checklist\n\nStart with the tests.\n");

  const listed = repo().list(ws);

  assert.equal(listed.length, 1);
  assert.match(listed[0].description, /Review checklist|Start with the tests/);
});

test("a directory without a SKILL.md is not a skill", () => {
  mkdirSync(join(ws, ".claudio", "skills", "not-a-skill"), { recursive: true });

  assert.deepEqual(repo().list(ws), []);
});

test("no skills anywhere means an empty index, not an error", () => {
  assert.deepEqual(repo().list(ws), []);
});

test("global and workspace skills are both offered", () => {
  globalSkill("global-one", "---\nname: global-one\ndescription: from the global directory\n---\nbody");
  workspaceSkill("local-one", "---\nname: local-one\ndescription: from the project\n---\nbody");

  const names = repo().list(ws).map((s) => s.name).sort();

  assert.deepEqual(names, ["global-one", "local-one"]);
});

test("the project's skill wins over a global one of the same name", () => {
  // The project is the thing under review, and its version is the one a
  // colleague cloning the repo gets.
  globalSkill("commit-style", "---\nname: commit-style\ndescription: the global one\n---\nglobal body");
  workspaceSkill("commit-style", "---\nname: commit-style\ndescription: the project one\n---\nproject body");

  const listed = repo().list(ws);

  assert.equal(listed.length, 1, "the same name was offered twice");
  assert.match(listed[0].description, /project one/);
  assert.match(repo().load(ws, "commit-style")?.body ?? "", /project body/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Loading one
// ─────────────────────────────────────────────────────────────────────────────

test("loading a skill returns its instructions", async () => {
  workspaceSkill("commit-style", SKILL);

  const out = await run({ action: WorkspaceAction.Skill, skill_name: "commit-style" });

  assert.match(out.text, /imperative and under 60/);
});

test("the front matter is not part of what the model reads", () => {
  // It is bookkeeping for the index. Sending it costs tokens and tells the
  // model nothing it was not already told.
  workspaceSkill("commit-style", SKILL);

  const body = repo().load(ws, "commit-style")?.body ?? "";

  assert.equal(body.includes("description:"), false);
  assert.match(body, /Write the reason/);
});

test("the skill's own files are listed, so the model knows what it may run", async () => {
  // This is how a skill carries a script: it ships the file, the model runs it
  // with the ordinary `bash` or `python` action, and that action passes the
  // approval gate like any other. No private execution path.
  workspaceSkill("release", "---\nname: release\ndescription: cutting a release\n---\nRun the checks.\n", {
    "check.sh": "#!/bin/sh\necho ok\n",
    "template.md": "# Release\n",
  });

  const out = await run({ action: WorkspaceAction.Skill, skill_name: "release" });

  assert.match(out.text, /check\.sh/);
  assert.match(out.text, /template\.md/);
  assert.match(out.text, /\.claudio\/skills\/release/, "the model needs the path to run anything");
});

test("a skill with no extra files says so rather than listing nothing", async () => {
  workspaceSkill("commit-style", SKILL);

  const out = await run({ action: WorkspaceAction.Skill, skill_name: "commit-style" });

  assert.equal(out.text.includes("SKILL.md"), false, "its own instructions are not a resource");
});

test("asking for a skill that does not exist lists the ones that do", async () => {
  // A model that guessed a name must be able to recover in the same turn.
  workspaceSkill("commit-style", SKILL);

  const out = await run({ action: WorkspaceAction.Skill, skill_name: "commit-styles" });

  assert.match(out.text, /not found|unknown/i);
  assert.match(out.text, /commit-style/);
});

test("asking with no name at all is an error, not a silent nothing", async () => {
  const out = await run({ action: WorkspaceAction.Skill });

  assert.match(out.text, /required/i);
});

test("the argument is not called `name`, because the textual path cannot carry it", () => {
  // `<action name="skill" …/>` already spends the `name` attribute on the action
  // itself, so a skill named through `name` would work on Path A and be
  // impossible to express on Path B — the two grammars drifting apart, which
  // this repo has paid for once already.
  const properties = WORKSPACE_TOOL_DEF.function.parameters.properties as Record<string, unknown>;

  assert.equal("skill_name" in properties, true);
  assert.equal("name" in properties, false, "the schema uses an attribute Path B cannot send");
});

test("a name that climbs out of the skills directory loads nothing", async () => {
  // The name comes from the model, and it is a path segment. `../../` is the
  // first thing to try.
  writeFileSync(join(ws, "secret.md"), "SECRET");

  const out = await run({ action: WorkspaceAction.Skill, skill_name: "../../secret" });

  assert.equal(out.text.includes("SECRET"), false, "a file outside the skills directory was read");
  assert.match(out.text, /not found|unknown|invalid/i);
});

test("a skill that has grown into a document is truncated, not dropped", () => {
  // It goes into the conversation whole. Half a skill still teaches something;
  // an unbounded one takes the window the work needs.
  workspaceSkill("long", `---\nname: long\ndescription: a long one\n---\n${"x".repeat(20_000)}`);

  const body = repo().load(ws, "long")?.body ?? "";

  assert.equal(body.length < 9_000, true, `it loaded ${body.length} characters`);
  assert.match(body, /truncated/i);
});
