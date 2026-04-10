import { Component, Input } from "@angular/core";
import { CommonModule } from "@angular/common";
import { ConnectionStatus } from "@shared/message-protocol";

@Component({
  selector: "app-connection-indicator",
  standalone: true,
  imports: [CommonModule],
  template: `
    <span class="d-inline-flex align-items-center gap-1 indicator" [class]="status">
      <span class="dot"></span>
      <span class="label">{{ statusLabel }}</span>
    </span>
  `,
  styles: [`
    .indicator { font-size: 11px; }

    .dot {
      width: 6px; height: 6px;
      border-radius: var(--radius-full);
      flex-shrink: 0;
    }

    .label { opacity: 0.75; }

    .connected .dot     { background: var(--c-success); }
    .connected .label   { color: var(--c-success-text); }
    .disconnected .dot  { background: var(--c-error); }
    .disconnected .label{ color: var(--c-error-text); }
    .checking .dot      { background: var(--c-warning); animation: pulse 1.2s ease-in-out infinite; }
    .checking .label    { color: var(--c-warning-text); }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.35; }
    }
  `],
})
export class ConnectionIndicatorComponent {
  @Input() status: ConnectionStatus = ConnectionStatus.Disconnected;

  get statusLabel(): string {
    switch (this.status) {
      case ConnectionStatus.Connected:    return "Connected";
      case ConnectionStatus.Disconnected: return "Disconnected";
      case ConnectionStatus.Checking:     return "Checking...";
    }
  }
}
