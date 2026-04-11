/**
 * llmClientPort.ts — Port for the LLM backend client.
 *
 * Abstracts the HTTP communication with an OpenAI-compatible chat completions
 * endpoint (LM Studio, OpenAI, OpenRouter, etc.). Application code never
 * imports `fetch` directly — it depends on this interface. The concrete
 * implementation lives in `infrastructure/adapters/fetchLlmClient.ts`.
 *
 * @module domain/ports/llmClientPort
 */

/** A chat request dispatched to the LLM backend. */
export interface LlmChatRequest {
  /**
   * Already-translated OpenAI request body. The translation from Anthropic
   * format happens upstream in RequestTranslator. This port does NOT know
   * about Anthropic. Typed as `any` because the body is an opaque JSON
   * payload that the adapter serializes verbatim.
   */
  body: any;

  /** When true, expects a streaming SSE response; otherwise a single JSON body. */
  stream: boolean;
}

/** Result of a chat request — streaming or one-shot. */
export interface LlmChatResponse {
  /** True when the backend returned a 2xx response. */
  ok: boolean;

  /** HTTP status code. `0` if the request failed before receiving a response. */
  status: number;

  /** Parsed JSON body when `stream === false`. Undefined otherwise. */
  json?: any;

  /** Raw SSE stream when `stream === true`. Undefined otherwise. */
  body?: ReadableStream<Uint8Array> | null;

  /** Error text when `ok === false`. */
  errorText?: string;
}

/**
 * Port for sending chat requests to the LLM backend.
 *
 * Implementors (adapters) are free to use fetch, axios, grpc — anything.
 * The application layer knows only this interface.
 */
export interface LlmClientPort {
  /** Send a chat request. Returns either a parsed JSON or a streaming body. */
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;

  /**
   * Lightweight liveness probe used by the proxy's background reachability
   * check. Implementors should use a cheap GET (e.g., `/v1/models`) rather
   * than a full chat request.
   */
  ping(): Promise<boolean>;
}
