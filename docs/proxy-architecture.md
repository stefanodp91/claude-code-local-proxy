# Proxy Architecture

> Anthropic-to-OpenAI translation proxy — v1.0.0

## Overview

The proxy is a Bun HTTP server that sits between Claude Code and a local LLM backend (LM Studio, ollama, vLLM, etc.). It translates Anthropic Messages API requests into OpenAI Chat Completions format and translates responses back, including full SSE streaming support.

```
+──────────────+          +─────────────────+          +──────────────+
│              │  Anthropic│                 │  OpenAI  │              │
│  Claude Code │─────────>│      Proxy      │─────────>│  Local LLM   │
│   (client)   │  Messages│  (Bun server)   │  Chat    │  (LM Studio) │
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
│  main.ts         Bootstrap (composition root)                       │
│  server.ts       HTTP server, routing, dependency wiring            │
│  config.ts       Environment variable parsing → ProxyConfig         │
│  logger.ts       Logger implements ILogger port                     │
│  modelInfo.ts    LM Studio /api/v0/models fetcher                   │
│  toolProbe.ts    Binary search tool limit detection                 │
│  httpUtils.ts    HTTP Response factories                            │
│  i18nLoader.ts   Bun.file() locale loader → calls setMessages()    │
│                                                                     │
│  +───────────────────────────────────────────────────────────────+  │
│  │                       APPLICATION                             │  │
│  │                                                               │  │
│  │  requestTranslator.ts   Anthropic → OpenAI request mapping    │  │
│  │  responseTranslator.ts  OpenAI → Anthropic non-streaming      │  │
│  │  streamTranslator.ts    OpenAI SSE → Anthropic SSE streaming  │  │
│  │  toolManager.ts         Scoring, selection, UseTool, promotion │  │
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
| **Entry** | `src/main.ts` | Composition root: loadConfig → ProxyServer → initialize → start |
| **Domain** | `src/domain/types.ts` | All enums (LogLevel, StopReason, FinishReason, ContentBlockType, SseEventType, ToolChoiceType, DeltaType, MessageRole, OpenAIToolType, Locale) and interfaces (LoadedModelInfo, AnthropicRequest, OpenAIRequest, OpenAITool, ToolSelection) |
| **Domain** | `src/domain/ports.ts` | `ILogger` interface — DIP contract for logging |
| **Domain** | `src/domain/utils.ts` | `msgId()` — Anthropic-style ID generation; `sseEvent()` — SSE wire format |
| **Domain** | `src/domain/i18n.ts` | `setMessages()` — inbound port; `t(key, params)` — pure `{{param}}` interpolation |
| **Application** | `src/application/requestTranslator.ts` | Anthropic → OpenAI: messages, tools, tool_choice, max_tokens capping |
| **Application** | `src/application/responseTranslator.ts` | OpenAI → Anthropic: non-streaming JSON response translation |
| **Application** | `src/application/streamTranslator.ts` | OpenAI SSE → Anthropic SSE: state machine with UseTool deferred emission |
| **Application** | `src/application/toolManager.ts` | Additive scoring, selection, UseTool meta-tool, promotion/decay |
| **Infrastructure** | `src/infrastructure/server.ts` | ProxyServer class: routing, handler orchestration, dependency wiring |
| **Infrastructure** | `src/infrastructure/config.ts` | `loadConfig()` → `ProxyConfig` from environment variables |
| **Infrastructure** | `src/infrastructure/logger.ts` | `Logger` implements `ILogger`, stderr output with timestamps |
| **Infrastructure** | `src/infrastructure/modelInfo.ts` | `ModelInfoService.fetch()` — queries LM Studio `/api/v0/models` |
| **Infrastructure** | `src/infrastructure/toolProbe.ts` | `ToolProbe.detect()` — binary search for max tool count |
| **Infrastructure** | `src/infrastructure/httpUtils.ts` | `anthropicError()` — Anthropic-format error Response factory |
| **Infrastructure** | `src/infrastructure/i18nLoader.ts` | `loadLocale()` — reads JSON from `locales/`, calls `setMessages()` |
| **Assets** | `locales/en_US.json` | English locale — 30+ message keys with `{{param}}` placeholders |

---

## Startup Sequence

```
main.ts
  │
  ├── loadConfig()                     Read all env vars → ProxyConfig
  │
  ├── new ProxyServer(config)          Create Logger from config.debug
  │
  ├── proxy.initialize()
  │     │
  │     ├── loadLocale(config.locale)  Read locales/en_US.json → setMessages()
  │     │
  │     ├── ModelInfoService.fetch()   GET /api/v0/models from LM Studio
  │     │     │                        Extract: id, arch, quantization,
  │     │     │                        loadedContextLength, capabilities
  │     │     └── Derive maxTokensCap  loadedContextLength / ratio
  │     │
  │     ├── detectToolLimit()
  │     │     ├── MAX_TOOLS set?  ──>  Use override value
  │     │     └── MAX_TOOLS unset? ──> ToolProbe.detect()
  │     │           └── Binary search  1..32 with dummy tool_calls
  │     │
  │     └── Wire dependencies
  │           ├── new ToolManager(maxTools, scoringConfig)
  │           ├── new RequestTranslator(modelInfo, toolManager, config)
  │           ├── new ResponseTranslator(toolManager)
  │           └── new StreamTranslator(toolManager, logger)
  │
  └── proxy.start()
        └── Bun.serve({ port, idleTimeout: 0, fetch: route })
              │
              └── idleTimeout: 0  (disabled — local LLMs may take 30+ seconds
                                   in reasoning phase before first token)
```

---

## Request Flow

```
Claude Code                     Proxy                          LM Studio
    │                             │                                │
    │  POST /v1/messages          │                                │
    │  {                          │                                │
    │    model, messages,         │                                │
    │    tools, tool_choice,      │                                │
    │    max_tokens, stream,      │                                │
    │    thinking, system         │                                │
    │  }                          │                                │
    │ ───────────────────────────>│                                │
    │                             │                                │
    │                      Parse JSON body                         │
    │                             │                                │
    │                      RequestTranslator.translate()            │
    │                        ├── System prompt → system message    │
    │                        ├── Messages: role/content conversion │
    │                        ├── Tools: input_schema → parameters  │
    │                        ├── tool_choice mapping               │
    │                        ├── max_tokens capping                │
    │                        └── ToolManager.selectTools()         │
    │                             │    Score + rank + split        │
    │                             │    Top N-1 + UseTool           │
    │                             │                                │
    │                             │  POST /v1/chat/completions     │
    │                             │  {                              │
    │                             │    model (remapped),            │
    │                             │    messages (OpenAI format),    │
    │                             │    tools (filtered + UseTool),  │
    │                             │    tool_choice, max_tokens,     │
    │                             │    stream                       │
    │                             │  }                              │
    │                             │ ──────────────────────────────>│
    │                             │                                │
    │                             │            (LLM generates)     │
    │                             │                                │
    │                             │<──────────────────────────────│
    │                             │  SSE stream or JSON response   │
    │                             │                                │
    │               stream=true?  │                                │
    │               ┌─────────────┤                                │
    │               │ YES         │ NO                             │
    │               │             │                                │
    │        StreamTranslator  ResponseTranslator                  │
    │        State machine     JSON → JSON                         │
    │        OpenAI SSE →      + UseTool rewriting                 │
    │        Anthropic SSE                                         │
    │        + UseTool deferred                                    │
    │               │             │                                │
    │<──────────────┘─────────────┘                                │
    │  Anthropic SSE/JSON response                                 │
```

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
       ^                                  ^
       │                                  │
  Used by application:              Created by infrastructure:
  streamTranslator.ts              server.ts constructor
  toolProbe.ts
  modelInfo.ts
```

Similarly, i18n is split:

```
domain/i18n.ts                  infrastructure/i18nLoader.ts
+─────────────────+             +───────────────────────+
│ setMessages()   │<────────────│ loadLocale()          │
│ t(key, params)  │  populates  │   Bun.file() → JSON   │
│                 │  via call   │   → setMessages(msgs)  │
│ Pure lookup.    │             │                       │
│ No I/O.         │             │ File I/O lives here.  │
+─────────────────+             +───────────────────────+
```

---

## Related Docs

- [Configuration Reference](proxy-configuration.md) — all environment variables
- [Tool Management](tool-management.md) — scoring, selection, UseTool, promotion
- [Startup Scripts](startup-scripts.md) — start.sh and start_claude_code.sh
