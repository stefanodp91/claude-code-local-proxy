/**
 * main.ts — Bootstrap entry point for the Anthropic-to-OpenAI proxy.
 *
 * Composition root: loads configuration, creates the server,
 * initializes async services, and starts listening.
 *
 * Usage:
 *   cd proxy && bun run src/main.ts
 *
 * @module main
 */

import { loadConfig } from "./infrastructure/config";
import { ProxyServer } from "./infrastructure/server";

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

const config = loadConfig();
const proxy = new ProxyServer(config);
await proxy.initialize();   // locale + model info (fast)
proxy.start();               // HTTP server + /health available immediately
await proxy.initializeTools(); // tool probe + wire translators (may be slow)
