/**
 * clockPort.ts — Port for time access.
 *
 * Wraps `Date.now()` behind an interface so time-dependent logic can be
 * tested with a fake clock. Used by `FsPlanFileRepository.loadMostRecent`
 * to compute the human-readable "2 minutes ago" stamp.
 *
 * @module domain/ports/clockPort
 */

export interface ClockPort {
  /** Returns the current time as Unix milliseconds since epoch. */
  now(): number;
}
