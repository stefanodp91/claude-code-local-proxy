/**
 * fsPlanFileRepository.ts — Filesystem-backed PlanFileRepositoryPort adapter.
 *
 * Single source of truth for the `.claudio/plans/` convention (or whatever
 * path was configured via `ProxyConfig.plansDir`). All code that needs to
 * read plan files, check whether a path is a plan path, or build plan file
 * paths goes through this adapter — NO other module should ever hardcode
 * the plans directory.
 *
 * @module infrastructure/adapters/fsPlanFileRepository
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ClockPort, PlanFileRepositoryPort } from "../../domain/ports";
import type { ExistingPlan } from "../../domain/entities/existingPlan";

export class FsPlanFileRepository implements PlanFileRepositoryPort {
  constructor(
    /** Plans directory relative to each workspace root (e.g. ".claudio/plans"). */
    readonly plansDirRelative: string,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Returns true iff `relPath` is a `.md` file located under the configured
   * plans directory. Accepts both absolute workspace-relative paths
   * (`".claudio/plans/foo.md"`) and paths that contain the plans dir segment
   * anywhere (defensive handling of `./`, `../`, multiple slashes).
   */
  isPlanPath(relPath: string): boolean {
    if (!relPath.endsWith(".md")) return false;
    const norm = relPath.replace(/\\/g, "/");
    const dir = this.plansDirRelative.replace(/\\/g, "/").replace(/\/$/, "");
    return norm.startsWith(`${dir}/`) || norm.includes(`/${dir}/`);
  }

  buildRelPath(filename: string): string {
    return `${this.plansDirRelative}/${filename}`;
  }

  /**
   * Return the most recently modified `.md` plan file in the workspace,
   * or null if the plans directory does not exist or contains no plan files.
   *
   * Reads the full content (no truncation) because downstream prompt
   * injection may want the entire file.
   */
  loadMostRecent(workspaceCwd: string): ExistingPlan | null {
    const plansDir = join(workspaceCwd, this.plansDirRelative);
    if (!existsSync(plansDir)) return null;

    let entries: string[];
    try {
      entries = readdirSync(plansDir);
    } catch {
      return null;
    }

    let best: { name: string; mtimeMs: number } | null = null;
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      try {
        const stat = statSync(join(plansDir, name));
        if (!stat.isFile()) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { name, mtimeMs: stat.mtimeMs };
        }
      } catch {
        /* skip unreadable entries */
      }
    }
    if (!best) return null;

    const absPath = join(plansDir, best.name);
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      return null;
    }

    return {
      relPath: `${this.plansDirRelative}/${best.name}`,
      absPath,
      content,
      mtimeRelative: this.formatRelativeTime(this.clock.now() - best.mtimeMs),
    };
  }

  /** Human-readable "N seconds/minutes/hours/days ago" stamp. */
  private formatRelativeTime(deltaMs: number): string {
    const sec = Math.floor(deltaMs / 1000);
    if (sec < 60)     return `${sec} seconds ago`;
    const min = Math.floor(sec / 60);
    if (min < 60)     return `${min} minute${min === 1 ? "" : "s"} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24)      return `${hr} hour${hr === 1 ? "" : "s"} ago`;
    const day = Math.floor(hr / 24);
    return `${day} day${day === 1 ? "" : "s"} ago`;
  }
}
