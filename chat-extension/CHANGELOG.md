# Claudio Changelog

All notable changes to the Claudio VS Code extension are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — 2026-08-27

### Fixed — A disposed session left the proxy waiting, and hung CI proving it

- **The suite passed locally and hung the first CI run for half an hour.** The
  tests slept a fixed 40 ms for the stream to reach its `tool_request_pending`
  event; on a slower machine the answer arrived first, nothing resolved the
  pending request, and each affected test sat on the session's five-minute
  timeout. A sleep is a race whose loser is always the slower machine. Every one
  is now a wait-for-condition that fails with a message instead of hanging, and
  both `test` scripts pass `--test-timeout 60000` so a hang costs a minute rather
  than a runner.

- **The leak it exposed is real, not a test artefact.** `dispose()` did not
  clear pending approvals: closing a VS Code window with a modal open left the
  five-minute timer and its promise alive, and the *proxy* holding that turn open
  waiting for an answer nobody could give. Disposing now denies whatever is
  pending — the view is gone, so that is the honest answer — and clears the
  timers. One test, one negative control that fails after the full five seconds
  it takes to notice.

- Sessions are disposed in `afterEach` rather than at the end of each test, so a
  *failing* test cannot leave one behind either.

### Added — `ProxyManager` has a suite (10 tests), and two faults it found

The 223 lines that spawn the proxy, wait for it, and kill it. The tests spawn a
real child — a five-line HTTP server standing in for the proxy, in a temporary
directory with its own `package.json` — because spawn, wait and kill cannot be
faked into meaning anything.

- **A five-second timer outlived every stop.** `stop()` arms a SIGKILL fallback;
  nothing cleared it when the child actually exited, so it sat holding the event
  loop with nothing left to kill. In VS Code that delays the host's shutdown; in
  a test process it hangs the run — the same leak with a louder voice. Cleared on
  the child's `exit` now.

- **A broken proxy directory cost thirty seconds of silence.** The child exits
  within a second — no start script, missing dependencies — and the manager kept
  polling `/health` for its full deadline before saying anything, so the user
  watched a spinner for half a minute with the reason already in the output
  channel. It now notices the exit, says so, and surfaces an error. The suite
  went from 40 s to 11 s on that change alone.

- Also covered: the reported port is the port the proxy actually took (they
  disagree and every poll goes to the wrong place), an occupied port is stepped
  over, `.env.proxy` reaches the child while `PROXY_PORT` still wins, the PID
  file is written and removed, and an orphan from a crashed window is killed
  before a new proxy starts.

- 62 tests in the extension now. Negative control: leaving the timer armed fails
  exactly 1, polling a dead child fails exactly 1 (after the full 30 s, which is
  the point), and dropping the PID file fails exactly 3.

### Added — `scripts/plan-mode-e2e.ts`

- Drives plan mode end to end against a running proxy: the plan is written, the
  workspace is left untouched while planning, the plan is executed on exit, and
  the file it edits keeps what was already there.

- It retries the planning turn, and that is a finding rather than a workaround:
  **plan mode is model-dependent**. Across runs the model wrote a plan and
  stopped, wrote a plan and called `exit_plan_mode`, and called `exit_plan_mode`
  immediately without writing anything at all.

- The run that produced this script also found three faults on the proxy side —
  see the proxy changelog for 2026-08-27.

### Added — The extension has tests (52), and the approval handshake was run for real

- **From zero.** `package.json` had no `test` script at all: 2 090 lines of
  extension host and an Angular webview, verified by `tsc --noEmit` and nothing
  else. The proxy went from 0 to 348 tests over the same period; this side had
  stayed at 0, and it is the surface the user actually touches.

- **41 host tests** — the SSE parser (a frame split across chunks, one character
  at a time, a stream that ends without its blank line), the proxy client (the
  workspace header that *selects the agent loop at all*, the plan-exit header,
  the thinking flag, an approval posted to the right id with the right scope),
  the health poller (every status transition, and that `stop()` really stops),
  and `chat-session`'s approval bridge.

- **11 webview tests** — `StreamingService` reassembling deltas into the message
  on screen: text and thinking kept apart, a tool call's arguments accumulated
  across fragments, a stream that ends without `message_stop` still finalising
  rather than leaving a spinner for ever.

- **`node:test` + `tsx`, the proxy's runner**, so the repo has one way of writing
  tests rather than two. `vscode` resolves to `test/stubs/vscode.ts` through
  `tsconfig.test.json` only: `npm run typecheck` still checks the host against
  the real `@types/vscode`, so a call that does not exist still fails there.

- **What this does not cover, stated rather than implied:** no Angular template
  is ever rendered. That needs a browser environment and a second runner, and
  the choice was to keep one.

- **`scripts/approval-e2e.ts`** drives the real handshake against a running proxy
  and a loaded model, using the shipped `ProxyClient` and simulating only the
  click. Verified 2026-08-27 against `qwen/qwen3.8-27b`: an approved write lands
  on disk, a denied one writes nothing and the model says so, `scope: "turn"`
  raises one modal for two writes, and an unknown approval id neither throws nor
  hangs. It needs a live backend, so it cannot run in CI — the extension's
  `regression.sh`.

- Negative control on five fronts, each failing narrowly: dropping the SSE
  partial-frame buffer, resolving any pending approval regardless of id,
  dropping the scope on the way to the proxy, dropping the workspace header, and
  removing the webview's `ngOnDestroy` unsubscribe.

- One test was wrong before the code was: it assumed two approval modals could
  be open at once. The stream *awaits* each decision, so they are strictly
  sequential — which is the safer behaviour and now the asserted one.

---

## [Unreleased] — 2026-08-26

### Documentation — cross-session memory is no longer absent

- **`feature-gap.md` listed cross-session memory as ABSENT.** The proxy now
  prepends `.claudio/MEMORY.md` to the system prompt when it exists (see
  `MEMORY_FILE` in the proxy configuration reference).

  There is nothing to build on the Claudio side: the memory is workspace state,
  not extension state, and the model updates it through the ordinary `write`
  action — so an update surfaces in Claudio's existing approval modal like any
  other write to disk. Recorded as PRESENT (proxy) with that noted, rather than
  left in the parity backlog it no longer belongs to.


### Documentation — stale packaging references and dead code anchors

- **`claudio-0.1.0.vsix`** appeared in the README, `quick-start.md`,
  `troubleshooting.md` and `architecture.md` as the file to install. The
  packaged artifact is `claudio-1.5.0.vsix`, so every copy-pasted install
  command failed.

- **`feature-gap.md` anchors pointed into `proxy/src/infrastructure/server.ts`**
  at lines 234-253, 289-306, 432-434 and 465 — a file that is now 416 lines
  long, having lost that logic to the hexagonal refactor. Re-pointed at
  `handleChatMessageUseCase.ts` (routing), `sseApprovalInteractor.ts` (the
  `tool_request_pending` emission) and `systemPromptBuilder.ts` (prompt
  assembly). Same for the client-side ones: the slash-command range pointed at
  plan-exit handling, and the persistence anchor at `clearHistory()`.

- **`feature-gap.md` claimed 13 proxy-side slash commands.** There are 8, out of
  15 in `SLASH_COMMAND_REGISTRY`; six of the remaining seven are handled in
  `chat-session.ts` and `/clear` never leaves the webview.

- **The agent-loop rows described iteration 0 as non-streaming** ("iter 1+
  streamed"). All iterations stream; iteration 0 is only a fallback guard.

- **`architecture.md` contradicted itself**: the Tool Use section header said
  `tool_use` visualization was "still absent" while the subsection below it
  documented the implemented pipeline in detail. Also refreshed the line counts
  in the key-files table (`chat-session.ts` 557 → 704, and four others), added
  the missing `src/shared/` folder to the directory map, and fixed a dead
  cross-doc anchor.

- **`slash-commands.md`** showed `/status` and `/version` returning proxy v1.1.0;
  the package is at 1.4.0, and the doc now names `proxy/package.json` as where
  that number comes from.


### Fixed — View mutual exclusivity never actually happened

- **`ChatSession.detachView()`** now invokes `activeViewDisposeFn` instead of
  discarding it. The field was assigned in `attachView()` and nulled in
  `detachView()` without ever being called, so the "close previous view"
  behaviour promised by both docstrings did not exist: opening the panel while
  the sidebar was attached left the old view on screen with a dead bridge
  behind it. The handle is cleared before being invoked — disposing a
  `WebviewPanel` fires its own `onDidDispose`, which re-enters `detachView()`.

- **`SidebarProvider`** passed `() => webviewView.dispose()`, but
  `vscode.WebviewView` has no `dispose()` — a view in the Activity Bar cannot
  be closed programmatically. This was the repository's only `tsc --noEmit`
  error. It now passes a documented no-op.

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
