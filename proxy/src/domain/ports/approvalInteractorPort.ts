/**
 * approvalInteractorPort.ts — Port for asking the user to approve a
 * destructive action.
 *
 * Decouples the approval flow from the SSE-based transport. The
 * `ApprovalGateService` uses this port to prompt the user and await a
 * decision. The concrete adapter (`SseApprovalInteractor`) emits a
 * `tool_request_pending` SSE event and suspends until the client POSTs
 * `/v1/messages/:id/approve`.
 *
 * Alternative implementations (e.g., a CLI prompt, a mock for tests) can
 * be plugged in without touching the approval logic.
 *
 * @module domain/ports/approvalInteractorPort
 */

import type { ApprovalResult, ApprovalScope } from "../types";
import type { ActionArgs } from "../entities/workspaceAction";
import type { SseWriterPort } from "./sseWriterPort";

/** Everything the approval modal needs to render a decision prompt. */
export interface ApprovalRequestParams {
  /** Action name as known by the workspace tool (write/edit/bash). */
  action: string;
  /** Full argument object from the model's tool call. */
  args: ActionArgs;
  /**
   * For `write` actions on an existing file: the current content, so the
   * client can render a diff preview. `null` when the file does not exist
   * yet or is not a write.
   */
  oldContent: string | null;
}

export interface ApprovalInteractorPort {
  /**
   * Ask the user to approve/deny an action. The implementation is
   * responsible for routing the prompt to wherever the user sees it
   * (webview modal, terminal, test mock). Awaits the user's response
   * or times out with `{approved: false, scope: "once"}`.
   */
  prompt(params: ApprovalRequestParams, writer: SseWriterPort): Promise<ApprovalResult>;

  /**
   * Resolve a previously-emitted prompt. Called by the HTTP `/approve`
   * handler when the client POSTs back. Returns `true` if a pending
   * request with that id existed, `false` if it was already resolved or
   * expired.
   */
  resolve(requestId: string, approved: boolean, scope: ApprovalScope): boolean;
}
