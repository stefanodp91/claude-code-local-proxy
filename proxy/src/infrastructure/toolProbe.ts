/**
 * toolProbe.ts — Auto-detection of model tool calling limits.
 *
 * Uses a binary search strategy to determine the maximum number of
 * tools a model can handle in structured tool calling mode. Sends
 * lightweight probe requests with dummy tools and checks whether
 * the model returns structured tool_calls or falls back to text.
 *
 * This runs once at startup (unless overridden by MAX_TOOLS env).
 *
 * @module infrastructure/toolProbe
 */

import type { ILogger } from "../domain/ports";
import { t } from "../domain/i18n";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Interface (DIP: depend on a narrow interface, not full config)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration subset needed by ToolProbe.
 * Extracted from ProxyConfig to avoid coupling to the full config shape.
 */
export interface ToolProbeConfig {
  /** Maximum number of tools to test in binary search (upper bound). */
  probeUpperBound: number;

  /** max_tokens for each probe request (keep low for speed). */
  probeMaxTokens: number;

  /** Timeout in milliseconds for each probe fetch request. */
  probeTimeout: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Prefix for dummy tool names generated during probing. */
const PROBE_TOOL_PREFIX = "probe_tool_";

/** Message sent to the model during probe requests. */
const PROBE_USER_MESSAGE = "Call probe_tool_0 with x='test'";

/** Tool choice value that forces the model to produce a tool call. */
const PROBE_TOOL_CHOICE = "required";

/** Minimum number of tools to test (lower bound of binary search). */
const PROBE_LOWER_BOUND = 1;

// ─────────────────────────────────────────────────────────────────────────────
// ToolProbe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines the maximum number of tools a model can handle
 * in structured tool calling mode via binary search.
 *
 * The probe sends non-streaming requests with `tool_choice: "required"`
 * and an increasing number of dummy tools. A test passes if the response
 * contains a non-empty `tool_calls` array; it fails if the model puts
 * the tool call JSON into the content text instead.
 *
 * @example
 * const probe = new ToolProbe("http://127.0.0.1:1234/v1/chat/completions", cfg, logger);
 * const maxTools = await probe.detect("nemotron-cascade-2-30b-a3b@6bit");
 * // Logs: "Probing tool limit... 16→❌ 8→❌ 4→✅ 6→✅ 7→✅ | Max tools detected: 7"
 */
export class ToolProbe {
  /**
   * @param targetUrl - The OpenAI-compatible chat completions endpoint URL.
   * @param cfg - Probe configuration (upper bound, max_tokens per probe).
   * @param logger - Logger instance for progress output.
   */
  constructor(
    private readonly targetUrl: string,
    private readonly cfg: ToolProbeConfig,
    private readonly logger: ILogger,
  ) {}

  /**
   * Run the binary search probe to detect the model's tool limit.
   *
   * @param modelId - Model identifier to use in probe requests.
   * @returns Maximum number of tools supported (0 if tool calling is unsupported).
   */
  async detect(modelId: string): Promise<number> {
    this.logger.info(t("probe.start"));

    // First: verify tool calling works at all with a single tool
    if (!await this.testWithNTools(modelId, PROBE_LOWER_BOUND)) {
      this.logger.info(t("probe.noSupport"));
      return 0;
    }

    // Binary search: find the largest N where structured tool calling works
    let lo = PROBE_LOWER_BOUND;
    let hi = this.cfg.probeUpperBound;
    let maxWorking = PROBE_LOWER_BOUND;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const ok = await this.testWithNTools(modelId, mid);

      if (ok) {
        this.logger.info(t("probe.result.ok", { n: mid }));
        maxWorking = mid;
        lo = mid + 1;
      } else {
        this.logger.info(t("probe.result.fail", { n: mid }));
        hi = mid - 1;
      }
    }

    this.logger.info(t("probe.detected", { max: maxWorking }));
    return maxWorking;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Test whether the model produces structured tool_calls with N tools.
   *
   * Sends a non-streaming request with N dummy tools and tool_choice "required".
   * Returns true if the response contains a non-empty tool_calls array.
   *
   * @param modelId - Model identifier.
   * @param n - Number of dummy tools to include.
   * @returns True if the model produced structured tool calls.
   */
  private async testWithNTools(modelId: string, n: number): Promise<boolean> {
    const tools = this.generateDummyTools(n);

    try {
      const res = await fetch(this.targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.cfg.probeTimeout),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: PROBE_USER_MESSAGE }],
          tools,
          tool_choice: PROBE_TOOL_CHOICE,
          max_tokens: this.cfg.probeMaxTokens,
          stream: false,
        }),
      });

      if (!res.ok) return false;

      const json = (await res.json()) as any;
      const toolCalls = json.choices?.[0]?.message?.tool_calls;
      return Array.isArray(toolCalls) && toolCalls.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Generate an array of N dummy tool definitions for probing.
   * Each tool has a simple string parameter to minimize token overhead.
   *
   * @param n - Number of dummy tools to generate.
   * @returns Array of OpenAI-format tool definitions.
   */
  private generateDummyTools(n: number): any[] {
    return Array.from({ length: n }, (_, i) => ({
      type: "function",
      function: {
        name: `${PROBE_TOOL_PREFIX}${i}`,
        description: `Probe tool ${i}`,
        parameters: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      },
    }));
  }
}
