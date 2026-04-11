/**
 * server.ts — Composition root + HTTP router.
 * Wires adapters → services → use cases, then dispatches HTTP requests.
 * Zero business logic — all decisions live in the application layer.
 * @module infrastructure/server
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { type ProxyConfig } from "./config";
import { Logger } from "./logger";
import { loadLocale } from "./i18nLoader";
import { t } from "../domain/i18n";
import {
  AgentMode,
  HttpMethod,
  ProxyEndpoint,
  type AnthropicRequest,
  type LoadedModelInfo,
  type ModelCapabilities,
} from "../domain/types";
import { ModelInfoService } from "./modelInfo";
import { PersistentCache } from "./persistentCache";
import { ToolManager } from "../application/toolManager";
import { RequestTranslator } from "../application/requestTranslator";
import { ResponseTranslator } from "../application/responseTranslator";
import { StreamTranslator } from "../application/streamTranslator";
import { SlashCommandInterceptor, SLASH_COMMAND_REGISTRY } from "../application/slashCommandInterceptor";
import { SystemPromptBuilder } from "../application/services/systemPromptBuilder";
import { ApprovalGateService } from "../application/services/approvalGateService";
import { NativeAgentLoopService } from "../application/services/nativeAgentLoopService";
import { HandleChatMessageUseCase } from "../application/useCases/handleChatMessageUseCase";
import { ResolveApprovalUseCase } from "../application/useCases/resolveApprovalUseCase";
import { FsPromptRepository } from "./adapters/fsPromptRepository";
import { FsPlanFileRepository } from "./adapters/fsPlanFileRepository";
import { FetchLlmClient } from "./adapters/fetchLlmClient";
import { NodeSseWriter } from "./adapters/nodeSseWriter";
import { SystemClock } from "./adapters/systemClock";
import { SseApprovalInteractor } from "./adapters/sseApprovalInteractor";
import { loadOldContent, checkAutoApprove } from "./adapters/autoApproveConfig";
import { ToolLimitDetector } from "./toolLimitDetector";
import { ThinkingDetector } from "./thinkingDetector";
import type { PlanFileRepositoryPort } from "../domain/ports";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

export class ProxyServer {
  private readonly logger: Logger;
  private readonly modelCache: PersistentCache<ModelCapabilities>;
  private modelInfo: LoadedModelInfo | null = null;
  private toolManager!: ToolManager;
  private requestTranslator!: RequestTranslator;
  private responseTranslator!: ResponseTranslator;
  private streamTranslator!: StreamTranslator;
  private readonly slashInterceptor = new SlashCommandInterceptor();
  private maxTools = 0;
  /** False → /health returns 503 (LLM unreachable). Updated by probe + request outcomes. */
  private llmReachable = false;
  /** True while a model-change re-initialization is in progress. POST /messages returns 503. */
  private reinitializing = false;

  private readonly llm: FetchLlmClient;
  private readonly planFiles: PlanFileRepositoryPort;
  private readonly promptRepo: FsPromptRepository;
  private readonly promptBuilder: SystemPromptBuilder;
  private readonly approvalInteractor: SseApprovalInteractor;
  private readonly approvalGate: ApprovalGateService;
  private readonly nativeLoop: NativeAgentLoopService;
  private handleChatUseCase!: HandleChatMessageUseCase;
  private resolveApprovalUseCase!: ResolveApprovalUseCase;

  constructor(private readonly config: ProxyConfig) {
    this.logger     = new Logger(config.debug);
    this.modelCache = new PersistentCache<ModelCapabilities>(
      resolve(__dirname, "../../model-cache.json"),
    );
    const clock = new SystemClock();
    this.llm               = new FetchLlmClient(config.targetUrl);
    this.planFiles         = new FsPlanFileRepository(config.plansDir, clock);
    this.promptRepo        = new FsPromptRepository(config.locale);
    this.promptBuilder     = new SystemPromptBuilder(this.promptRepo, this.planFiles);
    this.approvalInteractor = new SseApprovalInteractor(this.logger);
    this.approvalGate       = new ApprovalGateService(
      this.approvalInteractor, this.planFiles, this.logger,
      loadOldContent, checkAutoApprove,
    );
    this.nativeLoop = new NativeAgentLoopService(
      this.llm, this.approvalGate, this.planFiles, this.logger,
      () => this.modelInfo?.id ?? "unknown",
    );
  }

  async initialize(): Promise<void> {
    await loadLocale(this.config.locale);
    await this.promptRepo.load();
    const svc = new ModelInfoService(this.config, this.logger);
    this.modelInfo = await svc.fetch();
    this.logModelInfo();
    this.llmReachable = true;
  }

  async initializeTools(): Promise<void> {
    const detector = new ToolLimitDetector(
      {
        maxToolsOverride: this.config.maxToolsOverride,
        targetUrl:        this.config.targetUrl,
        probeUpperBound:  this.config.probeUpperBound,
        probeMaxTokens:   this.config.probeMaxTokens,
        probeTimeout:     this.config.probeTimeout,
      },
      this.modelCache,
      this.logger,
    );
    this.maxTools    = await detector.detect(this.modelInfo);

    // Probe thinking/reasoning support (cache-first). Populates
    // modelInfo.supportsThinking so downstream code can gate enable_thinking
    // and the extension can show/hide the thinking toggle.
    const thinkingDetector = new ThinkingDetector(
      {
        targetUrl:      this.config.targetUrl,
        probeMaxTokens: this.config.probeMaxTokens,
        probeTimeout:   this.config.probeTimeout,
      },
      this.modelCache,
      this.logger,
    );
    const thinkingCaps = await thinkingDetector.detect(this.modelInfo);
    if (this.modelInfo) {
      this.modelInfo.supportsThinking      = thinkingCaps.supportsThinking;
      this.modelInfo.thinkingCanBeDisabled = thinkingCaps.thinkingCanBeDisabled;
    }

    this.toolManager = new ToolManager(this.maxTools, {
      coreTools:            this.config.coreTools,
      scoreCoreTools:       this.config.scoreCoreTools,
      scorePromoted:        this.config.scorePromoted,
      scoreUsedInHistory:   this.config.scoreUsedInHistory,
      scoreForcedChoice:    this.config.scoreForcedChoice,
      promotionMaxAge:      this.config.promotionMaxAge,
      useToolDescMaxLength: this.config.useToolDescMaxLength,
    });
    this.requestTranslator  = new RequestTranslator(this.modelInfo, this.toolManager, this.config);
    this.responseTranslator = new ResponseTranslator(this.toolManager);
    this.streamTranslator   = new StreamTranslator(this.toolManager, this.logger);
    this.handleChatUseCase  = new HandleChatMessageUseCase(
      this.approvalGate, this.promptBuilder, this.nativeLoop, this.llm,
      this.requestTranslator, this.responseTranslator, this.streamTranslator,
      this.slashInterceptor, this.logger,
      () => this.modelInfo, () => this.maxTools, this.config.targetUrl,
    );
    this.resolveApprovalUseCase = new ResolveApprovalUseCase(this.approvalInteractor);
  }

  start(): void {
    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error("Unhandled request error:", String(err));
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal server error" } }));
        }
      });
    });
    server.timeout = 0;
    server.keepAliveTimeout = 0;
    server.listen(this.config.proxyPort, () => {
      this.logger.info(t("server.listening", { port: this.config.proxyPort }));
      this.logger.info(t("server.target",    { url:  this.config.targetUrl }));
      this.logger.info(t("server.debug",     { status: this.config.debug ? "ON" : "OFF" }));
      setInterval(() => { void this.probeLlm(); }, 30_000);
      setInterval(() => { void this.pollModelChange(); }, 15_000);
    });
  }

  private async probeLlm(): Promise<void> {
    const prev = this.llmReachable;
    this.llmReachable = await this.llm.ping();
    if (this.llmReachable !== prev) {
      this.logger.info(`[health] LLM backend ${this.llmReachable ? "reachable" : "unreachable"}`);
    }
  }

  private async pollModelChange(): Promise<void> {
    if (this.reinitializing || !this.llmReachable) return;
    const fresh = await new ModelInfoService(this.config, this.logger).fetch();
    if (!fresh || fresh.id === this.modelInfo?.id) return;

    this.reinitializing = true;
    this.logger.info(t("model.changed", { from: this.modelInfo?.id ?? "none", to: fresh.id }));
    this.modelInfo = fresh;
    this.logModelInfo();
    try {
      await this.initializeTools();
      this.logger.info(t("model.reloaded", {
        max:      this.maxTools,
        thinking: String(this.modelInfo?.supportsThinking ?? false),
      }));
    } finally {
      this.reinitializing = false;
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url      = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (req.method === HttpMethod.Get && pathname === ProxyEndpoint.Health) {
      return this.llmReachable
        ? this.sendJson(res, 200, { status: t("health.ok"), target: this.config.targetUrl, llm: "reachable" })
        : this.sendJson(res, 503, { status: "degraded",    target: this.config.targetUrl, llm: "unreachable" });
    }

    if (req.method === HttpMethod.Get && pathname === ProxyEndpoint.Config) {
      return this.sendJson(res, 200, this.buildConfigResponse());
    }

    if (req.method === HttpMethod.Get && pathname === ProxyEndpoint.Commands) {
      return this.sendJson(res, 200, { commands: SLASH_COMMAND_REGISTRY });
    }

    if (pathname === ProxyEndpoint.AgentMode) {
      if (req.method === HttpMethod.Get) {
        return this.sendJson(res, 200, { mode: this.approvalGate.agentMode });
      }
      if (req.method === HttpMethod.Post) {
        try {
          const { mode } = JSON.parse(await readBody(req)) as { mode?: string };
          const valid = Object.values(AgentMode) as string[];
          if (mode && valid.includes(mode)) {
            this.approvalGate.setAgentMode(mode as AgentMode);
            return this.sendJson(res, 200, { mode: this.approvalGate.agentMode });
          }
          return this.sendJson(res, 400, { error: `invalid mode "${mode}" — must be one of ${valid.join("|")}` });
        } catch {
          return this.sendJson(res, 400, { error: "invalid JSON body" });
        }
      }
    }

    if (req.method === HttpMethod.Post && pathname === ProxyEndpoint.Messages) {
      if (!this.requestTranslator || this.reinitializing) {
        return this.sendJson(res, 503, { type: "error", error: { type: "api_error", message: t("server.notReady") } });
      }
      let body: AnthropicRequest;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return this.sendJson(res, 400, { type: "error", error: { type: "api_error", message: t("request.invalidJson") } });
      }
      const workspaceCwd = req.headers["x-workspace-root"] as string | undefined;
      const result = await this.handleChatUseCase.execute({ body, workspaceCwd }, new NodeSseWriter(res));
      if (result.type === "json") this.sendJson(res, result.status, result.body);
      if (result.llmReachable !== null) this.llmReachable = result.llmReachable;
      return;
    }

    const approveMatch = pathname.match(/^\/v1\/messages\/([^/]+)\/approve$/);
    if (req.method === HttpMethod.Post && approveMatch) {
      let body: { approved?: boolean; scope?: unknown };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return this.sendJson(res, 400, { error: "invalid JSON body" });
      }
      const result = this.resolveApprovalUseCase.execute({ requestId: approveMatch[1], approved: body.approved, scope: body.scope });
      return result.resolved
        ? this.sendJson(res, 200, { ok: true })
        : this.sendJson(res, 404, { error: "unknown or expired request_id" });
    }

    this.sendJson(res, 404, {
      type: "error",
      error: { type: "api_error", message: t("server.unknownEndpoint", { method: req.method ?? "?", path: pathname }) },
    });
  }

  private buildConfigResponse() {
    return {
      proxyPort: this.config.proxyPort, targetUrl: this.config.targetUrl,
      maxTokensFallback: this.config.maxTokensFallback, locale: this.config.locale,
      temperature: this.config.temperature, systemPrompt: this.config.systemPrompt,
      enableThinking: this.config.enableThinking, agentMode: this.approvalGate.agentMode,
      model: this.modelInfo ? {
        id: this.modelInfo.id, type: this.modelInfo.type, publisher: this.modelInfo.publisher,
        arch: this.modelInfo.arch, quantization: this.modelInfo.quantization,
        compatibilityType: this.modelInfo.compatibilityType,
        loadedContextLength: this.modelInfo.loadedContextLength,
        maxContextLength: this.modelInfo.maxContextLength,
        maxTokensCap: this.modelInfo.maxTokensCap,
        // Probe-derived capabilities (not LM Studio's unreliable declared list).
        // supportsTools          — tool-limit probe succeeded (maxTools > 0)
        // supportsThinking       — first thinking probe saw reasoning_content
        // thinkingCanBeDisabled  — second thinking probe confirmed that
        //                          `enable_thinking: false` suppresses reasoning.
        //                          The extension only shows the thinking toggle
        //                          when both supportsThinking AND
        //                          thinkingCanBeDisabled are true.
        supportsTools:         this.maxTools > 0,
        supportsThinking:      this.modelInfo.supportsThinking ?? false,
        thinkingCanBeDisabled: this.modelInfo.thinkingCanBeDisabled ?? false,
      } : null,
    };
  }

  private sendJson(res: ServerResponse, status: number, data: any): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  private logModelInfo(): void {
    if (this.modelInfo) {
      this.logger.info(t("model.loaded",       { id: this.modelInfo.id, arch: this.modelInfo.arch, quantization: this.modelInfo.quantization }));
      this.logger.info(t("model.context",      { loaded: this.modelInfo.loadedContextLength, max: this.modelInfo.maxContextLength }));
      this.logger.info(t("model.capabilities", { list: this.modelInfo.capabilities.join(", ") || "none" }));
      this.logger.info(t("model.maxTokensCap", { cap: this.modelInfo.maxTokensCap }));
    } else {
      this.logger.info(t("model.fetchFailed", { fallback: this.config.maxTokensFallback }));
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data",  (chunk: Buffer) => chunks.push(chunk));
    req.on("end",   () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
