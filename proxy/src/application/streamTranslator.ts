/**
 * streamTranslator.ts — OpenAI SSE → Anthropic SSE streaming translation.
 *
 * Implements a state machine that processes OpenAI Server-Sent Events
 * chunk-by-chunk and emits corresponding Anthropic SSE events.
 *
 * The state machine tracks:
 * - Message lifecycle (start → content blocks → stop)
 * - Thinking blocks (reasoning_content)
 * - Text blocks (content)
 * - Tool call blocks (tool_calls), including UseTool buffering/rewriting
 *
 * UseTool handling: when a tool call with name "UseTool" is detected,
 * its SSE emission is deferred (buffered). On finalization, the accumulated
 * arguments are parsed and emitted as a burst with the real tool name.
 *
 * @module application/streamTranslator
 */

import {
  SseEventType,
  StopReason,
  FinishReason,
  ContentBlockType,
  DeltaType,
  USE_TOOL_NAME,
} from "../domain/types";
import type { ToolManager } from "./toolManager";
import type { ILogger } from "../domain/ports";
import { msgId, sseEvent } from "../domain/utils";
import { t } from "../domain/i18n";

// ─────────────────────────────────────────────────────────────────────────────
// Internal Types
// ─────────────────────────────────────────────────────────────────────────────

/** Tracks the state of a single tool call being accumulated from streaming deltas. */
interface StreamToolCall {
  /** Tool call ID from the first delta. */
  id: string;

  /** Tool function name (accumulated from deltas). */
  name: string;

  /** Accumulated function arguments JSON string. */
  arguments: string;

  /** Content block index assigned to this tool call. */
  blockIndex: number;

  /** Whether content_block_start has been emitted for this call. */
  started: boolean;

  /**
   * Whether this is a UseTool call that needs deferred emission.
   * When true, content_block_start is withheld until finalization,
   * at which point the real tool name is extracted from arguments.
   */
  pendingRewrite: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// StreamTranslator (public facade)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory for streaming translation state machines.
 *
 * Each call to translate() creates a fresh StreamStateMachine instance
 * with its own state, ensuring concurrent streams don't interfere.
 *
 * @example
 * const translator = new StreamTranslator(toolManager, logger);
 * const anthropicStream = translator.translate(openaiStream, model, false);
 * return new Response(anthropicStream, { headers: { "Content-Type": "text/event-stream" } });
 */
export class StreamTranslator {
  /**
   * @param toolManager - Tool manager for UseTool detection and rewriting.
   * @param logger - Logger for debug output and error reporting.
   */
  constructor(
    private readonly toolManager: ToolManager,
    private readonly logger: ILogger,
  ) {}

  /**
   * Create an Anthropic SSE ReadableStream from an OpenAI SSE stream.
   *
   * @param openaiStream - Raw byte stream from the OpenAI-compatible endpoint.
   * @param model - Model name for message_start events.
   * @param thinkingEnabled - Whether thinking blocks should be emitted.
   * @returns Anthropic-format SSE ReadableStream.
   */
  translate(
    openaiStream: ReadableStream<Uint8Array>,
    model: string,
    thinkingEnabled: boolean,
  ): ReadableStream<Uint8Array> {
    const machine = new StreamStateMachine(
      model,
      thinkingEnabled,
      this.toolManager,
      this.logger,
    );
    return machine.createStream(openaiStream);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// StreamStateMachine (internal, not exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State machine for translating a single OpenAI SSE stream to Anthropic SSE.
 *
 * Each instance processes exactly one streaming response. State is
 * encapsulated in instance fields — no shared mutable state.
 *
 * State transitions:
 *   (init) → message_start → [thinking_block] → [text_block] → [tool_blocks] → message_stop
 *
 * For UseTool calls, the tool block emission is deferred:
 *   tool_call delta (name=UseTool) → buffer arguments → finalize → emit burst with real name
 */
class StreamStateMachine {
  // ── State fields ──
  private started = false;
  private contentIndex = 0;
  private thinkingBlockOpen = false;
  private textBlockOpen = false;
  private toolCallsStarted = false;
  private readonly toolCalls = new Map<number, StreamToolCall>();
  private finalized = false;       // blocks closed, stop_reason known
  private finalEventsSent = false; // message_delta + message_stop emitted
  private closed = false;
  private buffer = "";
  private pendingUsage: { completion_tokens?: number; prompt_tokens?: number } = {};
  private pendingStopReason: StopReason | null = null;

  constructor(
    private readonly model: string,
    private readonly thinkingEnabled: boolean,
    private readonly toolManager: ToolManager,
    private readonly logger: ILogger,
  ) {}

  /**
   * Create the output ReadableStream that the HTTP response will wrap.
   *
   * The stream reads from the OpenAI upstream, processes each SSE line
   * through the state machine, and enqueues Anthropic SSE events.
   *
   * @param openaiStream - Raw upstream SSE byte stream.
   * @returns Anthropic SSE byte stream.
   */
  createStream(openaiStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Hoist reader so cancel() can abort the upstream on client disconnect
    let reader: ReadableStreamDefaultReader<Uint8Array>;

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        reader = openaiStream.getReader();
        await this.processStream(reader, controller, encoder, decoder);
      },
      cancel: () => {
        this.closed = true;
        reader?.cancel().catch(() => {});
      },
    });
  }

  // ── Stream Processing Loop ──────────────────────────────────────────────

  /**
   * Main read loop: consume OpenAI SSE chunks and emit Anthropic events.
   */
  private async processStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    decoder: TextDecoder,
  ): Promise<void> {
    try {
      let aborted = false;

      while (!aborted) {
        const { done, value } = await reader.read();

        if (done) {
          // Process any remaining data in the buffer
          if (this.buffer.trim()) {
            aborted = this.processBufferLines(this.buffer, controller, encoder);
          }
          if (!this.closed) {
            try { controller.close(); } catch { /* already closed */ }
          }
          break;
        }

        // Append chunk to buffer and process complete lines
        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? ""; // keep last incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const result = this.processChunk(trimmed);
          if (result) {
            this.logger.dbg("SSE out:", result.trim());
            if (!this.safeEnqueue(controller, encoder, result)) {
              aborted = true;
              break;
            }
          }
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.logger.error(t("stream.processingError", { error: String(err) }));
        const errEvent = sseEvent(SseEventType.Error, {
          type: "error",
          error: {
            type: "api_error",
            message: t("stream.processingError", { error: String(err) }),
          },
        });
        this.safeEnqueue(controller, encoder, errEvent);
        try { controller.close(); } catch { /* already closed */ }
      }
    }
  }

  /**
   * Process remaining buffer lines when the upstream ends.
   * @returns true if the client disconnected during processing.
   */
  private processBufferLines(
    buffer: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
  ): boolean {
    for (const line of buffer.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const result = this.processChunk(trimmed);
      if (result) {
        this.logger.dbg("SSE out:", result.trim());
        if (!this.safeEnqueue(controller, encoder, result)) return true;
      }
    }
    return false;
  }

  // ── Chunk Processing (State Machine Core) ───────────────────────────────

  /**
   * Process a single SSE line from the OpenAI stream.
   *
   * Dispatches to handlers based on the delta content:
   * reasoning_content, content, tool_calls, finish_reason.
   *
   * @param line - A complete SSE line (e.g., "data: {...}").
   * @returns Anthropic SSE events to emit, or empty string.
   */
  private processChunk(line: string): string {
    if (!line.startsWith("data: ")) return "";
    const dataStr = line.slice(6).trim();

    // Handle [DONE] sentinel
    if (dataStr === "[DONE]") {
      return this.handleDone();
    }

    // Parse the JSON payload
    let parsed: any;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      this.logger.dbg(t("stream.parseError"));
      return "";
    }

    // Capture usage from any chunk (LM Studio may send it in a choices-less chunk)
    if (parsed.usage) {
      this.pendingUsage = parsed.usage;
    }

    const choice = parsed.choices?.[0];
    if (!choice) return "";

    const delta = choice.delta ?? {};
    const finishReason = choice.finish_reason;
    let out = "";

    // Ensure message_start is emitted first
    if (!this.started) {
      out += this.emitMessageStart();
    }

    // 1. Reasoning content → thinking block
    if (delta.reasoning_content && this.thinkingEnabled) {
      out += this.handleReasoning(delta.reasoning_content);
    }

    // 2. Text content
    if (delta.content !== undefined && delta.content !== null) {
      out += this.handleContent(delta.content, finishReason);
    }

    // 3. Tool calls
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      out += this.handleToolCalls(delta.tool_calls);
    }

    // 4. Finish reason (from last chunk before [DONE])
    if (finishReason && !this.finalized) {
      out += this.handleFinishReason(finishReason, parsed);
    }

    return out;
  }

  // ── Delta Handlers ──────────────────────────────────────────────────────

  /**
   * Handle reasoning_content delta → thinking block.
   */
  private handleReasoning(reasoningContent: string): string {
    let out = "";

    if (!this.thinkingBlockOpen) {
      this.thinkingBlockOpen = true;
      this.contentIndex = 0;
      out += this.emitContentBlockStart(0, {
        type: ContentBlockType.Thinking,
        thinking: "",
        signature: "",
      });
      this.contentIndex = 1; // next block starts at 1
    }

    out += this.emitContentBlockDelta(0, {
      type: DeltaType.ThinkingDelta,
      thinking: reasoningContent,
    });

    return out;
  }

  /**
   * Handle content delta → text block.
   *
   * Skips whitespace-only content when tool calls are present or expected,
   * as some models emit spurious newlines around tool call deltas.
   */
  private handleContent(text: string, finishReason: string | null): string {
    // Skip whitespace-only content around tool calls
    const isWhitespaceOnly = !text.trim();
    if (isWhitespaceOnly && (this.toolCallsStarted || finishReason === FinishReason.ToolCalls)) {
      return "";
    }

    if (!text) return "";

    let out = "";

    // Close thinking block if still open (text follows thinking)
    out += this.closeThinkingBlock();

    if (!this.textBlockOpen) {
      this.textBlockOpen = true;
      out += this.emitContentBlockStart(this.contentIndex, {
        type: ContentBlockType.Text,
        text: "",
      });
    }

    out += this.emitContentBlockDelta(this.contentIndex, {
      type: DeltaType.TextDelta,
      text,
    });

    return out;
  }

  /**
   * Handle tool_calls delta → tool use blocks.
   *
   * For normal tools: emit content_block_start + incremental input_json_delta.
   * For UseTool: defer emission (pendingRewrite=true), buffer arguments.
   */
  private handleToolCalls(deltaCalls: any[]): string {
    this.toolCallsStarted = true;
    let out = "";

    // Close text/thinking blocks before tool calls
    out += this.closeThinkingBlock();
    out += this.closeTextBlock();

    for (const tc of deltaCalls) {
      const idx = tc.index ?? 0;

      // New tool call: allocate a block index and register it
      if (tc.id) {
        const blockIdx = this.contentIndex;
        this.contentIndex++;

        const isUseTool = tc.function?.name === USE_TOOL_NAME;

        this.toolCalls.set(idx, {
          id: tc.id,
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
          blockIndex: blockIdx,
          started: false,
          pendingRewrite: isUseTool,
        });
      }

      const existing = this.toolCalls.get(idx);
      if (!existing) continue;

      // Accumulate name and arguments from subsequent deltas
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;

      // For non-UseTool calls: emit content_block_start once the name is known
      if (!existing.pendingRewrite && !existing.started && existing.name) {
        existing.started = true;
        out += this.emitContentBlockStart(existing.blockIndex, {
          type: ContentBlockType.ToolUse,
          id: existing.id,
          name: existing.name,
          input: {},
        });
      }

      // For non-UseTool calls: emit incremental argument deltas
      if (!existing.pendingRewrite && existing.started && tc.function?.arguments) {
        out += this.emitContentBlockDelta(existing.blockIndex, {
          type: DeltaType.InputJsonDelta,
          partial_json: tc.function.arguments,
        });
      }

      // For UseTool calls: arguments accumulate silently (no emission yet)
    }

    return out;
  }

  /**
   * Handle the [DONE] sentinel: emit final message_delta + message_stop with
   * accumulated usage. This always runs last, so usage from any prior chunk
   * (including usage-only chunks) is available in pendingUsage.
   */
  private handleDone(): string {
    if (this.finalEventsSent) return "";
    this.finalEventsSent = true;

    let out = "";

    // Close any open blocks not yet closed by handleFinishReason
    if (!this.finalized) {
      this.finalized = true;
      out += this.closeThinkingBlock();
      out += this.closeTextBlock();
      out += this.finalizeToolCalls();
    }

    const stopReason =
      this.pendingStopReason ?? (this.toolCalls.size > 0 ? StopReason.ToolUse : StopReason.EndTurn);

    out += sseEvent(SseEventType.MessageDelta, {
      type: SseEventType.MessageDelta,
      delta: { stop_reason: stopReason },
      usage: { output_tokens: this.pendingUsage.completion_tokens ?? 0 },
    });
    out += sseEvent(SseEventType.MessageStop, { type: SseEventType.MessageStop });

    return out;
  }

  /**
   * Handle a finish_reason chunk: close open blocks and record stop reason.
   * Does NOT emit message_delta yet — deferred to handleDone() so that any
   * usage-only chunk that arrives between finish_reason and [DONE] is captured.
   */
  private handleFinishReason(finishReason: string, parsed: any): string {
    this.finalized = true;

    if (parsed.usage) this.pendingUsage = parsed.usage;

    // Map finish reason
    switch (finishReason) {
      case FinishReason.ToolCalls:
        this.pendingStopReason = StopReason.ToolUse;
        break;
      case FinishReason.Length:
        this.pendingStopReason = StopReason.MaxTokens;
        break;
      default:
        this.pendingStopReason = this.toolCalls.size > 0 ? StopReason.ToolUse : StopReason.EndTurn;
    }

    let out = "";
    out += this.closeThinkingBlock();
    out += this.closeTextBlock();
    out += this.finalizeToolCalls();
    return out;
  }

  // ── Tool Call Finalization ──────────────────────────────────────────────

  /**
   * Finalize all tool call blocks.
   *
   * For normal tools: emit content_block_stop.
   * For UseTool (pendingRewrite): parse accumulated arguments, emit a burst
   * of content_block_start + input_json_delta + content_block_stop with
   * the real tool name extracted from the UseTool parameters.
   */
  private finalizeToolCalls(): string {
    let out = "";

    for (const [, tc] of this.toolCalls) {
      if (tc.pendingRewrite) {
        // UseTool: deferred emission — parse and emit burst with real name
        const rewritten = this.toolManager.rewriteUseToolCall(tc.arguments);
        if (rewritten) {
          out += this.emitContentBlockStart(tc.blockIndex, {
            type: ContentBlockType.ToolUse,
            id: tc.id,
            name: rewritten.name,
            input: {},
          });
          out += this.emitContentBlockDelta(tc.blockIndex, {
            type: DeltaType.InputJsonDelta,
            partial_json: JSON.stringify(rewritten.input),
          });
          out += this.emitContentBlockStop(tc.blockIndex);
        } else {
          // Parsing failed — emit as-is with UseTool name as fallback
          out += this.emitContentBlockStart(tc.blockIndex, {
            type: ContentBlockType.ToolUse,
            id: tc.id,
            name: USE_TOOL_NAME,
            input: {},
          });
          out += this.emitContentBlockDelta(tc.blockIndex, {
            type: DeltaType.InputJsonDelta,
            partial_json: tc.arguments,
          });
          out += this.emitContentBlockStop(tc.blockIndex);
        }
      } else if (tc.started) {
        // Normal tool: already streaming — just close the block
        out += this.emitContentBlockStop(tc.blockIndex);
        tc.started = false;
      }
    }

    return out;
  }

  // ── SSE Event Emitters ─────────────────────────────────────────────────

  /** Emit message_start event (called once per stream). */
  private emitMessageStart(): string {
    this.started = true;
    return sseEvent(SseEventType.MessageStart, {
      type: SseEventType.MessageStart,
      message: {
        id: msgId(),
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  /** Emit content_block_start event. */
  private emitContentBlockStart(index: number, block: any): string {
    return sseEvent(SseEventType.ContentBlockStart, {
      type: SseEventType.ContentBlockStart,
      index,
      content_block: block,
    });
  }

  /** Emit content_block_delta event. */
  private emitContentBlockDelta(index: number, delta: any): string {
    return sseEvent(SseEventType.ContentBlockDelta, {
      type: SseEventType.ContentBlockDelta,
      index,
      delta,
    });
  }

  /** Emit content_block_stop event. */
  private emitContentBlockStop(index: number): string {
    return sseEvent(SseEventType.ContentBlockStop, {
      type: SseEventType.ContentBlockStop,
      index,
    });
  }

  // ── Block Lifecycle Helpers ────────────────────────────────────────────

  /** Close an open thinking block (thinking is always at index 0). */
  private closeThinkingBlock(): string {
    if (!this.thinkingBlockOpen) return "";
    this.thinkingBlockOpen = false;
    return this.emitContentBlockStop(0);
  }

  /** Close an open text block and advance the content index. */
  private closeTextBlock(): string {
    if (!this.textBlockOpen) return "";
    this.textBlockOpen = false;
    const idx = this.contentIndex;
    this.contentIndex++;
    return this.emitContentBlockStop(idx);
  }

  // ── Safe Enqueue ──────────────────────────────────────────────────────

  /**
   * Safely enqueue data to the controller, handling client disconnects.
   *
   * If the controller is already closed (client disconnected), sets the
   * closed flag and returns false to signal the read loop to abort.
   *
   * @returns true if the data was enqueued successfully, false if closed.
   */
  private safeEnqueue(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    data: string,
  ): boolean {
    if (this.closed) return false;
    try {
      controller.enqueue(encoder.encode(data));
      return true;
    } catch {
      this.closed = true;
      this.logger.dbg(t("stream.clientDisconnected"));
      return false;
    }
  }
}
