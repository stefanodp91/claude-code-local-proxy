/**
 * healthChecker.test.ts — the dot in the corner of the chat panel.
 *
 * It is the only thing telling the user whether anything is listening. A poller
 * that stops polling, or one that keeps reporting "Connected" after the proxy
 * has died, produces a panel that looks fine and a message that never answers.
 *
 * @module test/healthChecker
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HealthChecker } from "../src/extension/proxy/health-checker";
import { ConnectionStatus } from "../src/shared/message-protocol";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Every request answers `ok`, and each URL asked for is recorded. */
function serving(ok: boolean) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url));
    if (ok) return { ok: true, status: 200 } as any;
    return { ok: false, status: 503 } as any;
  }) as typeof fetch;
  return urls;
}

/** Let the pending fetch and its callback settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

test("a reachable proxy is reported connected, after saying it is checking", async () => {
  // Both events matter: the "checking" state is what stops the panel showing a
  // stale green dot while the first request is still in flight.
  const seen: ConnectionStatus[] = [];
  const checker = new HealthChecker("http://127.0.0.1:5678", (s) => seen.push(s));
  serving(true);

  checker.start();
  await settle();
  checker.stop();

  assert.deepEqual(seen, [ConnectionStatus.Checking, ConnectionStatus.Connected]);
});

test("an unreachable proxy is reported disconnected, not left as checking", async () => {
  const seen: ConnectionStatus[] = [];
  const checker = new HealthChecker("http://127.0.0.1:5678", (s) => seen.push(s));
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;

  checker.start();
  await settle();
  checker.stop();

  assert.equal(seen.at(-1), ConnectionStatus.Disconnected);
});

test("a proxy that answers with an error status is disconnected, not connected", async () => {
  // 503 is what the proxy returns while it is still probing the model. Reading
  // "it answered" as "it is ready" would send the first turn into a 503.
  const seen: ConnectionStatus[] = [];
  const checker = new HealthChecker("http://127.0.0.1:5678", (s) => seen.push(s));
  serving(false);

  checker.start();
  await settle();
  checker.stop();

  assert.equal(seen.at(-1), ConnectionStatus.Disconnected);
});

test("it polls the /health endpoint of the configured proxy", async () => {
  const urls = serving(true);
  const checker = new HealthChecker("http://127.0.0.1:9999", () => {});

  checker.start();
  await settle();
  checker.stop();

  assert.deepEqual(urls, ["http://127.0.0.1:9999/health"]);
});

test("a new base URL is used by the next poll", async () => {
  // The port changes when the proxy is restarted on a different one, which the
  // extension does routinely. Polling the old port reports a dead proxy that is
  // actually alive.
  const urls = serving(true);
  const checker = new HealthChecker("http://127.0.0.1:1111", () => {});

  checker.updateBaseUrl("http://127.0.0.1:2222");
  checker.start();
  await settle();
  checker.stop();

  assert.deepEqual(urls, ["http://127.0.0.1:2222/health"]);
});

test("stop ends the polling", async () => {
  // A checker that keeps its interval after stop() holds the extension host
  // awake and keeps writing to a webview that is gone.
  const urls = serving(true);
  const checker = new HealthChecker("http://127.0.0.1:5678", () => {});

  checker.start();
  await settle();
  const afterFirst = urls.length;
  checker.stop();
  await settle();

  assert.equal(urls.length, afterFirst, "it polled again after stop()");
});

test("start twice does not leave two pollers running", async () => {
  const urls = serving(true);
  const checker = new HealthChecker("http://127.0.0.1:5678", () => {});

  checker.start();
  checker.start();
  await settle();
  checker.stop();
  const afterStop = urls.length;
  await settle();

  assert.equal(urls.length, afterStop, "a second poller survived stop()");
});
