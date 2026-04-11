/**
 * loggerPort.ts — Logging port.
 *
 * Abstracts structured logging so application and infrastructure code
 * depend on an interface, never on the concrete Logger class. This
 * enables swapping the logging backend without touching business logic.
 *
 * Exported as both `LoggerPort` (new canonical name) and `ILogger`
 * (legacy alias — do not use in new code).
 *
 * @module domain/ports/loggerPort
 */

export interface LoggerPort {
  /** Log an informational message. */
  info(...args: unknown[]): void;

  /** Log a debug message (may be suppressed by configuration). */
  dbg(...args: unknown[]): void;

  /** Log an error message. */
  error(...args: unknown[]): void;
}

/** @deprecated Use `LoggerPort` in new code. */
export type ILogger = LoggerPort;
