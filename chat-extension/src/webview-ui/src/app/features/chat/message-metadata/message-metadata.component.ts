import { Component, Input } from "@angular/core";
import { CommonModule, DatePipe } from "@angular/common";
import type { ChatMessage } from "../../../core/models/chat-message.model";
import { MessageStatus } from "../../../core/enums/message-status.enum";

@Component({
  selector: "app-message-metadata",
  standalone: true,
  imports: [CommonModule, DatePipe],
  template: `
    <div class="meta d-flex align-items-center gap-2 flex-wrap mt-2">
      @if (message.status === streaming) {
        <span class="meta-item generating">
          <span class="spinner"></span>
          Generating
          @if (message.tokenUsage?.outputTokens) {
            <span class="meta-sep">·</span>
            <span>{{ message.tokenUsage?.outputTokens }} tokens</span>
          }
        </span>
      } @else {
        <span class="meta-item">{{ message.timestamp | date:'HH:mm' }}</span>
        @if (message.model) {
          <span class="meta-sep">·</span>
          <span class="meta-item meta-model">{{ message.model }}</span>
        }
        @if (message.tokenUsage && (message.tokenUsage.inputTokens > 0 || message.tokenUsage.outputTokens > 0)) {
          <span class="meta-sep">·</span>
          <span class="meta-item">
            ↑{{ message.tokenUsage.inputTokens | number }} ↓{{ message.tokenUsage.outputTokens | number }}
          </span>
        }
        @if (message.stopReason) {
          <span class="meta-sep">·</span>
          <span class="meta-item" [class.meta-stop]="message.stopReason !== 'end_turn'">{{ message.stopReason }}</span>
        }
      }
    </div>
  `,
  styles: [`
    .meta {
      font-size: 11px;
      color: var(--c-text-muted);
    }

    .meta-item { opacity: 0.85; }
    .meta-sep  { opacity: 0.4; }

    .meta-model {
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta-stop { color: var(--c-warning-text); }

    .generating {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--c-accent);
      opacity: 0.8;
    }

    .spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 1.5px solid var(--c-accent-muted);
      border-top-color: var(--c-accent);
      border-radius: var(--radius-full);
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `],
})
export class MessageMetadataComponent {
  @Input({ required: true }) message!: ChatMessage;
  readonly streaming = MessageStatus.Streaming;
}
