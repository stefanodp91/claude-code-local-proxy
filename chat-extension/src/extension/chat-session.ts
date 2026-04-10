/**
 * chat-session.ts — Singleton session that owns conversation state, proxy client,
 * health checker, and all message handlers.
 *
 * Both ChatPanel and SidebarProvider attach their webview to this session.
 * Only one view can be active at a time — attaching a new view automatically
 * detaches (and disposes) the previous one.
 *
 * @module extension
 */

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WebviewBridge } from "./webview/webview-bridge";
import { ProxyClient } from "./proxy/proxy-client";
import { HealthChecker } from "./proxy/health-checker";
import {
  ToWebviewType,
  ToExtensionType,
  ConnectionStatus,
  type StreamDeltaPayload,
  type SendMessagePayload,
  type SlashCommandPayload,
  type SlashCommandResultPayload,
  type ExecuteCodePayload,
  type CodeResultPayload,
  type CodeProgressPayload,
  type CodeProgressPhase,
  type HistoryRestorePayload,
  type Attachment,
  type FilesReadPayload,
  type ToolApprovalRequestPayload,
  type ToolApprovalResponsePayload,
} from "../shared/message-protocol";
import { SseEventType } from "../shared/anthropic-events";
import {
  loadVsCodeSettings,
  fetchProxyConfig,
  buildChatConfig,
  proxyBaseUrl,
  type ChatConfig,
} from "./config/extension-config";
import type { ConversationMessage, AnthropicContentBlock } from "./models/chat-message.model";

/** Remove ANSI/VT100 escape codes from a string. */
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");

// ── Python execution helpers ──────────────────────────────────────────────────

/** Cases where the import name differs from the PyPI package name. */
const IMPORT_TO_PACKAGE: Record<string, string> = {
  PIL:      "Pillow",
  cv2:      "opencv-python",
  sklearn:  "scikit-learn",
  bs4:      "beautifulsoup4",
  yaml:     "PyYAML",
  dotenv:   "python-dotenv",
  attr:     "attrs",
  jwt:      "PyJWT",
  dateutil: "python-dateutil",
  Crypto:   "pycryptodome",
  google:   "google-cloud",
  wx:       "wxPython",
};

function extractImports(code: string): string[] {
  const modules = new Set<string>();
  for (const m of code.matchAll(/^\s*import\s+([\w.]+)/gm))
    modules.add(m[1].split(".")[0]);
  for (const m of code.matchAll(/^\s*from\s+([\w.]+)\s+import/gm))
    modules.add(m[1].split(".")[0]);
  return [...modules];
}

async function findMissingModules(python: string, modules: string[]): Promise<string[]> {
  if (modules.length === 0) return [];
  const check = [
    "import importlib.util",
    `modules = ${JSON.stringify(modules)}`,
    "missing = [m for m in modules if importlib.util.find_spec(m) is None]",
    'print("\\n".join(missing))',
  ].join("\n");
  const { stdout } = await runProcess(python, ["-c", check], 10_000);
  return stdout.trim() ? stdout.trim().split("\n") : [];
}

const PYTHON_CANDIDATES = [
  "python3",
  "python",
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/opt/local/bin/python3",
];

async function findSystemPython(): Promise<string | null> {
  for (const cmd of PYTHON_CANDIDATES) {
    const found = await new Promise<boolean>((resolve) => {
      const p = spawn(cmd, ["--version"]);
      p.on("close", (code) => resolve(code === 0));
      p.on("error", () => resolve(false));
    });
    if (found) return cmd;
  }
  return null;
}

async function runProcess(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(cmd, args, { timeout: timeoutMs, cwd });
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", () => resolve({ stdout, stderr }));
    proc.on("error", (e) => resolve({ stdout, stderr: e.message }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export class ChatSession implements vscode.Disposable {
  readonly conversation: ConversationMessage[] = [];
  private config: ChatConfig;

  private readonly proxyClient: ProxyClient;
  private readonly healthChecker: HealthChecker;
  private readonly configWatcher: vscode.Disposable;

  private bridge: WebviewBridge | null = null;
  private activeViewDisposeFn: (() => void) | null = null;

  /** Resolved path to the venv Python binary; null until first ensureVenv() call. */
  private venvPython: string | null = null;
  private readonly venvPath: string;

  private assistantBuffer = "";

  /** Workspace root passed as X-Workspace-Root to the proxy. */
  private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  /** Pending tool approval promises keyed by request_id. */
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStoragePath: string,
  ) {
    this.venvPath = join(globalStoragePath, ".claudio-venv");

    const vsSettings = loadVsCodeSettings();
    this.config = buildChatConfig(vsSettings, null);

    const baseUrl = proxyBaseUrl(this.config);
    this.proxyClient = new ProxyClient(baseUrl);

    this.healthChecker = new HealthChecker(baseUrl, async (status) => {
      this.bridge?.send({ type: ToWebviewType.ConnectionStatus, payload: status });
      if (status === ConnectionStatus.Connected) {
        await this.refreshProxyConfig();
      }
    });

    this.configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudio")) {
        const newVs = loadVsCodeSettings();
        const newBaseUrl = proxyBaseUrl(newVs);
        this.proxyClient.updateBaseUrl(newBaseUrl);
        this.healthChecker.updateBaseUrl(newBaseUrl);
        void this.refreshProxyConfig();
      }
    });
  }

  /**
   * Attach a webview to this session. Automatically detaches (disposes) any
   * previously attached view first — mutual exclusivity is handled here.
   *
   * @param webview    The new webview to attach.
   * @param disposeFn  Called when we need to close the view from our side.
   * @param html       HTML content to set on the webview.
   */
  attachView(webview: vscode.Webview, disposeFn: () => void, html: string): void {
    // Close previous view if any (mutual exclusivity)
    this.detachView();

    webview.html = html;
    this.bridge = new WebviewBridge(webview);
    this.activeViewDisposeFn = disposeFn;

    // Register message handlers
    this.bridge.on(ToExtensionType.SendMessage, (msg) =>
      void this.handleSendMessage(msg.payload as SendMessagePayload),
    );
    this.bridge.on(ToExtensionType.CancelStream, () => this.handleCancelStream());
    this.bridge.on(ToExtensionType.ClearHistory, () => this.handleClearHistory());
    this.bridge.on(ToExtensionType.CheckHealth, () => this.healthChecker.start());
    this.bridge.on(ToExtensionType.ExecuteSlashCommand, (msg) =>
      void this.handleClientSlashCommand(msg.payload as SlashCommandPayload),
    );
    this.bridge.on(ToExtensionType.ExecuteCode, (msg) =>
      void this.handleExecuteCode((msg.payload as ExecuteCodePayload).code),
    );
    this.bridge.on(ToExtensionType.ReadFiles, (msg) =>
      void this.handleReadFiles((msg.payload as { uris: string[] }).uris),
    );
    this.bridge.on(ToExtensionType.ToolApprovalResponse, (msg) => {
      const { requestId, approved } = msg.payload as ToolApprovalResponsePayload;
      const resolve = this.pendingApprovals.get(requestId);
      if (resolve) {
        this.pendingApprovals.delete(requestId);
        resolve(approved);
      }
    });

    // Send current conversation history to the newly attached view
    const historyPayload: HistoryRestorePayload = {
      messages: this.conversation.map((m) => ({
        role: m.role,
        content: typeof m.content === "string"
          ? m.content
          : m.content.filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n"),
      })),
    };
    this.bridge.send({ type: ToWebviewType.HistoryRestore, payload: historyPayload });

    // Send current config
    this.bridge.send({
      type: ToWebviewType.ConfigUpdate,
      payload: { ...this.config, slashCommands: [] },
    });

    // (Re)start health checker — triggers refreshProxyConfig on Connected
    this.healthChecker.start();
  }

  /** Detach current view without disposing the session itself. */
  detachView(): void {
    if (this.bridge) {
      this.bridge.dispose();
      this.bridge = null;
    }
    this.activeViewDisposeFn = null;
  }

  dispose(): void {
    this.detachView();
    this.healthChecker.stop();
    this.proxyClient.cancel();
    this.configWatcher.dispose();
  }

  // ── Proxy config ────────────────────────────────────────────────────────────

  private async refreshProxyConfig(): Promise<void> {
    const vs = loadVsCodeSettings();
    const [remote, slashCommands] = await Promise.all([
      fetchProxyConfig(proxyBaseUrl(vs)),
      this.proxyClient.fetchCommands(),
    ]);
    this.config = buildChatConfig(vs, remote);
    this.bridge?.send({
      type: ToWebviewType.ConfigUpdate,
      payload: { ...this.config, slashCommands },
    });
  }

  // ── Message handlers ────────────────────────────────────────────────────────

  private async handleSendMessage(payload: SendMessagePayload): Promise<void> {
    const attachments: Attachment[] = payload.attachments ?? [];
    let msgContent: string | AnthropicContentBlock[];

    if (attachments.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      for (const att of attachments) {
        if (att.mimeType.startsWith("image/")) {
          blocks.push({ type: "image", source: { type: "base64", media_type: att.mimeType, data: att.data } });
        } else {
          const ext = att.name.split(".").pop() ?? "";
          const text = Buffer.from(att.data, "base64").toString("utf8");
          blocks.push({ type: "text", text: `\`\`\`${ext}\n// ${att.name}\n${text}\n\`\`\`` });
        }
      }
      if (payload.content.trim()) {
        blocks.push({ type: "text", text: payload.content });
      }
      msgContent = blocks;
    } else {
      msgContent = payload.content;
    }

    this.conversation.push({ role: "user", content: msgContent });

    try {
      for await (const sseEvent of this.proxyClient.sendMessage({
        messages: this.conversation,
        config: {
          ...this.config,
          ...(payload.temperature !== undefined && { temperature: payload.temperature }),
          ...(payload.maxTokens !== undefined && { maxTokens: payload.maxTokens }),
          ...(payload.systemPrompt !== undefined && { systemPrompt: payload.systemPrompt }),
        },
        workspaceRoot: this.workspaceRoot,
      })) {
        // Custom event: proxy is requesting human approval for a destructive action.
        if (sseEvent.event === "tool_request_pending") {
          await this.handleToolApproval(sseEvent.data);
          continue;
        }

        let parsed: any = {};
        try {
          parsed = JSON.parse(sseEvent.data);
        } catch {
          continue;
        }

        const deltaPayload: StreamDeltaPayload = { eventType: sseEvent.event, ...parsed };
        this.bridge?.send({ type: ToWebviewType.StreamDelta, payload: deltaPayload });

        if (sseEvent.event === SseEventType.ContentBlockDelta && parsed.delta?.type === "text_delta") {
          this.assistantBuffer += parsed.delta.text ?? "";
        }
        if (sseEvent.event === SseEventType.MessageStop) {
          this.finalizeAssistantMessage();
        }
      }

      this.bridge?.send({ type: ToWebviewType.StreamEnd });
    } catch (err: any) {
      if (err.name === "AbortError") {
        this.bridge?.send({ type: ToWebviewType.StreamEnd });
      } else {
        this.bridge?.send({
          type: ToWebviewType.StreamError,
          payload: { message: (err.message as string) || "Unknown error" },
        });
      }
    }
  }

  /**
   * Bridge a tool_request_pending event from the proxy to the webview approval modal.
   *
   * Flow: proxy emits SSE → extension parses → webview shows modal →
   * user decides → extension receives ToolApprovalResponse → POST /approve to proxy.
   * The proxy SSE stream is blocked until the POST arrives (or the 5-min timeout fires).
   */
  private async handleToolApproval(dataStr: string): Promise<void> {
    let payload: { request_id: string; action: string; params: Record<string, unknown> };
    try { payload = JSON.parse(dataStr); } catch { return; }

    const requestPayload: ToolApprovalRequestPayload = {
      requestId: payload.request_id,
      action: payload.action,
      params: payload.params as ToolApprovalRequestPayload["params"],
    };
    this.bridge?.send({ type: ToWebviewType.ToolApprovalRequest, payload: requestPayload });

    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(payload.request_id)) {
          this.pendingApprovals.delete(payload.request_id);
          resolve(false);
        }
      }, 5 * 60 * 1000);

      this.pendingApprovals.set(payload.request_id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });

    await this.proxyClient.approve(payload.request_id, approved);
  }

  private async handleClientSlashCommand(payload: SlashCommandPayload): Promise<void> {
    const { command } = payload;

    const sendResult = (content: string): void => {
      this.bridge?.send({
        type: ToWebviewType.SlashCommandResult,
        payload: { command, content } satisfies SlashCommandResultPayload,
      });
    };

    try {
      switch (command) {
        case "/copy": {
          sendResult("_Use the webview /copy command for clipboard access._");
          break;
        }

        case "/files": {
          const docs = vscode.workspace.textDocuments
            .filter((d) => !d.isUntitled && d.uri.scheme === "file")
            .map((d) => `- ${vscode.workspace.asRelativePath(d.uri)}`);
          const list = docs.length ? docs.join("\n") : "_(no open files)_";
          await this.handleSendMessage({
            content: `Currently open workspace files:\n${list}\n\nWhat would you like to know about these files?`,
          });
          break;
        }

        case "/simplify": {
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            sendResult("No active editor found. Open a file first.");
            break;
          }
          const content = editor.document.getText();
          const name = vscode.workspace.asRelativePath(editor.document.uri);
          await this.handleSendMessage({
            content: `Here is \`${name}\`:\n\`\`\`\n${content}\n\`\`\`\n\nReview for quality, efficiency and clarity. Suggest simplifications.`,
          });
          break;
        }

        case "/branch": {
          const terminal = vscode.window.createTerminal("Claudio: branch");
          terminal.show();
          terminal.sendText("git checkout -b ");
          sendResult("_Terminal opened — type the branch name and press Enter._");
          break;
        }

        case "/commit-push-pr": {
          const terminal = vscode.window.createTerminal("Claudio: commit-push-pr");
          terminal.show();
          terminal.sendText('git add -A && git commit -m "" && git push && gh pr create');
          sendResult("_Terminal opened for commit → push → PR._");
          break;
        }

        case "/pr-comments": {
          const terminal = vscode.window.createTerminal("Claudio: pr-comments");
          terminal.show();
          terminal.sendText("gh pr view --comments");
          sendResult("_Terminal opened — showing PR comments._");
          break;
        }

        default:
          sendResult(`Unknown client command: \`${command}\``);
      }
    } catch (err: any) {
      sendResult(`**Error running \`${command}\`:** ${err.message as string}`);
    }
  }

  private sendProgress(phase: CodeProgressPhase): void {
    this.bridge?.send({
      type: ToWebviewType.CodeProgress,
      payload: { phase } satisfies CodeProgressPayload,
    });
  }

  private async ensureVenv(onProgress?: (phase: CodeProgressPhase) => void): Promise<string | null> {
    if (this.venvPython) return this.venvPython;

    const isWin = process.platform === "win32";
    const venvBin = join(
      this.venvPath,
      isWin ? "Scripts" : "bin",
      isWin ? "python.exe" : "python",
    );

    if (existsSync(venvBin)) {
      this.venvPython = venvBin;
      return venvBin;
    }

    const sysPy = await findSystemPython();
    if (!sysPy) return null;

    try {
      await mkdir(this.venvPath, { recursive: true });
      onProgress?.("creating_env");
      await runProcess(sysPy, ["-m", "venv", this.venvPath], 60_000);
      onProgress?.("installing_packages");
      await runProcess(
        venvBin,
        ["-m", "pip", "install", "--quiet", "matplotlib", "numpy", "pandas", "scipy"],
        120_000,
      );
      this.venvPython = venvBin;
      return venvBin;
    } catch {
      this.venvPython = sysPy;
      return sysPy;
    }
  }

  private async handleReadFiles(uris: string[]): Promise<void> {
    const attachments: Attachment[] = [];
    for (const uri of uris) {
      try {
        const fileUri = vscode.Uri.parse(uri);
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const name = fileUri.path.split("/").pop() ?? "file";
        const ext = name.split(".").pop()?.toLowerCase() ?? "";
        const imageMimes: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", webp: "image/webp",
        };
        const mimeType = imageMimes[ext] ?? "text/plain";
        const data = Buffer.from(bytes).toString("base64");
        attachments.push({ name, mimeType, data, size: bytes.length });
      } catch {
        // skip unreadable files
      }
    }
    const payload: FilesReadPayload = { attachments };
    this.bridge?.send({ type: ToWebviewType.FilesRead, payload });
  }

  private async handleExecuteCode(code: string): Promise<void> {
    const sendResult = (payload: CodeResultPayload) =>
      this.bridge?.send({ type: ToWebviewType.CodeResult, payload });

    try {
      const python = await this.ensureVenv((phase) => this.sendProgress(phase));
      if (!python) {
        sendResult({ type: "error", data: "Python non trovato. Installa Python 3 e riprova." });
        return;
      }

      const missing = await findMissingModules(python, extractImports(code));
      if (missing.length > 0) {
        this.sendProgress("installing_packages");
        await runProcess(
          python,
          ["-m", "pip", "install", "--quiet", ...missing.map((m) => IMPORT_TO_PACKAGE[m] ?? m)],
          120_000,
        );
      }

      this.sendProgress("executing");

      const id = randomUUID();
      const tmp = tmpdir();
      const pyFile = join(tmp, `claudio_${id}.py`);
      const imgFile = join(tmp, `claudio_${id}.png`);

      const hasPlot = code.includes("plt.");
      let modified = code.replace(
        /plt\.show\(\s*\)/g,
        `plt.savefig(r'${imgFile}', dpi=100, bbox_inches='tight'); plt.close()`,
      );
      if (hasPlot && !code.includes("plt.show()")) {
        modified +=
          `\ntry:\n  import matplotlib.pyplot as _plt\n  _plt.savefig(r'${imgFile}', dpi=100, bbox_inches='tight'); _plt.close()\nexcept Exception:\n  pass\n`;
      }

      try {
        await writeFile(pyFile, modified, "utf-8");
        const { stdout, stderr } = await runProcess(python, [pyFile], 30_000, tmp);

        try {
          const imgData = await readFile(imgFile);
          sendResult({ type: "image", data: imgData.toString("base64") });
          await unlink(imgFile).catch(() => undefined);
        } catch {
          const cleanOut = stripAnsi(stdout.trim());
          const cleanErr = stripAnsi(stderr.trim());
          if (cleanErr && !cleanOut) {
            sendResult({ type: "error", data: cleanErr });
          } else {
            sendResult({ type: "text", data: cleanOut || "(nessun output)" });
          }
        }
      } finally {
        await unlink(pyFile).catch(() => undefined);
      }
    } catch (err: any) {
      sendResult({ type: "error", data: String(err?.message ?? err) });
    }
  }

  private handleCancelStream(): void {
    this.proxyClient.cancel();
  }

  private handleClearHistory(): void {
    this.conversation.length = 0;
  }

  private finalizeAssistantMessage(): void {
    if (this.assistantBuffer || this.conversation[this.conversation.length - 1]?.role === "user") {
      this.conversation.push({
        role: "assistant",
        content: this.assistantBuffer || "(assistant response)",
      });
    }
    this.assistantBuffer = "";
  }
}
