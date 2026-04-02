/**
 * ports.ts — Port interfaces for the Anthropic-to-OpenAI proxy.
 *
 * Defines abstract contracts (ports) that infrastructure adapters implement.
 * Application-layer code depends on these interfaces, never on concrete
 * implementations — enforcing the Dependency Inversion Principle (DIP).
 *
 * @module domain/ports
 */

// ─────────────────────────────────────────────────────────────────────────────
// Logging Port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Port interface for structured logging.
 *
 * Application and infrastructure code depends on this interface
 * rather than the concrete Logger class. This allows swapping
 * the logging implementation without touching business logic.
 */
export interface ILogger {
  /** Log an informational message. */
  info(...args: unknown[]): void;

  /** Log a debug message (may be suppressed by configuration). */
  dbg(...args: unknown[]): void;

  /** Log an error message. */
  error(...args: unknown[]): void;
}
