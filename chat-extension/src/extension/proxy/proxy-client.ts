/**
 * proxy-client.ts — HTTP client for the Anthropic-to-OpenAI proxy.
 *
 * Sends Anthropic Messages API requests and streams SSE responses
 * as an AsyncGenerator of parsed SSE events.
 *
 * @module extension/proxy
 */

import { SseParser, type SseEvent } from "./sse-parser";
import type { ConversationMessage } from "../models/chat-message.model";
import type { ChatConfig } from "../config/extension-config";
import type { SlashCommand, ApprovalScope } from "../../shared/message-protocol";

export interface ProxyRequest {
  messages: ConversationMessage[];
  config: ChatConfig;
  workspaceRoot?: string;
  planExitPath?: string | null;
}

export class ProxyClient {
  private abortController: AbortController | null = null;

  constructor(private baseUrl: string) {}

  updateBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  /**
   * Send a message to the proxy and yield SSE events as they arrive.
   * Passes X-Workspace-Root header so the proxy can run git commands
   * in the correct working directory.
   */
  async *sendMessage(request: ProxyRequest): AsyncGenerator<SseEvent> {
    this.abortController = new AbortController();

    const { messages, config, workspaceRoot, planExitPath } = request;

    const body: Record<string, any> = {
      model: "default",
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      stream: true,
    };

    if (config.systemPrompt) {
      body.system = config.systemPrompt;
    }

    // Enable thinking/reasoning blocks if the model supports them.
    // The proxy translates reasoning_content → thinking_delta only when this flag is set.
    if (config.enableThinking) {
      body.thinking = { type: "enabled" };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (workspaceRoot) {
      headers["x-workspace-root"] = workspaceRoot;
    }
    if (planExitPath) {
      headers["x-plan-exit-path"] = planExitPath;
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      throw new Error(`Proxy returned ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error("No response body from proxy");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush remaining buffer
          for (const evt of parser.flush()) {
            yield evt;
          }
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        for (const evt of parser.feed(chunk)) {
          yield evt;
        }
      }
    } finally {
      reader.releaseLock();
      this.abortController = null;
    }
  }

  /**
   * Execute a Python code snippet on the proxy and yield SSE events.
   * The proxy emits `progress` events (phase: string) followed by a
   * `result` event ({ type: "text"|"image"|"error", data: string }).
   *
   * No approval gate — the user explicitly clicked Run.
   */
  async *execPython(
    code: string,
    workspaceCwd: string,
  ): AsyncGenerator<SseEvent> {
    const res = await fetch(`${this.baseUrl}/v1/exec-python`, {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        "x-workspace-root": workspaceCwd,
      },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      throw new Error(`Proxy exec-python failed ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error("No response body from proxy exec-python");
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    const parser  = new SseParser();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          for (const evt of parser.flush()) yield evt;
          break;
        }
        for (const evt of parser.feed(decoder.decode(value, { stream: true }))) {
          yield evt;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Fetch the list of available slash commands from the proxy registry.
   * Returns an empty array if the proxy is unreachable or does not support the endpoint.
   */
  async fetchCommands(): Promise<SlashCommand[]> {
    try {
      const res = await fetch(`${this.baseUrl}/commands`);
      if (!res.ok) return [];
      const data = await res.json() as { commands?: SlashCommand[] };
      return data.commands ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Respond to a tool_request_pending approval gate at the proxy.
   * Called after the user approves or denies the action in the UI.
   *
   * @param scope - `"once"` (default) approves only this action; `"turn"`
   *                approves all destructive actions until the turn ends;
   *                `"file"` also remembers the path in the proxy's trustedFiles.
   */
  async approve(requestId: string, approved: boolean, scope: ApprovalScope = "once"): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/v1/messages/${requestId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, scope }),
      });
    } catch {
      // If the request fails the proxy will auto-deny on timeout — nothing more to do.
    }
  }

  /**
   * Set agent mode on the proxy (POST /agent-mode).
   * Returns the confirmed mode from the proxy, or undefined if the request fails.
   */
  async setAgentMode(mode: "ask" | "auto" | "plan"): Promise<"ask" | "auto" | "plan" | undefined> {
    try {
      const res = await fetch(`${this.baseUrl}/agent-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) return undefined;
      const data = await res.json() as { mode: "ask" | "auto" | "plan" };
      return data.mode;
    } catch {
      return undefined;
    }
  }

  /**
   * Cancel an in-progress stream.
   */
  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
