/**
 * chatSession.test.ts — the approval bridge, which is two processes and a
 * protocol wide.
 *
 * The proxy suspends a turn and emits `tool_request_pending`; the extension has
 * to raise a modal, hold the turn open while a human thinks, and POST the answer
 * back to the right request id. The proxy will wait five minutes and then deny.
 * Every way this breaks is quiet:
 *
 *   - the modal never appears → the turn hangs until the proxy's timeout, and
 *     the user sees a spinner and then a denial they never made;
 *   - the answer goes to the wrong id → same;
 *   - the scope is dropped → "allow for this turn" silently becomes "allow
 *     once", and the user is asked again three seconds later;
 *   - a stale answer resolves a request that already timed out → the *next*
 *     approval is decided by the previous click.
 *
 * The handshake was verified end to end against a real proxy and model on
 * 2026-08-27 (`scripts/approval-e2e.ts`). These tests are what keep it working
 * without one.
 *
 * `vscode` resolves to `test/stubs/vscode.ts` here and nowhere else — see
 * `tsconfig.test.json`. `npm run typecheck` still checks the host against the
 * real API.
 *
 * @module test/chatSession
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ChatSession } from "../src/extension/chat-session";
import {
  ToExtensionType,
  ToWebviewType,
  type ToWebviewMessage,
  type ToExtensionMessage,
} from "../src/shared/message-protocol";
import { Uri, resetRecorded } from "./stubs/vscode";

const realFetch = globalThis.fetch;
const live: ChatSession[] = [];

beforeEach(() => { resetRecorded(); });
afterEach(() => {
  // Disposed *before* the real fetch is restored: disposing denies any pending
  // approval, which posts it to the proxy, and that POST has to land on the fake
  // rather than on whatever is — or is not — listening on port 5678.
  //
  // Disposed here rather than at the end of each test, so a *failing* test
  // cannot leave a session, or its five-minute approval timeout, behind. That is
  // what hung CI for half an hour the first time this suite ran there.
  for (const s of live.splice(0)) s.dispose();
  globalThis.fetch = realFetch;
});

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface Wire {
  approvals: { url: string; body: any }[];
  toWebview: ToWebviewMessage[];
  send: (msg: ToExtensionMessage) => void;
}

/**
 * A session with a fake webview attached and a fake proxy answering.
 *
 * `frames` is the SSE the proxy sends for the turn; anything POSTed to an
 * `/approve` endpoint is recorded instead of being sent.
 */
function session(frames: string[]): { session: ChatSession; wire: Wire } {
  const approvals: { url: string; body: any }[] = [];
  const toWebview: ToWebviewMessage[] = [];
  let receive: ((msg: ToExtensionMessage) => void) | null = null;

  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/approve")) {
      approvals.push({ url: u, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }
    if (u.includes("/agent-mode") || u.includes("/config") || u.includes("/commands") || u.includes("/health")) {
      return { ok: true, status: 200, json: async () => ({ mode: "ask" }) } as any;
    }
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            i < frames.length
              ? { done: false, value: enc.encode(frames[i++]) }
              : { done: true, value: undefined },
          releaseLock() {},
        }),
      },
    } as any;
  }) as typeof fetch;

  const s = new ChatSession(Uri.file("/ext") as any);
  live.push(s);
  const webview = {
    html: "",
    postMessage: (msg: ToWebviewMessage) => { toWebview.push(msg); return Promise.resolve(true); },
    onDidReceiveMessage: (listener: (msg: ToExtensionMessage) => void) => {
      receive = listener;
      return { dispose() {} };
    },
    asWebviewUri: (u: unknown) => u,
    cspSource: "",
    options: {},
  };
  s.attachView(webview as any, () => {}, "<html></html>");

  return {
    session: s,
    wire: {
      approvals,
      toWebview,
      send: (msg) => receive?.(msg),
    },
  };
}

/** The modal request the webview was asked to show, if any. */
const modalOf = (wire: Wire) =>
  wire.toWebview.find((m) => m.type === ToWebviewType.ToolApprovalRequest)?.payload as any;

/**
 * Wait for a condition, or fail loudly rather than hanging.
 *
 * The first version of this file slept a fixed 40 ms instead. It passed locally
 * and hung CI for half an hour: on a slower machine the approval answer arrived
 * before the modal had been raised, so nothing resolved the pending request and
 * the session sat on its five-minute timeout — once per affected test. A sleep
 * is a race whose loser is always the slower machine.
 */
async function until(what: string, cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Send a user message and wait until the turn has raised what it is going to raise. */
async function turn(s: ChatSession, wire: Wire, text = "write a file"): Promise<void> {
  wire.send({ type: ToExtensionType.SendMessage, payload: { text } } as ToExtensionMessage);
  // The handler is fire-and-forget. Wait for the stream to have produced
  // something — a modal, or the assistant's message — rather than for a clock.
  await until(
    "the turn to produce something",
    () => wire.toWebview.length > 0,
  );
}

/** Wait for the approval modal carrying `requestId`, then answer it. */
async function answer(
  wire: Wire,
  requestId: string,
  approved: boolean,
  scope: "once" | "turn" | "file",
): Promise<void> {
  await until(`the modal for ${requestId}`, () =>
    wire.toWebview.some((m) =>
      m.type === ToWebviewType.ToolApprovalRequest &&
      (m.payload as any).requestId === requestId));

  wire.send({
    type: ToExtensionType.ToolApprovalResponse,
    payload: { requestId, approved, scope },
  } as ToExtensionMessage);
}

/** Answer the given requests, then dispose the session.
 *
 *  Both halves are needed for the run to end at all, and both are the property
 *  under test elsewhere: an unanswered approval holds a five-minute timer, and
 *  a session that is not disposed leaves the health poller running for ever.
 *  In VS Code that is a leak nobody sees; here it hangs the test runner, which
 *  is the same bug with a louder voice. */
async function settle(s: ChatSession, wire: Wire, outstanding: string[] = []): Promise<void> {
  for (const requestId of outstanding) {
    await answer(wire, requestId, false, "once");
  }
  if (outstanding.length > 0) {
    await until("the answers to reach the proxy", () => wire.approvals.length >= outstanding.length);
  }
}

const pending = (id: string) =>
  frame("tool_request_pending", {
    request_id: id,
    action: "write",
    params: { action: "write", path: "a.txt", content: "x" },
    oldContent: null,
  });

// ─────────────────────────────────────────────────────────────────────────────
// The handshake
// ─────────────────────────────────────────────────────────────────────────────

test("a pending tool request becomes a modal the user can answer", async () => {
  const { session: s, wire } = session([
    frame("message_start", {}),
    pending("req-1"),
    frame("message_stop", {}),
  ]);

  await turn(s, wire);
  await until("the approval modal", () => modalOf(wire) !== undefined);

  const modal = modalOf(wire);
  assert.ok(modal, "no approval modal was raised — the turn would hang to the proxy's timeout");
  assert.equal(modal.requestId, "req-1");
  assert.equal(modal.action, "write");
  assert.equal(modal.params.path, "a.txt");

  await settle(s, wire, ["req-1"]);
});

test("the user's decision reaches the proxy, at the id it asked about", async () => {
  const { session: s, wire } = session([pending("req-1"), frame("message_stop", {})]);

  await turn(s, wire);
  await answer(wire, "req-1", true, "once");
  await until("the approval to be posted", () => wire.approvals.length === 1);

  assert.match(wire.approvals[0].url, /\/v1\/messages\/req-1\/approve$/);
  assert.equal(wire.approvals[0].body.approved, true);

  await settle(s, wire);
});

test("the scope the user chose is the scope the proxy is told", async () => {
  // "for this turn" downgraded to "once" is not a crash: it is a second modal
  // three seconds later, and a user who stops trusting the button.
  const { session: s, wire } = session([pending("req-1"), frame("message_stop", {})]);

  await turn(s, wire);
  await answer(wire, "req-1", true, "turn");
  await until("the approval to be posted", () => wire.approvals.length === 1);

  assert.equal(wire.approvals[0].body.scope, "turn");

  await settle(s, wire);
});

test("a denial is forwarded as a denial", async () => {
  const { session: s, wire } = session([pending("req-1"), frame("message_stop", {})]);

  await turn(s, wire);
  await answer(wire, "req-1", false, "once");
  await until("the denial to be posted", () => wire.approvals.length === 1);

  assert.equal(wire.approvals[0].body.approved, false);

  await settle(s, wire);
});

test("an answer to a request that was never asked is ignored", async () => {
  // Late clicks, duplicated messages, a modal answered after its timeout: none
  // of them may resolve a *different* pending request.
  const { session: s, wire } = session([pending("req-1"), frame("message_stop", {})]);

  await turn(s, wire);
  await until("the modal", () => modalOf(wire) !== undefined);
  wire.send({
    type: ToExtensionType.ToolApprovalResponse,
    payload: { requestId: "someone-else", approved: true, scope: "once" },
  } as ToExtensionMessage);
  await new Promise((r) => setTimeout(r, 50));   // nothing should happen; give it the chance

  assert.deepEqual(wire.approvals, [], "a stale answer was forwarded");

  await settle(s, wire, ["req-1"]);
});

test("answering twice posts once — the second click has nothing left to resolve", async () => {
  const { session: s, wire } = session([pending("req-1"), frame("message_stop", {})]);

  await turn(s, wire);
  await answer(wire, "req-1", true, "once");
  await until("the approval to be posted", () => wire.approvals.length === 1);
  wire.send({
    type: ToExtensionType.ToolApprovalResponse,
    payload: { requestId: "req-1", approved: true, scope: "once" },
  } as ToExtensionMessage);
  await new Promise((r) => setTimeout(r, 50));   // the second click has nothing left to resolve

  assert.equal(wire.approvals.length, 1);

  await settle(s, wire);
});

test("approvals are asked one at a time, in the order the proxy asks", async () => {
  // The stream is *awaited* on each pending request, so the second modal does
  // not exist until the first is answered. That is the property worth pinning:
  // two modals stacked on one another would let a user answer the second while
  // believing they were answering the first, and the proxy runs destructive
  // actions sequentially for the same reason.
  const { session: s, wire } = session([
    pending("req-1"),
    pending("req-2"),
    frame("message_stop", {}),
  ]);

  await turn(s, wire);
  await until("the first modal", () =>
    wire.toWebview.some((m) => m.type === ToWebviewType.ToolApprovalRequest));

  const first = wire.toWebview.filter((m) => m.type === ToWebviewType.ToolApprovalRequest);
  assert.equal(first.length, 1, "both modals were raised at once");
  assert.equal((first[0].payload as any).requestId, "req-1");

  await answer(wire, "req-1", true, "once");
  await until("the second modal", () =>
    wire.toWebview.filter((m) => m.type === ToWebviewType.ToolApprovalRequest).length === 2);

  const both = wire.toWebview.filter((m) => m.type === ToWebviewType.ToolApprovalRequest);
  assert.deepEqual(both.map((m) => (m.payload as any).requestId), ["req-1", "req-2"]);

  await settle(s, wire, ["req-2"]);
});

test("a malformed pending event is dropped, not turned into a modal", async () => {
  // The payload comes off the wire. A parse failure must not raise a modal with
  // undefined fields, and must not take the turn down either.
  const { session: s, wire } = session([
    "event: tool_request_pending\ndata: {not json\n\n",
    frame("message_stop", {}),
  ]);

  await turn(s, wire);
  await new Promise((r) => setTimeout(r, 50));   // long enough for a modal to appear if it were going to

  assert.equal(modalOf(wire), undefined);

  await settle(s, wire);
});

test("a session disposed with a modal open denies it instead of leaving the proxy waiting", async () => {
  // Closing the window is an answer: nobody can click any more, and the proxy
  // is holding that turn open until someone does. Before this, dispose() left
  // the promise and its five-minute timer alive — invisible in VS Code, and the
  // reason this suite once hung a CI run for half an hour.
  const { session: s, wire } = session([pending("req-1"), frame("message_stop", {})]);

  await turn(s, wire);
  await until("the modal", () => modalOf(wire) !== undefined);
  s.dispose();
  await until("the denial to reach the proxy", () => wire.approvals.length === 1);

  assert.equal(wire.approvals[0].body.approved, false);
  assert.match(wire.approvals[0].url, /\/v1\/messages\/req-1\/approve$/);
});
