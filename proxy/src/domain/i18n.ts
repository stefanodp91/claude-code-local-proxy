/**
 * i18n.ts — Pure internationalization lookup for the proxy.
 *
 * Provides the t() translation function and message state management.
 * This module contains no I/O — the locale loading (Bun.file) lives
 * in infrastructure/i18nLoader.ts, which calls setMessages() to
 * populate the internal map.
 *
 * @module domain/i18n
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Flat key-value map of translated messages. */
type Messages = Record<string, string>;

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** Currently loaded message map. Empty until setMessages() is called. */
let messages: Messages = {};

/** Regex for matching {{paramName}} interpolation tokens. */
const INTERPOLATION_PATTERN = /\{\{(\w+)\}\}/g;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace the internal message map.
 *
 * Called by infrastructure/i18nLoader.ts after reading the locale JSON
 * from disk. This is the "inbound port" that bridges I/O and pure lookup.
 *
 * @param msgs - Flat key-value map loaded from a locale JSON file.
 */
export function setMessages(msgs: Messages): void {
  messages = msgs;
}

/**
 * Translate a message key with optional parameter interpolation.
 *
 * Parameters in the locale string use `{{paramName}}` syntax.
 * If the key is not found, the raw key string is returned as-is
 * (makes missing translations visible rather than silently failing).
 *
 * @param key - Dot-separated message key (e.g., "probe.detected").
 * @param params - Optional map of parameter values to interpolate.
 * @returns The translated and interpolated string.
 *
 * @example
 * t("probe.detected", { max: 7 })
 * // With en_US.json: "Max tools detected: {{max}}"
 * // Returns: "Max tools detected: 7"
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let msg = messages[key] ?? key;
  if (params) {
    msg = msg.replace(INTERPOLATION_PATTERN, (_, paramName) => {
      const value = params[paramName];
      return value !== undefined ? String(value) : `{{${paramName}}}`;
    });
  }
  return msg;
}
