/**
 * nativeAgentLoop.test.ts — Path A, for models that do have native tool calls.
 *
 * The loop Claudio actually runs on a capable model: stream a turn, collect the
 * `workspace` tool calls, execute them, feed the results back, repeat. Three
 * things in it are easy to get wrong and impossible to notice from outside.
 *
 *   - **The fallthrough contract.** `run()` returns `"fallthrough"` when the
 *     model produced nothing at all on iteration 0, and the caller then retries
 *     the turn as an ordinary completion. Returning `"handled"` there instead
 *     means the user gets silence; returning `"fallthrough"` after anything has
 *     already been written to the wire means they get the turn twice.
 *   - **Batched execution.** Read-only calls run in parallel, destructive ones
 *     strictly in sequence — otherwise two approval modals race for the same
 *     answer and `allowAllThisTurn` is decided by whichever resolves first.
 *   - **The iteration ceiling.** Without it a model that keeps calling tools
 *     runs until something else breaks.
 *
 * Driven with a scripted LLM and a real temporary workspace, asserting on what
 * reached the client and what reached disk.
 *
 * @module test/nativeAgentLoop
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAgentLoopService } from "../src/application/services/nativeAgentLoopService";
import { ApprovalGateService } from "../src/application/services/approvalGateService";
import { ContextCompactor } from "../src/application/services/contextCompactor";
import { AgentMode, ApprovalScope } from "../src/domain/types";
import { silentLogger } from "./fakes";
import type {
  ApprovalInteractorPort, LlmClientPort, LoggerPort,
  PlanFileRepositoryPort, SseWriterPort,
} from "../src/domain/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "claudio-native-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

interface Event { type: string; data: any }

/** One assistant turn: any text, plus any `workspace` tool calls. */
interface Turn {
  text?: string;
  thinking?: string;
  calls?: { id: string; args?: Record<string, unknown>; rawArgs?: string }[];
  /** Deliver this turn as a JSON body instead of a stream, as LM Studio sometimes does. */
  nonStreaming?: boolean;
}

function scriptedLlm(turns: Turn[]) {
  const seen: any[][] = [];
  let n = 0;

  const llm: LlmClientPort = {
    async chat({ body }) {
      seen.push(body.messages);
      const turn = turns[Math.min(n++, turns.length - 1)];
      const toolCalls = (turn.calls ?? []).map((c, i) => ({
        index: i,
        id: c.id,
        // `rawArgs` is how a real model misbehaves: the arguments field is a
        // string it wrote, not an object the fake serialised, so it can be
        // empty or truncated. A fake that can only produce valid JSON cannot
        // reproduce the turn that actually broke.
        function: { name: "workspace", arguments: c.rawArgs ?? JSON.stringify(c.args ?? {}) },
      }));

      if (turn.nonStreaming) {
        return {
          ok: true, status: 200,
          json: {
            choices: [{
              message: {
                content: turn.text ?? "",
                reasoning_content: turn.thinking ?? "",
                tool_calls: toolCalls,
              },
              finish_reason: toolCalls.length ? "tool_calls" : "stop",
            }],
          },
        };
      }

      const enc = new TextEncoder();
      const frames: string[] = [];
      if (turn.thinking) frames.push(chunk({ reasoning_content: turn.thinking }));
      if (turn.text) frames.push(chunk({ content: turn.text }));
      for (const tc of toolCalls) frames.push(chunk({ tool_calls: [tc] }));
      frames.push(chunk({}, toolCalls.length ? "tool_calls" : "stop"));

      return {
        ok: true, status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            for (const f of frames) c.enqueue(enc.encode(f));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
      };
    },
    async ping() { return true; },
  };

  return { llm, seen, get calls() { return n; } };
}

function chunk(delta: any, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
}

function collectingWriter() {
  let raw = "";
  const writer: SseWriterPort = {
    writeHeaders() {}, writeRaw: (f) => { raw += f; }, end() {},
    get isClosed() { return false; },
  };
  return { writer, events: () => parse(raw), raw: () => raw };
}

function parse(raw: string): Event[] {
  const out: Event[] = [];
  for (const frame of raw.split("\n\n")) {
    const line = frame.trim();
    if (!line) continue;
    const [ev, data] = line.split("\n");
    try {
      out.push({ type: ev.replace("event: ", ""), data: JSON.parse(data.replace("data: ", "")) });
    } catch { /* not a frame under test */ }
  }
  return out;
}

/** An approval gate wired to a scripted user. */
type Answer = (action: string) =>
  | { approved: boolean; scope: ApprovalScope }
  | Promise<{ approved: boolean; scope: ApprovalScope }>;

function gate(answer: Answer) {
  const asked: string[] = [];
  const interactor: ApprovalInteractorPort = {
    async prompt(params) { asked.push(params.action); return answer(params.action); },
    resolve: () => true,
  };
  const planFiles: PlanFileRepositoryPort = {
    plansDirRelative: ".claudio/plans",
    isPlanPath: (p) => p.startsWith(".claudio/plans/"),
    buildRelPath: (f) => `.claudio/plans/${f}`,
    loadMostRecent: () => null,
  };
  const service = new ApprovalGateService(
    interactor, planFiles, silentLogger as unknown as LoggerPort,
    () => null, () => false,
  );
  return { service, planFiles, asked };
}

/** A real compactor over a fake summariser — the loop's own history is trimmed. */
function compactorFor(llm: LlmClientPort) {
  return new ContextCompactor(llm, silentLogger as unknown as LoggerPort, {
    semanticEnabled: false, summaryMaxTokens: 128, summaryTimeout: 50,
  });
}

async function drive(turns: Turn[], opts: {
  maxIterations?: number;
  answer?: Answer;
  mode?: AgentMode;
  contextBudget?: number;
} = {}) {
  const { writer, events } = collectingWriter();
  const scripted = scriptedLlm(turns);
  const g = gate(opts.answer ?? (() => ({ approved: true, scope: ApprovalScope.Once })));
  if (opts.mode) g.service.setAgentMode(opts.mode);

  const loop = new NativeAgentLoopService(
    scripted.llm, g.service, g.planFiles, silentLogger as unknown as LoggerPort,
    () => "local-model", () => opts.maxIterations ?? 10,
    compactorFor(scripted.llm), () => opts.contextBudget ?? 0,
  );

  const outcome = await loop.run(
    writer, { model: "m", messages: [{ role: "user", content: "go" }] }, ws, false,
  );

  return { outcome, events: events(), sentToModel: scripted.seen, llmCalls: scripted.calls, asked: g.asked };
}

const textOf = (e: Event[]) =>
  e.filter((x) => x.data?.delta?.type === "text_delta").map((x) => x.data.delta.text).join("");
const toolUses = (e: Event[]) =>
  e.filter((x) => x.data?.content_block?.type === "tool_use").map((x) => x.data.content_block);
const read = (rel: string) => readFileSync(join(ws, rel), "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// The fallthrough contract
// ─────────────────────────────────────────────────────────────────────────────

test("a model that says nothing at all falls through to a normal completion", async () => {
  // Iteration 0 doubles as a guard: the workspace tool is forced on this
  // request, and a simple question ("explain this error") may leave the model
  // with nothing to say under that constraint. The caller retries without it.
  const { outcome, llmCalls } = await drive([{}]);

  assert.equal(outcome, "fallthrough");
  assert.equal(llmCalls, 1, "it gives up after the guard iteration, not after ten");
});

test("nothing is written to the wire before falling through", async () => {
  // The caller re-runs the turn. Anything already emitted would be duplicated,
  // and message_start twice is a protocol error the SDK does not forgive.
  const { writer, raw } = collectingWriter();
  const scripted = scriptedLlm([{}]);
  const g = gate(() => ({ approved: true, scope: ApprovalScope.Once }));
  const loop = new NativeAgentLoopService(
    scripted.llm, g.service, g.planFiles, silentLogger as unknown as LoggerPort,
    () => "local-model", () => 10,
    compactorFor(scripted.llm), () => 0,
  );

  const outcome = await loop.run(writer, { model: "m", messages: [] }, ws, false);

  assert.equal(outcome, "fallthrough");
  assert.equal(raw(), "", "the fallthrough path must leave the stream untouched");
});

test("a plain text answer is handled here, not passed back", async () => {
  const { outcome, events, llmCalls } = await drive([{ text: "42" }]);

  assert.equal(outcome, "handled");
  assert.equal(textOf(events), "42");
  assert.equal(llmCalls, 1);
  assert.equal(events.at(-1)?.type, "message_stop");
});

test("silence after the first iteration ends the turn instead of falling through", async () => {
  // Falling through at this point would replay a turn whose first half the
  // user has already seen.
  writeFileSync(join(ws, "a.ts"), "x");
  const { outcome, events } = await drive([
    { calls: [{ id: "c1", args: { action: "read", path: "a.ts" } }] },
    {},
  ]);

  assert.equal(outcome, "handled");
  assert.equal(events.at(-1)?.type, "message_stop");
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool calls
// ─────────────────────────────────────────────────────────────────────────────

test("a tool call is executed and its result fed back", async () => {
  writeFileSync(join(ws, "a.ts"), "file body");
  const { events, sentToModel, llmCalls } = await drive([
    { calls: [{ id: "c1", args: { action: "read", path: "a.ts" } }] },
    { text: "it says: file body" },
  ]);

  assert.equal(llmCalls, 2);
  assert.equal(toolUses(events).length, 1);

  const followUp = JSON.stringify(sentToModel[1]);
  assert.match(followUp, /file body/);
  assert.match(followUp, /"tool_call_id":"c1"/);
});

test("the assistant turn carrying the tool call is replayed to the model", async () => {
  // OpenAI rejects a tool message that does not follow the assistant tool_calls
  // it answers. Dropping that turn makes the next request malformed.
  writeFileSync(join(ws, "a.ts"), "x");
  const { sentToModel } = await drive([
    { calls: [{ id: "c1", args: { action: "read", path: "a.ts" } }] },
    { text: "done" },
  ]);

  const roles = sentToModel[1].map((m: any) => m.role);
  assert.equal(roles.includes("assistant"), true);
  assert.equal(roles.at(-1), "tool");
});

test("several read-only calls in one turn all run", async () => {
  writeFileSync(join(ws, "a.ts"), "AAA");
  writeFileSync(join(ws, "b.ts"), "BBB");

  const { sentToModel } = await drive([
    { calls: [
      { id: "c1", args: { action: "read", path: "a.ts" } },
      { id: "c2", args: { action: "read", path: "b.ts" } },
    ] },
    { text: "done" },
  ]);

  const followUp = JSON.stringify(sentToModel[1]);
  assert.match(followUp, /AAA/);
  assert.match(followUp, /BBB/);
});

test("results come back in the order the model asked for them", async () => {
  // They execute in parallel; the pairing with tool_call_id is what has to
  // survive that, or the model reads the wrong answer to its own question.
  writeFileSync(join(ws, "a.ts"), "AAA");
  writeFileSync(join(ws, "b.ts"), "BBB");

  const { sentToModel } = await drive([
    { calls: [
      { id: "c1", args: { action: "read", path: "a.ts" } },
      { id: "c2", args: { action: "read", path: "b.ts" } },
    ] },
    { text: "done" },
  ]);

  const toolMsgs = sentToModel[1].filter((m: any) => m.role === "tool");
  assert.deepEqual(toolMsgs.map((m: any) => [m.tool_call_id, m.content]), [["c1", "AAA"], ["c2", "BBB"]]);
});

test("a failing action comes back as an observation, not an exception", async () => {
  const { outcome, sentToModel } = await drive([
    { calls: [{ id: "c1", args: { action: "read", path: "../../etc/passwd" } }] },
    { text: "understood" },
  ]);

  assert.equal(outcome, "handled");
  assert.match(JSON.stringify(sentToModel[1]), /outside the workspace root/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Approval
// ─────────────────────────────────────────────────────────────────────────────

test("a destructive call is gated before it touches disk", async () => {
  const { asked } = await drive(
    [
      { calls: [{ id: "c1", args: { action: "write", path: "new.txt", content: "x" } }] },
      { text: "done" },
    ],
    { answer: () => ({ approved: false, scope: ApprovalScope.Once }) },
  );

  assert.deepEqual(asked, ["write"]);
  assert.throws(() => read("new.txt"));
});

test("a denial is reported to the model rather than swallowed", async () => {
  const { sentToModel } = await drive(
    [
      { calls: [{ id: "c1", args: { action: "write", path: "new.txt", content: "x" } }] },
      { text: "understood" },
    ],
    { answer: () => ({ approved: false, scope: ApprovalScope.Once }) },
  );

  assert.match(JSON.stringify(sentToModel[1]), /denied/i);
});

test("read-only calls are never gated", async () => {
  writeFileSync(join(ws, "a.ts"), "x");
  const { asked } = await drive([
    { calls: [{ id: "c1", args: { action: "read", path: "a.ts" } }] },
    { text: "done" },
  ]);

  assert.deepEqual(asked, []);
});

test("destructive calls in one batch are asked about one at a time", async () => {
  // They run sequentially on purpose: two modals racing would leave the user
  // answering one question while the other resolves on whatever came back
  // first, and "allow for this turn" would apply to whichever won.
  // Counting the prompts proves nothing — two writes ask twice either way.
  // What distinguishes the two is whether a second prompt opens while the first
  // is still waiting for an answer, so measure the overlap directly.
  let open = 0;
  let mostOpenAtOnce = 0;

  await drive(
    [
      { calls: [
        { id: "c1", args: { action: "write", path: "a.txt", content: "1" } },
        { id: "c2", args: { action: "write", path: "b.txt", content: "2" } },
      ] },
      { text: "done" },
    ],
    {
      answer: async () => {
        open++;
        mostOpenAtOnce = Math.max(mostOpenAtOnce, open);
        await new Promise((r) => setTimeout(r, 5)); // the user thinking
        open--;
        return { approved: true, scope: ApprovalScope.Once };
      },
    },
  );

  assert.equal(mostOpenAtOnce, 1, "a second modal opened while the first was still waiting");
  assert.equal(read("a.txt"), "1");
  assert.equal(read("b.txt"), "2");
});

test("approving for the turn stops the loop asking again", async () => {
  const { asked } = await drive(
    [
      { calls: [{ id: "c1", args: { action: "write", path: "a.txt", content: "1" } }] },
      { calls: [{ id: "c2", args: { action: "write", path: "b.txt", content: "2" } }] },
      { text: "done" },
    ],
    { answer: () => ({ approved: true, scope: ApprovalScope.Turn }) },
  );

  assert.equal(asked.length, 1, "'allow for this turn' has to mean the turn");
  assert.equal(read("b.txt"), "2");
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan mode
// ─────────────────────────────────────────────────────────────────────────────

test("plan mode lets the plan file through and blocks the rest", async () => {
  await drive(
    [
      { calls: [{ id: "c1", args: { action: "write", path: "src/x.ts", content: "nope" } }] },
      { calls: [{ id: "c2", args: { action: "write", path: ".claudio/plans/p.md", content: "# Plan" } }] },
      { text: "planned" },
    ],
    { mode: AgentMode.Plan },
  );

  assert.throws(() => read("src/x.ts"), "plan mode must not let a source write through");
  assert.equal(read(".claudio/plans/p.md"), "# Plan");
});

// ─────────────────────────────────────────────────────────────────────────────
// Loop control
// ─────────────────────────────────────────────────────────────────────────────

test("a model that never stops calling tools is cut off, visibly", async () => {
  writeFileSync(join(ws, "a.ts"), "x");
  const { events, llmCalls, outcome } = await drive(
    [{ calls: [{ id: "c1", args: { action: "read", path: "a.ts" } }] }],
    { maxIterations: 3 },
  );

  assert.equal(llmCalls, 3);
  assert.equal(outcome, "handled");
  assert.match(textOf(events), /Max workspace tool iterations reached \(3\)/);
  assert.equal(events.at(-1)?.type, "message_stop");
});

test("a backend error ends the turn instead of hanging the client", async () => {
  const { writer, events } = collectingWriter();
  const llm: LlmClientPort = {
    async chat() { return { ok: false, status: 503, errorText: "model unloaded" }; },
    async ping() { return true; },
  };
  const g = gate(() => ({ approved: true, scope: ApprovalScope.Once }));
  const loop = new NativeAgentLoopService(
    llm, g.service, g.planFiles, silentLogger as unknown as LoggerPort,
    () => "local-model", () => 10,
    compactorFor(llm), () => 0,
  );

  const outcome = await loop.run(writer, { model: "m", messages: [] }, ws, false);

  assert.equal(outcome, "handled");
  const out = events();
  assert.equal(out.at(-1)?.type, "message_stop");
  assert.match(JSON.stringify(out), /503|unloaded/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Compaction inside the turn
// ─────────────────────────────────────────────────────────────────────────────

test("a turn that outgrows the window is compacted mid-flight", async () => {
  // Compaction on the incoming request cannot help here: the request was small
  // and the *turn* is what grew. Each iteration appends an assistant turn plus
  // a tool result, and `read` truncates at 50 KB, so a handful of large reads
  // crosses the window — and the backend answers 400 rather than continuing,
  // after the user has already watched half a reply arrive.
  writeFileSync(join(ws, "big.ts"), "z".repeat(40_000));

  const { sentToModel, outcome } = await drive(
    [
      { calls: [{ id: "c1", args: { action: "read", path: "big.ts" } }] },
      { calls: [{ id: "c2", args: { action: "read", path: "big.ts" } }] },
      { calls: [{ id: "c3", args: { action: "read", path: "big.ts" } }] },
      { text: "done" },
    ],
    { contextBudget: 12_000 },
  );

  assert.equal(outcome, "handled");

  const sizes = sentToModel.map((m) => JSON.stringify(m).length);
  assert.equal(
    Math.max(...sizes) < 12_000 * 4,
    true,
    `the history kept growing past the window: ${sizes.join(", ")}`,
  );
});

test("mid-turn compaction leaves the history valid for the backend", async () => {
  // The whole reason the compactor repairs pairing. This history is nothing but
  // tool calls and their results, so trimming by position is almost guaranteed
  // to cut through a pair — and an orphan on either side is a 400.
  writeFileSync(join(ws, "big.ts"), "z".repeat(40_000));

  const { sentToModel } = await drive(
    [
      { calls: [{ id: "c1", args: { action: "read", path: "big.ts" } }] },
      { calls: [{ id: "c2", args: { action: "read", path: "big.ts" } }] },
      { calls: [{ id: "c3", args: { action: "read", path: "big.ts" } }] },
      { text: "done" },
    ],
    { contextBudget: 12_000 },
  );

  for (const messages of sentToModel) {
    const opened = new Set<string>();
    const answered = new Set<string>();
    for (const m of messages) {
      for (const tc of m.tool_calls ?? []) opened.add(tc.id);
      if (m.role === "tool") {
        assert.equal(opened.has(m.tool_call_id), true, `tool ${m.tool_call_id} answers nothing`);
        answered.add(m.tool_call_id);
      }
    }
    for (const id of opened) assert.equal(answered.has(id), true, `call ${id} unanswered`);
  }
});

test("a turn well inside the window is never compacted", async () => {
  writeFileSync(join(ws, "a.ts"), "small");

  const { sentToModel } = await drive(
    [
      { calls: [{ id: "c1", args: { action: "read", path: "a.ts" } }] },
      { text: "done" },
    ],
    { contextBudget: 100_000 },
  );

  assert.equal(JSON.stringify(sentToModel[1]).includes("removed to fit"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The non-streaming reply LM Studio sometimes sends anyway
// ─────────────────────────────────────────────────────────────────────────────

test("a JSON reply to a streaming request is handled, not dropped", async () => {
  // The loop asks for stream:true on every iteration, and the backend does not
  // always oblige. Ignoring the JSON body would lose the whole turn.
  const { outcome, events } = await drive([{ text: "answered in one shot", nonStreaming: true }]);

  assert.equal(outcome, "handled");
  assert.match(textOf(events), /answered in one shot/);
});

test("tool calls arriving as JSON are executed too", async () => {
  writeFileSync(join(ws, "a.ts"), "body");
  const { sentToModel } = await drive([
    { nonStreaming: true, calls: [{ id: "c1", args: { action: "read", path: "a.ts" } }] },
    { text: "done" },
  ]);

  assert.match(JSON.stringify(sentToModel[1]), /body/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed tool arguments
//
// Measured against the loaded backend, not assumed: an assistant turn whose
// `tool_calls[].function.arguments` is not a JSON *object* string is rejected
// outright — `""` and a truncated `{"action":` both return 500, `"null"` returns
// 400, `"{}"` returns 200. This model does emit argument-less calls, and the
// loop replays its own history verbatim on the next iteration, so one malformed
// call killed the turn one step later with a raw HTML error page in the user's
// chat. The execution side already tolerates it; only the replay did not.
// ─────────────────────────────────────────────────────────────────────────────

/** The assistant turn the loop replayed, from the request it sent next. */
function replayedCalls(sent: any[][], iteration = 1): any[] {
  const msgs = sent[iteration] ?? [];
  return msgs.filter((m: any) => Array.isArray(m.tool_calls)).flatMap((m: any) => m.tool_calls);
}

test("a tool call with no arguments is never replayed as an empty string", async () => {
  const { sentToModel, llmCalls } = await drive([
    { calls: [{ id: "c1", rawArgs: "" }] },
    { text: "done" },
  ]);

  assert.equal(llmCalls, 2, "the loop stopped before it could replay anything");
  const calls = replayedCalls(sentToModel);
  assert.equal(calls.length, 1);
  const parsed = JSON.parse(calls[0].function.arguments);
  assert.equal(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed), true);
});

test("unparseable arguments are replayed as the action that actually ran", async () => {
  // The history has to agree with the tool result sitting next to it: the
  // executor falls back to `list .`, so that is what the replay must say.
  const { sentToModel } = await drive([
    { calls: [{ id: "c1", rawArgs: '{"action":' }] },
    { text: "done" },
  ]);

  const parsed = JSON.parse(replayedCalls(sentToModel)[0].function.arguments);
  assert.deepEqual(parsed, { action: "list", path: "." });
});

test("arguments that parse to null do not end the turn", async () => {
  // `JSON.parse("null")` succeeds, so a guard that only catches a throw lets
  // this one through — and then reading `.action` off it does end the turn.
  const { outcome, sentToModel } = await drive([
    { calls: [{ id: "c1", rawArgs: "null" }] },
    { text: "done" },
  ]);

  assert.equal(outcome, "handled");
  const parsed = JSON.parse(replayedCalls(sentToModel)[0].function.arguments);
  assert.notEqual(parsed, null);
});

test("well-formed arguments are replayed exactly as the model wrote them", async () => {
  const { sentToModel } = await drive([
    { calls: [{ id: "c1", args: { action: "list", path: "." } }] },
    { text: "done" },
  ]);

  assert.deepEqual(JSON.parse(replayedCalls(sentToModel)[0].function.arguments), {
    action: "list", path: ".",
  });
});
