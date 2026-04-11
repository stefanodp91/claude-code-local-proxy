/**
 * fetchLlmClient.ts — Infrastructure adapter for the LLM backend.
 *
 * Implements `LlmClientPort` using the global `fetch()` function. This is the
 * only place in the codebase that directly calls `fetch` for chat completions
 * and model probing. Application-layer code depends on `LlmClientPort` and
 * never imports this file directly.
 *
 * @module infrastructure/adapters/fetchLlmClient
 */

import type { LlmClientPort, LlmChatRequest, LlmChatResponse } from "../../domain/ports";

/**
 * HTTP adapter that forwards chat requests to an OpenAI-compatible endpoint
 * (LM Studio, OpenAI, OpenRouter, etc.) via the global `fetch` API.
 */
export class FetchLlmClient implements LlmClientPort {
  constructor(private readonly targetUrl: string) {}

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    try {
      const res = await fetch(this.targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...req.body, stream: req.stream }),
      });
      if (!res.ok) {
        return { ok: false, status: res.status, errorText: await res.text().catch(() => "") };
      }
      if (req.stream) {
        return { ok: true, status: res.status, body: res.body };
      }
      return { ok: true, status: res.status, json: await res.json() };
    } catch (err) {
      return { ok: false, status: 0, errorText: String(err) };
    }
  }

  async ping(): Promise<boolean> {
    try {
      const modelsUrl = this.targetUrl.replace(/\/v1\/chat\/completions$/, "/v1/models");
      const res = await fetch(modelsUrl, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
