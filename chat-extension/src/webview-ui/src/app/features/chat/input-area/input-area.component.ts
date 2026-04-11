import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit, HostListener } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { MatIconModule } from "@angular/material/icon";
import { MatTooltipModule } from "@angular/material/tooltip";
import { TranslateModule } from "@ngx-translate/core";
import type { SlashCommand, Attachment, AgentMode } from "@shared/message-protocol";

export interface SendPayload {
  text: string;
  attachments: Attachment[];
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp",
    ts: "text/typescript", js: "text/javascript", tsx: "text/typescript",
    jsx: "text/javascript", py: "text/python", md: "text/markdown",
    json: "application/json", yaml: "text/yaml", yml: "text/yaml",
    html: "text/html", css: "text/css", sh: "text/x-sh",
    txt: "text/plain", rs: "text/x-rust", go: "text/x-go",
    java: "text/x-java", kt: "text/x-kotlin", swift: "text/x-swift",
    cpp: "text/x-c++", c: "text/x-c", rb: "text/x-ruby",
  };
  return map[ext] ?? "text/plain";
}

@Component({
  selector: "app-input-area",
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatTooltipModule, TranslateModule],
  template: `
    <div class="input-shell">
      @if (showMenu) {
        <div class="command-menu">
          <div class="command-menu-header">{{ 'slash.header' | translate }}</div>
          @for (cmd of slashCommands; track cmd.name) {
            <button class="command-item" (click)="selectCommand(cmd.name)">
              <span class="command-item-name">{{ cmd.name }}</span>
              <span class="command-item-desc">{{ cmd.descriptionKey | translate }}</span>
            </button>
          }
        </div>
      }

      <div
        class="input-box"
        [class.input-box--focused]="focused"
        [class.input-box--dragover]="isDragOver"
        (dragover)="onDragOver($event)"
        (dragleave)="onDragLeave($event)"
        (drop)="onDrop($event)">

        @if (attachments.length > 0) {
          <div class="attachment-chips">
            @for (att of attachments; track att.name + att.size) {
              <div class="attachment-chip">
                @if (isImage(att)) {
                  <img
                    [src]="'data:' + att.mimeType + ';base64,' + att.data"
                    class="chip-thumb"
                    [alt]="att.name" />
                } @else {
                  <mat-icon class="chip-icon">insert_drive_file</mat-icon>
                }
                <span class="chip-name" [title]="att.name">{{ att.name }}</span>
                <button class="chip-remove" (click)="removeAttachment(att)" title="Remove">×</button>
              </div>
            }
          </div>
        }

        <textarea
          #textarea
          class="input-textarea"
          [(ngModel)]="inputText"
          placeholder="Message Claudio…"
          [disabled]="isStreaming"
          rows="1"
          (keydown)="onKeydown($event)"
          (focus)="focused = true"
          (blur)="focused = false"
          (input)="autoResize()"
          (paste)="onPaste($event)"
        ></textarea>

        <div class="input-bottom-bar">
          <!-- Left: attach + slash -->
          <button
            class="bottom-btn attach-btn"
            matTooltip="Attach file"
            (click)="attachInput.click()">
            <mat-icon>add</mat-icon>
          </button>
          <input #attachInput type="file" multiple style="display:none" (change)="onFileInputChange($event)" />

          <button
            class="bottom-btn slash-btn"
            [class.slash-btn--active]="showMenu"
            [matTooltip]="'slash.tooltip' | translate"
            (click)="toggleMenu(); $event.stopPropagation()">
            <span class="slash-icon">/</span>
          </button>

          <span class="bottom-spacer"></span>

          <!-- Right: mode selector + send/stop -->
          <div class="mode-selector">
            @if (showModeMenu) {
              <div class="mode-panel">
                <div class="mode-panel-header">Agent mode</div>

                <button class="mode-item" [class.mode-item--active]="agentMode === 'ask'" (click)="selectMode('ask')">
                  <span class="mode-dot mode-dot--ask"></span>
                  <span class="mode-item-body">
                    <span class="mode-item-name">Ask before edits</span>
                    <span class="mode-item-desc">Approves each change</span>
                  </span>
                  @if (agentMode === 'ask') { <mat-icon class="mode-item-check">check</mat-icon> }
                </button>

                <button class="mode-item" [class.mode-item--active]="agentMode === 'auto'" (click)="selectMode('auto')">
                  <span class="mode-dot mode-dot--auto"></span>
                  <span class="mode-item-body">
                    <span class="mode-item-name">Edit automatically</span>
                    <span class="mode-item-desc">No approval required</span>
                  </span>
                  @if (agentMode === 'auto') { <mat-icon class="mode-item-check">check</mat-icon> }
                </button>

                <button class="mode-item" [class.mode-item--active]="agentMode === 'plan'" (click)="selectMode('plan')">
                  <span class="mode-dot mode-dot--plan"></span>
                  <span class="mode-item-body">
                    <span class="mode-item-name">Plan mode</span>
                    <span class="mode-item-desc">Writes plan, no edits</span>
                  </span>
                  @if (agentMode === 'plan') { <mat-icon class="mode-item-check">check</mat-icon> }
                </button>
              </div>
            }

            <button
              class="mode-btn"
              [class.mode-btn--open]="showModeMenu"
              (click)="toggleModeMenu(); $event.stopPropagation()">
              <span class="mode-dot mode-dot--{{ agentMode }}"></span>
              <span class="mode-label">{{ modeShort }}</span>
              <mat-icon class="mode-chevron" [class.mode-chevron--open]="showModeMenu">expand_less</mat-icon>
            </button>
          </div>

          @if (isStreaming) {
            <button class="bottom-btn send-btn stop-btn" matTooltip="Stop" (click)="cancel.emit()">
              <mat-icon>stop</mat-icon>
            </button>
          } @else {
            <button
              class="bottom-btn send-btn"
              matTooltip="Send (Enter)"
              [disabled]="!inputText.trim() && attachments.length === 0"
              (click)="sendMessage()">
              <mat-icon>arrow_upward</mat-icon>
            </button>
          }
        </div>
      </div>

      <p class="input-hint">Enter to send · Shift+Enter for new line · Drag or paste files</p>
      @if (visionWarning) {
        <p class="vision-warning">Il modello corrente non supporta le immagini.</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; flex-shrink: 0; }

    .input-shell {
      position: relative;
      padding: 10px 14px 12px;
      background: var(--c-surface);
      border-top: 1px solid var(--c-border);
    }

    .command-menu {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 14px;
      width: 300px;
      max-height: 300px;
      overflow-y: auto;
      background: var(--c-surface-2);
      border: 1px solid var(--c-border-2);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-dropdown);
      z-index: 100;
    }

    .command-menu-header {
      padding: 8px 12px 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--c-text-muted);
    }

    .command-item {
      display: flex;
      align-items: baseline;
      gap: 8px;
      width: 100%;
      padding: 7px 12px;
      border: none;
      background: transparent;
      cursor: pointer;
      color: var(--c-text);
      font-size: 13px;
      text-align: left;
      transition: background 0.1s;
    }
    .command-item:hover { background: var(--c-accent-dim); }

    .command-item-name {
      font-weight: 500;
      color: var(--c-accent);
      flex-shrink: 0;
    }

    .command-item-desc {
      font-size: 11px;
      color: var(--c-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .input-box {
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: var(--c-surface-2);
      border: 1px solid var(--c-border-2);
      border-radius: var(--radius-lg);
      padding: 8px;
      transition: border-color 0.15s;
    }
    .input-box--focused {
      border-color: var(--c-accent-focus);
    }
    .input-box--dragover {
      border-color: var(--c-accent);
      background: var(--c-accent-dim);
    }

    /* Attachment chips */
    .attachment-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 2px 0;
    }

    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 160px;
      padding: 3px 6px 3px 4px;
      background: var(--c-accent-dim);
      border: 1px solid var(--c-accent-border);
      border-radius: var(--radius-md);
      font-size: 11px;
      color: var(--c-text);
    }

    .chip-thumb {
      width: 28px;
      height: 28px;
      object-fit: cover;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .chip-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      color: var(--c-text-muted);
      flex-shrink: 0;
    }

    .chip-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chip-remove {
      flex-shrink: 0;
      background: none;
      border: none;
      color: var(--c-text-muted);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 1px;
      border-radius: 2px;
    }
    .chip-remove:hover { color: var(--c-text); }

    .input-textarea {
      width: 100%;
      background: transparent;
      border: none;
      outline: none;
      resize: none;
      color: var(--c-text);
      font-family: inherit;
      font-size: 13.5px;
      line-height: 1.55;
      max-height: 180px;
      overflow-y: auto;
      padding: 4px 2px 2px;
    }
    .input-textarea::placeholder { color: var(--c-text-muted); }
    .input-textarea:disabled { opacity: 0.5; }

    /* Bottom bar ─────────────────────────────── */
    .input-bottom-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding-top: 4px;
    }

    .bottom-spacer { flex: 1; }

    .bottom-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--btn-size-sm);
      height: var(--btn-size-sm);
      border-radius: var(--radius-md);
      border: none;
      flex-shrink: 0;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, opacity 0.15s;
    }
    .bottom-btn mat-icon { font-size: 17px; width: 17px; height: 17px; }

    .attach-btn {
      background: transparent;
      color: var(--c-text-muted);
    }
    .attach-btn:hover { background: var(--c-overlay-soft); color: var(--c-text); }

    .slash-btn {
      background: transparent;
      color: var(--c-text-muted);
      font-size: 15px;
      font-weight: 700;
    }
    .slash-btn:hover, .slash-btn--active {
      background: var(--c-overlay-soft);
      color: var(--c-text);
    }
    .slash-icon { font-size: 15px; font-weight: 700; line-height: 1; }

    /* Mode selector */
    .mode-selector {
      position: relative;
      display: inline-flex;
      align-items: center;
    }

    .mode-panel {
      position: absolute;
      bottom: calc(100% + 6px);
      right: 0;
      width: 216px;
      background: var(--c-surface-2);
      border: 1px solid var(--c-border-2);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04);
      overflow: hidden;
      z-index: 200;
    }

    .mode-panel-header {
      padding: 9px 12px 5px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: var(--c-text-muted);
    }

    .mode-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 7px 12px 7px 12px;
      border: none;
      background: transparent;
      cursor: pointer;
      text-align: left;
      transition: background 0.1s;
    }
    .mode-item:last-child { margin-bottom: 3px; }
    .mode-item:hover { background: var(--c-overlay-soft); }
    .mode-item--active { background: var(--c-accent-dim); }
    .mode-item--active:hover { background: rgba(124,140,248,0.14); }

    .mode-item-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .mode-item-name {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--c-text);
      line-height: 1.3;
    }
    .mode-item-desc {
      font-size: 10.5px;
      color: var(--c-text-muted);
      line-height: 1.3;
    }
    .mode-item-check {
      flex-shrink: 0;
      font-size: 14px;
      width: 14px;
      height: 14px;
      color: var(--c-accent);
    }

    /* Mode dot — colored indicator */
    .mode-dot {
      flex-shrink: 0;
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .mode-dot--ask  { background: #fb923c; box-shadow: 0 0 5px rgba(251,146,60,0.5); }
    .mode-dot--auto { background: #4ade80; box-shadow: 0 0 5px rgba(74,222,128,0.5); }
    .mode-dot--plan { background: #7c8cf8; box-shadow: 0 0 5px rgba(124,140,248,0.5); }

    /* Mode trigger button */
    .mode-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: var(--btn-size-sm);
      padding: 0 7px;
      border: none;
      border-radius: var(--radius-md);
      background: var(--c-overlay-subtle);
      color: var(--c-text-dim);
      font-size: 12px;
      font-family: inherit;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      white-space: nowrap;
    }
    .mode-btn:hover, .mode-btn--open {
      background: var(--c-overlay-soft);
      color: var(--c-text);
    }
    .mode-label { font-size: 12px; font-weight: 500; }
    .mode-chevron {
      font-size: 14px;
      width: 14px;
      height: 14px;
      transition: transform 0.15s;
    }
    .mode-chevron--open { transform: rotate(180deg); }

    .send-btn {
      background: var(--c-accent);
      color: #fff;
    }
    .send-btn:hover:not([disabled]) { background: var(--c-accent-hover); }
    .send-btn[disabled] {
      background: var(--c-disabled-bg);
      color: var(--c-disabled-text);
      cursor: default;
    }

    .stop-btn {
      background: var(--c-error-muted) !important;
      color: var(--c-error) !important;
    }
    .stop-btn:hover { background: var(--c-error-hover) !important; }

    .input-hint {
      font-size: 10.5px;
      color: var(--c-text-muted);
      margin-top: 5px;
      padding-left: 2px;
    }

    .vision-warning {
      font-size: 11px;
      color: var(--c-error);
      margin-top: 3px;
      padding-left: 2px;
    }
  `],
})
export class InputAreaComponent implements AfterViewInit {
  @Input() isStreaming    = false;
  @Input() slashCommands: SlashCommand[] = [];
  @Input() supportsVision = false;
  @Input() agentMode: AgentMode = "ask";
  @Output() sendMsg = new EventEmitter<SendPayload>();
  @Output() cancel  = new EventEmitter<void>();
  @Output() requestFileRead = new EventEmitter<string[]>();
  @Output() agentModeChange = new EventEmitter<AgentMode>();

  @ViewChild("textarea") textareaRef!: ElementRef<HTMLTextAreaElement>;

  inputText      = "";
  focused        = false;
  showMenu       = false;
  showModeMenu   = false;
  isDragOver     = false;
  visionWarning  = false;
  attachments: Attachment[] = [];

  get modeShort(): string {
    return this.agentMode === "ask" ? "Ask" : this.agentMode === "auto" ? "Auto" : "Plan";
  }

  toggleModeMenu(): void {
    this.showModeMenu = !this.showModeMenu;
  }

  selectMode(mode: AgentMode): void {
    this.showModeMenu = false;
    this.agentModeChange.emit(mode);
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;
    for (const file of Array.from(input.files)) {
      void this.readFile(file);
    }
    input.value = "";
  }

  constructor(private readonly el: ElementRef) {}

  ngAfterViewInit(): void {
    this.textareaRef.nativeElement.focus();
  }

  // ── Slash command menu ────────────────────────────────────────────────────

  toggleMenu(): void {
    this.showMenu = !this.showMenu;
  }

  selectCommand(name: string): void {
    this.showMenu = false;
    this.sendMsg.emit({ text: name, attachments: [] });
  }

  @HostListener("document:click", ["$event"])
  onDocumentClick(event: MouseEvent): void {
    if (!this.el.nativeElement.contains(event.target as Node)) {
      this.showMenu = false;
      this.showModeMenu = false;
    }
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  sendMessage(): void {
    const text = this.inputText.trim();
    if (!text && this.attachments.length === 0) return;

    this.sendMsg.emit({ text, attachments: [...this.attachments] });
    this.inputText     = "";
    this.attachments   = [];
    this.visionWarning = false;
    setTimeout(() => this.autoResize(), 0);
  }

  autoResize(): void {
    const el = this.textareaRef?.nativeElement;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }

  // ── Attachments ───────────────────────────────────────────────────────────

  isImage(att: Attachment): boolean {
    return IMAGE_MIME_TYPES.has(att.mimeType);
  }

  removeAttachment(att: Attachment): void {
    this.attachments = this.attachments.filter((a) => a !== att);
  }

  /** Called by the parent (ChatContainerComponent) after extension-host reads VS Code Explorer files. */
  addAttachments(attachments: Attachment[]): void {
    this.attachments = [...this.attachments, ...attachments];
  }

  // ── Drag & Drop ───────────────────────────────────────────────────────────

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;

    const dt = event.dataTransfer;
    if (!dt) return;

    // 1. OS filesystem files (File objects)
    if (dt.files && dt.files.length > 0) {
      for (const file of Array.from(dt.files)) {
        void this.readFile(file);
      }
      return;
    }

    // 2. VS Code Explorer drag (text/uri-list)
    const uriList = dt.getData("text/uri-list");
    if (uriList) {
      const uris = uriList
        .split(/\r?\n/)
        .map((u) => u.trim())
        .filter((u) => u && !u.startsWith("#"));
      if (uris.length > 0) {
        this.requestFileRead.emit(uris);
      }
    }
  }

  // ── Clipboard Paste ───────────────────────────────────────────────────────

  onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        event.preventDefault(); // prevent default paste into textarea
        const file = item.getAsFile();
        if (file) void this.readFile(file);
      }
    }
    // Non-image items: allow normal text paste to continue
  }

  // ── File reading ──────────────────────────────────────────────────────────

  private readFile(file: File): Promise<void> {
    const mimeType = file.type || guessMimeType(file.name);

    // Block images when the current model doesn't support vision
    if (IMAGE_MIME_TYPES.has(mimeType) && !this.supportsVision) {
      this.visionWarning = true;
      return Promise.resolve();
    }
    this.visionWarning = false;

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // result is "data:<mime>;base64,<data>" — strip the prefix
        const commaIdx = result.indexOf(",");
        const data = commaIdx !== -1 ? result.slice(commaIdx + 1) : result;

        const att: Attachment = {
          name: file.name || "pasted-image",
          mimeType,
          data,
          size: file.size,
        };
        this.attachments = [...this.attachments, att];
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }
}
