# Anthropic-to-OpenAI Proxy

A lightweight local proxy that lets **Claude Code** talk to any LLM served by an
OpenAI-compatible endpoint (LM Studio, ollama, vLLM, text-generation-webui, etc.).

The proxy receives requests in the **Anthropic Messages API** format
(`POST /v1/messages`), translates them to the **OpenAI Chat Completions** format
(`POST /v1/chat/completions`), forwards them to the local LLM, and translates the
response — including SSE streaming — back to the Anthropic format expected by the SDK.

```
Claude Code (Anthropic SDK)
       |
       |  POST /v1/messages  (Anthropic format, SSE)
       v
   +-----------+
   |   PROXY   |  :5678
   +-----------+
       |
       |  POST /v1/chat/completions  (OpenAI format, SSE)
       v
  LM Studio / ollama / vLLM
       :1234
```

---

## Table of Contents

1.  [Requirements](#requirements)
2.  [Quick Start](#quick-start)
3.  [Configuration](#configuration)
    - [.env.proxy — Proxy settings](#envproxy--proxy-settings)
    - [.env.claude — Claude Code settings](#envclaude--claude-code-settings)
    - [Port map](#port-map)
4.  [Scripts](#scripts)
    - [start.sh](#startsh)
    - [start_claude_code.sh](#start_claude_codesh)
5.  [Design Principles](#design-principles)
6.  [Sandbox Mode](#sandbox-mode)
7.  [Architecture](#architecture)
    - [Request translation (Anthropic to OpenAI)](#request-translation-anthropic-to-openai)
    - [Non-streaming response translation](#non-streaming-response-translation)
    - [Streaming response translation (state machine)](#streaming-response-translation-state-machine)
    - [Thinking / Reasoning support](#thinking--reasoning-support)
8.  [Reference Mappings](#reference-mappings)
    - [Messages](#messages)
    - [Tools](#tools)
    - [Tool choice](#tool-choice)
    - [Stop reason](#stop-reason)
    - [Ignored fields](#ignored-fields)
9.  [Verified Edge Cases](#verified-edge-cases)
10. [Known Limitations](#known-limitations)
11. [Model Compatibility](#model-compatibility)
12. [Manual Testing](#manual-testing)
13. [Troubleshooting](#troubleshooting)
14. [File Structure](#file-structure)

---

## Requirements

| Requirement | Minimum version | Notes |
|-------------|----------------|-------|
| [Bun](https://bun.sh) | >= 1.0 | TypeScript runtime; powers `Bun.serve` |
| Local LLM server | any | Must expose `POST /v1/chat/completions` |
| Claude Code | any | The Anthropic CLI you want to connect |

The only dependency is `bun-types` (dev-only, for IDE type checking). The proxy
itself uses only Bun built-ins (`Bun.serve`, `fetch`, `ReadableStream`, `crypto`).

---

## Quick Start

### 1. Install dependencies

```bash
cd proxy && bun install
```

This installs `bun-types` (dev-only, needed for IDE type checking). Only required once.

### 2. Make sure your local LLM is running

Verify with:

```bash
curl -s http://127.0.0.1:1234/v1/models | python3 -m json.tool
```

### 3. Run everything

From the **repository root**:

```bash
./start.sh
```

The script will:

1. Check that `bun` is installed and the LLM server is reachable
2. Start the proxy in the background on port 5678
3. Wait for the proxy health check to pass
4. If no model is configured, query the LLM server and let you pick one interactively
5. Launch `claude` with the right environment variables
6. When you exit Claude Code, automatically shut down the proxy

That's it. One command.

### Alternative: run components separately

```bash
# Terminal 1 — start proxy only
bun run proxy/server.ts

# Terminal 2 — start Claude Code only (proxy must be running)
./start_claude_code.sh
```

---

## Configuration

All configuration lives in two `.env` files. Environment variables set in the shell
**always override** values from the files.

### .env.proxy — Proxy settings

| Variable | Default | Required | Description |
|----------|---------|:--------:|-------------|
| `PROXY_PORT` | `5678` | No | Port the proxy listens on |
| `TARGET_URL` | `http://127.0.0.1:1234/v1/chat/completions` | No | Full URL of the OpenAI-compatible endpoint |
| `DEBUG` | `0` | No | Set to `1` for verbose SSE event logging |

### .env.claude — Claude Code settings

| Variable | Default | Required | If missing |
|----------|---------|:--------:|------------|
| `ANTHROPIC_MODEL` | *(none)* | **Yes** | The script queries `GET /v1/models` on the LLM server and presents an interactive numbered menu |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:${PROXY_PORT}` | No | Derived automatically from `PROXY_PORT` |
| `ANTHROPIC_API_KEY` | `local-proxy` | No | Any non-empty string; the proxy ignores it, but the SDK requires one |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` | No | Strips beta fields from tool schemas that LM Studio rejects |
| `CLAUDE_CODE_SIMPLE` | `1` | No | Sandbox mode — disables OAuth, keychain, telemetry, and all background prefetches (see [Sandbox Mode](#sandbox-mode)) |
| `DISABLE_AUTOUPDATER` | `1` | No | Prevents Claude Code from checking for updates |
| `DISABLE_TELEMETRY` | `1` | No | Disables anonymous usage metrics |

### Port map

These are the default ports used by each component. They are deliberately chosen to
avoid conflicts with each other and with common development tools:

| Component | Default port | Configurable via |
|-----------|:------------:|------------------|
| LM Studio | 1234 | LM Studio settings |
| Proxy | 5678 | `PROXY_PORT` in `.env.proxy` |
| ollama (if used instead) | 11434 | `TARGET_URL` in `.env.proxy` |
| vLLM (if used instead) | 8000 | `TARGET_URL` in `.env.proxy` |

The proxy port (`5678`) was chosen to avoid `8080` (commonly used by dev servers,
Jenkins, etc.) and to stay away from the LLM server ports listed above.

---

## Scripts

### start.sh

**Orchestrator** — starts everything in the right order and cleans up on exit.

```
1. Load .env.proxy
2. Verify bun is installed
3. Verify the LLM server is reachable
4. Check that PROXY_PORT is available
5. Start the proxy in the background (bun run proxy/server.ts)
6. Wait for the proxy health check (GET /health, retry with timeout)
7. Call ./start_claude_code.sh in the foreground
8. On exit (EXIT/INT/TERM), kill the proxy process
```

### start_claude_code.sh

**Claude Code launcher** — can also be called standalone when the proxy is already
running (useful for restarting Claude Code without restarting the proxy).

```
1. Load proxy/.env.proxy (for PROXY_PORT)
2. Load proxy/.env.claude
3. If ANTHROPIC_MODEL is empty:
   a. GET /v1/models from the LLM server
   b. Display a numbered list of available models (excluding embeddings)
   c. Prompt the user to pick one
4. Resolve ${PROXY_PORT} in ANTHROPIC_BASE_URL
5. Export all variables
6. exec claude (replaces the shell process)
```

---

## Design Principles

### Agnostic

The proxy **does not depend on any specific model**. The `model` field from the
Anthropic request is forwarded as-is to the LLM server. No conditional logic is based
on the model name. You can swap models in LM Studio without touching the proxy.

### Adaptive

The proxy **auto-detects model capabilities from the response**, not from the request
or model name:

- **Reasoning / Thinking**: if the model returns `reasoning_content` (non-empty),
  the proxy translates it into Anthropic `thinking` blocks. If the field is absent
  or empty, no thinking blocks are emitted.
- **Tool calling**: detected by the presence of `tool_calls` in the response.
- **Token counts**: uses real values from `usage` when available.

### Reactive

In streaming mode, the proxy operates as a **chunk-by-chunk state machine**:

- `delta.reasoning_content` arrives → open/accumulate a thinking block
- `delta.content` arrives → open/accumulate a text block (close thinking if open)
- `delta.tool_calls` arrives → open tool_use blocks
- `finish_reason` arrives → close everything

No advance knowledge of the model's output is needed.

---

## Sandbox Mode

Claude Code is designed to connect to Anthropic's servers for authentication, user
profile, subscription info, telemetry, bootstrap configuration, and many other
background services. When using a local LLM proxy, **none of these services exist** —
and the connections would leak personal account information or fail with errors.

The startup scripts enable **sandbox mode** (`CLAUDE_CODE_SIMPLE=1`, also known as
`--bare` mode) to prevent all of this. When active, Claude Code:

| Feature | Behavior in sandbox |
|---------|-------------------|
| OAuth / keychain reads | **Disabled** — no tokens loaded, no refresh attempts |
| User profile / subscription | **Skipped** — `isClaudeAISubscriber()` returns false |
| Background prefetches | **Skipped** — no bootstrap, quota, fast mode, or passes checks |
| Telemetry / analytics | **Disabled** — no metrics sent to `api.anthropic.com` |
| Auto-updater | **Disabled** — no update checks |
| MCP cloud configs | **Skipped** — no remote MCP server list fetched |
| LSP / skill scanning | **Skipped** — reduces startup overhead |
| Authentication | **API key only** — uses `ANTHROPIC_API_KEY` from `.env.claude` |

This is controlled by three environment variables in `.env.claude` (and enforced by
`start_claude_code.sh`):

```env
CLAUDE_CODE_SIMPLE=1       # Core sandbox — ~30 gates across the codebase
DISABLE_AUTOUPDATER=1      # No update checks
DISABLE_TELEMETRY=1        # No anonymous metrics
```

If you need to temporarily disable sandbox mode (e.g. to test with a real Anthropic
account), set `CLAUDE_CODE_SIMPLE=0` in your shell before running the scripts — shell
environment variables override `.env` file values.

---

## Architecture

### Request translation (Anthropic to OpenAI)

`translateRequest()` is synchronous and pure. It converts:

```
Anthropic POST /v1/messages          OpenAI POST /v1/chat/completions
====================================  ====================================
{                                     {
  model: "...",                         model: "...",
  system: [{type:"text",text:"..."}],   messages: [
  messages: [                             {role:"system",content:"..."},
    {role:"user", content:[...]},         {role:"user",content:"..."},
    {role:"assistant",content:[...]},     {role:"assistant",content:"...",
  ],                                         tool_calls:[...]},
  tools: [{name,description,             {role:"tool",tool_call_id,content},
           input_schema}],              ],
  tool_choice: {type:"auto"},           tools: [{type:"function",
  max_tokens: 8192,                              function:{name,description,
  stream: true,                                           parameters}}],
  thinking: {type:"enabled"},           tool_choice: "auto",
  temperature: 0.7,                     max_tokens: 8192,
  betas: [...],                         stream: true,
  metadata: {...},                      temperature: 0.7,
  cache_control: {...},                }
}
```

### Non-streaming response translation

`translateResponse()` converts a single OpenAI JSON response to Anthropic format:

```
OpenAI                                Anthropic
====================================  ====================================
{                                     {
  choices: [{                           id: "msg_proxy_...",
    message: {                          type: "message",
      content: "Hello",                 role: "assistant",
      reasoning_content: "Think..",     model: "...",
      tool_calls: [{                    content: [
        id: "123",                        {type:"thinking",
        function: {                          thinking:"Think..",
          name: "Bash",                      signature:""},
          arguments: "{...}",             {type:"text",text:"Hello"},
        }                                 {type:"tool_use",
      }],                                    id:"123",name:"Bash",
    },                                       input:{...}},
    finish_reason: "tool_calls",        ],
  }],                                   stop_reason: "tool_use",
  usage: {                              usage: {
    prompt_tokens: 100,                   input_tokens: 100,
    completion_tokens: 50,                output_tokens: 50,
  },                                    },
}                                     }
```

### Streaming response translation (state machine)

`translateStream()` converts an OpenAI SSE stream into an Anthropic SSE stream,
event by event.

**State:**

```
started: boolean              // message_start emitted?
contentIndex: number          // current content block index
thinkingBlockOpen: boolean    // thinking block open?
textBlockOpen: boolean        // text block open?
toolCallsStarted: boolean     // any tool_calls seen?
toolCalls: Map<index, {...}>  // in-flight tool calls
finalized: boolean            // message_delta/stop emitted?
```

**Event flow:**

```
OpenAI chunk                           Anthropic event(s)
-------------------------------------  ------------------------------------
delta.role="assistant"              -> message_start
delta.reasoning_content="Think..."  -> content_block_start (thinking)
                                       content_block_delta (thinking_delta)
(first delta.content)               -> content_block_stop  (close thinking)
delta.content="Hello"               -> content_block_start (text)
                                       content_block_delta (text_delta)
delta.tool_calls[{id,name,args}]    -> content_block_stop  (close text)
                                       content_block_start (tool_use)
                                       content_block_delta (input_json_delta)
finish_reason="stop"                -> content_block_stop  (all blocks)
                                       message_delta (stop_reason:"end_turn")
                                       message_stop
finish_reason="tool_calls"          -> ... (stop_reason:"tool_use")
finish_reason="length"              -> ... (stop_reason:"max_tokens")
[DONE]                              -> (end of stream / fallback finalize)
```

### Thinking / Reasoning support

The proxy handles thinking **conditionally** based on the Anthropic request:

| Anthropic request | Model response | Proxy behavior |
|-------------------|---------------|----------------|
| `thinking: {type:"enabled"}` | `reasoning_content` present and non-empty | Translated to `thinking` blocks with `signature: ""` |
| `thinking: {type:"enabled"}` | `reasoning_content` absent or `""` | No thinking blocks emitted |
| `thinking: {type:"adaptive"}` | any | Same as `enabled` |
| `thinking: {type:"disabled"}` | any | Reasoning discarded, no thinking blocks |
| *(field absent)* | any | Same as `disabled` |

The `signature` field is always `""`. In the Anthropic protocol it is used for
cryptographic verification of Claude's thinking — not applicable to local models.
Claude Code initializes it to `""` anyway (`claude.ts:2037`), so this causes no errors.

> **Note**: Local models (e.g. nemotron) produce `reasoning_content` regardless of
> the request. The proxy uses the request's `thinking` field only to decide WHETHER
> to translate reasoning into the response.

---

## Reference Mappings

### Messages

| Anthropic block (request) | OpenAI message |
|---------------------------|----------------|
| `{role:"user", content:[{type:"text", text:"..."}]}` | `{role:"user", content:"..."}` |
| `{role:"user", content:[{type:"tool_result", tool_use_id:"X", content:"..."}]}` | `{role:"tool", tool_call_id:"X", content:"..."}` |
| `{role:"assistant", content:[{type:"text", text:"..."}]}` | `{role:"assistant", content:"..."}` |
| `{role:"assistant", content:[{type:"tool_use", id:"X", name:"Bash", input:{...}}]}` | `{role:"assistant", tool_calls:[{id:"X", type:"function", function:{name:"Bash", arguments:"{...}"}}]}` |
| `{type:"thinking", ...}` | *(discarded — model generates its own reasoning)* |
| `{type:"image", ...}` / `{type:"document", ...}` | *(discarded)* |

### Tools

| Anthropic | OpenAI |
|-----------|--------|
| `{name, description, input_schema: {type:"object", properties:{...}}}` | `{type:"function", function:{name, description, parameters:{type:"object", properties:{...}}}}` |

Conversion: `input_schema` becomes `parameters`, wrapped in `{type:"function", function:{...}}`.

### Tool choice

| Anthropic | OpenAI | Notes |
|-----------|--------|-------|
| `{type:"auto"}` | `"auto"` | |
| `{type:"any"}` | `"auto"` | |
| `{type:"none"}` | `"none"` | |
| `{type:"tool", name:"X"}` | `"required"` | LM Studio does not support forcing a specific tool; falls back to "required" |

### Stop reason

| OpenAI `finish_reason` | Anthropic `stop_reason` |
|------------------------|------------------------|
| `"stop"` | `"end_turn"` |
| `"tool_calls"` | `"tool_use"` |
| `"length"` | `"max_tokens"` |

### Ignored fields

These Anthropic request fields are silently discarded (no OpenAI equivalent or not
meaningful for local LLMs):

- `betas` — Anthropic-specific feature flags
- `metadata` — Claude Code session metadata
- `cache_control` — Anthropic prompt caching
- `speed` — fast mode
- `output_config` — effort / budget
- `context_management` — Anthropic context management
- `anthropic_internal` — internal fields
- `anti_distillation` — distillation protection

---

## Verified Edge Cases

These behaviors were **verified directly** against the LM Studio API with real models
(nemotron-cascade-2-30b-a3b, omnicoder-9b, qwen3.5-9b, qwen3-4b):

### Numeric tool IDs

LM Studio generates tool IDs like `"831176498"` (numeric strings) instead of the
`"call_xxx"` format used by OpenAI. The proxy passes them through opaquely — the
Anthropic SDK treats them as opaque strings, so they work fine.

### Spurious content with tool calls

The model often produces `content: "\n\n"` even when making tool calls. The proxy
filters out empty/whitespace-only content when tool_calls are present, preventing
empty text blocks in the Anthropic response.

### Streaming order with tool calls

The typical chunk order observed during streaming:

1. `delta.reasoning_content` (model's thinking)
2. `delta.content: "\n"` (spurious)
3. `delta.tool_calls` (name + arguments)
4. `delta.content: "\n"` (spurious)
5. `finish_reason: "tool_calls"`

The proxy handles **content interleaved with tool_calls**: it closes the text block
before tool_calls and ignores empty content after them.

### Reasoning consuming max_tokens

With a low `max_tokens`, the model may use all tokens for reasoning without producing
any content (`finish_reason: "length"`, `content: ""`). The proxy correctly handles
responses with only thinking and no text block.

### Tool arguments in a single chunk

LM Studio often sends all tool call arguments in a single SSE chunk (e.g.
`{"command":"echo hello"}` as one piece), not fragmented. The proxy emits a single
`input_json_delta` with the complete JSON.

### First chunk with role + reasoning

The first SSE chunk from LM Studio contains both `delta.role: "assistant"` and
`delta.reasoning_content: "..."`. The proxy emits in sequence:
`message_start` → `content_block_start(thinking)` → `content_block_delta(thinking_delta)`.

### Tool result with content array

When Anthropic sends `tool_result` with `content` as an array of blocks (rather than
a string), the proxy extracts and concatenates the text blocks.

---

## Known Limitations

### Token counting

The proxy uses token counts reported by LM Studio (`usage.prompt_tokens`,
`usage.completion_tokens`). In streaming, tokens are only available in the final chunk
(with `finish_reason`). The `message_start` event reports `input_tokens: 0` as a
placeholder — the real value arrives in the final `message_delta`.

### Thinking signature

The `signature` field on thinking blocks is always `""`. It is used for cryptographic
verification of Anthropic Claude's thinking — not applicable to local models.

### Specific tool_choice

LM Studio does not support forcing a specific tool
(`{type:"function", function:{name:"X"}}`). The proxy falls back to `"required"`
(forces any tool call, but not a specific one).

### No parallel multi-tool

The local models tested (nemotron, qwen) call one tool at a time. Claude Code's
parallel tool operations will be serialized automatically.

### Tool calling quality

Tool calling quality depends entirely on the local model. With ~40 simultaneous tools
(as in Claude Code), smaller models may:
- Pick the wrong tool
- Use incorrect parameter names (e.g. `input` instead of `command`)
- Produce malformed JSON in arguments

### Cache control

Ignored completely — not meaningful for local LLMs that have no prompt caching.

---

## Model Compatibility

The proxy has been tested with the following models on LM Studio:

| Model | Reasoning | Tool calling | Notes |
|-------|:---------:|:------------:|-------|
| nemotron-cascade-2-30b-a3b@6bit | Yes | Yes | Reasoning + tool calls work well |
| nemotron-cascade-2-30b-a3b@4bit | Yes | Yes | Same, more aggressive quantization |
| omnicoder-9b | Yes | Not tested | Very verbose reasoning |
| qwen3.5-9b | Yes | Yes | Good quality/speed balance |
| qwen3.5-27b | — | — | LM Studio crash (insufficient memory) |
| qwen/qwen3-4b-2507 | No (*) | Not tested | `reasoning_content: ""` (present but empty) |

(*) The `reasoning_content` field is present in the response but always empty — the
proxy handles this correctly by not emitting thinking blocks.

Any model served by an OpenAI-compatible endpoint should work. The proxy has no
model-specific logic.

---

## Manual Testing

### Health check

```bash
curl -s http://127.0.0.1:5678/health | python3 -m json.tool
```

Expected:
```json
{"status": "ok", "target": "http://127.0.0.1:1234/v1/chat/completions"}
```

### Non-streaming without tools

```bash
curl -s -X POST http://127.0.0.1:5678/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: fake-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "nemotron-cascade-2-30b-a3b@6bit",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "Say hello in one word."}]}],
    "max_tokens": 100,
    "stream": false
  }' | python3 -m json.tool
```

Expected:
```json
{
    "id": "msg_proxy_...",
    "type": "message",
    "role": "assistant",
    "model": "nemotron-cascade-2-30b-a3b@6bit",
    "content": [{"type": "text", "text": "Hello"}],
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": {"input_tokens": 39, "output_tokens": 72}
}
```

### Non-streaming with thinking

```bash
curl -s -X POST http://127.0.0.1:5678/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: fake-key" \
  -d '{
    "model": "nemotron-cascade-2-30b-a3b@6bit",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "What is 5+3?"}]}],
    "max_tokens": 500,
    "stream": false,
    "thinking": {"type": "enabled", "budget_tokens": 1000}
  }' | python3 -m json.tool
```

Expected: `content` array with a `thinking` block followed by a `text` block:
```json
{
    "content": [
        {"type": "thinking", "thinking": "...", "signature": ""},
        {"type": "text", "text": "5 + 3 = 8"}
    ],
    "stop_reason": "end_turn"
}
```

### Non-streaming with tool call

```bash
curl -s -X POST http://127.0.0.1:5678/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: fake-key" \
  -d '{
    "model": "nemotron-cascade-2-30b-a3b@6bit",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "List files in /tmp"}]}],
    "max_tokens": 300,
    "stream": false,
    "thinking": {"type": "enabled", "budget_tokens": 1000},
    "tools": [{"name": "Bash", "description": "Execute a bash command", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}]
  }' | python3 -m json.tool
```

Expected:
```json
{
    "content": [
        {"type": "thinking", "thinking": "...", "signature": ""},
        {"type": "tool_use", "id": "...", "name": "Bash", "input": {"command": "ls -la /tmp"}}
    ],
    "stop_reason": "tool_use"
}
```

### Streaming with thinking and text

```bash
curl -s -N -X POST http://127.0.0.1:5678/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: fake-key" \
  -d '{
    "model": "nemotron-cascade-2-30b-a3b@6bit",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "Say hello"}]}],
    "max_tokens": 300,
    "stream": true,
    "thinking": {"type": "enabled", "budget_tokens": 1000}
  }'
```

Expected event sequence:
```
event: message_start        -> initial message
event: content_block_start  -> {type:"thinking"}
event: content_block_delta  -> {type:"thinking_delta", thinking:"..."}  (repeated)
event: content_block_stop   -> close thinking
event: content_block_start  -> {type:"text"}
event: content_block_delta  -> {type:"text_delta", text:"..."}  (repeated)
event: content_block_stop   -> close text
event: message_delta        -> {stop_reason:"end_turn"}
event: message_stop         -> done
```

### Streaming with thinking and tool call

```bash
curl -s -N -X POST http://127.0.0.1:5678/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: fake-key" \
  -d '{
    "model": "nemotron-cascade-2-30b-a3b@6bit",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "Run: echo hello"}]}],
    "max_tokens": 300,
    "stream": true,
    "thinking": {"type": "enabled", "budget_tokens": 1000},
    "tools": [{"name": "Bash", "description": "Execute a bash command", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}]
  }'
```

Expected event sequence:
```
event: message_start        -> initial message
event: content_block_start  -> {type:"thinking"}
event: content_block_delta  -> {type:"thinking_delta"}  (repeated)
event: content_block_stop   -> close thinking
event: content_block_start  -> {type:"tool_use", id:"...", name:"Bash"}
event: content_block_delta  -> {type:"input_json_delta", partial_json:"..."}
event: content_block_stop   -> close tool_use
event: message_delta        -> {stop_reason:"tool_use"}
event: message_stop         -> done
```

---

## Troubleshooting

### "Cannot connect to LLM at ..."

The proxy cannot reach the LLM server. Check that:
- LM Studio (or another server) is running and a model is loaded
- The port is correct (`TARGET_URL` in `.env.proxy`)
- `curl http://127.0.0.1:1234/v1/models` returns the model list

### "Extra inputs are not permitted"

You forgot `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` when launching Claude Code.
This is set automatically by `.env.claude` and the startup scripts, but if you launch
`claude` manually you must set it yourself.

### Response with only thinking and no text

The `max_tokens` is too low. The model used all tokens for reasoning without producing
content. Claude Code generally uses high values (8192–16384), so this does not happen
in normal operation.

### Tool call with wrong parameters

The local model may use different parameter names than expected (e.g. `input` instead
of `command`). This is a model limitation, not a proxy issue. Larger or
tool-calling-specialized models produce better results.

### Claude Code won't start / authentication error

Make sure `ANTHROPIC_API_KEY` is set to a non-empty value (any string works). The
Anthropic SDK requires this variable to be present.

### Port already in use

If you see "Port 5678 is already in use", either:
- Another proxy instance is running — kill it first
- Another service uses that port — change `PROXY_PORT` in `.env.proxy`

### Verbose debugging

To see every translated SSE event and full request/response bodies:

```bash
DEBUG=1 bun run proxy/server.ts
```

Or set `DEBUG=1` in `.env.proxy`.

---

## File Structure

```
./
  start.sh                 Orchestrator: proxy + health check + Claude Code + cleanup
  start_claude_code.sh     Claude Code launcher with interactive model selection
  proxy/
    server.ts              Server proxy (~500 lines TypeScript)
                             translateRequest()    — Anthropic to OpenAI (sync, pure)
                             translateResponse()   — OpenAI to Anthropic (non-streaming)
                             translateStream()     — OpenAI SSE to Anthropic SSE (state machine)
                             handleMessages()      — main POST /v1/messages handler
                             Bun.serve()           — HTTP routing
    .env.proxy             Proxy configuration (port, target URL, debug)
    .env.claude            Claude Code configuration (model, API key, base URL)
    README.md              This file
```
