/**
 * promptRepositoryPort.ts — Port for loading localized prompt templates.
 *
 * Long LLM prompts live as `.md` files under `proxy/prompts/<locale>/` so
 * they are diff-friendly and editable without recompiling. This port is the
 * application-layer entry point; the concrete adapter
 * (`FsPromptRepository`) reads the files from disk.
 *
 * Prompts support `{{name}}` placeholder interpolation — same syntax as the
 * existing i18n system in `domain/i18n.ts` — but they are kept separate
 * because their content (multi-line LLM system prompts) is structurally
 * different from the short UI strings in `locales/*.json`.
 *
 * @module domain/ports/promptRepositoryPort
 */

/**
 * Registered prompt template keys. Extend this enum to add new templates.
 * Every key must have a corresponding `<key>.md` file in each locale.
 */
export enum PromptKey {
  /** Base agent prompt used in ask/auto modes. */
  AgentBase           = "agent-base",
  /** Forced plan-mode prompt (top-of-prompt directive + mandatory write to plans dir). */
  PlanMode            = "plan-mode",
  /** Template injected into the plan-mode prompt when an existing plan is found. */
  ExistingPlanSection = "existing-plan-section",
}

export interface PromptRepositoryPort {
  /**
   * Preload all known prompts for the configured locale into memory.
   * Called once during `ProxyServer.initialize()`. Throws if any prompt
   * file is missing.
   */
  load(): Promise<void>;

  /**
   * Return a prompt template with `{{name}}` placeholders replaced by the
   * corresponding values. Placeholders without a matching param are left
   * as-is (`{{missing}}`) so debugging is easier.
   *
   * @throws Error if the prompt key was never loaded.
   */
  get(key: PromptKey, params?: Record<string, string>): string;
}
