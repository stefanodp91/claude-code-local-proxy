import { Component, Input, Output, EventEmitter } from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { MatTooltipModule } from "@angular/material/tooltip";
import { ConnectionIndicatorComponent } from "../connection-indicator/connection-indicator.component";
import { ConnectionStatus } from "@shared/message-protocol";

@Component({
  selector: "app-toolbar",
  standalone: true,
  imports: [MatIconModule, MatTooltipModule, ConnectionIndicatorComponent],
  template: `
    <header class="toolbar d-flex align-items-center px-3">
      <span class="toolbar-title">Claudio</span>
      <span class="flex-grow-1"></span>
      <app-connection-indicator [status]="connectionStatus" />
      <button
        class="icon-btn ms-1"
        matTooltip="Clear history"
        (click)="clearHistory.emit()">
        <mat-icon>delete_outline</mat-icon>
      </button>
    </header>
  `,
  styles: [`
    :host { display: block; flex-shrink: 0; }

    .toolbar {
      height: 44px;
      background: var(--c-surface);
      border-bottom: 1px solid var(--c-border);
    }

    .toolbar-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.3px;
      color: var(--c-text);
    }

    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--btn-size-md);
      height: var(--btn-size-md);
      border: none;
      background: transparent;
      border-radius: var(--radius-sm);
      color: var(--c-text-muted);
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .icon-btn:hover {
      background: var(--c-overlay-soft);
      color: var(--c-text);
    }
    .icon-btn mat-icon { font-size: 18px; width: 18px; height: 18px; }
  `],
})
export class ToolbarComponent {
  @Input() connectionStatus: ConnectionStatus = ConnectionStatus.Disconnected;
  @Output() clearHistory = new EventEmitter<void>();
}
