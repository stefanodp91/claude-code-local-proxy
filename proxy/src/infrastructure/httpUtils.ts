/**
 * httpUtils.ts — HTTP-specific utility functions.
 *
 * Contains helpers that create HTTP Response objects — an infrastructure
 * concern that belongs outside the domain and application layers.
 *
 * @module infrastructure/httpUtils
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic error type used in all proxy error responses. */
const ANTHROPIC_ERROR_TYPE = "api_error";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a standardized Anthropic-format error Response.
 *
 * Returns a JSON response matching the Anthropic error schema:
 *   { type: "error", error: { type: "api_error", message: "..." } }
 *
 * @param status - HTTP status code.
 * @param message - Human-readable error description.
 * @returns A Response object with the appropriate status and JSON body.
 */
export function anthropicError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: ANTHROPIC_ERROR_TYPE, message },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}
