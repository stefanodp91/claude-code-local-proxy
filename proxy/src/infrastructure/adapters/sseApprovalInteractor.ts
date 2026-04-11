/**
 * sseApprovalInteractor.ts — SSE-based ApprovalInteractorPort adapter.
 *
 * Implements the approval protocol over the existing proxy SSE stream:
 *
 *   1. `prompt()` emits a custom `tool_request_pending` SSE event with a
 *      generated request_id.
 *   2. The agent loop awaits the returned Promise.
 *   3. The client (chat-extension) shows its embedded approval modal and,
 *      on user decision, POSTs `/v1/messages/<request_id>/approve` with
 *      `{approved, scope}`.
 *   4. `ProxyServer.handleApprove` calls `resolve()` which looks up the
 *      pending promise and fulfills it.
 *
 * Timeout: if the user does not respond within `timeoutMs` the promise
 * resolves to `{approved: false, scope: "once"}` — treating silence as a
 * denial — so the agent loop never hangs indefinitely.
 *
 * State (`pending` map) lives ONLY in this adapter. The application-layer
 * `ApprovalGateService` knows nothing about request IDs or SSE plumbing.
 *
 * @module infrastructure/adapters/sseApprovalInteractor
 */

import * as crypto from "node:crypto";
import type {
  ApprovalInteractorPort,
  ApprovalRequestParams,
  LoggerPort,
  SseWriterPort,
} from "../../domain/ports";
import {
  ApprovalResult,
  ApprovalScope,
  CustomSseEvent,
} from "../../domain/types";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class SseApprovalInteractor implements ApprovalInteractorPort {
  /** request_id → resolver for the promise returned by `prompt()`. */
  private readonly pending = new Map<string, (result: ApprovalResult) => void>();

  constructor(
    private readonly logger: LoggerPort,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  prompt(params: ApprovalRequestParams, writer: SseWriterPort): Promise<ApprovalResult> {
    const requestId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

    writer.writeRaw(
      `event: ${CustomSseEvent.ToolRequestPending}\ndata: ${JSON.stringify({
        request_id: requestId,
        action:     params.action,
        params:     params.args,
        oldContent: params.oldContent,
      })}\n\n`,
    );

    return new Promise<ApprovalResult>((resolve) => {
      this.pending.set(requestId, resolve);

      setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          this.logger.dbg(`[approval] timeout for ${requestId} (${params.action}) — auto-deny`);
          resolve({ approved: false, scope: ApprovalScope.Once });
        }
      }, this.timeoutMs);
    });
  }

  resolve(requestId: string, approved: boolean, scope: ApprovalScope): boolean {
    const resolver = this.pending.get(requestId);
    if (!resolver) return false;
    this.pending.delete(requestId);
    resolver({ approved, scope });
    return true;
  }
}
