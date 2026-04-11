/**
 * planFileRepositoryPort.ts — Port for plan-file management.
 *
 * Encapsulates ALL knowledge of the plans directory (default `.claudio/plans`,
 * configurable via `ProxyConfig.plansDir`). Application code never hardcodes
 * the path — it calls methods on this port.
 *
 * The concrete adapter lives in
 * `infrastructure/adapters/fsPlanFileRepository.ts` and uses `node:fs`.
 *
 * @module domain/ports/planFileRepositoryPort
 */

import type { ExistingPlan } from "../entities/existingPlan";

export interface PlanFileRepositoryPort {
  /**
   * Configured plans directory, relative to each workspace's root.
   * Example: ".claudio/plans". Exposed as a read-only field so that callers
   * (e.g., SystemPromptBuilder) can mention it in prompts without knowing the
   * internal config.
   */
  readonly plansDirRelative: string;

  /**
   * Returns true when `relPath` points to a markdown file inside the
   * configured plans directory. Used by `ApprovalGateService` to decide
   * whether a write in Plan mode should be auto-approved.
   */
  isPlanPath(relPath: string): boolean;

  /**
   * Build a plan-file relative path from a filename.
   * Example: `.buildRelPath("foo.md") → ".claudio/plans/foo.md"`.
   */
  buildRelPath(filename: string): string;

  /**
   * Returns the most recently modified plan file in the workspace,
   * or `null` if the plans directory is missing or empty.
   */
  loadMostRecent(workspaceCwd: string): ExistingPlan | null;
}
