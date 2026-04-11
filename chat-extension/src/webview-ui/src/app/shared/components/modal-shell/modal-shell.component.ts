/**
 * modal-shell.component.ts — Centralized overlay + card shell for all embedded modals.
 *
 * All in-webview modal dialogs (tool approval, plan-mode exit, future prompts)
 * MUST be wrapped in this component so the overlay, backdrop dismissal,
 * ESC handling and z-index management live in one place.
 *
 * Usage:
 *   <app-modal-shell [open]="isOpen" (dismissed)="close()">
 *     <h3>Header…</h3>
 *     <div>Body…</div>
 *     <div>Buttons…</div>
 *   </app-modal-shell>
 *
 * The shell is invisible (renders nothing) when `open` is false, so parents
 * can bind it directly to their state signal.
 */
import { Component, Input, Output, EventEmitter, HostListener } from "@angular/core";
import { CommonModule } from "@angular/common";

@Component({
  selector: "app-modal-shell",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./modal-shell.component.html",
  styleUrl: "./modal-shell.component.scss",
})
export class ModalShellComponent {
  /** When false, nothing renders. */
  @Input() open = false;

  /** When true (default), clicking the dark backdrop emits `dismissed`. */
  @Input() closeOnBackdrop = true;

  /** When true (default), pressing ESC emits `dismissed`. */
  @Input() closeOnEscape = true;

  /** Emitted when the user dismisses the modal via backdrop click or ESC. */
  @Output() dismissed = new EventEmitter<void>();

  onBackdrop(): void {
    if (this.closeOnBackdrop) this.dismissed.emit();
  }

  @HostListener("document:keydown.escape")
  onEscape(): void {
    if (this.open && this.closeOnEscape) this.dismissed.emit();
  }
}
