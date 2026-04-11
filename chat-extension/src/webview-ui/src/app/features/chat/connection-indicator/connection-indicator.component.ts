import { Component, Input } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { ConnectionStatus } from "@shared/message-protocol";

@Component({
  selector: "app-connection-indicator",
  standalone: true,
  imports: [TranslateModule],
  templateUrl: "./connection-indicator.component.html",
  styleUrl: "./connection-indicator.component.scss",
})
export class ConnectionIndicatorComponent {
  @Input() status: ConnectionStatus = ConnectionStatus.Disconnected;

  get statusClass(): ConnectionStatus {
    return this.status;
  }

  get statusKey(): string {
    switch (this.status) {
      case ConnectionStatus.Connected:    return "status.connected";
      case ConnectionStatus.Disconnected: return "status.disconnected";
      case ConnectionStatus.Checking:     return "status.checking";
    }
  }
}
