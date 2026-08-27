/**
 * fsWorkspaceFileRepository.ts — one reader for the files a workspace keeps for
 * the model: the cross-session memory, and the todo list.
 *
 * They are the same thing twice — a markdown file under `.claudio/`, read at the
 * start of a turn and injected into the prompt when it has content — so they are
 * one class with two instances rather than two classes that drift. Everything
 * that can go wrong resolves to `null`: a missing file must degrade to "nothing
 * to inject" and never to a failed request.
 *
 * @module infrastructure/adapters/fsWorkspaceFileRepository
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { MemoryRepositoryPort, TodoRepositoryPort } from "../../domain/ports";

/** Ceiling on injected memory. Beyond this it is crowding out the conversation. */
export const MAX_MEMORY_BYTES = 8_000;
/** The todo list is re-read on every turn and should stay a list, not a document. */
export const MAX_TODO_BYTES = 4_000;

export class FsWorkspaceFileRepository implements MemoryRepositoryPort, TodoRepositoryPort {
  /**
   * @param relativePath Workspace-relative file. Empty disables the feature.
   * @param maxBytes     Injection ceiling; beyond it the content is truncated
   *                     with a marker rather than dropped, because half a list
   *                     is worth more than none and silence is worth nothing.
   */
  constructor(readonly relativePath: string, private readonly maxBytes = MAX_MEMORY_BYTES) {}

  load(workspaceCwd: string): string | null {
    if (!this.relativePath) return null;

    const full = resolve(workspaceCwd, this.relativePath);
    // The path comes from configuration rather than from the model, but it is
    // still interpolated into a prompt and read from disk; the containment
    // check costs nothing and keeps a stray `../` in a config file from
    // reading somewhere else entirely.
    const rel = relative(resolve(workspaceCwd), full);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;

    try {
      if (!statSync(full).isFile()) return null;
      const content = readFileSync(full, "utf-8").trim();
      if (!content) return null;
      return content.length > this.maxBytes
        ? content.slice(0, this.maxBytes) + `\n\n[${this.relativePath} truncated]`
        : content;
    } catch {
      return null;
    }
  }
}
