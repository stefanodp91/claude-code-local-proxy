/**
 * approval-e2e.ts — drive the real approval handshake against a real proxy.
 *
 * This is the extension's counterpart to `proxy/scripts/regression.sh`: it needs
 * a live backend and therefore cannot run in CI, and it answers a question no
 * unit test can. `test/chatSession.test.ts` proves the extension *would* answer
 * a `tool_request_pending` correctly; this proves that the proxy sends one, that
 * the id round-trips, that the action then actually runs, and that the model is
 * told what happened.
 *
 * It uses the shipped `ProxyClient` — the same code the extension runs — and
 * simulates only the human clicking a button.
 *
 * Usage:
 *
 *   1. Load a model in LM Studio.
 *   2. cd proxy && npm start          (leave it running, agent mode "ask")
 *   3. cd chat-extension && npx tsx scripts/approval-e2e.ts /tmp/some-workspace
 *
 * It writes files inside the workspace you point it at. Point it at a scratch
 * directory, not at anything you care about.
 *
 * Last run: 2026-08-27 against qwen/qwen3.8-27b — all four cases as expected.
 *
 * @module scripts/approval-e2e
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ProxyClient } from "../src/extension/proxy/proxy-client";
import type { ChatConfig } from "../src/extension/config/extension-config";
import type { ApprovalScope } from "../src/shared/message-protocol";

const WS = process.argv[2];
const PROXY = process.env["PROXY_URL"] ?? "http://127.0.0.1:5678";

if (!WS) {
  console.error("usage: npx tsx scripts/approval-e2e.ts <workspace-dir>");
  process.exit(1);
}

const client = new ProxyClient(PROXY);

const config = {
  proxyHost: "127.0.0.1", proxyPort: 5678, temperature: 0.7, systemPrompt: "",
  enableThinking: false, maxTokens: 900, locale: "en", agentMode: "ask", modelInfo: null,
} as unknown as ChatConfig;

type Decision = (modalNumber: number, payload: any) => { approved: boolean; scope: ApprovalScope };

/** Run one turn, answering every approval modal with `decide`. */
async function turn(prompt: string, decide: Decision) {
  let modals = 0;
  let text = "";
  const actions: string[] = [];

  for await (const evt of client.sendMessage({
    messages: [{ role: "user", content: prompt }] as any,
    config,
    workspaceRoot: WS,
  })) {
    if (evt.event === "tool_request_pending") {
      const payload = JSON.parse(evt.data);
      modals++;
      actions.push(`${payload.action} ${payload.params?.path ?? payload.params?.cmd ?? ""}`.trim());
      const d = decide(modals, payload);
      await client.approve(payload.request_id, d.approved, d.scope);
    }
    if (evt.event === "content_block_delta") {
      const d = JSON.parse(evt.data);
      if (d.delta?.type === "text_delta") text += d.delta.text;
    }
  }

  return { modals, actions, text: text.trim().replace(/\s+/g, " ") };
}

const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${detail}`);
  return ok;
};

async function main() {
  if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
  for (const f of ["hello.txt", "denied.txt", "a.txt", "b.txt"]) {
    rmSync(join(WS, f), { force: true });
  }

  let allPassed = true;

  const allow = await turn(
    "Create a file called hello.txt containing exactly: ciao",
    () => ({ approved: true, scope: "once" }),
  );
  allPassed = check(
    "an approved write raises one modal and lands on disk",
    allow.modals === 1 && existsSync(join(WS, "hello.txt")),
    `modals=${allow.modals} actions=[${allow.actions}] file=${existsSync(join(WS, "hello.txt"))}`,
  ) && allPassed;

  const denied = await turn(
    "Create a file called denied.txt containing: nope",
    () => ({ approved: false, scope: "once" }),
  );
  allPassed = check(
    "a denied write writes nothing, and the model is told",
    denied.modals === 1 && !existsSync(join(WS, "denied.txt")) && /deni|not creat/i.test(denied.text),
    `file=${existsSync(join(WS, "denied.txt"))} answer="${denied.text.slice(0, 90)}"`,
  ) && allPassed;

  const turnScope = await turn(
    "Create two files: a.txt containing A, and b.txt containing B. Use one action per file.",
    () => ({ approved: true, scope: "turn" }),
  );
  allPassed = check(
    "scope=turn asks once and covers the rest of the turn",
    turnScope.modals === 1 && existsSync(join(WS, "a.txt")) && existsSync(join(WS, "b.txt")),
    `modals=${turnScope.modals} a=${existsSync(join(WS, "a.txt"))} b=${existsSync(join(WS, "b.txt"))}`,
  ) && allPassed;

  await client.approve("id-the-proxy-never-issued", true, "once");
  allPassed = check("an unknown approval id neither throws nor hangs", true, "returned") && allPassed;

  console.log(allPassed ? "\nall four as expected" : "\nsomething changed — read the FAILs above");
  process.exit(allPassed ? 0 : 1);
}

void main();
