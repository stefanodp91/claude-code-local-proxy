/**
 * proxyManager.test.ts — the 223 lines that start and kill processes.
 *
 * Claudio spawns the proxy itself: it finds a free port, launches `npm run
 * start` there, waits for `/health`, writes a PID file, and kills the process on
 * dispose. When it goes wrong the symptom is never an error message — it is a
 * proxy left listening on a port nobody remembers, or a window that says
 * "Disconnected" because the port it polls is not the port that was used.
 *
 * These tests spawn a *real* child process: a five-line HTTP server standing in
 * for the proxy, in a temporary directory with its own `package.json`. That is
 * the only way to exercise the part that matters — spawn, wait, kill — and it
 * costs about a second.
 *
 * @module test/proxyManager
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyManager } from "../src/extension/proxy/proxy-manager";

let dir: string;      // stands in for proxy/
let storage: string;  // stands in for globalStoragePath

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudio-pm-"));
  storage = mkdtempSync(join(tmpdir(), "claudio-pm-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(storage, { recursive: true, force: true });
});

/** A "proxy" that answers /health on whatever PROXY_PORT it is given. */
function fakeProxyProject(): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fake-proxy",
    scripts: { start: "node server.mjs" },
  }));
  writeFileSync(join(dir, "server.mjs"), `
    import { createServer } from "node:http";
    const port = Number(process.env.PROXY_PORT ?? 5678);
    createServer((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", marker: process.env.MARKER ?? null }));
    }).listen(port, "127.0.0.1");
  `);
}

const lines: string[] = [];
const errors: string[] = [];
const channel = {
  appendLine: (l: string) => { lines.push(l); },
  append: (l: string) => { lines.push(l); },
  show() {}, dispose() {},
} as any;

function manager(): ProxyManager {
  lines.length = 0;
  errors.length = 0;
  return new ProxyManager(dir, storage, channel, (m) => errors.push(m));
}

const pidFile = () => {
  const found = readdirSync(storage).filter((f) => f.startsWith(".claudio-proxy-"));
  return found.length ? join(storage, found[0]) : null;
};

/** Hold a port so the next start() has to move past it. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

const health = async (port: number) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch { return false; }
};

// ─────────────────────────────────────────────────────────────────────────────
// Starting
// ─────────────────────────────────────────────────────────────────────────────

test("the proxy is spawned and answers on the port the manager reports", async () => {
  // `actualPort` is what every other part of the extension polls and posts to.
  // If it disagrees with the port the process took, everything says
  // "Disconnected" while a healthy proxy runs beside it.
  fakeProxyProject();
  const pm = manager();

  await pm.start(45231);
  try {
    assert.equal(await health(pm.actualPort), true, `nothing answered on ${pm.actualPort}`);
    assert.equal(pm.isRunning, true);
  } finally {
    pm.dispose();
  }
});

test("an occupied port is stepped over, not fought for", async () => {
  fakeProxyProject();
  const blocker = await occupy(45301);
  const pm = manager();

  try {
    await pm.start(45301);
    assert.notEqual(pm.actualPort, 45301, "it tried to use a port that was taken");
    assert.equal(await health(pm.actualPort), true);
  } finally {
    pm.dispose();
    blocker.close();
  }
});

test("the proxy's own .env is passed through, and the port overrides it", async () => {
  // `.env.proxy` is where the user sets TARGET_URL and friends; a manager that
  // ignored it would start a proxy pointed at the wrong backend. PROXY_PORT is
  // the one variable the manager must win, or the port it reports is a guess.
  fakeProxyProject();
  writeFileSync(join(dir, ".env.proxy"), "# a comment\n\nMARKER=from-env-file\nPROXY_PORT=9999\n");
  const pm = manager();

  await pm.start(45411);
  try {
    const res = await fetch(`http://127.0.0.1:${pm.actualPort}/health`);
    assert.equal((await res.json() as any).marker, "from-env-file");
    assert.notEqual(pm.actualPort, 9999, "the .env port won over the discovered one");
  } finally {
    pm.dispose();
  }
});

test("a PID file is written so a crashed window can clean up after itself", async () => {
  fakeProxyProject();
  const pm = manager();

  await pm.start(45501);
  try {
    const file = pidFile();
    assert.ok(file, "no PID file was written — an orphan would be unfindable");
    assert.equal(Number.isInteger(parseInt(readFileSync(file!, "utf8"), 10)), true);
  } finally {
    pm.dispose();
  }
});

test("a proxy directory with no start script surfaces an error instead of hanging", async () => {
  // `npm run start` fails immediately; the manager must not wait out its 30 s
  // health deadline before saying anything.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "no-start", scripts: {} }));
  const pm = manager();
  const started = Date.now();

  await pm.start(45601);
  pm.dispose();

  // Not "eventually": the child exits in under a second, and the manager has
  // to notice rather than poll a corpse for its full thirty-second deadline.
  assert.equal(Date.now() - started < 10_000, true,
    `it waited ${Math.round((Date.now() - started) / 1000)}s for a process that had already exited`);
  assert.match(lines.join("\n"), /exited/i);
  assert.match(errors.join("\n"), /exited on startup/i, "the user was never told");
});

// ─────────────────────────────────────────────────────────────────────────────
// Stopping
// ─────────────────────────────────────────────────────────────────────────────

test("dispose kills the proxy and takes the PID file with it", async () => {
  // The leak that matters: a VS Code window closes and leaves a proxy holding a
  // port. Nothing reports it until the next window picks a different port and
  // the user wonders why two models are loaded.
  //
  // This one is platform-dependent, and only CI can see it. `npm run start`
  // makes node a *grandchild*; on macOS a SIGTERM to npm reaches the whole
  // group anyway, so this passed locally for as long as it existed. On Linux it
  // does not: npm died, node kept the port, and the surviving grandchild held
  // this test process's pipes open until the runner killed the step. The fix is
  // to signal the process group — see `signalGroup` — and the reason it is
  // written down here is that a green run on a Mac proves nothing about it.
  fakeProxyProject();
  const pm = manager();
  await pm.start(45701);
  const port = pm.actualPort;
  assert.equal(await health(port), true);

  pm.dispose();
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(await health(port), false, "the proxy is still listening after dispose");
  assert.equal(pm.isRunning, false);
  assert.equal(pidFile(), null, "the PID file outlived the process");
});

test("stopping a manager that never started is not an error", async () => {
  const pm = manager();
  pm.dispose();
  assert.equal(pm.isRunning, false);
});

test("stop leaves no timer holding the process open", async () => {
  // stop() arms a five-second SIGKILL fallback. Once the child is gone that
  // timer has nothing to kill, and until it fires it keeps the event loop —
  // and the extension host's shutdown, and this test run — waiting on it.
  fakeProxyProject();
  const pm = manager();
  await pm.start(45801);

  pm.dispose();
  await new Promise((r) => setTimeout(r, 500));

  const timers = process.getActiveResourcesInfo().filter((r) => r === "Timeout");
  assert.equal(timers.length, 0, `${timers.length} timer(s) still pending after stop()`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphans
// ─────────────────────────────────────────────────────────────────────────────

test("an orphan from a previous session is killed before a new proxy starts", async () => {
  // The PID file is the only trace a crashed window leaves. Ignoring it means
  // the old proxy keeps the port and the new one lands somewhere else.
  fakeProxyProject();
  const first = manager();
  await first.start(45901);
  const orphanPid = parseInt(readFileSync(pidFile()!, "utf8"), 10);

  // Simulate a crash: forget the process without stopping it.
  (first as any).process = null;
  (first as any).isOwner = false;

  const second = manager();
  await second.start(45901);
  try {
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try { process.kill(orphanPid, 0); } catch { alive = false; }
    assert.equal(alive, false, "the orphaned proxy survived the new start");
  } finally {
    second.dispose();
  }
});

test("a PID file naming a process that is already gone is just cleaned up", async () => {
  fakeProxyProject();
  mkdirSync(storage, { recursive: true });
  const pm = manager();
  // A pid that cannot exist: write it where this manager will look.
  const file = (pm as any).pidFile as string;
  writeFileSync(file, "999999", "utf8");

  await pm.start(46001);
  try {
    assert.equal(existsSync(file), true, "the new PID file should have replaced the stale one");
    assert.notEqual(readFileSync(file, "utf8"), "999999");
  } finally {
    pm.dispose();
  }
});
