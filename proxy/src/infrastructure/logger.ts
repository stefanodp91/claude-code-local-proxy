/**
 * logger.ts — Structured logging for the Anthropic-to-OpenAI proxy.
 *
 * Provides a Logger class that implements the ILogger port interface.
 * Debug messages are suppressed unless the debug flag is enabled.
 * All output goes to stderr to avoid interfering with stdout streams.
 *
 * @module infrastructure/logger
 */

import { LogLevel } from "../domain/types.ts";
import type { ILogger } from "../domain/ports.ts";

/**
 * Structured logger with debug gating.
 *
 * Implements the ILogger port so that application-layer code can
 * depend on the interface rather than this concrete class.
 *
 * All messages are written to stderr with ISO-8601 timestamps
 * and level prefixes: `[2026-04-01T21:48:11.606Z] [info] ...`
 *
 * @example
 * const logger = new Logger(true);  // debug enabled
 * logger.info("Server started on port", 5678);
 * logger.dbg("SSE chunk received:", rawData);  // only if debug=true
 * logger.error("Connection failed:", err);
 */
export class Logger implements ILogger {
  /**
   * @param debugEnabled - When false, calls to dbg() are silently dropped.
   */
  constructor(private readonly debugEnabled: boolean) {}

  /**
   * Emit a log message at the specified level.
   *
   * @param level - Severity level (info, debug, error).
   * @param args - Values to log (formatted by console.error).
   */
  log(level: LogLevel, ...args: unknown[]): void {
    if (level === LogLevel.Debug && !this.debugEnabled) return;
    const ts = new Date().toISOString();
    console.error(`[${ts}] [${level}]`, ...args);
  }

  /** Log an informational message. */
  info(...args: unknown[]): void {
    this.log(LogLevel.Info, ...args);
  }

  /** Log a debug message (suppressed when debug is disabled). */
  dbg(...args: unknown[]): void {
    this.log(LogLevel.Debug, ...args);
  }

  /** Log an error message. */
  error(...args: unknown[]): void {
    this.log(LogLevel.Error, ...args);
  }
}
