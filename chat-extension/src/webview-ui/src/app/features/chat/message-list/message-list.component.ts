import { Component, Input, Output, EventEmitter } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { MessageBubbleComponent } from "../message-bubble/message-bubble.component";
import { AutoScrollDirective } from "../../../shared/directives/auto-scroll.directive";
import type { ChatMessage } from "../../../core/models/chat-message.model";

@Component({
  selector: "app-message-list",
  standalone: true,
  imports: [TranslateModule, MessageBubbleComponent, AutoScrollDirective],
  templateUrl: "./message-list.component.html",
  styleUrl: "./message-list.component.scss",
})
export class MessageListComponent {
  @Input() messages: ChatMessage[] = [];
  @Input() isPending = false;
  @Output() runCode = new EventEmitter<string>();
}
