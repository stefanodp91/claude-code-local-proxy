/**
 * nativeAgentLoopService.ts — Path A agentic loop (native tool calls).
 *
 * Orchestrates multi-iteration LLM ↔ workspace interaction for models that
 * support native tool_call syntax (maxTools > 0). Each turn proceeds as:
 *
 *   Iter-0: non-streaming probe (stream:false) — acts as a fallback guard.
 *     - If the model returns nothing: delegates to normal streaming (returns "fallthrough").
 *     - If the model returns text only: emits it and ends.
 *     - If the model calls tools: executes them and continues to iter-1+.
 *
 *   Iter-1+: streaming (stream:true) — forwards thinking/text deltas live and
 *     accumulates tool calls. When [DONE] is received, tool_use blocks are
 *     emitted and tool calls are executed, then the loop repeats.
 *
 * Depends only on domain ports and `ApprovalGateService`. Has no direct
 * dependency on `node:http`, `node:fs`, or `fetch`.
 *
 * @module application/services/nativeAgentLoopService
 */

import { sseEvent, msgId } from "../../domain/utils";
import {
  AgentMode,
  ApprovalScope,
  ContentBlockType,
  CustomSseEvent,
  DeltaType,
  OpenAIToolChoice,
  SseEventType,
  StopReason,
} from "../../domain/types";
import {
  ACTION_CLASSIFICATION,
  ActionClass,
  executeAction,
  WORKSPACE_TOOL_DEF,
  WorkspaceAction,
  type ActionArgs,
} from "../../infrastructure/workspaceActions";
import { t } from "../../domain/i18n";
import type {
  LlmClientPort,
  LoggerPort,
  PlanFileRepositoryPort,
  SseWriterPort,
} from "../../domain/ports";
import type { ApprovalGateService } from "./approvalGateService";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers (pure, no side effects)
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the text of the last user message from an OpenAI messages array. */
function lastUserMessageText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
    }
  }
  return "";
}

/**
 * Emit the `plan_mode_exit_suggestion` custom SSE event. The extension
 * handles this by showing the embedded PlanExit modal.
 */
function emitPlanModeExitSuggestion(
  writeSSE: (frame: string) => void,
  lastMessage: string,
  planRelPath: string | null,
): void {
  writeSSE(
    `event: ${CustomSseEvent.PlanModeExitSuggestion}\ndata: ${JSON.stringify({
      lastMessage,
      planPath: planRelPath,
    })}\n\n`,
  );
}

/**
 * Emit the `plan_file_created` custom SSE event when the model writes a plan
 * file. Uses the `PlanFileRepositoryPort` to classify the path — no hardcoded
 * `.claudio/plans/` string.
 *
 * @returns true when the event was emitted (caller uses this to relax tool_choice).
 */
function emitPlanFileCreated(
  args: ActionArgs,
  writeSSE: (frame: string) => void,
  planFiles: PlanFileRepositoryPort,
): boolean {
  if (args.action !== WorkspaceAction.Write || typeof args.path !== "string") return false;
  if (!planFiles.isPlanPath(args.path)) return false;
  writeSSE(`event: ${CustomSseEvent.PlanFileCreated}\ndata: ${JSON.stringify({ path: args.path })}\n\n`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutable per-run state
// ─────────────────────────────────────────────────────────────────────────────

/** Mutable state that is shared across iterations within a single `run()` call. */
interface LoopState {
  /** True after the user approves a destructive action with scope="turn". */
  allowAllThisTurn: boolean;
  /** True after the first plan-file write (relaxes `tool_choice` to "auto"). */
  planFileWritten: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Return type of `run()`. "fallthrough" means iter-0 produced no output and
 *  the caller should fall back to normal LLM streaming. */
export type NativeLoopOutcome = "handled" | "fallthrough";

/**
 * Application service that drives the native (Path A) agentic loop.
 *
 * Dependencies injected at construction time; per-request context (writer,
 * request body, workspace path) passed to `run()`.
 */
export class NativeAgentLoopService {
  constructor(
    private readonly llm: LlmClientPort,
    private readonly approvalGate: ApprovalGateService,
    private readonly planFiles: PlanFileRepositoryPort,
    private readonly logger: LoggerPort,
    /** Returns the currently-loaded model id (e.g. "nemotron-…"). */
    private readonly modelIdResolver: () => string,
  ) {}

  // ── Public entry point ────────────────────────────────────────────────────

  async run(
    writer: SseWriterPort,
    openaiReq: any,
    workspaceCwd: string,
    thinkingEnabled: boolean,
  ): Promise<NativeLoopOutcome> {
    const MAX_ITERATIONS = 10;

    const planMode = this.approvalGate.agentMode === AgentMode.Plan;
    const state: LoopState = { allowAllThisTurn: false, planFileWritten: false };

    const currentToolChoice = (): OpenAIToolChoice =>
      planMode && !state.planFileWritten ? OpenAIToolChoice.Required : OpenAIToolChoice.Auto;

    const agentReq = {
      ...openaiReq,
      tools: [WORKSPACE_TOOL_DEF],
      tool_choice: currentToolChoice(),
    };
    const messages: any[] = [...openaiReq.messages];
    const messageId = msgId();
    let messageStartSent = false;
    let contentIndex = 0;

    // ── SSE write helpers ────────────────────────────────────────────────────

    /** Lazy: emits `message_start` on first call, then forwards raw frames. */
    const writeSSE = (frame: string): void => {
      if (!messageStartSent) {
        messageStartSent = true;
        writer.writeRaw(
          sseEvent(SseEventType.MessageStart, {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              content: [],
              model: this.modelIdResolver(),
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
        );
      }
      writer.writeRaw(frame);
    };

    const endMessage = (outputTokens = 0, stopReason: StopReason = StopReason.EndTurn): void => {
      writeSSE(
        sseEvent(SseEventType.MessageDelta, {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }),
      );
      writeSSE(sseEvent(SseEventType.MessageStop, { type: "message_stop" }));
      writer.end();
    };

    const emitTextBlock = (text: string): void => {
      writeSSE(sseEvent(SseEventType.ContentBlockStart, { type: "content_block_start", index: contentIndex, content_block: { type: "text", text: "" } }));
      writeSSE(sseEvent(SseEventType.ContentBlockDelta, { type: "content_block_delta", index: contentIndex, delta: { type: "text_delta", text } }));
      writeSSE(sseEvent(SseEventType.ContentBlockStop, { type: "content_block_stop", index: contentIndex }));
      contentIndex++;
    };

    // ── Iteration loop ────────────────────────────────────────────────────────
    //
    // All iterations now use streaming (stream:true) so that thinking/text
    // deltas are forwarded to the client in real time.
    //
    // Iter-0 still acts as a fallback guard: if the model produces no output
    // at all (empty text, no thinking, no tool calls) — i.e. writeSSE was
    // never called and messageStartSent is still false — we return
    // "fallthrough" so the caller can retry with normal streaming and no
    // workspace-tool constraint.

    for (let i = 0; i < MAX_ITERATIONS; i++) {

      const llmResp = await this.llm.chat({
        body: { ...agentReq, tool_choice: currentToolChoice(), messages },
        stream: true,
      });

      if (!llmResp.ok) {
        emitTextBlock(`Error from LLM: ${llmResp.errorText ?? `HTTP ${llmResp.status}`}`);
        endMessage();
        return "handled";
      }

      // ── Streaming path ──────────────────────────────────────────────────
      if (llmResp.body) {
        const { toolCalls, nextContentIndex, outputTokens } =
          await this.parseStreamingIteration(llmResp.body, writeSSE, contentIndex, thinkingEnabled);

        // Iter-0 only: if nothing was emitted (model produced no text, no
        // thinking, no tool calls), fall through to normal streaming.
        if (i === 0 && !messageStartSent) return "fallthrough";

        contentIndex = nextContentIndex;

        if (toolCalls.length === 0) {
          endMessage(outputTokens);
          return "handled";
        }

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
          const { result, exitLoop } = await this.processToolCall(
            writeSSE, emitTextBlock, endMessage,
            tc.id, tc.arguments,
            workspaceCwd, openaiReq.messages, state,
          );
          if (exitLoop) return "handled";
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        continue;
      }

      // ── Non-streaming fallback (backend returned JSON despite stream:true) ──
      const choice = llmResp.json?.choices?.[0];
      if (!choice) {
        if (i === 0) return "fallthrough";
        endMessage();
        return "handled";
      }

      const text: string = choice.message?.content ?? "";
      const reasoning: string = choice.message?.reasoning_content ?? "";
      const rawToolCalls: any[] = (choice.message?.tool_calls ?? [])
        .filter((tc: any) => tc.function?.name === "workspace");

      if (!text.trim() && !reasoning && rawToolCalls.length === 0) {
        if (i === 0) return "fallthrough";
        endMessage();
        return "handled";
      }

      if (thinkingEnabled && reasoning) {
        writeSSE(sseEvent(SseEventType.ContentBlockStart, {
          type: "content_block_start", index: contentIndex,
          content_block: { type: ContentBlockType.Thinking, thinking: "", signature: "" },
        }));
        writeSSE(sseEvent(SseEventType.ContentBlockDelta, {
          type: "content_block_delta", index: contentIndex,
          delta: { type: DeltaType.ThinkingDelta, thinking: reasoning },
        }));
        writeSSE(sseEvent(SseEventType.ContentBlockStop, {
          type: "content_block_stop", index: contentIndex,
        }));
        contentIndex++;
      }

      if (rawToolCalls.length === 0) {
        emitTextBlock(text);
        endMessage(text.length);
        return "handled";
      }

      messages.push(choice.message);
      for (const tc of rawToolCalls) {
        const { result, exitLoop } = await this.processToolCall(
          writeSSE, emitTextBlock, endMessage,
          tc.id, tc.function?.arguments ?? "{}",
          workspaceCwd, openaiReq.messages, state,
        );
        if (exitLoop) return "handled";
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }

    // Max iterations reached without a final text response.
    emitTextBlock("(Max workspace tool iterations reached — response may be incomplete)");
    endMessage();
    return "handled";
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Shared tool-call executor — eliminates the duplication between iter-0 and
   * iter-1+. Handles the exit_plan_mode control action, the destructive-action
   * approval gate, and `executeAction`. Mutates `state` (allowAllThisTurn,
   * planFileWritten).
   *
   * @param writeSSE      - SSE write helper with lazy message_start.
   * @param emitTextBlock - helper that emits a complete text content block.
   * @param endMessage    - sends message_delta + message_stop and ends the response.
   * @param toolCallId    - OpenAI tool call id (used for tool result message).
   * @param argsRaw       - raw JSON string of the workspace tool arguments.
   * @param workspaceCwd  - absolute path to the workspace root.
   * @param originalMessages - original request messages (for lastUserMessageText).
   * @param state         - mutable loop state (allowAllThisTurn, planFileWritten).
   * @returns `{ result, exitLoop }` — result string for the tool-result message;
   *          exitLoop=true means the caller should return "handled" immediately.
   */
  private async processToolCall(
    writeSSE: (frame: string) => void,
    emitTextBlock: (text: string) => void,
    endMessage: () => void,
    _toolCallId: string,
    argsRaw: string,
    workspaceCwd: string,
    originalMessages: any[],
    state: LoopState,
  ): Promise<{ result: string; exitLoop: boolean }> {
    let args: ActionArgs;
    try { args = JSON.parse(argsRaw); }
    catch { args = { action: WorkspaceAction.List, path: "." } as ActionArgs; }

    // ── Control action: model requests exit_plan_mode ──────────────────────
    if (args.action === WorkspaceAction.ExitPlanMode) {
      const existing = this.planFiles.loadMostRecent(workspaceCwd);
      this.logger.info(`[plan-mode] model requested exit_plan_mode; existing plan: ${existing?.relPath ?? "(none)"}`);
      emitPlanModeExitSuggestion(
        writeSSE,
        lastUserMessageText(originalMessages),
        existing?.relPath ?? null,
      );
      emitTextBlock(
        existing
          ? t("planMode.exitSuggestion.withPlan", { path: existing.relPath })
          : t("planMode.exitSuggestion.noPlan"),
      );
      endMessage();
      return { result: "", exitLoop: true };
    }

    // ── Destructive action: gate through ApprovalGateService ───────────────
    let result: string;
    if (ACTION_CLASSIFICATION[args.action] === ActionClass.Destructive) {
      let approved: boolean;
      if (state.allowAllThisTurn) {
        this.logger.dbg(`[approval] allowAllTurn auto-approved ${args.action}`);
        approved = true;
      } else {
        const writerAdapter: SseWriterPort = {
          writeHeaders() { /* headers already handled by writeSSE lazy init */ },
          writeRaw: (frame) => writeSSE(frame),
          end() { /* owned by the loop */ },
          get isClosed() { return false; },
        };
        const approval = await this.approvalGate.request(writerAdapter, args.action, args, workspaceCwd);
        approved = approval.approved;
        if (approval.approved && approval.scope === ApprovalScope.Turn) {
          state.allowAllThisTurn = true;
          this.logger.info("[approval] allowAllThisTurn = true for the rest of this turn");
        }
      }

      if (!approved) {
        this.logger.dbg(`[workspace] ${args.action} denied by user`);
        result = `Action '${args.action}' was denied by the user.`;
      } else {
        result = executeAction(args, workspaceCwd);
        if (emitPlanFileCreated(args, writeSSE, this.planFiles)) state.planFileWritten = true;
      }
    } else {
      // Read-only action: execute without gating.
      result = executeAction(args, workspaceCwd);
    }

    this.logger.dbg(`[workspace] ${args.action} "${(args as any).path ?? ""}" → ${result.slice(0, 120)}`);
    return { result, exitLoop: false };
  }

  /**
   * Consume one streaming LLM response (an OpenAI SSE stream) and translate
   * it to Anthropic SSE events forwarded to the client in real time.
   *
   * - Thinking (`reasoning_content`) → `thinking_delta` events (when enabled).
   * - Text (`content`) → `text_delta` events.
   * - Tool calls → accumulated silently; emitted as `tool_use` blocks at [DONE].
   *
   * Content block indices start at `startContentIndex` and are updated as
   * blocks are opened/closed. Returns `nextContentIndex` for the next iteration.
   */
  private async parseStreamingIteration(
    body: ReadableStream<Uint8Array>,
    writeSSE: (frame: string) => void,
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
        // Emit all accumulated tool_use blocks in order.
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
          thinkingIndex = currentIndex;
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
        closeThinking();
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

      // 3. Tool calls: accumulate silently; emitted at [DONE] as complete blocks.
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
}
