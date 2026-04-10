import { Component, Input, Output, EventEmitter, ElementRef, AfterViewInit, OnDestroy, HostListener, effect, inject } from "@angular/core";
import { CommonModule } from "@angular/common";
import { MarkdownPipe } from "../../../shared/pipes/markdown.pipe";
import { ThinkingBlockComponent } from "../thinking-block/thinking-block.component";
import { MessageMetadataComponent } from "../message-metadata/message-metadata.component";
import { CodeRegistryService } from "../../../shared/services/code-registry.service";
import { MessageStoreService } from "../../../core/services/message-store.service";
import { MessageRole } from "../../../core/enums/message-role.enum";
import { ContentBlockType } from "../../../core/enums/content-block-type.enum";
import type { ChatMessage } from "../../../core/models/chat-message.model";
import type { TextBlock, ThinkingBlock, ImageBlock } from "../../../core/models/content-block.model";

@Component({
  selector: "app-message-bubble",
  standalone: true,
  imports: [CommonModule, MarkdownPipe, ThinkingBlockComponent, MessageMetadataComponent],
  template: `
    <div class="msg-row" [class.msg-row--user]="isUser">
      <div class="bubble" [class.bubble--user]="isUser" [class.bubble--assistant]="!isUser">
        <div class="bubble-content">
          @for (block of message.contentBlocks; track $index) {
            @if (block.type === thinkingType) {
              <app-thinking-block [block]="asThinking(block)" />
            } @else if (block.type === imageType) {
              <img
                class="attachment-image"
                [src]="'data:' + asImage(block).mimeType + ';base64,' + asImage(block).data"
                [alt]="asImage(block).name"
                loading="lazy"
                (click)="openLightbox(asImage(block))" />
            } @else {
              <div class="md-content" [innerHTML]="asText(block).text | markdown"></div>
            }
          }
        </div>
        @if (!isUser) {
          <div class="bubble-footer">
            <app-message-metadata [message]="message" />
            <button
              class="copy-bubble-btn"
              [class.copy-bubble-btn--copied]="bubbleCopied"
              (click)="copyBubble()"
              title="Copy response">
              {{ bubbleCopied ? '✓ Copied' : 'Copy' }}
            </button>
          </div>
        }
      </div>
    </div>

    @if (lightboxSrc) {
      <div class="lightbox-overlay" (click)="closeLightbox()">
        <button class="lightbox-close" (click)="closeLightbox()">×</button>
        <img
          class="lightbox-img"
          [src]="lightboxSrc"
          [alt]="lightboxAlt"
          (click)="$event.stopPropagation()" />
      </div>
    }
  `,
  styles: [`
    :host { display: block; }

    /* ── Row ─────────────────────────────────────────────── */
    .msg-row {
      display: flex;
      padding: 4px 0;
    }
    .msg-row--user {
      justify-content: flex-end;
    }

    /* ── Bubble ──────────────────────────────────────────── */
    .bubble {
      max-width: 82%;
      padding: 11px 15px 9px;
      border-radius: var(--radius-xl);
      font-size: 13.5px;
      line-height: 1.65;
      word-break: break-word;
    }

    .bubble--user {
      background: var(--c-user-bg);
      color: var(--c-user-text);
      border: 1px solid var(--c-accent-border);
    }

    .bubble--assistant {
      max-width: 100%;
      background: transparent;
      color: var(--c-text);
      padding-left: 0;
      padding-right: 0;
    }

    .bubble-content { line-height: 1.65; }

    /* ── Bubble footer ───────────────────────────────────────── */
    .bubble-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 4px;
    }

    .copy-bubble-btn {
      flex-shrink: 0;
      background: none;
      border: 1px solid var(--c-border-2);
      color: var(--c-text-muted);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: var(--radius-md);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s, border-color 0.15s;
    }
    :host:hover .copy-bubble-btn { opacity: 1; }
    .copy-bubble-btn:hover { color: var(--c-text); border-color: var(--c-accent); }
    .copy-bubble-btn--copied { color: var(--c-accent) !important; border-color: var(--c-accent) !important; opacity: 1 !important; }

    .attachment-image {
      max-width: 100%;
      max-height: 320px;
      border-radius: var(--radius-md);
      object-fit: contain;
      display: block;
      margin-bottom: 6px;
      cursor: zoom-in;
    }

    /* ── Lightbox ─────────────────────────────────────────── */
    .lightbox-overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: zoom-out;
      animation: lb-fade-in 0.15s ease;
    }

    @keyframes lb-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .lightbox-img {
      max-width: 92vw;
      max-height: 90vh;
      object-fit: contain;
      border-radius: var(--radius-md);
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
      cursor: default;
    }

    .lightbox-close {
      position: fixed;
      top: 16px;
      right: 20px;
      background: rgba(255, 255, 255, 0.12);
      border: none;
      color: #fff;
      font-size: 24px;
      line-height: 1;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
      z-index: 10000;
    }
    .lightbox-close:hover { background: rgba(255, 255, 255, 0.25); }

    /* ── Markdown content ─────────────────────────────────── */
    :host ::ng-deep .md-content {

      & > :first-child { margin-top: 0 !important; }
      & > :last-child  { margin-bottom: 0 !important; }

      p { margin: 5px 0; }

      h1, h2, h3, h4 {
        font-weight: 600;
        margin: 14px 0 5px;
        color: var(--c-text);
        line-height: 1.3;
      }
      h1 { font-size: 1.2em; }
      h2 { font-size: 1.08em; }
      h3 { font-size: 0.98em; }

      /* Code blocks */
      pre {
        background: var(--c-code-bg);
        border: 1px solid var(--c-border-2);
        border-radius: var(--radius-md);
        padding: 13px 15px;
        overflow-x: auto;
        margin: 10px 0;
        font-size: 12.5px;
        line-height: 1.6;
      }

      pre code {
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
        font-size: 12.5px;
        color: var(--c-code-text);
        background: transparent;
        padding: 0;
        border-radius: 0;
      }

      code {
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
        font-size: 12.5px;
      }

      /* Inline code */
      :not(pre) > code {
        background: var(--c-code-inline-bg);
        color: var(--c-code-inline-text);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        font-size: 12px;
      }

      /* Lists */
      ul, ol { padding-left: 18px; margin: 5px 0; }
      li { margin: 2px 0; }
      li > p { margin: 0; }

      /* Table */
      table {
        border-collapse: collapse;
        width: 100%;
        margin: 10px 0;
        font-size: 13px;
      }
      th, td {
        border: 1px solid var(--c-border-2);
        padding: 6px 11px;
        text-align: left;
      }
      th {
        background: var(--c-overlay-subtle);
        font-weight: 600;
        color: var(--c-text);
      }
      tr:nth-child(even) td { background: var(--c-overlay-subtle); }

      /* Blockquote */
      blockquote {
        border-left: 2px solid var(--c-accent);
        padding-left: 12px;
        margin: 8px 0;
        color: var(--c-text-muted);
      }

      /* Links */
      a {
        color: var(--c-accent);
        text-decoration: none;
        border-bottom: 1px solid var(--c-accent-link);
      }
      a:hover { border-bottom-color: var(--c-accent); }

      strong { font-weight: 600; color: var(--c-text-strong); }
      em     { color: var(--c-text-subtle); }

      hr {
        border: none;
        border-top: 1px solid var(--c-border);
        margin: 12px 0;
      }
    }
  `],
})
export class MessageBubbleComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) message!: ChatMessage;
  @Output() runCode = new EventEmitter<string>();

  private readonly observer: MutationObserver;

  constructor(
    private readonly el: ElementRef<HTMLElement>,
    private readonly codeRegistry: CodeRegistryService,
  ) {
    // Watch for innerHTML changes (caused by [innerHTML] binding updates)
    // and attach native click listeners to any .run-code-btn buttons found.
    this.observer = new MutationObserver(() => this.attachRunButtons());
    this.observer.observe(this.el.nativeElement, { childList: true, subtree: true });

    // Reset run buttons to their initial state when execution finishes.
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

  /** Attach native click listeners to every unbound run/copy button in this bubble. */
  attachRunButtons(): void {
    // Run buttons
    const runBtns = this.el.nativeElement.querySelectorAll<HTMLElement>(
      ".run-code-btn:not([data-bound])",
    );
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

    // Copy-code buttons
    const copyBtns = this.el.nativeElement.querySelectorAll<HTMLElement>(
      ".copy-code-btn:not([data-bound])",
    );
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

  readonly thinkingType = ContentBlockType.Thinking;
  readonly imageType    = ContentBlockType.Image;

  lightboxSrc: string | null = null;
  lightboxAlt = "";
  bubbleCopied = false;

  get isUser(): boolean {
    return this.message.role === MessageRole.User;
  }

  asThinking(block: any): ThinkingBlock { return block as ThinkingBlock; }
  asText(block: any): TextBlock          { return block as TextBlock; }
  asImage(block: any): ImageBlock        { return block as ImageBlock; }

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
}
