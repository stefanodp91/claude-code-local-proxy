/**
 * types.ts — Shared type definitions for the Anthropic-to-OpenAI proxy.
 *
 * Contains all enums, interfaces, and type aliases used across modules.
 * No runtime logic — pure type declarations and enum values.
 *
 * @module types
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/** Log severity levels used by the Logger class. */
export enum LogLevel {
  Info = "info",
  Debug = "debug",
  Error = "error",
}

/** Anthropic stop reasons sent back to Claude Code in responses. */
export enum StopReason {
  EndTurn = "end_turn",
  ToolUse = "tool_use",
  MaxTokens = "max_tokens",
}

/** OpenAI finish reasons received from LM Studio / compatible backends. */
export enum FinishReason {
  Stop = "stop",
  ToolCalls = "tool_calls",
  Length = "length",
}

/** Values for the `thinking.type` field in Anthropic requests. */
export enum ThinkingType {
  Enabled  = "enabled",
  Adaptive = "adaptive",
  Disabled = "disabled",
}

/** Anthropic content block types in messages. */
export enum ContentBlockType {
  Text = "text",
  ToolUse = "tool_use",
  ToolResult = "tool_result",
  Thinking = "thinking",
  Image = "image",
}

/** Anthropic SSE event types emitted in streaming responses. */
export enum SseEventType {
  MessageStart = "message_start",
  ContentBlockStart = "content_block_start",
  ContentBlockDelta = "content_block_delta",
  ContentBlockStop = "content_block_stop",
  MessageDelta = "message_delta",
  MessageStop = "message_stop",
  Error = "error",
}

/**
 * Custom (non-Anthropic) SSE events emitted by the proxy to its client.
 * The chat-extension handles these in `chat-session.ts` and the webview.
 */
export enum CustomSseEvent {
  /** Emitted when a destructive action needs user approval. Client responds via POST /approve. */
  ToolRequestPending     = "tool_request_pending",
  /** Emitted right after the model writes a plan file. Client opens it as markdown preview. */
  PlanFileCreated        = "plan_file_created",
  /** Emitted when the model calls `workspace(action="exit_plan_mode")`. Client shows the embedded PlanExit modal. */
  PlanModeExitSuggestion = "plan_mode_exit_suggestion",
}

/** HTTP methods used by the proxy router. */
export enum HttpMethod {
  Get  = "GET",
  Post = "POST",
}

/** Known proxy HTTP endpoints. `/v1/messages/:id/approve` uses a regex match, not this enum. */
export enum ProxyEndpoint {
  Health    = "/health",
  Config    = "/config",
  Commands  = "/commands",
  AgentMode = "/agent-mode",
  Messages  = "/v1/messages",
}

/**
 * Approval scope chosen by the user when confirming a destructive action.
 * Mirrors the shared type in `chat-extension/src/shared/message-protocol.ts`.
 *
 * - Once: approve only this specific action (default)
 * - Turn: approve all destructive actions until the current turn ends
 * - File: approve this action AND future write/edit on the same path for the rest of the session
 */
export enum ApprovalScope {
  Once = "once",
  Turn = "turn",
  File = "file",
}

/** Result of an approval request — returned by the `ApprovalInteractorPort` and consumed by the agent loop. */
export interface ApprovalResult {
  approved: boolean;
  scope:    ApprovalScope;
}

/** Anthropic tool_choice type values sent by Claude Code. */
export enum ToolChoiceType {
  Auto = "auto",
  Any = "any",
  None = "none",
  Tool = "tool",
}

/**
 * OpenAI `tool_choice` values sent to the LLM backend.
 * Distinct from {@link ToolChoiceType} (Anthropic side): different protocol.
 */
export enum OpenAIToolChoice {
  Auto = "auto",
  Required = "required",
  None = "none",
}

/**
 * Agent gating mode — controls how destructive workspace actions
 * (write, edit, bash) are authorized by the proxy.
 *
 * - {@link AgentMode.Ask}  (default): show a user-approval modal per action
 * - {@link AgentMode.Auto}          : auto-approve all actions, no prompts
 * - {@link AgentMode.Plan}          : block destructive actions; force the
 *                                     model to produce a plan file instead
 */
export enum AgentMode {
  Ask = "ask",
  Auto = "auto",
  Plan = "plan",
}

/** Supported locales for i18n. Only en_US is currently available. */
export enum Locale {
  EnUS = "en_US",
}

/**
 * Delta type identifiers used in Anthropic streaming content_block_delta events.
 * Each delta type corresponds to a specific content block update.
 */
export enum DeltaType {
  TextDelta = "text_delta",
  InputJsonDelta = "input_json_delta",
  ThinkingDelta = "thinking_delta",
}

/** OpenAI message roles in the chat completions API. */
export enum MessageRole {
  System = "system",
  User = "user",
  Assistant = "assistant",
  Tool = "tool",
}

/** OpenAI tool type — currently only "function" is supported. */
export enum OpenAIToolType {
  Function = "function",
}

/** Well-known name for the proxy-injected meta-tool. */
export const USE_TOOL_NAME = "UseTool" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces — Model Info
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Information about the model currently loaded in LM Studio.
 * Fetched from the LM Studio internal API (/api/v0/models) at startup.
 */
export interface LoadedModelInfo {
  /** Model identifier as reported by LM Studio (e.g., "nemotron-cascade-2-30b-a3b@6bit"). */
  id: string;

  /** Model type as reported by LM Studio: "llm" for text-only, "vlm" for vision-language models. */
  type: string;

  /** Who quantized/published the model (e.g., "bartowski", "lmstudio-community"). */
  publisher: string;

  /** Model architecture family (e.g., "nemotron_h", "llama"). */
  arch: string;

  /** Quantization format (e.g., "6bit", "Q4_K_M"). */
  quantization: string;

  /** Execution backend (e.g., "gguf", "mlx"). */
  compatibilityType: string;

  /** Context window actually loaded (may be less than max due to VRAM constraints). */
  loadedContextLength: number;

  /** Maximum context window supported by the model architecture. */
  maxContextLength: number;

  /** Model capabilities as reported by LM Studio (e.g., ["tool_use"]).
   *  NOTE: this list is unreliable — LM Studio does not expose reasoning
   *  support even for models that produce `reasoning_content`. Prefer the
   *  probe-derived flags below (`supportsThinking`, `maxTools`). */
  capabilities: string[];

  /** Derived max_tokens cap: loadedContextLength / contextToMaxTokensRatio. */
  maxTokensCap: number;

  /** Populated at model-change time by `ThinkingDetector`. Reflects an actual
   *  probe of the model, not LM Studio's declared capabilities. */
  supportsThinking?: boolean;

  /** Populated by the second `ThinkingDetector` probe. True iff the model
   *  honors `enable_thinking: false` and stops emitting reasoning_content. */
  thinkingCanBeDisabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces — Anthropic API (incoming from Claude Code)
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic Messages API request body as sent by Claude Code. */
export interface AnthropicRequest {
  model: string;
  messages: any[];
  system?: any[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  thinking?: { type: ThinkingType; budget_tokens?: number };
  stop_sequences?: string[];
  [key: string]: any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces — OpenAI API (outgoing to LM Studio)
// ─────────────────────────────────────────────────────────────────────────────

/** OpenAI Chat Completions request body sent to LM Studio. */
export interface OpenAIRequest {
  model: string;
  messages: any[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function: { name: string } };
  stop?: string[];
  enable_thinking?: boolean;
}

/** OpenAI function tool definition. */
export interface OpenAITool {
  type: OpenAIToolType.Function;
  function: {
    name: string;
    description?: string;
    parameters?: any;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces — Cached Model Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-model capabilities detected at runtime and persisted across restarts.
 * Fields are optional — only those that have been probed are populated.
 *
 * Extend this interface to add new detectable characteristics.
 * Existing cache entries will simply lack the new fields until re-probed.
 */
export interface ModelCapabilities {
  /** Maximum number of tools the model accepts in a single request. */
  maxTools?: number;

  /** Whether the model produces `reasoning_content` (thinking) when asked. */
  supportsThinking?: boolean;

  /** Whether `enable_thinking: false` actually suppresses reasoning on this
   *  model. False for models that always think (e.g. QwQ, DeepSeek-R1). */
  thinkingCanBeDisabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces — Tool Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of the dynamic tool selection algorithm.
 * Returned by ToolManager.selectTools() for each request.
 */
export interface ToolSelection {
  /** Tools to send to the model (core set + optional UseTool). */
  tools: OpenAITool[];

  /** Tools that were filtered out and are accessible via UseTool. */
  overflow: OpenAITool[];

  /** The generated UseTool definition, or null if no filtering was needed. */
  useToolDef: OpenAITool | null;
}
