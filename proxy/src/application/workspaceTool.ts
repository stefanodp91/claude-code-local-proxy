/**
 * workspaceTool.ts — the static workspace summary for models without tools.
 *
 * One export: `buildWorkspaceContextSummary()`, injected into the system prompt
 * on Path B, where the model cannot look at anything for itself.
 *
 * It used to carry two more — a second `WORKSPACE_TOOL_DEF` offering only
 * `list` and `read`, and an `executeWorkspaceTool()` that implemented them with
 * a fourth private copy of the containment check. Nothing imported either: the
 * real schema lives in `domain/entities/workspaceAction.ts` with nine actions,
 * and execution lives in `infrastructure/workspaceActions.ts`. A stale duplicate
 * of a schema is not harmless — it is one wrong import away from telling a model
 * it has two actions when it has nine — so it is gone.
 *
 * @module application/workspaceTool
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Option B — static context summary (for models without tool support)
// ─────────────────────────────────────────────────────────────────────────────

/** How many top-level entries the summary lists before saying "and N more". */
const MAX_SUMMARY_ENTRIES = 60;

/**
 * Build a static workspace summary to inject into the system prompt
 * when the model does not support tool calling.
 *
 * Two things this owes the reader, both learned the hard way elsewhere in this
 * project:
 *
 * - **It never comes back silently empty.** On Path B this summary is all the
 *   model knows about the workspace; an unreadable root used to produce an
 *   empty string, and the model then answered about a project it had never been
 *   shown. It now says it could not look.
 * - **It is bounded.** It is injected into every system prompt of the turn, and
 *   the context window is the scarce resource here. A directory with hundreds
 *   of entries would spend the conversation's budget on file names.
 */
export function buildWorkspaceContextSummary(workspaceCwd: string): string {
  const lines: string[] = [];

  // Top-level listing
  try {
    const entries = readdirSync(workspaceCwd, { withFileTypes: true });
    lines.push("Workspace structure (top level):");
    for (const e of entries.slice(0, MAX_SUMMARY_ENTRIES)) {
      lines.push(`  ${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`);
    }
    if (entries.length > MAX_SUMMARY_ENTRIES) {
      lines.push(`  … and ${entries.length - MAX_SUMMARY_ENTRIES} more entries (use an action to look)`);
    }
  } catch (err) {
    lines.push(`Workspace structure: could not be listed (${String(err)})`);
  }

  // package.json
  const pkgPath = join(workspaceCwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      lines.push(
        `\npackage.json: name="${pkg.name ?? "?"}", description="${pkg.description ?? "none"}"`,
      );
      if (pkg.workspaces) {
        lines.push(`workspaces: ${JSON.stringify(pkg.workspaces)}`);
      }
    } catch {}
  }

  // README (first 2000 chars)
  for (const name of ["README.md", "readme.md"]) {
    const p = join(workspaceCwd, name);
    if (existsSync(p)) {
      try {
        const readme = readFileSync(p, "utf-8");
        lines.push(
          `\nREADME.md:\n${readme.slice(0, 2_000)}${readme.length > 2_000 ? "\n[truncated]" : ""}`,
        );
      } catch {}
      break;
    }
  }

  return lines.join("\n");
}
