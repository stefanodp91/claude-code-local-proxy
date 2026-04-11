/**
 * systemClock.ts — Real-time ClockPort implementation.
 *
 * Production adapter backed by `Date.now()`. Tests can substitute a
 * fixed-time mock that implements the same `ClockPort` interface.
 *
 * @module infrastructure/adapters/systemClock
 */

import type { ClockPort } from "../../domain/ports";

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }
}
