import { Component, Input, Output, EventEmitter } from "@angular/core";
import { diffLines } from "diff";
import { TranslateModule } from "@ngx-translate/core";
import type { ToolApprovalRequestPayload, ApprovalScope } from "@shared/message-protocol";
import { ToolAction } from "../../../core/enums/tool-action.enum";
import { ModalShellComponent } from "../../../shared/components/modal-shell/modal-shell.component";

/** Emitted when the user makes a decision. */
export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  scope: ApprovalScope;
}

/** One rendered diff line with its visual classification. */
interface DiffLine {
  kind: "added" | "removed" | "context" | "ellipsis";
  marker: string;
  text: string;
}

const CONTEXT_LINES = 3;

/**
 * Modal overlay that asks the user to approve or deny a destructive
 * workspace action (write, edit, bash) requested by the LLM.
 *
 * Renders a unified diff for write/edit actions, and a plain command block
 * for bash. Behaviour by action:
 *   - write, new file    → every line shown as added (green +)
 *   - write, existing    → unified diff of oldContent vs params.content
 *   - edit               → unified diff of old_string vs new_string
 *   - bash               → command shown verbatim, no diff
 *
 * The overlay + card chrome comes from `<app-modal-shell>` — all modals in
 * the webview share that single shell so z-index / backdrop / ESC handling
 * live in one place.
 */
@Component({
  selector: "app-tool-approval-modal",
  standalone: true,
  imports: [TranslateModule, ModalShellComponent],
  templateUrl: "./tool-approval-modal.component.html",
  styleUrl: "./tool-approval-modal.component.scss",
})
export class ToolApprovalModalComponent {
  @Input() request: ToolApprovalRequestPayload | null = null;
  @Output() decision = new EventEmitter<ApprovalDecision>();

  /** Expose enum for template comparisons. */
  readonly ToolAction = ToolAction;

  get headerIcon(): string {
    switch (this.request?.action) {
      case ToolAction.Write: return this.request.oldContent == null ? "📄" : "✏️";
      case ToolAction.Edit:  return "📝";
      case ToolAction.Bash:  return "⚡";
      default:               return "⚠️";
    }
  }

  /** Returns the i18n key for the modal header verb. */
  get headerLabelKey(): string {
    switch (this.request?.action) {
      case ToolAction.Write: return this.request.oldContent == null
        ? "approval.header.create"
        : "approval.header.modify";
      case ToolAction.Edit:  return "approval.header.edit";
      case ToolAction.Bash:  return "approval.header.runCommand";
      default:               return "approval.header.allow";
    }
  }

  get headerTarget(): string {
    if (!this.request) return "";
    if (this.request.action === "bash") return "";
    return this.request.params.path ?? "";
  }

  /**
   * Compute the diff lines to render. Logic:
   *   write (new)      → all new content as added lines
   *   write (existing) → diffLines(oldContent, params.content)
   *   edit             → diffLines(params.old_string, params.new_string)
   *   bash             → [] (not used — template renders cmd block instead)
   */
  get diffDisplayLines(): DiffLine[] {
    const req = this.request;
    if (!req) return [];

    let oldText = "";
    let newText = "";
    if (req.action === "write") {
      oldText = req.oldContent ?? "";
      newText = req.params.content ?? "";
    } else if (req.action === "edit") {
      oldText = req.params.old_string ?? "";
      newText = req.params.new_string ?? "";
    } else {
      return [];
    }

    // New file: no diff, just added lines.
    if (req.action === "write" && (req.oldContent == null || req.oldContent === "")) {
      return newText.split("\n").map((line) => ({
        kind: "added" as const,
        marker: "+",
        text: line,
      }));
    }

    const chunks = diffLines(oldText, newText);
    const lines: DiffLine[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const raw = c.value.split("\n");
      // diffLines often leaves a trailing empty string when the chunk ends with \n
      if (raw[raw.length - 1] === "") raw.pop();

      if (c.added) {
        raw.forEach((t) => lines.push({ kind: "added", marker: "+", text: t }));
      } else if (c.removed) {
        raw.forEach((t) => lines.push({ kind: "removed", marker: "-", text: t }));
      } else {
        // Context: keep head and tail, collapse long middles.
        const isFirst = i === 0;
        const isLast = i === chunks.length - 1;
        if (raw.length > CONTEXT_LINES * 2 + 1) {
          const head = isFirst ? raw.slice(-CONTEXT_LINES) : raw.slice(0, CONTEXT_LINES);
          const tail = isLast ? raw.slice(0, CONTEXT_LINES) : raw.slice(-CONTEXT_LINES);
          if (!isFirst) head.forEach((t) => lines.push({ kind: "context", marker: " ", text: t }));
          lines.push({
            kind: "ellipsis",
            marker: " ",
            text: `… ${raw.length - (isFirst || isLast ? CONTEXT_LINES : CONTEXT_LINES * 2)} unchanged lines …`,
          });
          if (!isLast) tail.forEach((t) => lines.push({ kind: "context", marker: " ", text: t }));
        } else {
          raw.forEach((t) => lines.push({ kind: "context", marker: " ", text: t }));
        }
      }
    }

    return lines;
  }

  /** Allow this single action only (default click on the primary Allow button). */
  approveOnce(): void {
    if (!this.request) return;
    this.decision.emit({ requestId: this.request.requestId, approved: true, scope: "once" });
  }

  /** Allow ALL destructive actions for the rest of the current turn. */
  approveTurn(): void {
    if (!this.request) return;
    this.decision.emit({ requestId: this.request.requestId, approved: true, scope: "turn" });
  }

  /**
   * Allow this action AND any future write/edit on the same file until the
   * proxy restarts. Hidden for bash (no path → no meaningful file trust).
   */
  approveFile(): void {
    if (!this.request) return;
    this.decision.emit({ requestId: this.request.requestId, approved: true, scope: "file" });
  }

  deny(): void {
    if (!this.request) return;
    this.decision.emit({ requestId: this.request.requestId, approved: false, scope: "once" });
  }
}
