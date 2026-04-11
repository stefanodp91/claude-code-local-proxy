/**
 * plan-exit-modal.component.ts — Embedded dialog shown when the model calls
 * `workspace(action="exit_plan_mode")`, asking the user to switch out of
 * Plan mode.
 *
 * Replaces the old `vscode.window.showInformationMessage` flow: all user
 * interaction lives inside the webview, via the centralized ModalShell.
 */
import { Component, Input, Output, EventEmitter } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import type { PlanExitRequestPayload } from "@shared/message-protocol";
import { ModalShellComponent } from "../../../shared/components/modal-shell/modal-shell.component";

/** Emitted when the user picks an option. `null` = "Stay in Plan mode". */
export interface PlanExitDecision {
  mode: "auto" | "ask" | null;
}

@Component({
  selector: "app-plan-exit-modal",
  standalone: true,
  imports: [TranslateModule, ModalShellComponent],
  templateUrl: "./plan-exit-modal.component.html",
  styleUrl: "./plan-exit-modal.component.scss",
})
export class PlanExitModalComponent {
  @Input() request: PlanExitRequestPayload | null = null;
  @Output() decision = new EventEmitter<PlanExitDecision>();

  stay(): void {
    this.decision.emit({ mode: null });
  }

  chooseAsk(): void {
    this.decision.emit({ mode: "ask" });
  }

  chooseAuto(): void {
    this.decision.emit({ mode: "auto" });
  }
}
