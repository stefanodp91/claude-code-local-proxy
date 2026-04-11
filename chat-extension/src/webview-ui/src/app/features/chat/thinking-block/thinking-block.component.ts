import { Component, Input, signal } from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { TranslateModule } from "@ngx-translate/core";
import { MarkdownPipe } from "../../../shared/pipes/markdown.pipe";
import type { ThinkingBlock } from "../../../core/models/content-block.model";

@Component({
  selector: "app-thinking-block",
  standalone: true,
  imports: [MatIconModule, TranslateModule, MarkdownPipe],
  templateUrl: "./thinking-block.component.html",
  styleUrl: "./thinking-block.component.scss",
})
export class ThinkingBlockComponent {
  @Input({ required: true }) block!: ThinkingBlock;

  expanded = signal(true);

  toggle(): void {
    this.expanded.update((v) => !v);
  }

  /** i18n key used in the template (supports interpolation params). */
  get headerKey(): string {
    if (!this.block.isComplete) return "chat.thinking";
    if (this.block.startedAt && this.block.completedAt) return "chat.thoughtFor";
    return "chat.thought";
  }

  /** Interpolation params for the header translation. */
  get headerParams(): Record<string, number> | undefined {
    if (this.block.startedAt && this.block.completedAt) {
      return { seconds: Math.round((this.block.completedAt - this.block.startedAt) / 1000) };
    }
    return undefined;
  }
}
