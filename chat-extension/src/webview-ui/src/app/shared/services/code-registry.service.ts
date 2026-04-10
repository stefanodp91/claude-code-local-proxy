import { Injectable } from "@angular/core";

/**
 * Maps short UUIDs to Python code strings.
 * Lets the markdown pipe store code server-side (in memory) and only
 * embed a small UUID in the rendered HTML attribute, avoiding any
 * HTML attribute encoding / length issues.
 */
@Injectable({ providedIn: "root" })
export class CodeRegistryService {
  private readonly registry = new Map<string, string>();

  register(code: string): string {
    // Stable hash: same code → same ID → markdown pipe can stay pure
    let h = 0;
    for (let i = 0; i < code.length; i++) {
      h = Math.imul(31, h) + code.charCodeAt(i) | 0;
    }
    const id = `cr_${(h >>> 0).toString(36)}`;
    this.registry.set(id, code);
    return id;
  }

  get(id: string): string | undefined {
    return this.registry.get(id);
  }
}
