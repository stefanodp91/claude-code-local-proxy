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
  type ApprovalScope,
  type SetAgentModePayload,
  type SetEnableThinkingPayload,
  type PlanExitRequestPayload,
  type PlanExitResponsePayload,
  type NotificationPayload,
  type NotificationDismissedPayload,
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

const CONV_STATE_KEY = "claudio.conversation";

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
  /** Called by the reconnect button — restarts the proxy if managed and dead. */
  private reconnectFn: (() => Promise<void>) | null = null;

  /** Workspace root passed as X-Workspace-Root to the proxy. */
  private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  /**
   * Pending tool approval promises keyed by request_id. Each resolver takes
   * the full `{approved, scope}` payload — the scope is forwarded to the
   * proxy so it can honor "allow for this turn" / "always allow this file".
   */
  private readonly pendingApprovals = new Map<string, (result: { approved: boolean; scope: ApprovalScope }) => void>();
  /**
   * Set by `runProxyTurn` when the proxy emits a `plan_mode_exit_suggestion`
   * event. After the stream ends, `handleSendMessage` checks this field and
   * asks the webview to show the embedded PlanExit modal.
   */
  private pendingExitSuggestion: { lastMessage: string; planPath: string | null } | null = null;
  /**
   * Resolver for the PlanExit modal response. Set by `handlePlanExitSuggestion`
   * right before asking the webview for a decision, consumed by the
   * `PlanExitResponse` handler in `attachView`. Only one exit suggestion
   * can be in-flight at a time (the chat is sequential).
   */
  private pendingPlanExitResolver: ((mode: "auto" | "ask" | null) => void) | null = null;
  /**
   * Notifications produced before a webview is attached. Flushed to the
   * bridge in `attachView()` so early-startup errors (e.g. ProxyManager
   * failing) still reach the user once the sidebar opens.
   */
  private readonly bufferedNotifications: NotificationPayload[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStoragePath: string,
    private readonly workspaceState?: vscode.Memento,
  ) {
    this.venvPath = join(globalStoragePath, ".claudio-venv");

    // Restore persisted conversation from workspaceState (survives VS Code reloads)
    const saved = this.workspaceState?.get<ConversationMessage[]>(CONV_STATE_KEY);
    if (saved?.length) {
      this.conversation.push(...saved);
    }

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
    this.bridge.on(ToExtensionType.CheckHealth, () => void this.handleReconnect());
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
      const { requestId, approved, scope } = msg.payload as ToolApprovalResponsePayload;
      const resolve = this.pendingApprovals.get(requestId);
      if (resolve) {
        this.pendingApprovals.delete(requestId);
        resolve({ approved, scope });
      }
    });
    this.bridge.on(ToExtensionType.SetAgentMode, (msg) => {
      void this.handleSetAgentMode((msg.payload as SetAgentModePayload).mode);
    });
    this.bridge.on(ToExtensionType.SetEnableThinking, (msg) => {
      const { enabled } = msg.payload as SetEnableThinkingPayload;
      this.config.enableThinking = enabled;
    });
    this.bridge.on(ToExtensionType.PlanExitResponse, (msg) => {
      const { mode } = msg.payload as PlanExitResponsePayload;
      const resolver = this.pendingPlanExitResolver;
      if (resolver) {
        this.pendingPlanExitResolver = null;
        resolver(mode);
      }
    });
    this.bridge.on(ToExtensionType.NotificationDismissed, (msg) => {
      // Webview tells us the user dismissed a banner. Nothing to persist
      // here — the webview removes it locally — but the hook exists so
      // future features (e.g. deduplication) can subscribe cleanly.
      void (msg.payload as NotificationDismissedPayload);
    });

    // Flush any notifications that arrived before the webview was attached.
    for (const n of this.bufferedNotifications) {
      this.bridge.send({ type: ToWebviewType.NotificationShow, payload: n });
    }
    this.bufferedNotifications.length = 0;

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

  /**
   * Surface an embedded notification banner to the user. Called by
   * `activation.ts` and `ProxyManager` instead of `vscode.window.showErrorMessage`.
   *
   * If a webview is attached the notification is sent immediately. Otherwise
   * it is buffered and flushed when the sidebar opens (see `attachView()`).
   */
  notify(level: "error" | "warn" | "info", message: string): void {
    const payload: NotificationPayload = { id: randomUUID(), level, message };
    if (this.bridge) {
      this.bridge.send({ type: ToWebviewType.NotificationShow, payload });
    } else {
      this.bufferedNotifications.push(payload);
    }
  }

  /**
   * Re-read VS Code settings (including any `setProxyPortOverride` applied
   * since construction) and rebuild the proxy client + health checker URLs.
   * Called from `activation.ts` after `ProxyManager.start()` resolves, so the
   * session picks up the actual port the proxy bound to.
   */
  updateProxyConnection(): void {
    const vs = loadVsCodeSettings();
    const newBaseUrl = proxyBaseUrl(vs);
    this.proxyClient.updateBaseUrl(newBaseUrl);
    this.healthChecker.updateBaseUrl(newBaseUrl);
  }

  /**
   * Register a callback that attempts to restart the proxy before checking
   * health. Called from `activation.ts` when `ProxyManager` is available.
   */
  setReconnectHandler(fn: () => Promise<void>): void {
    this.reconnectFn = fn;
  }

  // ── Reconnect & Proxy config ────────────────────────────────────────────────

  private async handleReconnect(): Promise<void> {
    if (this.reconnectFn) {
      try {
        await this.reconnectFn();
      } catch {
        // Restart failed — health checker will report Disconnected
      }
    }
    this.healthChecker.start();
  }

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
    this.persistConversation();

    await this.runProxyTurn(payload);

    // If the proxy signalled "user wants to exit plan mode", handle it now
    // (after the stream has fully ended). The handler may switch mode and
    // re-run the turn in the new mode.
    if (this.pendingExitSuggestion) {
      await this.handlePlanExitSuggestion();
    }
  }

  /**
   * Run a single proxy turn against the current conversation. Used by
   * `handleSendMessage` for the initial turn and by `handlePlanExitSuggestion`
   * to re-issue the same conversation after switching out of Plan mode.
   *
   * Captures `plan_mode_exit_suggestion` events into `this.pendingExitSuggestion`
   * for the caller to process after the stream ends.
   */
  private async runProxyTurn(payload?: SendMessagePayload): Promise<void> {
    this.pendingExitSuggestion = null;
    try {
      for await (const sseEvent of this.proxyClient.sendMessage({
        messages: this.conversation,
        config: {
          ...this.config,
          ...(payload?.temperature !== undefined && { temperature: payload.temperature }),
          ...(payload?.maxTokens !== undefined && { maxTokens: payload.maxTokens }),
          ...(payload?.systemPrompt !== undefined && { systemPrompt: payload.systemPrompt }),
        },
        workspaceRoot: this.workspaceRoot,
      })) {
        // Custom event: proxy is requesting human approval for a destructive action.
        if (sseEvent.event === "tool_request_pending") {
          await this.handleToolApproval(sseEvent.data);
          continue;
        }

        // Custom event: proxy wrote a plan file — open it as markdown preview.
        if (sseEvent.event === "plan_file_created") {
          void this.handlePlanFileCreated(sseEvent.data);
          continue;
        }

        // Custom event: model called workspace(action="exit_plan_mode").
        // Stash the payload — it's processed after the stream ends.
        if (sseEvent.event === "plan_mode_exit_suggestion") {
          try { this.pendingExitSuggestion = JSON.parse(sseEvent.data); } catch { /* ignore */ }
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
   * Show a VS Code notification asking the user to switch out of Plan mode,
   * then (on confirmation) switch the agent mode and re-run the turn with the
   * existing plan content prepended to the user message — so the model in the
   * new mode has full plan context even though the system prompt no longer
   * injects it.
   */
  private async handlePlanExitSuggestion(): Promise<void> {
    const sugg = this.pendingExitSuggestion;
    this.pendingExitSuggestion = null;
    if (!sugg) return;

    // Ask the webview to show the embedded PlanExit modal.
    this.bridge?.send({
      type: ToWebviewType.PlanExitRequest,
      payload: { planPath: sugg.planPath, lastMessage: sugg.lastMessage } satisfies PlanExitRequestPayload,
    });

    // Wait for the user's decision (comes back via the PlanExitResponse handler
    // registered in attachView). 5-minute safety timeout so we don't hang.
    const chosenMode = await new Promise<"auto" | "ask" | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingPlanExitResolver === resolver) {
          this.pendingPlanExitResolver = null;
          resolve(null);
        }
      }, 5 * 60 * 1000);
      const resolver = (mode: "auto" | "ask" | null): void => {
        clearTimeout(timer);
        resolve(mode);
      };
      this.pendingPlanExitResolver = resolver;
    });

    if (!chosenMode) return; // user chose "Stay in Plan mode" (or timeout)

    // Switch the proxy mode (also broadcasts ConfigUpdate to the webview).
    await this.handleSetAgentMode(chosenMode);

    // Pop the assistant suggestion message we just got — we don't want the
    // re-run to see it as already-answered, otherwise the model in the new
    // mode would think the turn is over.
    if (
      this.conversation.length > 0 &&
      this.conversation[this.conversation.length - 1]?.role === "assistant"
    ) {
      this.conversation.pop();
    }

    // Augment the user's last message with the existing plan content so the
    // model in auto/ask mode has the full plan in its prompt (the auto/ask
    // system prompt does NOT inject existing plans the way plan mode does).
    if (sugg.planPath && this.workspaceRoot) {
      try {
        const fullPath = join(this.workspaceRoot, sugg.planPath.replace(/\\/g, "/"));
        const planContent = await readFile(fullPath, "utf-8");
        const last = this.conversation[this.conversation.length - 1];
        if (last?.role === "user" && typeof last.content === "string") {
          last.content =
            `[Existing plan from \`${sugg.planPath}\`]:\n\n${planContent}\n\n---\n\n${last.content}`;
        }
      } catch {
        // Plan file unreadable — proceed without augmentation.
      }
    }

    this.persistConversation();

    // Re-run the same conversation in the new mode.
    await this.runProxyTurn();
  }

  /**
   * Bridge a tool_request_pending event from the proxy to the webview approval modal.
   *
   * Flow: proxy emits SSE → extension parses → webview shows modal →
   * user decides → extension receives ToolApprovalResponse → POST /approve to proxy.
   * The proxy SSE stream is blocked until the POST arrives (or the 5-min timeout fires).
   */
  private async handleToolApproval(dataStr: string): Promise<void> {
    let payload: {
      request_id: string;
      action: string;
      params: Record<string, unknown>;
      oldContent?: string | null;
    };
    try { payload = JSON.parse(dataStr); } catch { return; }

    const requestPayload: ToolApprovalRequestPayload = {
      requestId: payload.request_id,
      action: payload.action,
      params: payload.params as ToolApprovalRequestPayload["params"],
      oldContent: payload.oldContent,
    };
    this.bridge?.send({ type: ToWebviewType.ToolApprovalRequest, payload: requestPayload });

    const result = await new Promise<{ approved: boolean; scope: ApprovalScope }>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(payload.request_id)) {
          this.pendingApprovals.delete(payload.request_id);
          resolve({ approved: false, scope: "once" });
        }
      }, 5 * 60 * 1000);

      this.pendingApprovals.set(payload.request_id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });

    await this.proxyClient.approve(payload.request_id, result.approved, result.scope);
  }

  /**
   * Opens a plan file written by the model as a markdown preview in the VS Code
   * editor area so the user can review and edit it before switching mode.
   */
  private async handlePlanFileCreated(dataStr: string): Promise<void> {
    let payload: { path: string };
    try { payload = JSON.parse(dataStr); } catch { return; }
    if (!this.workspaceRoot || !payload.path) return;

    const fullPath = join(this.workspaceRoot, payload.path.replace(/\\/g, "/"));
    const uri = vscode.Uri.file(fullPath);

    try {
      // Open rendered preview in the main editor area.
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    } catch (err) {
      this.notify(
        "warn",
        `Could not open plan preview for ${payload.path}: ${String(err)}. Open it manually from the file explorer.`,
      );
    }
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
    this.persistConversation();
  }

  private finalizeAssistantMessage(): void {
    if (this.assistantBuffer || this.conversation[this.conversation.length - 1]?.role === "user") {
      this.conversation.push({
        role: "assistant",
        content: this.assistantBuffer || "(assistant response)",
      });
      this.persistConversation();
    }
    this.assistantBuffer = "";
  }

  private persistConversation(): void {
    void this.workspaceState?.update(CONV_STATE_KEY, this.conversation);
  }

  private async handleSetAgentMode(mode: "ask" | "auto" | "plan"): Promise<void> {
    const actual = await this.proxyClient.setAgentMode(mode);
    if (actual !== undefined) {
      // Keep the local config in sync so subsequent refreshProxyConfig broadcasts
      // include the current mode and never overwrite it with a stale default.
      this.config.agentMode = actual;
      // Broadcast back so the input area reflects the confirmed state immediately.
      this.bridge?.send({
        type: ToWebviewType.ConfigUpdate,
        payload: { agentMode: actual },
      });
    }
  }
}
