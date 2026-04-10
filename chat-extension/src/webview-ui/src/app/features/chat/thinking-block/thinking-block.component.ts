import { Component, Input, signal } from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatIconModule } from "@angular/material/icon";
import { MarkdownPipe } from "../../../shared/pipes/markdown.pipe";
import type { ThinkingBlock } from "../../../core/models/content-block.model";

@Component({
  selector: "app-thinking-block",
  standalone: true,
  imports: [CommonModule, MatIconModule, MarkdownPipe],
  template: `
    <div class="thinking-wrap my-2">
      <button class="thinking-toggle d-flex align-items-center gap-2" (click)="toggle()">
        <mat-icon class="think-icon" [class.spin]="!block.isComplete">psychology</mat-icon>
        <span>{{ headerText }}</span>
        <mat-icon class="chevron" [class.open]="expanded()">expand_more</mat-icon>
      </button>
      @if (expanded()) {
        <div class="thinking-body md-content" [innerHTML]="block.thinking | markdown"></div>
      }
    </div>
  `,
  styles: [`
    .thinking-wrap {
      border: 1px solid var(--c-border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .thinking-toggle {
      width: 100%;
      padding: 8px 12px;
      background: var(--c-overlay-subtle);
      border: none;
      color: var(--c-text-dim);
      cursor: pointer;
      font-size: 12px;
      text-align: left;
      transition: background 0.15s;
    }
    .thinking-toggle:hover { background: var(--c-overlay-soft); }

    .think-icon {
      font-size: 15px; width: 15px; height: 15px;
      color: var(--c-thinking);
    }
    .think-icon.spin { animation: spin 1.8s linear infinite; }

    .chevron {
      font-size: 16px; width: 16px; height: 16px;
      margin-left: auto;
      transition: transform 0.2s;
    }
    .chevron.open { transform: rotate(180deg); }

    .thinking-body {
      padding: 10px 14px;
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--c-text-dim);
      max-height: 360px;
      overflow-y: auto;
      border-top: 1px solid var(--c-border);
    }

    @keyframes spin { to { transform: rotate(360deg); } }
  `],
})
export class ThinkingBlockComponent {
  @Input({ required: true }) block!: ThinkingBlock;

  expanded = signal(true);

  toggle(): void {
    this.expanded.update((v) => !v);
  }

  get headerText(): string {
    if (!this.block.isComplete) return "Thinking...";
    if (this.block.startedAt && this.block.completedAt) {
      const s = Math.round((this.block.completedAt - this.block.startedAt) / 1000);
      return `Thought for ${s}s`;
    }
    return "Thought";
  }
}
