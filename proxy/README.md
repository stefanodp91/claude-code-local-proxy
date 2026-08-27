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

## Documentation

- [CLAUDE.md](../CLAUDE.md) — orientation for anyone picking the project up: invariants, working method, current state
- [Quick Setup](docs/quick-setup.md) — minimum configuration to get up and running
- [Architecture](docs/architecture.md) — hexagonal structure, request flow, SSE state machine, slash commands, workspace tool
- [Configuration](docs/configuration.md) — complete reference for all environment variables
- [Agent Loop](docs/agent-loop.md) — Path A (native tool calls) and Path B (textual tags)
- [Permission Protocol](docs/permission-protocol.md) — approval gate and the `tool_request_pending` SSE handshake
- [System Prompt Injection](docs/system-prompt-injection.md) — what the proxy prepends, and when
- [Tool Management](docs/tool-management.md) — scoring algorithm, UseTool, promotion, probe, persistent cache
- [Testing](docs/testing.md) — automated suites, how to run them, what is not covered yet
- [Lifecycle](docs/lifecycle.md) — multi-instance architecture and port discovery
- [Startup Scripts](docs/startup-scripts.md) — start_agent_cli.sh internals

---

## Table of Contents

1.  [Requirements](#requirements)
2.  [Quick Start](#quick-start)
3.  [Configuration](#configuration)
    - [.env.proxy — Proxy settings](#envproxy--proxy-settings)
    - [.env.claude — Claude Code settings](#envclaude--claude-code-settings)
    - [Port map](#port-map)
4.  [Scripts](#scripts)
    - [npm scripts](#npm-scripts)
    - [start_agent_cli.sh](#start_agent_clish)
    - [scripts/regression.sh](#scriptsregressionsh)
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
12. [Tests](#tests)
13. [Manual Smoke Tests](#manual-smoke-tests)
14. [Troubleshooting](#troubleshooting)
15. [File Structure](#file-structure)

---

## Requirements

| Requirement | Minimum version | Notes |
|-------------|----------------|-------|
| [Node.js](https://nodejs.org) | >= 18 | Runs the proxy; CI builds on 24 |
| Local LLM server | any | Must expose `POST /v1/chat/completions` |
| Claude Code | any | The Anthropic CLI you want to connect — only needed for the CLI path |

**`dependencies` is empty and stays empty.** The proxy uses nothing but Node
built-ins: `node:http`, `fetch`, `node:fs`, `node:crypto`. The four
`devDependencies` (`tsx`, `tsup`, `typescript`, `@types/node`) never reach a
running process — they type-check, run TypeScript sources directly, and bundle.

That property is worth defending. It is what makes deployment a file copy, and
what let the test suite be written against real objects instead of a mock
framework.

---

## Quick Start

### 1. Install dependencies

```bash
cd proxy && npm install
```

Installs the dev toolchain only — `dependencies` is empty. Required once.

### 2. Make sure your local LLM is running

Verify with:

```bash
curl -s http://127.0.0.1:1234/v1/models | python3 -m json.tool
```

Load the model **before** starting the proxy. The proxy probes the model's tool
ceiling and thinking behaviour before it begins listening, so a cold model makes
`/health` unreachable for a minute or more — which looks exactly like a hung
proxy. See [Probe-before-listen](#probe-before-listen) below.

### 3. Run everything

From the **repository root**:

```bash
sh start_agent_cli.sh
```

The script will:

1. Find a free port, starting from `PROXY_PORT` (5678) and walking upward
2. Check that `node` is installed and that the LLM server answers `/v1/models`
3. Spawn the proxy in the background on the port it found, logging to `proxy.log`
4. Poll `GET /health` until the proxy answers (30 attempts, 1s apart)
5. If no model is configured, list the available models and let you pick one
6. `exec claude` with the right environment variables
7. Kill the proxy on exit, via a trap on `EXIT`/`INT`/`TERM`

Because the port is discovered per invocation, several agents can run side by
side without colliding. Details in [Startup Scripts](docs/startup-scripts.md)
and [Lifecycle](docs/lifecycle.md).

### Alternative: run the proxy on its own

```bash
# Fixed port, foreground, no Claude Code
cd proxy && npm start

# Same, with a watcher that restarts on source changes
cd proxy && npm run dev
```

Claudio (the VS Code extension) needs none of this: it spawns and supervises its
own proxy instance when the project folder opens.

#### Probe-before-listen

`main.ts` awaits model info and both probes — tool limit and thinking — and only
then calls `start()`. Nothing answers on the port until probing finishes. This is
deliberate (a request served before the tool ceiling is known would be routed on
a guess), but it means "connection refused" during the first minute after launch
is normal rather than a failure. A model already resident in LM Studio removes
the delay almost entirely; `model-cache.json` removes the tool probe on every
subsequent start with the same model.

---

## Configuration

All configuration lives in two `.env` files. Environment variables set in the shell
**always override** values from the files.

### .env.proxy — Proxy settings

| Variable | Default | Required | Description |
|----------|---------|:--------:|-------------|
| `PROXY_PORT` | `5678` | No | Port the proxy listens on. The launchers walk upward from here to find a free one |
| `TARGET_URL` | `http://127.0.0.1:1234/v1/chat/completions` | No | Full URL of the OpenAI-compatible endpoint |
| `DEBUG` | `0` | No | Set to `1` for verbose SSE event logging |

These three are the ones you are likely to touch. There are about twenty more — tool
limits and probe bounds, scoring weights, agent iteration tiers, compaction
thresholds — all parsed in one place by `loadConfig()` and documented in
[Configuration](docs/configuration.md). No module reads `process.env` directly.

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

### npm scripts

| Script | Command | What it does |
|---|---|---|
| `npm start` | `node --import tsx src/main.ts` | Runs the proxy from TypeScript sources, no build step |
| `npm run dev` | `tsx --watch src/main.ts` | Same, restarting on source changes |
| `npm run build` | `tsup … --outDir dist` | Bundles an ESM build targeting Node 18 |
| `npm run typecheck` | `tsc --noEmit` | Type-checks `src/` **and** `test/` |
| `npm test` | `node --import tsx --test "test/**/*.test.ts"` | Runs the automated suites — see [Tests](#tests) |

`npm test` is preceded by a `pretest` guard that fails the run when the glob
matches no files. `node --test` exits 0 on an empty run, so without it a broken
glob would report success while verifying nothing.

### start_agent_cli.sh

Lives at the **repository root**, not in `proxy/`. One command that finds a free
port, spawns a proxy, waits for its health check, offers an interactive model
picker, launches Claude Code, and tears the proxy down on exit. The flow is
listed under [Quick Start](#3-run-everything) and dissected in
[Startup Scripts](docs/startup-scripts.md).

> The earlier `start.sh` and `start_claude_code.sh` pair no longer exists. The
> CLI half became `start_agent_cli.sh`; the supervision half became
> `ProxyManager` inside Claudio.

### scripts/regression.sh

A curl-driven snapshot of proxy behaviour against a **live** backend: it needs
the proxy running, LM Studio up, and a model loaded. That makes it useful before
a release and unusable as a merge gate — it cannot run on CI, which has no GPU.

It is not a substitute for `npm test`, and the two should not be conflated: one
checks that the translation logic is correct, the other checks that a particular
model still behaves the way it did last week.

---

## Design Principles

### Agnostic

The proxy **does not depend on any specific model**. The `model` field from the
Anthropic request is forwarded as-is to the LLM server. No conditional logic is based
on the model name. You can swap models in LM Studio without touching the proxy.

### Adaptive

The proxy **auto-detects model capabilities and tunes behaviour from runtime data**, not from the request or model name:

- **Reasoning / Thinking**: if the model returns `reasoning_content` (non-empty), the proxy translates it into Anthropic `thinking` blocks. If the field is absent or empty, no thinking blocks are emitted.
- **Tool calling**: detected by the presence of `tool_calls` in the response.
- **Token counts**: uses real values from `usage` when available.
- **Agent loop iterations**: the iteration ceiling is derived from the model's loaded context window (10 for ≤8 K context, up to 40 for ≥64 K). Recomputed on every turn — model changes via LM Studio take effect immediately.
- **Summarization budget**: the token budget for context compaction is `~2%` of the context window, capped at `SUMMARY_MAX_TOKENS`.

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

This is controlled by three environment variables in `.env.claude`, exported by
`start_agent_cli.sh` before it execs `claude`:

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
drops empty/whitespace-only content when tool_calls are present, preventing empty
text blocks in the Anthropic response.

Streaming needs a second mechanism for it. The usual order is padding *first* and
the tool call second, so at the moment the whitespace arrives nothing yet knows a
call is coming. Whitespace that would open a text block is therefore held back:
flushed ahead of the next real text, and discarded if a tool call turns up
instead. Covered by [`test/streamTranslator.test.ts`](test/streamTranslator.test.ts).

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

### Parallel tool benefit is model-dependent

Read-only workspace actions (`list`, `read`, `grep`, `glob`) are dispatched in parallel
at the proxy level via `Promise.all`. The actual speedup depends on whether the model
emits multiple tool calls in a single turn — most local models (Qwen, Llama) call one
tool at a time, so parallel dispatch has no effect on them. Frontier models are more
likely to batch multiple calls per turn.

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
| qwen/qwen3.8-27b (MLX 4-bit) | Always on | Yes, ≥96 tools | 119 552 ctx. Reasoning **cannot be switched off** — see note (**). Measured 2026-08-26 |
| nemotron-cascade-2-30b-a3b@6bit | Yes | Yes | Reasoning + tool calls work well |
| nemotron-cascade-2-30b-a3b@4bit | Yes | Yes | Same, more aggressive quantization |
| omnicoder-9b | Yes | Not tested | Very verbose reasoning |
| qwen3.5-9b | Yes | Yes | Good quality/speed balance |
| qwen3.5-27b | — | — | LM Studio crash (insufficient memory) |
| qwen/qwen3-4b-2507 | No (*) | Not tested | `reasoning_content: ""` (present but empty) |

(*) The `reasoning_content` field is present in the response but always empty — the
proxy handles this correctly by not emitting thinking blocks.

(**) On `qwen/qwen3.8-27b` the model emits `reasoning_content` unconditionally. None
of the three switches suppress it: top-level `enable_thinking: false` (what the proxy
sends), `chat_template_kwargs.enable_thinking: false`, or the Qwen `/no_think` soft
switch. `ThinkingDetector` therefore records `thinkingCanBeDisabled: false`, which is
the correct answer — Claudio greys the thinking toggle out rather than offering a
control that would do nothing.

Tool-calling ceilings are per-model and do not transfer between models: an
architecture, its chat template, and how the backend parses its tool calls all
matter. Always read the number the probe writes to `model-cache.json` for the model
you actually loaded.

Any model served by an OpenAI-compatible endpoint should work. The proxy has no
model-specific logic.

---

## Tests

```bash
cd proxy && npm test
```

381 tests, ~1.1 s, no GPU, no LM Studio, no model loaded, no network. That is
the property that matters: it is why these can gate a pull request while
`scripts/regression.sh` cannot.

| Suite | Covers |
|---|---|
| [`test/i18n.test.ts`](test/i18n.test.ts) | Every key passed to `t()` exists in every locale; every locale is a *flat* map of strings; locales do not drift apart |
| [`test/toolProbe.test.ts`](test/toolProbe.test.ts) | `ToolProbe` outcome triage — a refusal searches downward, a timeout is retried rather than believed, an HTTP error is not read as a capability, a persistent timeout caps the search and says so |
| [`test/approvalGate.test.ts`](test/approvalGate.test.ts) | The `write`/`edit`/`bash`/`python` gate — precedence of plan mode, auto mode, trusted files and the allowlist; which approval scopes persist and which must not; workspace containment of a `scope: "file"` grant |
| [`test/requestTranslator.test.ts`](test/requestTranslator.test.ts) | Anthropic → OpenAI — system prompt shapes, tool-result and image ordering, tool and tool_choice mapping, `max_tokens` capping, explicit `enable_thinking` |
| [`test/responseTranslator.test.ts`](test/responseTranslator.test.ts) | OpenAI → Anthropic, non-streaming — block order, UseTool rewriting, stop-reason mapping, the never-empty content array |
| [`test/streamTranslator.test.ts`](test/streamTranslator.test.ts) | The SSE state machine — block lifecycle and indices, split and merged chunk boundaries, deferred UseTool emission, usage arriving after `finish_reason` |
| [`test/toolManager.test.ts`](test/toolManager.test.ts) | Which tools the model is offered when there are more than it can hold — scoring, the reserved UseTool slot, overflow reachability, tie stability, promotion and its decay |
| [`test/autoApproveConfig.test.ts`](test/autoApproveConfig.test.ts) | `.claudio/auto-approve.json` — rule matching, constraints that fail closed, unusable patterns, and the workspace containment of the diff preview read |
| [`test/workspaceActions.test.ts`](test/workspaceActions.test.ts) | The filesystem and shell backend — `safeResolvePath` containment, every action's success and failure strings, literal replacement in `edit`, output limits |
| [`test/textualAgentLoop.test.ts`](test/textualAgentLoop.test.ts) | Path B — tag parsing across chunk boundaries, both documented tag forms, approval scopes, the iteration ceiling, and agreement between the tool manual and the parser |
| [`test/nativeAgentLoop.test.ts`](test/nativeAgentLoop.test.ts) | Path A — the fallthrough contract, batched execution and its ordering, approval scopes, plan mode, the iteration ceiling, and a JSON reply to a streaming request |
| [`test/contextCompactor.test.ts`](test/contextCompactor.test.ts) | Trimming a conversation to fit the window — both strategies, the timeout, and tool-call pairing surviving the trim in both message shapes |
| [`test/systemPromptBuilder.test.ts`](test/systemPromptBuilder.test.ts) | What every request is prefixed with — mode selection, the textual tail, cross-session memory, and that every parameter the builder computes has a placeholder in the shipped template |
| [`test/fsMemoryRepository.test.ts`](test/fsMemoryRepository.test.ts) | Reading the memory file — missing, empty, oversized, and paths that leave the workspace |

Both suites exist because the bug they describe actually happened. `t()` returns
the key itself when a lookup misses and locale files arrive through `JSON.parse`,
so a *nested* key type-checks perfectly and reaches the user as the raw string
`tools.unsupportedByModel`. The probe collapsed every failure into `false`, so a
slow reply at 48 tools was indistinguishable from a model that could not handle
48 tools — and since more tools means a longer prompt and a slower reply, the
timeouts clustered exactly on the boundary the binary search was looking for.

Tests are covered by `npm run typecheck`, and both suites were verified by
negative control: reintroducing the nested locale key fails 2 of the 5 i18n
tests, and restoring `catch { return false }` fails exactly the 4 triage tests
and nothing else. A test that does not fail when the bug returns is decoration.

`LlmClientPort` and `SseWriterPort` are already ports, so they are fake-able
without a mock framework — the hexagonal architecture is paid for, it just has
to be used. `ToolProbe` still reaches for global `fetch` and the test stubs it;
if it ever becomes a port, that test gets simpler on its own.

Covered: everything on the Phase 1 priority list, both agent loops, the workspace
actions and the compactor. Not covered: the routing use case, the slash
interceptor, startup probing, and the thin adapters —
enumerated in [Testing](docs/testing.md#not-covered-yet), which also records what
each suite pins and what it found.

---

## Manual Smoke Tests

The curl calls below exercise the paths the automated suites do not reach yet.
They need a running proxy and a loaded model.

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

`start_agent_cli.sh` and Claudio both walk upward from `PROXY_PORT` until they
find a free port, so a busy 5678 is not normally fatal. You only see this when
starting the proxy directly with `npm start`, which honours `PROXY_PORT` exactly:

- Another proxy instance is running — kill it, or let the launcher pick a port
- Another service uses that port — change `PROXY_PORT` in `.env.proxy`

### Verbose debugging

To see every translated SSE event and full request/response bodies:

```bash
cd proxy && DEBUG=1 npm start
```

Or set `DEBUG=1` in `.env.proxy`. When the proxy was launched by
`start_agent_cli.sh` the output is in `proxy.log` at the repository root; when it
was launched by Claudio, in the extension's output channel.

---

## File Structure

```
./
  start_agent_cli.sh       Port discovery + proxy spawn + model picker + claude, with cleanup trap
  .github/workflows/ci.yml Typecheck & tests, on request only (no GPU required)
  proxy/
    src/
      main.ts              Composition root: loads config, builds adapters, probes, then listens
      domain/              Pure types, entities and ports. No I/O, no Node imports
        types.ts             Anthropic/OpenAI shapes, SSE event names, enums
        i18n.ts              t() — flat key lookup, returns the key on a miss
        entities/            workspaceAction (actions, ActionOutcome, ActionEnv),
                             existingPlan
        ports/               llmClient, sseWriter, logger, clock, approvalInteractor,
                             planFileRepository, promptRepository
      application/         Translation and orchestration. Depends on ports only
        requestTranslator.ts   Anthropic → OpenAI (sync, pure)
        responseTranslator.ts  OpenAI → Anthropic (non-streaming)
        streamTranslator.ts    OpenAI SSE → Anthropic SSE (state machine)
        toolManager.ts         Scoring, selection, UseTool overflow, promotion decay
        slashCommandInterceptor.ts  Handles /commit, /diff, /plan … before the LLM
        workspaceTool.ts       list/read/grep/glob/write/edit/bash/python definitions
        textualAgentLoop.ts    Path B — XML-tag actions for models with no tool support
        services/              nativeAgentLoopService (Path A), approvalGateService,
                               systemPromptBuilder, contextCompactor,
                               actionOutcome (where an action's image goes)
        useCases/              handleChatMessage (the routing decision), resolveApproval
      infrastructure/      Everything that touches the outside world
        server.ts              node:http routing: /v1/messages, /v1/messages/:id/approve,
                               /v1/exec-python, /health, /config, /commands, /agent-mode
        config.ts              loadConfig() — the only reader of process.env
        modelInfo.ts           LM Studio /api/v0/models metadata
        toolProbe.ts           Binary search for the model's tool ceiling
        toolLimitDetector.ts   Probe orchestration + cache read/write
        thinkingProbe.ts       Detects whether reasoning is emitted and suppressible
        pythonExecutor.ts      Auto-managed venv for the python action
        workspaceActions.ts    Filesystem and shell execution (bash and grep spawn
                               asynchronously; savePlot writes a figure to disk)
        persistentCache.ts     model-cache.json
        adapters/              fetchLlmClient, nodeSseWriter, sseApprovalInteractor,
                               fsMemoryRepository,
                               fsPlanFileRepository, fsPromptRepository, systemClock,
                               autoApproveConfig
    test/                  node:test suites — see [Tests](#tests)
    docs/                  Long-form documentation (see [Documentation](#documentation))
    locales/               en_US.json — flat map, one level, strings only
    prompts/en_US/         agent-base, plan-mode, existing-plan-section, memory-section
    scripts/regression.sh  Live-backend snapshot; needs a GPU, cannot run on CI
    model-cache.json       Per-model maxTools, written after a successful probe
    .env.proxy             Proxy configuration (git-ignored)
    .env.claude            Claude Code configuration (git-ignored)
    README.md              This file
```

The dependency rule points one way and is enforced by review, not by tooling:
`domain` imports nothing outside itself, `application` depends on `domain` and
its ports, `infrastructure` depends on both and owns every adapter.

The rule is fully honoured in `domain/`. In `application/` there are three known
exceptions, all predating the hexagonal refactor: `workspaceTool.ts` reads the
filesystem through `node:fs`, `slashCommandInterceptor.ts` shells out through
`node:child_process`, and `approvalGateService.ts` resolves paths with
`node:path`. They are listed here so the gap is visible rather than discovered —
each is a candidate for a port, and each would make the corresponding test
simpler if it became one.
