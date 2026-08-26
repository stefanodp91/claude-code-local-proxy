/**
 * toolProbe.test.ts — Guards the tool-limit probe's outcome triage.
 *
 * The probe answers one question: how many tool definitions can this model be
 * given before it stops emitting structured `tool_calls`? Getting it wrong is
 * expensive in both directions — too low and ToolManager splits the tool set
 * behind a `UseTool` meta-tool for nothing, too high and the model silently
 * degrades.
 *
 * The bug these tests exist for: `testWithNTools()` used to end in
 * `catch { return false }`, so a timeout, a dropped connection and an HTTP 500
 * were indistinguishable from "the model replied without tool calls". Since a
 * larger tool array makes the reply slower, timeouts cluster exactly at the
 * boundary the binary search is narrowing in on — so the search measured
 * latency rather than capability, and did it silently.
 *
 * `t()` is never initialised here, and that is deliberate: an unresolved key
 * comes back verbatim, so the log assertions below read as message keys
 * (`probe.detected.capped`) instead of English prose that a copy-edit could
 * break.
 *
 * @module test/toolProbe
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ToolProbe } from "../src/infrastructure/toolProbe";
import type { LoggerPort } from "../src/domain/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** What the fake backend does for one attempt. */
type Reply =
  | "tool_calls"   // 200 with a structured call — N is supported
  | "text"         // 200 with prose but no tool_calls — genuine refusal
  | "timeout"      // fetch rejects, as AbortSignal.timeout does
  | "http500";     // backend error — says nothing about capability

/** Decides the reply for a probe of `n` tools on its `attempt`-th try (1-based). */
type Backend = (n: number, attempt: number) => Reply;

interface Harness {
  /** Every probe issued, in order. */
  readonly calls: { n: number; attempt: number }[];
  /** Message keys passed to logger.info(), in order. */
  readonly logs: string[];
  readonly logger: LoggerPort;
}

const realFetch = globalThis.fetch;
let harness: Harness;

/** Installs a fake backend in place of global fetch. */
function install(backend: Backend): Harness {
  const calls: { n: number; attempt: number }[] = [];
  const logs: string[] = [];
  const attemptsByN = new Map<number, number>();

  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const n = body.tools.length;
    const attempt = (attemptsByN.get(n) ?? 0) + 1;
    attemptsByN.set(n, attempt);
    calls.push({ n, attempt });

    switch (backend(n, attempt)) {
      case "timeout":
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      case "http500":
        return new Response("upstream exploded", { status: 500 });
      case "text":
        return Response.json({ choices: [{ message: { content: "I would call a tool." } }] });
      case "tool_calls":
        return Response.json({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_0",
                type: "function",
                function: { name: "probe_tool_0", arguments: '{"x":"test"}' },
              }],
            },
          }],
        });
    }
  }) as typeof fetch;

  const logger: LoggerPort = {
    info: (...args) => logs.push(String(args[0])),
    dbg: () => {},
    error: () => {},
  };

  harness = { calls, logs, logger };
  return harness;
}

/** A probe wired to the fake backend. Timeouts are irrelevant — fetch is fake. */
function probe(upperBound: number): ToolProbe {
  return new ToolProbe(
    "http://fake/v1/chat/completions",
    { probeUpperBound: upperBound, probeMaxTokens: 100, probeTimeout: 1_000 },
    harness.logger,
  );
}

/** Attempts recorded for a given tool count. */
const attemptsAt = (n: number) => harness.calls.filter((c) => c.n === n).length;

beforeEach(() => { globalThis.fetch = realFetch; });
afterEach(() => { globalThis.fetch = realFetch; });

// ─────────────────────────────────────────────────────────────────────────────
// Capability detection
// ─────────────────────────────────────────────────────────────────────────────

test("a model that refuses even one tool reports 0", async () => {
  install(() => "text");
  const max = await probe(16).detect("fake-model");

  assert.equal(max, 0);
  assert.ok(harness.logs.includes("probe.noSupport"));
  assert.equal(harness.calls.length, 1, "should stop after the single-tool check");
});

test("a genuine ceiling is found and reported plainly", async () => {
  install((n) => (n <= 8 ? "tool_calls" : "text"));
  const max = await probe(16).detect("fake-model");

  assert.equal(max, 8);
  assert.ok(harness.logs.includes("probe.detected"));
  assert.ok(!harness.logs.includes("probe.detected.capped"));
  assert.ok(!harness.logs.includes("probe.detected.atBound"));
});

test("reaching the upper bound without failing says so", async () => {
  install(() => "tool_calls");
  const max = await probe(64).detect("fake-model");

  assert.equal(max, 64);
  assert.ok(
    harness.logs.includes("probe.detected.atBound"),
    "a bound that was never exceeded is not the model's limit, and the log must admit it",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Outcome triage — the reason this file exists
// ─────────────────────────────────────────────────────────────────────────────

test("a transient timeout is retried instead of being believed", async () => {
  // Every tool count works; n=24 just happens to answer slowly once.
  install((n, attempt) => (n === 24 && attempt === 1 ? "timeout" : "tool_calls"));
  const max = await probe(32).detect("fake-model");

  assert.equal(max, 32, "one slow reply must not lower the reported ceiling");
  assert.equal(attemptsAt(24), 2, "the inconclusive attempt should have been retried");
  assert.ok(!harness.logs.includes("probe.detected.capped"));
});

test("an HTTP error is inconclusive, not a capability signal", async () => {
  install((n, attempt) => (n === 12 && attempt === 1 ? "http500" : "tool_calls"));
  const max = await probe(16).detect("fake-model");

  assert.equal(max, 16);
  assert.equal(attemptsAt(12), 2, "a 500 tells us nothing, so it must be retried");
});

test("a persistent timeout caps the search and is reported as a floor", async () => {
  install((n) => (n >= 12 ? "timeout" : "tool_calls"));
  const max = await probe(16).detect("fake-model");

  assert.ok(max < 12, "a tool count we never got an answer for cannot be reported as working");
  assert.ok(
    harness.logs.includes("probe.detected.capped"),
    "a truncated search must not print the same line as a completed one",
  );
  assert.ok(harness.logs.includes("probe.result.timeout"));
});

test("a refusal still searches downward — retrying is only for no answer", async () => {
  install((n) => (n <= 4 ? "tool_calls" : "text"));
  const max = await probe(16).detect("fake-model");

  assert.equal(max, 4);
  for (const n of new Set(harness.calls.map((c) => c.n))) {
    assert.equal(attemptsAt(n), 1, `n=${n} was retried, but the model did answer`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the trace that motivated the fix
// ─────────────────────────────────────────────────────────────────────────────

test("regression: one slow reply at n=48 no longer caps a 64-tool model at 47", async () => {
  // Reproduces the observed run against qwen/qwen3.8-27b (MLX 4-bit): every
  // tool count works, but n=48 took 30.007s against a 30s timeout while its
  // neighbours answered in 7-12s. The old `catch { return false }` read that as
  // a hard ceiling and the search converged on 47.
  install((n, attempt) => (n === 48 && attempt === 1 ? "timeout" : "tool_calls"));
  const max = await probe(64).detect("qwen/qwen3.8-27b");

  assert.notEqual(max, 47, "47 was the artefact this fix exists to prevent");
  assert.equal(max, 64);
  assert.equal(attemptsAt(48), 2);
  assert.ok(harness.logs.includes("probe.detected.atBound"));
});
