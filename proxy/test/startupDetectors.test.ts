/**
 * startupDetectors.test.ts — deciding what the model can do, once, at startup.
 *
 * Both detectors answer a question that costs real time to ask — a tool probe
 * is a binary search over live requests, a thinking probe is two more — and both
 * cache the answer under the model's id. Everything downstream is built on those
 * two numbers: `maxTools` chooses Path A or Path B and how many tools survive
 * filtering, and the thinking flags decide whether Claudio shows a toggle that
 * does anything.
 *
 * So the failures are quiet and expensive in opposite directions. A cache that
 * is not read re-probes on every start, which looks like a slow proxy. A cache
 * that is read *wrongly* is worse: a model recorded as supporting one tool comes
 * back as supporting none, and Claudio silently drops to the textual loop for
 * ever. `0` and `false` are the interesting values in both files, and both are
 * exactly the values a `?? ` or a truthiness check would lose.
 *
 * The probes themselves have their own suite; here `fetch` is stubbed and
 * *counted*, because "the expensive path was skipped" is the property under
 * test and the count is the only way to see it.
 *
 * @module test/startupDetectors
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolLimitDetector } from "../src/infrastructure/toolLimitDetector";
import { ThinkingDetector } from "../src/infrastructure/thinkingDetector";
import { PersistentCache } from "../src/infrastructure/persistentCache";
import { silentLogger, modelInfoFake } from "./fakes";
import type { ModelCapabilities } from "../src/domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let dir: string;
let cachePath: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudio-detect-"));
  cachePath = join(dir, "model-cache.json");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

/** Count every request that reaches the backend; answer as instructed. */
function backend(answer: "tool_calls" | "reasoning" | "plain") {
  const calls: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    const message: any = { content: "ok" };
    if (answer === "tool_calls") {
      message.tool_calls = [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }];
    }
    if (answer === "reasoning") message.reasoning_content = "thinking…";
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) } as any;
  }) as typeof fetch;
  return calls;
}

const cache = () => new PersistentCache<ModelCapabilities>(cachePath);
const writeCache = (value: Record<string, Partial<ModelCapabilities>>) =>
  writeFileSync(cachePath, JSON.stringify(value));
const readCache = () => JSON.parse(readFileSync(cachePath, "utf-8"));

const toolLimits = (over: Partial<{ maxToolsOverride: number | null }> = {}) =>
  new ToolLimitDetector(
    {
      maxToolsOverride: null,
      targetUrl: "http://backend/v1/chat/completions",
      probeUpperBound: 4,
      probeMaxTokens: 16,
      probeTimeout: 500,
      ...over,
    },
    cache(),
    silentLogger,
  );

const thinking = () =>
  new ThinkingDetector(
    { targetUrl: "http://backend/v1/chat/completions", probeMaxTokens: 16, probeTimeout: 500 },
    cache(),
    silentLogger,
  );

const model = modelInfoFake({ id: "local-model" });

// ─────────────────────────────────────────────────────────────────────────────
// The tool limit
// ─────────────────────────────────────────────────────────────────────────────

test("a configured override skips the probe entirely", async () => {
  // The escape hatch for a model whose probe is wrong or too slow to wait for.
  const calls = backend("tool_calls");

  const max = await toolLimits({ maxToolsOverride: 3 }).detect(model);

  assert.equal(max, 3);
  assert.deepEqual(calls, [], "it probed a model it had been told about");
});

test("an override of zero is honoured, not read as 'no override'", async () => {
  // `0` is a deliberate setting — "this model cannot do tool calls, do not ask
  // it" — and the value a falsy check silently turns back into a probe.
  const calls = backend("tool_calls");

  const max = await toolLimits({ maxToolsOverride: 0 }).detect(model);

  assert.equal(max, 0);
  assert.deepEqual(calls, []);
});

test("no loaded model means no tools, and no probing", async () => {
  const calls = backend("tool_calls");

  assert.equal(await toolLimits().detect(null), 0);
  assert.deepEqual(calls, []);
});

test("a cached limit is used instead of probing again", async () => {
  // The probe is a binary search over live requests; on a cold model it is the
  // slowest thing in startup. Re-running it every launch is the failure nobody
  // reports as a bug — it just feels slow.
  writeCache({ "local-model": { maxTools: 7 } });
  const calls = backend("tool_calls");

  assert.equal(await toolLimits().detect(model), 7);
  assert.deepEqual(calls, [], "a cached answer was ignored");
});

test("a cached zero is a real answer, not a missing one", async () => {
  // The probe found the model could not manage a single tool. Re-probing on
  // every start is a minute of waiting for the same 0 — and if the check were
  // truthiness rather than `undefined`, that is exactly what would happen.
  writeCache({ "local-model": { maxTools: 0 } });
  const calls = backend("tool_calls");

  assert.equal(await toolLimits().detect(model), 0);
  assert.deepEqual(calls, []);
});

test("a cache holding only the thinking flags still triggers a tool probe", async () => {
  // The two detectors write into the same record. A partial one must not be
  // read as a complete one.
  writeCache({ "local-model": { supportsThinking: true, thinkingCanBeDisabled: false } });
  const calls = backend("tool_calls");

  const max = await toolLimits().detect(model);

  assert.equal(max, 4, "the probe should have run and found the upper bound");
  assert.equal(calls.length > 0, true);
});

test("what the probe found is written back, without losing what was there", async () => {
  // `merge`, not `set`: the thinking detector's answer lives in the same record
  // and must survive.
  writeCache({ "local-model": { supportsThinking: true, thinkingCanBeDisabled: false } });
  backend("tool_calls");

  await toolLimits().detect(model);

  assert.deepEqual(readCache()["local-model"], {
    supportsThinking: true,
    thinkingCanBeDisabled: false,
    maxTools: 4,
  });
});

test("another model's entry is left alone", async () => {
  writeCache({ "other-model": { maxTools: 9 } });
  backend("tool_calls");

  await toolLimits().detect(model);

  assert.equal(readCache()["other-model"].maxTools, 9);
});

// ─────────────────────────────────────────────────────────────────────────────
// Thinking
// ─────────────────────────────────────────────────────────────────────────────

test("no loaded model means the conservative answer, and no probing", async () => {
  const calls = backend("reasoning");

  assert.deepEqual(await thinking().detect(null), {
    supportsThinking: false,
    thinkingCanBeDisabled: false,
  });
  assert.deepEqual(calls, []);
});

test("both cached flags skip both probes", async () => {
  writeCache({ "local-model": { supportsThinking: true, thinkingCanBeDisabled: false } });
  const calls = backend("reasoning");

  const caps = await thinking().detect(model);

  assert.deepEqual(caps, { supportsThinking: true, thinkingCanBeDisabled: false });
  assert.deepEqual(calls, []);
});

test("cached `false` flags are answers too", async () => {
  // Same falsy trap as the tool limit, and the same cost: two probes on every
  // start for a model that has already said no twice.
  writeCache({ "local-model": { supportsThinking: false, thinkingCanBeDisabled: false } });
  const calls = backend("reasoning");

  assert.deepEqual(await thinking().detect(model), {
    supportsThinking: false,
    thinkingCanBeDisabled: false,
  });
  assert.deepEqual(calls, []);
});

test("half a cached answer is not an answer", async () => {
  writeCache({ "local-model": { supportsThinking: true } });
  const calls = backend("reasoning");

  await thinking().detect(model);

  assert.equal(calls.length > 0, true, "an incomplete record was treated as complete");
});

test("a model that emits reasoning it will not suppress is described as such", async () => {
  // The measured shape of the current model: reasoning always, no way to turn it
  // off. Both probes run, and the second one's answer is what stops Claudio
  // offering a toggle that does nothing.
  const calls = backend("reasoning");

  const caps = await thinking().detect(model);

  assert.deepEqual(caps, { supportsThinking: true, thinkingCanBeDisabled: false });
  assert.equal(calls.length, 2, "the second probe is what decides `canBeDisabled`");
});

test("a model with no reasoning at all is not asked twice", async () => {
  // There is nothing to disable, so the second probe would spend a request to
  // learn nothing.
  const calls = backend("plain");

  const caps = await thinking().detect(model);

  assert.deepEqual(caps, { supportsThinking: false, thinkingCanBeDisabled: false });
  assert.equal(calls.length, 1);
});

test("the thinking answer is written back beside the tool limit", async () => {
  writeCache({ "local-model": { maxTools: 5 } });
  backend("reasoning");

  await thinking().detect(model);

  assert.deepEqual(readCache()["local-model"], {
    maxTools: 5,
    supportsThinking: true,
    thinkingCanBeDisabled: false,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The cache underneath
// ─────────────────────────────────────────────────────────────────────────────

test("a missing cache file reads as empty, not as an error", async () => {
  // First launch on a new machine. Startup must not depend on the file existing.
  assert.equal(cache().get("local-model"), null);
});

test("a corrupt cache file reads as empty too", async () => {
  // Half-written by a kill during startup, or hand-edited. Refusing to start
  // over a damaged cache would be worse than re-probing.
  writeFileSync(cachePath, "{ not json");

  assert.equal(cache().get("local-model"), null);
});

test("writing one key leaves the others as they were", async () => {
  writeCache({ a: { maxTools: 1 }, b: { maxTools: 2 } });

  await cache().set("a", { maxTools: 99 } as ModelCapabilities);

  assert.deepEqual(readCache(), { a: { maxTools: 99 }, b: { maxTools: 2 } });
});

test("merging keeps the fields it was not given", async () => {
  writeCache({ a: { maxTools: 1, supportsThinking: true } });

  await cache().merge("a", { thinkingCanBeDisabled: false });

  assert.deepEqual(readCache().a, {
    maxTools: 1,
    supportsThinking: true,
    thinkingCanBeDisabled: false,
  });
});

test("merging into a key that does not exist yet creates it", async () => {
  await cache().merge("new-model", { maxTools: 3 });

  assert.deepEqual(readCache()["new-model"], { maxTools: 3 });
});

test("a cache that cannot be written does not take the startup with it", async () => {
  // Best-effort by design: a read-only directory, a full disk, a path that does
  // not exist. The proxy re-probes next time; it does not fail to start.
  const unwritable = new PersistentCache<ModelCapabilities>(join(dir, "no", "such", "dir.json"));

  await unwritable.merge("local-model", { maxTools: 3 });

  assert.equal(existsSync(join(dir, "no")), false);
});
