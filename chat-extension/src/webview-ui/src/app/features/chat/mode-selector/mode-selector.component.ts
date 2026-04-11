import { Component, Input, Output, EventEmitter, HostListener } from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { TranslateModule } from "@ngx-translate/core";
import { AgentMode } from "../../../core/enums/agent-mode.enum";

@Component({
  selector: "app-mode-selector",
  standalone: true,
  imports: [MatIconModule, TranslateModule],
  templateUrl: "./mode-selector.component.html",
  styleUrl: "./mode-selector.component.scss",
})
export class ModeSelectorComponent {
  @Input() agentMode: AgentMode = AgentMode.Ask;
  @Output() agentModeChange = new EventEmitter<AgentMode>();

  readonly modeAsk  = AgentMode.Ask;
  readonly modeAuto = AgentMode.Auto;
  readonly modePlan = AgentMode.Plan;

  showPanel = false;

  get modeShortKey(): string {
    switch (this.agentMode) {
      case AgentMode.Ask:  return "mode.ask.short";
      case AgentMode.Auto: return "mode.auto.short";
      case AgentMode.Plan: return "mode.plan.short";
    }
  }

  toggle(): void {
    this.showPanel = !this.showPanel;
  }

  select(mode: AgentMode): void {
    this.showPanel = false;
    this.agentModeChange.emit(mode);
  }

  @HostListener("document:click")
  onDocumentClick(): void {
    this.showPanel = false;
  }
}
