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

import { resolve, join } from "node:path";
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
    if (!full.startsWith(workspaceCwd) || !existsSync(full)) return null;
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
    if (rule.pathPattern && args.path && !new RegExp(rule.pathPattern).test(args.path)) continue;
    if (rule.cmdPattern  && args.cmd  && !new RegExp(rule.cmdPattern).test(args.cmd))   continue;
    return true;
  }
  return false;
}
