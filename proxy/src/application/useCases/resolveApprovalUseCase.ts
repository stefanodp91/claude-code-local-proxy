/**
 * resolveApprovalUseCase.ts — Use case for POST /v1/messages/:id/approve.
 *
 * Parses and validates the approval decision, then delegates to the
 * `ApprovalInteractorPort` to fulfill the pending approval promise.
 *
 * @module application/useCases/resolveApprovalUseCase
 */

import { ApprovalScope } from "../../domain/types";
import type { ApprovalInteractorPort } from "../../domain/ports";

export interface ResolveApprovalInput {
  requestId: string;
  approved:  boolean | undefined;
  scope:     unknown;
}

export interface ResolveApprovalResult {
  /** `true` if the request was found and resolved; `false` if unknown/expired. */
  resolved: boolean;
}

export class ResolveApprovalUseCase {
  constructor(private readonly interactor: ApprovalInteractorPort) {}

  execute(input: ResolveApprovalInput): ResolveApprovalResult {
    const approved = input.approved === true;
    const scope    = this.parseScope(input.scope);
    const resolved = this.interactor.resolve(input.requestId, approved, scope);
    return { resolved };
  }

  private parseScope(raw: unknown): ApprovalScope {
    if (raw === ApprovalScope.Turn || raw === ApprovalScope.File) return raw;
    return ApprovalScope.Once;
  }
}
