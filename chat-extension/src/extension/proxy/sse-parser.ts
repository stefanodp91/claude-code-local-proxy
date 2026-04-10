/**
 * sse-parser.ts — Server-Sent Events stream parser.
 *
 * Parses raw SSE text chunks into structured events.
 * Handles partial chunks by buffering incomplete lines.
 *
 * @module extension/proxy
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = "";

  /**
   * Feed a raw text chunk and extract complete SSE events.
   *
   * @param chunk - Raw text from the SSE stream.
   * @returns Array of parsed SSE events.
   */
  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    const blocks = this.buffer.split("\n\n");
    // Last element may be incomplete — keep it in the buffer
    this.buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const event = parseBlock(block);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Flush any remaining buffer content.
   */
  flush(): SseEvent[] {
    if (!this.buffer.trim()) {
      return [];
    }
    const event = parseBlock(this.buffer);
    this.buffer = "";
    return event ? [event] : [];
  }
}

function parseBlock(block: string): SseEvent | null {
  let eventType = "";
  let data = "";

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event: ")) {
      eventType = trimmed.slice(7);
    } else if (trimmed.startsWith("data: ")) {
      data = trimmed.slice(6);
    }
  }

  if (!eventType && !data) {
    return null;
  }

  return { event: eventType, data };
}
