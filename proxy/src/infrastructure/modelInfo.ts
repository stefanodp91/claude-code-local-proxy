/**
 * modelInfo.ts — LM Studio model information service.
 *
 * Fetches metadata about the currently loaded model from the
 * LM Studio internal API (/api/v0/models). This information
 * drives runtime decisions: model remapping, max_tokens capping,
 * and capability detection.
 *
 * @module infrastructure/modelInfo
 */

import type { LoadedModelInfo } from "../domain/types.ts";
import type { ProxyConfig } from "./config.ts";
import type { ILogger } from "../domain/ports.ts";
import { t } from "../domain/i18n.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** LM Studio internal API path for listing loaded models. */
const LM_STUDIO_MODELS_PATH = "/api/v0/models";

/** Default context length when the model does not report one. */
const DEFAULT_CONTEXT_LENGTH = 32768;

/** State value indicating a model is loaded and ready. */
const MODEL_STATE_LOADED = "loaded";

// ─────────────────────────────────────────────────────────────────────────────
// ModelInfoService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Service responsible for querying LM Studio's internal API to retrieve
 * information about the currently loaded model.
 *
 * The fetched info includes: model ID, architecture, quantization,
 * context window sizes, capabilities, and a derived max_tokens cap.
 *
 * @example
 * const service = new ModelInfoService(config, logger);
 * const info = await service.fetch();
 * if (info) {
 *   logger.info(t("model.loaded", { id: info.id, arch: info.arch, quantization: info.quantization }));
 * }
 */
export class ModelInfoService {
  /** Base URL of the LM Studio server (without /v1/chat/completions suffix). */
  private readonly baseUrl: string;

  /** Ratio used to derive maxTokensCap from the loaded context length. */
  private readonly contextToMaxTokensRatio: number;

  /**
   * @param config - Proxy configuration (for targetUrl and contextToMaxTokensRatio).
   * @param logger - Logger instance for error reporting.
   */
  constructor(
    private readonly config: ProxyConfig,
    private readonly logger: ILogger,
  ) {
    this.baseUrl = config.targetUrl.replace(/\/v1\/chat\/completions$/, "");
    this.contextToMaxTokensRatio = config.contextToMaxTokensRatio;
  }

  /**
   * Fetch information about the currently loaded model from LM Studio.
   *
   * Queries the /api/v0/models endpoint and returns info for the first
   * model with state "loaded". Returns null if no model is loaded
   * or the API is unreachable.
   *
   * @returns Model information or null if unavailable.
   */
  async fetch(): Promise<LoadedModelInfo | null> {
    try {
      const res = await fetch(`${this.baseUrl}${LM_STUDIO_MODELS_PATH}`);
      if (!res.ok) return null;

      const json = (await res.json()) as any;
      const models: any[] = json.data ?? [];
      const loaded = models.find((m: any) => m.state === MODEL_STATE_LOADED);
      if (!loaded) return null;

      const ctxLen: number =
        loaded.loaded_context_length ?? loaded.max_context_length ?? DEFAULT_CONTEXT_LENGTH;

      return {
        id: loaded.id,
        arch: loaded.arch ?? "unknown",
        quantization: loaded.quantization ?? "unknown",
        loadedContextLength: ctxLen,
        maxContextLength: loaded.max_context_length ?? ctxLen,
        capabilities: loaded.capabilities ?? [],
        maxTokensCap: Math.floor(ctxLen / this.contextToMaxTokensRatio),
      };
    } catch (err) {
      this.logger.error(t("model.fetchFailed", { fallback: this.config.maxTokensFallback }));
      return null;
    }
  }
}
