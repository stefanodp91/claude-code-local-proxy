/**
 * main.ts — Bootstrap entry point for the Anthropic-to-OpenAI proxy.
 *
 * Composition root: loads configuration, creates the server,
 * initializes async services, and starts listening.
 *
 * Usage:
 *   cd proxy && npm run dev
 *
 * @module main
 */

import { loadConfig } from "./infrastructure/config";
import { ProxyServer } from "./infrastructure/server";

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const proxy = new ProxyServer(config);
  await proxy.initialize();      // locale + model info (fast)
  await proxy.initializeTools(); // tool probe or cache hit + wire translators
  proxy.start();                 // HTTP server ready — translators already wired
}

main().catch((err) => {
  console.error("Fatal error during proxy startup:", err);
  process.exit(1);
});
