import { Directive, ElementRef, AfterViewInit, OnDestroy, Input } from "@angular/core";

const SCROLL_THRESHOLD = 50;

@Directive({ selector: "[appAutoScroll]", standalone: true })
export class AutoScrollDirective implements AfterViewInit, OnDestroy {
  @Input() appAutoScroll = true;

  private observer: MutationObserver | null = null;
  private userScrolledUp = false;

  constructor(private readonly el: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    const element = this.el.nativeElement;

    element.addEventListener("scroll", this.onScroll);

    this.observer = new MutationObserver(() => {
      if (!this.userScrolledUp && this.appAutoScroll) {
        this.scrollToBottom();
      }
    });

    this.observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.el.nativeElement.removeEventListener("scroll", this.onScroll);
  }

  private readonly onScroll = (): void => {
    const el = this.el.nativeElement;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.userScrolledUp = distanceFromBottom > SCROLL_THRESHOLD;
  };

  private scrollToBottom(): void {
    const el = this.el.nativeElement;
    el.scrollTop = el.scrollHeight;
  }
}
