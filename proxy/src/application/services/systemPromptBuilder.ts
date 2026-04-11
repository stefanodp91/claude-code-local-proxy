/**
 * systemPromptBuilder.ts — Builds the system prompt injected into every
 * chat request when a workspace directory is known.
 *
 * Pure domain service: depends only on the `PromptRepositoryPort` (for
 * loading templates) and `PlanFileRepositoryPort` (for discovering the most
 * recent plan). It does NOT touch the filesystem directly.
 *
 * Replaces the old inline `buildAgentSystemPrompt()` function that lived in
 * `infrastructure/server.ts`. The same logic, now testable in isolation and
 * with the prompt text externalized to `proxy/prompts/<locale>/*.md`.
 *
 * @module application/services/systemPromptBuilder
 */

import { basename } from "node:path";
import { AgentMode } from "../../domain/types";
import {
  PromptKey,
  type PromptRepositoryPort,
  type PlanFileRepositoryPort,
} from "../../domain/ports";
import { buildWorkspaceContextSummary } from "../workspaceTool";
import { TEXTUAL_TOOL_MANUAL } from "../textualAgentLoop";

export class SystemPromptBuilder {
  constructor(
    private readonly prompts: PromptRepositoryPort,
    private readonly planFiles: PlanFileRepositoryPort,
  ) {}

  /**
   * Build the system prompt for a chat request.
   *
   * @param workspaceCwd - Absolute workspace root path.
   * @param mode         - Current agent mode (ask / auto / plan).
   * @param textualPath  - True when the model has no native tool support
   *                       (Path B / maxTools == 0). Appends the textual
   *                       tool manual and a static workspace summary.
   */
  build(workspaceCwd: string, mode: AgentMode, textualPath: boolean): string {
    const base = {
      cwd:      workspaceCwd,
      cwdBase:  basename(workspaceCwd),
      plansDir: this.planFiles.plansDirRelative,
    };

    if (mode === AgentMode.Plan) {
      return this.buildPlanModePrompt(workspaceCwd, textualPath, base);
    }
    return this.buildAgentBasePrompt(workspaceCwd, textualPath, base);
  }

  // ── Private builders ─────────────────────────────────────────────────────

  private buildAgentBasePrompt(
    workspaceCwd: string,
    textualPath: boolean,
    base: Record<string, string>,
  ): string {
    const prompt = this.prompts.get(PromptKey.AgentBase, base);
    return this.appendTextualTail(prompt, workspaceCwd, textualPath);
  }

  private buildPlanModePrompt(
    workspaceCwd: string,
    textualPath: boolean,
    base: Record<string, string>,
  ): string {
    const existing = this.planFiles.loadMostRecent(workspaceCwd);
    const existingPlanSection = existing
      ? this.prompts.get(PromptKey.ExistingPlanSection, {
          planPath:      existing.relPath,
          mtimeRelative: existing.mtimeRelative,
          planContent:   existing.content,
        })
      : "";

    const prompt = this.prompts.get(PromptKey.PlanMode, {
      ...base,
      existingPlanSection,
    });
    return this.appendTextualTail(prompt, workspaceCwd, textualPath);
  }

  /**
   * When the model has no native tool support, append the workspace summary
   * and the textual tool manual so the model knows how to emit `<action>` tags.
   */
  private appendTextualTail(prompt: string, cwd: string, textualPath: boolean): string {
    if (!textualPath) return prompt;
    return `${prompt}\n\n${buildWorkspaceContextSummary(cwd)}\n\n${TEXTUAL_TOOL_MANUAL}`;
  }
}
