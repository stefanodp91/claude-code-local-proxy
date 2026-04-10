/**
 * server.ts — HTTP server and request orchestrator for the proxy.
 *
 * The ProxyServer class wires up dependencies via constructor injection,
 * initializes async services at startup, and runs a Node.js HTTP server
 * that translates Claude Code's Anthropic API requests to OpenAI format.
 *
 * @module infrastructure/server
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { type ProxyConfig } from "./config";
import { Logger } from "./logger";
import { loadLocale } from "./i18nLoader";
import { t } from "../domain/i18n";
import { sseEvent, msgId } from "../domain/utils";
import { SseEventType, StopReason, ContentBlockType, DeltaType } from "../domain/types";
import { ModelInfoService } from "./modelInfo";
import { ToolProbe } from "./toolProbe";
import { PersistentCache } from "./persistentCache";
import { ToolManager } from "../application/toolManager";
import { RequestTranslator } from "../application/requestTranslator";
import { ResponseTranslator } from "../application/responseTranslator";
import { StreamTranslator } from "../application/streamTranslator";
import { SlashCommandInterceptor, SLASH_COMMAND_REGISTRY } from "../application/slashCommandInterceptor";
import { buildWorkspaceContextSummary } from "../application/workspaceTool";
import { WORKSPACE_TOOL_DEF, executeAction, type ActionArgs } from "../infrastructure/workspaceActions";

import type { LoadedModelInfo, AnthropicRequest, ModelCapabilities } from "../domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// Module directory resolution
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// ProxyServer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main proxy server class.
 *
 * Lifecycle:
 * 1. constructor() — create logger from config
 * 2. initialize() — async: load locale, fetch model info, probe tool limit, wire translators
 * 3. start() — launch Node.js HTTP server
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
  private readonly slashInterceptor = new SlashCommandInterceptor();
  private maxTools = 0;

  /**
   * @param config - Fully populated proxy configuration.
   */
  constructor(private readonly config: ProxyConfig) {
    this.logger = new Logger(config.debug);
    this.modelCache = new PersistentCache<ModelCapabilities>(
      resolve(__dirname, "../../model-cache.json"),
    );
  }

  /**
   * Async initialization: load locale and fetch model info.
   *
   * Must be called before start(). Does NOT run the tool probe,
   * so the HTTP server can start listening quickly.
   */
  async initialize(): Promise<void> {
    // Step 0: Load i18n locale
    await loadLocale(this.config.locale);

    // Step 1: Fetch loaded model info from LM Studio
    const modelService = new ModelInfoService(this.config, this.logger);
    this.modelInfo = await modelService.fetch();
    this.logModelInfo();
  }

  /**
   * Async tool initialization: detect tool limit and wire up translators.
   *
   * Must be called after start() so the health endpoint is already available
   * while the (potentially slow) tool probe runs.
   */
  async initializeTools(): Promise<void> {
    // Step 2: Detect tool calling limit (probe or override)
    const maxTools = await this.detectToolLimit();
    this.maxTools = maxTools;

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
   * Start the Node.js HTTP server.
   */
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

    // Disable timeout — local LLMs may spend 30+ seconds reasoning before first token
    server.timeout = 0;
    server.keepAliveTimeout = 0;

    server.listen(this.config.proxyPort, () => {
      this.logger.info(t("server.listening", { port: this.config.proxyPort }));
      this.logger.info(t("server.target", { url: this.config.targetUrl }));
      this.logger.info(t("server.debug", { status: this.config.debug ? "ON" : "OFF" }));
    });
  }

  // ── Request Handling ───────────────────────────────────────────────────

  /**
   * Handle an incoming HTTP request, routing to the appropriate handler.
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Health check endpoint
    if (req.method === "GET" && pathname === "/health") {
      this.sendJson(res, 200, { status: t("health.ok"), target: this.config.targetUrl });
      return;
    }

    // Config endpoint: exposes proxy config + model info to clients
    if (req.method === "GET" && pathname === "/config") {
      this.sendJson(res, 200, this.buildConfigResponse());
      return;
    }

    // Commands endpoint: exposes available slash commands to clients
    if (req.method === "GET" && pathname === "/commands") {
      this.sendJson(res, 200, { commands: SLASH_COMMAND_REGISTRY });
      return;
    }

    // Main endpoint: POST /v1/messages (Anthropic Messages API)
    if (req.method === "POST" && pathname === "/v1/messages") {
      await this.handleMessages(req, res);
      return;
    }

    this.sendJson(res, 404, {
      type: "error",
      error: { type: "api_error", message: t("server.unknownEndpoint", { method: req.method ?? "?", path: pathname }) },
    });
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  /**
   * Main handler: translate and forward Anthropic requests to the LLM backend.
   */
  private async handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Guard: translators are wired in initializeTools() which runs after start()
    if (!this.requestTranslator) {
      this.sendJson(res, 503, {
        type: "error",
        error: { type: "api_error", message: t("server.notReady") },
      });
      return;
    }

    // Parse request body
    let body: AnthropicRequest;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch {
      this.sendJson(res, 400, {
        type: "error",
        error: { type: "api_error", message: t("request.invalidJson") },
      });
      return;
    }

    const thinkingEnabled =
      body.thinking?.type === "enabled" || body.thinking?.type === "adaptive";

    // Log request metadata
    this.logRequest(body, thinkingEnabled);

    // Slash command interception — before translation and LLM call
    const workspaceCwd = req.headers["x-workspace-root"] as string | undefined;
    const intercept = await this.slashInterceptor.intercept(body, workspaceCwd);

    if (intercept.type === "synthetic") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      this.writeSyntheticSse(res, intercept.text);
      return;
    }

    if (intercept.type === "enrich") {
      const last = body.messages.at(-1);
      if (last) last.content = intercept.newContent;
    }

    // Inject workspace context into system prompt so the LLM knows its working directory.
    // If the model supports tools (maxTools > 0), inject only the path and let the LLM
    // explore the codebase via the workspace tool. Otherwise inject a static summary.
    if (workspaceCwd) {
      const pathLine = `Working directory: ${workspaceCwd} (${basename(workspaceCwd)})`;
      const wsContext = this.maxTools === 0
        ? `${pathLine}\n\n${buildWorkspaceContextSummary(workspaceCwd)}`
        : pathLine;

      if (!body.system) {
        (body as any).system = wsContext;
      } else if (typeof body.system === "string") {
        (body as any).system = `${wsContext}\n\n${body.system}`;
      } else if (Array.isArray(body.system)) {
        body.system = [{ type: "text", text: wsContext }, ...body.system];
      }
    }

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

    // Option A: model supports tools — run agentic workspace exploration loop.
    // runNativeAgentLoop returns true if it handled the response, false if the
    // model didn't use the workspace tool (fall through to normal streaming).
    if (this.maxTools > 0 && workspaceCwd) {
      const handled = await this.runNativeAgentLoop(res, openaiReq, workspaceCwd, thinkingEnabled);
      if (handled) return;
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
      this.sendJson(res, 502, {
        type: "error",
        error: { type: "api_error", message: t("target.connectFailed", { url: this.config.targetUrl, error: String(err) }) },
      });
      return;
    }

    if (!targetResponse.ok) {
      const errText = await targetResponse.text().catch(() => "unknown error");
      this.logger.error(`Target returned ${targetResponse.status}:`, errText);
      this.sendJson(res, targetResponse.status, {
        type: "error",
        error: { type: "api_error", message: t("target.errorReturned", { error: errText }) },
      });
      return;
    }

    // Non-streaming response
    if (!openaiReq.stream) {
      let openaiJson: any;
      try {
        openaiJson = await targetResponse.json();
      } catch (err) {
        const raw = await targetResponse.text().catch(() => "");
        this.logger.error(t("response.invalidJson", { error: String(err) }), raw.slice(0, 200));
        this.sendJson(res, 502, {
          type: "error",
          error: { type: "api_error", message: t("response.invalidJson", { error: String(err) }) },
        });
        return;
      }
      this.logger.dbg("OpenAI response:", JSON.stringify(openaiJson, null, 2));
      const anthropicResp = this.responseTranslator.translate(openaiJson, body.model, thinkingEnabled);
      this.logger.info(t("response.stopReason", { reason: anthropicResp.stop_reason }));
      this.sendJson(res, 200, anthropicResp);
      return;
    }

    // Streaming response
    if (!targetResponse.body) {
      this.sendJson(res, 502, {
        type: "error",
        error: { type: "api_error", message: t("response.noBody") },
      });
      return;
    }

    const anthropicStream = this.streamTranslator.translate(
      targetResponse.body,
      this.modelInfo?.id ?? body.model,
      thinkingEnabled,
    );

    this.logger.info(t("response.streamStarted"));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // Pipe the Web ReadableStream to the Node.js response
    const nodeStream = Readable.fromWeb(anthropicStream as any);
    nodeStream.pipe(res);

    // Handle client disconnect
    res.on("close", () => {
      nodeStream.destroy();
    });
  }

  // ── Utility Methods ────────────────────────────────────────────────────

  /**
   * Native agentic loop for workspace-aware file exploration (Path A).
   *
   * Iteration 0 uses stream:false as a fallback guard (returns false if the
   * model produces nothing, letting normal streaming handle the response).
   * Iterations 1+ use stream:true, forwarding thinking and text deltas to the
   * client in real time.  Tool calls are accumulated and emitted as tool_use
   * blocks when each iteration's stream ends.
   *
   * The resulting Anthropic SSE stream is one continuous message
   * (single message_start … message_stop) regardless of how many iterations
   * the loop takes.  The client does not know which iteration it is on.
   */
  private async runNativeAgentLoop(
    res: ServerResponse,
    openaiReq: any,
    workspaceCwd: string,
    thinkingEnabled: boolean,
  ): Promise<boolean> {
    const MAX_ITERATIONS = 10;
    const SSE_HEADERS = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    };

    // Replace all client tools with only the workspace tool so the model can
    // only call workspace actions and text responses terminate the loop cleanly.
    const agentReq = { ...openaiReq, tools: [WORKSPACE_TOOL_DEF], tool_choice: "auto" };
    const messages: any[] = [...openaiReq.messages];
    const messageId = msgId();
    let headersSent = false;
    let contentIndex = 0;

    // Lazy write: sends SSE headers + message_start on the first call.
    const writeSSE = (text: string): void => {
      if (!headersSent) {
        headersSent = true;
        res.writeHead(200, SSE_HEADERS);
        res.write(
          sseEvent(SseEventType.MessageStart, {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              content: [],
              model: this.modelInfo?.id ?? agentReq.model ?? "unknown",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
        );
      }
      res.write(text);
    };

    // Emit final message_delta + message_stop and close the response.
    const endMessage = (outputTokens = 0, stopReason: StopReason = StopReason.EndTurn): void => {
      writeSSE(
        sseEvent(SseEventType.MessageDelta, {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }),
      );
      writeSSE(sseEvent(SseEventType.MessageStop, { type: "message_stop" }));
      res.end();
    };

    // Emit a text block (convenience helper for error messages and simple text).
    const emitTextBlock = (text: string): void => {
      writeSSE(sseEvent(SseEventType.ContentBlockStart, { type: "content_block_start", index: contentIndex, content_block: { type: "text", text: "" } }));
      writeSSE(sseEvent(SseEventType.ContentBlockDelta, { type: "content_block_delta", index: contentIndex, delta: { type: "text_delta", text } }));
      writeSSE(sseEvent(SseEventType.ContentBlockStop, { type: "content_block_stop", index: contentIndex }));
      contentIndex++;
    };

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // ── Iteration 0: non-streaming fallback guard ──────────────────────────
      if (i === 0) {
        let data: any;
        try {
          const resp = await fetch(this.config.targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...agentReq, messages, stream: false }),
          });
          if (!resp.ok) {
            const errText = await resp.text().catch(() => "");
            emitTextBlock(`Error from LLM: ${errText}`);
            endMessage();
            return true;
          }
          data = await resp.json();
        } catch (err) {
          emitTextBlock(`Error contacting LLM: ${String(err)}`);
          endMessage();
          return true;
        }

        const choice = data?.choices?.[0];
        const workspaceCalls: any[] = (choice?.message?.tool_calls ?? []).filter(
          (tc: any) => tc.function?.name === "workspace",
        );
        const text: string = choice?.message?.content ?? "";

        // Nothing produced: fall back to normal streaming (no response sent yet).
        if (workspaceCalls.length === 0 && !text.trim()) return false;

        // Text only (no tool calls): emit as a single text block and finish.
        if (workspaceCalls.length === 0) {
          emitTextBlock(text);
          endMessage(text.length);
          return true;
        }

        // Tool calls: emit tool_use blocks, execute each call, continue loop.
        messages.push(choice.message);
        for (const tc of workspaceCalls) {
          let args: ActionArgs;
          try { args = JSON.parse(tc.function.arguments ?? "{}"); }
          catch { args = { action: "list", path: "." }; }

          writeSSE(sseEvent(SseEventType.ContentBlockStart, { type: "content_block_start", index: contentIndex, content_block: { type: "tool_use", id: tc.id, name: "workspace", input: {} } }));
          writeSSE(sseEvent(SseEventType.ContentBlockDelta, { type: "content_block_delta", index: contentIndex, delta: { type: "input_json_delta", partial_json: tc.function.arguments ?? "" } }));
          writeSSE(sseEvent(SseEventType.ContentBlockStop, { type: "content_block_stop", index: contentIndex }));
          contentIndex++;

          const result = executeAction(args, workspaceCwd);
          this.logger.dbg(`[workspace] ${args.action} "${args.path ?? ""}" → ${result.slice(0, 120)}`);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        continue;
      }

      // ── Iterations 1+: streaming ────────────────────────────────────────────
      let resp: Response;
      try {
        resp = await fetch(this.config.targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...agentReq, messages, stream: true }),
        });
        if (!resp.ok || !resp.body) {
          const errText = !resp.ok ? await resp.text().catch(() => "") : "";
          emitTextBlock(`Error from LLM: ${errText || "no response body"}`);
          endMessage();
          return true;
        }
      } catch (err) {
        emitTextBlock(`Error contacting LLM: ${String(err)}`);
        endMessage();
        return true;
      }

      const { toolCalls, nextContentIndex, outputTokens } =
        await this.parseStreamingIteration(resp.body, writeSSE, contentIndex, thinkingEnabled);
      contentIndex = nextContentIndex;

      if (toolCalls.length === 0) {
        // Final answer fully streamed — close the message.
        endMessage(outputTokens);
        return true;
      }

      // Tool calls from a streaming iteration: inject into messages, loop again.
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: "workspace", arguments: tc.arguments },
        })),
      });
      for (const tc of toolCalls) {
        let args: ActionArgs;
        try { args = JSON.parse(tc.arguments); }
        catch { args = { action: "list", path: "." }; }

        const result = executeAction(args, workspaceCwd);
        this.logger.dbg(`[workspace] ${args.action} "${args.path ?? ""}" → ${result.slice(0, 120)}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }

    // Max iterations reached without a final text response.
    emitTextBlock("(Max workspace tool iterations reached — response may be incomplete)");
    endMessage();
    return true;
  }

  /**
   * Stream one agent loop iteration to the client.
   *
   * Reads an OpenAI SSE stream and:
   * - Forwards thinking deltas as Anthropic thinking_delta events in real time.
   * - Forwards text deltas as Anthropic text_delta events in real time.
   * - Accumulates tool calls silently, emitting them as tool_use blocks at [DONE].
   *
   * Content block indices start at startContentIndex and are incremented as
   * blocks are opened and closed.  The returned nextContentIndex is where the
   * next block should start in subsequent iterations.
   */
  private async parseStreamingIteration(
    body: ReadableStream<Uint8Array>,
    writeSSE: (text: string) => void,
    startContentIndex: number,
    thinkingEnabled: boolean,
  ): Promise<{ toolCalls: Array<{ id: string; name: string; arguments: string }>; nextContentIndex: number; outputTokens: number }> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let lineBuffer = "";

    let thinkingOpen = false;
    let thinkingIndex = -1;
    let textOpen = false;
    let textIndex = -1;
    let currentIndex = startContentIndex;
    let outputTokens = 0;
    let doneSeen = false;

    // Keyed by OpenAI delta index (the `index` field in tool_calls deltas).
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

    const emit = (eventType: string, data: any): void => writeSSE(sseEvent(eventType, data));

    const closeThinking = (): void => {
      if (!thinkingOpen) return;
      emit(SseEventType.ContentBlockStop, { type: "content_block_stop", index: thinkingIndex });
      thinkingOpen = false;
      currentIndex++;
    };

    const closeText = (): void => {
      if (!textOpen) return;
      emit(SseEventType.ContentBlockStop, { type: "content_block_stop", index: textIndex });
      textOpen = false;
      currentIndex++;
    };

    const processLine = (line: string): void => {
      if (!line.startsWith("data: ")) return;
      const dataStr = line.slice(6).trim();

      if (dataStr === "[DONE]") {
        doneSeen = true;
        closeText();
        closeThinking();
        // Emit accumulated tool_use blocks in order.
        for (const [, tc] of toolCallMap) {
          const blockIdx = currentIndex++;
          emit(SseEventType.ContentBlockStart, { type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} } });
          emit(SseEventType.ContentBlockDelta, { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: tc.arguments } });
          emit(SseEventType.ContentBlockStop, { type: "content_block_stop", index: blockIdx });
        }
        return;
      }

      let parsed: any;
      try { parsed = JSON.parse(dataStr); } catch { return; }

      if (parsed.usage?.completion_tokens) outputTokens = parsed.usage.completion_tokens;

      const choice = parsed.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};

      // 1. Thinking (reasoning_content)
      if (delta.reasoning_content && thinkingEnabled) {
        if (!thinkingOpen) {
          thinkingIndex = currentIndex; // do NOT increment — incremented on close
          thinkingOpen = true;
          emit(SseEventType.ContentBlockStart, {
            type: "content_block_start",
            index: thinkingIndex,
            content_block: { type: ContentBlockType.Thinking, thinking: "", signature: "" },
          });
        }
        emit(SseEventType.ContentBlockDelta, {
          type: "content_block_delta",
          index: thinkingIndex,
          delta: { type: DeltaType.ThinkingDelta, thinking: delta.reasoning_content },
        });
      }

      // 2. Text content
      if (delta.content != null && delta.content !== "") {
        closeThinking(); // close thinking block if thinking preceded text
        if (!textOpen) {
          textIndex = currentIndex;
          textOpen = true;
          emit(SseEventType.ContentBlockStart, {
            type: "content_block_start",
            index: textIndex,
            content_block: { type: ContentBlockType.Text, text: "" },
          });
        }
        emit(SseEventType.ContentBlockDelta, {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: DeltaType.TextDelta, text: delta.content },
        });
      }

      // 3. Tool calls: accumulate silently, emit at [DONE] as complete blocks.
      if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
        closeThinking();
        closeText();
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.id) {
            toolCallMap.set(idx, {
              id: tc.id,
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          } else {
            const existing = toolCallMap.get(idx);
            if (existing) {
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            }
          }
        }
      }
    };

    // Main read loop
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (lineBuffer.trim()) processLine(lineBuffer.trim());
          break;
        }
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) processLine(trimmed);
        }
        if (doneSeen) break;
      }
    } catch (err) {
      this.logger.error(`[agent stream] Read error: ${String(err)}`);
      closeText();
      closeThinking();
    }

    return {
      toolCalls: [...toolCallMap.values()],
      nextContentIndex: currentIndex,
      outputTokens,
    };
  }

  /**
   * Write a complete synthetic Anthropic SSE stream to the response.
   * Used for slash commands that respond immediately without calling the LLM.
   */
  private writeSyntheticSse(res: ServerResponse, text: string): void {
    const id = `msg_sys_${Date.now()}`;
    const sse = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    sse("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", content: [], model: "proxy-system", stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    sse("content_block_stop",  { type: "content_block_stop", index: 0 });
    sse("message_delta",       { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: text.length } });
    sse("message_stop",        { type: "message_stop" });
    res.end();
  }

  /**
   * Build the response payload for GET /config.
   */
  private buildConfigResponse() {
    return {
      proxyPort: this.config.proxyPort,
      targetUrl: this.config.targetUrl,
      maxTokensFallback: this.config.maxTokensFallback,
      locale: this.config.locale,
      temperature: this.config.temperature,
      systemPrompt: this.config.systemPrompt,
      enableThinking: this.config.enableThinking,
      model: this.modelInfo
        ? {
            id: this.modelInfo.id,
            type: this.modelInfo.type,
            publisher: this.modelInfo.publisher,
            arch: this.modelInfo.arch,
            quantization: this.modelInfo.quantization,
            compatibilityType: this.modelInfo.compatibilityType,
            loadedContextLength: this.modelInfo.loadedContextLength,
            maxContextLength: this.modelInfo.maxContextLength,
            maxTokensCap: this.modelInfo.maxTokensCap,
            capabilities: this.modelInfo.capabilities,
          }
        : null,
    };
  }

  /**
   * Send a JSON response.
   */
  private sendJson(res: ServerResponse, status: number, data: any): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  // ── Initialization Helpers ──────────────────────────────────────────────

  /**
   * Detect the model's tool calling limit.
   */
  private async detectToolLimit(): Promise<number> {
    if (this.config.maxToolsOverride !== null) {
      this.logger.info(t("probe.override", { max: this.config.maxToolsOverride }));
      return this.config.maxToolsOverride;
    }

    if (!this.modelInfo) {
      return 0;
    }

    // Check cache before running the (potentially slow) probe
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
   * Log incoming request metadata.
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the full request body as a string from a Node.js IncomingMessage.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
