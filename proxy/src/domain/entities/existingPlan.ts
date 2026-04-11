/**
 * existingPlan.ts — Value object describing the most recent plan file in a workspace.
 *
 * Returned by `PlanFileRepositoryPort.loadMostRecent()` and consumed by
 * `SystemPromptBuilder` to inject the existing plan into the plan-mode system
 * prompt.
 *
 * @module domain/entities/existingPlan
 */

export interface ExistingPlan {
  /** Relative path from the workspace root, e.g. `.claudio/plans/hello-world.md`. */
  relPath: string;

  /** Absolute path on disk — used for the trusted-files check in ApprovalGate. */
  absPath: string;

  /** Full file content, no truncation. */
  content: string;

  /** Human-readable age relative to now, e.g. "2 minutes ago". */
  mtimeRelative: string;
}
