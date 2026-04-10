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

export interface ToWebviewMessage {
  type: ToWebviewType;
  payload?: StreamDeltaPayload | StreamErrorPayload | ConnectionStatus | SlashCommandResultPayload | HistoryRestorePayload | Record<string, any>;
}

export interface ToExtensionMessage {
  type: ToExtensionType;
  payload?: SendMessagePayload | SlashCommandPayload | Record<string, any>;
}
