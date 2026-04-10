/**
 * toolManager.ts — Dynamic tool selection and UseTool meta-tool management.
 *
 * Responsible for:
 * 1. Context-aware tool selection using an additive scoring algorithm
 * 2. Generating the UseTool meta-tool definition for overflow tools
 * 3. Automatic promotion of tools used via UseTool into the core set
 * 4. Rewriting UseTool calls back to real tool names in responses
 *
 * The ToolManager maintains in-memory state (promoted tools) that persists
 * across requests within a single proxy session. This allows the tool set
 * to adapt over the course of a conversation.
 *
 * @module application/toolManager
 */

import {
  type OpenAITool,
  type ToolSelection,
  OpenAIToolType,
  ContentBlockType,
  USE_TOOL_NAME,
} from "../domain/types";
import { t } from "../domain/i18n";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Interface (DIP: narrow interface, not full ProxyConfig)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration subset needed by ToolManager.
 * Injected via constructor to decouple from the full ProxyConfig.
 */
export interface ToolManagerConfig {
  /** Ordered list of core tool names that receive the highest base score. */
  coreTools: string[];

  /** Additive score for tools in the core list. */
  scoreCoreTools: number;

  /** Additive score for tools promoted via UseTool. */
  scorePromoted: number;

  /** Additive score for tools that appear in conversation history. */
  scoreUsedInHistory: number;

  /** Additive score for the tool forced by tool_choice. */
  scoreForcedChoice: number;

  /** Number of requests without use before a promoted tool decays. */
  promotionMaxAge: number;

  /** Max characters for each tool description in the UseTool listing. */
  useToolDescMaxLength: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Types
// ─────────────────────────────────────────────────────────────────────────────

/** Tracks a promoted tool's lifetime. */
interface PromotionEntry {
  /** Timestamp when the tool was last promoted (for debugging/logging). */
  timestamp: number;

  /** Number of requests since last use. Incremented each request; reset on use. */
  age: number;
}

/** A tool paired with its computed score for sorting. */
interface ScoredTool {
  tool: OpenAITool;
  score: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages dynamic tool selection, overflow via UseTool, and tool promotion.
 *
 * Scoring algorithm (additive — a tool can receive multiple bonuses):
 *   +scoreForcedChoice   if tool_choice forces this specific tool
 *   +scoreCoreTools      if the tool is in the configured core list
 *   +scorePromoted       if the tool was recently used via UseTool
 *   +scoreUsedInHistory  if the tool appears in the conversation's tool_use blocks
 *
 * Tools are ranked by score. The top (maxTools - 1) become the active set;
 * the rest are listed in the auto-generated UseTool meta-tool definition.
 *
 * @example
 * const tm = new ToolManager(7, config);
 * const selection = tm.selectTools(allTools, messages);
 * // selection.tools = [Bash, Read, Edit, Write, Glob, Grep, UseTool]
 * // selection.overflow = [Agent, TodoWrite, WebSearch, ...]
 */
export class ToolManager {
  /** Maximum tools to send per request (detected or overridden). */
  private maxTools: number;

  /** Configuration for scoring weights and promotion behavior. */
  private readonly cfg: ToolManagerConfig;

  /** Tools promoted via UseTool, keyed by tool name. */
  private readonly promoted = new Map<string, PromotionEntry>();

  /**
   * @param maxTools - Maximum number of tools per request (from probe or override).
   * @param cfg - Tool management configuration (scoring weights, core tools, etc.).
   */
  constructor(maxTools: number, cfg: ToolManagerConfig) {
    this.maxTools = maxTools;
    this.cfg = cfg;
  }

  /** Get the current tool limit. */
  get limit(): number {
    return this.maxTools;
  }

  /** Update the tool limit (e.g., after a late probe result). */
  set limit(n: number) {
    this.maxTools = n;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Select the optimal set of tools for the current request.
   *
   * If the number of tools is within the limit, all are returned unchanged.
   * Otherwise, tools are scored, ranked, and the top (maxTools - 1) are kept
   * as the active set, with UseTool occupying the last slot.
   *
   * @param allTools - All tools from the original request (already in OpenAI format).
   * @param messages - Anthropic-format conversation messages (for history analysis).
   * @param forcedToolName - Tool name forced by tool_choice, if any.
   * @returns Selection result with active tools, overflow, and UseTool definition.
   */
  selectTools(
    allTools: OpenAITool[],
    messages: any[],
    forcedToolName?: string,
  ): ToolSelection {
    // No filtering needed if within the limit or filtering is disabled
    if (this.maxTools <= 0 || allTools.length <= this.maxTools) {
      return { tools: allTools, overflow: [], useToolDef: null };
    }

    // Step 1: Score each tool based on context
    const usedInHistory = this.extractUsedToolNames(messages);
    this.agePromotions();

    const scored: ScoredTool[] = allTools.map(tool => ({
      tool,
      score: this.scoreTool(tool.function.name, usedInHistory, forcedToolName),
    }));

    // Step 2: Sort by score (descending). Stable sort preserves original order for ties.
    scored.sort((a, b) => b.score - a.score);

    // Step 3: Split into core set and overflow
    const slotsForCore = this.maxTools - 1; // reserve one slot for UseTool
    const coreTools = scored.slice(0, slotsForCore).map(s => s.tool);
    const overflowTools = scored.slice(slotsForCore).map(s => s.tool);

    // Step 4: Build the UseTool meta-tool definition listing overflow tools
    const useToolDef = this.buildUseToolDefinition(overflowTools);

    return {
      tools: [...coreTools, useToolDef],
      overflow: overflowTools,
      useToolDef,
    };
  }

  /**
   * Promote a tool that was invoked via UseTool.
   *
   * Promoted tools receive a score bonus in future requests, allowing them
   * to enter the core set automatically if used frequently enough.
   *
   * @param toolName - Name of the tool to promote.
   */
  promoteUsedTool(toolName: string): void {
    this.promoted.set(toolName, { timestamp: Date.now(), age: 0 });
  }

  /**
   * Rewrite a UseTool call's arguments into the real tool name and parameters.
   *
   * Parses the UseTool JSON arguments (`{tool_name, parameters}`) and returns
   * the actual tool name and input. Also promotes the tool for future requests.
   *
   * @param args - Raw JSON string of the UseTool arguments.
   * @returns Rewritten tool name and input, or null if parsing fails.
   */
  rewriteUseToolCall(args: string): { name: string; input: any } | null {
    try {
      const parsed = JSON.parse(args);
      if (parsed.tool_name && typeof parsed.tool_name === "string") {
        this.promoteUsedTool(parsed.tool_name);
        return {
          name: parsed.tool_name,
          input: parsed.parameters ?? {},
        };
      }
    } catch {
      // Malformed JSON — cannot rewrite
    }
    return null;
  }

  /**
   * Check if a tool call name is the UseTool meta-tool.
   *
   * @param name - Tool name from a response tool_call.
   * @returns True if this is a UseTool call that needs rewriting.
   */
  isUseToolCall(name: string): boolean {
    return name === USE_TOOL_NAME;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Compute the additive score for a single tool.
   *
   * Multiple bonuses can stack. For example, a core tool that was also
   * used in history receives: scoreCoreTools + scoreUsedInHistory.
   *
   * @param name - Tool name.
   * @param usedInHistory - Set of tool names found in conversation history.
   * @param forcedToolName - Tool forced by tool_choice, if any.
   * @returns Computed score (higher = more likely to be in the active set).
   */
  private scoreTool(
    name: string,
    usedInHistory: Set<string>,
    forcedToolName?: string,
  ): number {
    let score = 0;

    // Forced tool gets the highest priority to ensure it's always included
    if (forcedToolName === name) score += this.cfg.scoreForcedChoice;

    // Core tools configured by the user get a strong base score
    if (this.cfg.coreTools.includes(name)) score += this.cfg.scoreCoreTools;

    // Recently promoted tools (used via UseTool) get a bonus
    if (this.promoted.has(name)) score += this.cfg.scorePromoted;

    // Tools seen in conversation history are likely needed again
    if (usedInHistory.has(name)) score += this.cfg.scoreUsedInHistory;

    return score;
  }

  /**
   * Extract tool names that were used in the conversation history.
   *
   * Scans all messages for tool_use content blocks (in assistant messages)
   * to identify tools the model has called during this conversation.
   *
   * @param messages - Anthropic-format messages array.
   * @returns Set of tool names found in history.
   */
  private extractUsedToolNames(messages: any[]): Set<string> {
    const names = new Set<string>();
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === ContentBlockType.ToolUse && block.name) {
          names.add(block.name);
        }
      }
    }
    return names;
  }

  /**
   * Age all promoted tools and remove those that have expired.
   *
   * Called once per request. Each promotion's age is incremented;
   * entries older than promotionMaxAge are garbage collected.
   * This ensures the core set doesn't permanently hold tools
   * that are no longer relevant.
   */
  private agePromotions(): void {
    for (const [name, entry] of this.promoted) {
      entry.age++;
      if (entry.age > this.cfg.promotionMaxAge) {
        this.promoted.delete(name);
      }
    }
  }

  /**
   * Build the UseTool meta-tool definition.
   *
   * The description dynamically lists all overflow tools with truncated
   * descriptions so the model knows what's available via UseTool.
   *
   * @param overflowTools - Tools that were filtered out of the active set.
   * @returns OpenAI-format tool definition for UseTool.
   */
  private buildUseToolDefinition(overflowTools: OpenAITool[]): OpenAITool {
    const listing = overflowTools
      .map(tool => {
        const desc = (tool.function.description ?? "").slice(0, this.cfg.useToolDescMaxLength);
        return `- ${tool.function.name}: ${desc}`;
      })
      .join("\n");

    return {
      type: OpenAIToolType.Function,
      function: {
        name: USE_TOOL_NAME,
        description: t("useTool.description", { listing }),
        parameters: {
          type: "object",
          properties: {
            tool_name: {
              type: "string",
              description: t("useTool.toolNameDesc"),
            },
            parameters: {
              type: "object",
              description: t("useTool.parametersDesc"),
            },
          },
          required: ["tool_name", "parameters"],
        },
      },
    };
  }
}
