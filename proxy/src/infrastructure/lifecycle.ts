/**
 * lifecycle.ts — the rules for starting and stopping a proxy, in one place.
 *
 * These rules used to exist twice: in TypeScript inside Claudio's
 * `ProxyManager`, and in bash inside `start_agent_cli.sh`. Both discovered a
 * free port, both wrote a PID file, both killed the proxy by that pid — and both
 * were wrong the same way, because `npm run start` makes node a *grandchild* and
 * the pid belongs to the wrapper. One copy was fixed when CI hung on it; the
 * other kept the bug, because nothing connected them.
 *
 * The intelligence belongs here. What each surface still owns is what it really
 * owns: Claudio pipes the proxy's output into a VS Code channel and raises
 * banners, the launcher writes a log file and prints colours.
 *
 * Nothing in this module throws. Every failure — a PID file that cannot be read,
 * a process that is already gone, a directory that cannot be created — is a
 * lifecycle event, and a proxy that will not start is a message to the user, not
 * an exception in the middle of activation.
 *
 * @module infrastructure/lifecycle
 */

import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How often health is polled while waiting for a proxy to come up. */
const HEALTH_POLL_MS = 500;
/** How long a single health request may take before it is retried. */
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;

/**
 * The first free TCP port at or after `basePort`, on the loopback interface.
 *
 * Two windows, or a launcher beside an extension, must not fight over 5678: the
 * second one moves. Binding is the only reliable test — asking the OS whether a
 * port is free and then binding it is a race with whoever asked first.
 */
export function findFreePort(basePort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => {
      findFreePort(basePort + 1).then(resolve, reject);
    });
    server.listen(basePort, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Where the PID of the proxy started for `proxyDir` is remembered.
 *
 * One file per proxy directory: two VS Code windows pointed at different
 * checkouts must not kill each other's proxy, which is what a single shared
 * file would guarantee.
 */
export function pidFilePath(stateDir: string, proxyDir: string): string {
  const hash = createHash("sha256").update(proxyDir).digest("hex").slice(0, 16);
  return join(stateDir, `.claudio-proxy-${hash}.pid`);
}

/** Record a running proxy. Creates the state directory if it is missing. */
export function writePidFile(file: string, pid: number): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, String(pid), "utf8");
  } catch {
    // Best-effort: without the file the next start cannot clean up an orphan,
    // which is worse than this, but not worth failing a startup over.
  }
}

/** Forget a proxy. Absent file is the ordinary case, not a failure. */
export function removePidFile(file: string): void {
  try { unlinkSync(file); } catch { /* already gone */ }
}

/**
 * Signal a process and everything it started.
 *
 * A negative pid means the process group, which is the whole point: the pid
 * being signalled is a wrapper's — `npm run start`, or `sh -c` — and the proxy
 * itself is its child. Falls back to the process alone when the group is gone
 * or the platform refuses.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch { /* not a group leader, or already gone */ }
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

/**
 * Kill whatever a previous session left behind, and forget it.
 *
 * The PID file is the only trace a crashed window leaves. Ignoring it means the
 * old proxy keeps the port and the new one lands somewhere else — with the user
 * watching two models load and no explanation.
 */
export async function cleanupOrphan(file: string): Promise<void> {
  if (!existsSync(file)) return;
  try {
    const pid = parseInt(readFileSync(file, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 1) {
      killProcessGroup(pid, "SIGTERM");
    }
  } catch { /* unreadable — nothing to kill, and the file goes anyway */ }
  removePidFile(file);
}

/**
 * Poll `/health` until it answers, the deadline passes, or the process dies.
 *
 * @param isAlive Optional: when it returns false the wait stops at once. A proxy
 *                that has already exited will never answer, and waiting out
 *                thirty seconds for it means a spinner with the reason already
 *                printed in the log.
 * @returns whether the proxy became healthy.
 */
export async function waitForHealth(
  port: number,
  timeoutMs: number,
  isAlive: () => boolean = () => true,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}
