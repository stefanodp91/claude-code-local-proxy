# Claudio — Architecture

> Struttura interna dell'estensione VS Code per sviluppatori che vogliono contribuire o estendere Claudio.

---

## High-Level Overview

Claudio ha tre componenti principali che comunicano tra loro:

```
┌──────────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js / TypeScript)        │
│                                                       │
│  activation.ts ──> ChatSession (singleton)            │
│      │                                                │
│      ├── ProxyClient      (HTTP + SSE streaming)      │
│      ├── HealthChecker    (polling /health ogni 10s)  │
│      ├── Python executor  (subprocess + venv)         │
│      └── WebviewBridge    (postMessage bus)           │
└────────────────────┬──────────────────────────────────┘
                     │
          postMessage (typed protocol)
          ToWebviewMessage / ToExtensionMessage
                     │
┌────────────────────▼──────────────────────────────────┐
│  Webview (Angular 19 + Bootstrap)                     │
│                                                       │
│  ChatContainerComponent                               │
│  ├── MessageListComponent    (history + streaming)    │
│  ├── InputAreaComponent      (input + attachments)    │
│  ├── ToolbarComponent        (settings + actions)     │
│  └── ConnectionIndicator     (proxy status)           │
│                                                       │
│  Services: VscodeApiService, WebviewBridgeService,    │
│            StreamingService, MessageStoreService       │
└────────────────────┬──────────────────────────────────┘
                     │
          HTTP POST /v1/messages
          (Anthropic Messages API + SSE)
                     │
┌────────────────────▼──────────────────────────────────┐
│  Proxy (Node.js + tsx)                                │
│  http://127.0.0.1:5678                                │
│                                                       │
│  POST /v1/messages  ──>  translate  ──>  LLM backend  │
│  GET  /config       ──>  runtime config               │
│  GET  /commands     ──>  slash command registry       │
│  GET  /health       ──>  {"status":"ok"}              │
└───────────────────────────────────────────────────────┘
```

---

## Extension Host — Directory Map

```
src/extension/
├── activation.ts              # Entry point: registers commands, sidebar, and ProxyManager
├── chat-session.ts            # Singleton: session logic, all handlers
│
├── commands/
│   └── open-chat.command.ts   # Handler for claudio.openChat command
│
├── config/
│   └── extension-config.ts    # VS Code settings + GET /config merge + port override
│
├── enums/
│   └── (command IDs)          # VS Code command enum IDs
│
├── models/
│   └── chat-message.model.ts  # Conversation message types
│
├── proxy/
│   ├── proxy-manager.ts       # Proxy child process lifecycle (spawn/kill/health)
│   ├── proxy-client.ts        # HTTP client: POST /v1/messages, yield SSE events
│   ├── health-checker.ts      # Poll /health every 10s, emit ConnectionStatus
│   └── sse-parser.ts          # Stateful SSE parser (handles partial chunks)
│
└── webview/
    ├── chat-panel.ts          # Opens a WebviewPanel (side-by-side)
    ├── sidebar-provider.ts    # Implements WebviewViewProvider (sidebar)
    ├── webview-bridge.ts      # Bidirectional message bus (on/send)
    └── content-provider.ts    # Generates the HTML shell for the Angular app
```

**Key files:**

| File | Lines (approx.) | Responsibility |
|------|-----------------|----------------|
| `chat-session.ts` | 557 | Central singleton: all handlers, conversation state, Python, attachments |
| `proxy-manager.ts` | 190 | Proxy child process lifecycle: spawn, port discovery, orphan cleanup, kill |
| `proxy-client.ts` | 128 | Async generator HTTP client yielding SSE events |
| `extension-config.ts` | 130 | VS Code settings + proxy `/config` merge + runtime port override |
| `content-provider.ts` | 63 | HTML shell with CSP, import map, dist/webview-ui/ references |
| `webview-bridge.ts` | 47 | Typed wrapper around `panel.webview.postMessage()` |
| `activation.ts` | 55 | Entry point: ProxyManager, ChatSession, commands, sidebar |

---

## ProxyManager — Proxy Lifecycle

`ProxyManager` manages the proxy child process. It is instantiated in `activation.ts`
and registered as a VS Code disposable so the proxy is automatically killed when
the extension deactivates (VS Code window closes).

```
activate()
  │
  ├── loadVsCodeSettings()
  │     proxyDir = "${workspaceFolder}/proxy"  ← from .vscode/settings.json
  │     autoStartProxy = true
  │     proxyPort = 5678 (base)
  │
  ├── ProxyManager(proxyDir, globalStoragePath, outputChannel)
  │     │
  │     ├── cleanupOrphan()
  │     │     └── read globalStoragePath/.claudio-proxy.pid
  │     │           → SIGTERM old process (handles VS Code crash recovery)
  │     │
  │     ├── findFreePort(5678)
  │     │     └── net.createServer() probe loop → 5679 (example)
  │     │
  │     ├── parseEnvFile(proxy/.env.proxy)
  │     │
  │     ├── spawn: npx --prefix proxy tsx proxy/src/main.ts
  │     │         env: { PROXY_PORT: "5679", TARGET_URL: ..., ... }
  │     │         stdout/stderr → "Claudio Proxy" OutputChannel
  │     │
  │     ├── write PID → globalStoragePath/.claudio-proxy.pid
  │     │
  │     └── waitForHealth(5679, 30s)
  │           polls http://127.0.0.1:5679/health every 1s
  │
  ├── setProxyPortOverride(5679)
  │     loadVsCodeSettings() returns port=5679 for this session
  │
  └── ChatSession → http://127.0.0.1:5679
        HealthChecker polls /health every 10s → ● Connected

deactivate() / context.subscriptions.dispose()
  └── ProxyManager.dispose() → stop()
        ├── SIGTERM to proxy process
        ├── setTimeout 5s → SIGKILL if still alive
        └── delete .claudio-proxy.pid
```

**ProxyManager VS Code settings:**

| Setting | Type | Default | Description |
|---|---|---|---|
| `claudio.proxyDir` | string | `""` | Absolute path to `proxy/`. Supports `${workspaceFolder}`. Empty = external proxy. |
| `claudio.autoStartProxy` | boolean | `true` | Enable automatic proxy lifecycle. Requires `proxyDir`. |
| `claudio.proxyPort` | number | `5678` | Base port for discovery. Actual port may differ. |

---

## Webview UI — Directory Map

```
src/webview-ui/src/app/
│
├── app.component.ts                    # Root component (bootstrap Angular)
│
├── core/
│   ├── models/                         # Tipi dati (ChatMessage, Attachment, ecc.)
│   ├── enums/                          # Enum (MessageRole, ContentType, ecc.)
│   └── services/
│       ├── message-store.service.ts    # Stato conversazione (signal-based)
│       ├── streaming.service.ts        # Gestisce gli eventi SSE in arrivo
│       └── vscode-api.service.ts       # Wrapper attorno a acquireVsCodeApi()
│
├── features/
│   └── chat/
│       ├── chat-container/             # Layout principale della chat
│       ├── message-list/               # Lista messaggi scrollabile
│       ├── message-bubble/             # Singolo messaggio con rendering MD
│       ├── input-area/                 # Input testo + allegati
│       ├── toolbar/                    # Azioni e impostazioni
│       ├── connection-indicator/       # Badge stato connessione
│       ├── thinking-block/             # Reasoning block espandibile
│       └── message-metadata/          # Contatore token
│
└── shared/
    ├── directives/                     # Direttive Angular custom
    ├── pipes/                          # Pipe Angular custom
    └── services/
        ├── webview-bridge.service.ts   # on()/send() wrapper per postMessage
        └── code-registry.service.ts    # Syntax highlighting support
```

---

## Protocollo Messaggi Tipizzato

Il file `src/shared/message-protocol.ts` definisce il contratto tra extension host e webview. È compilato sia da esbuild (per l'extension host) che da Angular CLI (per la webview).

### Messaggi dall'Extension Host alla Webview (`ToWebviewType`)

| Tipo | Payload | Scopo |
|------|---------|-------|
| `streamDelta` | `StreamDeltaPayload` (evento SSE) | Chunk di risposta in streaming |
| `streamEnd` | — | Generazione completata |
| `streamError` | `{ message: string }` | Errore durante la generazione |
| `connectionStatus` | `ConnectionStatus` enum | Risultato health check |
| `configUpdate` | `ChatConfig` | Config del proxy ricevuta/aggiornata |
| `slashCommandResult` | `{ command, content }` | Risposta a un slash command |
| `codeResult` | `{ type: "text" \| "image", data }` | Risultato esecuzione Python |
| `codeProgress` | `{ phase }` | Fase esecuzione (creating_env, installing_packages, executing) |
| `historyRestore` | `{ messages: [...] }` | Cronologia conversazione al riattacco del pannello |
| `filesRead` | `{ attachments: [...] }` | File letti per allegato |

### Messaggi dalla Webview all'Extension Host (`ToExtensionType`)

| Tipo | Payload | Scopo |
|------|---------|-------|
| `sendMessage` | `{ content, attachments?, temperature?, maxTokens?, systemPrompt? }` | Messaggio utente |
| `cancelStream` | — | Annulla la generazione in corso |
| `checkHealth` | — | Health check manuale |
| `clearHistory` | — | Cancella la cronologia |
| `executeSlashCommand` | `{ command }` | Esegui uno slash command |
| `executeCode` | `{ code }` | Esegui snippet Python |
| `readFiles` | `{ uris: string[] }` | Carica file per allegato |

---

## Flusso: Messaggio Utente → Risposta in Streaming

```
1. Utente digita nella InputArea e preme Invio
   └── Angular emette evento → WebviewBridgeService.send({ type: "sendMessage", ... })
         └── postMessage alla extension host

2. Extension Host riceve in ChatSession.handleSendMessage()
   ├── Aggiunge messaggio utente alla history
   ├── Legge config (temperatura, systemPrompt, enableThinking)
   └── Chiama ProxyClient.sendMessage(messages, config)
         └── fetch POST http://127.0.0.1:5678/v1/messages
               Headers: Content-Type: application/json
                        X-Workspace-Root: /percorso/workspace (se disponibile)
               Body: { model, messages, max_tokens, temperature, stream: true, ... }

3. ProxyClient itera gli eventi SSE con SSEParser
   Per ogni evento Anthropic:
     └── WebviewBridge.send({ type: "streamDelta", event: <SseEvent> })
           └── postMessage alla webview

4. Webview riceve in WebviewBridgeService
   └── StreamingService.handleDelta(event)
         ├── content_block_delta (text_delta) → appende testo al messaggio corrente
         ├── content_block_delta (thinking_delta) → aggiorna thinking block
         └── message_stop → flush, notifica fine streaming

5. Webview invia { type: "streamEnd" } alla fine
   └── ChatSession aggiunge la risposta completa alla history in-memory
```

---

## Flusso: Slash Command

### Comandi gestiti dall'extension host (client-side)

```
Utente digita /files nella webview
  └── WebviewBridge.send({ type: "executeSlashCommand", command: "/files" })
        └── ChatSession.handleClientSlashCommand("/files")
              ├── Legge i file aperti nell'editor VS Code
              ├── Costruisce la lista
              └── WebviewBridge.send({ type: "slashCommandResult", content: "..." })
```

### Comandi gestiti dal proxy (proxy-side)

```
Utente digita /commit nella webview
  └── sendMessage({ content: "/commit" })
        └── ProxyClient.sendMessage() → POST /v1/messages
              └── SlashCommandInterceptor.intercept()
                    ├── Detecta "/commit"
                    ├── Esegue git diff --staged
                    ├── type: "enrich" → sostituisce il contenuto con il diff
                    └── Chiama l'LLM con il prompt arricchito
              └── Risposta SSE normale → streaming in Claudio
```

---

## Flusso: Esecuzione Codice Python

```
Utente clicca ▶ su un blocco Python nella webview
  └── WebviewBridge.send({ type: "executeCode", code: "..." })
        └── ChatSession.handleExecuteCode(code)

1. Trova Python:
   └── Cerca "python3" o "python" in PATH

2. Crea/verifica venv:
   └── .claudio-venv in VS Code globalStoragePath
   └── send({ type: "codeProgress", phase: "creating_env" })

3. Scansiona import nel codice:
   └── Regex per trovare "import X" e "from X import"

4. Installa pacchetti mancanti:
   └── pip install <mancanti>
   └── send({ type: "codeProgress", phase: "installing_packages" })

5. Modifica matplotlib (se presente):
   └── Sostituisce plt.show() con salvataggio su file temporaneo

6. Esegue il codice:
   └── python3 <temp_file.py>
   └── send({ type: "codeProgress", phase: "executing" })

7. Invia il risultato:
   ├── Testo: send({ type: "codeResult", data: { type: "text", data: stdout } })
   └── Plot: legge PNG dal file → base64 → send({ type: "codeResult", data: { type: "image", data: base64 } })
```

---

## Pipeline di Build

```
npm run build
  │
  ├── npm run build:webview
  │     └── cd src/webview-ui && npx ng build --configuration production
  │           Output: dist/webview-ui/browser/
  │             ├── main.js
  │             ├── styles.css
  │             └── (chunk files)
  │
  └── npm run build:extension
        └── node esbuild.config.mjs
              Entry:    src/extension/activation.ts
              Output:   dist/extension.js
              Format:   CommonJS
              External: vscode (fornito da VS Code al runtime)
              Bundle:   sì (include shared/message-protocol.ts e tutto il resto)

npm run package
  └── npx @vscode/vsce package --no-dependencies
        Output: claudio-0.1.0.vsix
        Include: dist/, media/, package.json, locales
```

---

## Architettura Configurazione

La configurazione di Claudio ha una gerarchia precisa:

```
Priorità (dalla più alta alla più bassa):

1. Overrides per-messaggio
   (temperatura, maxTokens, systemPrompt passati dall'UI)

2. Proxy config (GET /config)
   { temperature, systemPrompt, enableThinking, maxTokensFallback, locale, model }

3. VS Code settings
   { claudio.proxyHost, claudio.proxyPort }

4. Default hardcoded
   { temperature: 0.7, maxTokens: 4096, locale: "en" }
```

La funzione `buildChatConfig()` in `extension-config.ts` esegue il merge in questo ordine.

**Flusso di caricamento:**
1. All'attivazione, `ChatSession` chiama `ExtensionConfig.load()`
2. Legge VS Code settings (`proxyHost`, `proxyPort`)
3. Fetch `GET {proxyHost}:{proxyPort}/config`
4. Merge: proxy config sovrascrive i default, VS Code settings sovrascrivono host/porta
5. Config disponibile per tutti i messaggi successivi
6. `HealthChecker` rileva reconnect → `refreshProxyConfig()` → repeat step 3-4

---

## Tech Stack

| Componente | Tecnologia |
|---|---|
| Extension host | TypeScript 5.6 + Node.js 18 |
| Extension bundler | esbuild 0.24 |
| Webview UI | Angular 19 |
| Webview bundler | Angular CLI (@angular/build) |
| Styling webview | SCSS + Bootstrap 5 |
| Rendering Markdown | marked + marked-highlight |
| Rendering formule | KaTeX |
| i18n | @ngx-translate/core (en + it) |
| Packaging VS Code | @vscode/vsce |

---

## Tool Use & Permission Flow (planned)

> **Status: planned, not yet implemented.** Questa sezione descrive come Claudio dovrà evolversi per visualizzare l'attività agentica del proxy e per gestire le approvazioni utente per le action distruttive. Il quadro complessivo è in [feature-gap.md](feature-gap.md); l'architettura completa lato proxy è in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md).

### Stato attuale

Il proxy oggi può eseguire un agent loop con il tool `workspace` (action `list`/`read`) per modelli con `maxTools > 0`. Quando lo fa, emette il risultato finale come testo "sintetico" — i blocchi `tool_use` Anthropic intermedi **esistono nel flusso SSE** ma sono ignorati lato Claudio:

- [chat-session.ts:295-321](../src/extension/chat-session.ts#L295-L321) gestisce solo `text_delta` nello switch sugli eventi SSE
- I blocchi `content_block_start` con `content_block.type === "tool_use"` non vengono parsati
- Risultato: l'utente non vede mai "📂 list .", "📄 read README.md", ecc. Vede solo la risposta finale

### Cosa servirà aggiungere

1. **Parsing dei blocchi `tool_use`** in `chat-session.ts`:
   - Riconoscere `content_block_start` con `content_block.type === "tool_use"` e propagare al webview con un nuovo message type
   - Bufferare gli `input_json_delta` chunk (l'input JSON arriva in più pezzi)
   - Riconoscere `content_block_stop` per finalizzare il blocco

2. **Nuovi tipi nel message protocol** ([message-protocol.ts](../src/shared/message-protocol.ts)):
   - `ToolUseBlockPayload` — un blocco `tool_use` completo o parziale da mostrare in chat
   - `ToolRequestPayload` — il proxy chiede approvazione per un'action distruttiva
   - `ToolApprovalPayload` — l'utente decide approve/reject

3. **Componente Angular per la visualizzazione** dei blocchi `tool_use` in `MessageList`:
   - Rendering inline dell'azione: "📂 list `src/`", "📄 read `README.md`", ecc.
   - Mostrare lo stato (pending → executing → completed)
   - Espansione opzionale per vedere il risultato dell'azione

4. **Componente Angular modal di approvazione** per le action distruttive (write/edit/bash):
   - Triggered da un nuovo evento custom SSE `tool_request_pending` (vedi [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md))
   - Mostra preview del file/comando
   - Bottoni Approve / Reject
   - Su click → POST `/v1/messages/:request_id/approve` al proxy via `proxy-client.ts`

### Vincolo cardinale: agnostic verso il path agentico

Il proxy implementerà due path agentici (native per modelli con tool, textual per modelli senza). Claudio **non deve sapere quale path è in uso**: in entrambi i casi riceve blocchi `tool_use` Anthropic-standard nello stream SSE. Tutta la complessità di emulazione testuale o di decodifica di tool_calls OpenAI vive nel proxy.

Questo significa che le modifiche elencate sopra in Claudio sono **una sola volta** — non serve un parser separato per ogni path.

---

## Related Docs

- [Quick Start](quick-start.md) — step-by-step installation guide
- [Slash Commands](slash-commands.md) — complete command reference
- [Troubleshooting](troubleshooting.md) — problem resolution
- [Feature Gap](feature-gap.md) — Claudio vs Claude Code, cosa è presente e cosa manca
- [Proxy Architecture](../../proxy/docs/architecture.md) — internal proxy structure
- [Proxy Agent Loop](../../proxy/docs/agent-loop.md) — agent loop attuale e roadmap dual-path
- [Proxy Permission Protocol](../../proxy/docs/permission-protocol.md) — wire format approvazioni planned
