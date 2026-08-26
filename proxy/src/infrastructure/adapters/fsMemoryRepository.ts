/**
 * fsMemoryRepository.ts — Filesystem-backed MemoryRepositoryPort adapter.
 *
 * Reads the workspace's memory file. Everything that can go wrong here — no
 * file, no permission, a directory where a file was expected — resolves to
 * `null`, because a missing memory must degrade to "no memory" and never to a
 * failed request.
 *
 * @module infrastructure/adapters/fsMemoryRepository
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { MemoryRepositoryPort } from "../../domain/ports";

/** Ceiling on injected memory. Beyond this it is crowding out the conversation. */
const MAX_MEMORY_BYTES = 8_000;

export class FsMemoryRepository implements MemoryRepositoryPort {
  constructor(readonly relativePath: string) {}

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
      return content.length > MAX_MEMORY_BYTES
        ? content.slice(0, MAX_MEMORY_BYTES) + "\n\n[memory truncated]"
        : content;
    } catch {
      return null;
    }
  }
}
