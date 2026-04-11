import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit, HostListener } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatIconModule } from "@angular/material/icon";
import { MatTooltipModule } from "@angular/material/tooltip";
import { TranslateModule } from "@ngx-translate/core";
import { ModeSelectorComponent } from "../mode-selector/mode-selector.component";
import { AgentMode } from "../../../core/enums/agent-mode.enum";
import type { SlashCommand, Attachment } from "@shared/message-protocol";

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
  imports: [FormsModule, MatIconModule, MatTooltipModule, TranslateModule, ModeSelectorComponent],
  templateUrl: "./input-area.component.html",
  styleUrl: "./input-area.component.scss",
})
export class InputAreaComponent implements AfterViewInit {
  @Input() isStreaming          = false;
  @Input() slashCommands: SlashCommand[] = [];
  @Input() supportsVision       = false;
  @Input() thinkingSupported    = false;
  @Input() thinkingCanBeToggled = false;
  @Input() enableThinking       = true;
  @Input() agentMode: AgentMode = AgentMode.Ask;

  @Output() sendMsg             = new EventEmitter<SendPayload>();
  @Output() cancel              = new EventEmitter<void>();
  @Output() requestFileRead     = new EventEmitter<string[]>();
  @Output() agentModeChange     = new EventEmitter<AgentMode>();
  @Output() enableThinkingChange = new EventEmitter<boolean>();

  @ViewChild("textarea") textareaRef!: ElementRef<HTMLTextAreaElement>;

  inputText    = "";
  focused      = false;
  showMenu     = false;
  isDragOver   = false;
  visionWarning = false;
  attachments: Attachment[] = [];

  constructor(private readonly el: ElementRef) {}

  ngAfterViewInit(): void {
    this.textareaRef.nativeElement.focus();
  }

  toggleMenu(): void {
    this.showMenu = !this.showMenu;
  }

  selectCommand(name: string): void {
    this.showMenu = false;
    this.sendMsg.emit({ text: name, attachments: [] });
  }

  toggleThinking(): void {
    this.enableThinking = !this.enableThinking;
    this.enableThinkingChange.emit(this.enableThinking);
  }

  @HostListener("document:click", ["$event"])
  onDocumentClick(event: MouseEvent): void {
    if (!this.el.nativeElement.contains(event.target as Node)) {
      this.showMenu = false;
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

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

  isImage(att: Attachment): boolean {
    return IMAGE_MIME_TYPES.has(att.mimeType);
  }

  removeAttachment(att: Attachment): void {
    this.attachments = this.attachments.filter((a) => a !== att);
  }

  addAttachments(attachments: Attachment[]): void {
    this.attachments = [...this.attachments, ...attachments];
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;
    for (const file of Array.from(input.files)) void this.readFile(file);
    input.value = "";
  }

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

    if (dt.files && dt.files.length > 0) {
      for (const file of Array.from(dt.files)) void this.readFile(file);
      return;
    }

    const uriList = dt.getData("text/uri-list");
    if (uriList) {
      const uris = uriList.split(/\r?\n/).map((u) => u.trim()).filter((u) => u && !u.startsWith("#"));
      if (uris.length > 0) this.requestFileRead.emit(uris);
    }
  }

  onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) void this.readFile(file);
      }
    }
  }

  private readFile(file: File): Promise<void> {
    const mimeType = file.type || guessMimeType(file.name);
    if (IMAGE_MIME_TYPES.has(mimeType) && !this.supportsVision) {
      this.visionWarning = true;
      return Promise.resolve();
    }
    this.visionWarning = false;

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const commaIdx = result.indexOf(",");
        const data = commaIdx !== -1 ? result.slice(commaIdx + 1) : result;
        this.attachments = [...this.attachments, {
          name: file.name || "pasted-image",
          mimeType,
          data,
          size: file.size,
        }];
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }
}
