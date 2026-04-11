/**
 * message-protocol.ts — Typed contract between extension host and Angular webview.
 *
 * Shared via source-level import by both the extension (esbuild) and
 * the webview (Angular CLI) build pipelines.
 *
 * @module shared/message-protocol
 */

// ─────────────────────────────────────────────────────────────────────────────
// Direction: Extension → Webview
// ─────────────────────────────────────────────────────────────────────────────

export enum ToWebviewType {
  StreamDelta = "streamDelta",
  StreamEnd = "streamEnd",
  StreamError = "streamError",
  ConnectionStatus = "connectionStatus",
  ConfigUpdate = "configUpdate",
  SlashCommandResult = "slashCommandResult",
  CodeResult = "codeResult",
  CodeProgress = "codeProgress",
  HistoryRestore = "historyRestore",
  FilesRead = "filesRead",
  ToolApprovalRequest = "toolApprovalRequest",
  PlanExitRequest = "planExitRequest",
  NotificationShow = "notificationShow",
  NotificationDismiss = "notificationDismiss",
}

// ─────────────────────────────────────────────────────────────────────────────
// Direction: Webview → Extension
// ─────────────────────────────────────────────────────────────────────────────

export enum ToExtensionType {
  SendMessage = "sendMessage",
  CancelStream = "cancelStream",
  CheckHealth = "checkHealth",
  ClearHistory = "clearHistory",
  UpdateConfig = "updateConfig",
  ExecuteSlashCommand = "executeSlashCommand",
  ExecuteCode = "executeCode",
  ReadFiles = "readFiles",
  ToolApprovalResponse = "toolApprovalResponse",
  SetAgentMode = "setAgentMode",
  SetEnableThinking = "setEnableThinking",
  PlanExitResponse = "planExitResponse",
  NotificationDismissed = "notificationDismissed",
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection Status
// ─────────────────────────────────────────────────────────────────────────────

export enum ConnectionStatus {
  Connected = "connected",
  Disconnected = "disconnected",
  Checking = "checking",
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash Command Types (shared with proxy registry shape)
// ─────────────────────────────────────────────────────────────────────────────

export interface SlashCommand {
  name: string;
  descriptionKey: string; // i18n key: slash.commands.*
  handler: "proxy" | "client";
}

export interface SlashCommandPayload {
  command: string; // e.g. '/branch', '/copy'
}

export interface SlashCommandResultPayload {
  command: string;
  content: string; // markdown to display as a system message
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecuteCodePayload {
  code: string;
}

export interface CodeResultPayload {
  type: "image" | "text" | "error";
  data: string; // base64 PNG | stdout text | error message
}

export type CodeProgressPhase = "creating_env" | "installing_packages" | "executing";

export interface CodeProgressPayload {
  phase: CodeProgressPhase;
}

export interface StreamDeltaPayload {
  eventType: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
    signature?: string;
  };
  message?: {
    id: string;
    type: string;
    role: string;
    model: string;
    content: any[];
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
  usage?: { output_tokens: number };
  stop_reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachment Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Attachment {
  name: string;
  mimeType: string; // e.g. "image/png", "text/typescript"
  data: string;     // base64 encoded content
  size: number;
}

export interface ReadFilesPayload {
  uris: string[];
}

export interface FilesReadPayload {
  attachments: Attachment[];
}

export interface SendMessagePayload {
  content: string;
  attachments?: Attachment[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface StreamErrorPayload {
  message: string;
  code?: string;
}

export interface HistoryRestorePayload {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Envelope Types
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Tool Approval Types
// ─────────────────────────────────────────────────────────────────────────────

/** Sent from extension → webview when the proxy requests approval for a destructive action. */
export interface ToolApprovalRequestPayload {
  requestId: string;
  action: string;
  params: {
    path?: string;
    pattern?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
    cmd?: string;
    [key: string]: string | undefined;
  };
  /**
   * For `write` actions on existing files: the current file contents.
   * `null` means the file does not exist yet (new file — no diff, just added lines).
   * `undefined` for non-write actions.
   */
  oldContent?: string | null;
}

/**
 * Approval scope chosen by the user when confirming a destructive action.
 *
 * - `once`  — the default. Approve only this specific action.
 * - `turn`  — approve all destructive actions until the current turn ends.
 *             The proxy stores the flag in the agent-loop closure, so it
 *             resets automatically on the next user message.
 * - `file`  — approve this action AND any future write/edit on the same path
 *             until the proxy process restarts. Not applicable to bash.
 */
export type ApprovalScope = "once" | "turn" | "file";

/** Sent from webview → extension after the user approves or denies a tool action. */
export interface ToolApprovalResponsePayload {
  requestId: string;
  approved: boolean;
  scope: ApprovalScope;
}

/** Agent mode controls how the proxy gates destructive workspace actions. */
export type AgentMode = "ask" | "auto" | "plan";

/** Sent from webview → extension to set the agent mode on the proxy. */
export interface SetAgentModePayload {
  mode: AgentMode;
}

/** Sent from webview → extension to toggle thinking for subsequent messages.
 *  Session-scoped — the extension updates `config.enableThinking` in memory,
 *  and the next call to `sendMessage` will (or won't) include `thinking.type`. */
export interface SetEnableThinkingPayload {
  enabled: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan-Mode Exit Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent from extension → webview when the model calls `workspace(action="exit_plan_mode")`.
 * The webview shows an embedded modal asking the user to switch to Auto/Ask mode
 * or stay in Plan mode.
 */
export interface PlanExitRequestPayload {
  /** Relative path of the existing plan file, if any. `null` when the model signals exit before writing any plan. */
  planPath: string | null;
  /** The user's latest message text (used to re-run the turn after the mode switch). */
  lastMessage: string;
}

/** Sent from webview → extension after the user picks an option in the PlanExit modal. */
export interface PlanExitResponsePayload {
  /** `null` = "Stay in Plan mode" (no change). Otherwise the new agent mode. */
  mode: "auto" | "ask" | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification Banner Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Embedded banner shown at the top of the chat. Used to surface errors and
 * informational messages without resorting to `vscode.window.showErrorMessage`.
 */
export interface NotificationPayload {
  id: string;
  level: "error" | "warn" | "info";
  message: string;
}

/** Sent from webview → extension when the user dismisses a banner with the × button. */
export interface NotificationDismissedPayload {
  id: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Envelope Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToWebviewMessage {
  type: ToWebviewType;
  payload?:
    | StreamDeltaPayload
    | StreamErrorPayload
    | ConnectionStatus
    | SlashCommandResultPayload
    | HistoryRestorePayload
    | ToolApprovalRequestPayload
    | PlanExitRequestPayload
    | NotificationPayload
    | Record<string, any>;
}

export interface ToExtensionMessage {
  type: ToExtensionType;
  payload?:
    | SendMessagePayload
    | SlashCommandPayload
    | ToolApprovalResponsePayload
    | SetAgentModePayload
    | SetEnableThinkingPayload
    | PlanExitResponsePayload
    | NotificationDismissedPayload
    | Record<string, any>;
}
