/**
 * toolLimitDetector.ts — Detects the tool-call limit for the loaded model.
 *
 * Runs at startup (after the HTTP server is already listening) to determine
 * `maxTools` — the maximum number of tool definitions the model accepts in a
 * single request. Uses a three-tier strategy:
 *
 *   1. Config override (`maxToolsOverride`) — skip probe entirely.
 *   2. Persistent cache (`model-cache.json`) — avoid redundant probes.
 *   3. Live probe (`ToolProbe.detect()`) — binary-search the actual limit.
 *
 * @module infrastructure/toolLimitDetector
 */

import { t } from "../domain/i18n";
import type { LoadedModelInfo, ModelCapabilities } from "../domain/types";
import type { ILogger } from "../domain/ports";
import { ToolProbe } from "./toolProbe";
import { PersistentCache } from "./persistentCache";

export interface ToolLimitConfig {
  maxToolsOverride:  number | null;
  targetUrl:         string;
  probeUpperBound:   number;
  probeMaxTokens:    number;
  probeTimeout:      number;
}

export class ToolLimitDetector {
  constructor(
    private readonly cfg: ToolLimitConfig,
    private readonly cache: PersistentCache<ModelCapabilities>,
    private readonly logger: ILogger,
  ) {}

  async detect(modelInfo: LoadedModelInfo | null): Promise<number> {
    if (this.cfg.maxToolsOverride !== null) {
      this.logger.info(t("probe.override", { max: this.cfg.maxToolsOverride }));
      return this.cfg.maxToolsOverride;
    }
    if (!modelInfo) return 0;

    const cached = this.cache.get(modelInfo.id);
    if (cached?.maxTools !== undefined) {
      this.logger.info(t("probe.cached", { max: cached.maxTools }));
      return cached.maxTools;
    }

    const probe = new ToolProbe(
      this.cfg.targetUrl,
      {
        probeUpperBound: this.cfg.probeUpperBound,
        probeMaxTokens:  this.cfg.probeMaxTokens,
        probeTimeout:    this.cfg.probeTimeout,
      },
      this.logger,
    );
    const maxTools = await probe.detect(modelInfo.id);
    await this.cache.merge(modelInfo.id, { maxTools });
    return maxTools;
  }
}
