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
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export class ProxyManager implements vscode.Disposable {
  private process: ChildProcess | null = null;
  private isOwner = false;
  private readonly pidFile: string;

  /** The port the proxy is actually listening on. Set after a successful start(). */
  actualPort = 5678;

  constructor(
    private readonly proxyDir: string,
    private readonly globalStoragePath: string,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this.pidFile = path.join(globalStoragePath, ".claudio-proxy.pid");
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async start(basePort: number): Promise<void> {
    await this.cleanupOrphan();

    const port = await this.findFreePort(basePort);
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

    const child = spawn(
      "npm",
      ["run", "start"],
      { cwd: this.proxyDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );

    child.stdout?.on("data", (d: Buffer) =>
      this.outputChannel.append(d.toString()),
    );
    child.stderr?.on("data", (d: Buffer) => {
      const msg = d.toString();
      this.outputChannel.append(msg);
      if (msg.includes("MODULE_NOT_FOUND") || msg.includes("tsx: not found")) {
        vscode.window
          .showErrorMessage(
            "Claudio: proxy dependencies missing. Run `npm install` in the proxy/ directory.",
            "How to fix",
          )
          .then((action) => {
            if (action) {
              void vscode.env.openExternal(
                vscode.Uri.parse("https://github.com/anthropics/claude-code"),
              );
            }
          });
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        vscode.window.showErrorMessage(
          "Claudio: Node.js not found. Install Node.js 18+ from https://nodejs.org",
        );
      } else {
        this.outputChannel.appendLine(`[ProxyManager] Spawn error: ${err.message}`);
      }
      this.process = null;
    });

    child.on("exit", (code, signal) => {
      this.outputChannel.appendLine(
        `[ProxyManager] Proxy exited (code=${code ?? "?"}, signal=${signal ?? "none"}). ` +
          "Reload Window (Ctrl+Shift+P) to restart.",
      );
      this.process = null;
      try { fs.unlinkSync(this.pidFile); } catch { /* already gone */ }
    });

    this.process = child;
    this.isOwner = true;

    if (child.pid !== undefined) {
      try {
        fs.mkdirSync(this.globalStoragePath, { recursive: true });
        fs.writeFileSync(this.pidFile, String(child.pid), "utf8");
      } catch (e) {
        this.outputChannel.appendLine(`[ProxyManager] Could not write PID file: ${e}`);
      }
    }

    try {
      await this.waitForHealth(port, 30_000);
      this.outputChannel.appendLine(
        `[ProxyManager] Proxy ready at http://127.0.0.1:${port}`,
      );
    } catch (err) {
      this.outputChannel.appendLine(
        `[ProxyManager] Health check timed out after 30s. The proxy may still be initializing (tool probe). ` +
          "The connection indicator will turn green once it responds.",
      );
      // Non-fatal: HealthChecker will continue polling
    }
  }

  stop(): void {
    if (!this.isOwner || !this.process) return;
    this.outputChannel.appendLine("[ProxyManager] Stopping proxy (SIGTERM)…");
    this.process.kill("SIGTERM");
    const proc = this.process;
    setTimeout(() => {
      if (proc.exitCode === null) {
        this.outputChannel.appendLine("[ProxyManager] Force-killing proxy (SIGKILL)…");
        proc.kill("SIGKILL");
      }
    }, 5_000);
    this.process = null;
    try { fs.unlinkSync(this.pidFile); } catch { /* already gone */ }
  }

  get isRunning(): boolean {
    return this.process !== null;
  }

  dispose(): void {
    this.stop();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Find the first available TCP port starting from startPort. */
  private findFreePort(startPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(startPort, "127.0.0.1", () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(port));
      });
      server.on("error", () =>
        this.findFreePort(startPort + 1).then(resolve, reject),
      );
    });
  }

  /** Kill any proxy process left behind by a previous VS Code crash. */
  private async cleanupOrphan(): Promise<void> {
    if (!fs.existsSync(this.pidFile)) return;
    try {
      const pid = parseInt(fs.readFileSync(this.pidFile, "utf8").trim(), 10);
      if (!isNaN(pid)) {
        try { process.kill(pid, 0); process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
      }
      fs.unlinkSync(this.pidFile);
    } catch { /* nothing to do */ }
  }

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

  /** Poll /health until it responds 200 or the deadline is exceeded. */
  private async waitForHealth(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) return;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`Proxy on port ${port} did not respond within ${timeoutMs / 1000}s`);
  }
}
