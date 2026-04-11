/**
 * nodeSseWriter.ts — Infrastructure adapter for SSE output.
 *
 * Implements `SseWriterPort` by wrapping a Node.js `ServerResponse`.
 * This is the only place in the codebase that calls `res.writeHead` and
 * `res.write` for SSE streams. All application-layer code writes frames
 * through `SseWriterPort` and never touches `ServerResponse` directly.
 *
 * @module infrastructure/adapters/nodeSseWriter
 */

import type { ServerResponse } from "node:http";
import type { SseWriterPort } from "../../domain/ports";

const SSE_HEADERS = {
  "Content-Type":  "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection":    "keep-alive",
} as const;

/**
 * SSE writer backed by a Node.js `ServerResponse`.
 *
 * Headers are sent lazily on the first `writeRaw()` call (or eagerly via
 * `writeHeaders()`). Subsequent calls to `writeHeaders()` are no-ops.
 */
export class NodeSseWriter implements SseWriterPort {
  private headersSent = false;

  constructor(private readonly res: ServerResponse) {}

  writeHeaders(): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.res.writeHead(200, SSE_HEADERS);
  }

  writeRaw(frame: string): void {
    if (!this.headersSent) this.writeHeaders();
    this.res.write(frame);
  }

  end(): void {
    this.res.end();
  }

  get isClosed(): boolean {
    return this.res.writableEnded || this.res.destroyed;
  }
}
