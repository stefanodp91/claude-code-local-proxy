/**
 * fsHooksRepository.ts — user commands that run without asking, and the trust
 * that lets them.
 *
 * A hook is the one thing here whose purpose is to skip the approval modal: run
 * the linter after every write, the tests after every edit. That is also what
 * makes it the most dangerous file in the workspace, because a hook is a line in
 * a file and files are what the model writes.
 *
 * Hence the rule, borrowed from `direnv` because it is the one that survives
 * contact with reality:
 *
 * - Hooks are **inert until trusted once**, with their content shown.
 * - Trust is on the **content**, so any change makes them inert again — the
 *   model's edit, a `git pull`, a colleague's commit.
 * - The trust record lives **outside the workspace**, beside the proxy. Inside
 *   it, the model could write it with `write` and trust its own hooks, and the
 *   whole mechanism would be theatre.
 *
 * The case that makes none of this optional: a repository you clone can ship a
 * `.claudio/hooks.json`. Without trust-on-change it would run on your first
 * edit, and nothing would have asked you anything.
 *
 * @module infrastructure/adapters/fsHooksRepository
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** What a workspace's hooks look like once read. */
export interface HooksStatus {
  /** Whether the workspace has a hooks file at all. */
  configured: boolean;
  /** Whether its current content has been trusted. */
  trusted: boolean;
  /** Set when the file exists but could not be read or parsed. */
  error?: string;
  /** Commands per action name, empty when not configured or unreadable. */
  hooks: Record<string, string[]>;
  /** The file's content, for showing the user what they are trusting. */
  content?: string;
}

export class FsHooksRepository {
  /**
   * @param workspaceRelativeFile Where a workspace declares its hooks.
   * @param trustFile             Absolute path to the trust record, which must
   *                              be outside any workspace.
   */
  constructor(
    private readonly workspaceRelativeFile: string,
    private readonly trustFile: string,
  ) {}

  /** What this workspace has, and whether it may run. Never throws. */
  status(workspaceCwd: string): HooksStatus {
    const empty: HooksStatus = { configured: false, trusted: false, hooks: {} };
    if (!this.workspaceRelativeFile || !this.trustFile) return empty;

    const file = this.resolveInside(workspaceCwd);
    if (!file || !existsSync(file)) return empty;

    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch (err) {
      return { configured: true, trusted: false, hooks: {}, error: String(err) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Hand-written JSON. A typo must not read as "no hooks", or the linter
      // stops running and nobody is told why.
      return {
        configured: true,
        trusted: false,
        hooks: {},
        error: `invalid JSON in ${this.workspaceRelativeFile}`,
        content,
      };
    }

    return {
      configured: true,
      trusted: this.trustedDigest(workspaceCwd) === digest(content),
      hooks: normalise(parsed),
      content,
    };
  }

  /** Commands to run after `action` succeeded, or none when untrusted. */
  forAction(workspaceCwd: string, action: string): string[] {
    const status = this.status(workspaceCwd);
    if (!status.configured || !status.trusted) return [];
    return status.hooks[action] ?? [];
  }

  /** Record the current content as trusted for this workspace. */
  trust(workspaceCwd: string): boolean {
    const status = this.status(workspaceCwd);
    if (!status.configured || status.content === undefined) return false;

    const all = this.readTrustStore();
    all[resolve(workspaceCwd)] = digest(status.content);
    try {
      mkdirSync(dirname(this.trustFile), { recursive: true });
      writeFileSync(this.trustFile, JSON.stringify(all, null, 2) + "\n", "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  /** Forget this workspace's hooks, making them inert again. */
  revoke(workspaceCwd: string): void {
    const all = this.readTrustStore();
    delete all[resolve(workspaceCwd)];
    try {
      writeFileSync(this.trustFile, JSON.stringify(all, null, 2) + "\n", "utf-8");
    } catch { /* best effort — an unwritable store means untrusted, which is safe */ }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private resolveInside(workspaceCwd: string): string | null {
    const full = resolve(workspaceCwd, this.workspaceRelativeFile);
    const rel = relative(resolve(workspaceCwd), full);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return full;
  }

  private trustedDigest(workspaceCwd: string): string | null {
    return this.readTrustStore()[resolve(workspaceCwd)] ?? null;
  }

  private readTrustStore(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.trustFile, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  }
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** `{ "write": ["cmd"] }` or `{ "write": "cmd" }` — both are what people write. */
function normalise(parsed: unknown): Record<string, string[]> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string[]> = {};
  for (const [action, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[action] = [value];
    else if (Array.isArray(value)) out[action] = value.filter((v): v is string => typeof v === "string");
  }
  return out;
}
