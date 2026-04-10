import { Pipe, PipeTransform } from "@angular/core";
import { DomSanitizer, type SafeHtml } from "@angular/platform-browser";
import { Marked } from "marked";
import katex from "katex";
import { CodeRegistryService } from "../services/code-registry.service";

const LATEX_BLOCK_RE = /\$\$([\s\S]*?)\$\$/g;
const LATEX_INLINE_RE = /\$([^\n$]+?)\$/g;
const LATEX_DISPLAY_RE = /\\\[([\s\S]*?)\\\]/g;
const LATEX_INLINE_ALT_RE = /\\\(([\s\S]*?)\\\)/g;

const PYTHON_LANGS = new Set(["python", "py"]);

@Pipe({ name: "markdown", standalone: true, pure: true })
export class MarkdownPipe implements PipeTransform {
  private readonly marked: Marked;

  constructor(
    private readonly sanitizer: DomSanitizer,
    private readonly codeRegistry: CodeRegistryService,
  ) {
    this.marked = this.buildMarked();
  }

  private buildMarked(): Marked {
    const instance = new Marked();
    const registry = this.codeRegistry;

    instance.use({
      renderer: {
        code({ text, lang }: { text: string; lang?: string }): string {
          const isPython = PYTHON_LANGS.has((lang ?? "").toLowerCase());
          const escaped = escapeHtml(text);
          const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
          const runBtn = isPython
            ? `<button class="run-code-btn" data-code-id="${registry.register(text)}">&#9654; Run</button>`
            : "";
          const copyBtn = `<button class="copy-code-btn">Copy</button>`;
          const header = `<div class="code-header">${langLabel}<div class="code-actions">${runBtn}${copyBtn}</div></div>`;
          return `<div class="code-block-wrap">${header}<pre><code>${escaped}</code></pre></div>`;
        },
      },
    });
    return instance;
  }

  transform(value: string | null | undefined): SafeHtml {
    if (!value) {
      return "";
    }

    // Step 1: Extract and protect LaTeX blocks with placeholders
    const latexMap = new Map<string, string>();
    let counter = 0;

    let processed = value;
    processed = processed.replace(LATEX_BLOCK_RE, (_, expr) => {
      const key = `%%LATEX_${counter++}%%`;
      latexMap.set(key, renderLatex(expr.trim(), true));
      return key;
    });
    processed = processed.replace(LATEX_DISPLAY_RE, (_, expr) => {
      const key = `%%LATEX_${counter++}%%`;
      latexMap.set(key, renderLatex(expr.trim(), true));
      return key;
    });
    processed = processed.replace(LATEX_INLINE_ALT_RE, (_, expr) => {
      const key = `%%LATEX_${counter++}%%`;
      latexMap.set(key, renderLatex(expr.trim(), false));
      return key;
    });
    processed = processed.replace(LATEX_INLINE_RE, (_, expr) => {
      const key = `%%LATEX_${counter++}%%`;
      latexMap.set(key, renderLatex(expr.trim(), false));
      return key;
    });

    // Step 2: Render markdown
    let html = this.marked.parse(processed) as string;

    // Step 3: Restore LaTeX HTML
    for (const [key, latex] of latexMap) {
      html = html.replace(key, latex);
    }

    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}

function renderLatex(expr: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expr, {
      displayMode,
      throwOnError: false,
      output: "html",
    });
  } catch {
    return `<code class="latex-error">${escapeHtml(expr)}</code>`;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
