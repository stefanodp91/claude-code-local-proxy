/**
 * utils.ts — Pure utility functions for the proxy domain layer.
 *
 * Stateless helpers used across application modules: ID generation
 * and SSE event formatting. These are pure functions with no I/O
 * dependencies (crypto.randomUUID is a Web API, not file/network I/O).
 *
 * For HTTP-specific utilities (Response creation), see
 * infrastructure/httpUtils.ts.
 *
 * @module domain/utils
 */

import { SseEventType } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ID Generation
// ─────────────────────────────────────────────────────────────────────────────

/** Prefix for all proxy-generated message IDs. */
const MSG_ID_PREFIX = "msg_proxy_";

/** Length of the random portion of generated message IDs. */
const MSG_ID_RANDOM_LENGTH = 20;

/**
 * Generate a unique Anthropic-style message ID.
 *
 * Format: "msg_proxy_" + 20 hex characters from a UUID.
 * Used for message_start events and non-streaming responses.
 *
 * @returns A unique message identifier string.
 */
export function msgId(): string {
  return MSG_ID_PREFIX + crypto.randomUUID().replace(/-/g, "").slice(0, MSG_ID_RANDOM_LENGTH);
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a Server-Sent Event (SSE) message.
 *
 * Produces the wire format expected by Anthropic SSE consumers:
 *   event: <eventType>\ndata: <JSON>\n\n
 *
 * @param eventType - The SSE event type (from SseEventType enum).
 * @param data - The event payload, serialized as JSON.
 * @returns Formatted SSE string ready to be sent over the wire.
 */
export function sseEvent(eventType: SseEventType | string, data: any): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}
