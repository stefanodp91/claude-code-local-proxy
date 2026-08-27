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
  type MemoryRepositoryPort,
  type TodoRepositoryPort,
  type SkillRepositoryPort,
} from "../../domain/ports";
import { buildWorkspaceContextSummary } from "../workspaceTool";
import { TEXTUAL_TOOL_MANUAL } from "../textualAgentLoop";

export class SystemPromptBuilder {
  constructor(
    private readonly prompts: PromptRepositoryPort,
    private readonly planFiles: PlanFileRepositoryPort,
    private readonly memory: MemoryRepositoryPort,
    private readonly todo: TodoRepositoryPort,
    private readonly skills: SkillRepositoryPort,
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
    // Only what every template actually uses. A parameter a template never
    // interpolates is silently dropped, so passing one everywhere just in case
    // hides which prompt depends on what — `plansDir` went to the base prompt
    // for exactly that reason and was never read.
    const base = {
      cwd:           workspaceCwd,
      cwdBase:       basename(workspaceCwd),
      memorySection: this.buildMemorySection(workspaceCwd),
      todoSection:   this.buildTodoSection(workspaceCwd),
      skillsSection: this.buildSkillsSection(workspaceCwd),
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
      plansDir: this.planFiles.plansDirRelative,
      existingPlanSection,
    });
    return this.appendTextualTail(prompt, workspaceCwd, textualPath);
  }

  /**
   * Wrap whatever the workspace remembers from earlier sessions, or return an
   * empty string.
   *
   * Empty rather than a "no memories yet" placeholder: every token spent on an
   * empty section is taken from the conversation, and on these models the
   * context window is the scarce resource in the whole project.
   */
  private buildMemorySection(workspaceCwd: string): string {
    const remembered = this.memory.load(workspaceCwd);
    if (!remembered) return "";
    return this.prompts.get(PromptKey.MemorySection, {
      memory:     remembered,
      memoryPath: this.memory.relativePath,
    });
  }

  /**
   * The list the model was keeping, or an empty string.
   *
   * Empty for the same reason memory is: this goes into every request of the
   * turn, and an empty heading spends tokens telling the model there is nothing
   * to tell it.
   */
  private buildTodoSection(workspaceCwd: string): string {
    const list = this.todo.load(workspaceCwd);
    if (!list) return "";
    return this.prompts.get(PromptKey.TodoSection, {
      todo:     list,
      todoPath: this.todo.relativePath,
    });
  }

  /**
   * The index of skills on offer: a name and a line each, and nothing more.
   *
   * The bodies are loaded by `action="skill"` when the model decides it needs
   * one. That is the feature — instructions the conversation pays for only when
   * they are used — and injecting them here would undo it.
   */
  private buildSkillsSection(workspaceCwd: string): string {
    const available = this.skills.list(workspaceCwd);
    if (available.length === 0) return "";
    return this.prompts.get(PromptKey.SkillsSection, {
      skillList: available.map((s) => `  ${s.name} — ${s.description}`).join("\n"),
    });
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
