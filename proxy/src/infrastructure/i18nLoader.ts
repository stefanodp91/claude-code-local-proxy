/**
 * i18nLoader.ts — Locale file loader for the proxy i18n system.
 *
 * Reads locale JSON files from disk using Node.js fs and populates
 * the domain i18n module's message map via setMessages().
 *
 * This is the infrastructure adapter for i18n — the only place
 * where file I/O occurs for translation loading.
 *
 * @module infrastructure/i18nLoader
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Locale } from "../domain/types";
import { setMessages } from "../domain/i18n";

// ─────────────────────────────────────────────────────────────────────────────
// Module directory resolution
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  const localesDir = resolve(__dirname, "../../locales");
  const path = `${localesDir}/${locale}.json`;

  try {
    const content = await readFile(path, "utf-8");
    const msgs = JSON.parse(content);
    setMessages(msgs);
  } catch {
    // Fallback to default locale if the requested one is missing
    if (locale !== Locale.EnUS) {
      const fallbackPath = `${localesDir}/${Locale.EnUS}.json`;
      try {
        const content = await readFile(fallbackPath, "utf-8");
        const msgs = JSON.parse(content);
        setMessages(msgs);
      } catch {
        // No locale files available — t() will return raw keys
        setMessages({});
      }
    }
  }
}
