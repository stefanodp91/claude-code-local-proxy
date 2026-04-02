/**
 * responseTranslator.ts — OpenAI → Anthropic non-streaming response translation.
 *
 * Converts OpenAI Chat Completions JSON responses back to Anthropic Messages
 * API format for Claude Code. Handles thinking blocks, text content,
 * tool_calls (including UseTool rewriting), and stop reason mapping.
 *
 * For streaming responses, see streamTranslator.ts.
 *
 * @module application/responseTranslator
 */

import {
  StopReason,
  FinishReason,
  ContentBlockType,
} from "../domain/types";
import type { ToolManager } from "./toolManager";
import { msgId } from "../domain/utils";
import { t } from "../domain/i18n";

// ─────────────────────────────────────────────────────────────────────────────
// ResponseTranslator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translates OpenAI Chat Completions responses to Anthropic Messages format.
 *
 * Handles:
 * - Thinking/reasoning content → thinking blocks
 * - Text content → text blocks
 * - Tool calls → tool_use blocks (with UseTool rewriting via ToolManager)
 * - finish_reason → stop_reason mapping
 * - Usage stats translation
 *
 * @example
 * const translator = new ResponseTranslator(toolManager);
 * const anthropicResponse = translator.translate(openaiJson, "claude-3-opus", false);
 */
export class ResponseTranslator {
  /**
   * @param toolManager - Tool manager for UseTool call rewriting.
   */
  constructor(private readonly toolManager: ToolManager) {}

  /**
   * Translate a non-streaming OpenAI response to Anthropic format.
   *
   * @param openaiJson - Parsed JSON from the OpenAI-compatible endpoint.
   * @param model - Model name to include in the Anthropic response.
   * @param thinkingEnabled - Whether thinking blocks should be emitted.
   * @returns Anthropic Messages API response object.
   */
  translate(openaiJson: any, model: string, thinkingEnabled: boolean): any {
    const choice = openaiJson.choices?.[0];
    if (!choice) {
      return this.buildErrorResponse(t("response.noChoices"));
    }

    const msg = choice.message;
    const content = this.buildContentBlocks(msg, thinkingEnabled);
    const stopReason = this.mapFinishReason(choice.finish_reason, content);
    const usage = openaiJson.usage ?? {};

    return {
      id: msgId(),
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
      },
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Build the Anthropic content blocks array from an OpenAI message.
   *
   * Processes in order: thinking → text → tool_calls.
   * UseTool calls are intercepted and rewritten to the real tool name.
   *
   * @param msg - The OpenAI message object (from choices[0].message).
   * @param thinkingEnabled - Whether to emit thinking blocks.
   * @returns Array of Anthropic content blocks.
   */
  private buildContentBlocks(msg: any, thinkingEnabled: boolean): any[] {
    const content: any[] = [];

    // 1. Thinking block (if enabled and reasoning present)
    if (
      thinkingEnabled &&
      msg.reasoning_content &&
      msg.reasoning_content.length > 0
    ) {
      content.push({
        type: ContentBlockType.Thinking,
        thinking: msg.reasoning_content,
        signature: "",
      });
    }

    // 2. Text block
    const text = msg.content?.trim();
    if (text) {
      content.push({ type: ContentBlockType.Text, text });
    }

    // 3. Tool use blocks (with UseTool rewriting)
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        // Check if this is a UseTool call that needs rewriting
        if (this.toolManager.isUseToolCall(tc.function.name)) {
          const rewritten = this.toolManager.rewriteUseToolCall(tc.function.arguments);
          if (rewritten) {
            content.push({
              type: ContentBlockType.ToolUse,
              id: tc.id,
              name: rewritten.name,
              input: rewritten.input,
            });
            continue;
          }
        }

        // Normal tool call — parse arguments
        content.push({
          type: ContentBlockType.ToolUse,
          id: tc.id,
          name: tc.function.name,
          input: this.parseToolArguments(tc.function.arguments),
        });
      }
    }

    // Ensure at least one content block (Anthropic requires non-empty content)
    if (content.length === 0) {
      content.push({ type: ContentBlockType.Text, text: "" });
    }

    return content;
  }

  /**
   * Map OpenAI finish_reason to Anthropic stop_reason.
   *
   * @param finishReason - OpenAI finish reason string.
   * @param content - Built content blocks (to detect tool_use presence).
   * @returns Anthropic stop reason.
   */
  private mapFinishReason(finishReason: string, content: any[]): StopReason {
    switch (finishReason) {
      case FinishReason.ToolCalls:
        return StopReason.ToolUse;
      case FinishReason.Length:
        return StopReason.MaxTokens;
      default:
        // If content contains tool_use blocks, treat as tool_use stop
        // (some backends return "stop" instead of "tool_calls")
        if (content.some(b => b.type === ContentBlockType.ToolUse)) {
          return StopReason.ToolUse;
        }
        return StopReason.EndTurn;
    }
  }

  /**
   * Safely parse tool call arguments JSON.
   *
   * @param raw - Raw JSON string of tool arguments.
   * @returns Parsed arguments object, or a fallback with the raw string.
   */
  private parseToolArguments(raw: string): any {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }

  /**
   * Build an Anthropic error response object.
   *
   * @param message - Error description.
   * @returns Error response in Anthropic format.
   */
  private buildErrorResponse(message: string): any {
    return {
      type: "error",
      error: { type: "api_error", message },
    };
  }
}
