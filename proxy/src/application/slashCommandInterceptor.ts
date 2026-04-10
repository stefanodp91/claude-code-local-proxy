/**
 * slashCommandInterceptor.ts — Slash command registry and interceptor.
 *
 * Intercepts slash commands (e.g. /commit, /status) from incoming Anthropic
 * requests before they reach the LLM, handling them with:
 * - 'synthetic': immediate SSE response without calling the LLM
 * - 'enrich': replaces the message content with an enriched prompt, then proceeds normally
 * - 'passthrough': not a handled slash command, continues normally
 *
 * @module application/slashCommandInterceptor
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { AnthropicRequest } from "../domain/types";

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SlashCommand {
  name: string;
  descriptionKey: string; // i18n key used by the plugin (slash.commands.*)
  handler: "proxy" | "client";
}

export type InterceptResult =
  | { type: "synthetic"; text: string }    // immediate response, no LLM call
  | { type: "enrich"; newContent: string } // replace last message, then call LLM
  | { type: "passthrough" };               // not handled by proxy

// ─────────────────────────────────────────────────────────────────────────────
// Registry — source of truth for all clients
// ─────────────────────────────────────────────────────────────────────────────

/** Centralised list of available slash commands, served via GET /commands. */
export const SLASH_COMMAND_REGISTRY: SlashCommand[] = [
  { name: "/status",         descriptionKey: "slash.commands.status",         handler: "proxy"  },
  { name: "/version",        descriptionKey: "slash.commands.version",         handler: "proxy"  },
  { name: "/commit",         descriptionKey: "slash.commands.commit",          handler: "proxy"  },
  { name: "/diff",           descriptionKey: "slash.commands.diff",            handler: "proxy"  },
  { name: "/review",         descriptionKey: "slash.commands.review",          handler: "proxy"  },
  { name: "/compact",        descriptionKey: "slash.commands.compact",         handler: "proxy"  },
  { name: "/brief",          descriptionKey: "slash.commands.brief",           handler: "proxy"  },
  { name: "/plan",           descriptionKey: "slash.commands.plan",            handler: "proxy"  },
  { name: "/copy",           descriptionKey: "slash.commands.copy",            handler: "client" },
  { name: "/files",          descriptionKey: "slash.commands.files",           handler: "client" },
  { name: "/simplify",       descriptionKey: "slash.commands.simplify",        handler: "client" },
  { name: "/branch",         descriptionKey: "slash.commands.branch",          handler: "client" },
  { name: "/commit-push-pr", descriptionKey: "slash.commands.commit-push-pr",  handler: "client" },
  { name: "/pr-comments",    descriptionKey: "slash.commands.pr-comments",     handler: "client" },
  { name: "/clear",          descriptionKey: "slash.commands.clear",           handler: "client" },
];

const PROXY_COMMANDS = new Set(
  SLASH_COMMAND_REGISTRY.filter(c => c.handler === "proxy").map(c => c.name),
);

/**
 * Anthropic-specific commands that must never be forwarded to a local LLM.
 * When intercepted, the proxy returns an explanatory message.
 */
const ANTHROPIC_BLOCKED_COMMANDS = new Set([
  "/login", "/logout", "/upgrade", "/usage", "/extra-usage",
  "/cost", "/feedback", "/stickers", "/mobile", "/rate-limit-options",
  "/privacy-settings", "/install-github-app", "/install-slack-app",
  "/desktop", "/chrome", "/thinkback", "/thinkback-play",
  "/session", "/share", "/remote-control", "/remote-env",
  "/teleport", "/heapdump", "/install", "/web-setup",
]);

// ─────────────────────────────────────────────────────────────────────────────
// SlashCommandInterceptor
// ─────────────────────────────────────────────────────────────────────────────

export class SlashCommandInterceptor {
  /**
   * Inspect the last user message in the request. If it is a slash command,
   * return the appropriate InterceptResult; otherwise return 'passthrough'.
   *
   * @param workspaceCwd - Workspace root supplied by the client via X-Workspace-Root header.
   *                       Falls back to process.cwd() when absent.
   */
  async intercept(request: AnthropicRequest, workspaceCwd?: string): Promise<InterceptResult> {
    const lastMsg = request.messages.at(-1);
    if (!lastMsg || lastMsg.role !== "user") return { type: "passthrough" };

    const raw: string =
      typeof lastMsg.content === "string"
        ? lastMsg.content
        : (lastMsg.content?.[0]?.text as string | undefined) ?? "";

    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return { type: "passthrough" };

    const command = trimmed.split(" ")[0].toLowerCase();

    // Block Anthropic-specific commands before touching the LLM
    if (ANTHROPIC_BLOCKED_COMMANDS.has(command)) {
      return {
        type: "synthetic",
        text: `> **\`${command}\`** is specific to Anthropic/Claude and is not available with local LLM proxies.`,
      };
    }

    if (!PROXY_COMMANDS.has(command)) return { type: "passthrough" };

    const cwd = workspaceCwd ?? process.cwd();
    return this.execute(command, cwd);
  }

  // ── Command implementations ─────────────────────────────────────────────

  private async execute(command: string, cwd: string): Promise<InterceptResult> {
    switch (command) {

      case "/status": {
        const { version } = require("../../package.json") as { version: string };
        const lines = [
          "## Proxy Status",
          `- **Proxy version:** ${version}`,
          `- **Target URL:** ${process.env["TARGET_URL"] ?? "http://localhost:1234/v1/chat/completions"}`,
          `- **Port:** ${process.env["PROXY_PORT"] ?? "5678"}`,
          `- **Node.js:** ${process.version}`,
          `- **Working dir:** ${cwd}`,
        ];
        return { type: "synthetic", text: lines.join("\n") };
      }

      case "/version": {
        const { version } = require("../../package.json") as { version: string };
        return { type: "synthetic", text: `**Anthropic-to-OpenAI Proxy** v${version}` };
      }

      case "/commit": {
        const diff = await this.git("diff --staged", cwd);
        if (!diff) return { type: "synthetic", text: "No staged changes. Run `git add <file>` first." };
        const log = await this.git("log --oneline -5", cwd);
        return {
          type: "enrich",
          newContent:
            `Staged diff:\n\`\`\`\n${diff}\n\`\`\`\n` +
            (log ? `\nRecent commits:\n\`\`\`\n${log}\n\`\`\`\n` : "") +
            `\nWrite a concise conventional commit message for these changes.`,
        };
      }

      case "/diff": {
        const diff = await this.git("diff HEAD", cwd);
        if (!diff) return { type: "synthetic", text: "No uncommitted changes found." };
        return { type: "enrich", newContent: `Current git diff:\n\`\`\`\n${diff}\n\`\`\`\n\nExplain these changes clearly and concisely.` };
      }

      case "/review": {
        const diff =
          await this.git("diff main...HEAD", cwd) ??
          await this.git("diff master...HEAD", cwd);
        if (!diff) return { type: "synthetic", text: "No changes found vs main/master branch." };
        return { type: "enrich", newContent: `Diff vs main branch:\n\`\`\`\n${diff}\n\`\`\`\n\nReview these changes: identify issues, suggest improvements.` };
      }

      case "/compact":
        return { type: "enrich", newContent: "Summarize our conversation so far in one concise paragraph, capturing the key points and decisions." };

      case "/brief":
        return { type: "enrich", newContent: "From now on in this conversation, respond briefly — maximum 3 sentences per answer unless explicitly asked for more detail." };

      case "/plan":
        return { type: "enrich", newContent: "Think step by step before giving your next answer. Show your reasoning process." };

      default:
        return { type: "passthrough" };
    }
  }

  /** Run a git command, return trimmed stdout or null on failure/empty output. */
  private async git(args: string, cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`git ${args}`, { cwd });
      const out = stdout.trim();
      return out || null;
    } catch {
      return null;
    }
  }
}
