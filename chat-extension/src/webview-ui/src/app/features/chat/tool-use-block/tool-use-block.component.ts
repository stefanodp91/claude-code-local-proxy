import { Component, Input } from "@angular/core";
import { CommonModule } from "@angular/common";
import type { ToolUseBlock } from "../../../core/models/content-block.model";

const ACTION_ICONS: Record<string, string> = {
  list: "📂",
  read: "📄",
  grep: "🔍",
  glob: "🌐",
  write: "✏️",
  edit:  "✏️",
  bash:  "⚡",
};

@Component({
  selector: "app-tool-use-block",
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="tool-use-wrap" [class.tool-use-wrap--pending]="!block.isComplete">
      <span class="tool-use-icon" aria-hidden="true">{{ icon }}</span>
      <code class="tool-use-label">{{ label }}</code>
      @if (!block.isComplete) {
        <span class="tool-use-dot" aria-hidden="true"></span>
      }
    </div>
  `,
  styles: [`
    .tool-use-wrap {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      margin: 2px 0;
      background: var(--c-overlay-subtle);
      border: 1px solid var(--c-border);
      border-radius: var(--radius-md);
      font-size: 12px;
      color: var(--c-text-dim);
      max-width: 100%;
      overflow: hidden;
    }

    .tool-use-wrap--pending {
      border-color: var(--c-accent-border);
      animation: tool-pulse 1.6s ease-in-out infinite;
    }

    .tool-use-icon {
      font-size: 13px;
      flex-shrink: 0;
      line-height: 1;
    }

    .tool-use-label {
      font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
      font-size: 11.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: inherit;
    }

    .tool-use-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--c-accent);
      flex-shrink: 0;
      margin-left: 2px;
      animation: dot-blink 1s ease-in-out infinite;
    }

    @keyframes tool-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.65; }
    }

    @keyframes dot-blink {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.15; }
    }
  `],
})
export class ToolUseBlockComponent {
  @Input({ required: true }) block!: ToolUseBlock;

  get icon(): string {
    const action = this.block.parsedInput?.action ?? this.guessAction();
    return ACTION_ICONS[action] ?? "🔧";
  }

  get label(): string {
    const input = this.block.parsedInput;
    if (!input) {
      // Block not yet complete — show tool name as placeholder
      return this.block.toolName;
    }
    const action = input.action ?? "?";
    const { path, pattern, include } = input;

    switch (action) {
      case "list":
        return `list ${path ?? "."}`;
      case "read":
        return `read ${path ?? "?"}`;
      case "grep": {
        let s = `grep "${pattern ?? "?"}"`;
        if (path && path !== ".") s += ` in ${path}`;
        if (include) s += ` (${include})`;
        return s;
      }
      case "glob":
        return `glob ${pattern ?? "?"}`;
      case "write":
      case "edit":
        return `${action} ${path ?? "?"}`;
      case "bash":
        return `bash ${(input["cmd"] ?? "").slice(0, 40)}`;
      default:
        return action;
    }
  }

  /** Try to read the action from the (possibly incomplete) rawInput JSON. */
  private guessAction(): string {
    const m = this.block.rawInput.match(/"action"\s*:\s*"([^"]+)"/);
    return m?.[1] ?? "";
  }
}
