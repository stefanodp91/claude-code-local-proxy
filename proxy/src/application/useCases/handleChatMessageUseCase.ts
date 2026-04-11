/**
 * handleChatMessageUseCase.ts — Use case for POST /v1/messages.
 *
 * Orchestrates the full request lifecycle:
 *   1. Slash command interception (synthetic SSE or content enrichment)
 *   2. System prompt injection (workspace context + agent instructions)
 *   3. Context compaction (trim conversation to fit model context window)
 *   4. Anthropic → OpenAI request translation (with tool selection)
 *   5. Agent loop routing:
 *      - Path A: native tool_calls via NativeAgentLoopService (maxTools > 0)
 *      - Path B: textual XML tags via runTextualAgentLoop (maxTools == 0)
 *      - Fall-through: direct LLM streaming/non-streaming forward
 *   6. Fall-through response handling (streaming via writer, or JSON return)
 *
 * Depends only on domain ports and application-layer services.
 * Zero Node.js I/O — no fetch, no fs, no ServerResponse.
 *
 * @module application/useCases/handleChatMessageUseCase
 */

import { t } from "../../domain/i18n";
import type { LlmClientPort, SseWriterPort, LoggerPort } from "../../domain/ports";
import type { AnthropicRequest, LoadedModelInfo, ApprovalResult } from "../../domain/types";
import { ThinkingType } from "../../domain/types";
import type { ActionArgs } from "../../domain/entities/workspaceAction";
import { ApprovalGateService } from "../services/approvalGateService";
import { SystemPromptBuilder } from "../services/systemPromptBuilder";
import { NativeAgentLoopService } from "../services/nativeAgentLoopService";
import { RequestTranslator } from "../requestTranslator";
import { ResponseTranslator } from "../responseTranslator";
import { StreamTranslator } from "../streamTranslator";
import { SlashCommandInterceptor } from "../slashCommandInterceptor";
import {
  runTextualAgentLoop,
  type TextualApprovalGate,
} from "../textualAgentLoop";

// ─────────────────────────────────────────────────────────────────────────────
// Context compaction (moved from server.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Rough token estimate: 4 chars ≈ 1 token (conservative). */
function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

const COMPACT_THRESHOLD = 0.80; // trigger at 80% of context window
const COMPACT_TARGET    = 0.65; // trim down to 65% of context window

/**
 * Compact `messages` in-place so their estimated token count stays under
 * `budgetTokens * COMPACT_THRESHOLD`. Returns the number of messages dropped.
 */
function compactMessages(messages: any[], budgetTokens: number): number {
  if (budgetTokens <= 0) return 0;

  const trigger = Math.floor(budgetTokens * COMPACT_THRESHOLD);
  const target  = Math.floor(budgetTokens * COMPACT_TARGET);

  if (estimateTokens(messages) <= trigger) return 0;

  let dropped = 0;
  // Keep index 0 (first user message) — drop from index 1 onward
  while (messages.length > 2 && estimateTokens(messages) > target) {
    messages.splice(1, 1);
    dropped++;
  }

  if (dropped > 0) {
    messages.splice(1, 0, {
      role: "user",
      content: `[${dropped} earlier message(s) were removed to fit the context window.]`,
    });
  }

  return dropped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface HandleChatMessageInput {
  /** Parsed Anthropic request body from Claude Code. */
  body: AnthropicRequest;
  /**
   * Workspace root directory passed by the IDE extension via
   * `x-workspace-root` header. Undefined for bare API calls without
   * a workspace context (agent loops are disabled in that case).
   */
  workspaceCwd: string | undefined;
}

/**
 * Result of a chat message use case execution.
 *
 * - `"handled"` — the response was fully written to `writer` (SSE stream).
 *   Caller must NOT write any further data to the response.
 * - `"json"` — the use case could not write an SSE response (non-streaming
 *   LLM reply or LLM error). Caller must write `body` as a JSON HTTP response
 *   with `status`.
 *
 * `llmReachable`:
 *   - `true`  — LLM was called and responded successfully.
 *   - `false` — LLM was called but returned an error.
 *   - `null`  — LLM was not called (agent loop handled, slash command, etc.).
 *   Caller should update the health-probe flag when non-null.
 */
export type HandleChatMessageResult =
  | { type: "handled"; llmReachable: boolean | null }
  | { type: "json";    status: number; body: any; llmReachable: boolean | null };

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export class HandleChatMessageUseCase {
  constructor(
    private readonly approvalGate: ApprovalGateService,
    private readonly promptBuilder: SystemPromptBuilder,
    private readonly nativeLoop: NativeAgentLoopService,
    private readonly llm: LlmClientPort,
    private readonly requestTranslator: RequestTranslator,
    private readonly responseTranslator: ResponseTranslator,
    private readonly streamTranslator: StreamTranslator,
    private readonly slashInterceptor: SlashCommandInterceptor,
    private readonly logger: LoggerPort,
    private readonly modelInfoProvider: () => LoadedModelInfo | null,
    private readonly maxToolsProvider: () => number,
    private readonly targetUrl: string,
  ) {}

  async execute(
    input: HandleChatMessageInput,
    writer: SseWriterPort,
  ): Promise<HandleChatMessageResult> {
    const { body, workspaceCwd } = input;
    const modelInfo = this.modelInfoProvider();
    const maxTools  = this.maxToolsProvider();

    const thinkingEnabled =
      body.thinking?.type === ThinkingType.Enabled || body.thinking?.type === ThinkingType.Adaptive;

    this.logRequest(body, thinkingEnabled, modelInfo);

    // ── 1. Slash command interception ─────────────────────────────────────
    const intercept = await this.slashInterceptor.intercept(body, workspaceCwd);

    if (intercept.type === "synthetic") {
      this.writeSyntheticSse(writer, intercept.text);
      return { type: "handled", llmReachable: null };
    }

    if (intercept.type === "enrich") {
      const last = body.messages.at(-1);
      if (last) last.content = intercept.newContent;
    }

    // ── 2. System prompt injection ────────────────────────────────────────
    // Injects workspace context + agent instructions. When agentMode=plan,
    // appends an additional block that instructs the model to write its plan
    // to .claudio/plans/ and wait for the user to switch mode.
    if (workspaceCwd) {
      this.logger.info(
        `[agent] mode="${this.approvalGate.agentMode}" cwd="${workspaceCwd}" maxTools=${maxTools}`,
      );
      const agentPrompt = this.promptBuilder.build(
        workspaceCwd,
        this.approvalGate.agentMode,
        maxTools === 0,
      );
      if (!body.system) {
        (body as any).system = agentPrompt;
      } else if (typeof body.system === "string") {
        (body as any).system = `${agentPrompt}\n\n${body.system}`;
      } else if (Array.isArray(body.system)) {
        body.system = [{ type: "text", text: agentPrompt }, ...body.system];
      }
    }

    // ── 3. Context compaction ──────────────────────────────────────────────
    const contextBudget = modelInfo?.loadedContextLength ?? 0;
    if (contextBudget > 0) {
      const dropped = compactMessages(body.messages, contextBudget);
      if (dropped > 0) {
        this.logger.info(
          `[compact] dropped ${dropped} message(s) to fit context window (${contextBudget} tokens)`,
        );
      }
    }

    // ── 4. Request translation (Anthropic → OpenAI) ────────────────────────
    const { request: openaiReq, toolSelection } = this.requestTranslator.translate(body);
    this.logger.dbg("OpenAI request:", JSON.stringify(openaiReq, null, 2));

    if (toolSelection?.useToolDef) {
      const coreNames = toolSelection.tools
        .filter((t: any) => t.function.name !== "UseTool")
        .map((t: any) => t.function.name)
        .join(",");
      this.logger.info(
        t("tools.filtered", {
          from: (toolSelection.tools.length - 1) + toolSelection.overflow.length,
          to: toolSelection.tools.length,
          coreList: coreNames,
        }),
      );
    }

    // ── 5. Agent loop routing ──────────────────────────────────────────────
    if (workspaceCwd) {
      if (maxTools > 0) {
        // Path A: native tool_calls
        const outcome = await this.nativeLoop.run(writer, openaiReq, workspaceCwd, thinkingEnabled);
        if (outcome === "handled") return { type: "handled", llmReachable: null };
        // "fallthrough" → continue to direct LLM call below
      } else {
        // Path B: textual XML tags
        await runTextualAgentLoop(
          writer,
          openaiReq,
          workspaceCwd,
          thinkingEnabled,
          this.llm,
          modelInfo?.id ?? openaiReq.model ?? "unknown",
          this.logger,
          this.makeTextualApprovalGate(workspaceCwd),
        );
        return { type: "handled", llmReachable: null };
      }
    }

    // ── 6. Fall-through: direct LLM forward ───────────────────────────────
    const llmResp = await this.llm.chat({ body: openaiReq, stream: !!openaiReq.stream });
    const llmReachable = llmResp.ok;

    if (!llmResp.ok) {
      const errMsg = llmResp.status === 0
        ? t("target.connectFailed", { url: this.targetUrl, error: llmResp.errorText ?? "" })
        : t("target.errorReturned", { error: llmResp.errorText ?? `HTTP ${llmResp.status}` });
      this.logger.error(errMsg);
      return {
        type:         "json",
        status:       llmResp.status > 0 ? llmResp.status : 502,
        body:         { type: "error", error: { type: "api_error", message: errMsg } },
        llmReachable: false,
      };
    }

    // Non-streaming response
    if (!openaiReq.stream) {
      const openaiJson = llmResp.json;
      this.logger.dbg("OpenAI response:", JSON.stringify(openaiJson, null, 2));
      const anthropicResp = this.responseTranslator.translate(
        openaiJson,
        body.model,
        thinkingEnabled,
      );
      this.logger.info(t("response.stopReason", { reason: anthropicResp.stop_reason }));
      return { type: "json", status: 200, body: anthropicResp, llmReachable };
    }

    // Streaming response — but backend may have returned JSON despite stream:true.
    if (!llmResp.body) {
      if (llmResp.json) {
        // Backend doesn't support streaming: fall back to responseTranslator.
        const anthropicResp = this.responseTranslator.translate(
          llmResp.json,
          body.model,
          thinkingEnabled,
        );
        this.logger.info(t("response.stopReason", { reason: anthropicResp.stop_reason }));
        return { type: "json", status: 200, body: anthropicResp, llmReachable };
      }
      return {
        type:         "json",
        status:       502,
        body:         { type: "error", error: { type: "api_error", message: t("response.noBody") } },
        llmReachable: false,
      };
    }

    const anthropicStream = this.streamTranslator.translate(
      llmResp.body,
      modelInfo?.id ?? body.model,
      thinkingEnabled,
    );

    this.logger.info(t("response.streamStarted"));
    writer.writeHeaders();

    const reader  = anthropicStream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (writer.isClosed) break;
        const { done, value } = await reader.read();
        if (done) break;
        writer.writeRaw(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      this.logger.error("[stream] error reading translated stream:", String(err));
    } finally {
      reader.releaseLock();
      writer.end();
    }

    return { type: "handled", llmReachable };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Write a complete synthetic Anthropic SSE stream to `writer`.
   * Used for slash commands that respond immediately without calling the LLM.
   */
  private writeSyntheticSse(writer: SseWriterPort, text: string): void {
    const id = `msg_sys_${Date.now()}`;
    const sse = (event: string, data: unknown): void => {
      writer.writeRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    sse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model: "proxy-system",
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
    sse("content_block_stop", { type: "content_block_stop", index: 0 });
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: text.length },
    });
    sse("message_stop", { type: "message_stop" });
    writer.end();
  }

  /**
   * Build the `TextualApprovalGate` callback for `runTextualAgentLoop`.
   * Adapts the loop's `(action, args, writeFn)` signature to
   * `ApprovalGateService.request()` which uses `SseWriterPort`.
   */
  private makeTextualApprovalGate(workspaceCwd: string): TextualApprovalGate {
    return (action: string, args: ActionArgs, writeFn: (text: string) => void) => {
      const writerAdapter: SseWriterPort = {
        writeHeaders() { /* headers already sent by the loop's writeSSE wrapper */ },
        writeRaw:   (frame) => writeFn(frame),
        end()       { /* owned by the agent loop */ },
        get isClosed() { return false; },
      };
      return this.approvalGate.request(writerAdapter, action, args, workspaceCwd);
    };
  }

  /** Log incoming request metadata at INFO level. */
  private logRequest(
    body: AnthropicRequest,
    thinkingEnabled: boolean,
    modelInfo: LoadedModelInfo | null,
  ): void {
    const effectiveModel = modelInfo?.id ?? body.model;
    const modelStr       = body.model !== effectiveModel
      ? `${body.model}→${effectiveModel}`
      : body.model;
    const maxTokensCap  = modelInfo?.maxTokensCap ?? 0;
    const cappedMaxTokens = maxTokensCap > 0
      ? Math.min(body.max_tokens, maxTokensCap)
      : body.max_tokens;

    this.logger.info(
      t("request.incoming", {
        model:    modelStr,
        msgs:     body.messages.length,
        tools:    body.tools?.length ?? 0,
        stream:   String(body.stream),
        thinking: String(thinkingEnabled),
        from:     body.max_tokens,
        to:       cappedMaxTokens,
      }),
    );
  }
}
