/**
 * notification-banner.component.ts — Stack of embedded banners rendered at
 * the top of the chat container. Used to surface errors and status messages
 * without resorting to `vscode.window.showErrorMessage`.
 *
 * The parent owns the notification list (signal-based). This component is
 * purely presentational: it renders each banner and emits a `dismiss` event
 * with the id when the user clicks ×.
 */
import { Component, Input, Output, EventEmitter } from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatIconModule } from "@angular/material/icon";
import type { NotificationPayload } from "@shared/message-protocol";

@Component({
  selector: "app-notification-banner",
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: "./notification-banner.component.html",
  styleUrl: "./notification-banner.component.scss",
})
export class NotificationBannerComponent {
  @Input() notifications: NotificationPayload[] = [];
  @Output() dismiss = new EventEmitter<string>();

  iconFor(level: NotificationPayload["level"]): string {
    switch (level) {
      case "error": return "error_outline";
      case "warn":  return "warning_amber";
      default:      return "info";
    }
  }
}
