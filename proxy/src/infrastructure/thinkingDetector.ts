/**
 * thinkingDetector.ts — Detects reasoning/thinking capabilities for the loaded model.
 *
 * Runs two probes (cache-first via `PersistentCache`):
 *
 *   1. `enable_thinking: true`  → does the model produce `reasoning_content` at all?
 *      Result → `supportsThinking`
 *
 *   2. `enable_thinking: false` → does the model honor the disable request?
 *      (Only runs if probe #1 succeeded.)
 *      Result → `thinkingCanBeDisabled`
 *      (`true` when the model *suppresses* reasoning on request, `false` when
 *      it keeps thinking regardless — e.g. QwQ, DeepSeek-R1.)
 *
 * Invoked from `server.initializeTools()`, which runs both at startup
 * (first load) and on every model change detected by `pollModelChange()`.
 *
 * @module infrastructure/thinkingDetector
 */

import { t } from "../domain/i18n";
import type { LoadedModelInfo, ModelCapabilities } from "../domain/types";
import type { ILogger } from "../domain/ports";
import { ThinkingProbe } from "./thinkingProbe";
import { PersistentCache } from "./persistentCache";

export interface ThinkingDetectConfig {
  targetUrl:      string;
  probeMaxTokens: number;
  probeTimeout:   number;
}

/**
 * Probe-derived thinking capabilities for a model.
 *
 * `thinkingCanBeDisabled` is only meaningful when `supportsThinking` is true.
 * The extension uses both flags to decide whether to show the thinking toggle:
 * only when `supportsThinking && thinkingCanBeDisabled` does the user get a
 * control that actually does something on the backend.
 */
export interface ThinkingCapabilities {
  supportsThinking:      boolean;
  thinkingCanBeDisabled: boolean;
}

export class ThinkingDetector {
  constructor(
    private readonly cfg: ThinkingDetectConfig,
    private readonly cache: PersistentCache<ModelCapabilities>,
    private readonly logger: ILogger,
  ) {}

  /**
   * Detect the thinking capabilities of the current model.
   * Returns conservative defaults (both false) if no model is loaded or
   * probes fail.
   */
  async detect(modelInfo: LoadedModelInfo | null): Promise<ThinkingCapabilities> {
    if (!modelInfo) {
      return { supportsThinking: false, thinkingCanBeDisabled: false };
    }

    // Cache hit: both flags present → skip probes entirely.
    const cached = this.cache.get(modelInfo.id);
    if (cached?.supportsThinking !== undefined && cached?.thinkingCanBeDisabled !== undefined) {
      this.logger.info(t("thinkingProbe.cached", {
        supported:    String(cached.supportsThinking),
        canBeDisabled: String(cached.thinkingCanBeDisabled),
      }));
      return {
        supportsThinking:      cached.supportsThinking,
        thinkingCanBeDisabled: cached.thinkingCanBeDisabled,
      };
    }

    const probe = new ThinkingProbe(
      this.cfg.targetUrl,
      { probeMaxTokens: this.cfg.probeMaxTokens, probeTimeout: this.cfg.probeTimeout },
      this.logger,
    );

    // Probe #1: does the model emit reasoning_content when asked?
    const supportsThinking = await probe.detect(modelInfo.id, true);

    // Probe #2: if so, does `enable_thinking: false` actually suppress it?
    // (Skipped when the model doesn't think at all — nothing to disable.)
    let thinkingCanBeDisabled = false;
    if (supportsThinking) {
      const reasoningWhenDisabled = await probe.detect(modelInfo.id, false);
      thinkingCanBeDisabled = !reasoningWhenDisabled;
    }

    await this.cache.merge(modelInfo.id, { supportsThinking, thinkingCanBeDisabled });
    this.logger.info(t("thinkingProbe.detected", {
      supported:     String(supportsThinking),
      canBeDisabled: String(thinkingCanBeDisabled),
    }));

    return { supportsThinking, thinkingCanBeDisabled };
  }
}
