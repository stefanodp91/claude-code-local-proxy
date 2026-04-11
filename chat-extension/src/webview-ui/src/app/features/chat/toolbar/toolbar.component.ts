import { Component, Input, Output, EventEmitter } from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { MatTooltipModule } from "@angular/material/tooltip";
import { TranslateModule } from "@ngx-translate/core";
import { ConnectionIndicatorComponent } from "../connection-indicator/connection-indicator.component";
import { ConnectionStatus } from "@shared/message-protocol";

@Component({
  selector: "app-toolbar",
  standalone: true,
  imports: [MatIconModule, MatTooltipModule, TranslateModule, ConnectionIndicatorComponent],
  templateUrl: "./toolbar.component.html",
  styleUrl: "./toolbar.component.scss",
})
export class ToolbarComponent {
  @Input() connectionStatus: ConnectionStatus = ConnectionStatus.Disconnected;
  @Output() clearHistory = new EventEmitter<void>();
}
