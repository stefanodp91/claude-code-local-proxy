# Claudio Changelog

All notable changes to the Claudio VS Code extension are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.5.0] — 2026-04-12

### Changed — Python execution moved to proxy

- **Python execution is now handled by the proxy** (`POST /v1/exec-python`).
  The extension's `handleExecuteCode()` is now a thin relay: it streams SSE
  events from the proxy and forwards `progress`/`result` events to the webview.
  ~150 lines of venv management, pip-install, subprocess, and matplotlib
  interception code removed from `chat-session.ts`.

- **Per-workspace venv**: the proxy creates the venv at
  `<workspaceCwd>/.claudio/python-venv` (configurable via `PYTHON_VENV_DIR`),
  not in VS Code's `globalStoragePath`. Each workspace gets its own isolated
  environment.

- **`globalStoragePath` removed from `ChatSession` constructor**: no longer
  needed since the venv is managed by the proxy.

### Changed — Plan exit orchestration moved to proxy

- **`handlePlanExitSuggestion()`** no longer reads the plan file from disk or
  mutates `last.content`. Instead it passes a `planExitPath` argument to
  `runProxyTurn()`, which sends the `X-Plan-Exit-Path` header to the proxy.
  The proxy reads the file and prepends its content server-side.

- **`ProxyRequest.planExitPath`** and **`ProxyClient.execPython()`** added to
  `proxy-client.ts` for the two new extension→proxy interactions.

---

## [1.4.1] — 2026-04-12

### Fixed — Reconnect button now restarts the proxy

- **`ProxyManager.restart()`** (`proxy-manager.ts`): new method that stops the old process,
  waits for the port to be released, and spawns a fresh proxy. Remembers the base port from
  the first `start()` call so callers don't need to track it.

- **`ChatSession.handleReconnect()`** (`chat-session.ts`): the `CheckHealth` handler now
  calls an optional `reconnectFn` before starting the health polling. If the proxy is dead
  and managed by `ProxyManager`, the reconnect function restarts it and updates the session's
  connection URLs (port may change via `findFreePort`).

- **Wiring** (`activation.ts`): `session.setReconnectHandler()` is called after
  `ProxyManager` creation. The handler checks `proxyManager.isRunning` — if the process is
  dead, it restarts and re-wires the port override. If the proxy is already running (e.g.
  temporary network hiccup), only the health check runs.

**Before:** clicking the reconnect button only pinged `/health`. If the proxy had crashed,
the status stayed `Disconnected` and the button appeared to do nothing.

**After:** clicking reconnect detects the dead process, restarts it, and reconnects.

---

## [1.4.0] — 2026-04-12

### Fixed — Multi-window proxy isolation

- **PID file per `proxyDir`** (`proxy-manager.ts`): il file PID era condiviso tra tutte le finestre VSCode dello stesso utente (`globalStoragePath/.claudio-proxy.pid`). Aprendo un secondo progetto con `autoStartProxy: true`, `cleanupOrphan()` uccideva il proxy della prima finestra, lasciandola disconnessa a tempo indefinito. Il file PID ora include un hash del `proxyDir` (`.claudio-proxy-<hash>.pid`), rendendo ogni finestra completamente indipendente.

### Fixed — Intervalli duplicati nell'health checker

- **`HealthChecker.start()` idempotente** (`health-checker.ts`): chiamato due volte in rapida successione (da `attachView` e dal `CheckHealth` della webview), creava intervalli di polling paralleli. `start()` chiama ora `stop()` prima di avviare il nuovo ciclo.

### Added — Pulsante di riconnessione manuale

- **Pulsante `refresh`** in `ToolbarComponent`: visibile solo quando lo stato è `Disconnected`. Al click invia `CheckHealth` all'extension host, che esegue immediatamente un nuovo ciclo di health check (lo stato passa a `Checking` poi a `Connected` o `Disconnected`).
- **i18n**: `status.reconnect` aggiunto a `en.json` ("Reconnect") e `it.json` ("Riconnetti").

---

## [1.3.0] — 2026-04-12

### Added — Thinking detection & toggle

- **`ThinkingProbe`** (`proxy/src/infrastructure/thinkingProbe.ts`) — single HTTP probe that checks whether a model produces `reasoning_content`. Sends a fixed arithmetic prompt with `enable_thinking: true`; result is `true` iff `reasoning_content` is a non-empty string.

- **`ThinkingDetector`** (`proxy/src/infrastructure/thinkingDetector.ts`) — dual-probe orchestrator:
  - Probe #1: `enable_thinking: true` → verifica `supportsThinking`
  - Probe #2 (solo se probe #1 è `true`): `enable_thinking: false` → verifica `thinkingCanBeDisabled`
  - Risultati salvati in `model-cache.json` (merge con `maxTools` esistente). Zero costo per modelli già probati.

- **`supportsThinking` + `thinkingCanBeDisabled`** esposti in `GET /config` → `model` object; propagati via `ProxyModelInfo` in `extension-config.ts` fino alla webview.

- **Thinking toggle** in `InputAreaComponent`:
  - Icona `psychology` (Material Icons) visibile quando `supportsThinking === true`
  - Disabilitato (non cliccabile, `cursor: not-allowed`) quando `thinkingCanBeDisabled === false` (es. Gemma 4 31B)
  - Cliccabile e funzionale quando entrambi i flag sono `true` (es. Qwen3)
  - Tooltip contestuale: "Thinking always on for this model" / "Thinking enabled — click to disable" / "Thinking disabled — click to enable"

- **`SetEnableThinking`** message type (`ToExtensionType`): il webview notifica l'extension host al click del toggle. `ChatSession` aggiorna `config.enableThinking` in-session; applicato alla successiva richiesta via `proxy-client.ts`.

- **`SetAgentMode`** message type (`ToExtensionType`): sincronizza la modalità agente (Ask / Auto / Plan) dal webview all'extension host.

### Changed — Proxy

- **`requestTranslator`**: quando `supportsThinking === true`, il parametro `enable_thinking` è sempre esplicito (`true` o `false`). Senza questo, alcuni backend (es. LM Studio con Qwen3) ignorano `enable_thinking: false` e continuano a generare reasoning. Ora il disable è effettivo.

- **`nativeAgentLoopService`**: iter-0 convertito a streaming — i token del primo turno appaiono in real-time invece di arrivare tutti alla fine.

- **Fallback non-streaming** in `fetchLlmClient`: se il backend risponde con `Content-Type: application/json` nonostante `stream: true`, la risposta viene normalizzata e processata senza errore.

### Changed — Webview Refactoring (breaking-free)

- **Tutti i componenti** ora hanno file separati `.ts` / `.html` / `.scss` (nessun template o stile inline).
- **`AgentMode`** e **`ToolAction`** — nuovi enum in `core/enums/`; tutti i componenti li usano al posto di stringhe hardcoded.
- **`ModeSelectorComponent`** (`features/chat/mode-selector/`) — estratto da `InputAreaComponent` come componente standalone con template e stili propri.
- **i18n completa** — nessuna stringa hardcoded nei template o nei getter TypeScript: tutte le label usano il pipe `translate` o `TranslateService.instant()`.
- **Bootstrap utilities** — le classi di layout (`d-flex`, `flex-grow-1`, `gap-*`, `align-items-center`, ecc.) sono ora espresse direttamente nell'HTML; il CSS custom è limitato a colori del design system e animazioni.
- **`tool-approval-modal`** + **`plan-exit-modal`**: `CommonModule` rimosso, `TranslateModule` aggiunto; header e bottoni usano chiavi i18n e `ToolAction` enum.
- **`chat-container`**: `StreamingService` inizializzato con `inject()` nel costruttore (side-effect only, nessuna proprietà dichiarata inutilizzata).

---

## [1.2.0] — 2026-04-11

### Added

- **`ToolApprovalModalComponent`** — visualizza le richieste di approvazione tool in attesa (action, path, diff preview per write). Approvazione singola o globale per il turno.
- **`PlanExitModalComponent`** — dialog di conferma per l'uscita da Plan mode suggerita dal proxy.
- **`ModalShellComponent`** (`shared/components/`) — shell modale riutilizzabile: backdrop, slot header/body/footer, animazione fade-in.
- **`NotificationBannerComponent`** (`shared/components/`) — banner non bloccante per eventi in-stream (`plan_file_created`, `plan_mode_exit_suggestion`).

### Changed

- **Mode selector** — rimpiazzato `MatMenu` di Angular Material con dropdown custom dark:
  - Dot colorati per modalità: arancione (Ask), verde (Auto), viola (Plan)
  - Bottone trigger compatto con label breve + chevron animato
  - Panel nativo al design system: background `--c-surface-2`, border `--c-border-2`, shadow profondo
  - Ogni opzione mostra nome + descrizione breve su due righe
  - Checkmark `--c-accent` sull'opzione attiva

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
