/**
 * i18nLoader.ts — Locale file loader for the proxy i18n system.
 *
 * Reads locale JSON files from disk using Bun.file() and populates
 * the domain i18n module's message map via setMessages().
 *
 * This is the infrastructure adapter for i18n — the only place
 * where file I/O occurs for translation loading.
 *
 * @module infrastructure/i18nLoader
 */

import { Locale } from "../domain/types";
import { setMessages } from "../domain/i18n";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load locale messages from the locales/ directory.
 *
 * Reads `locales/<locale>.json` relative to the project root and
 * populates the i18n module's internal message map.
 * Falls back to Locale.EnUS if the requested locale file is not found.
 * Must be called once during startup before any t() calls.
 *
 * @param locale - A value from the Locale enum (e.g., Locale.EnUS).
 */
export async function loadLocale(locale: Locale): Promise<void> {
  // import.meta.dir resolves to this file's directory (src/infrastructure/)
  // locales/ is at ../../locales/ relative to here
  const localesDir = `${import.meta.dir}/../../locales`;
  const path = `${localesDir}/${locale}.json`;

  try {
    const file = Bun.file(path);
    const msgs = await file.json();
    setMessages(msgs);
  } catch {
    // Fallback to default locale if the requested one is missing
    if (locale !== Locale.EnUS) {
      const fallbackPath = `${localesDir}/${Locale.EnUS}.json`;
      try {
        const msgs = await Bun.file(fallbackPath).json();
        setMessages(msgs);
      } catch {
        // No locale files available — t() will return raw keys
        setMessages({});
      }
    }
  }
}
