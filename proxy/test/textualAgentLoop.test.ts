/**
 * textualAgentLoop.test.ts — Path B, for models with no native tool calls.
 *
 * The model writes `<action …/>` tags into ordinary prose; the loop intercepts
 * them mid-stream, emits them as Anthropic `tool_use` blocks so the client
 * cannot tell which path is running, executes them, and feeds the result back
 * as an `<observation>` turn.
 *
 * Two things make this worth testing carefully. The tag parser runs over a
 * *stream*, so a tag split across chunk boundaries has to survive — and the
 * grammar it accepts has to be the one `TEXTUAL_TOOL_MANUAL` teaches the model,
 * because those two are written in different places and nothing checks that
 * they agree. When they disagree the model does exactly as instructed and the
 * action silently does not happen.
 *
 * The suite drives the real loop with a scripted LLM and a real temporary
 * workspace, and asserts on both what reached the client and what reached disk.
 *
 * @module test/textualAgentLoop
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTextualAgentLoop, type TextualApprovalGate } from "../src/application/textualAgentLoop";
import { silentLogger } from "./fakes";
import type { LlmClientPort, SseWriterPort } from "../src/domain/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "claudio-textual-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

interface Event { type: string; data: any }

/**
 * An LLM that replies with the given turns in order. Each turn is a list of
 * text chunks, so a test can put a chunk boundary exactly where it wants one.
 */
function scriptedLlm(turns: string[][]) {
  const seen: any[][] = [];
  let turn = 0;

  const llm: LlmClientPort = {
    async chat({ body }) {
      seen.push(body.messages);
      const chunks = turns[Math.min(turn++, turns.length - 1)];
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            for (const text of chunks) {
              c.enqueue(encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
              ));
            }
            c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
            c.enqueue(encoder.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
      };
    },
    async ping() { return true; },
  };

  return { llm, seen, get turns() { return turn; } };
}

function collectingWriter() {
  let raw = "";
  const writer: SseWriterPort = {
    writeHeaders() {},
    writeRaw: (frame) => { raw += frame; },
    end() {},
    get isClosed() { return false; },
  };
  return { writer, events: () => parse(raw) };
}

function parse(raw: string): Event[] {
  const out: Event[] = [];
  for (const frame of raw.split("\n\n")) {
    const line = frame.trim();
    if (!line) continue;
    const [ev, data] = line.split("\n");
    try {
      out.push({ type: ev.replace("event: ", ""), data: JSON.parse(data.replace("data: ", "")) });
    } catch { /* not an SSE frame we care about */ }
  }
  return out;
}

/** Run the loop over a scripted conversation. Approves everything by default. */
async function drive(turns: string[][], gate?: TextualApprovalGate) {
  const { writer, events } = collectingWriter();
  const scripted = scriptedLlm(turns);
  const approve: TextualApprovalGate = gate ?? (async () => ({ approved: true, scope: "once" }));

  await runTextualAgentLoop(
    writer,
    { model: "m", messages: [{ role: "user", content: "go" }] },
    ws,
    false,
    scripted.llm,
    "local-model",
    silentLogger,
    approve,
  );

  return { events: events(), sentToModel: scripted.seen, turns: scripted.turns };
}

const textOf = (events: Event[]) =>
  events.filter((e) => e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");

const toolUses = (events: Event[]) =>
  events.filter((e) => e.data?.content_block?.type === "tool_use").map((e) => e.data.content_block);

const read = (rel: string) => readFileSync(join(ws, rel), "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// Plain answers
// ─────────────────────────────────────────────────────────────────────────────

test("a turn with no action tag is forwarded as text and ends", async () => {
  const { events, turns } = await drive([["The answer ", "is 42."]]);

  assert.equal(textOf(events), "The answer is 42.");
  assert.equal(turns, 1, "no action means no second call to the model");
  assert.equal(events.at(-1)?.type, "message_stop");
});

test("the client is never told which path produced the answer", async () => {
  const { events } = await drive([["hi"]]);
  const types = events.map((e) => e.type);

  assert.equal(types[0], "message_start");
  assert.equal(types.includes("message_delta"), true);
  assert.equal(types.at(-1), "message_stop");
});

// ─────────────────────────────────────────────────────────────────────────────
// Read-only actions
// ─────────────────────────────────────────────────────────────────────────────

test("a read action is executed and its result fed back as an observation", async () => {
  writeFileSync(join(ws, "a.ts"), "file body");

  const { events, sentToModel, turns } = await drive([
    ['Let me look. <action name="read" path="a.ts"/>'],
    ["It says: file body"],
  ]);

  assert.equal(turns, 2, "the loop continues after an action");
  assert.deepEqual(toolUses(events).map((b) => b.name), ["workspace"]);

  const observation = JSON.stringify(sentToModel[1]);
  assert.match(observation, /observation/);
  assert.match(observation, /file body/);
});

test("text before the tag reaches the client, the tag itself does not", async () => {
  writeFileSync(join(ws, "a.ts"), "x");
  const { events } = await drive([['Checking now. <action name="read" path="a.ts"/>'], ["done"]]);

  assert.match(textOf(events), /Checking now\./);
  assert.equal(textOf(events).includes("<action"), false, "the tag is protocol, not prose");
});

test("a tag split across chunk boundaries is still recognised", async () => {
  // The parser holds back a lookahead tail precisely so a tag arriving in
  // pieces is not flushed as prose. One chunk per character is the extreme
  // case of what the network can do.
  writeFileSync(join(ws, "a.ts"), "x");
  const tag = '<action name="read" path="a.ts"/>';

  const { events, turns } = await drive([[...tag.split("")], ["done"]]);

  assert.equal(turns, 2);
  assert.equal(toolUses(events).length, 1);
  assert.equal(textOf(events).includes("<action"), false);
});

test("prose that merely mentions an action tag is not executed", async () => {
  const { events, turns } = await drive([["You could write <action name=\"bash\" cmd=\"rm -rf /\" but I will not"]]);

  // No `/>` — the tag never closes, so nothing runs. It comes back as text.
  assert.equal(turns, 1);
  assert.equal(toolUses(events).length, 0);
});

test("a malformed tag is shown as text rather than executed", async () => {
  const { events, turns } = await drive([['<action nome="read" path="a.ts"/> oops']]);

  assert.equal(toolUses(events).length, 0);
  assert.equal(turns, 1);
  assert.match(textOf(events), /<action nome=/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The grammar the manual teaches
// ─────────────────────────────────────────────────────────────────────────────

test("edit works in the form the tool manual documents", async () => {
  // TEXTUAL_TOOL_MANUAL teaches:
  //   <action name="edit" path="…" old_string="…" new_string="…"/>
  // If the parser does not read those two attributes, a model following its
  // instructions exactly gets "Error: 'old_string' is required" every time,
  // and Path B simply cannot edit a file.
  writeFileSync(join(ws, "a.ts"), "const x = 1");

  await drive([
    ['<action name="edit" path="a.ts" old_string="const x = 1" new_string="const x = 2"/>'],
    ["done"],
  ]);

  assert.equal(read("a.ts"), "const x = 2");
});

test("write works in the form the tool manual documents", async () => {
  // The manual teaches a body form closed by </action>, not a self-closing tag:
  //   <action name="write" path="hello.txt">
  //   hi
  //   </action>
  await drive([['<action name="write" path="hello.txt">\nhi\n</action>'], ["done"]]);

  assert.equal(read("hello.txt").trim(), "hi");
});

test("what the model is taught and what the parser accepts do not drift apart", async () => {
  // The manual is a string constant in one file and the parser is a state
  // machine in another. Nothing but this test connects them, and every example
  // in the manual is a promise made to the model.
  const { TEXTUAL_TOOL_MANUAL, parseActionTag } = await import("../src/application/textualAgentLoop");

  // Every attribute the manual writes inside an <action …> tag, asked of the
  // parser directly. Deriving the accepted set from the parser rather than from
  // a list written here is the whole point: a hardcoded list passes at exactly
  // the moment it should fail.
  const taught = new Set(
    [...TEXTUAL_TOOL_MANUAL.matchAll(/<action[^>]*>/g)]
      .flatMap((tag) => [...tag[0].matchAll(/(\w+)="/g)].map((m) => m[1])),
  );

  for (const attr of taught) {
    if (attr === "name") continue;
    const parsed = parseActionTag(`<action name="read" ${attr}="value"/>`);
    assert.equal(
      parsed?.[attr],
      "value",
      `the manual teaches ${attr}="…" but parseActionTag never reads it`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Approval
// ─────────────────────────────────────────────────────────────────────────────

test("a destructive action is gated before it touches disk", async () => {
  const asked: string[] = [];
  await drive(
    [['<action name="bash" cmd="touch new.txt"/>'], ["done"]],
    async (action) => { asked.push(action); return { approved: false, scope: "once" }; },
  );

  assert.deepEqual(asked, ["bash"]);
  assert.throws(() => read("new.txt"), "a denied command must not have run");
});

test("a denial is reported back to the model, not swallowed", async () => {
  const { sentToModel } = await drive(
    [['<action name="bash" cmd="touch new.txt"/>'], ["understood"]],
    async () => ({ approved: false, scope: "once" }),
  );

  assert.match(JSON.stringify(sentToModel[1]), /deni|refus|not approved/i);
});

test("read-only actions are never gated", async () => {
  writeFileSync(join(ws, "a.ts"), "x");
  const asked: string[] = [];

  await drive(
    [['<action name="read" path="a.ts"/>'], ["done"]],
    async (action) => { asked.push(action); return { approved: true, scope: "once" }; },
  );

  assert.deepEqual(asked, [], "asking to read would make the loop unusable");
});

test("approving for the turn stops the loop asking again", async () => {
  const asked: string[] = [];
  await drive(
    [
      ['<action name="bash" cmd="touch a.txt"/>'],
      ['<action name="bash" cmd="touch b.txt"/>'],
      ["done"],
    ],
    async (action) => { asked.push(action); return { approved: true, scope: "turn" }; },
  );

  assert.equal(asked.length, 1, "'allow for this turn' has to mean the turn");
  assert.equal(read("b.txt"), "", "the second command ran without being asked about");
});

// ─────────────────────────────────────────────────────────────────────────────
// Loop control
// ─────────────────────────────────────────────────────────────────────────────

test("the loop stops on its own when the model stops emitting actions", async () => {
  writeFileSync(join(ws, "a.ts"), "x");
  const { turns } = await drive([
    ['<action name="read" path="a.ts"/>'],
    ['<action name="read" path="a.ts"/>'],
    ["I have what I need."],
  ]);

  assert.equal(turns, 3);
});

test("a model that never stops is cut off and the client is told", async () => {
  // Without a ceiling this is an infinite loop against a paid-for-by-electricity
  // backend. The cut-off has to be visible, not just a stream that stops.
  writeFileSync(join(ws, "a.ts"), "x");
  const { events, turns } = await drive([['<action name="read" path="a.ts"/>']]);

  assert.equal(turns <= 12, true, `ran ${turns} iterations`);
  assert.match(textOf(events), /iteration|limit|max/i);
  assert.equal(events.at(-1)?.type, "message_stop", "the stream still has to close properly");
});

test("an LLM error ends the turn cleanly instead of hanging the client", async () => {
  const { writer, events } = collectingWriter();
  const llm: LlmClientPort = {
    async chat() { return { ok: false, status: 500, errorText: "backend on fire" }; },
    async ping() { return true; },
  };

  await runTextualAgentLoop(
    writer, { model: "m", messages: [] }, ws, false, llm, "local-model", silentLogger,
    async () => ({ approved: true, scope: "once" }),
  );

  const out = events();
  assert.equal(out.at(-1)?.type, "message_stop");
  assert.match(JSON.stringify(out), /500|fire|error/i);
});
