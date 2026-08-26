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

/**
 * Multiplier applied to `probeTimeout` when retrying an inconclusive attempt.
 * A larger tool array means a larger prompt and a slower reply, so the retry
 * gets proportionally more room before we give up on it.
 */
const PROBE_RETRY_TIMEOUT_FACTOR = 3;

/**
 * Outcome of a single probe attempt.
 *
 * The distinction matters: a request that timed out tells us nothing about the
 * model's capability, while a reply carrying no `tool_calls` genuinely does.
 * Collapsing both into `false` biases the binary search downward, because a
 * bigger tool array is exactly what makes a reply slow enough to time out.
 */
export type ProbeOutcome = "tool_calls" | "no_tool_calls" | "inconclusive";

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
    if (await this.attempt(modelId, PROBE_LOWER_BOUND) !== "tool_calls") {
      this.logger.info(t("probe.noSupport"));
      return 0;
    }

    // Binary search: find the largest N where structured tool calling works
    let lo = PROBE_LOWER_BOUND;
    let hi = this.cfg.probeUpperBound;
    let maxWorking = PROBE_LOWER_BOUND;
    let timedOut = false;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const outcome = await this.attempt(modelId, mid);

      if (outcome === "tool_calls") {
        this.logger.info(t("probe.result.ok", { n: mid }));
        maxWorking = mid;
        lo = mid + 1;
        continue;
      }

      if (outcome === "inconclusive") {
        // We never got an answer, so this says nothing about the model. Treat
        // it as a ceiling only so the search terminates, and say so out loud —
        // the reported number is a floor, not the model's real limit.
        this.logger.info(t("probe.result.timeout", { n: mid }));
        timedOut = true;
      } else {
        this.logger.info(t("probe.result.fail", { n: mid }));
      }
      hi = mid - 1;
    }

    if (timedOut) {
      this.logger.info(t("probe.detected.capped", { max: maxWorking }));
    } else if (maxWorking === this.cfg.probeUpperBound) {
      this.logger.info(t("probe.detected.atBound", { max: maxWorking }));
    } else {
      this.logger.info(t("probe.detected", { max: maxWorking }));
    }
    return maxWorking;
  }

  /**
   * Run one probe attempt, retrying once with a longer timeout when the first
   * try is inconclusive. Only after the retry also fails to produce an answer
   * do we report `inconclusive` to the search.
   */
  private async attempt(modelId: string, n: number): Promise<ProbeOutcome> {
    const first = await this.testWithNTools(modelId, n, this.cfg.probeTimeout);
    if (first !== "inconclusive") return first;
    return this.testWithNTools(modelId, n, this.cfg.probeTimeout * PROBE_RETRY_TIMEOUT_FACTOR);
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
  private async testWithNTools(modelId: string, n: number, timeoutMs: number): Promise<ProbeOutcome> {
    const tools = this.generateDummyTools(n);

    try {
      const res = await fetch(this.targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: PROBE_USER_MESSAGE }],
          tools,
          tool_choice: PROBE_TOOL_CHOICE,
          max_tokens: this.cfg.probeMaxTokens,
          stream: false,
        }),
      });

      // A non-2xx says something went wrong on the backend, not that the model
      // declined to call a tool — the search must not read it as a capability.
      if (!res.ok) {
        this.logger.dbg(`[probe] n=${n} HTTP ${res.status} — inconclusive`);
        return "inconclusive";
      }

      const json = (await res.json()) as any;
      const toolCalls = json.choices?.[0]?.message?.tool_calls;
      return Array.isArray(toolCalls) && toolCalls.length > 0 ? "tool_calls" : "no_tool_calls";
    } catch (err) {
      // Timeout or transport failure. No answer arrived, so we learned nothing.
      this.logger.dbg(`[probe] n=${n} failed after ${timeoutMs}ms: ${String(err)} — inconclusive`);
      return "inconclusive";
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
