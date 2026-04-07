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
await proxy.initialize();      // locale + model info (fast)
await proxy.initializeTools(); // tool probe or cache hit + wire translators
proxy.start();                 // HTTP server ready — translators already wired
