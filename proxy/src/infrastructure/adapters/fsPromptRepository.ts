/**
 * fsPromptRepository.ts — Filesystem-backed PromptRepositoryPort adapter.
 *
 * Loads `.md` prompt templates from `proxy/prompts/<locale>/` at boot and
 * serves them with `{{name}}` placeholder substitution. Each `PromptKey`
 * enum value must have a corresponding `<key>.md` file in the locale dir.
 *
 * @module infrastructure/adapters/fsPromptRepository
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join, dirname } from "node:path";
import { PromptKey, type PromptRepositoryPort } from "../../domain/ports";
import { Locale } from "../../domain/types";

/** Regex matching `{{name}}` placeholders. Mirrors `domain/i18n.ts`. */
const INTERPOLATION_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * Default prompt directory resolved relative to this source file's location.
 * Points at `<proxy-root>/prompts/` which sits next to `src/`.
 */
function defaultBaseDir(): string {
  // src/infrastructure/adapters/fsPromptRepository.ts → <proxy-root>/prompts
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), "..", "..", "..", "prompts");
}

export class FsPromptRepository implements PromptRepositoryPort {
  private readonly prompts = new Map<PromptKey, string>();
  private loaded = false;

  constructor(
    private readonly locale: Locale,
    private readonly baseDir: string = defaultBaseDir(),
  ) {}

  async load(): Promise<void> {
    const dir = join(this.baseDir, this.locale);
    for (const key of Object.values(PromptKey)) {
      const path = join(dir, `${key}.md`);
      const raw = await readFile(path, "utf-8");
      // Strip a single trailing newline so `[...].join("\n")` semantics line up
      // with file-per-prompt content — editors typically add a trailing EOL
      // that we do NOT want in the composed prompt.
      const normalized = raw.replace(/\n$/, "");
      this.prompts.set(key as PromptKey, normalized);
    }
    this.loaded = true;
  }

  get(key: PromptKey, params: Record<string, string> = {}): string {
    if (!this.loaded) {
      throw new Error(`FsPromptRepository: get(${key}) called before load()`);
    }
    const template = this.prompts.get(key);
    if (template === undefined) {
      throw new Error(`FsPromptRepository: missing prompt "${key}" for locale "${this.locale}"`);
    }
    return template.replace(INTERPOLATION_PATTERN, (_, name: string) =>
      params[name] ?? `{{${name}}}`,
    );
  }
}
