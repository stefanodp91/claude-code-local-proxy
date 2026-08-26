/**
 * handleChatMessage.test.ts — the routing decision itself.
 *
 * `docs/testing.md` listed this as the largest genuine gap, and the reason is
 * the shape of the thing: it decides *which proxy the client is talking to*.
 *
 *   - a request with `X-Workspace-Root` and a tool-capable model runs Path A,
 *     the proxy's own agent loop;
 *   - the same request on a model that failed the tool probe runs Path B, the
 *     textual loop;
 *   - without the header the proxy is a pure translator, and the CLI keeps its
 *     own loop, its own tools and its own prompts.
 *
 * Getting that wrong is not a crash. It is Claudio silently losing its agent,
 * or the CLI silently receiving a system prompt written for Claudio, or a
 * fallthrough that answers twice — or not at all. Everything asserted here is
 * about *which* of those happened, and none of it shows up in a stack trace.
 *
 * @module test/handleChatMessage
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HandleChatMessageUseCase } from "../src/application/useCases/handleChatMessageUseCase";
import { ApprovalGateService } from "../src/application/services/approvalGateService";
import { RequestTranslator } from "../src/application/requestTranslator";
import { ResponseTranslator } from "../src/application/responseTranslator";
import { StreamTranslator } from "../src/application/streamTranslator";
import { SlashCommandInterceptor } from "../src/application/slashCommandInterceptor";
import type { SystemPromptBuilder } from "../src/application/services/systemPromptBuilder";
import type { NativeAgentLoopService } from "../src/application/services/nativeAgentLoopService";
import type { ContextCompactor } from "../src/application/services/contextCompactor";
import { toolManagerFake, configFake, modelInfoFake, silentLogger } from "./fakes";
import type {
  ApprovalInteractorPort, LlmClientPort, LoggerPort,
  PlanFileRepositoryPort, SseWriterPort,
} from "../src/domain/ports";
import type { AnthropicRequest, LoadedModelInfo } from "../src/domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** What the LLM should answer, and what it was asked. */
function llmFake(reply: {
  ok?: boolean;
  status?: number;
  json?: any;
  stream?: string[];
  errorText?: string;
} = {}) {
  const seen: any[] = [];
  const llm: LlmClientPort = {
    async chat({ body }) {
      seen.push(body);
      if (reply.ok === false) {
        return { ok: false, status: reply.status ?? 500, errorText: reply.errorText };
      }
      if (reply.stream) {
        const enc = new TextEncoder();
        const frames = [...reply.stream, "data: [DONE]\n\n"];
        return {
          ok: true, status: 200,
          body: new ReadableStream<Uint8Array>({
            start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
          }),
        };
      }
      return {
        ok: true, status: 200,
        json: reply.json ?? { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] },
      };
    },
    async ping() { return true; },
  };
  return { llm, seen, get calls() { return seen.length; } };
}

const delta = (d: any, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: finish }] })}\n\n`;

function collectingWriter() {
  let raw = "";
  let closed = false;
  const writer: SseWriterPort = {
    writeHeaders() {}, writeRaw: (f) => { raw += f; }, end() { closed = true; },
    get isClosed() { return false; },
  };
  return { writer, raw: () => raw, get ended() { return closed; } };
}

/** Records what Path A was asked to do, and what it answered. */
function nativeLoopStub(outcome: "handled" | "fallthrough" = "handled") {
  const runs: { workspaceCwd: string; thinking: boolean }[] = [];
  const loop = {
    async run(_w: SseWriterPort, _req: any, workspaceCwd: string, thinking: boolean) {
      runs.push({ workspaceCwd, thinking });
      return outcome;
    },
  } as unknown as NativeAgentLoopService;
  return { loop, runs };
}

/** Records the system prompt the builder was asked for. */
function promptBuilderStub(text = "AGENT-PROMPT") {
  const builds: { cwd: string; mode: string; textual: boolean }[] = [];
  const builder = {
    build(cwd: string, mode: string, textual: boolean) {
      builds.push({ cwd, mode, textual });
      return text;
    },
  } as unknown as SystemPromptBuilder;
  return { builder, builds, text };
}

/** Records the budget compaction was given — 0 means "window unknown". */
function compactorStub() {
  const budgets: number[] = [];
  const compactor = {
    async compact(_messages: any[], budget: number) {
      budgets.push(budget);
      return { compacted: false, strategy: "none", removed: 0 };
    },
  } as unknown as ContextCompactor;
  return { compactor, budgets };
}

function gate() {
  const interactor: ApprovalInteractorPort = {
    async prompt() { return { approved: true, scope: "once" as any }; },
    resolve: () => true,
  };
  const planFiles: PlanFileRepositoryPort = {
    plansDirRelative: ".claudio/plans",
    isPlanPath: (p) => p.startsWith(".claudio/plans/"),
    buildRelPath: (f) => `.claudio/plans/${f}`,
    loadMostRecent: () => null,
  };
  return new ApprovalGateService(
    interactor, planFiles, silentLogger as unknown as LoggerPort,
    () => null, () => false,
  );
}

interface Opts {
  workspaceCwd?: string;
  maxTools?: number;
  modelInfo?: LoadedModelInfo | null;
  nativeOutcome?: "handled" | "fallthrough";
  llm?: ReturnType<typeof llmFake>;
}

async function run(body: Partial<AnthropicRequest>, opts: Opts = {}) {
  const tm = toolManagerFake();
  const modelInfo = opts.modelInfo === undefined ? modelInfoFake() : opts.modelInfo;
  const llm = opts.llm ?? llmFake();
  const native = nativeLoopStub(opts.nativeOutcome ?? "handled");
  const prompt = promptBuilderStub();
  const compaction = compactorStub();
  const w = collectingWriter();

  const useCase = new HandleChatMessageUseCase(
    gate(),
    prompt.builder,
    native.loop,
    llm.llm,
    new RequestTranslator(modelInfo, tm.manager, configFake()),
    new ResponseTranslator(tm.manager),
    new StreamTranslator(tm.manager, silentLogger),
    new SlashCommandInterceptor(),
    silentLogger as unknown as LoggerPort,
    () => modelInfo,
    () => opts.maxTools ?? 8,
    () => 10,
    "http://target",
    compaction.compactor,
    {},
  );

  const full = { model: "claude", max_tokens: 100, messages: [], ...body } as AnthropicRequest;
  const result = await useCase.execute({ body: full, workspaceCwd: opts.workspaceCwd }, w.writer);

  return { result, body: full, sentToLlm: llm.seen, llmCalls: llm.calls, native, prompt, compaction, sse: w.raw() };
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] } as any);

// ─────────────────────────────────────────────────────────────────────────────
// Which proxy is this?
// ─────────────────────────────────────────────────────────────────────────────

test("no workspace root means no agent loop — the proxy is a translator", async () => {
  // The CLI case. It keeps its own loop and its own tools; a proxy loop here
  // would be a second agent nobody asked for.
  const { result, native, llmCalls } = await run({ messages: [user("hi")] });

  assert.deepEqual(native.runs, []);
  assert.equal(llmCalls, 1, "the request was not forwarded");
  assert.equal(result.type, "json");
});

test("a workspace root on a tool-capable model runs Path A", async () => {
  const { result, native, llmCalls } = await run(
    { messages: [user("hi")] },
    { workspaceCwd: "/ws", maxTools: 8 },
  );

  assert.equal(native.runs.length, 1);
  assert.equal(native.runs[0].workspaceCwd, "/ws");
  assert.equal(llmCalls, 0, "Path A owns the LLM calls; the use case made one of its own");
  assert.deepEqual(result, { type: "handled", llmReachable: null });
});

test("a workspace root on a model with no tool support runs Path B", async () => {
  // maxTools === 0 is the probe saying the model cannot emit tool calls. Path B
  // strips tools from the request entirely, which is how it is told apart from
  // the plain forward below.
  const llm = llmFake({ stream: [delta({ content: "done" }), delta({}, "stop")] });
  const { result, native, sentToLlm } = await run(
    { messages: [user("hi")], tools: [{ name: "Read", input_schema: {} }] as any },
    { workspaceCwd: "/ws", maxTools: 0, llm },
  );

  assert.deepEqual(native.runs, [], "Path A ran on a model that cannot do tool calls");
  assert.equal(sentToLlm[0].tools, undefined, "Path B forwarded the tools it cannot use");
  assert.deepEqual(result, { type: "handled", llmReachable: null });
});

test("Path A falling through leaves the turn to the ordinary forward", async () => {
  // "fallthrough" means iteration 0 produced nothing. Returning early here
  // would hand the user silence.
  const { result, native, llmCalls, sentToLlm } = await run(
    { messages: [user("hi")] },
    { workspaceCwd: "/ws", maxTools: 8, nativeOutcome: "fallthrough" },
  );

  assert.equal(native.runs.length, 1);
  assert.equal(llmCalls, 1, "nobody answered the turn");
  assert.equal(sentToLlm[0].tools, undefined);
  assert.equal(result.type, "json");
});

// ─────────────────────────────────────────────────────────────────────────────
// The capability guard
// ─────────────────────────────────────────────────────────────────────────────

test("tools for a model that cannot use them, with no workspace, is a 400", async () => {
  // Not a silent pass-through: 0 means the model failed a one-tool probe, and
  // ToolManager reads 0 as "filtering off", so ~40 tools would reach it intact.
  const { result, llmCalls } = await run(
    { messages: [user("hi")], tools: [{ name: "Read", input_schema: {} }] as any },
    { maxTools: 0 },
  );

  assert.equal(result.type, "json");
  assert.equal((result as any).status, 400);
  assert.equal(llmCalls, 0, "the request was forwarded anyway");
});

test("the same model with no tools requested is forwarded normally", async () => {
  // The guard is about tools, not about the model: a plain question still works.
  const { result, llmCalls } = await run({ messages: [user("hi")] }, { maxTools: 0 });

  assert.equal(llmCalls, 1);
  assert.equal((result as any).status ?? 200, 200);
});

test("the guard does not fire when a workspace root is present", async () => {
  // With a workspace, maxTools === 0 has a meaning: it selects Path B.
  const llm = llmFake({ stream: [delta({ content: "ok" }), delta({}, "stop")] });
  const { result } = await run(
    { messages: [user("hi")], tools: [{ name: "Read", input_schema: {} }] as any },
    { workspaceCwd: "/ws", maxTools: 0, llm },
  );

  assert.equal(result.type, "handled");
});

// ─────────────────────────────────────────────────────────────────────────────
// The system prompt, and who gets it
// ─────────────────────────────────────────────────────────────────────────────

test("without a workspace the request keeps its own system prompt", async () => {
  // The CLI already has instructions of its own. Prepending Claudio's would
  // teach it about a workspace tool it does not have.
  const { body, prompt } = await run({ messages: [user("hi")], system: "CLI RULES" as any });

  assert.deepEqual(prompt.builds, []);
  assert.equal(body.system, "CLI RULES");
});

test("with a workspace and no system prompt, the agent prompt becomes it", async () => {
  const { body, prompt } = await run({ messages: [user("hi")] }, { workspaceCwd: "/ws" });

  assert.equal(body.system, prompt.text);
  assert.equal(prompt.builds[0].cwd, "/ws");
});

test("an existing string system prompt is kept, with the agent prompt in front", async () => {
  const { body, prompt } = await run(
    { messages: [user("hi")], system: "CALLER RULES" as any },
    { workspaceCwd: "/ws" },
  );

  assert.equal(body.system, `${prompt.text}\n\nCALLER RULES`);
});

test("a block-array system prompt gets the agent prompt as its first block", async () => {
  const { body, prompt } = await run(
    { messages: [user("hi")], system: [{ type: "text", text: "CALLER RULES" }] as any },
    { workspaceCwd: "/ws" },
  );

  assert.deepEqual(body.system, [
    { type: "text", text: prompt.text },
    { type: "text", text: "CALLER RULES" },
  ]);
});

test("the prompt builder is told which path the model is on", async () => {
  // Path B's prompt carries the textual tool manual; Path A's must not.
  const llm = llmFake({ stream: [delta({ content: "ok" }), delta({}, "stop")] });
  const b = await run({ messages: [user("hi")] }, { workspaceCwd: "/ws", maxTools: 0, llm });
  const a = await run({ messages: [user("hi")] }, { workspaceCwd: "/ws", maxTools: 8 });

  assert.equal(b.prompt.builds[0].textual, true);
  assert.equal(a.prompt.builds[0].textual, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Compaction
// ─────────────────────────────────────────────────────────────────────────────

test("compaction is given the model's real window", async () => {
  const { compaction } = await run(
    { messages: [user("hi")] },
    { modelInfo: modelInfoFake({ loadedContextLength: 8192 }) },
  );

  assert.deepEqual(compaction.budgets, [8192]);
});

test("with no model metadata the budget is zero, not a guess", async () => {
  // Zero is the compactor's "unknown": it trims nothing rather than trimming
  // against a number nobody measured.
  const { compaction } = await run({ messages: [user("hi")] }, { modelInfo: null });

  assert.deepEqual(compaction.budgets, [0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Slash commands
// ─────────────────────────────────────────────────────────────────────────────

test("a proxy-handled slash command answers without touching the LLM", async () => {
  const { result, llmCalls, sse } = await run({ messages: [user("/status")] });

  assert.equal(llmCalls, 0);
  assert.deepEqual(result, { type: "handled", llmReachable: null });
  assert.match(sse, /event: message_start/);
  assert.match(sse, /event: message_stop/);
});

test("the synthetic answer is a complete stream, not a fragment", async () => {
  // A client that is missing content_block_stop or message_delta hangs waiting.
  const { sse } = await run({ messages: [user("/status")] });

  for (const ev of ["message_start", "content_block_start", "content_block_delta",
                    "content_block_stop", "message_delta", "message_stop"]) {
    assert.match(sse, new RegExp(`event: ${ev}\\b`), `missing ${ev}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// What comes back from the backend
// ─────────────────────────────────────────────────────────────────────────────

test("an unreachable backend is reported as unreachable, with its status", async () => {
  const llm = llmFake({ ok: false, status: 503, errorText: "down" });
  const { result } = await run({ messages: [user("hi")] }, { llm });

  assert.equal(result.type, "json");
  assert.equal((result as any).status, 503);
  assert.equal(result.llmReachable, false);
});

test("a connection that never opened becomes a 502, not a status 0", async () => {
  // status 0 is "no HTTP happened at all". Passing it through would produce an
  // invalid response line.
  const llm = llmFake({ ok: false, status: 0, errorText: "ECONNREFUSED" });
  const { result } = await run({ messages: [user("hi")] }, { llm });

  assert.equal((result as any).status, 502);
  assert.equal(result.llmReachable, false);
});

test("a backend that ignores stream:true and answers JSON is still answered", async () => {
  // Not every OpenAI-compatible server streams. The turn is translated rather
  // than failed.
  const llm = llmFake({ json: { choices: [{ message: { content: "hello" }, finish_reason: "stop" }] } });
  const { result } = await run({ messages: [user("hi")], stream: true } as any, { llm });

  assert.equal(result.type, "json");
  assert.equal((result as any).status, 200);
  assert.equal(result.llmReachable, true);
  assert.equal((result as any).body.content[0].text, "hello");
});

test("a streaming answer is written to the wire and reported as handled", async () => {
  const llm = llmFake({ stream: [delta({ content: "hel" }), delta({ content: "lo" }), delta({}, "stop")] });
  const { result, sse } = await run({ messages: [user("hi")], stream: true } as any, { llm });

  assert.deepEqual(result, { type: "handled", llmReachable: true });
  assert.match(sse, /hel/);
  assert.match(sse, /event: message_stop/);
});

test("a response with neither a body nor JSON is a 502, not a hang", async () => {
  const llm: ReturnType<typeof llmFake> = {
    seen: [], calls: 1,
    llm: { async chat() { return { ok: true, status: 200 }; }, async ping() { return true; } },
  } as any;
  const { result } = await run({ messages: [user("hi")], stream: true } as any, { llm });

  assert.equal((result as any).status, 502);
  assert.equal(result.llmReachable, false);
});
