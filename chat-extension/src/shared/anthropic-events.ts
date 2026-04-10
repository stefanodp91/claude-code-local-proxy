/**
 * anthropic-events.ts — Anthropic SSE event types mirrored from the proxy.
 *
 * These enums match the proxy's domain/types.ts definitions and are
 * used by both the extension host (SSE parsing) and webview (stream processing).
 *
 * @module shared/anthropic-events
 */

export enum SseEventType {
  MessageStart = "message_start",
  ContentBlockStart = "content_block_start",
  ContentBlockDelta = "content_block_delta",
  ContentBlockStop = "content_block_stop",
  MessageDelta = "message_delta",
  MessageStop = "message_stop",
  Error = "error",
}

export enum ContentBlockType {
  Text = "text",
  ToolUse = "tool_use",
  ToolResult = "tool_result",
  Thinking = "thinking",
}

export enum DeltaType {
  TextDelta = "text_delta",
  InputJsonDelta = "input_json_delta",
  ThinkingDelta = "thinking_delta",
}

export enum StopReason {
  EndTurn = "end_turn",
  ToolUse = "tool_use",
  MaxTokens = "max_tokens",
}
