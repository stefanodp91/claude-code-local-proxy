# Changelog

All notable changes to the proxy and Claudio extension are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.2.0] — 2026-04-11

### Changed — Proxy: SOLID/hexagonal architecture refactor (Fix 8)

- **`server.ts` ridotto da 1633 → 280 righe** — ora è un puro composition root + HTTP router.
  Zero business logic: nessun `fetch()` diretto, nessun `readFileSync`, nessun loop agente.

- **Nuovi service estratti** (`application/services/`):
  - `NativeAgentLoopService` — Path A agent loop (tool_calls nativi); metodo `processToolCall()` condiviso tra iter-0 e iter-1+, elimina la duplicazione precedente
  - `ApprovalGateService` — macchina a stati per approvazioni (ask/auto/plan, trusted files, auto-approve allowlist)
  - `SystemPromptBuilder` — costruzione del system prompt via `PromptRepositoryPort` + `PlanFileRepositoryPort`

- **Nuovi use case** (`application/useCases/`):
  - `HandleChatMessageUseCase` — orchestrazione completa di `POST /v1/messages` (slash intercept → system prompt → compaction → translate → route → stream)
  - `ResolveApprovalUseCase` — `POST /v1/messages/:id/approve`

- **Nuovi adapter infrastrutturali** (`infrastructure/adapters/`):
  - `FetchLlmClient` — implementa `LlmClientPort` via `fetch()` globale
  - `NodeSseWriter` — implementa `SseWriterPort` via `ServerResponse` Node.js
  - `FsPlanFileRepository` — implementa `PlanFileRepositoryPort` via `node:fs`
  - `FsPromptRepository` — implementa `PromptRepositoryPort` via `node:fs`
  - `SseApprovalInteractor` — implementa `ApprovalInteractorPort` via SSE custom event + promise resolver
  - `SystemClock` — implementa `ClockPort` via `Date.now()`
  - `autoApproveConfig` — helpers `loadOldContent` e `checkAutoApprove` per `.claudio/auto-approve.json`

- **Nuovi file infrastrutturali**:
  - `infrastructure/toolLimitDetector.ts` — strategia override/cache/probe per `maxTools`

- **Domain layer**:
  - `domain/entities/workspaceAction.ts` — `WorkspaceAction`, `ActionClass`, `ActionArgs`, `WORKSPACE_TOOL_DEF` spostati dal layer infrastrutturale al dominio puro
  - `domain/ports/` barrel — re-export di tutti i port types da un unico punto

- **Textual agent loop** (`application/textualAgentLoop.ts`) ora usa `SseWriterPort` + `LlmClientPort` invece di `ServerResponse` e URL diretto

### Added — Chat Extension: UI improvements (Fix 7 + mode selector)

- **`ToolApprovalModalComponent`** — modal che visualizza le richieste di approvazione tool in attesa: nome action, path, preview diff side-by-side per `write`, pulsanti Approve / Approve All / Deny
- **`PlanExitModalComponent`** — dialog di conferma per l'uscita da Plan mode
- **`ModalShellComponent`** (`shared/components/`) — shell modale riutilizzabile con backdrop, animazione, slot header/body/footer
- **`NotificationBannerComponent`** (`shared/components/`) — banner non bloccante per notifiche in-stream (`plan_file_created`, `plan_mode_exit_suggestion`, ecc.)
- **Mode selector redesign** — sostituito `MatMenu` di Angular Material con panel custom dark:
  - Indicatori dot colorati per modalità (arancione=Ask, verde=Auto, viola=Plan) visibili sia nel bottone trigger che nelle voci dropdown
  - Bottone compatto: `● Ask / Auto / Plan` + chevron animato
  - Panel: `--c-surface-2` + `--c-border-2` + shadow del design system; ogni voce ha nome + descrizione breve
  - Chiusura su click esterno (stesso `@HostListener` del slash menu)

---

## [1.1.0] — 2026-04-10

### Added — Proxy lifecycle management

- **`ProxyManager`** (`chat-extension/src/extension/proxy/proxy-manager.ts`):
  new VS Code disposable that spawns, monitors and kills the proxy child process.
  Registered in `context.subscriptions` so the proxy is automatically stopped
  when the VS Code window closes or the extension is deactivated.

- **Port discovery**: each consumer instance (VS Code window, CLI session) finds
  the first available port starting from `claudio.proxyPort` (default 5678) via
  `net.createServer()` (TypeScript) or `lsof` (bash). Multiple parallel agents
  run on independent ports without conflicts.

- **PID file** (`globalStoragePath/.claudio-proxy.pid`): written on spawn, read on
  the next `activate()` to kill orphan proxies left over after a VS Code crash.

- **`claudio.proxyDir`** VS Code setting: absolute path to the `proxy/` directory.
  Supports `${workspaceFolder}`. Empty = external proxy (backward-compatible default).

- **`claudio.autoStartProxy`** VS Code setting: when `true` (default), `ProxyManager`
  is activated automatically. Set to `false` to manage the proxy manually.

- **`.vscode/settings.json`** in repo root: plug-and-play workspace settings
  (`claudio.proxyDir`, `claudio.proxyHost`, `claudio.proxyPort`, `claudio.autoStartProxy`).
  Cloning the repo and opening it in VS Code with Claudio installed is all that's needed.

- **`start_agent_cli.sh`**: new unified CLI script. Performs port discovery
  (`find_free_port`), spawns the proxy, waits for `/health`, presents an interactive
  model selector if `ANTHROPIC_MODEL` is unset, launches Claude Code, and kills the
  proxy automatically on exit via `trap`.

### Removed

- **`start.sh`**: functionality absorbed by `start_agent_cli.sh`.
- **`start_claude_code.sh`**: functionality absorbed by `start_agent_cli.sh`.

---

### Added — Proxy (previously unreleased)

- **Slash command interceptor** (`proxy/src/application/slashCommandInterceptor.ts`): intercepts slash commands from incoming requests before the LLM is called. Three result types:
  - `synthetic` — immediate SSE response without any LLM call (e.g. `/status`, `/version`, Anthropic-blocked commands)
  - `enrich` — replaces the last message with enriched content, then proceeds to LLM (e.g. `/commit`, `/diff`, `/review`)
  - `passthrough` — not a handled command, normal flow continues
  - Proxy-handled commands: `/status`, `/version`, `/commit`, `/diff`, `/review`, `/compact`, `/brief`, `/plan`
  - Client-handled commands (registry only, no proxy logic): `/copy`, `/files`, `/simplify`, `/branch`, `/commit-push-pr`, `/pr-comments`, `/clear`
  - Blocked Anthropic-specific commands: `/login`, `/logout`, `/upgrade`, `/cost`, `/usage`, and 20+ others return a synthetic explanatory message

- **Workspace tool** (`proxy/src/application/workspaceTool.ts`): OpenAI-format tool definition for filesystem exploration inside the workspace root:
  - `action: "list"` — lists directory contents with `[dir]`/`[file]` markers
  - `action: "read"` — reads file content (max 50KB, truncated if larger)
  - `safeResolve()` — security check that prevents path traversal outside the workspace root
  - Static summary fallback (`buildWorkspaceContextSummary()`): when models don't support tools, injects top-level listing + `package.json` + `README.md` (first 2000 chars) as a system prompt text block

- **Agentic workspace exploration loop** (in `src/infrastructure/server.ts`): when the client sends the `X-Workspace-Root` header and `maxTools > 0`, the server runs up to 10 non-streaming rounds with only the `workspace` tool active. The model reads files, builds context, and the loop exits when the model produces a text response. The final result is returned as a single streaming response to the client.

- **Persistent model cache** (`proxy/src/infrastructure/persistentCache.ts`): generic JSON file-backed key-value cache. Used to store `{ "<modelId>": { "maxTools": N } }` in `proxy/model-cache.json`. On startup, if the current model is found in cache, the expensive binary search probe is skipped entirely.

- **Split initialization sequence** (in `proxy/src/main.ts` and `proxy/src/infrastructure/server.ts`):
  - `proxy.initialize()` — fast path: loads locale + fetches model info (~100–300ms)
  - `proxy.start()` — starts the HTTP server immediately after initialize(); health checks pass at this point
  - `proxy.initializeTools()` — background: checks cache or runs binary search probe + wires translators (3–30s). Requests arriving before this completes receive `503 Proxy is still initializing`.

- **`PROBE_TIMEOUT` config variable**: timeout in milliseconds for each individual probe fetch request (default: 30,000ms). Previously the probe had no timeout.

- **Chat defaults config variables** (exposed via `GET /config` to chat clients like Claudio):
  - `TEMPERATURE` — default LLM temperature (default: 0.7)
  - `SYSTEM_PROMPT` — optional system prompt prepended to every conversation (default: empty)
  - `ENABLE_THINKING` — whether to send `thinking:{type:"enabled"}` to the model (default: 1)

- **`GET /config` endpoint**: returns proxy runtime configuration including model info, temperature, system prompt, locale, maxTokensFallback. Used by Claudio to auto-configure itself.

- **`GET /commands` endpoint**: returns the full slash command registry (`SLASH_COMMAND_REGISTRY`). Used by Claudio to show command autocomplete.

### Added — Claudio (new)

- **`chat-extension/`** — new VS Code extension providing a chat UI for the proxy:
  - Extension host: TypeScript compiled with esbuild to `dist/extension.js`
  - Webview UI: Angular 19 compiled with Angular CLI to `dist/webview-ui/`
  - Sidebar view registered in VS Code Activity Bar (icon: `media/claudio.svg`)
  - VS Code settings: `claudio.proxyHost` (default: `http://127.0.0.1`) and `claudio.proxyPort` (default: 5678)

- **Streaming chat**: `ProxyClient.sendMessage()` sends Anthropic Messages API requests to the proxy and yields SSE events as an async generator. The webview receives each chunk and appends it in real-time.

- **Markdown + KaTeX rendering**: messages rendered with `marked` (syntax highlighting via `marked-highlight`) and math expressions with KaTeX.

- **Python code execution** (in `ChatSession`): detects Python code blocks, creates a venv at `.claudio-venv` in VS Code global storage, auto-installs missing packages (matplotlib, numpy, pandas, scipy), executes code via subprocess, captures stdout. matplotlib `plt.show()` is intercepted and replaced with file save + base64 PNG returned to the webview.

- **File attachments**: `handleReadFiles()` reads files from the workspace, converts images (PNG, JPG, GIF, WebP) to base64 image blocks, and text files to fenced code blocks. Attached to the next message as Anthropic content blocks.

- **Client-side slash commands**: `/files` (lists open workspace files), `/simplify` (sends active editor file for code review), `/copy` (clipboard via webview bridge), `/branch` (opens terminal), `/commit-push-pr` (opens terminal), `/pr-comments` (opens terminal), `/clear` (clears history).

- **Health monitoring**: `HealthChecker` polls `GET /health` every 10 seconds. Connection status is sent to the webview (`connected` / `disconnected` / `checking`). On reconnect, proxy config is refreshed via `GET /config`.

- **i18n**: English (`en.json`) and Italian (`it.json`) translations via `@ngx-translate/core`. Language follows the proxy's `locale` config.

- **Typed message protocol** (`chat-extension/src/shared/message-protocol.ts`): all messages between extension host and webview use typed enums (`ToWebviewType`, `ToExtensionType`) with typed payloads.

---

## [1.0.0] — 2026-03-31

### Added — Proxy

- Initial Anthropic-to-OpenAI translation proxy
- Full SSE streaming: Anthropic SSE events translated from OpenAI SSE chunks via a state machine (`StreamStateMachine`)
- Dynamic tool selection with additive scoring algorithm (core tools, promoted, history, forced choice)
- `UseTool` meta-tool: overflow tools listed in a single meta-tool, proxy transparently rewrites the LLM response to the real tool name
- Auto-promotion with decay: tools invoked via UseTool are promoted for `PROMOTION_MAX_AGE` requests
- Binary search tool probe (`ToolProbe.detect()`): auto-detects model's maximum tool count at startup
- Model info fetch from LM Studio's `/api/v0/models` endpoint: architecture, quantization, context length, capabilities
- `max_tokens` capping: prevents runaway generation by capping Claude Code's `max_tokens=32000+` to `loadedContextLength / CONTEXT_TO_MAX_TOKENS_RATIO`
- Hexagonal architecture: domain (pure types + i18n), application (translators + tool manager), infrastructure (server + config + logger)
- i18n: locale files in `proxy/locales/`, `t()` function with `{{param}}` interpolation
- `start.sh` orchestrator: loads `.env.proxy`, checks prerequisites (node, LLM server, port), starts proxy in background, waits for health check, launches Claude Code, kills proxy on exit
- `start_claude_code.sh` launcher: loads env files, resolves `${PROXY_PORT}`, interactive model selection, `exec claude`
- Thinking block translation: `reasoning_content` from OpenAI responses mapped to Anthropic `thinking` content blocks
- Stop reason mapping: `finish_reason` → `stop_reason` (end_turn, tool_use, max_tokens)
