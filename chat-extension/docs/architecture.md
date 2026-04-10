# Claudio — Architecture

> Internal structure of the VS Code extension for developers who want to contribute to or extend Claudio.

---

## High-Level Overview

Claudio has three main components that communicate with each other:

```
┌──────────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js / TypeScript)        │
│                                                       │
│  activation.ts ──> ChatSession (singleton)            │
│      │                                                │
│      ├── ProxyClient      (HTTP + SSE streaming)      │
│      ├── HealthChecker    (polling /health every 10s) │
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
│   ├── models/                         # Data types (ChatMessage, Attachment, etc.)
│   ├── enums/                          # Enums (MessageRole, ContentType, etc.)
│   └── services/
│       ├── message-store.service.ts    # Conversation state (signal-based)
│       ├── streaming.service.ts        # Handles incoming SSE events
│       └── vscode-api.service.ts       # Wrapper around acquireVsCodeApi()
│
├── features/
│   └── chat/
│       ├── chat-container/             # Main chat layout
│       ├── message-list/               # Scrollable message list
│       ├── message-bubble/             # Single message with MD rendering
│       ├── input-area/                 # Text input + attachments
│       ├── toolbar/                    # Actions and settings
│       ├── connection-indicator/       # Connection status badge
│       ├── thinking-block/             # Expandable reasoning block
│       └── message-metadata/          # Token counter
│
└── shared/
    ├── directives/                     # Custom Angular directives
    ├── pipes/                          # Custom Angular pipes
    └── services/
        ├── webview-bridge.service.ts   # on()/send() wrapper for postMessage
        └── code-registry.service.ts    # Syntax highlighting support
```

---

## Typed Message Protocol

The file `src/shared/message-protocol.ts` defines the contract between extension host and webview. It is compiled by both esbuild (for the extension host) and Angular CLI (for the webview).

### Messages from Extension Host to Webview (`ToWebviewType`)

| Type | Payload | Purpose |
|------|---------|---------|
| `streamDelta` | `StreamDeltaPayload` (SSE event) | Streaming response chunk |
| `streamEnd` | — | Generation complete |
| `streamError` | `{ message: string }` | Error during generation |
| `connectionStatus` | `ConnectionStatus` enum | Health check result |
| `configUpdate` | `ChatConfig` | Proxy config received/updated |
| `slashCommandResult` | `{ command, content }` | Response to a slash command |
| `codeResult` | `{ type: "text" \| "image", data }` | Python execution result |
| `codeProgress` | `{ phase }` | Execution phase (creating_env, installing_packages, executing) |
| `historyRestore` | `{ messages: [...] }` | Conversation history on panel reattach |
| `filesRead` | `{ attachments: [...] }` | Files read for attachment |

### Messages from Webview to Extension Host (`ToExtensionType`)

| Type | Payload | Purpose |
|------|---------|---------|
| `sendMessage` | `{ content, attachments?, temperature?, maxTokens?, systemPrompt? }` | User message |
| `cancelStream` | — | Cancel ongoing generation |
| `checkHealth` | — | Manual health check |
| `clearHistory` | — | Clear conversation history |
| `executeSlashCommand` | `{ command }` | Execute a slash command |
| `executeCode` | `{ code }` | Execute Python snippet |
| `readFiles` | `{ uris: string[] }` | Load files for attachment |

---

## Flow: User Message → Streaming Response

```
1. User types in the InputArea and presses Enter
   └── Angular emits event → WebviewBridgeService.send({ type: "sendMessage", ... })
         └── postMessage to extension host

2. Extension Host receives in ChatSession.handleSendMessage()
   ├── Adds user message to history
   ├── Reads config (temperature, systemPrompt, enableThinking)
   └── Calls ProxyClient.sendMessage(messages, config)
         └── fetch POST http://127.0.0.1:5678/v1/messages
               Headers: Content-Type: application/json
                        X-Workspace-Root: /path/to/workspace (if available)
               Body: { model, messages, max_tokens, temperature, stream: true, ... }

3. ProxyClient iterates SSE events with SSEParser
   For each Anthropic event:
     └── WebviewBridge.send({ type: "streamDelta", event: <SseEvent> })
           └── postMessage to webview

4. Webview receives in WebviewBridgeService
   └── StreamingService.handleDelta(event)
         ├── content_block_delta (text_delta) → appends text to current message
         ├── content_block_delta (thinking_delta) → updates thinking block
         └── message_stop → flush, notify streaming end

5. Webview sends { type: "streamEnd" } at the end
   └── ChatSession adds the complete response to the in-memory history
```

---

## Flow: Slash Command

### Commands handled by the extension host (client-side)

```
User types /files in the webview
  └── WebviewBridge.send({ type: "executeSlashCommand", command: "/files" })
        └── ChatSession.handleClientSlashCommand("/files")
              ├── Reads open files in the VS Code editor
              ├── Builds the list
              └── WebviewBridge.send({ type: "slashCommandResult", content: "..." })
```

### Commands handled by the proxy (proxy-side)

```
User types /commit in the webview
  └── sendMessage({ content: "/commit" })
        └── ProxyClient.sendMessage() → POST /v1/messages
              └── SlashCommandInterceptor.intercept()
                    ├── Detects "/commit"
                    ├── Runs git diff --staged
                    ├── type: "enrich" → replaces content with the diff
                    └── Calls the LLM with the enriched prompt
              └── Normal SSE response → streaming in Claudio
```

---

## Flow: Python Code Execution

```
User clicks ▶ on a Python block in the webview
  └── WebviewBridge.send({ type: "executeCode", code: "..." })
        └── ChatSession.handleExecuteCode(code)

1. Find Python:
   └── Search for "python3" or "python" in PATH

2. Create/verify venv:
   └── .claudio-venv in VS Code globalStoragePath
   └── send({ type: "codeProgress", phase: "creating_env" })

3. Scan imports in the code:
   └── Regex to find "import X" and "from X import"

4. Install missing packages:
   └── pip install <missing>
   └── send({ type: "codeProgress", phase: "installing_packages" })

5. Patch matplotlib (if present):
   └── Replace plt.show() with save to temp file

6. Execute the code:
   └── python3 <temp_file.py>
   └── send({ type: "codeProgress", phase: "executing" })

7. Send the result:
   ├── Text: send({ type: "codeResult", data: { type: "text", data: stdout } })
   └── Plot: read PNG from file → base64 → send({ type: "codeResult", data: { type: "image", data: base64 } })
```

---

## Build Pipeline

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
              External: vscode (provided by VS Code at runtime)
              Bundle:   yes (includes shared/message-protocol.ts and everything else)

npm run package
  └── npx @vscode/vsce package --no-dependencies
        Output: claudio-0.1.0.vsix
        Include: dist/, media/, package.json, locales
```

---

## Configuration Architecture

Claudio's configuration has a precise hierarchy:

```
Priority (highest to lowest):

1. Per-message overrides
   (temperature, maxTokens, systemPrompt passed from the UI)

2. Proxy config (GET /config)
   { temperature, systemPrompt, enableThinking, maxTokensFallback, locale, model }

3. VS Code settings
   { claudio.proxyHost, claudio.proxyPort }

4. Hardcoded defaults
   { temperature: 0.7, maxTokens: 4096, locale: "en" }
```

The `buildChatConfig()` function in `extension-config.ts` performs the merge in this order.

**Loading flow:**
1. On activation, `ChatSession` calls `ExtensionConfig.load()`
2. Reads VS Code settings (`proxyHost`, `proxyPort`)
3. Fetch `GET {proxyHost}:{proxyPort}/config`
4. Merge: proxy config overwrites defaults, VS Code settings overwrite host/port
5. Config available for all subsequent messages
6. `HealthChecker` detects reconnect → `refreshProxyConfig()` → repeat steps 3-4

---

## Tech Stack

| Component | Technology |
|---|---|
| Extension host | TypeScript 5.6 + Node.js 18 |
| Extension bundler | esbuild 0.24 |
| Webview UI | Angular 19 |
| Webview bundler | Angular CLI (@angular/build) |
| Webview styling | SCSS + Bootstrap 5 |
| Markdown rendering | marked + marked-highlight |
| Formula rendering | KaTeX |
| i18n | @ngx-translate/core (en + it) |
| VS Code packaging | @vscode/vsce |

---

## Tool Use & Permission Flow (planned)

> **Status: planned, not yet implemented.** This section describes how Claudio will need to evolve to visualize the proxy's agentic activity and to handle user approvals for destructive actions. The overall picture is in [feature-gap.md](feature-gap.md); the full proxy-side architecture is in [proxy/docs/agent-loop.md](../../proxy/docs/agent-loop.md).

### Current State

The proxy can today run an agent loop with the `workspace` tool (actions `list`/`read`) for models with `maxTools > 0`. When it does so, it emits the final result as "synthetic" text — intermediate Anthropic `tool_use` blocks **exist in the SSE stream** but are ignored on the Claudio side:

- [chat-session.ts:295-321](../src/extension/chat-session.ts#L295-L321) handles only `text_delta` in the switch over SSE events
- `content_block_start` blocks with `content_block.type === "tool_use"` are not parsed
- Result: the user never sees "📂 list .", "📄 read README.md", etc. — only the final response

### What Needs to Be Added

1. **Parsing of `tool_use` blocks** in `chat-session.ts`:
   - Recognize `content_block_start` with `content_block.type === "tool_use"` and propagate to the webview with a new message type
   - Buffer `input_json_delta` chunks (the JSON input arrives in multiple pieces)
   - Recognize `content_block_stop` to finalize the block

2. **New types in the message protocol** ([message-protocol.ts](../src/shared/message-protocol.ts)):
   - `ToolUseBlockPayload` — a complete or partial `tool_use` block to display in chat
   - `ToolRequestPayload` — the proxy is asking for approval for a destructive action
   - `ToolApprovalPayload` — the user decides approve/reject

3. **Angular component for visualization** of `tool_use` blocks in `MessageList`:
   - Inline rendering of the action: "📂 list `src/`", "📄 read `README.md`", etc.
   - Show the state (pending → executing → completed)
   - Optional expansion to see the action result

4. **Angular approval modal component** for destructive actions (write/edit/bash):
   - Triggered by a new custom SSE event `tool_request_pending` (see [proxy/docs/permission-protocol.md](../../proxy/docs/permission-protocol.md))
   - Shows file/command preview
   - Approve / Reject buttons
   - On click → POST `/v1/messages/:request_id/approve` to the proxy via `proxy-client.ts`

### Cardinal Constraint: Agnostic to the Agentic Path

The proxy will implement two agentic paths (native for tool-capable models, textual for models without tools). Claudio **must not know which path is in use**: in both cases it receives standard Anthropic `tool_use` blocks in the SSE stream. All the complexity of textual emulation or OpenAI tool_calls decoding lives in the proxy.

This means the Claudio-side changes listed above need to be implemented **once** — no separate parser is needed for each path.

---

## Related Docs

- [Quick Start](quick-start.md) — step-by-step installation guide
- [Slash Commands](slash-commands.md) — complete command reference
- [Troubleshooting](troubleshooting.md) — problem resolution
- [Feature Gap](feature-gap.md) — Claudio vs Claude Code, what is present and what is missing
- [Proxy Architecture](../../proxy/docs/architecture.md) — internal proxy structure
- [Proxy Agent Loop](../../proxy/docs/agent-loop.md) — current agent loop and dual-path roadmap
- [Proxy Permission Protocol](../../proxy/docs/permission-protocol.md) — planned approval wire format
