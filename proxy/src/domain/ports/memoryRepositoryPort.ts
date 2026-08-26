/**
 * memoryRepositoryPort.ts — Port for cross-session memory.
 *
 * A single markdown file in the workspace whose contents are prepended to the
 * system prompt on every request, so that a decision made last week survives a
 * restart of the proxy, the editor, and the conversation.
 *
 * There is deliberately no `save()`. The model already has a way to write files
 * — the ordinary `write` action — and routing memory updates through it means
 * they pass the approval gate like anything else that touches the disk. A
 * dedicated write path would have been a second, ungated one.
 *
 * The concrete adapter lives in `infrastructure/adapters/fsMemoryRepository.ts`.
 *
 * @module domain/ports/memoryRepositoryPort
 */

export interface MemoryRepositoryPort {
  /**
   * Memory file path relative to the workspace root, e.g. `.claudio/MEMORY.md`.
   * Exposed so the prompt can tell the model where to write.
   */
  readonly relativePath: string;

  /**
   * Current memory contents, or `null` when the file is missing, unreadable or
   * empty. `null` means the prompt gets no memory section at all rather than an
   * empty one — an empty heading costs tokens and teaches the model nothing.
   */
  load(workspaceCwd: string): string | null;
}
