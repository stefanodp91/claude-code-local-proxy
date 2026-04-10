/**
 * workspaceTool.ts — Workspace file-system tool for LLM-driven code exploration.
 *
 * Provides:
 * - WORKSPACE_TOOL_DEF: OpenAI tool schema (single tool, 1 slot)
 * - executeWorkspaceTool(): execute list/read calls from the LLM
 * - buildWorkspaceContextSummary(): static summary for models without tool support
 *
 * @module application/workspaceTool
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const MAX_FILE_BYTES = 50_000;

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition (OpenAI schema)
// ─────────────────────────────────────────────────────────────────────────────

export const WORKSPACE_TOOL_DEF = {
  type: "function",
  function: {
    name: "workspace",
    description:
      "Access files in the current workspace. " +
      "Use action='list' to list the contents of a directory, " +
      "action='read' to read the content of a file.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read"] },
        path: {
          type: "string",
          description:
            "Path relative to the workspace root (e.g. '.', 'src/components', 'package.json').",
        },
      },
      required: ["action", "path"],
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a workspace tool call from the LLM.
 * Returns a string result suitable for use as a tool_result message.
 */
export function executeWorkspaceTool(
  args: { action: string; path: string },
  workspaceCwd: string,
): string {
  const safePath = safeResolve(args.path, workspaceCwd);
  if (!safePath) return "Error: path is outside workspace root";

  if (args.action === "list") {
    try {
      const entries = readdirSync(safePath, { withFileTypes: true });
      if (entries.length === 0) return "(empty directory)";
      return entries
        .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
        .join("\n");
    } catch (err) {
      return `Error listing directory: ${String(err)}`;
    }
  }

  if (args.action === "read") {
    try {
      const stat = statSync(safePath);
      if (stat.isDirectory()) return "Error: path is a directory — use action='list'";
      const raw = readFileSync(safePath, "utf-8");
      if (raw.length > MAX_FILE_BYTES) {
        return raw.slice(0, MAX_FILE_BYTES) + `\n\n[file truncated at ${MAX_FILE_BYTES} bytes]`;
      }
      return raw;
    } catch (err) {
      return `Error reading file: ${String(err)}`;
    }
  }

  return `Error: unknown action '${args.action}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Option B — static context summary (for models without tool support)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a static workspace summary to inject into the system prompt
 * when the model does not support tool calling.
 */
export function buildWorkspaceContextSummary(workspaceCwd: string): string {
  const lines: string[] = [];

  // Top-level listing
  try {
    const entries = readdirSync(workspaceCwd, { withFileTypes: true });
    lines.push("Workspace structure (top level):");
    for (const e of entries) {
      lines.push(`  ${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`);
    }
  } catch {}

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

// ─────────────────────────────────────────────────────────────────────────────
// Security helper
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a relative path and ensure it stays within workspaceCwd. */
function safeResolve(relativePath: string, workspaceCwd: string): string | null {
  const resolved = resolve(workspaceCwd, relativePath);
  // Must start with workspaceCwd followed by separator or be exactly workspaceCwd
  if (resolved !== workspaceCwd && !resolved.startsWith(workspaceCwd + "/")) return null;
  return resolved;
}
