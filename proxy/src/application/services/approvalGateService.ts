/**
 * approvalGateService.ts — Application service coordinating approval state
 * and the approval interactor.
 *
 * Holds the session-scoped state:
 *
 *   - `agentMode`   (Ask | Auto | Plan)
 *   - `trustedFiles` (Set of absolute paths approved with `scope: "file"`)
 *
 * The core logic of `request()` decides, based on mode + trusted list +
 * allowlist, whether to:
 *
 *   a) auto-approve (plan write in plan mode, auto mode, trusted path, allowlist)
 *   b) auto-deny   (plan mode blocking a non-plan destructive action)
 *   c) delegate to the interactor port (ask mode → modal)
 *
 * The service does NOT talk to the transport layer — it calls the
 * `ApprovalInteractorPort` which in production is `SseApprovalInteractor`.
 *
 * @module application/services/approvalGateService
 */

import { resolve } from "node:path";
import {
  AgentMode,
  ApprovalResult,
  ApprovalScope,
} from "../../domain/types";
import {
  ActionClass,
  WorkspaceAction,
  type ActionArgs,
} from "../../domain/entities/workspaceAction";
import type {
  ApprovalInteractorPort,
  LoggerPort,
  PlanFileRepositoryPort,
  SseWriterPort,
} from "../../domain/ports";

/** Shape of the `oldContent` loader so the service stays filesystem-agnostic. */
export type OldContentLoader = (
  action: string,
  args: ActionArgs,
  workspaceCwd: string | undefined,
) => string | null;

/** Static auto-approve allowlist predicate (from `.claudio/auto-approve.json`). */
export type AutoApproveCheck = (
  action: string,
  args: ActionArgs,
  workspaceCwd: string,
) => boolean;

export class ApprovalGateService {
  private readonly trustedFiles = new Set<string>();
  private _agentMode: AgentMode = AgentMode.Ask;

  constructor(
    private readonly interactor: ApprovalInteractorPort,
    private readonly planFiles: PlanFileRepositoryPort,
    private readonly logger: LoggerPort,
    private readonly loadOldContent: OldContentLoader,
    private readonly isAutoApproved: AutoApproveCheck,
  ) {}

  // ── Agent mode accessors ─────────────────────────────────────────────────

  get agentMode(): AgentMode {
    return this._agentMode;
  }

  setAgentMode(mode: AgentMode): void {
    this._agentMode = mode;
    this.logger.info(`[agent-mode] set to "${mode}"`);
  }

  // ── Main gate ────────────────────────────────────────────────────────────

  /**
   * Decide whether a destructive action can proceed. Returns the user's
   * (or the gate's) verdict as an {@link ApprovalResult}.
   */
  async request(
    writer: SseWriterPort,
    action: string,
    args: ActionArgs,
    workspaceCwd?: string,
  ): Promise<ApprovalResult> {
    // ── Plan mode: only plan-file writes are allowed ───────────────────────
    if (this._agentMode === AgentMode.Plan) {
      if (
        action === WorkspaceAction.Write &&
        typeof args.path === "string" &&
        this.planFiles.isPlanPath(args.path)
      ) {
        this.logger.dbg(`[approval] plan-mode auto-approved plan write: ${args.path}`);
        return { approved: true, scope: ApprovalScope.Once };
      }
      this.logger.dbg(`[approval] plan-mode blocked ${action}`);
      return { approved: false, scope: ApprovalScope.Once };
    }

    // ── Auto mode: no gating ───────────────────────────────────────────────
    if (this._agentMode === AgentMode.Auto) {
      this.logger.dbg(`[approval] auto-mode approved ${action}`);
      return { approved: true, scope: ApprovalScope.Once };
    }

    // ── Trusted file fast path (previous scope=file grant) ─────────────────
    if (
      (action === WorkspaceAction.Write || action === WorkspaceAction.Edit) &&
      typeof args.path === "string" &&
      workspaceCwd
    ) {
      const full = resolve(workspaceCwd, args.path);
      if (full.startsWith(workspaceCwd) && this.trustedFiles.has(full)) {
        this.logger.dbg(`[approval] trusted-file auto-approved ${action}: ${args.path}`);
        return { approved: true, scope: ApprovalScope.Once };
      }
    }

    // ── Static allowlist (.claudio/auto-approve.json) ──────────────────────
    if (workspaceCwd && this.isAutoApproved(action, args, workspaceCwd)) {
      this.logger.dbg(`[approval] auto-approved ${action} via allowlist`);
      return { approved: true, scope: ApprovalScope.Once };
    }

    // ── Ask mode: delegate to the interactor ───────────────────────────────
    const oldContent = this.loadOldContent(action, args, workspaceCwd);
    const result = await this.interactor.prompt({ action, args, oldContent }, writer);

    // Persist scope=file grants so future writes on the same path are waved through.
    if (
      result.approved &&
      result.scope === ApprovalScope.File &&
      (action === WorkspaceAction.Write || action === WorkspaceAction.Edit) &&
      typeof args.path === "string" &&
      workspaceCwd
    ) {
      const full = resolve(workspaceCwd, args.path);
      if (full.startsWith(workspaceCwd)) {
        this.trustedFiles.add(full);
        this.logger.info(`[approval] scope=file added to trustedFiles: ${args.path}`);
      }
    }

    return result;
  }
}
