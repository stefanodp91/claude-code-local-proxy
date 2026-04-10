# Proxy Architecture

> Anthropic-to-OpenAI translation proxy — v1.0.0

## Overview

The proxy is a Node.js HTTP server (run via `tsx`) that sits between Claude Code (or Claudio) and a local LLM backend (LM Studio, ollama, vLLM, etc.). It translates Anthropic Messages API requests into OpenAI Chat Completions format and translates responses back, including full SSE streaming support.

```
+──────────────+          +─────────────────+          +──────────────+
│              │  Anthropic│                 │  OpenAI  │              │
│  Claude Code │─────────>│      Proxy      │─────────>│  Local LLM   │
│   (client)   │  Messages│  (Node.js/tsx)  │  Chat    │  (LM Studio) │
│              │<─────────│                 │<─────────│              │
│              │  SSE/JSON │                 │  SSE/JSON│              │
+──────────────+          +─────────────────+          +──────────────+
     :5678                    localhost                    :1234
  POST /v1/messages      translate + route         POST /v1/chat/completions
```

---

## Hexagonal Architecture

The codebase follows hexagonal (clean) architecture with three layers. Dependencies always point inward — infrastructure depends on application, application depends on domain. The domain layer has zero I/O.

```
+─────────────────────────────────────────────────────────────────────+
│                        INFRASTRUCTURE                               │
│                                                                     │
│  main.ts             Bootstrap (composition root)                   │
│  server.ts           HTTP server, routing, agentic loop, wiring     │
│  config.ts           Environment variable parsing → ProxyConfig     │
│  logger.ts           Logger implements ILogger port                 │
│  modelInfo.ts        LM Studio /api/v0/models fetcher               │
│  toolProbe.ts        Binary search tool limit detection             │
│  persistentCache.ts  JSON file-backed model capability cache        │
│  httpUtils.ts        HTTP Response factories                        │
│  i18nLoader.ts       Locale loader → calls setMessages()           │
│                                                                     │
│  +───────────────────────────────────────────────────────────────+  │
│  │                       APPLICATION                             │  │
│  │                                                               │  │
│  │  requestTranslator.ts      Anthropic → OpenAI request         │  │
│  │  responseTranslator.ts     OpenAI → Anthropic non-streaming   │  │
│  │  streamTranslator.ts       OpenAI SSE → Anthropic SSE         │  │
│  │  toolManager.ts            Scoring, selection, UseTool        │  │
│  │  slashCommandInterceptor.ts  Registry + pre-LLM interception  │  │
│  │  workspaceTool.ts          Workspace list/read + summary      │  │
│  │                                                               │  │
│  │  +─────────────────────────────────────────────────────────+  │  │
│  │  │                      DOMAIN                             │  │  │
│  │  │                                                         │  │  │
│  │  │  types.ts    Enums, interfaces, constants               │  │  │
│  │  │  ports.ts    ILogger interface (DIP contract)           │  │  │
│  │  │  utils.ts    Pure functions: msgId(), sseEvent()        │  │  │
│  │  │  i18n.ts     Pure lookup: setMessages(), t()            │  │  │
│  │  │                                                         │  │  │
│  │  │  No I/O. No imports from outer layers.                  │  │  │
│  │  +─────────────────────────────────────────────────────────+  │  │
│  +───────────────────────────────────────────────────────────────+  │
+─────────────────────────────────────────────────────────────────────+
```

---

## File Map

| Layer | File | Description |
|---|---|---|
| **Entry** | `src/main.ts` | Composition root: loadConfig → ProxyServer → initialize → start → initializeTools |
| **Domain** | `src/domain/types.ts` | All enums (LogLevel, StopReason, FinishReason, ContentBlockType, SseEventType, ToolChoiceType, DeltaType, MessageRole, OpenAIToolType, Locale) and interfaces (LoadedModelInfo, AnthropicRequest, OpenAIRequest, OpenAITool, ToolSelection) |
| **Domain** | `src/domain/ports.ts` | `ILogger` interface — DIP contract for logging |
| **Domain** | `src/domain/utils.ts` | `msgId()` — Anthropic-style ID generation; `sseEvent()` — SSE wire format |
| **Domain** | `src/domain/i18n.ts` | `setMessages()` — inbound port; `t(key, params)` — pure `{{param}}` interpolation |
| **Application** | `src/application/requestTranslator.ts` | Anthropic → OpenAI: messages, tools, tool_choice, max_tokens capping |
| **Application** | `src/application/responseTranslator.ts` | OpenAI → Anthropic: non-streaming JSON response translation |
| **Application** | `src/application/streamTranslator.ts` | OpenAI SSE → Anthropic SSE: state machine with UseTool deferred emission |
| **Application** | `src/application/toolManager.ts` | Additive scoring, selection, UseTool meta-tool, promotion/decay |
| **Application** | `src/application/slashCommandInterceptor.ts` | Slash command registry + interceptor (synthetic / enrich / passthrough) |
| **Application** | `src/application/workspaceTool.ts` | Workspace list/read tool definition, path validation, static summary fallback |
| **Infrastructure** | `src/infrastructure/server.ts` | ProxyServer class: routing, agentic loop, handler orchestration, dependency wiring |
| **Infrastructure** | `src/infrastructure/config.ts` | `loadConfig()` → `ProxyConfig` from environment variables |
| **Infrastructure** | `src/infrastructure/logger.ts` | `Logger` implements `ILogger`, stderr output with timestamps |
| **Infrastructure** | `src/infrastructure/modelInfo.ts` | `ModelInfoService.fetch()` — queries LM Studio `/api/v0/models` |
| **Infrastructure** | `src/infrastructure/toolProbe.ts` | `ToolProbe.detect()` — binary search for max tool count |
| **Infrastructure** | `src/infrastructure/persistentCache.ts` | Generic JSON file-backed key-value cache (stores maxTools per model ID) |
| **Infrastructure** | `src/infrastructure/httpUtils.ts` | `anthropicError()` — Anthropic-format error Response factory |
| **Infrastructure** | `src/infrastructure/i18nLoader.ts` | `loadLocale()` — reads JSON from `locales/`, calls `setMessages()` |
| **Assets** | `locales/en_US.json` | English locale — 30+ message keys with `{{param}}` placeholders |

---

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check: `{"status":"ok","target":"..."}`. Available immediately after `proxy.start()`. |
| `GET` | `/config` | Runtime config: proxyPort, targetUrl, temperature, systemPrompt, enableThinking, locale, maxTokensFallback, model info. Used by Claudio to auto-configure. |
| `GET` | `/commands` | Slash command registry (`SLASH_COMMAND_REGISTRY`). Used by Claudio for command autocomplete. |
| `POST` | `/v1/messages` | Main translation endpoint. Returns `503` while `initializeTools()` is still running. |

---

## Startup Sequence

```
main.ts
  │
  ├── loadConfig()                     Read all env vars → ProxyConfig
  │
  ├── new ProxyServer(config)          Create Logger + ModelCache (PersistentCache)
  │
  ├── proxy.initialize()               FAST PATH (~100-300ms)
  │     ├── loadLocale(config.locale)  Read locales/en_US.json → setMessages()
  │     └── ModelInfoService.fetch()   GET /api/v0/models from LM Studio
  │           └── Derive maxTokensCap  loadedContextLength / ratio
  │
  ├── proxy.start()                    HTTP server now listening
  │     └── GET /health returns 200    (health check passes HERE)
  │
  └── proxy.initializeTools()          BACKGROUND (~3-30s)
        │
        ├── detectToolLimit()
        │     ├── MAX_TOOLS set?    ──> Use override value
        │     ├── Cache hit?        ──> Use cached maxTools (skip probe)
        │     └── Cache miss?       ──> ToolProbe.detect() binary search
        │           └── Write result to model-cache.json
        │
        └── Wire dependencies
              ├── new ToolManager(maxTools, scoringConfig)
              ├── new RequestTranslator(modelInfo, toolManager, config)
              ├── new ResponseTranslator(toolManager)
              └── new StreamTranslator(toolManager, logger)

              ↑ POST /v1/messages returns 503 until this completes
```

---

## Request Flow

```
Claude Code (or Claudio)          Proxy                          LM Studio
    │                             │                                │
    │  POST /v1/messages          │                                │
    │  {                          │                                │
    │    model, messages,         │                                │
    │    tools, tool_choice,      │                                │
    │    max_tokens, stream,      │                                │
    │    thinking, system         │                                │
    │  }                          │                                │
    │  X-Workspace-Root: /path    │                                │
    │ ───────────────────────────>│                                │
    │                             │                                │
    │                   SlashCommandInterceptor.intercept()        │
    │                      ├── synthetic? ──> SSE response, DONE  │
    │                      ├── enrich?    ──> replace last message │
    │                      └── passthrough ──> continue            │
    │                             │                                │
    │                   Workspace context injection                │
    │                   (if X-Workspace-Root header present)       │
    │                             │                                │
    │                   RequestTranslator.translate()              │
    │                      ├── System prompt → system message      │
    │                      ├── Messages: role/content conversion   │
    │                      ├── Tools: input_schema → parameters    │
    │                      ├── tool_choice mapping                 │
    │                      ├── max_tokens capping                  │
    │                      └── ToolManager.selectTools()           │
    │                             │                                │
    │               Has workspace + maxTools > 0?                  │
    │               ┌─────────────┤                                │
    │               │ YES         │ NO                             │
    │               │             │                                │
    │        AGENTIC LOOP     Normal path                          │
    │        (non-streaming)  (streaming or JSON)                  │
    │        up to 10 rounds       │                               │
    │             │                │                               │
    │        Each round:           │  POST /v1/chat/completions    │
    │          POST (no stream)    │ ──────────────────────────>   │
    │          Execute workspace   │                               │
    │          tool calls          │<──────────────────────────    │
    │          if text → break     │  SSE stream or JSON response  │
    │             │                │                               │
    │        Final text →     stream=true?                         │
    │        stream as SSE    ├── YES: StreamTranslator            │
    │               │         │        OpenAI SSE → Anthropic SSE  │
    │               │         └── NO:  ResponseTranslator          │
    │               │                  JSON → JSON                 │
    │<──────────────┘─────────────┘                                │
    │  Anthropic SSE/JSON response                                 │
```

---

## Slash Command Interception

The `SlashCommandInterceptor` runs on every `POST /v1/messages` request, **before** the request is translated and forwarded to the LLM.

### How It Works

```
Incoming request
      │
      ├── Last message is a user message starting with "/"?
      │     NO  → passthrough (normal flow)
      │     YES → extract command name
      │
      ├── In ANTHROPIC_BLOCKED_COMMANDS?
      │     YES → synthetic: "not available with local LLM proxies"
      │
      ├── In PROXY_COMMANDS?
      │     NO  → passthrough (forwarded to LLM as-is)
      │     YES → execute handler:
      │
      ├── execute(command, workspaceCwd)
      │     ├── /status   → synthetic: proxy version, port, Node.js version, cwd
      │     ├── /version  → synthetic: package version
      │     ├── /commit   → enrich: staged diff + recent log → LLM writes commit msg
      │     ├── /diff     → enrich: git diff HEAD → LLM explains changes
      │     ├── /review   → enrich: diff vs main/master → LLM reviews
      │     ├── /compact  → enrich: "summarize our conversation"
      │     ├── /brief    → enrich: "respond briefly from now on"
      │     └── /plan     → enrich: "think step by step"
```

### Result Types

| Type | LLM called? | Description |
|---|---|---|
| `synthetic` | No | The proxy sends a complete SSE response immediately. The LLM is never invoked. |
| `enrich` | Yes | The proxy replaces the last user message with an enriched prompt (e.g. with a git diff), then forwards to the LLM normally. |
| `passthrough` | Yes | Not a handled command. Request proceeds through the normal translation pipeline. |

### Workspace CWD

The `X-Workspace-Root` header sent by Claudio is passed to the interceptor as the `workspaceCwd` argument. Git commands (`/commit`, `/diff`, `/review`) run inside that directory. Falls back to `process.cwd()` when the header is absent.

### Command Registry

The full command registry is served via `GET /commands`. Clients (like Claudio) use this to populate slash command autocomplete. Client-handled commands (e.g. `/files`, `/copy`) appear in the registry but have `handler: "client"` — the proxy does not execute them.

---

## Workspace Tool and Agentic Loop

> **Deep-dive docs**: [agent-loop.md](agent-loop.md) covers the loop iteration, known limitations, and the planned model-agnostic dual-path architecture. [system-prompt-injection.md](system-prompt-injection.md) covers what the loop sees in the system prompt before running. [permission-protocol.md](permission-protocol.md) covers the planned approval flow for destructive actions.

When a client sends the `X-Workspace-Root` header, the proxy can give the LLM access to the workspace filesystem.

### Workspace Tool Definition

```typescript
{
  type: "function",
  function: {
    name: "workspace",
    description: "Access files in the current workspace.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read"] },
        path: { type: "string" }   // relative to workspace root
      },
      required: ["action", "path"]
    }
  }
}
```

### Security

`safeResolve(workspaceCwd, relativePath)` resolves the path and checks that it starts with the workspace root. Any attempt to read outside (e.g. `../../etc/passwd`) is rejected with an error.

### Two Modes

**Agentic Loop** (when `maxTools > 0`):

```
POST /v1/messages received (with X-Workspace-Root)
  │
  └── Round 1: POST /v1/chat/completions (non-streaming)
        Only `workspace` tool available
        │
        ├── Model calls workspace(action="list", path=".")
        │     → proxy executes: lists workspace root
        │     → tool result injected as next user message
        │
        └── Round 2: POST /v1/chat/completions
              │
              ├── Model calls workspace(action="read", path="src/main.ts")
              │     → proxy reads file (max 50KB)
              │     → tool result injected
              │
              └── Round N (up to 10): model produces text response
                    → exit loop
                    → stream text response to client as Anthropic SSE
```

**Static Summary** (when `maxTools === 0`): the proxy injects a pre-built text block into the system prompt containing:
- Top-level directory listing
- `package.json` content (name, description, workspaces)
- First 2000 characters of `README.md`

---

## Persistent Model Cache

Tool limit detection via binary search probe can take 3–30 seconds. The persistent cache avoids this on every restart.

```
proxy/model-cache.json example:
{
  "qwen/qwen3.5-35b-a3b":             { "maxTools": 15 },
  "nemotron-cascade-2-30b-a3b@6bit":  { "maxTools": 7  },
  "llama-3.1-8b-instruct":            { "maxTools": 4  }
}
```

**Cache lifecycle:**

```
Startup
  │
  ├── modelInfo.id available?
  │     NO  → skip cache, run probe
  │     YES → check model-cache.json
  │
  ├── Cache hit (modelId found)?
  │     YES → use cached maxTools immediately  ← probe skipped
  │     NO  → run ToolProbe.detect() binary search
  │             write result: cache.set(modelId, { maxTools: N })
  │
  └── Wire translators with maxTools value
```

To force a re-detection: delete `proxy/model-cache.json` or remove the specific model entry.

---

## Streaming SSE State Machine

The `StreamStateMachine` (in `streamTranslator.ts`) processes OpenAI SSE chunks and emits Anthropic SSE events. Each stream creates a fresh instance.

### State Transitions

```
                              ┌───────────────────────┐
                              │                       │
                              v                       │
  ┌──────┐   first chunk   ┌─────────────┐           │
  │ INIT ├────────────────>│ MSG_START   │           │
  └──────┘                 │ (emit once) │           │
                           └──────┬──────┘           │
                                  │                   │
                    ┌─────────────┼─────────────┐     │
                    v             v             v     │
              ┌──────────┐ ┌──────────┐ ┌──────────┐ │
              │ THINKING │ │   TEXT   │ │  TOOL    │ │
              │  BLOCK   │ │  BLOCK   │ │  CALLS   │ │
              │ (idx: 0) │ │(idx: N)  │ │(idx: N+) │ │
              └────┬─────┘ └────┬─────┘ └────┬─────┘ │
                   │            │             │       │
                   └─────────┬──┘─────────────┘       │
                             │                        │
                    [DONE] or finish_reason            │
                             │                        │
                             v                        │
                    ┌─────────────────┐               │
                    │   FINALIZE      │               │
                    │ close blocks    │               │
                    │ flush UseTool   │               │
                    │ emit msg_delta  │               │
                    │ emit msg_stop   │───────────────┘
                    └─────────────────┘      (stream ends)
```

### SSE Event Types Emitted

| Anthropic SSE Event | When | Content |
|---|---|---|
| `message_start` | First chunk received | Message shell: id, role, model, empty content |
| `content_block_start` | New thinking/text/tool block | Block type + index |
| `content_block_delta` | Each content chunk | `thinking_delta`, `text_delta`, or `input_json_delta` |
| `content_block_stop` | Block finishes | Block index |
| `message_delta` | Stream ends | `stop_reason` + output token count |
| `message_stop` | Final event | End of stream |

### UseTool Deferred Emission

When a tool call with name `UseTool` is detected in the stream:

```
Normal tool call:                    UseTool call:
  ┌─ content_block_start (name=X)     ┌─ (nothing emitted)
  ├─ input_json_delta (chunk 1)       ├─ (arguments buffered)
  ├─ input_json_delta (chunk 2)       ├─ (arguments buffered)
  ├─ input_json_delta (chunk N)       ├─ (arguments buffered)
  └─ content_block_stop               └─ FINALIZE:
                                           Parse {tool_name, parameters}
                                           Emit content_block_start (name=REAL)
                                           Emit input_json_delta (full JSON)
                                           Emit content_block_stop
                                           Promote tool in ToolManager
```

This deferred approach ensures Claude Code never sees "UseTool" — it receives the real tool name as if the model called it directly.

---

## Message Translation

### Role Mapping

| Anthropic | OpenAI |
|---|---|
| `system` (array of text blocks or string) | `system` message |
| `user` with text blocks | `user` message |
| `user` with `tool_result` blocks | `tool` messages (one per result) |
| `assistant` with text blocks | `assistant` message (content) |
| `assistant` with `tool_use` blocks | `assistant` message (tool_calls) |
| `assistant` with `thinking` blocks | Skipped (model generates its own) |

### Content Block Mapping

| Anthropic Block | OpenAI Equivalent |
|---|---|
| `{ type: "text", text: "..." }` | `content: "..."` (string) |
| `{ type: "tool_use", id, name, input }` | `tool_calls: [{ id, type: "function", function: { name, arguments } }]` |
| `{ type: "tool_result", tool_use_id, content }` | `{ role: "tool", tool_call_id, content }` |
| `{ type: "thinking", thinking: "..." }` | `reasoning_content: "..."` (in response only) |

### Tool Definition Translation

| Anthropic | OpenAI |
|---|---|
| `name` | `function.name` |
| `description` | `function.description` |
| `input_schema` | `function.parameters` |
| (top-level object) | Wrapped in `{ type: "function", function: {...} }` |

### Tool Choice Mapping

| Anthropic `tool_choice` | OpenAI `tool_choice` |
|---|---|
| `{ type: "auto" }` | `"auto"` |
| `{ type: "any" }` | `"auto"` |
| `{ type: "none" }` | `"none"` |
| `{ type: "tool", name: "X" }` | `"required"` (LM Studio doesn't support forced tool objects) |

### Stop Reason Mapping

| OpenAI `finish_reason` | Anthropic `stop_reason` |
|---|---|
| `"stop"` | `"end_turn"` (or `"tool_use"` if content has tool_use blocks) |
| `"tool_calls"` | `"tool_use"` |
| `"length"` | `"max_tokens"` |

---

## Dependency Inversion (DIP)

The domain layer defines port interfaces that infrastructure implements:

```
domain/ports.ts                 infrastructure/logger.ts
+────────────────+              +──────────────────────+
│  interface      │  implements  │  class Logger        │
│  ILogger {      │<────────────│  implements ILogger { │
│    info()       │              │    info()            │
│    dbg()        │              │    dbg()             │
│    error()      │              │    error()           │
│  }              │              │  }                   │
+────────────────+              +──────────────────────+
```

Similarly, i18n is split:

```
domain/i18n.ts                  infrastructure/i18nLoader.ts
+─────────────────+             +───────────────────────+
│ setMessages()   │<────────────│ loadLocale()          │
│ t(key, params)  │  populates  │   fs.readFile() → JSON│
│                 │  via call   │   → setMessages(msgs)  │
│ Pure lookup.    │             │                       │
│ No I/O.         │             │ File I/O lives here.  │
+─────────────────+             +───────────────────────+
```

---

## Related Docs

- [Configuration Reference](configuration.md) — all environment variables
- [Tool Management](tool-management.md) — scoring, selection, UseTool, promotion, persistent cache
- [Agent Loop](agent-loop.md) — workspace exploration loop, limitations, and the planned dual-path architecture
- [System Prompt Injection](system-prompt-injection.md) — what the proxy auto-injects into every workspace-aware request
- [Permission Protocol](permission-protocol.md) — planned wire format for approving destructive actions
- [Startup Scripts](startup-scripts.md) — start_agent_cli.sh internals
