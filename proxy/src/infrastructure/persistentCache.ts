/**
 * persistentCache.ts — Generic key-value persistent store backed by a JSON file.
 *
 * Completely agnostic about what is stored or how keys are structured.
 * Callers decide the key (e.g., model ID) and value shape (e.g., ModelCapabilities).
 *
 * Cache format: { "<key>": <value>, ... }
 *
 * @module infrastructure/persistentCache
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

// ─────────────────────────────────────────────────────────────────────────────
// PersistentCache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Key-value store backed by a local JSON file.
 *
 * - get() reads from disk synchronously (fast, no async overhead at startup).
 * - set() writes the full record to disk.
 * - merge() shallow-merges fields into an existing record without overwriting others.
 *
 * On any read error (file missing, invalid JSON) the cache is treated as empty.
 * On write errors the error is silently swallowed — the cache is best-effort.
 *
 * @template T - Shape of the stored value for each key.
 */
export class PersistentCache<T extends object> {
  /**
   * @param path - Absolute path to the backing JSON file.
   */
  constructor(private readonly path: string) {}

  /**
   * Retrieve a stored value by key.
   *
   * @param key - Lookup key.
   * @returns The stored value, or null if the key is absent or the file is unreadable.
   */
  get(key: string): T | null {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, T>;
      return data[key] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Store a value under a key, replacing any previous entry for that key.
   * Other keys are preserved.
   *
   * @param key - Storage key.
   * @param value - Value to store.
   */
  async set(key: string, value: T): Promise<void> {
    const data = this.readAll();
    data[key] = value;
    await this.writeAll(data);
  }

  /**
   * Shallow-merge fields into an existing record.
   *
   * Fields present in `update` are added or overwritten.
   * Fields already stored under `key` that are absent from `update` are kept.
   * Other keys in the cache are untouched.
   *
   * @param key - Storage key.
   * @param update - Partial value to merge into the existing record.
   */
  async merge(key: string, update: Partial<T>): Promise<void> {
    const data = this.readAll();
    data[key] = { ...data[key], ...update } as T;
    await this.writeAll(data);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private readAll(): Record<string, T> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, T>;
    } catch {
      return {};
    }
  }

  private async writeAll(data: Record<string, T>): Promise<void> {
    try {
      await writeFile(this.path, JSON.stringify(data, null, 2) + "\n", "utf8");
    } catch {
      // Best-effort: silently ignore write failures
    }
  }
}
