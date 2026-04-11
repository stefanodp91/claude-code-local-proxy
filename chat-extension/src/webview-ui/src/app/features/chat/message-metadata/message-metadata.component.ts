import { Component, Input } from "@angular/core";
import { CommonModule, DatePipe } from "@angular/common";
import { TranslateModule } from "@ngx-translate/core";
import type { ChatMessage } from "../../../core/models/chat-message.model";
import { MessageStatus } from "../../../core/enums/message-status.enum";

@Component({
  selector: "app-message-metadata",
  standalone: true,
  imports: [CommonModule, DatePipe, TranslateModule],
  templateUrl: "./message-metadata.component.html",
  styleUrl: "./message-metadata.component.scss",
})
export class MessageMetadataComponent {
  @Input({ required: true }) message!: ChatMessage;

  readonly streaming = MessageStatus.Streaming;
}
