/**
 * proxy-manager.ts — Manages the proxy child process lifecycle.
 *
 * Spawns `npm run start` in <proxyDir>, waits for the /health endpoint to
 * respond, and kills the process on dispose.
 *
 * Each VS Code window that has `claudio.proxyDir` configured gets its own
 * proxy process on its own dynamically-discovered free port.
 *
 * @module extension/proxy
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
// The lifecycle rules live in the proxy, and this imports them rather than
// keeping a second copy. The two copies is how the orphaned-proxy bug came to
// be fixed here and left in `start_agent_cli.sh`: same rule, two homes, one
// correction. See proxy/src/infrastructure/lifecycle.ts.
import {
  findFreePort,
  pidFilePath,
  writePidFile,
  removePidFile,
  killProcessGroup,
  cleanupOrphan,
  waitForHealth,
} from "../../../../proxy/src/infrastructure/lifecycle";

export class ProxyManager implements vscode.Disposable {
  private process: ChildProcess | null = null;
  private isOwner = false;
  private readonly pidFile: string;
  /**
   * The SIGKILL fallback armed by `stop()`.
   *
   * It has to be cleared when the child actually exits: until it fires it keeps
   * the event loop alive with nothing left to kill, which delays the extension
   * host's own shutdown by five seconds and holds a test run open for the same.
   */
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when the child exits, so a health wait can give up instead of polling a corpse. */
  private exited = false;

  /** The port the proxy is actually listening on. Set after a successful start(). */
  actualPort = 5678;
  /** The base port passed to the first start() call — used by restart(). */
  private startPort = 5678;

  constructor(
    private readonly proxyDir: string,
    private readonly globalStoragePath: string,
    private readonly outputChannel: vscode.OutputChannel,
    /**
     * Called whenever ProxyManager needs to surface an error to the user.
     * Wired to `ChatSession.notify("error", msg)` in activation.ts so errors
     * appear as embedded banners in the webview, not as native VS Code toasts.
     */
    private readonly onError: (message: string) => void,
  ) {
    // One PID file per proxyDir, so two VS Code windows pointed at different
    // checkouts do not kill each other's proxy. The naming rule is the proxy's.
    this.pidFile = pidFilePath(globalStoragePath, proxyDir);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async start(basePort: number): Promise<void> {
    this.startPort = basePort;
    await cleanupOrphan(this.pidFile);

    const port = await findFreePort(basePort);
    this.actualPort = port;

    const envVars = this.parseEnvFile(path.join(this.proxyDir, ".env.proxy"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envVars,
      PROXY_PORT: String(port),
    };

    this.outputChannel.appendLine(
      `[ProxyManager] Spawning proxy on port ${port} from ${this.proxyDir}`,
    );

    // `detached` puts the child in its own process group, and that is the whole
    // difference between stopping the proxy and orphaning it.
    //
    // `npm run start` is a wrapper: npm spawns node as a *grandchild*. Killing
    // the npm pid ends npm and leaves node running — holding the port, holding
    // the inherited pipes, and invisible to the PID file, which records npm's
    // pid and not node's. On macOS the signal reaches the whole group anyway,
    // which is why this survived every local run; on Linux it does not, and a
    // closed VS Code window left a proxy listening for ever. CI found it by
    // hanging: the surviving grandchild kept the test process's pipes open.
    const child = spawn(
      "npm",
      ["run", "start"],
      { cwd: this.proxyDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );

    child.stdout?.on("data", (d: Buffer) =>
      this.outputChannel.append(d.toString()),
    );
    child.stderr?.on("data", (d: Buffer) => {
      const msg = d.toString();
      this.outputChannel.append(msg);
      if (msg.includes("MODULE_NOT_FOUND") || msg.includes("tsx: not found")) {
        this.onError(
          "Proxy dependencies missing. Run `npm install` in the proxy/ directory.",
        );
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // A process that never started will never answer /health either. Without
      // this the manager polls a child that does not exist for its full
      // thirty-second deadline.
      this.exited = true;
      if (err.code === "ENOENT") {
        this.onError("Node.js not found. Install Node.js 18+ from https://nodejs.org");
      } else {
        this.outputChannel.appendLine(`[ProxyManager] Spawn error: ${err.message}`);
      }
      this.process = null;
    });

    child.on("exit", (code, signal) => {
      this.exited = true;
      if (this.forceKillTimer) {
        clearTimeout(this.forceKillTimer);
        this.forceKillTimer = null;
      }
      this.outputChannel.appendLine(
        `[ProxyManager] Proxy exited (code=${code ?? "?"}, signal=${signal ?? "none"}). ` +
          "Reload Window (Ctrl+Shift+P) to restart.",
      );
      this.process = null;
      removePidFile(this.pidFile);
    });

    this.process = child;
    this.isOwner = true;
    this.exited = false;

    if (child.pid !== undefined) {
      writePidFile(this.pidFile, child.pid);
    }

    const healthy = await waitForHealth(port, 30_000, () => !this.exited);
    if (healthy) {
      this.outputChannel.appendLine(
        `[ProxyManager] Proxy ready at http://127.0.0.1:${port}`,
      );
    } else {
      // Two different failures, and telling them apart is the difference
      // between a wait and a diagnosis: a proxy still probing its model can
      // take half a minute, but a proxy that has already exited will never
      // answer, and waiting out the deadline for it leaves the user watching a
      // spinner for thirty seconds with the reason already in the log.
      this.outputChannel.appendLine(
        this.exited
          ? "[ProxyManager] The proxy process exited before it became healthy — see the output above for why."
          : "[ProxyManager] Health check timed out after 30s. The proxy may still be initializing (tool probe). " +
            "The connection indicator will turn green once it responds.",
      );
      if (this.exited) {
        this.onError("The proxy exited on startup. Open the Claudio output channel for the reason.");
      }
      // Non-fatal either way: HealthChecker keeps polling.
    }
  }

  async restart(): Promise<void> {
    this.stop();
    // Give the old process time to release the port
    await new Promise((r) => setTimeout(r, 500));
    await this.start(this.startPort);
  }

  stop(): void {
    if (!this.isOwner || !this.process) return;
    this.outputChannel.appendLine("[ProxyManager] Stopping proxy (SIGTERM)…");
    const proc = this.process;
    if (proc.pid !== undefined) killProcessGroup(proc.pid, "SIGTERM");
    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = null;
      if (proc.exitCode === null) {
        this.outputChannel.appendLine("[ProxyManager] Force-killing proxy (SIGKILL)…");
        if (proc.pid !== undefined) killProcessGroup(proc.pid, "SIGKILL");
      }
    }, 5_000);
    this.process = null;
    removePidFile(this.pidFile);
  }

  get isRunning(): boolean {
    return this.process !== null;
  }

  dispose(): void {
    this.stop();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Parse KEY=VALUE lines from a .env file; returns {} if the file is absent. */
  private parseEnvFile(filePath: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (!fs.existsSync(filePath)) return result;
    try {
      for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (key) result[key] = value;
      }
    } catch { /* silently skip malformed files */ }
    return result;
  }

}
