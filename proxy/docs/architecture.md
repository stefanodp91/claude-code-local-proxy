# Proxy Architecture

> Anthropic-to-OpenAI translation proxy — v1.4.0

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
│  main.ts             Composition root: config → probes → listen     │
│  server.ts           HTTP router + wiring (416 lines)               │
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
│  │  workspaceTool.ts          Static workspace summary (context) │  │
│  │  textualAgentLoop.ts       Path B agent loop (XML tags)       │  │
│  │                                                               │  │
│  │  +─────────────────────────────────────────────────────────+  │  │
│  │  │                      DOMAIN                             │  │  │
│  │  │                                                         │  │  │
│  │  │  types.ts    Enums, interfaces, constants               │  │  │
│  │  │  ports/      7 port interfaces (DIP contracts)          │  │  │
│  │  │  entities/   workspaceAction, existingPlan              │  │  │
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
| **Entry** | `src/main.ts` | Composition root: `loadConfig` → `ProxyServer` → `initialize()` (locale + model info) → `initializeTools()` (probe or cache hit) → `start()`. Listening comes **last**, deliberately — see [probe-before-listen](../README.md#probe-before-listen) |
| **Domain** | `src/domain/types.ts` | All enums (LogLevel, StopReason, FinishReason, ContentBlockType, SseEventType, ToolChoiceType, DeltaType, MessageRole, OpenAIToolType, Locale) and interfaces (LoadedModelInfo, AnthropicRequest, OpenAIRequest, OpenAITool, ToolSelection) |
| **Domain** | `src/domain/entities/workspaceAction.ts` | `WorkspaceAction` enum, `ActionClass`, `ActionArgs`, `WORKSPACE_TOOL_DEF` — workspace tool definition moved to pure domain |
| **Domain** | `src/domain/ports/` | Barrel re-export of all port interfaces: `LlmClientPort`, `SseWriterPort`, `PlanFileRepositoryPort`, `PromptRepositoryPort`, `ApprovalInteractorPort`, `LoggerPort`, `ClockPort`, `MemoryRepositoryPort` |
| **Domain** | `src/domain/utils.ts` | `msgId()` — Anthropic-style ID generation; `sseEvent()` — SSE wire format |
| **Domain** | `src/domain/i18n.ts` | `setMessages()` — inbound port; `t(key, params)` — pure `{{param}}` interpolation |
| **Application** | `src/application/requestTranslator.ts` | Anthropic → OpenAI: messages, tools, tool_choice, max_tokens capping |
| **Application** | `src/application/responseTranslator.ts` | OpenAI → Anthropic: non-streaming JSON response translation |
| **Application** | `src/application/streamTranslator.ts` | OpenAI SSE → Anthropic SSE: state machine with UseTool deferred emission |
| **Application** | `src/application/toolManager.ts` | Additive scoring, selection, UseTool meta-tool, promotion/decay |
| **Application** | `src/application/slashCommandInterceptor.ts` | Slash command registry + interceptor (synthetic / enrich / passthrough) |
| **Application** | `src/application/workspaceTool.ts` | `buildWorkspaceContextSummary()` — static dir/package/README snapshot for system prompt |
| **Application** | `src/application/textualAgentLoop.ts` | Path B agent loop: XML tag interception, synthetic tool_use SSE, observation re-injection |
| **Application** | `src/application/services/nativeAgentLoopService.ts` | Path A agent loop (native tool_calls). Every iteration streams; iteration 0 additionally acts as the fallback guard |
| **Application** | `src/application/services/approvalGateService.ts` | Approval state machine: ask / auto / plan modes, trusted-file tracking, auto-approve allowlist |
| **Application** | `src/application/services/systemPromptBuilder.ts` | System prompt construction via `PromptRepositoryPort` + `PlanFileRepositoryPort` |
| **Application** | `src/application/services/contextCompactor.ts` | Trims the conversation to fit the context window: semantic summary, naive drop, and the tool-pairing repair both leave behind |
| **Application** | `src/application/useCases/handleChatMessageUseCase.ts` | Full `POST /v1/messages` orchestration: slash intercept → system prompt → compaction → translate → route → stream |
| **Application** | `src/application/useCases/resolveApprovalUseCase.ts` | `POST /v1/messages/:id/approve` — parse scope, delegate to `ApprovalInteractorPort` |
| **Infrastructure** | `src/infrastructure/workspaceActions.ts` | Shared action backend: list/read/grep/glob/write/edit/bash/python, path safety, bash timeout |
| **Infrastructure** | `src/infrastructure/server.ts` | HTTP router and wiring (416 lines): `/v1/messages`, `/v1/messages/:id/approve`, `/v1/exec-python`, `/health`, `/config`, `/commands`, `/agent-mode`. Zero business logic — all decisions live in the application layer |
| **Infrastructure** | `src/infrastructure/toolLimitDetector.ts` | Three-tier strategy for `maxTools`: config override → persistent cache → live probe |
| **Infrastructure** | `src/infrastructure/adapters/fetchLlmClient.ts` | `LlmClientPort` implementation via global `fetch()` |
| **Infrastructure** | `src/infrastructure/adapters/nodeSseWriter.ts` | `SseWriterPort` implementation via Node.js `ServerResponse` |
| **Infrastructure** | `src/infrastructure/adapters/fsPlanFileRepository.ts` | `PlanFileRepositoryPort` implementation via `node:fs` |
| **Infrastructure** | `src/infrastructure/adapters/fsMemoryRepository.ts` | `MemoryRepositoryPort` implementation: reads the workspace memory file, degrading every failure to "no memory" |
| **Infrastructure** | `src/infrastructure/adapters/fsPromptRepository.ts` | `PromptRepositoryPort` implementation via `node:fs` |
| **Infrastructure** | `src/infrastructure/adapters/sseApprovalInteractor.ts` | `ApprovalInteractorPort` implementation: emits `tool_request_pending` SSE + parks Promise |
| **Infrastructure** | `src/infrastructure/adapters/systemClock.ts` | `ClockPort` implementation via `Date.now()` |
| **Infrastructure** | `src/infrastructure/adapters/autoApproveConfig.ts` | `loadOldContent()` + `checkAutoApprove()` for `.claudio/auto-approve.json` allowlist |
| **Infrastructure** | `src/infrastructure/config.ts` | `loadConfig()` → `ProxyConfig` from environment variables |
| **Infrastructure** | `src/infrastructure/logger.ts` | `Logger` implements `ILogger`, stderr output with timestamps |
| **Infrastructure** | `src/infrastructure/modelInfo.ts` | `ModelInfoService.fetch()` — queries LM Studio `/api/v0/models` |
| **Infrastructure** | `src/infrastructure/toolProbe.ts` | `ToolProbe.detect()` — binary search for max tool count |
| **Infrastructure** | `src/infrastructure/persistentCache.ts` | Generic JSON file-backed key-value cache (stores maxTools per model ID) |
| **Infrastructure** | `src/infrastructure/httpUtils.ts` | `anthropicError()` — Anthropic-format error Response factory |
| **Infrastructure** | `src/infrastructure/i18nLoader.ts` | `loadLocale()` — reads JSON from `locales/`, calls `setMessages()` |
| **Infrastructure** | `src/infrastructure/thinkingProbe.ts` | Dual probe: whether reasoning is emitted, and whether `enable_thinking: false` suppresses it |
| **Infrastructure** | `src/infrastructure/thinkingDetector.ts` | Extracts `reasoning_content` from a backend response, whichever field it arrives in |
| **Infrastructure** | `src/infrastructure/pythonExecutor.ts` | Auto-managed venv behind the `python` workspace action |
| **Assets** | `locales/en_US.json` | English locale — 45 keys, flat map, `{{param}}` placeholders. Its shape is asserted by [`test/i18n.test.ts`](../test/i18n.test.ts) |
| **Assets** | `prompts/en_US/` | `agent-base.md`, `plan-mode.md`, `existing-plan-section.md`, `memory-section.md` — loaded through `PromptRepositoryPort` |
| **Tests** | `test/` | `node:test` suites, type-checked alongside the sources — see [testing.md](testing.md) |

---

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check: `{"status":"ok","target":"..."}`. Available immediately after `proxy.start()`. |
| `GET` | `/config` | Runtime config: proxyPort, targetUrl, temperature, systemPrompt, enableThinking, locale, maxTokensFallback, model info. Used by Claudio to auto-configure. |
| `GET` | `/commands` | Slash command registry (`SLASH_COMMAND_REGISTRY`). Used by Claudio for command autocomplete. |
| `POST` | `/v1/messages` | Main translation endpoint. Returns `503` while `initializeTools()` is still running. |
| `POST` | `/v1/messages/:requestId/approve` | Resolve a pending destructive-action approval. Body: `{"approved": bool}`. Returns `200 {"ok":true}`. |
| `GET` | `/plan-mode` | Current plan mode state: `{"enabled": bool}`. |
| `POST` | `/plan-mode` | Toggle plan mode. Body: `{"enabled": bool}`. Returns `{"enabled": bool}`. |

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
    │               Has workspace header?                           │
    │               ┌──────────────┤                               │
    │               │ YES          │ NO                            │
    │               │              │                               │
    │       maxTools > 0?      Normal path                         │
    │       ┌────────┤         (streaming or JSON)                 │
    │       │YES     │NO            │                              │
    │       │        │              │  POST /v1/chat/completions   │
    │  Path A:    Path B:           │ ──────────────────────────>  │
    │  runNative  runTextual        │<──────────────────────────   │
    │  AgentLoop  AgentLoop         │  SSE stream or JSON          │
    │  (stream:   (XML tag          │                              │
    │  false/true  parser)     stream=true?                        │
    │  up to 10    up to 10    ├── YES: StreamTranslator           │
    │  iterations) iterations) │        OpenAI SSE → Anthropic SSE │
    │       │        │         └── NO:  ResponseTranslator         │
    │  Both paths emit Anthropic SSE    JSON → JSON                │
    │  (tool_use blocks + text_delta)                              │
    │<──────┘────────┘─────────┘                                   │
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

> **Deep-dive docs**: [agent-loop.md](agent-loop.md) covers the full dual-path architecture, action set, and known limitations. [system-prompt-injection.md](system-prompt-injection.md) covers what the loop sees in the system prompt before running. [permission-protocol.md](permission-protocol.md) covers the approval flow for destructive actions.

When a client sends the `X-Workspace-Root` header, the proxy gives the LLM access to the workspace filesystem through one of two paths depending on the loaded model's capabilities.

### Workspace Tool Definition

A single tool slot with `action` as a discriminator (defined in [workspaceActions.ts:96-160](../src/infrastructure/workspaceActions.ts#L96-L160)):

```typescript
{
  type: "function",
  function: {
    name: "workspace",
    description: "Access the current workspace. Available actions: list, read, grep, glob, write, edit, bash",
    parameters: {
      type: "object",
      properties: {
        action:     { type: "string", enum: ["list","read","grep","glob","write","edit","bash"] },
        path:       { type: "string" },   // relative to workspace root
        pattern:    { type: "string" },   // for grep (regex) or glob (pattern)
        include:    { type: "string" },   // for grep: file filter (e.g. "*.ts")
        content:    { type: "string" },   // for write
        old_string: { type: "string" },   // for edit
        new_string: { type: "string" },   // for edit
        cmd:        { type: "string" }    // for bash
      },
      required: ["action"]
    }
  }
}
```

### Security

`safeResolvePath(workspaceCwd, relativePath)` resolves the path and rejects anything that does not start with the workspace root. Path traversal (`../../etc/passwd`), absolute paths, and symlink escapes are all rejected with an error string.

Destructive actions additionally require explicit user approval before executing — see [permission-protocol.md](permission-protocol.md).

### Two Paths

**Path A — Native Agent Loop** (`maxTools > 0`, e.g. Nemotron):

```
POST /v1/messages (with X-Workspace-Root)
  │
  ├── Round 0: POST /v1/chat/completions (non-streaming, guard)
  │     Model calls workspace(action="list", path=".")
  │     → proxy executes, injects result
  │
  └── Round 1+: POST /v1/chat/completions (streaming)
        thinking + text tokens forwarded to client in real time
        tool_calls consumed by proxy → execute → inject result
        ...
        Round N (up to 10): model produces only text → done
```

**Path B — Textual Agent Loop** (`maxTools == 0`, e.g. Qwen 3.5):

```
POST /v1/messages (with X-Workspace-Root)
  │
  ├── System prompt augmented with TEXTUAL_TOOL_MANUAL (XML tag protocol)
  │
  └── Round 0..N: POST /v1/chat/completions (streaming)
        text tokens forwarded to client in real time
        <action .../> tag detected by stateful parser
        → proxy executes, injects <observation>
        ...
        No action tag → stream done → message_stop
```

Both paths emit identical Anthropic SSE `tool_use` blocks toward the client.

---

## Context Compaction

The proxy automatically trims the conversation history when it approaches the model's context window limit. The logic lives in `compactMessages()` in [handleChatMessageUseCase.ts](../src/application/useCases/handleChatMessageUseCase.ts), called just before `RequestTranslator.translate()`.

**Algorithm:**

| Parameter | Value | Meaning |
|---|---|---|
| Trigger threshold | 80% of `loadedContextLength` | Start trimming when estimated tokens exceed this |
| Target | 65% of `loadedContextLength` | Trim until estimated tokens fall below this |
| Token estimation | `⌈JSON.stringify(messages).length / 4⌉` | 4 chars ≈ 1 token |

**Strategy:** the first user message (conversation anchor) is always preserved. Messages at index 1 onward are dropped oldest-first until the target is reached. A sentinel message is prepended to inform the model that earlier context was removed:

```
[N earlier message(s) were removed to fit the context window.]
```

Compaction only fires when `modelInfo.loadedContextLength > 0` (i.e. the model's context length was successfully fetched from LM Studio). It is a no-op when the model info is unavailable.

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
- [Permission Protocol](permission-protocol.md) — wire format for approving destructive actions
- [Startup Scripts](startup-scripts.md) — start_agent_cli.sh internals
