/**
 * server.ts — HTTP server and request orchestrator for the proxy.
 *
 * The ProxyServer class wires up dependencies via constructor injection,
 * initializes async services at startup, and runs a Bun HTTP server
 * that translates Claude Code's Anthropic API requests to OpenAI format.
 *
 * @module infrastructure/server
 */

import { loadConfig, type ProxyConfig } from "./config";
import { Logger } from "./logger";
import { loadLocale } from "./i18nLoader";
import { t } from "../domain/i18n";
import { ModelInfoService } from "./modelInfo";
import { ToolProbe } from "./toolProbe";
import { ToolManager } from "../application/toolManager";
import { RequestTranslator } from "../application/requestTranslator";
import { ResponseTranslator } from "../application/responseTranslator";
import { StreamTranslator } from "../application/streamTranslator";
import { anthropicError } from "./httpUtils";
import type { LoadedModelInfo, AnthropicRequest } from "../domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// ProxyServer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main proxy server class.
 *
 * Lifecycle:
 * 1. constructor() — create logger from config
 * 2. initialize() — async: load locale, fetch model info, probe tool limit, wire translators
 * 3. start() — launch Bun HTTP server
 *
 * All dependencies are created internally during initialize() and passed
 * to child components via constructor injection (DIP).
 */
export class ProxyServer {
  private readonly logger: Logger;
  private modelInfo: LoadedModelInfo | null = null;
  private toolManager!: ToolManager;
  private requestTranslator!: RequestTranslator;
  private responseTranslator!: ResponseTranslator;
  private streamTranslator!: StreamTranslator;

  /**
   * @param config - Fully populated proxy configuration.
   */
  constructor(private readonly config: ProxyConfig) {
    this.logger = new Logger(config.debug);
  }

  /**
   * Async initialization: load locale, fetch model info, detect tool limit,
   * and wire up all translator dependencies.
   *
   * Must be called before start().
   */
  async initialize(): Promise<void> {
    // Step 0: Load i18n locale
    await loadLocale(this.config.locale);

    // Step 1: Fetch loaded model info from LM Studio
    const modelService = new ModelInfoService(this.config, this.logger);
    this.modelInfo = await modelService.fetch();
    this.logModelInfo();

    // Step 2: Detect tool calling limit (probe or override)
    const maxTools = await this.detectToolLimit();

    // Step 3: Wire up components with injected dependencies
    this.toolManager = new ToolManager(maxTools, {
      coreTools: this.config.coreTools,
      scoreCoreTools: this.config.scoreCoreTools,
      scorePromoted: this.config.scorePromoted,
      scoreUsedInHistory: this.config.scoreUsedInHistory,
      scoreForcedChoice: this.config.scoreForcedChoice,
      promotionMaxAge: this.config.promotionMaxAge,
      useToolDescMaxLength: this.config.useToolDescMaxLength,
    });

    this.requestTranslator = new RequestTranslator(this.modelInfo, this.toolManager, this.config);
    this.responseTranslator = new ResponseTranslator(this.toolManager);
    this.streamTranslator = new StreamTranslator(this.toolManager, this.logger);
  }

  /**
   * Start the Bun HTTP server.
   *
   * idleTimeout is set to 0 (disabled) because local LLMs may spend
   * 30+ seconds in the reasoning phase before emitting the first token.
   */
  start(): void {
    const server = Bun.serve({
      port: this.config.proxyPort,
      idleTimeout: 0,
      fetch: (req) => this.route(req),
    });

    this.logger.info(t("server.listening", { port: server.port ?? 0 }));
    this.logger.info(t("server.target", { url: this.config.targetUrl }));
    this.logger.info(t("server.debug", { status: this.config.debug ? "ON" : "OFF" }));
  }

  // ── Routing ─────────────────────────────────────────────────────────────

  /**
   * Route incoming HTTP requests to the appropriate handler.
   */
  private async route(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    // Health check endpoint
    if (req.method === "GET" && pathname === "/health") {
      return this.handleHealth();
    }

    // Main endpoint: POST /v1/messages (Anthropic Messages API)
    if (req.method === "POST" && pathname === "/v1/messages") {
      return this.handleMessages(req);
    }

    return anthropicError(404, t("server.unknownEndpoint", { method: req.method, path: pathname }));
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  /**
   * Health check handler — returns a simple OK response.
   */
  private handleHealth(): Response {
    return new Response(
      JSON.stringify({ status: t("health.ok"), target: this.config.targetUrl }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  /**
   * Main handler: translate and forward Anthropic requests to the LLM backend.
   *
   * Flow:
   * 1. Parse Anthropic request body
   * 2. Log request metadata (model remap, tool count, max_tokens cap)
   * 3. Translate to OpenAI format (includes dynamic tool selection)
   * 4. Forward to the target LLM endpoint
   * 5. Translate response back (streaming or non-streaming)
   */
  private async handleMessages(req: Request): Promise<Response> {
    // Parse request body
    let body: AnthropicRequest;
    try {
      body = await req.json();
    } catch {
      return anthropicError(400, t("request.invalidJson"));
    }

    const thinkingEnabled =
      body.thinking?.type === "enabled" || body.thinking?.type === "adaptive";

    // Log request metadata
    this.logRequest(body, thinkingEnabled);

    // Translate request (Anthropic → OpenAI, with tool selection)
    const { request: openaiReq, toolSelection } = this.requestTranslator.translate(body);
    this.logger.dbg("OpenAI request:", JSON.stringify(openaiReq, null, 2));

    // Log tool selection if filtering occurred
    if (toolSelection?.useToolDef) {
      const coreNames = toolSelection.tools
        .filter(t => t.function.name !== "UseTool")
        .map(t => t.function.name)
        .join(",");
      this.logger.info(t("tools.filtered", {
        from: (toolSelection.tools.length - 1) + toolSelection.overflow.length,
        to: toolSelection.tools.length,
        coreList: coreNames,
      }));
    }

    // Forward to the LLM backend
    let targetResponse: Response;
    try {
      targetResponse = await fetch(this.config.targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(openaiReq),
      });
    } catch (err) {
      this.logger.error(t("target.connectFailed", { url: this.config.targetUrl, error: String(err) }));
      return anthropicError(502, t("target.connectFailed", { url: this.config.targetUrl, error: String(err) }));
    }

    if (!targetResponse.ok) {
      const errText = await targetResponse.text().catch(() => "unknown error");
      this.logger.error(`Target returned ${targetResponse.status}:`, errText);
      return anthropicError(targetResponse.status, t("target.errorReturned", { error: errText }));
    }

    // Non-streaming response
    if (!body.stream) {
      const openaiJson = await targetResponse.json();
      this.logger.dbg("OpenAI response:", JSON.stringify(openaiJson, null, 2));
      const anthropicResp = this.responseTranslator.translate(openaiJson, body.model, thinkingEnabled);
      this.logger.info(t("response.stopReason", { reason: anthropicResp.stop_reason }));
      return new Response(JSON.stringify(anthropicResp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Streaming response
    if (!targetResponse.body) {
      return anthropicError(502, t("response.noBody"));
    }

    const anthropicStream = this.streamTranslator.translate(
      targetResponse.body,
      body.model,
      thinkingEnabled,
    );

    this.logger.info(t("response.streamStarted"));
    return new Response(anthropicStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  // ── Initialization Helpers ──────────────────────────────────────────────

  /**
   * Detect the model's tool calling limit.
   *
   * Uses MAX_TOOLS env override if set, otherwise runs a binary search probe.
   *
   * @returns Maximum number of tools the model supports (0 = no tool calling).
   */
  private async detectToolLimit(): Promise<number> {
    if (this.config.maxToolsOverride !== null) {
      this.logger.info(t("probe.override", { max: this.config.maxToolsOverride }));
      return this.config.maxToolsOverride;
    }

    if (!this.modelInfo) {
      return 0;
    }

    const probe = new ToolProbe(
      this.config.targetUrl,
      {
        probeUpperBound: this.config.probeUpperBound,
        probeMaxTokens: this.config.probeMaxTokens,
      },
      this.logger,
    );

    return probe.detect(this.modelInfo.id);
  }

  /**
   * Log loaded model information at startup.
   */
  private logModelInfo(): void {
    if (this.modelInfo) {
      this.logger.info(t("model.loaded", {
        id: this.modelInfo.id,
        arch: this.modelInfo.arch,
        quantization: this.modelInfo.quantization,
      }));
      this.logger.info(t("model.context", {
        loaded: this.modelInfo.loadedContextLength,
        max: this.modelInfo.maxContextLength,
      }));
      this.logger.info(t("model.capabilities", {
        list: this.modelInfo.capabilities.join(", ") || "none",
      }));
      this.logger.info(t("model.maxTokensCap", { cap: this.modelInfo.maxTokensCap }));
    } else {
      this.logger.info(t("model.fetchFailed", { fallback: this.config.maxTokensFallback }));
    }
  }

  /**
   * Log incoming request metadata (model remap, message count, tool count, etc.).
   */
  private logRequest(body: AnthropicRequest, thinkingEnabled: boolean): void {
    const effectiveModel = this.modelInfo?.id ?? body.model;
    const modelStr = body.model !== effectiveModel
      ? `${body.model}→${effectiveModel}`
      : body.model;
    const maxTokensCap = this.modelInfo?.maxTokensCap ?? this.config.maxTokensFallback;
    const cappedMaxTokens = maxTokensCap > 0
      ? Math.min(body.max_tokens, maxTokensCap)
      : body.max_tokens;

    this.logger.info(t("request.incoming", {
      model: modelStr,
      msgs: body.messages.length,
      tools: body.tools?.length ?? 0,
      stream: String(body.stream),
      thinking: String(thinkingEnabled),
      from: body.max_tokens,
      to: cappedMaxTokens,
    }));
  }
}
