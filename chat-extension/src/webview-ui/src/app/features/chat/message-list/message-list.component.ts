import { Component, Input, Output, EventEmitter } from "@angular/core";
import { CommonModule } from "@angular/common";
import { MessageBubbleComponent } from "../message-bubble/message-bubble.component";
import { AutoScrollDirective } from "../../../shared/directives/auto-scroll.directive";
import type { ChatMessage } from "../../../core/models/chat-message.model";

@Component({
  selector: "app-message-list",
  standalone: true,
  imports: [CommonModule, MessageBubbleComponent, AutoScrollDirective],
  template: `
    <div class="message-list" [appAutoScroll]="true">
      @if (messages.length === 0) {
        <div class="d-flex flex-column align-items-center justify-content-center h-100 empty-state">
          <span class="empty-icon">✦</span>
          <p class="mt-2 small">Start a conversation</p>
        </div>
      }
      @for (msg of messages; track msg.id) {
        <app-message-bubble [message]="msg" (runCode)="runCode.emit($event)" />
      }
      @if (isPending) {
        <div class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .message-list {
      flex: 1;
      overflow-y: auto;
      padding: 20px 24px 20px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .empty-state {
      opacity: 0.3;
      color: var(--c-text, #e5e5e5);
      flex: 1;
    }
    .empty-icon { font-size: 28px; }

    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 10px 4px;
    }
    .typing-indicator span {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: var(--radius-full);
      background: var(--c-text-muted);
      animation: typing-bounce 1.2s ease-in-out infinite;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes typing-bounce {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
      40%           { transform: translateY(-5px); opacity: 1; }
    }
  `],
})
export class MessageListComponent {
  @Input() messages: ChatMessage[] = [];
  @Input() isPending = false;
  @Output() runCode = new EventEmitter<string>();
}
