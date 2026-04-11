/**
 * thinkingProbe.ts — Auto-detection of model reasoning/thinking support.
 *
 * Sends a single non-streaming request with `enable_thinking: true` and a
 * deterministic math prompt ("What is 17 times 23? Think step by step.").
 * If the response's `choices[0].message.reasoning_content` is a non-empty
 * string, the model is declared to support thinking.
 *
 * Why not use LM Studio's `capabilities` list: that list is unreliable —
 * Gemma 4 31B is declared as `["tool_use"]` yet produces reasoning_content.
 * The only robust check is to ask the model and observe.
 *
 * @module infrastructure/thinkingProbe
 */

import type { ILogger } from "../domain/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Subset of ProxyConfig needed by ThinkingProbe. */
export interface ThinkingProbeConfig {
  /** max_tokens for the probe request (keep low for speed). */
  probeMaxTokens: number;

  /** Timeout in milliseconds for the probe fetch request. */
  probeTimeout: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic prompt that reliably triggers reasoning on thinking models. */
const PROBE_PROMPT = "What is 17 times 23? Think step by step.";

// ─────────────────────────────────────────────────────────────────────────────
// ThinkingProbe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines whether a model produces reasoning_content at runtime.
 *
 * @example
 * const probe = new ThinkingProbe("http://127.0.0.1:1234/v1/chat/completions", cfg, logger);
 * const supports = await probe.detect("google/gemma-4-31b"); // → true
 */
export class ThinkingProbe {
  /**
   * @param targetUrl - The OpenAI-compatible chat completions endpoint URL.
   * @param cfg - Probe configuration.
   * @param logger - Logger for progress / errors.
   */
  constructor(
    private readonly targetUrl: string,
    private readonly cfg: ThinkingProbeConfig,
    private readonly logger: ILogger,
  ) {}

  /**
   * Run the probe once with a specific `enable_thinking` value.
   *
   * Used twice by `ThinkingDetector`:
   *   1. With `enableThinking=true`  → does the model produce `reasoning_content` at all?
   *   2. With `enableThinking=false` → does the model honor the disable request?
   *
   * @param modelId - Model identifier to include in the request body.
   * @param enableThinking - Value to send for the `enable_thinking` parameter.
   * @returns True if the response contains non-empty `reasoning_content`.
   */
  async detect(modelId: string, enableThinking: boolean): Promise<boolean> {
    try {
      const res = await fetch(this.targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.cfg.probeTimeout),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: PROBE_PROMPT }],
          max_tokens: this.cfg.probeMaxTokens,
          stream: false,
          enable_thinking: enableThinking,
        }),
      });

      if (!res.ok) {
        this.logger.dbg(`[thinking probe] HTTP ${res.status} (enable_thinking=${enableThinking}) — treating as no reasoning`);
        return false;
      }

      const json = (await res.json()) as any;
      const reasoning = json?.choices?.[0]?.message?.reasoning_content;
      return typeof reasoning === "string" && reasoning.trim().length > 0;
    } catch (err) {
      this.logger.dbg(`[thinking probe] error (enable_thinking=${enableThinking}): ${String(err)}`);
      return false;
    }
  }
}
