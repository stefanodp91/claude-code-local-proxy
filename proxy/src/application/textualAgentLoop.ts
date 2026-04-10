/**
 * textualAgentLoop.ts — Path B agent loop for models without native tool support.
 *
 * For models where maxTools == 0, the proxy uses this textual agent loop:
 * the model is instructed to emit XML action tags inline, which the proxy
 * intercepts, executes, and responds to via <observation> blocks.
 *
 * The resulting Anthropic SSE stream is identical in structure to Path A
 * (tool_use content blocks, same message_start … message_stop envelope),
 * so the client is fully path-agnostic.
 *
 * @module application/textualAgentLoop
 */

import type { ServerResponse } from "node:http";
import { sseEvent, msgId } from "../domain/utils";
import { SseEventType, StopReason, ContentBlockType, DeltaType } from "../domain/types";
import { executeAction, ACTION_CLASSIFICATION, type ActionArgs } from "../infrastructure/workspaceActions";
import type { ILogger } from "../domain/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Textual tool manual (injected into the system prompt by server.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instructions injected into the system prompt for maxTools == 0 models.
 * Teaches the model to emit self-closing XML action tags that the proxy
 * will intercept, execute, and respond to with <observation> blocks.
 */
export const TEXTUAL_TOOL_MANUAL = [
  "You can interact with the workspace by emitting a self-closing XML action tag on its own line:",
  "",
  "  <action name=\"list\" path=\"./src\"/>",
  "  <action name=\"read\" path=\"README.md\"/>",
  "  <action name=\"grep\" pattern=\"parseConfig\" path=\"src/\" include=\"*.ts\"/>",
  "  <action name=\"glob\" pattern=\"**/*.ts\"/>",
  "",
  "After each action you will receive the result inside an <observation> block.",
  "Wait for the observation before continuing.",
  "Emit exactly one action at a time.",
  "Only emit an action tag when you need to inspect the workspace.",
  "When you have enough information, respond normally without emitting any action tag.",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 10;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
} as const;

// Number of trailing characters to keep in the pending text buffer as
// lookahead for a tag boundary split across two streaming chunks.
// Length of "<actio" = 6; using 7 is a safe margin.
const TAG_LOOKAHEAD = 7;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Callback for destructive-action approval.
 * `writeFn` is the loop's `writeSSE` helper — the gate uses it to emit the
 * `tool_request_pending` SSE event to the client before suspending.
 */
export type TextualApprovalGate = (
  action: string,
  args: ActionArgs,
  writeFn: (text: string) => void,
) => Promise<boolean>;

interface TextualIterationResult {
  /** All text forwarded to the client as text_delta events before the action. */
  textBeforeAction: string;
  /** The raw action tag string (<action .../>) or null if none was found. */
  actionTag: string | null;
  /** Parsed action arguments or null if no action was found. */
  actionArgs: ActionArgs | null;
  /** Content block index to use for the next iteration. */
  nextContentIndex: number;
  /** Output token count reported by the model for this iteration. */
  outputTokens: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Path B textual agent loop.
 *
 * Handles the full request/response lifecycle for models that lack native
 * tool_calls support (maxTools == 0).  Each iteration:
 *   1. Streams the model response, forwarding thinking and text deltas to the
 *      client in real time via a stateful XML tag parser.
 *   2. If an <action .../> tag is detected, intercepts it, emits it to the
 *      client as an Anthropic tool_use content block, executes the action,
 *      and injects the result as an <observation> user turn.
 *   3. Loops with the updated message history until the model responds without
 *      an action tag or MAX_ITERATIONS is reached.
 *
 * The client receives standard Anthropic SSE throughout and does not need to
 * know whether Path A or Path B is active.
 */
export async function runTextualAgentLoop(
  res: ServerResponse,
  openaiReq: any,
  workspaceCwd: string,
  thinkingEnabled: boolean,
  targetUrl: string,
  modelId: string,
  logger: ILogger,
  approvalGate?: TextualApprovalGate,
): Promise<void> {
  // Strip any tool-related fields — this model cannot use them.
  const baseReq = { ...openaiReq, tools: undefined, tool_choice: undefined };

  const messages: any[] = [...openaiReq.messages];
  const messageId = msgId();
  let headersSent = false;
  let contentIndex = 0;

  // ── SSE helpers ────────────────────────────────────────────────────────────

  /** Lazy write: sends SSE headers + message_start on the first call. */
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
            model: modelId,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }
    res.write(text);
  };

  /** Emit message_delta + message_stop, then close the response. */
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

  /** Emit a complete text content block (for errors and simple messages). */
  const emitTextBlock = (text: string): void => {
    if (!text) return;
    writeSSE(sseEvent(SseEventType.ContentBlockStart, {
      type: "content_block_start",
      index: contentIndex,
      content_block: { type: "text", text: "" },
    }));
    writeSSE(sseEvent(SseEventType.ContentBlockDelta, {
      type: "content_block_delta",
      index: contentIndex,
      delta: { type: "text_delta", text },
    }));
    writeSSE(sseEvent(SseEventType.ContentBlockStop, {
      type: "content_block_stop",
      index: contentIndex,
    }));
    contentIndex++;
  };

  // ── Agent loop ─────────────────────────────────────────────────────────────

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let resp: Response;
    try {
      resp = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...baseReq, messages, stream: true }),
      });
      if (!resp.ok || !resp.body) {
        const errText = !resp.ok ? await resp.text().catch(() => "") : "";
        emitTextBlock(`Error from LLM: ${errText || "no response body"}`);
        endMessage();
        return;
      }
    } catch (err) {
      emitTextBlock(`Error contacting LLM: ${String(err)}`);
      endMessage();
      return;
    }

    const result = await parseTextualIteration(
      resp.body,
      writeSSE,
      contentIndex,
      thinkingEnabled,
    );
    contentIndex = result.nextContentIndex;

    if (!result.actionTag || !result.actionArgs) {
      // No action — the model gave a final answer. Close the message.
      endMessage(result.outputTokens);
      return;
    }

    // ── Action found: emit as tool_use block, execute, inject observation ──

    const toolId = `tool_txt_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const rawInput = JSON.stringify(result.actionArgs);

    writeSSE(sseEvent(SseEventType.ContentBlockStart, {
      type: "content_block_start",
      index: contentIndex,
      content_block: { type: "tool_use", id: toolId, name: "workspace", input: {} },
    }));
    writeSSE(sseEvent(SseEventType.ContentBlockDelta, {
      type: "content_block_delta",
      index: contentIndex,
      delta: { type: "input_json_delta", partial_json: rawInput },
    }));
    writeSSE(sseEvent(SseEventType.ContentBlockStop, {
      type: "content_block_stop",
      index: contentIndex,
    }));
    contentIndex++;

    const actionArgs = result.actionArgs;
    let actionResult: string;
    if (ACTION_CLASSIFICATION[actionArgs.action] === "destructive" && approvalGate) {
      const approved = await approvalGate(actionArgs.action, actionArgs, writeSSE);
      if (!approved) {
        logger.dbg(`[workspace/textual] ${actionArgs.action} denied by user`);
        actionResult = `Action '${actionArgs.action}' was denied by the user.`;
      } else {
        actionResult = executeAction(actionArgs, workspaceCwd);
      }
    } else {
      actionResult = executeAction(actionArgs, workspaceCwd);
    }
    logger.dbg(
      `[workspace/textual] ${actionArgs.action} "${actionArgs.path ?? ""}" → ${actionResult.slice(0, 120)}`,
    );

    // Re-inject as assistant (text before action + the action tag itself) and
    // user (the observation).  The observation is plain text — non-tool models
    // cannot parse a structured tool_result, so we embed it inline.
    const assistantContent = result.textBeforeAction
      ? `${result.textBeforeAction}\n${result.actionTag}`
      : result.actionTag;

    messages.push({ role: "assistant", content: assistantContent });
    messages.push({ role: "user", content: `<observation>\n${actionResult}\n</observation>` });
  }

  // Max iterations reached without a final answer.
  emitTextBlock("(Max workspace tool iterations reached — response may be incomplete)");
  endMessage();
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming iteration parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stream one agent loop iteration to the client.
 *
 * Reads an OpenAI SSE stream and:
 *   - Forwards thinking deltas as Anthropic thinking_delta events in real time.
 *   - Forwards text deltas through a stateful XML tag parser that detects
 *     <action .../> tags even when split across streaming chunks.
 *   - When a complete action tag is found, stops forwarding text to the client
 *     and drains the rest of the stream silently.
 *
 * @returns textBeforeAction, actionTag, actionArgs, nextContentIndex, outputTokens
 */
async function parseTextualIteration(
  body: ReadableStream<Uint8Array>,
  writeSSE: (text: string) => void,
  startContentIndex: number,
  thinkingEnabled: boolean,
): Promise<TextualIterationResult> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let lineBuffer = "";

  // ── Content block state ──────────────────────────────────────────────────

  let thinkingOpen = false;
  let thinkingIndex = -1;
  let textOpen = false;
  let textIndex = -1;
  let currentIndex = startContentIndex;
  let outputTokens = 0;

  const emit = (eventType: string, data: any): void => writeSSE(sseEvent(eventType, data));

  const closeThinking = (): void => {
    if (!thinkingOpen) return;
    emit(SseEventType.ContentBlockStop, { type: "content_block_stop", index: thinkingIndex });
    thinkingOpen = false;
    currentIndex++;
  };

  const openText = (): void => {
    if (textOpen) return;
    closeThinking();
    textIndex = currentIndex;
    textOpen = true;
    emit(SseEventType.ContentBlockStart, {
      type: "content_block_start",
      index: textIndex,
      content_block: { type: ContentBlockType.Text, text: "" },
    });
  };

  const closeText = (): void => {
    if (!textOpen) return;
    emit(SseEventType.ContentBlockStop, { type: "content_block_stop", index: textIndex });
    textOpen = false;
    currentIndex++;
  };

  // ── XML tag parser state ─────────────────────────────────────────────────

  /** Text buffered since the last flush (protects against split tag boundaries). */
  let pendingText = "";
  /** Whether we are currently accumulating characters inside an <action tag. */
  let inTag = false;
  /** Set to true once an action tag is found; silently discards subsequent text. */
  let draining = false;

  /** Accumulated text forwarded to the client before the action tag. */
  let textBeforeAction = "";
  let foundActionTag: string | null = null;
  let foundActionArgs: ActionArgs | null = null;

  /**
   * Forward text to the client as a text_delta and accumulate for replay.
   * No-op if draining or if text is empty.
   */
  const flushText = (text: string): void => {
    if (!text || draining) return;
    openText();
    emit(SseEventType.ContentBlockDelta, {
      type: "content_block_delta",
      index: textIndex,
      delta: { type: DeltaType.TextDelta, text },
    });
    textBeforeAction += text;
  };

  /**
   * Process an incoming text chunk through the stateful XML tag parser.
   *
   * Algorithm:
   *   1. Append chunk to pendingText.
   *   2. If not in a tag: scan for "<action".
   *      - If not found: flush all but the last TAG_LOOKAHEAD chars (protecting
   *        against a tag boundary split at a chunk edge).
   *      - If found: flush text before it, enter tag mode.
   *   3. If in a tag: scan for "/>".
   *      - If not found: buffer and wait for more data.
   *      - If found: extract complete tag, parse attributes, mark draining.
   */
  const processTextChunk = (chunk: string): void => {
    if (draining) return;

    pendingText += chunk;

    while (pendingText.length > 0 && !draining) {
      if (!inTag) {
        const tagStart = pendingText.indexOf("<action");
        if (tagStart === -1) {
          // No action tag starting — flush everything except the lookahead tail.
          const safeLen = pendingText.length - TAG_LOOKAHEAD;
          if (safeLen > 0) {
            flushText(pendingText.slice(0, safeLen));
            pendingText = pendingText.slice(safeLen);
          }
          break; // wait for more data
        }
        // Tag start found — flush text before it.
        if (tagStart > 0) {
          flushText(pendingText.slice(0, tagStart));
        }
        pendingText = pendingText.slice(tagStart);
        inTag = true;
        // fall through to tag-mode processing in the same iteration
      } else {
        // Tag mode: look for the self-closing marker.
        const closePos = pendingText.indexOf("/>");
        if (closePos === -1) {
          // Tag not complete yet — wait for more chunks.
          break;
        }
        const completeTag = pendingText.slice(0, closePos + 2);
        pendingText = pendingText.slice(closePos + 2);
        inTag = false;

        const args = parseActionTag(completeTag);
        if (args) {
          foundActionTag = completeTag;
          foundActionArgs = args;
          draining = true;
          // Close any open text block before the tool_use block is emitted
          // by the caller.
          closeThinking();
          closeText();
        } else {
          // Malformed tag — treat as regular text.
          flushText(completeTag);
        }
      }
    }
  };

  /**
   * Flush remaining pendingText at stream end.
   * If we ended mid-tag (incomplete), emit it as text anyway.
   */
  const flushRemainder = (): void => {
    if (!pendingText || draining) return;
    flushText(pendingText);
    pendingText = "";
  };

  // ── Stream reading loop ──────────────────────────────────────────────────

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();

        if (dataStr === "[DONE]") {
          flushRemainder();
          closeThinking();
          closeText();
          break outer;
        }

        let parsed: any;
        try { parsed = JSON.parse(dataStr); } catch { continue; }

        if (parsed.usage?.completion_tokens) {
          outputTokens = parsed.usage.completion_tokens;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        // 1. Thinking (reasoning_content)
        if (delta.reasoning_content && thinkingEnabled && !draining) {
          // Close any open text block — thinking precedes text structurally.
          closeText();
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

        // 2. Text content — route through XML tag parser.
        if (delta.content != null && delta.content !== "") {
          processTextChunk(delta.content);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    textBeforeAction,
    actionTag: foundActionTag,
    actionArgs: foundActionArgs,
    nextContentIndex: currentIndex,
    outputTokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// XML action tag parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an XML action tag into an ActionArgs object.
 *
 * Supported attributes: name (required), path, pattern, include, cmd.
 * Attribute values must be double-quoted.
 *
 * @returns ActionArgs on success, null if the tag is malformed or missing name.
 */
function parseActionTag(tag: string): ActionArgs | null {
  const nameMatch = tag.match(/name="([^"]+)"/);
  if (!nameMatch) return null;

  const args: ActionArgs = { action: nameMatch[1] };

  const pathMatch = tag.match(/path="([^"]+)"/);
  if (pathMatch) args.path = pathMatch[1];

  const patternMatch = tag.match(/pattern="([^"]+)"/);
  if (patternMatch) args.pattern = patternMatch[1];

  const includeMatch = tag.match(/include="([^"]+)"/);
  if (includeMatch) args.include = includeMatch[1];

  const cmdMatch = tag.match(/cmd="([^"]+)"/);
  if (cmdMatch) args.cmd = cmdMatch[1];

  return args;
}
