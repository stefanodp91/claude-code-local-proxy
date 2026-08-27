/**
 * slashCommandInterceptor.test.ts — the commands the proxy answers itself.
 *
 * Three ways this goes wrong, none of them loud:
 *
 *   - **A command that is not intercepted** reaches the model as literal text,
 *     and a local model asked to obey "/commit" invents something.
 *   - **A command that is intercepted when it should not be** steals a client
 *     command: the proxy answers `/copy` and the extension never sees it.
 *   - **A registry entry with no implementation, or no translation**, produces
 *     a command that lists itself in the palette and then does nothing, or one
 *     labelled with a raw i18n key.
 *
 * The last two are checked against the artefacts rather than against a list
 * written here: the registry against `execute()`, and the registry against the
 * extension's own locale files. The registry is served over `GET /commands` and
 * rendered by Claudio's palette, so the two packages have to agree — and they
 * did not: `/brief` shipped without a translation in either language.
 *
 * The git-backed commands run against a real temporary repository. They are the
 * only tests here that touch a subprocess, and they are worth it: every one of
 * them has a "no output" branch that must produce a readable answer rather than
 * an empty enrichment.
 *
 * @module test/slashCommandInterceptor
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SlashCommandInterceptor,
  SLASH_COMMAND_REGISTRY,
  type InterceptResult,
} from "../src/application/slashCommandInterceptor";
import type { AnthropicRequest } from "../src/domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "claudio-slash-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

const interceptor = new SlashCommandInterceptor();

/** Send one user message, as a plain string. */
function ask(text: string, cwd?: string): Promise<InterceptResult> {
  const request = { messages: [{ role: "user", content: text }] } as unknown as AnthropicRequest;
  return interceptor.intercept(request, cwd ?? ws);
}

/** Send whatever content shape the caller wants. */
function askRaw(messages: any[], cwd?: string): Promise<InterceptResult> {
  return interceptor.intercept({ messages } as unknown as AnthropicRequest, cwd ?? ws);
}

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

/** A repository with one commit, so HEAD exists. */
function repo(): void {
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "test@example.com"], ws);
  git(["config", "user.name", "Test"], ws);
  writeFileSync(join(ws, "a.txt"), "one\n");
  git(["add", "a.txt"], ws);
  git(["commit", "-qm", "first"], ws);
}

const proxyCommands = SLASH_COMMAND_REGISTRY.filter((c) => c.handler === "proxy");
const clientCommands = SLASH_COMMAND_REGISTRY.filter((c) => c.handler === "client");

// ─────────────────────────────────────────────────────────────────────────────
// What is a command, and what is not
// ─────────────────────────────────────────────────────────────────────────────

test("ordinary text passes through untouched", async () => {
  assert.deepEqual(await ask("what does this repo do?"), { type: "passthrough" });
});

test("a message that only mentions a slash mid-sentence is not a command", async () => {
  assert.deepEqual(await ask("run git diff / git status and explain"), { type: "passthrough" });
});

test("an unknown slash command is left to the model", async () => {
  // The proxy answers what it implements and nothing else; the CLI has its own.
  assert.deepEqual(await ask("/deploy staging"), { type: "passthrough" });
});

test("a client-handled command is not stolen from the client", async () => {
  // /copy, /files, /clear … are the extension's. Answering them here means the
  // extension never sees them and the user gets prose instead of an action.
  for (const cmd of clientCommands) {
    assert.deepEqual(await ask(cmd.name), { type: "passthrough" }, `${cmd.name} was intercepted`);
  }
});

test("the last message decides, and only when it is the user's", async () => {
  const result = await askRaw([
    { role: "user", content: "/status" },
    { role: "assistant", content: "sure" },
  ]);

  assert.deepEqual(result, { type: "passthrough" });
});

test("a command inside a content block is found, not just a plain string", async () => {
  const result = await askRaw([{ role: "user", content: [{ type: "text", text: "/version" }] }]);

  assert.equal(result.type, "synthetic");
});

test("a command typed alongside an attachment is still a command", async () => {
  // Claudio can attach images, and the attachment arrives as the first block.
  // Reading block 0 and stopping means the command is silently forwarded to the
  // model as text — the same "first block" assumption that once pinned thinking
  // to index 0.
  const result = await askRaw([{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "/version" },
    ],
  }]);

  assert.equal(result.type, "synthetic", "the command was hidden behind the attachment");
});

test("case and arguments do not stop a command being recognised", async () => {
  const upper = await ask("/STATUS");
  const withArgs = await ask("/status please");

  assert.equal(upper.type, "synthetic");
  assert.equal(withArgs.type, "synthetic");
});

test("an Anthropic-only command is explained, not forwarded", async () => {
  // /login against a local model would be answered by the model, plausibly and
  // wrongly. The user is told it does not apply here.
  const result = await ask("/login");

  assert.equal(result.type, "synthetic");
  assert.match((result as any).text, /\/login/);
  assert.match((result as any).text, /not available|specific to Anthropic/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// The registry, checked against what it promises
// ─────────────────────────────────────────────────────────────────────────────

test("every proxy-handled command in the registry actually does something", async () => {
  // Derived from the registry, so a command added there without an
  // implementation fails here instead of listing itself in the palette and
  // falling through to the model.
  repo();
  assert.equal(proxyCommands.length > 0, true, "the registry advertises no proxy commands");

  for (const cmd of proxyCommands) {
    const result = await ask(cmd.name);
    assert.notEqual(result.type, "passthrough", `${cmd.name} is advertised and does nothing`);
  }
});

test("every registry entry has a translation in the extension, in every language", async () => {
  // The registry is served over GET /commands and rendered by Claudio's command
  // palette through `descriptionKey | translate`. A missing key shows the raw
  // key to the user. Two packages, one repo, and they had already drifted:
  // /brief was in the registry and in neither locale file.
  const flatten = (obj: any, prefix = ""): Record<string, string> =>
    Object.entries(obj).reduce((acc: Record<string, string>, [k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      return v && typeof v === "object"
        ? { ...acc, ...flatten(v, key) }
        : { ...acc, [key]: String(v) };
    }, {});

  for (const locale of ["en", "it"]) {
    const path = join("..", "chat-extension", "src", "webview-ui", "src", "assets", "i18n", `${locale}.json`);
    const keys = flatten(JSON.parse(readFileSync(path, "utf-8")));

    for (const cmd of SLASH_COMMAND_REGISTRY) {
      assert.equal(
        typeof keys[cmd.descriptionKey] === "string" && keys[cmd.descriptionKey].length > 0,
        true,
        `${locale}.json has no ${cmd.descriptionKey} — ${cmd.name} shows a raw key in the palette`,
      );
    }
  }
});

test("/version reports the version the package actually has", async () => {
  // Read from the real package.json, so a moved file or a bumped version that
  // did not reach here fails rather than reporting a stale number.
  const { version } = JSON.parse(readFileSync("package.json", "utf-8"));

  const result = await ask("/version");

  assert.match((result as any).text, new RegExp(version.replace(/\./g, "\\.")));
});

test("/status describes the running proxy, including where it is working", async () => {
  const result = await ask("/status");

  assert.equal(result.type, "synthetic");
  assert.match((result as any).text, new RegExp(ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// ─────────────────────────────────────────────────────────────────────────────
// The git-backed commands
// ─────────────────────────────────────────────────────────────────────────────

test("/commit with nothing staged says so instead of enriching with emptiness", async () => {
  repo();

  const result = await ask("/commit");

  assert.equal(result.type, "synthetic");
  assert.match((result as any).text, /staged/i);
});

test("/commit sends the staged diff and asks for a message", async () => {
  repo();
  writeFileSync(join(ws, "a.txt"), "one\ntwo\n");
  git(["add", "a.txt"], ws);

  const result = await ask("/commit");

  assert.equal(result.type, "enrich");
  assert.match((result as any).newContent, /\+two/);
  assert.match((result as any).newContent, /commit message/i);
});

test("/diff with a clean tree says so", async () => {
  repo();

  const result = await ask("/diff");

  assert.equal(result.type, "synthetic");
  assert.match((result as any).text, /no uncommitted changes/i);
});

test("/diff sends the working-tree diff", async () => {
  repo();
  writeFileSync(join(ws, "a.txt"), "changed\n");

  const result = await ask("/diff");

  assert.equal(result.type, "enrich");
  assert.match((result as any).newContent, /-one/);
  assert.match((result as any).newContent, /\+changed/);
});

test("/review on a branch with nothing to compare says so", async () => {
  // No second branch, so `diff main...HEAD` is empty and `master` does not
  // exist. Both branches of the fallback end in the same readable answer.
  repo();

  const result = await ask("/review");

  assert.equal(result.type, "synthetic");
  assert.match((result as any).text, /main\/master/i);
});

test("/review sends the diff against main when there is one", async () => {
  repo();
  git(["checkout", "-qb", "feature"], ws);
  writeFileSync(join(ws, "a.txt"), "feature work\n");
  git(["commit", "-qam", "work"], ws);

  const result = await ask("/review");

  assert.equal(result.type, "enrich");
  assert.match((result as any).newContent, /feature work/);
});

test("outside a git repository the git commands answer rather than throw", async () => {
  // execAsync rejects when git fails; a throw here would end the turn with a
  // 500 instead of a sentence.
  for (const cmd of ["/commit", "/diff", "/review"]) {
    const result = await ask(cmd);
    assert.equal(result.type, "synthetic", `${cmd} did not degrade to a readable answer`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The prompt-only commands
// ─────────────────────────────────────────────────────────────────────────────

test("the prompt-only commands replace the message and let the model answer", async () => {
  // They are `enrich`, not `synthetic`: the point is that the LLM still runs,
  // with different instructions.
  for (const [cmd, pattern] of [
    ["/compact", /summari[sz]e/i],
    ["/brief", /brief|3 sentences/i],
    ["/plan", /step by step/i],
  ] as [string, RegExp][]) {
    const result = await ask(cmd);
    assert.equal(result.type, "enrich", `${cmd} should still call the model`);
    assert.match((result as any).newContent, pattern);
  }
});
