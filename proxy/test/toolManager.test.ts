/**
 * toolManager.test.ts — Dynamic tool selection, overflow, and promotion decay.
 *
 * What decides which ~6 of Claude Code's ~40 tools a local model actually gets
 * to see. Everything here fails quietly by construction: the model is simply
 * never offered the tool it needed, answers as best it can, and nothing
 * anywhere reports that a capability was withheld.
 *
 * The suite uses the real default weights rather than round test numbers,
 * because the interesting behaviour is in how they compare — 10 for a core
 * tool against 8 for a promoted one is the difference between promotion working
 * and promotion being decorative, and a test built on 1/2/3 would prove nothing
 * about the configuration people actually run.
 *
 * @module test/toolManager
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ToolManager, type ToolManagerConfig } from "../src/application/toolManager";
import { loadLocale } from "../src/infrastructure/i18nLoader";
import { Locale, OpenAIToolType, USE_TOOL_NAME, type OpenAITool } from "../src/domain/types";

// The UseTool description is built through t(). Without a locale loaded it
// comes back as the bare key `useTool.description` and the overflow listing
// never appears — the assertions would pass or fail for the wrong reason.
// Loading the real file also means these tests exercise the real template.
before(() => loadLocale(Locale.EnUS));

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** The shipped defaults, from infrastructure/config.ts. */
const DEFAULTS: ToolManagerConfig = {
  coreTools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  scoreCoreTools: 10,
  scorePromoted: 8,
  scoreUsedInHistory: 5,
  scoreForcedChoice: 20,
  promotionMaxAge: 10,
  useToolDescMaxLength: 80,
};

function tool(name: string, description = `${name} does things`): OpenAITool {
  return {
    type: OpenAIToolType.Function,
    function: { name, description, parameters: { type: "object", properties: {} } },
  };
}

/** The six core tools plus however many extras are asked for. */
function toolset(extras: string[] = []): OpenAITool[] {
  return [...DEFAULTS.coreTools, ...extras].map((n) => tool(n));
}

function manager(maxTools: number, over: Partial<ToolManagerConfig> = {}) {
  return new ToolManager(maxTools, { ...DEFAULTS, ...over });
}

/**
 * A limit the six core tools already exceed, so `selectTools` always filters.
 *
 * Named rather than inlined because the boundary is `allTools.length <= maxTools`
 * and getting it wrong costs nothing visible: the call returns everything, the
 * assertion that the tool is present passes, and the test proves nothing. Four
 * tests in this file did exactly that before the limit was pinned here.
 */
const LIMIT = 4;

const names = (tools: OpenAITool[]) => tools.map((t) => t.function.name);

/** An assistant turn that called `toolName`, as it appears in the history. */
function historyWith(toolName: string) {
  return [{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: toolName, input: {} }] }];
}

// ─────────────────────────────────────────────────────────────────────────────
// When no filtering is needed
// ─────────────────────────────────────────────────────────────────────────────

test("a tool set within the limit passes through untouched", () => {
  const tools = toolset();
  const sel = manager(10).selectTools(tools, []);

  assert.deepEqual(sel.tools, tools);
  assert.deepEqual(sel.overflow, []);
  assert.equal(sel.useToolDef, null, "no meta-tool when nothing overflowed");
});

test("exactly at the limit is still not filtering", () => {
  // 6 tools, limit 6. Reserving a UseTool slot here would evict a tool to
  // describe an overflow that does not exist.
  const sel = manager(6).selectTools(toolset(), []);
  assert.equal(sel.tools.length, 6);
  assert.equal(sel.useToolDef, null);
});

test("a limit of zero means no limit here, whatever it means to the probe", () => {
  // The probe emits 0 for "this model cannot call tools at all" — the opposite
  // reading. Requests that would hit the contradiction are refused upstream by
  // the capability guard, so a 0 arriving here can only be an explicit
  // MAX_TOOLS=0 override, where "unlimited" is what was meant.
  const tools = toolset(["Agent", "WebSearch", "TodoWrite"]);
  const sel = manager(0).selectTools(tools, []);

  assert.deepEqual(sel.tools, tools);
  assert.equal(sel.useToolDef, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Overflow
// ─────────────────────────────────────────────────────────────────────────────

test("over the limit, exactly maxTools go out and UseTool takes the last slot", () => {
  const sel = manager(7).selectTools(toolset(["Agent", "WebSearch", "TodoWrite"]), []);

  assert.equal(sel.tools.length, 7, "the budget is the budget");
  assert.equal(names(sel.tools).at(-1), USE_TOOL_NAME);
  assert.equal(sel.overflow.length, 3);
});

test("nothing is lost: every tool is either sent or reachable through UseTool", () => {
  const all = toolset(["Agent", "WebSearch", "TodoWrite", "NotebookEdit"]);
  const sel = manager(7).selectTools(all, []);

  const reachable = [...names(sel.tools).filter((n) => n !== USE_TOOL_NAME), ...names(sel.overflow)];
  assert.deepEqual(reachable.sort(), names(all).sort());
});

test("the overflow tools are listed in the UseTool description", () => {
  const sel = manager(LIMIT).selectTools(toolset(["Agent", "WebSearch"]), []);

  assert.equal(sel.overflow.length > 0, true, "guard: nothing overflowed");
  for (const name of names(sel.overflow)) {
    assert.equal(sel.useToolDef!.function.description!.includes(name), true, `${name} missing from the listing`);
  }
});

test("long descriptions are truncated per tool", () => {
  const long = "x".repeat(500);
  const sel = manager(LIMIT, { useToolDescMaxLength: 20, coreTools: [] })
    .selectTools([...toolset(), tool("Agent", long)], []);

  assert.equal(sel.useToolDef!.function.description!.includes("x".repeat(20)), true);
  assert.equal(sel.useToolDef!.function.description!.includes("x".repeat(21)), false);
});

test("UseTool demands both a tool name and a parameters object", () => {
  const sel = manager(LIMIT).selectTools(toolset(), []);
  const params = sel.useToolDef!.function.parameters as any;

  assert.deepEqual(params.required, ["tool_name", "parameters"]);
  assert.equal(params.properties.tool_name.type, "string");
});

test("with a limit of one, only UseTool is sent", () => {
  // Degenerate but reachable: a model that the probe found could handle a
  // single tool. Every real tool moves behind the meta-tool.
  const sel = manager(1).selectTools(toolset(), []);

  assert.deepEqual(names(sel.tools), [USE_TOOL_NAME]);
  assert.equal(sel.overflow.length, 6);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

test("core tools win the slots when nothing else scores", () => {
  const sel = manager(7).selectTools(toolset(["Agent", "WebSearch", "TodoWrite"]), []);

  assert.deepEqual(names(sel.tools).slice(0, 6).sort(), [...DEFAULTS.coreTools].sort());
  assert.deepEqual(names(sel.overflow).sort(), ["Agent", "TodoWrite", "WebSearch"]);
});

test("a tool used earlier in the conversation is kept over an unused one", () => {
  const sel = manager(LIMIT, { coreTools: [] })
    .selectTools(toolset(["Agent"]), historyWith("Agent"));

  assert.equal(names(sel.tools).includes("Agent"), true);
  assert.equal(sel.useToolDef !== null, true, "guard: this request must actually filter");
});

test("the forced tool outranks everything, core tools included", () => {
  // tool_choice cannot be enforced on the wire for this backend — the name is
  // dropped in favour of "required" — so scoring it to the top is the only
  // thing that makes a named choice mean anything at all.
  const sel = manager(LIMIT).selectTools(toolset(["Agent"]), [], "Agent");

  assert.equal(names(sel.tools).includes("Agent"), true);
  assert.equal(
    names(sel.overflow).some((n) => DEFAULTS.coreTools.includes(n)),
    true,
    "a core tool gave up its slot for it",
  );
});

test("scores are additive, and that is what makes promotion effective", () => {
  // A promoted tool scores 8 against a core tool's 10, so promotion alone never
  // displaces one at default weights. Promoted *and* seen in history is 13, and
  // that does. Since using a tool through UseTool puts it in the history too,
  // the intended path works — but it works because the two bonuses stack, not
  // because promotion is strong enough on its own.
  const promotedOnly = manager(LIMIT);
  promotedOnly.rewriteUseToolCall('{"tool_name":"Agent","parameters":{}}');
  assert.equal(
    names(promotedOnly.selectTools(toolset(["Agent"]), []).tools).includes("Agent"),
    false,
    "8 < 10: promotion alone loses to a core tool",
  );

  const promotedAndUsed = manager(LIMIT);
  promotedAndUsed.rewriteUseToolCall('{"tool_name":"Agent","parameters":{}}');
  assert.equal(
    names(promotedAndUsed.selectTools(toolset(["Agent"]), historyWith("Agent")).tools).includes("Agent"),
    true,
    "8 + 5 > 10: the two together do",
  );
});

test("ties keep the order the client sent them in", () => {
  // Claude Code orders its tools deliberately. With nothing to separate them,
  // that order is the only signal left, and a sort that scrambled it would
  // silently reshuffle the tool set from one request to the next.
  const alphabet = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"];
  const sel = manager(5, { coreTools: [] }).selectTools(alphabet.map((n) => tool(n)), []);

  // Both halves, and their exact order: a reshuffle that happened to keep the
  // right tools would still be a reshuffle, and the first two positions alone
  // survive several ways of breaking the sort.
  assert.deepEqual(names(sel.tools).slice(0, 4), ["Alpha", "Beta", "Gamma", "Delta"]);
  assert.deepEqual(names(sel.overflow), ["Epsilon", "Zeta", "Eta", "Theta"]);
});

test("history only counts tool_use blocks, not text that mentions a tool", () => {
  const messages = [
    { role: "user", content: "please use Agent for this" },
    { role: "assistant", content: [{ type: "text", text: "I will call Agent" }] },
  ];
  const sel = manager(LIMIT, { coreTools: [] }).selectTools(toolset(["Agent"]), messages);

  assert.equal(names(sel.overflow).includes("Agent"), true, "prose is not a tool call");
});

// ─────────────────────────────────────────────────────────────────────────────
// UseTool call rewriting
// ─────────────────────────────────────────────────────────────────────────────

test("a well-formed UseTool call yields the real name and parameters", () => {
  const rewritten = manager(7).rewriteUseToolCall('{"tool_name":"Grep","parameters":{"pattern":"TODO"}}');
  assert.deepEqual(rewritten, { name: "Grep", input: { pattern: "TODO" } });
});

test("a UseTool call with no parameters yields an empty input, not undefined", () => {
  assert.deepEqual(manager(7).rewriteUseToolCall('{"tool_name":"Grep"}')?.input, {});
});

test("malformed or incomplete UseTool arguments rewrite to null", () => {
  const tm = manager(7);
  assert.equal(tm.rewriteUseToolCall("{not json"), null);
  assert.equal(tm.rewriteUseToolCall('{"parameters":{}}'), null, "no tool_name");
  assert.equal(tm.rewriteUseToolCall('{"tool_name":42}'), null, "tool_name must be a string");
  assert.equal(tm.rewriteUseToolCall('{"tool_name":""}'), null, "an empty name is not a name");
});

test("only the meta-tool counts as a UseTool call", () => {
  const tm = manager(7);
  assert.equal(tm.isUseToolCall(USE_TOOL_NAME), true);
  assert.equal(tm.isUseToolCall("Grep"), false);
  assert.equal(tm.isUseToolCall("useTool"), false, "the check is exact, not case-folded");
});

// ─────────────────────────────────────────────────────────────────────────────
// Promotion decay
// ─────────────────────────────────────────────────────────────────────────────

test("a promotion expires after promotionMaxAge filtered requests", () => {
  const tm = manager(LIMIT, { promotionMaxAge: 2, coreTools: [] });
  tm.rewriteUseToolCall('{"tool_name":"Agent","parameters":{}}');

  const survives = () => names(tm.selectTools(toolset(["Agent"]), []).tools).includes("Agent");

  assert.equal(survives(), true, "request 1");
  assert.equal(survives(), true, "request 2");
  assert.equal(survives(), false, "request 3 — aged out");
});

test("using a tool again through UseTool resets its age", () => {
  const tm = manager(LIMIT, { promotionMaxAge: 2, coreTools: [] });
  tm.rewriteUseToolCall('{"tool_name":"Agent","parameters":{}}');

  tm.selectTools(toolset(["Agent"]), []);
  tm.rewriteUseToolCall('{"tool_name":"Agent","parameters":{}}'); // used again
  tm.selectTools(toolset(["Agent"]), []);
  tm.selectTools(toolset(["Agent"]), []);

  assert.equal(
    names(tm.selectTools(toolset(["Agent"]), []).tools).includes("Agent"),
    false,
    "the clock restarts, it does not stop",
  );
});

test("ageing happens only on requests that actually filter", () => {
  // agePromotions() sits after the early return, so a run of small requests
  // does not burn a promotion's lifetime. Worth pinning: the docstring says
  // "once per request", and the difference only shows up in a session that
  // mixes filtered and unfiltered turns.
  const tm = manager(LIMIT, { promotionMaxAge: 1, coreTools: [] });
  tm.rewriteUseToolCall('{"tool_name":"Agent","parameters":{}}');

  const small = [tool("Bash"), tool("Read")]; // under LIMIT: nothing to filter
  for (let i = 0; i < 5; i++) tm.selectTools(small, []);

  const sel = tm.selectTools(toolset(["Agent"]), []);
  assert.equal(sel.useToolDef !== null, true, "guard: this request must actually filter");
  assert.equal(names(sel.tools).includes("Agent"), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// The limit itself
// ─────────────────────────────────────────────────────────────────────────────

test("the limit can be raised after a late probe result", () => {
  const tm = manager(7);
  assert.equal(tm.limit, 7);

  tm.limit = 32;
  assert.equal(tm.selectTools(toolset(["Agent", "WebSearch"]), []).useToolDef, null);
});
