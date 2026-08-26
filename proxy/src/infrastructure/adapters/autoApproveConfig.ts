/**
 * autoApproveConfig.ts — Infrastructure adapter for the static auto-approve allowlist.
 *
 * Reads `.claudio/auto-approve.json` from the workspace and exposes two
 * pure functions that `ApprovalGateService` receives as callback ports:
 *
 *   `loadOldContent`  — read a write target's current content for diff preview
 *   `checkAutoApprove` — match action+args against the allowlist rules
 *
 * These functions are the only place in the codebase that touch `node:fs`
 * for approval-related I/O. They are passed as lambdas from the composition
 * root (`server.ts`) so the application layer stays filesystem-agnostic.
 *
 * @module infrastructure/adapters/autoApproveConfig
 */

import { isAbsolute, join, relative, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { WorkspaceAction, type ActionArgs } from "../../domain/entities/workspaceAction";

interface AutoApproveRule {
  action: string;
  pathPattern?: string;
  cmdPattern?: string;
}

interface AutoApproveConfig {
  rules: AutoApproveRule[];
}

/**
 * Read the current on-disk content of a `write` target so the approval
 * modal can render a diff preview. Returns null for non-write actions or
 * when the file does not exist yet (client renders "all added" lines).
 * Content is truncated to 50 KB to avoid huge payloads.
 */
export function loadOldContent(
  action: string,
  args: ActionArgs,
  workspaceCwd: string | undefined,
): string | null {
  if (action !== WorkspaceAction.Write || typeof args.path !== "string" || !workspaceCwd) {
    return null;
  }
  try {
    const full = resolve(workspaceCwd, args.path);
    if (!isInside(workspaceCwd, full) || !existsSync(full)) return null;
    let contents = readFileSync(full, "utf-8");
    if (contents.length > 50_000) contents = contents.slice(0, 50_000) + "\n…[truncated]";
    return contents;
  } catch {
    return null;
  }
}

/**
 * Returns true if the action+args pair matches any rule in
 * `<workspaceCwd>/.claudio/auto-approve.json`.
 * Silently returns false on any read/parse error.
 */
export function checkAutoApprove(action: string, args: ActionArgs, workspaceCwd: string): boolean {
  const configPath = join(workspaceCwd, ".claudio", "auto-approve.json");
  if (!existsSync(configPath)) return false;
  let cfg: AutoApproveConfig;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf-8")) as AutoApproveConfig;
  } catch {
    return false;
  }
  for (const rule of cfg.rules ?? []) {
    if (rule.action !== action) continue;
    if (rule.pathPattern !== undefined && !matches(rule.pathPattern, args.path)) continue;
    if (rule.cmdPattern  !== undefined && !matches(rule.cmdPattern,  args.cmd))  continue;
    return true;
  }
  return false;
}

/**
 * Test one rule pattern against one argument, failing closed on anything that
 * cannot be decided.
 *
 * Both of those cases used to read as "constraint satisfied", because the guards
 * were written as `pattern && value && !test(value)`:
 *
 * - **The argument is absent.** A `pathPattern` written against `bash`, which
 *   carries a command and never a path, short-circuited to a match — turning
 *   "only under scripts/" into every shell command approved without asking. The
 *   plausible config mistake produced the opposite of what it said, in the one
 *   file whose job is to be restrictive.
 * - **The pattern does not compile.** `new RegExp()` sat outside the try that
 *   covers the read and the parse, so a typo threw through the approval gate and
 *   took the turn down, despite this function documenting that it fails quietly.
 *
 * A rule that states no pattern at all still matches everything for its action:
 * that is an explicit blanket, and deliberate.
 */
function matches(pattern: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

/**
 * True when `fullPath` lies inside `root`. `startsWith(root)` is not a
 * containment test — for a workspace at `/ws` it also accepts the sibling
 * `/ws-evil` — and here that decided whether a file outside the workspace could
 * be read into the approval modal. Mirrors the check in `ApprovalGateService`.
 */
function isInside(root: string, fullPath: string): boolean {
  const rel = relative(resolve(root), fullPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
