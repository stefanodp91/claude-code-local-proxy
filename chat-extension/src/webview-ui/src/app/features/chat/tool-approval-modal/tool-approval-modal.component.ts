import { Component, Input, Output, EventEmitter } from "@angular/core";
import { CommonModule } from "@angular/common";
import type { ToolApprovalRequestPayload } from "@shared/message-protocol";

/** Emitted when the user makes a decision. */
export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
}

/**
 * Modal overlay that asks the user to approve or deny a destructive
 * workspace action (write, edit, bash) requested by the LLM.
 *
 * Displayed by ChatContainerComponent when it receives a
 * ToWebviewType.ToolApprovalRequest message from the extension host.
 */
@Component({
  selector: "app-tool-approval-modal",
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (request) {
      <div class="overlay" (click)="deny()">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <span class="action-icon">{{ actionIcon }}</span>
            <span class="action-label">Allow <strong>{{ request.action }}</strong>?</span>
          </div>

          @if (request.params.path) {
            <div class="param-row">
              <span class="param-key">path</span>
              <code class="param-val">{{ request.params.path }}</code>
            </div>
          }
          @if (request.params.pattern) {
            <div class="param-row">
              <span class="param-key">pattern</span>
              <code class="param-val">{{ request.params.pattern }}</code>
            </div>
          }
          @if (request.params.cmd) {
            <div class="param-row">
              <span class="param-key">cmd</span>
              <code class="param-val">{{ request.params.cmd }}</code>
            </div>
          }
          @if (request.params.old_string) {
            <div class="param-row">
              <span class="param-key">old</span>
              <pre class="param-pre">{{ request.params.old_string }}</pre>
            </div>
          }
          @if (request.params.new_string) {
            <div class="param-row">
              <span class="param-key">new</span>
              <pre class="param-pre">{{ request.params.new_string }}</pre>
            </div>
          }
          @if (contentPreview) {
            <div class="param-row">
              <span class="param-key">content</span>
              <pre class="param-pre">{{ contentPreview }}</pre>
            </div>
          }

          <div class="modal-actions">
            <button class="btn btn--deny"    (click)="deny()">Deny</button>
            <button class="btn btn--approve" (click)="approve()">Allow</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .overlay {
      position: fixed;
      inset: 0;
      z-index: 9000;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fade-in 0.12s ease;
    }
    @keyframes fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .modal {
      background: var(--c-bg);
      border: 1px solid var(--c-border-2);
      border-radius: var(--radius-xl);
      padding: 18px 20px 16px;
      min-width: 320px;
      max-width: min(480px, 92vw);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    .modal-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
      font-size: 14px;
      color: var(--c-text);
    }
    .action-icon { font-size: 20px; }
    .action-label strong { color: var(--c-accent); }

    .param-row {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-bottom: 10px;
    }
    .param-key {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--c-text-muted);
    }
    .param-val {
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 12px;
      color: var(--c-code-text);
      background: var(--c-code-bg);
      border: 1px solid var(--c-border-2);
      border-radius: var(--radius-sm);
      padding: 3px 7px;
      word-break: break-all;
    }
    .param-pre {
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 11.5px;
      color: var(--c-code-text);
      background: var(--c-code-bg);
      border: 1px solid var(--c-border-2);
      border-radius: var(--radius-sm);
      padding: 6px 9px;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 140px;
      overflow-y: auto;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    .btn {
      border: 1px solid var(--c-border-2);
      border-radius: var(--radius-md);
      padding: 5px 16px;
      font-size: 12.5px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .btn--deny {
      background: none;
      color: var(--c-text-muted);
    }
    .btn--deny:hover { background: var(--c-overlay-subtle); color: var(--c-text); }
    .btn--approve {
      background: var(--c-accent);
      color: #fff;
      border-color: transparent;
      font-weight: 600;
    }
    .btn--approve:hover { filter: brightness(1.1); }
  `],
})
export class ToolApprovalModalComponent {
  @Input() request: ToolApprovalRequestPayload | null = null;
  @Output() decision = new EventEmitter<ApprovalDecision>();

  get actionIcon(): string {
    switch (this.request?.action) {
      case "write":  return "✏️";
      case "edit":   return "📝";
      case "bash":   return "⚡";
      default:       return "⚠️";
    }
  }

  /** Show at most 400 chars of content to keep the modal compact. */
  get contentPreview(): string | null {
    const c = this.request?.params?.content;
    if (!c) return null;
    return c.length > 400 ? c.slice(0, 400) + "\n…" : c;
  }

  approve(): void {
    if (!this.request) return;
    this.decision.emit({ requestId: this.request.requestId, approved: true });
  }

  deny(): void {
    if (!this.request) return;
    this.decision.emit({ requestId: this.request.requestId, approved: false });
  }
}
