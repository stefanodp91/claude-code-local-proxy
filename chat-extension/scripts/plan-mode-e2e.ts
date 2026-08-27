/**
 * plan-mode-e2e.ts — drive plan mode end to end against a real proxy.
 *
 * The flow crosses both packages and cannot be unit-tested as one piece: the
 * proxy forces a tool call until a plan exists, auto-approves the write into
 * `.claudio/plans/`, emits `plan_file_created` and then
 * `plan_mode_exit_suggestion`; Claudio shows a modal, switches mode, and re-runs
 * the turn with `x-plan-exit-path`; the proxy reads that plan back and puts it
 * in front of the model with an instruction to carry it out.
 *
 * The last step is why this script exists. Before 2026-08-27 the plan was
 * prepended with no instruction, and the model — measured, not guessed — read
 * it and explained it back, changing nothing. Nothing failed; the user simply
 * approved a plan and got a summary of it.
 *
 * Usage (LM Studio loaded, proxy running):
 *
 *   cd chat-extension && npx tsx scripts/plan-mode-e2e.ts /tmp/scratch-ws
 *
 * It writes inside the workspace you point it at. Use a scratch directory.
 *
 * @module scripts/plan-mode-e2e
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProxyClient } from "../src/extension/proxy/proxy-client";
import type { ChatConfig } from "../src/extension/config/extension-config";

const WS = process.argv[2];
const PROXY = process.env["PROXY_URL"] ?? "http://127.0.0.1:5678";

if (!WS) {
  console.error("usage: npx tsx scripts/plan-mode-e2e.ts <workspace-dir>");
  process.exit(1);
}

const client = new ProxyClient(PROXY);
const config = {
  proxyHost: "127.0.0.1", proxyPort: 5678, temperature: 0.7, systemPrompt: "",
  enableThinking: false, maxTokens: 1200, locale: "en", agentMode: "plan", modelInfo: null,
} as unknown as ChatConfig;

const TASK = "Add a function called titleCase to src/util.ts";
const SEED = 'export function slugify(s: string): string {\n  return s.toLowerCase().replace(/ /g, "-");\n}\n';

async function turn(planExitPath?: string) {
  const events = new Set<string>();
  let text = "";
  let planPath: string | null = null;
  const actions: string[] = [];

  for await (const evt of client.sendMessage({
    messages: [{ role: "user", content: TASK }] as any,
    config,
    workspaceRoot: WS,
    planExitPath,
  })) {
    events.add(evt.event);
    if (evt.event === "plan_file_created") planPath = JSON.parse(evt.data).path;
    if (evt.event === "tool_request_pending") {
      const p = JSON.parse(evt.data);
      await client.approve(p.request_id, true, "turn");
    }
    if (evt.event === "content_block_delta") {
      const d = JSON.parse(evt.data);
      if (d.delta?.type === "text_delta") text += d.delta.text;
      if (d.delta?.type === "input_json_delta") actions.push(d.delta.partial_json);
    }
  }

  return { events, text: text.trim().replace(/\s+/g, " "), planPath, actions: actions.join("") };
}

const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${detail}`);
  return ok;
};

async function main() {
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(join(WS, "src"), { recursive: true });
  writeFileSync(join(WS, "src", "util.ts"), SEED);

  let passed = true;

  console.log("agent mode:", await client.setAgentMode("plan"));

  // Plan mode is model-dependent, measurably so: across runs this model has
  // written a plan and stopped, written a plan and called exit_plan_mode, and
  // called exit_plan_mode straight away without writing anything. The proxy
  // handles all three; only the first two let this script check what happens
  // *after* a plan, so it retries rather than reporting a flow failure for what
  // is a model's choice.
  const ATTEMPTS = 3;
  let planning = await turn();
  let attempt = 1;
  while (planning.planPath === null && attempt < ATTEMPTS) {
    console.log(`      no plan on attempt ${attempt} (model chose not to write one) — retrying`);
    attempt++;
    planning = await turn();
  }

  passed = check(
    "plan mode writes a plan and announces it",
    planning.planPath !== null,
    `plan=${planning.planPath} attempts=${attempt}/${ATTEMPTS} events=[${[...planning.events].join(",")}]`,
  ) && passed;

  passed = check(
    "plan mode changes nothing in the workspace itself",
    readFileSync(join(WS, "src", "util.ts"), "utf-8") === SEED,
    "src/util.ts untouched",
  ) && passed;

  // The model does not always call exit_plan_mode — it sometimes tells the user
  // to switch modes in prose instead. Reported, not asserted: it is model
  // behaviour, and the proxy handles both.
  console.log(
    `${planning.events.has("plan_mode_exit_suggestion") ? "NOTE" : "NOTE"}  ` +
    `exit_plan_mode ${planning.events.has("plan_mode_exit_suggestion") ? "was" : "was NOT"} called this run`,
  );

  if (!planning.planPath) {
    console.log("\nno plan file — nothing further to check");
    process.exit(1);
  }

  console.log("\nagent mode:", await client.setAgentMode("auto"));
  const executing = await turn(planning.planPath);
  const after = readFileSync(join(WS, "src", "util.ts"), "utf-8");

  passed = check(
    "leaving plan mode executes the plan instead of restating it",
    /titleCase/.test(after),
    `src/util.ts ${/titleCase/.test(after) ? "now defines titleCase" : "is unchanged"} · answer="${executing.text.slice(0, 80)}"`,
  ) && passed;

  passed = check(
    "the original file is still there — the plan was applied, not overwritten",
    /slugify/.test(after),
    "slugify still defined",
  ) && passed;

  await client.setAgentMode("ask");
  console.log(passed ? "\nplan mode works end to end" : "\nsomething changed — read the FAILs above");
  process.exit(passed ? 0 : 1);
}

void main();
