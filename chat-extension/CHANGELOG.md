# Claudio Changelog

All notable changes to the Claudio VS Code extension are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.0] — 2026-04-10

### Added — Proxy lifecycle management

- **`ProxyManager`** (`src/extension/proxy/proxy-manager.ts`):
  new VS Code disposable that spawns, monitors and kills the proxy child process.
  Registered in `context.subscriptions` so the proxy is automatically stopped
  when the VS Code window closes or the extension is deactivated.

- **Port discovery**: each VS Code window finds the first available port starting from
  `claudio.proxyPort` (default 5678) using `net.createServer()`. Multiple windows run
  independent proxy instances on independent ports without conflicts.

- **PID file** (`globalStoragePath/.claudio-proxy.pid`): written on spawn, read on
  the next `activate()` to kill orphan proxies left over after a VS Code crash.

- **`claudio.proxyDir`** VS Code setting: absolute path to the `proxy/` directory.
  Supports `${workspaceFolder}`. Empty = external proxy (backward-compatible default).

- **`claudio.autoStartProxy`** VS Code setting: when `true` (default), `ProxyManager`
  is activated automatically. Set to `false` to manage the proxy manually.

- **`.vscode/settings.json`** in repo root: plug-and-play workspace settings
  (`claudio.proxyDir`, `claudio.proxyHost`, `claudio.proxyPort`, `claudio.autoStartProxy`).
  Cloning the repo and opening it in VS Code with Claudio installed is all that's needed.

---

## [0.1.0] — 2026-03-31

### Added — Initial release

- **Extension host** (`src/extension/`): TypeScript extension compiled with esbuild to `dist/extension.js`
- **Webview UI** (`src/webview-ui/`): Angular 19 compiled to `dist/webview-ui/`
- **Sidebar view** registered in VS Code Activity Bar (icon: `media/claudio.svg`)
- **VS Code settings**: `claudio.proxyHost` (default: `http://127.0.0.1`) and `claudio.proxyPort` (default: 5678)

- **Streaming chat**: `ProxyClient.sendMessage()` sends Anthropic Messages API requests to the proxy and yields SSE events as an async generator. The webview receives each chunk and appends it in real-time.

- **Markdown + KaTeX rendering**: messages rendered with `marked` (syntax highlighting via `marked-highlight`) and math expressions with KaTeX.

- **Python code execution**: detects Python code blocks, creates a venv at `.claudio-venv` in VS Code global storage, auto-installs missing packages (matplotlib, numpy, pandas, scipy), executes code via subprocess, captures stdout. matplotlib `plt.show()` is intercepted and replaced with file save + base64 PNG returned to the webview.

- **File attachments**: `handleReadFiles()` reads files from the workspace, converts images (PNG, JPG, GIF, WebP) to base64 image blocks, and text files to fenced code blocks.

- **Client-side slash commands**: `/files`, `/simplify`, `/copy`, `/branch`, `/commit-push-pr`, `/pr-comments`, `/clear`.

- **Health monitoring**: `HealthChecker` polls `GET /health` every 10 seconds. On reconnect, proxy config is refreshed via `GET /config`.

- **i18n**: English (`en.json`) and Italian (`it.json`) translations via `@ngx-translate/core`.

- **Typed message protocol** (`src/shared/message-protocol.ts`): all messages between extension host and webview use typed enums (`ToWebviewType`, `ToExtensionType`) with typed payloads.
