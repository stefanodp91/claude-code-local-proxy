import { Component, Input } from "@angular/core";
import type { ToolUseBlock } from "../../../core/models/content-block.model";

const ACTION_ICONS: Record<string, string> = {
  list:  "📂",
  read:  "📄",
  grep:  "🔍",
  glob:  "🌐",
  write: "✏️",
  edit:  "✏️",
  bash:  "⚡",
};

@Component({
  selector: "app-tool-use-block",
  standalone: true,
  imports: [],
  templateUrl: "./tool-use-block.component.html",
  styleUrl: "./tool-use-block.component.scss",
})
export class ToolUseBlockComponent {
  @Input({ required: true }) block!: ToolUseBlock;

  get icon(): string {
    const action = this.block.parsedInput?.action ?? this.guessAction();
    return ACTION_ICONS[action] ?? "🔧";
  }

  get label(): string {
    const input = this.block.parsedInput;
    if (!input) return this.block.toolName;

    const action = input.action ?? "?";
    const { path, pattern, include } = input;

    switch (action) {
      case "list":  return `list ${path ?? "."}`;
      case "read":  return `read ${path ?? "?"}`;
      case "grep": {
        let s = `grep "${pattern ?? "?"}"`;
        if (path && path !== ".") s += ` in ${path}`;
        if (include) s += ` (${include})`;
        return s;
      }
      case "glob":  return `glob ${pattern ?? "?"}`;
      case "write":
      case "edit":  return `${action} ${path ?? "?"}`;
      case "bash":  return `bash ${(input["cmd"] ?? "").slice(0, 40)}`;
      default:      return action;
    }
  }

  private guessAction(): string {
    const m = this.block.rawInput.match(/"action"\s*:\s*"([^"]+)"/);
    return m?.[1] ?? "";
  }
}
