import { Component, Input, Output, EventEmitter, ElementRef, AfterViewInit, OnDestroy, HostListener, effect, inject } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { MarkdownPipe } from "../../../shared/pipes/markdown.pipe";
import { ThinkingBlockComponent } from "../thinking-block/thinking-block.component";
import { ToolUseBlockComponent } from "../tool-use-block/tool-use-block.component";
import { MessageMetadataComponent } from "../message-metadata/message-metadata.component";
import { CodeRegistryService } from "../../../shared/services/code-registry.service";
import { MessageStoreService } from "../../../core/services/message-store.service";
import { MessageRole } from "../../../core/enums/message-role.enum";
import { ContentBlockType } from "../../../core/enums/content-block-type.enum";
import type { ChatMessage } from "../../../core/models/chat-message.model";
import type { TextBlock, ThinkingBlock, ImageBlock, ToolUseBlock } from "../../../core/models/content-block.model";

@Component({
  selector: "app-message-bubble",
  standalone: true,
  imports: [TranslateModule, MarkdownPipe, ThinkingBlockComponent, ToolUseBlockComponent, MessageMetadataComponent],
  templateUrl: "./message-bubble.component.html",
  styleUrl: "./message-bubble.component.scss",
})
export class MessageBubbleComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) message!: ChatMessage;
  @Output() runCode = new EventEmitter<string>();

  readonly thinkingType = ContentBlockType.Thinking;
  readonly toolUseType  = ContentBlockType.ToolUse;
  readonly imageType    = ContentBlockType.Image;

  lightboxSrc: string | null = null;
  lightboxAlt = "";
  bubbleCopied = false;

  private readonly observer: MutationObserver;

  constructor(
    private readonly el: ElementRef<HTMLElement>,
    private readonly codeRegistry: CodeRegistryService,
  ) {
    this.observer = new MutationObserver(() => this.attachRunButtons());
    this.observer.observe(this.el.nativeElement, { childList: true, subtree: true });

    const store = inject(MessageStoreService);
    effect(() => {
      if (store.codeStatus() === null) {
        this.el.nativeElement
          .querySelectorAll<HTMLButtonElement>(".run-code-btn")
          .forEach((btn) => {
            btn.disabled = false;
            btn.textContent = "▶ Run";
          });
      }
    });
  }

  ngAfterViewInit(): void {
    this.attachRunButtons();
  }

  ngOnDestroy(): void {
    this.observer.disconnect();
  }

  get isUser(): boolean {
    return this.message.role === MessageRole.User;
  }

  asThinking(block: any): ThinkingBlock { return block as ThinkingBlock; }
  asToolUse(block: any): ToolUseBlock   { return block as ToolUseBlock; }
  asText(block: any): TextBlock         { return block as TextBlock; }
  asImage(block: any): ImageBlock       { return block as ImageBlock; }

  copyBubble(): void {
    const text = this.message.contentBlocks
      .filter((b) => b.type === ContentBlockType.Text)
      .map((b) => (b as TextBlock).text)
      .join("\n\n");
    void navigator.clipboard.writeText(text).then(() => {
      this.bubbleCopied = true;
      setTimeout(() => { this.bubbleCopied = false; }, 2000);
    });
  }

  openLightbox(block: ImageBlock): void {
    this.lightboxSrc = `data:${block.mimeType};base64,${block.data}`;
    this.lightboxAlt = block.name;
  }

  closeLightbox(): void {
    this.lightboxSrc = null;
  }

  @HostListener("document:keydown.escape")
  onEscape(): void {
    this.closeLightbox();
  }

  attachRunButtons(): void {
    const runBtns = this.el.nativeElement.querySelectorAll<HTMLElement>(".run-code-btn:not([data-bound])");
    runBtns.forEach((btn) => {
      btn.setAttribute("data-bound", "1");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        (btn as HTMLButtonElement).disabled = true;
        btn.textContent = "⏳ Running…";
        const id = btn.getAttribute("data-code-id");
        const code = id ? this.codeRegistry.get(id) : undefined;
        if (code) this.runCode.emit(code);
      });
    });

    const copyBtns = this.el.nativeElement.querySelectorAll<HTMLElement>(".copy-code-btn:not([data-bound])");
    copyBtns.forEach((btn) => {
      btn.setAttribute("data-bound", "1");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wrap = btn.closest(".code-block-wrap");
        const code = wrap?.querySelector("pre > code")?.textContent ?? "";
        void navigator.clipboard.writeText(code).then(() => {
          btn.textContent = "✓ Copied";
          setTimeout(() => { btn.textContent = "Copy"; }, 2000);
        });
      });
    });
  }
}
