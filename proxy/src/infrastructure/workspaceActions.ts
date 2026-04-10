/**
 * workspaceActions.ts — Shared action backend for the agent loop.
 *
 * Single source of truth for all workspace actions executed by the proxy on
 * behalf of the LLM.  Both the native agent loop (Path A, tool_calls) and the
 * textual agent loop (Path B, XML tags) call executeAction() — they never
 * implement file-system or shell logic themselves.
 *
 * Actions
 * ──────────────────────────────────────────────────────────────────
 *   read-only  : list, read, grep, glob
 *   destructive: write, edit, bash           (not yet implemented — stubs only)
 *
 * Security
 * ──────────────────────────────────────────────────────────────────
 *   All file-system paths are resolved through safeResolvePath() before use.
 *   Any path that escapes the workspace root is rejected with an error string.
 *
 * Output contract
 * ──────────────────────────────────────────────────────────────────
 *   executeAction() always returns a string.  Callers convert that string into
 *   a tool_result or <observation> as appropriate for their path.
 *
 * @module infrastructure/workspaceActions
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, relative, dirname } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 50_000;
const MAX_GREP_LINES = 200;
const MAX_GLOB_RESULTS = 500;
const SHELL_TIMEOUT_MS = 15_000;

// Directories that are never useful to search or list for an LLM agent.
const PRUNE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".angular",
  ".next",
  ".nuxt",
  "__pycache__",
  ".cache",
  "coverage",
  ".venv",
  "venv",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Action classification
// ─────────────────────────────────────────────────────────────────────────────

export type ActionClass = "read-only" | "destructive";

/**
 * Classification of each action for the permission gate.
 * read-only actions are auto-executed.
 * destructive actions require user approval before execution
 * (see proxy/docs/permission-protocol.md).
 */
export const ACTION_CLASSIFICATION: Record<string, ActionClass> = {
  list: "read-only",
  read: "read-only",
  grep: "read-only",
  glob: "read-only",
  write: "destructive",
  edit: "destructive",
  bash: "destructive",
};

// ─────────────────────────────────────────────────────────────────────────────
// Extended OpenAI tool definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OpenAI tool definition for the workspace tool.
 * A single tool slot with an `action` discriminator keeps the tool count at 1,
 * which is safe even for models with low maxTools limits.
 */
export const WORKSPACE_TOOL_DEF = {
  type: "function",
  function: {
    name: "workspace",
    description: [
      "Access the current workspace. Available actions:",
      "  list   – list directory contents",
      "  read   – read a file",
      "  grep   – search for a regex pattern across files",
      "  glob   – find files matching a glob-style pattern",
      "  write  – create or overwrite a file  ⚠ requires user approval",
      "  edit   – replace exact text in a file ⚠ requires user approval",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "grep", "glob", "write", "edit"],
          description: "Action to perform.",
        },
        path: {
          type: "string",
          description:
            "Path relative to the workspace root " +
            "(e.g. '.', 'src/components', 'package.json'). " +
            "Required for list, read, grep, write, and edit.",
        },
        pattern: {
          type: "string",
          description:
            "For grep: a regex pattern to search for. " +
            "For glob: a glob pattern (e.g. '**/*.ts', 'src/**/*.tsx').",
        },
        include: {
          type: "string",
          description:
            "For grep: a file name pattern to restrict the search " +
            "(e.g. '*.ts', '*.{ts,tsx}'). Optional.",
        },
        content: {
          type: "string",
          description: "For write: the complete text content to write to the file.",
        },
        old_string: {
          type: "string",
          description:
            "For edit: the exact string to find in the file " +
            "(must match character-for-character including whitespace).",
        },
        new_string: {
          type: "string",
          description: "For edit: the replacement string.",
        },
      },
      required: ["action"],
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionArgs {
  action: string;
  path?: string;
  pattern?: string;
  include?: string;
  content?: string;     // for write: full file content
  old_string?: string;  // for edit: exact text to replace
  new_string?: string;  // for edit: replacement text
  cmd?: string;         // for bash
  [key: string]: string | undefined;
}

/**
 * Async callback the agent loops use to request human approval before
 * executing a destructive action (write, edit, bash).
 *
 * @param action - action name (e.g. "write")
 * @param args   - full action arguments
 * @returns      - true if approved, false if denied or timed out
 */
export type ApprovalGate = (action: string, args: ActionArgs) => Promise<boolean>;

/**
 * Execute a workspace action and return the result as a string.
 *
 * @param args         - action name plus action-specific parameters
 * @param workspaceCwd - absolute path to the workspace root
 * @returns            - a string result, never throws
 */
export function executeAction(args: ActionArgs, workspaceCwd: string): string {
  try {
    switch (args.action) {
      case "list":
        return actionList(args, workspaceCwd);
      case "read":
        return actionRead(args, workspaceCwd);
      case "grep":
        return actionGrep(args, workspaceCwd);
      case "glob":
        return actionGlob(args, workspaceCwd);
      case "write":
        return actionWrite(args, workspaceCwd);
      case "edit":
        return actionEdit(args, workspaceCwd);
      case "bash":
        return "Error: bash is a destructive action and has not been approved yet";
      default:
        return `Error: unknown action '${args.action}'. Valid actions: list, read, grep, glob`;
    }
  } catch (err) {
    return `Error executing action '${args.action}': ${String(err)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action: list
// ─────────────────────────────────────────────────────────────────────────────

function actionList(args: ActionArgs, workspaceCwd: string): string {
  const targetPath = args.path ?? ".";
  const safe = safeResolvePath(targetPath, workspaceCwd);
  if (!safe) return `Error: path '${targetPath}' is outside the workspace root`;

  let entries;
  try {
    entries = readdirSync(safe, { withFileTypes: true });
  } catch (err) {
    return `Error listing '${targetPath}': ${String(err)}`;
  }

  if (entries.length === 0) return "(empty directory)";

  return entries
    .sort((a, b) => {
      // directories first, then files, alphabetical within each group
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((e) => `${e.isDirectory() ? "[dir] " : "[file]"} ${e.name}`)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Action: read
// ─────────────────────────────────────────────────────────────────────────────

function actionRead(args: ActionArgs, workspaceCwd: string): string {
  if (!args.path) return "Error: 'path' is required for action='read'";

  const safe = safeResolvePath(args.path, workspaceCwd);
  if (!safe) return `Error: path '${args.path}' is outside the workspace root`;

  let stat;
  try {
    stat = statSync(safe);
  } catch (err) {
    return `Error: cannot access '${args.path}': ${String(err)}`;
  }

  if (stat.isDirectory()) {
    return `Error: '${args.path}' is a directory — use action='list' to inspect it`;
  }

  let content;
  try {
    content = readFileSync(safe, "utf-8");
  } catch (err) {
    return `Error reading '${args.path}': ${String(err)}`;
  }

  if (content.length > MAX_FILE_BYTES) {
    return content.slice(0, MAX_FILE_BYTES) + `\n\n[file truncated at ${MAX_FILE_BYTES} bytes]`;
  }
  return content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action: grep
// ─────────────────────────────────────────────────────────────────────────────

function actionGrep(args: ActionArgs, workspaceCwd: string): string {
  if (!args.pattern) return "Error: 'pattern' is required for action='grep'";

  const searchRoot = args.path ?? ".";
  const safe = safeResolvePath(searchRoot, workspaceCwd);
  if (!safe) return `Error: path '${searchRoot}' is outside the workspace root`;

  // Build a grep command. Use platform grep (available on macOS and Linux).
  // -r recursive, -n show line numbers, -I skip binary files, --include for filter.
  const escapedPattern = args.pattern.replace(/'/g, "'\\''");
  let cmd = `grep -rn -I --color=never`;

  if (args.include) {
    // Support comma-separated patterns like "*.ts,*.tsx"
    const includes = args.include.split(",").map((p) => p.trim());
    for (const inc of includes) {
      cmd += ` --include='${inc.replace(/'/g, "'\\''")}'`;
    }
  }

  // Exclude pruned directories
  for (const dir of PRUNE_DIRS) {
    cmd += ` --exclude-dir='${dir}'`;
  }

  cmd += ` '${escapedPattern}' .`;

  let output: string;
  try {
    output = execSync(cmd, {
      cwd: safe,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    // grep exits with code 1 when no matches — that is a valid result
    const childErr = err as { status?: number; stdout?: string; message?: string };
    if (childErr.status === 1) return "(no matches found)";
    return `Error running grep: ${childErr.message ?? String(err)}`;
  }

  const lines = output.trimEnd().split("\n");
  if (lines.length > MAX_GREP_LINES) {
    return (
      lines.slice(0, MAX_GREP_LINES).join("\n") +
      `\n\n[output truncated — showing ${MAX_GREP_LINES} of ${lines.length} matches]`
    );
  }
  return output.trimEnd() || "(no matches found)";
}

// ─────────────────────────────────────────────────────────────────────────────
// Action: glob
// ─────────────────────────────────────────────────────────────────────────────

function actionGlob(args: ActionArgs, workspaceCwd: string): string {
  if (!args.pattern) return "Error: 'pattern' is required for action='glob'";

  const results: string[] = [];
  walkForGlob(workspaceCwd, workspaceCwd, args.pattern, results);

  if (results.length === 0) return "(no files matched)";

  results.sort();
  if (results.length > MAX_GLOB_RESULTS) {
    return (
      results.slice(0, MAX_GLOB_RESULTS).join("\n") +
      `\n\n[output truncated — showing ${MAX_GLOB_RESULTS} of ${results.length} matches]`
    );
  }
  return results.join("\n");
}

/** Recursive directory walk that tests each file against the glob pattern. */
function walkForGlob(
  dir: string,
  workspaceRoot: string,
  pattern: string,
  results: string[],
): void {
  if (results.length >= MAX_GLOB_RESULTS) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_GLOB_RESULTS) break;
    if (PRUNE_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(workspaceRoot, fullPath);

    if (entry.isDirectory()) {
      walkForGlob(fullPath, workspaceRoot, pattern, results);
    } else if (matchGlob(pattern, relPath)) {
      results.push(relPath);
    }
  }
}

/**
 * Minimal glob matcher supporting:
 *   `**`  – any number of path segments
 *   `*`   – any characters within a single segment
 *   `?`   – any single character
 *   `{a,b}` – alternation
 *
 * Path separators are normalised to `/` before matching.
 */
function matchGlob(pattern: string, filePath: string): boolean {
  const p = pattern.replace(/\\/g, "/");
  const f = filePath.replace(/\\/g, "/");

  // Expand {a,b,c} alternation into multiple patterns
  const braceMatch = p.match(/\{([^}]+)\}/);
  if (braceMatch) {
    const alternatives = braceMatch[1].split(",");
    return alternatives.some((alt) =>
      matchGlob(p.replace(braceMatch[0], alt.trim()), filePath),
    );
  }

  // Convert glob to regex
  const regexStr =
    "^" +
    p
      .split("**")
      .map((segment) =>
        segment
          .split("*")
          .map((s) => s.split("?").map(escapeRegex).join("."))
          .join("[^/]*"),
      )
      .join(".*") +
    "$";

  return new RegExp(regexStr).test(f);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// Action: write
// ─────────────────────────────────────────────────────────────────────────────

function actionWrite(args: ActionArgs, workspaceCwd: string): string {
  if (!args.path) return "Error: 'path' is required for action='write'";
  if (args.content === undefined) return "Error: 'content' is required for action='write'";

  const safe = safeResolvePath(args.path, workspaceCwd);
  if (!safe) return `Error: path '${args.path}' is outside the workspace root`;

  try {
    mkdirSync(dirname(safe), { recursive: true });
    writeFileSync(safe, args.content, "utf-8");
    return `Written ${args.content.length} chars to '${args.path}'`;
  } catch (err) {
    return `Error writing '${args.path}': ${String(err)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action: edit
// ─────────────────────────────────────────────────────────────────────────────

function actionEdit(args: ActionArgs, workspaceCwd: string): string {
  if (!args.path) return "Error: 'path' is required for action='edit'";
  if (args.old_string === undefined) return "Error: 'old_string' is required for action='edit'";
  if (args.new_string === undefined) return "Error: 'new_string' is required for action='edit'";

  const safe = safeResolvePath(args.path, workspaceCwd);
  if (!safe) return `Error: path '${args.path}' is outside the workspace root`;

  let content: string;
  try {
    content = readFileSync(safe, "utf-8");
  } catch (err) {
    return `Error reading '${args.path}': ${String(err)}`;
  }

  if (!content.includes(args.old_string)) {
    return `Error: 'old_string' not found in '${args.path}' — no changes made`;
  }

  // Replace only the first occurrence to match Claude Code behaviour.
  const newContent = content.replace(args.old_string, args.new_string);

  try {
    writeFileSync(safe, newContent, "utf-8");
    return `Replaced 1 occurrence in '${args.path}'`;
  } catch (err) {
    return `Error writing '${args.path}': ${String(err)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Security helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a path relative to workspaceCwd and verify it stays inside the root.
 * Returns null if the resolved path escapes the workspace.
 */
export function safeResolvePath(
  relativePath: string,
  workspaceCwd: string,
): string | null {
  // Reject obviously absolute or home-relative paths before resolve()
  if (relativePath.startsWith("/") || relativePath.startsWith("~")) return null;

  const resolved = resolve(workspaceCwd, relativePath);
  if (resolved !== workspaceCwd && !resolved.startsWith(workspaceCwd + "/")) {
    return null;
  }
  return resolved;
}
