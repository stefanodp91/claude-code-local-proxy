/**
 * requestTranslator.ts — Anthropic → OpenAI request translation.
 *
 * Converts Claude Code's Anthropic Messages API requests into
 * OpenAI Chat Completions format for LM Studio and compatible backends.
 *
 * Handles:
 * - System prompt extraction
 * - Message role/content format conversion
 * - Tool definition translation (Anthropic → OpenAI)
 * - Tool choice mapping
 * - max_tokens capping based on loaded model info
 * - Dynamic tool selection via ToolManager
 *
 * @module application/requestTranslator
 */

import {
  type AnthropicRequest,
  type OpenAIRequest,
  type OpenAITool,
  type LoadedModelInfo,
  type ToolSelection,
  OpenAIToolType,
  ContentBlockType,
  ToolChoiceType,
  MessageRole,
} from "../domain/types.ts";
import type { ProxyConfig } from "../infrastructure/config.ts";
import type { ToolManager } from "./toolManager.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** OpenAI tool_choice value for forced tool calling. */
const OPENAI_TOOL_CHOICE_REQUIRED = "required";

// ─────────────────────────────────────────────────────────────────────────────
// RequestTranslator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translates Anthropic Messages API requests to OpenAI Chat Completions format.
 *
 * Dependencies are injected via constructor (DIP):
 * - LoadedModelInfo: for model remapping and max_tokens capping
 * - ToolManager: for dynamic tool selection and filtering
 * - ProxyConfig: for max_tokens fallback value
 *
 * @example
 * const translator = new RequestTranslator(modelInfo, toolManager, config);
 * const { request, toolSelection } = translator.translate(anthropicBody);
 * // request is ready to POST to the OpenAI-compatible endpoint
 */
export class RequestTranslator {
  /**
   * @param modelInfo - Currently loaded model info (null if unavailable).
   * @param toolManager - Tool manager for dynamic selection.
   * @param config - Proxy configuration for fallback values.
   */
  constructor(
    private readonly modelInfo: LoadedModelInfo | null,
    private readonly toolManager: ToolManager,
    private readonly config: ProxyConfig,
  ) {}

  /**
   * Translate an Anthropic request body into an OpenAI request.
   *
   * @param body - The parsed Anthropic request body from Claude Code.
   * @returns The translated OpenAI request and tool selection metadata.
   */
  translate(body: AnthropicRequest): { request: OpenAIRequest; toolSelection: ToolSelection | null; prunedMessages: number } {
    const maxTokens = this.capMaxTokens(body.max_tokens);
    const allMessages = this.translateMessages(body);
    const messages = this.pruneMessages(allMessages, maxTokens);
    const prunedMessages = allMessages.length - messages.length;

    const req: OpenAIRequest = {
      model: this.modelInfo?.id ?? body.model,
      messages,
      max_tokens: maxTokens,
      stream: body.stream ?? true,
    };

    // Optional parameters — only include if explicitly set
    if (body.temperature !== undefined) req.temperature = body.temperature;
    if (body.top_p !== undefined) req.top_p = body.top_p;
    if (body.stop_sequences) req.stop = body.stop_sequences;

    // Tool translation with dynamic selection
    let toolSelection: ToolSelection | null = null;
    if (body.tools && body.tools.length > 0) {
      const openaiTools = this.translateTools(body.tools);
      const forcedTool = this.extractForcedToolName(body.tool_choice);
      toolSelection = this.toolManager.selectTools(openaiTools, body.messages, forcedTool);
      req.tools = toolSelection.tools;
    }

    // Tool choice mapping
    if (body.tool_choice) {
      req.tool_choice = this.translateToolChoice(body.tool_choice);
    }

    return { request: req, toolSelection, prunedMessages };
  }

  // ── Private: Message Translation ────────────────────────────────────────

  /**
   * Translate the full message array from Anthropic to OpenAI format.
   *
   * Handles:
   * - System prompt (array of text blocks or plain string)
   * - User messages (text + tool_result blocks)
   * - Assistant messages (text + tool_use blocks)
   *
   * @param body - The Anthropic request containing system and messages.
   * @returns Array of OpenAI-format messages.
   */
  private translateMessages(body: AnthropicRequest): any[] {
    const messages: any[] = [];

    // System prompt → system message
    this.appendSystemMessage(body.system, messages);

    // Conversation messages
    for (const msg of body.messages) {
      if (msg.role === MessageRole.User) {
        this.appendUserMessages(msg.content, messages);
      } else if (msg.role === MessageRole.Assistant) {
        this.appendAssistantMessage(msg.content, messages);
      }
    }

    return messages;
  }

  /**
   * Extract and append the system prompt as an OpenAI system message.
   *
   * Anthropic system can be either an array of text blocks or a plain string.
   */
  private appendSystemMessage(system: any, messages: any[]): void {
    if (system) {
      if (Array.isArray(system)) {
        const text = system
          .filter((b: any) => b.type === ContentBlockType.Text)
          .map((b: any) => b.text)
          .join("\n\n");
        if (text) {
          messages.push({ role: MessageRole.System, content: text });
        }
      } else if (typeof system === "string") {
        messages.push({ role: MessageRole.System, content: system });
      }
    }

    // Inject claude-local.md — only active in local proxy sessions, never in premium
    if (this.config.systemPromptAppend) {
      const last = messages[messages.length - 1];
      if (last?.role === MessageRole.System) {
        last.content += "\n\n" + this.config.systemPromptAppend;
      } else {
        messages.push({ role: MessageRole.System, content: this.config.systemPromptAppend });
      }
    }
  }

  /**
   * Translate a user message's content and append to the messages array.
   *
   * User messages in Anthropic format can contain mixed content:
   * - Text blocks → OpenAI user message
   * - Tool result blocks → OpenAI tool messages (must follow assistant's tool_calls)
   * - Thinking/image/document blocks → skipped
   *
   * Tool results are emitted BEFORE user text to maintain proper ordering
   * relative to the assistant's tool_calls they respond to.
   */
  private appendUserMessages(content: any, messages: any[]): void {
    if (typeof content === "string") {
      messages.push({ role: MessageRole.User, content });
      return;
    }
    if (!Array.isArray(content)) {
      messages.push({ role: MessageRole.User, content: String(content ?? "") });
      return;
    }

    const textParts: string[] = [];
    const toolResults: any[] = [];

    for (const block of content) {
      if (block.type === ContentBlockType.ToolResult) {
        toolResults.push(block);
      } else if (block.type === ContentBlockType.Text) {
        textParts.push(block.text);
      }
      // thinking, image, document → skip
    }

    // Emit tool results first (they must follow the assistant's tool_calls)
    for (const tr of toolResults) {
      messages.push({
        role: MessageRole.Tool,
        tool_call_id: tr.tool_use_id,
        content: this.extractToolResultContent(tr.content),
      });
    }

    // Then emit user text if any
    const userText = textParts.join("\n\n");
    if (userText) {
      messages.push({ role: MessageRole.User, content: userText });
    }
  }

  /**
   * Extract text content from a tool_result's content field.
   *
   * The content can be a plain string or an array of text blocks.
   */
  private extractToolResultContent(content: any): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((b: any) => b.type === ContentBlockType.Text)
        .map((b: any) => b.text)
        .join("\n");
    }
    return "";
  }

  /**
   * Translate an assistant message's content and append to the messages array.
   *
   * Assistant messages can contain:
   * - Text blocks → concatenated into the content field
   * - Tool use blocks → translated to OpenAI tool_calls format
   * - Thinking blocks → skipped (model generates its own reasoning)
   */
  private appendAssistantMessage(content: any, messages: any[]): void {
    if (typeof content === "string") {
      messages.push({ role: MessageRole.Assistant, content });
      return;
    }
    if (!Array.isArray(content)) {
      messages.push({ role: MessageRole.Assistant, content: String(content ?? "") });
      return;
    }

    const textParts: string[] = [];
    const toolCalls: any[] = [];

    for (const block of content) {
      if (block.type === ContentBlockType.Text && block.text) {
        textParts.push(block.text);
      } else if (block.type === ContentBlockType.ToolUse) {
        toolCalls.push({
          id: block.id,
          type: OpenAIToolType.Function,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
      // thinking → skip
    }

    const assistantMsg: any = {
      role: MessageRole.Assistant,
      content: textParts.join("\n") || null,
    };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls;
    }
    messages.push(assistantMsg);
  }

  // ── Private: Tool Translation ───────────────────────────────────────────

  /**
   * Convert Anthropic tool definitions to OpenAI format.
   *
   * Anthropic uses `input_schema`; OpenAI uses `parameters`.
   * Anthropic uses top-level `name`/`description`; OpenAI nests under `function`.
   *
   * @param tools - Array of Anthropic-format tool definitions.
   * @returns Array of OpenAI-format tool definitions.
   */
  private translateTools(tools: any[]): OpenAITool[] {
    return tools.map((t: any) => ({
      type: OpenAIToolType.Function,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  /**
   * Map Anthropic tool_choice to OpenAI tool_choice format.
   *
   * Anthropic uses `{type: "auto|any|none|tool", name?: string}`.
   * OpenAI uses `"auto"|"none"|"required"|{type:"function", function:{name:...}}`.
   *
   * Note: LM Studio doesn't support forced tool choice objects,
   * so `tool` type falls back to "required".
   *
   * @param tc - Anthropic tool_choice value.
   * @returns OpenAI-compatible tool_choice value.
   */
  private translateToolChoice(tc: any): string | { type: string; function: { name: string } } {
    if (tc.type === ToolChoiceType.Auto || tc.type === ToolChoiceType.Any) {
      return ToolChoiceType.Auto;
    }
    if (tc.type === ToolChoiceType.None) {
      return ToolChoiceType.None;
    }
    if (tc.type === ToolChoiceType.Tool) {
      // LM Studio doesn't support forced tool choice object → fallback to "required"
      return OPENAI_TOOL_CHOICE_REQUIRED;
    }
    return ToolChoiceType.Auto;
  }

  /**
   * Extract the forced tool name from an Anthropic tool_choice, if any.
   *
   * @param toolChoice - Anthropic tool_choice value.
   * @returns The forced tool name, or undefined if not forcing a specific tool.
   */
  private extractForcedToolName(toolChoice: any): string | undefined {
    if (toolChoice?.type === ToolChoiceType.Tool && toolChoice.name) {
      return toolChoice.name;
    }
    return undefined;
  }

  // ── Private: Model Limits ──────────────────────────────────────────────

  /**
   * Cap max_tokens to prevent runaway generation on small models.
   *
   * Claude Code sends max_tokens=32000+ which can cause infinite
   * repetition loops on local models. This caps the value using
   * the loaded model's context/ratio, with a configurable fallback.
   *
   * @param requested - max_tokens value from Claude Code.
   * @returns Capped max_tokens value.
   */
  private capMaxTokens(requested: number): number {
    const cap = this.modelInfo?.maxTokensCap ?? this.config.maxTokensFallback;
    return cap > 0 ? Math.min(requested, cap) : requested;
  }

  // ── Private: Context Pruning ──────────────────────────────────────────────

  /**
   * Estimate token count for an array of messages using a char/4 heuristic.
   * Fast and model-agnostic — no tokenizer needed.
   */
  private estimateTokens(messages: any[]): number {
    return Math.ceil(
      messages.reduce((sum, m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        const toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls) : "";
        return sum + (content.length + toolCalls.length) / 4;
      }, 0),
    );
  }

  /**
   * Prune oldest conversation turns when messages exceed the available context budget.
   *
   * Budget = loadedContextLength - cappedMaxTokens.
   * If loadedContextLength is unavailable, falls back to maxTokensFallback * contextToMaxTokensRatio.
   *
   * The system message and the last user turn are always preserved.
   * Turns are removed oldest-first in complete units (assistant + following tool/user responses)
   * to keep the conversation structurally valid.
   *
   * @param messages - Translated OpenAI-format messages.
   * @param cappedMaxTokens - Already-capped max_tokens for this request.
   * @returns Pruned messages array (may be identical if no pruning needed).
   */
  private pruneMessages(messages: any[], cappedMaxTokens: number): any[] {
    const contextLength =
      this.modelInfo?.loadedContextLength ??
      (this.config.maxTokensFallback * this.config.contextToMaxTokensRatio);

    const budget = contextLength - cappedMaxTokens;
    if (budget <= 0) return messages;

    if (this.estimateTokens(messages) <= budget) return messages;

    // Separate the system message (always first, always kept)
    const system = messages[0]?.role === "system" ? [messages[0]] : [];
    const conversation = messages[0]?.role === "system" ? messages.slice(1) : messages;

    // Find conversation "turns": each turn starts at an assistant message.
    // We identify turn boundaries by assistant message indices, then drop
    // the oldest turn (and all its associated tool/user follow-ups) at a time.
    let pruned = [...conversation];
    while (pruned.length > 1 && this.estimateTokens([...system, ...pruned]) > budget) {
      // Find the first assistant message index — drop from there until the next assistant
      const firstAssistantIdx = pruned.findIndex(m => m.role === "assistant");
      if (firstAssistantIdx === -1) break; // nothing left to prune

      // Find where the next turn starts (next assistant message after this one)
      const nextAssistantIdx = pruned.findIndex(
        (m, i) => i > firstAssistantIdx && m.role === "assistant",
      );

      const cutEnd = nextAssistantIdx === -1 ? pruned.length : nextAssistantIdx;
      pruned = [...pruned.slice(0, firstAssistantIdx), ...pruned.slice(cutEnd)];
    }

    return [...system, ...pruned];
  }
}
