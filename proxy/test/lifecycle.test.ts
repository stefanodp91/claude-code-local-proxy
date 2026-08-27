/**
 * lifecycle.test.ts — the rules for starting and stopping a proxy, in one place.
 *
 * These rules existed twice: once in TypeScript inside Claudio's `ProxyManager`,
 * once in bash inside `start_agent_cli.sh`. Both found a free port, both wrote a
 * PID file, both killed the proxy by that pid — and both were wrong in the same
 * way, because `npm run start` makes node a *grandchild* and the pid belongs to
 * the wrapper. It was fixed on the Claudio side when CI hung on it; the launcher
 * kept the bug, because nothing connected the two copies.
 *
 * So the rules live here now, in the proxy, and both surfaces call them. What
 * each surface still owns is what it genuinely owns: Claudio pipes the output
 * into a VS Code channel, the launcher writes it to a log file.
 *
 * @module test/lifecycle
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findFreePort,
  pidFilePath,
  writePidFile,
  removePidFile,
  killProcessGroup,
  cleanupOrphan,
  waitForHealth,
} from "../src/infrastructure/lifecycle";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claudio-life-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const occupy = (port: number): Promise<Server> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(port, "127.0.0.1", () => resolve(s));
  });

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// ─────────────────────────────────────────────────────────────────────────────
// Finding somewhere to listen
// ─────────────────────────────────────────────────────────────────────────────

test("a free port is returned as it is", async () => {
  assert.equal(await findFreePort(46101), 46101);
});

test("an occupied port is stepped over", async () => {
  // Two VS Code windows, or a launcher beside an extension: the second one has
  // to move rather than fail, or the user gets "Disconnected" and no reason.
  const blocker = await occupy(46201);
  try {
    assert.equal(await findFreePort(46201), 46202);
  } finally {
    blocker.close();
  }
});

test("a run of occupied ports is walked until one is free", async () => {
  const a = await occupy(46301);
  const b = await occupy(46302);
  try {
    assert.equal(await findFreePort(46301), 46303);
  } finally {
    a.close();
    b.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Remembering what was started
// ─────────────────────────────────────────────────────────────────────────────

test("the PID file is named after the directory it belongs to", async () => {
  // One file per proxy directory, so two VS Code windows pointed at different
  // checkouts do not kill each other's proxy.
  const a = pidFilePath(dir, "/home/me/project-a/proxy");
  const b = pidFilePath(dir, "/home/me/project-b/proxy");

  assert.notEqual(a, b);
  assert.equal(a, pidFilePath(dir, "/home/me/project-a/proxy"), "the name is not stable");
  assert.match(a, /\.claudio-proxy-.*\.pid$/);
});

test("writing the PID file creates the directory it needs", async () => {
  const file = pidFilePath(join(dir, "not", "there"), "/proxy");

  writePidFile(file, 4242);

  assert.equal(readFileSync(file, "utf8"), "4242");
});

test("removing a PID file that is already gone is not an error", async () => {
  removePidFile(join(dir, "never-existed.pid"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Stopping what was started
// ─────────────────────────────────────────────────────────────────────────────

test("killing the group takes the grandchild with it", async () => {
  // The bug this module exists for. `sh -c "node …"` is the same shape as
  // `npm run start`: the pid is the shell's, and the node process under it is
  // what holds the port. Signalling the pid alone leaves it running — on Linux
  // certainly, and on any platform where the signal does not reach the group.
  const child = spawn("sh", ["-c", "node -e 'setInterval(() => {}, 1000)' & wait"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 300));
  const shellPid = child.pid!;

  killProcessGroup(shellPid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(alive(shellPid), false, "the wrapper survived");
  // The grandchild has no pid we can name from here; what we can assert is that
  // the group is gone, which is what `kill(-pid)` reports.
  let groupAlive = true;
  try { process.kill(-shellPid, 0); } catch { groupAlive = false; }
  assert.equal(groupAlive, false, "the process group outlived the signal");
});

test("killing a process that is already gone is not an error", async () => {
  killProcessGroup(999_999, "SIGTERM");
});

test("an orphan named by a PID file is killed and the file removed", async () => {
  // What a crashed VS Code window leaves behind. The next start has to clear it,
  // or the old proxy keeps the port and the new one lands somewhere else.
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const file = join(dir, "orphan.pid");
  writePidFile(file, child.pid!);

  await cleanupOrphan(file);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(alive(child.pid!), false, "the orphan survived");
  assert.equal(existsSync(file), false, "the PID file outlived the orphan");
});

test("a PID file naming a dead process is just cleared", async () => {
  const file = join(dir, "stale.pid");
  writeFileSync(file, "999999");

  await cleanupOrphan(file);

  assert.equal(existsSync(file), false);
});

test("a PID file with rubbish in it is cleared, not obeyed", async () => {
  // Half-written by a kill during startup. Parsing it to NaN and signalling
  // that would be worse than doing nothing.
  const file = join(dir, "rubbish.pid");
  writeFileSync(file, "not a pid\n");

  await cleanupOrphan(file);

  assert.equal(existsSync(file), false);
});

test("no PID file at all is the ordinary case, not a failure", async () => {
  await cleanupOrphan(join(dir, "absent.pid"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Waiting for it to be ready
// ─────────────────────────────────────────────────────────────────────────────

test("waiting returns as soon as health answers", async () => {
  const port = await findFreePort(46401);
  const server = spawn("node", ["-e", `
    require("node:http").createServer((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404); res.end("{}");
    }).listen(${port}, "127.0.0.1");
  `], { detached: true, stdio: "ignore" });

  try {
    assert.equal(await waitForHealth(port, 10_000), true);
  } finally {
    killProcessGroup(server.pid!, "SIGKILL");
  }
});

test("waiting gives up when told the process is already gone", async () => {
  // The proxy that exits on startup — no start script, missing dependencies —
  // must not cost the caller its full deadline. Thirty seconds of spinner with
  // the reason already printed is the failure this replaces.
  const started = Date.now();

  const ok = await waitForHealth(46501, 30_000, () => false);

  assert.equal(ok, false);
  assert.equal(Date.now() - started < 3_000, true, "it waited for a process it knew was dead");
});

test("waiting stops at its deadline when nothing ever answers", async () => {
  const started = Date.now();

  const ok = await waitForHealth(46601, 1_200);

  assert.equal(ok, false);
  assert.equal(Date.now() - started >= 1_000, true, "it gave up before the deadline");
  assert.equal(Date.now() - started < 5_000, true, "it overran the deadline");
});
