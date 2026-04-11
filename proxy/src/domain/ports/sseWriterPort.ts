/**
 * sseWriterPort.ts — Port for writing SSE frames to the client.
 *
 * Abstracts the details of Node's `ServerResponse`. Application code
 * depends on this interface to emit streaming events; the concrete adapter
 * (`NodeSseWriter`) wraps ServerResponse in `infrastructure/adapters/`.
 *
 * @module domain/ports/sseWriterPort
 */

/**
 * Writes Server-Sent Events to a single client connection.
 *
 * Implementations MUST be idempotent on `writeHeaders()` — multiple calls
 * should only send the HTTP headers once.
 */
export interface SseWriterPort {
  /** Send the HTTP headers required for an SSE stream. No-op if already sent. */
  writeHeaders(): void;

  /**
   * Write a raw SSE frame to the client. The frame must be pre-formatted
   * with `event:` / `data:` / `\n\n` — this port does NOT do formatting.
   * Implementations should call `writeHeaders()` automatically on first write.
   */
  writeRaw(frame: string): void;

  /** Close the stream. Subsequent writes are no-ops. */
  end(): void;

  /** True when the underlying transport is closed (client disconnected or end() was called). */
  readonly isClosed: boolean;
}
