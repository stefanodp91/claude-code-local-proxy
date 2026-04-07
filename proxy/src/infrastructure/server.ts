/**
 * server.ts — HTTP server and request orchestrator for the proxy.
 *
 * The ProxyServer class wires up dependencies via constructor injection,
 * initializes async services at startup, and runs a Node.js HTTP server
 * that translates Claude Code's Anthropic API requests to OpenAI format.
 *
 * @module infrastructure/server
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { ProxyConfig } from "./config.ts";
import { Logger } from "./logger.ts";
import { loadLocale } from "./i18nLoader.ts";
import { t } from "../domain/i18n.ts";
import { ModelInfoService } from "./modelInfo.ts";
import { ToolProbe } from "./toolProbe.ts";
import { PersistentCache } from "./persistentCache.ts";
import { ToolManager } from "../application/toolManager.ts";
import { RequestTranslator } from "../application/requestTranslator.ts";
import { ResponseTranslator } from "../application/responseTranslator.ts";
import { StreamTranslator } from "../application/streamTranslator.ts";
import { anthropicError } from "./httpUtils.ts";
import type { LoadedModelInfo, AnthropicRequest, ModelCapabilities } from "../domain/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// ProxyServer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main proxy server class.
 *
 * Lifecycle:
 * 1. constructor() — create logger from config
 * 2. initialize() — async: load locale, fetch model info, load claude-local.md
 * 3. initializeTools() — tool probe or cache hit, wire translators
 * 4. start() — launch Node.js HTTP server
 *
 * All dependencies are created internally during initialize() and passed
 * to child components via constructor injection (DIP).
 */
export class ProxyServer {
  private readonly logger: Logger;
  private readonly modelCache: PersistentCache<ModelCapabilities>;
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
    this.modelCache = new PersistentCache<ModelCapabilities>(
      `${__dirname}/../../model-cache.json`,
    );
  }

  /**
   * Async initialization: load locale, fetch model info, load claude-local.md.
   */
  async initialize(): Promise<void> {
    // Step 0: Load i18n locale
    await loadLocale(this.config.locale);

    // Step 1: Fetch loaded model info from LM Studio
    const modelService = new ModelInfoService(this.config, this.logger);
    this.modelInfo = await modelService.fetch();
    this.logModelInfo();

    // Step 2: Build system prompt — dynamic model preamble + claude-local.md rules
    const claudeLocalPath = `${__dirname}/../../claude-local.md`;
    const rules = await readFile(claudeLocalPath, "utf8").catch(() => "").then((s: string) => s.trim());
    if (rules) {
      this.logger.info(t("server.claudeLocalLoaded", { chars: rules.length }));
    }
    this.config.systemPromptAppend = this.buildSystemPromptAppend(rules);
  }

  /**
   * Build the content injected into every request's system prompt.
   *
   * Prepends a dynamic block with live model facts (context, output cap, capabilities)
   * so the model has self-awareness about its own constraints without any manual
   * per-model configuration. Then appends the user-editable claude-local.md rules.
   */
  private buildSystemPromptAppend(rules: string): string {
    const preamble = this.modelInfo ? this.buildModelPreamble(this.modelInfo) : "";
    return [preamble, rules].filter(Boolean).join("\n\n");
  }

  /**
   * Generate a dynamic system prompt block describing the current model's constraints.
   * Uses only data already available in LoadedModelInfo — fully model-agnostic.
   */
  private buildModelPreamble(info: LoadedModelInfo): string {
    const conversationBudget = info.loadedContextLength - info.maxTokensCap;
    return [
      "## Current Model",
      `- **Model:** ${info.id} (${info.arch}, ${info.quantization})`,
      `- **Context window:** ${info.loadedContextLength.toLocaleString()} tokens`,
      `- **Max output:** ${info.maxTokensCap.toLocaleString()} tokens`,
      `- **Available for conversation:** ~${conversationBudget.toLocaleString()} tokens`,
      `- **Capabilities:** ${info.capabilities.join(", ") || "text generation only"}`,
    ].join("\n");
  }

  /**
   * Async tool initialization: detect tool limit and wire up translators.
   */
  async initializeTools(): Promise<void> {
    const maxTools = await this.detectToolLimit();

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
   * Start the Node.js HTTP server.
   *
   * Uses the Web Fetch API (Request/Response) internally for handler logic,
   * adapting to/from Node.js IncomingMessage/ServerResponse at the boundary.
   * Socket timeout is disabled (0) because local LLMs may spend 30+ seconds
   * in the reasoning phase before emitting the first token.
   */
  start(): void {
    const server = createServer(async (nodeReq, nodeRes) => {
      // Collect request body
      const chunks: Buffer[] = [];
      for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
      const bodyBuffer = chunks.length > 0 ? Buffer.concat(chunks) : null;

      // Build Web API Request
      const url = `http://127.0.0.1:${this.config.proxyPort}${nodeReq.url ?? "/"}`;
      const webReq = new Request(url, {
        method: nodeReq.method ?? "GET",
        headers: nodeReq.headers as Record<string, string>,
        body: bodyBuffer?.length ? bodyBuffer : null,
      });

      // Dispatch to route handler
      const webRes = await this.route(webReq).catch(err => {
        this.logger.error("Unhandled route error:", String(err));
        return anthropicError(500, String(err));
      });

      // Write status + headers
      const resHeaders: Record<string, string> = {};
      webRes.headers.forEach((value, key) => { resHeaders[key] = value; });
      nodeRes.writeHead(webRes.status, resHeaders);

      // Stream body to client
      if (webRes.body) {
        const reader = webRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          nodeRes.write(value);
        }
      }
      nodeRes.end();
    });

    // Disable socket idle timeout so long LLM responses don't get cut off
    server.on("connection", (socket) => socket.setTimeout(0));

    server.listen(this.config.proxyPort, () => {
      this.logger.info(t("server.listening", { port: this.config.proxyPort }));
      this.logger.info(t("server.target", { url: this.config.targetUrl }));
      this.logger.info(t("server.debug", { status: this.config.debug ? "ON" : "OFF" }));
    });
  }

  // ── Routing ─────────────────────────────────────────────────────────────

  /**
   * Route incoming HTTP requests to the appropriate handler.
   */
  private async route(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/health") {
      return this.handleHealth();
    }

    if (req.method === "POST" && pathname === "/v1/messages") {
      return this.handleMessages(req);
    }

    return anthropicError(404, t("server.unknownEndpoint", { method: req.method, path: pathname }));
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  private handleHealth(): Response {
    return new Response(
      JSON.stringify({ status: t("health.ok"), target: this.config.targetUrl }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  private async handleMessages(req: Request): Promise<Response> {
    if (!this.requestTranslator) {
      return anthropicError(503, t("server.notReady"));
    }

    let body: AnthropicRequest;
    try {
      body = await req.json();
    } catch {
      return anthropicError(400, t("request.invalidJson"));
    }

    const thinkingEnabled =
      body.thinking?.type === "enabled" || body.thinking?.type === "adaptive";

    this.logRequest(body, thinkingEnabled);

    const { request: openaiReq, toolSelection, prunedMessages } = this.requestTranslator.translate(body);
    if (prunedMessages > 0) {
      this.logger.info(t("request.pruned", { count: prunedMessages, remaining: openaiReq.messages.length }));
    }
    this.logger.dbg("OpenAI request:", JSON.stringify(openaiReq, null, 2));

    if (toolSelection?.useToolDef) {
      const coreNames = toolSelection.tools
        .filter((tool: { function: { name: string } }) => tool.function.name !== "UseTool")
        .map((tool: { function: { name: string } }) => tool.function.name)
        .join(",");
      this.logger.info(t("tools.filtered", {
        from: (toolSelection.tools.length - 1) + toolSelection.overflow.length,
        to: toolSelection.tools.length,
        coreList: coreNames,
      }));
    }

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

    if (!openaiReq.stream) {
      let openaiJson: unknown;
      try {
        openaiJson = await targetResponse.json();
      } catch (err) {
        const raw = await targetResponse.text().catch(() => "");
        this.logger.error(t("response.invalidJson", { error: String(err) }), raw.slice(0, 200));
        return anthropicError(502, t("response.invalidJson", { error: String(err) }));
      }
      this.logger.dbg("OpenAI response:", JSON.stringify(openaiJson, null, 2));
      const anthropicResp = this.responseTranslator.translate(openaiJson, body.model, thinkingEnabled);
      this.logger.info(t("response.stopReason", { reason: anthropicResp.stop_reason }));
      return new Response(JSON.stringify(anthropicResp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

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

  private async detectToolLimit(): Promise<number> {
    if (this.config.maxToolsOverride !== null) {
      this.logger.info(t("probe.override", { max: this.config.maxToolsOverride }));
      return this.config.maxToolsOverride;
    }

    if (!this.modelInfo) {
      return 0;
    }

    const cached = this.modelCache.get(this.modelInfo.id);
    if (cached?.maxTools !== undefined) {
      this.logger.info(t("probe.cached", { max: cached.maxTools }));
      return cached.maxTools;
    }

    const probe = new ToolProbe(
      this.config.targetUrl,
      {
        probeUpperBound: this.config.probeUpperBound,
        probeMaxTokens: this.config.probeMaxTokens,
        probeTimeout: this.config.probeTimeout,
      },
      this.logger,
    );

    const maxTools = await probe.detect(this.modelInfo.id);
    await this.modelCache.merge(this.modelInfo.id, { maxTools });
    return maxTools;
  }

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
