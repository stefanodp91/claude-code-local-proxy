/**
 * contextCompactor.ts — trim a conversation to fit the model's context window.
 *
 * Extracted from `handleChatMessageUseCase` so both the incoming request and
 * the agent loops can use it. The loops need it: each iteration appends an
 * assistant turn and its tool results with no further budget check, so a long
 * tool-heavy turn could overflow the window halfway through and get a 400 from
 * the backend instead of an answer.
 *
 * Two strategies, in order:
 *
 *   1. **Semantic** — ask the model to summarise the middle of the conversation
 *      and replace it with the summary. Costs one extra call, keeps the sense.
 *   2. **Naive** — drop messages from the front until it fits. Always available,
 *      and the fallback whenever the summary fails, times out, or is disabled.
 *
 * Both then run `repairToolPairing()`, which is the part that is easy to miss:
 * compaction fires exactly when a conversation is long, which in this proxy
 * means exactly when it is full of `tool_use` / `tool_result` pairs. Those are
 * not ordinary messages — after translation they become an assistant turn
 * carrying `tool_calls` and the `tool` messages answering it, and an
 * OpenAI-compatible backend rejects the request outright when either half has
 * lost its partner. Trimming by position cannot see that structure, so the
 * repair pass restores it afterwards.
 *
 * @module application/services/contextCompactor
 */

import { ContentBlockType } from "../../domain/types";
import type { LlmClientPort, LoggerPort } from "../../domain/ports";

/** Fraction of the context window at which compaction triggers. */
const COMPACT_THRESHOLD = 0.80;
/** Fraction of the context window compaction trims down to. */
const COMPACT_TARGET = 0.65;

/** Rough token estimate: 4 chars ≈ 1 token (conservative). */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export interface CompactorOptions {
  /** Try summarising before falling back to dropping messages. */
  semanticEnabled: boolean;
  /** `max_tokens` for the summarisation call. */
  summaryMaxTokens: number;
  /** How long to wait for a summary before falling back. */
  summaryTimeout: number;
}

export interface CompactionOutcome {
  /** True when the conversation was modified. */
  compacted: boolean;
  /** How it was done. */
  strategy: "none" | "semantic" | "naive";
  /** Messages removed (naive) or condensed into a summary (semantic). */
  removed: number;
}

const NOTHING: CompactionOutcome = { compacted: false, strategy: "none", removed: 0 };

export class ContextCompactor {
  constructor(
    private readonly llm: LlmClientPort,
    private readonly logger: LoggerPort,
    private readonly opts: CompactorOptions,
  ) {}

  /**
   * Trim `messages` in place if it exceeds the trigger threshold.
   *
   * @param messages     Anthropic-format messages, modified in place.
   * @param budgetTokens The model's loaded context window. `0` means unknown —
   *                     nothing is trimmed, because guessing a budget and
   *                     trimming on the guess is worse than leaving it alone.
   */
  async compact(messages: any[], budgetTokens: number): Promise<CompactionOutcome> {
    if (budgetTokens <= 0) return NOTHING;
    if (estimateTokens(messages) <= Math.floor(budgetTokens * COMPACT_THRESHOLD)) return NOTHING;

    if (this.opts.semanticEnabled) {
      const condensed = await this.semantic(messages, budgetTokens);
      if (condensed > 0) {
        repairToolPairing(messages);
        this.logger.info(`[compact] summarized ${condensed} message(s) via LLM`);
        return { compacted: true, strategy: "semantic", removed: condensed };
      }
    }

    const dropped = this.naive(messages, budgetTokens);
    repairToolPairing(messages);
    if (dropped > 0) {
      this.logger.info(
        `[compact] dropped ${dropped} message(s) to fit context window (${budgetTokens} tokens)`,
      );
      return { compacted: true, strategy: "naive", removed: dropped };
    }
    return NOTHING;
  }

  // ── Strategies ──────────────────────────────────────────────────────────

  /**
   * Drop messages from the front until the estimate is under target. Keeps the
   * first message (it carries the task) and the last two (what the model is
   * answering right now), and leaves a marker in their place — a conversation
   * silently shortened makes the model contradict itself about things it can no
   * longer see.
   */
  private naive(messages: any[], budgetTokens: number): number {
    const target = Math.floor(budgetTokens * COMPACT_TARGET);
    let dropped = 0;
    while (messages.length > 2 && estimateTokens(messages) > target) {
      messages.splice(1, 1);
      dropped++;
    }
    if (dropped > 0) {
      messages.splice(1, 0, {
        role: "user",
        content: `[${dropped} earlier message(s) were removed to fit the context window.]`,
      });
    }
    return dropped;
  }

  /**
   * Ask the model to summarise everything between the first message and the
   * last two, and put the summary in their place. Returns the number of
   * messages condensed, or 0 if it could not be done — the caller then falls
   * back to dropping.
   *
   * The call races a timeout: it happens mid-request, so a backend that never
   * answers would otherwise hang the user's turn.
   */
  private async semantic(messages: any[], budgetTokens: number): Promise<number> {
    const target = Math.floor(budgetTokens * COMPACT_TARGET);
    if (estimateTokens(messages) <= target) return 0;
    if (messages.length < 4) return 0;

    const toSummarize = messages.slice(1, messages.length - 2);
    if (toSummarize.length === 0) return 0;

    const prompt = [
      "Summarize this conversation history concisely.",
      "Preserve: all file names, decisions made, code written, errors encountered, and current task context.",
      "Output only the summary, no preamble.\n",
      "<history>",
      JSON.stringify(toSummarize, null, 2),
      "</history>",
    ].join("\n");

    try {
      const call = this.llm.chat({
        body: {
          model: "default",
          messages: [{ role: "user", content: prompt }],
          max_tokens: this.opts.summaryMaxTokens,
          stream: false,
        },
        stream: false,
      });
      const timeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), this.opts.summaryTimeout),
      );

      const resp = await Promise.race([call, timeout]);
      if (!resp || !resp.ok || !resp.json) {
        this.logger.dbg("[compact] semantic summary failed or timed out — falling back to naive");
        return 0;
      }

      const summary: string = resp.json.choices?.[0]?.message?.content?.trim() ?? "";
      if (!summary) return 0;

      messages.splice(1, toSummarize.length, {
        role: "user",
        content: `[Conversation summary — ${toSummarize.length} message(s) condensed]:\n${summary}`,
      });
      return toSummarize.length;
    } catch (err) {
      this.logger.dbg(`[compact] semantic summary error: ${String(err)} — falling back to naive`);
      return 0;
    }
  }
}

/**
 * Restore the tool-call ↔ tool-result pairing after messages have been removed,
 * dropping whichever half lost its partner.
 *
 * Handles **both** message shapes, because compaction runs on both sides of the
 * translation: the incoming request is Anthropic (`tool_use` and `tool_result`
 * content blocks) while the agent loops trim their own OpenAI history (an
 * assistant message carrying `tool_calls`, answered by `role: "tool"` messages).
 *
 * Both directions are fatal downstream and neither is visible here: a result
 * with no preceding call becomes a `tool` message with nothing to answer, and a
 * call with no result is one the backend expects a reply for. Either way the
 * request is rejected — and only ever in the long conversations where
 * compaction runs at all, which is to say the ones where a failure costs most.
 *
 * A message whose blocks are all removed is dropped; one that also carried text
 * keeps the text.
 */
export function repairToolPairing(messages: any[]): void {
  repairAnthropicShape(messages);
  repairOpenAiShape(messages);
}

/** OpenAI shape: `assistant.tool_calls[]` answered by `role: "tool"` messages. */
function repairOpenAiShape(messages: any[]): void {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m?.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);
  }

  const opened = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (Array.isArray(m?.tool_calls)) {
      const kept = m.tool_calls.filter((tc: any) => {
        if (!answered.has(tc.id)) return false;
        opened.add(tc.id);
        return true;
      });
      if (kept.length !== m.tool_calls.length) {
        if (kept.length === 0) {
          delete m.tool_calls;
          // An assistant turn with neither text nor calls says nothing at all.
          if (m.content === null || m.content === undefined || m.content === "") {
            messages.splice(i, 1);
            i--;
          }
          continue;
        }
        m.tool_calls = kept;
      }
      continue;
    }

    if (m?.role === "tool" && !opened.has(m.tool_call_id)) {
      messages.splice(i, 1);
      i--;
    }
  }
}

/** Anthropic shape: `tool_use` / `tool_result` content blocks. */
function repairAnthropicShape(messages: any[]): void {
  const answered = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type === ContentBlockType.ToolResult && b.tool_use_id) answered.add(b.tool_use_id);
    }
  }

  const opened = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;

    const kept = m.content.filter((b: any) => {
      if (b?.type === ContentBlockType.ToolUse) {
        if (!answered.has(b.id)) return false; // never answered
        opened.add(b.id);
        return true;
      }
      if (b?.type === ContentBlockType.ToolResult) {
        return opened.has(b.tool_use_id);      // answers something still present
      }
      return true;
    });

    if (kept.length === m.content.length) continue;
    if (kept.length === 0) {
      messages.splice(i, 1);
      i--;
      continue;
    }
    m.content = kept;
  }
}
