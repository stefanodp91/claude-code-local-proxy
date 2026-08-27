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
 *   executeAction() always returns an ActionOutcome: `text` for the model,
 *   plus an optional `image` when the action produced one (today only a
 *   matplotlib figure from action='python').  Callers turn the text into a
 *   tool_result or an <observation>, and hand the image to the model as an
 *   image part — see application/services/actionOutcome.ts.  The image is kept
 *   out of `text` deliberately: its base64 used to *be* the result string, and
 *   an unreadable payload the model pays full price for is worse than no
 *   picture at all.
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
import { spawn } from "node:child_process";
import { resolve, join, relative, dirname, sep } from "node:path";
import { executePythonCode } from "./pythonExecutor";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 50_000;
const MAX_GREP_LINES = 200;
const MAX_GLOB_RESULTS = 500;
const SHELL_TIMEOUT_MS = 15_000;
const BASH_TIMEOUT_MS = 30_000;
const MAX_BASH_OUTPUT = 8_000;

/** Fallbacks when a caller passes no environment — mirror the proxy config. */
const DEFAULT_VENV_DIR = ".claudio/python-venv";
const DEFAULT_PLOT_DIR = ".claudio/plots";

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
// Domain re-exports (for backward compatibility with existing imports)
// ─────────────────────────────────────────────────────────────────────────────
//
// The enums, classification map, tool schema, and ActionArgs shape now live
// in `domain/entities/workspaceAction.ts`. This file re-exports them so that
// consumers currently importing from `infrastructure/workspaceActions` keep
// working. New code should import directly from the domain entity.

export {
  WorkspaceAction,
  ActionClass,
  ACTION_CLASSIFICATION,
  WORKSPACE_TOOL_DEF,
  type ActionArgs,
  type ActionEnv,
  type ActionImage,
  type ActionOutcome,
} from "../domain/entities/workspaceAction";

import {
  WorkspaceAction,
  type ActionArgs,
  type ActionEnv,
  type ActionImage,
  type ActionOutcome,
} from "../domain/entities/workspaceAction";

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
 * Execute a workspace action.
 *
 * @param args         - action name plus action-specific parameters
 * @param workspaceCwd - absolute path to the workspace root
 * @param venvDir      - relative path (from workspaceCwd) to the Python venv;
 *                       only used for action='python'. Defaults to the proxy
 *                       config default `.claudio/python-venv`.
 * @returns            - an {@link ActionOutcome}, never throws. Every failure
 *                       is text the model can act on, not an exception.
 */
export async function executeAction(
  args: ActionArgs,
  workspaceCwd: string,
  env: ActionEnv = {},
): Promise<ActionOutcome> {
  const { venvDir = DEFAULT_VENV_DIR, plotDir = DEFAULT_PLOT_DIR } = env;
  try {
    switch (args.action) {
      case WorkspaceAction.List:
        return { text: actionList(args, workspaceCwd) };
      case WorkspaceAction.Read:
        return { text: actionRead(args, workspaceCwd) };
      case WorkspaceAction.Grep:
        return { text: await actionGrep(args, workspaceCwd) };
      case WorkspaceAction.Glob:
        return { text: actionGlob(args, workspaceCwd) };
      case WorkspaceAction.Write:
        return { text: actionWrite(args, workspaceCwd) };
      case WorkspaceAction.Edit:
        return { text: actionEdit(args, workspaceCwd) };
      case WorkspaceAction.Bash:
        return { text: await actionBash(args, workspaceCwd) };
      case WorkspaceAction.Python: {
        if (!args.cmd) return { text: "Error: 'cmd' is required for action='python'" };
        const result = await executePythonCode(args.cmd, workspaceCwd, venvDir, () => {});
        // A figure comes back instead of stdout, never alongside it — see
        // executePythonCode. It leaves here as an image, not as base64 text.
        if (result.type === "image") {
          const { image, error } = saveFigure(result.data, workspaceCwd, plotDir);
          return {
            text: error ? `Note: the figure could not be saved to '${plotDir}' (${error}).` : "",
            image,
          };
        }
        return { text: result.type === "error" ? `Error: ${result.data}` : result.data };
      }
      default:
        return { text: `Error: unknown action '${args.action}'. Valid actions: ${Object.values(WorkspaceAction).join(", ")}` };
    }
  } catch (err) {
    return { text: `Error executing action '${args.action}': ${String(err)}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Saving a figure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a figure into the workspace and describe it.
 *
 * The attached image is what the *model* sees; a file is what a *person* can
 * open, and the two are only the same picture if the path travels with it. A
 * failure to save is reported in the text and never hides the image: the turn
 * carries on with a picture the model can still read.
 *
 * The write is the output of an action the user has already approved — `python`
 * is destructive and passes the gate — and it is confined to the configured
 * directory under the workspace root, through the same `safeResolvePath()` as
 * every other write.
 */
export function saveFigure(
  data: string,
  workspaceCwd: string,
  plotDir: string,
): { image: ActionImage; error?: string } {
  const image: ActionImage = { media_type: "image/png", data };
  if (!plotDir) return { image };   // saving switched off is a choice, not a fault

  const saved = savePlot(data, workspaceCwd, plotDir);
  if ("relPath" in saved) return { image: { ...image, savedPath: saved.relPath } };
  return { image, error: saved.error };
}

/**
 * Write a base64 image under `plotDir`, returning where it went or why it did
 * not go anywhere.
 *
 * The file name carries a timestamp *and* a counter, because two plots in the
 * same second is the ordinary case — the model draws, looks, and redraws — and
 * a name derived from the clock alone would lose the first one.
 *
 * @returns `{ relPath }` (workspace-relative, forward slashes) or `{ error }`.
 *          Never throws: a lost figure must not cost the turn.
 */
export function savePlot(
  data: string,
  workspaceCwd: string,
  plotDir: string,
): { relPath: string } | { error: string } {
  const dir = safeResolvePath(plotDir, workspaceCwd);
  if (!dir) return { error: `plot directory '${plotDir}' is outside the workspace root` };

  try {
    mkdirSync(dir, { recursive: true });
    const stamp = timestampSlug();
    for (let n = 0; n < 1_000; n++) {
      const name = n === 0 ? `plot-${stamp}.png` : `plot-${stamp}-${n}.png`;
      const full = join(dir, name);
      if (existsSync(full)) continue;
      // 'wx' fails rather than overwrites, so a race loses the name, not a file.
      writeFileSync(full, Buffer.from(data, "base64"), { flag: "wx" });
      return { relPath: `${plotDir.replace(/\/+$/, "")}/${name}` };
    }
    return { error: `could not find a free name in '${plotDir}'` };
  } catch (err) {
    return { error: String(err) };
  }
}

/** `YYYYMMDD-HHMMSS`, local time — it is a file name a person reads. */
function timestampSlug(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
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

async function actionGrep(args: ActionArgs, workspaceCwd: string): Promise<string> {
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

  // Read-only actions are dispatched with Promise.all by the agent loop, which
  // a blocking call quietly turns back into a queue — so this one spawns too.
  const r = await runProcess(cmd, safe, SHELL_TIMEOUT_MS, 2 * 1024 * 1024);
  if (r.timedOut) return `Error running grep: timed out after ${SHELL_TIMEOUT_MS / 1000}s`;
  if (r.error) return `Error running grep: ${r.error}`;
  // grep exits 1 when there are no matches — a valid result, not a failure.
  if (r.code === 1) return "(no matches found)";
  if (r.code !== 0) return `Error running grep: ${r.stderr.trim() || `exit code ${r.code}`}`;
  const output = r.stdout;

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
  //
  // The replacement goes through a function on purpose. Passing the string
  // directly makes `$$`, `$&`, `` $` `` and `$'` inside it *replacement
  // patterns* rather than text: "$$" collapsed to "$", "$&" expanded to the
  // text being replaced, "$'" to everything after it. An edit inserting shell
  // or Makefile source therefore wrote something other than what was asked,
  // reported success, and left no trace. A replacer function is inserted
  // literally.
  const newContent = content.replace(args.old_string, () => args.new_string as string);

  try {
    writeFileSync(safe, newContent, "utf-8");
    return `Replaced 1 occurrence in '${args.path}'`;
  } catch (err) {
    return `Error writing '${args.path}': ${String(err)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action: bash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a shell command in the workspace root and return its output.
 *
 * Security model: the approval gate (invoked by the caller before
 * executeAction) is the authorization boundary.  Here we apply only
 * resource limits: a 30-second timeout, combined stdout+stderr capped
 * at MAX_BASH_OUTPUT, and cwd locked to workspaceCwd.
 */
function actionBash(args: ActionArgs, workspaceCwd: string): Promise<string> {
  if (!args.cmd) return Promise.resolve("Error: 'cmd' is required for action='bash'");
  return runShell(args.cmd, workspaceCwd, BASH_TIMEOUT_MS);
}

/**
 * Run one shell command without blocking the event loop, and describe what
 * happened in the words the model reads.
 *
 * `spawnSync` used to do this, and for up to 30 seconds nothing else in the
 * process ran: not the SSE writes to the client, not the approval gate, not the
 * health probe. Acceptable for a single user, said the note that stood here —
 * until read-only actions started being dispatched in parallel, which a
 * blocking call quietly turns back into a queue.
 *
 * Three things `spawnSync` gave for free have to be done by hand now, and each
 * has a test, because losing one of them is silent:
 *
 * - **The timeout.** `spawn`'s own `timeout` sends a signal; the promise still
 *   has to settle, and a promise that never settles hangs the whole turn. The
 *   kill is timed here and reported as a timeout.
 * - **The cap.** `spawn` has no `maxBuffer`, so unbounded output is this code's
 *   problem: collection stops at the cap rather than growing without limit.
 * - **The exit code**, which arrives on `close` rather than on a result object,
 *   and is `null` when a signal ended the process.
 *
 * @param timeoutMs Parameterised so a test can watch a kill happen in 150 ms
 *                  instead of waiting out the shipped 30 s.
 */
export async function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<string> {
  const r = await runProcess(cmd, cwd, timeoutMs, MAX_BASH_OUTPUT * 2);
  if (r.timedOut) return `Error: command timed out after ${timeoutMs / 1000}s`;
  if (r.error) return `Error: ${r.error}`;
  return formatShellOutput(r.stdout, r.stderr, r.code);
}

/** What a finished process left behind. Never rejects — every end is a result. */
interface ProcessResult {
  stdout: string;
  stderr: string;
  /** Exit code, or `null` when a signal ended it. */
  code: number | null;
  timedOut: boolean;
  /** Set when the process could not be started at all. */
  error?: string;
}

/**
 * Spawn `bash -c cmd` and collect what it produces, bounded in time and size.
 *
 * `collectLimit` stands in for `maxBuffer`, which `spawn` does not have: past
 * it, output is dropped rather than accumulated. It bounds memory only — the
 * text the model sees is capped separately by each caller, so this limit has no
 * observable effect and no test asserts it.
 */
function runProcess(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  collectLimit: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], { cwd });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const collect = (into: "out" | "err") => (chunk: Buffer) => {
      if (stdout.length + stderr.length >= collectLimit) return;
      if (into === "out") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));

    // spawn's own `timeout` signals the child but leaves the promise to settle
    // on its own, and a promise that never settles hangs the turn.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (r: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    child.on("error", (err) =>
      finish({ stdout, stderr, code: null, timedOut, error: String(err) }));
    child.on("close", (code) => finish({ stdout, stderr, code, timedOut }));
  });
}

/** stdout first, stderr labelled, exit code appended, the whole thing capped. */
function formatShellOutput(rawOut: string, rawErr: string, code: number | null): string {
  const stdout = rawOut.trimEnd();
  const stderr = rawErr.trimEnd();

  let output = stdout;
  if (stderr) {
    output += (output ? "\n\n[stderr]\n" : "[stderr]\n") + stderr;
  }
  if (!output) {
    output = code !== 0 ? `(no output, exit code ${code ?? "?"})` : "(no output)";
  } else if (code !== 0 && code !== null) {
    output += `\n\n[exit code: ${code}]`;
  }

  if (output.length > MAX_BASH_OUTPUT) {
    output = output.slice(0, MAX_BASH_OUTPUT) + `\n\n[output truncated at ${MAX_BASH_OUTPUT} chars]`;
  }
  return output;
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

  // Normalise the root first. The comparison below appends a separator, so a
  // root arriving with a trailing slash (from the X-Workspace-Root header) was
  // compared against "/ws//" and every path in the workspace read as an escape:
  // total failure, reported as "outside the workspace root".
  const root = resolve(workspaceCwd);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }
  return resolved;
}
