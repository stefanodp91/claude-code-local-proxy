# Proxy Configuration Reference

> Complete reference for all environment variables in `.env.proxy` and `.env.claude`.

All configuration is read once at startup by `loadConfig()` in `infrastructure/config.ts`. No module reads `process.env` directly — everything flows through the `ProxyConfig` interface via constructor injection.

---

## Proxy Configuration (`.env.proxy`)

### Server

| Variable | Type | Default | Description |
|---|---|---|---|
| `PROXY_PORT` | int | `5678` | Port the proxy HTTP server listens on. Chosen to avoid conflicts with LM Studio (1234), dev servers (8080), ollama (11434). |
| `TARGET_URL` | string | `http://127.0.0.1:1234/v1/chat/completions` | Full URL of the OpenAI-compatible chat completions endpoint. |
| `DEBUG` | `0`/`1` | `0` | Verbose logging. When `1`, logs every SSE event translation (both directions). |

**Supported backends:**

| Backend | Default URL |
|---|---|
| LM Studio | `http://127.0.0.1:1234/v1/chat/completions` |
| ollama | `http://127.0.0.1:11434/v1/chat/completions` |
| vLLM | `http://127.0.0.1:8000/v1/chat/completions` |
| text-generation-webui | `http://127.0.0.1:5000/v1/chat/completions` |

### Tool Management

| Variable | Type | Default | Description |
|---|---|---|---|
| `MAX_TOOLS` | int / unset | Auto-detect | Maximum tools sent per request. **Unset** = auto-detect via binary search probe. **0** = disable filtering (all tools pass through). **N** = hard limit. |
| `CORE_TOOLS` | comma-list | `Bash,Read,Edit,Write,Glob,Grep` | Tools always prioritized during dynamic selection. These receive the highest base score. |

**MAX_TOOLS behavior:**

```
MAX_TOOLS unset  →  ToolProbe runs binary search at startup
                    Detects maximum N the model handles
                    Example: Nemotron = 7, Qwen 3.5 = 15

MAX_TOOLS=0      →  No filtering. All tools pass through as-is.
                    Use when the model supports unlimited tools.

MAX_TOOLS=7      →  Hard limit. Skip probe. Send max 7 tools per request.
                    Top 6 by score + UseTool meta-tool.
```

### Tool Scoring Weights

Scores are **additive** — a tool can receive multiple bonuses that stack.

| Variable | Type | Default | Description |
|---|---|---|---|
| `SCORE_CORE_TOOLS` | int | `10` | Bonus for tools listed in `CORE_TOOLS`. |
| `SCORE_PROMOTED` | int | `8` | Bonus for tools recently used via UseTool (auto-promoted). |
| `SCORE_USED_IN_HISTORY` | int | `5` | Bonus for tools that appear in conversation history (`tool_use` blocks). |
| `SCORE_FORCED_CHOICE` | int | `20` | Bonus when `tool_choice` forces a specific tool. Highest priority. |

**Example score calculation:**

```
Tool: "Bash"
  + 10  (in CORE_TOOLS)
  +  5  (used in history)
  ─────
  = 15

Tool: "Agent"
  +  8  (promoted via UseTool last request)
  +  5  (used in history)
  ─────
  = 13

Tool: "WebSearch"
  +  0  (not core, not promoted, not in history)
  ─────
  =  0  → goes to overflow (accessible via UseTool)
```

### Tool Probe

Auto-detection of the model's tool calling limit. Runs once at startup unless `MAX_TOOLS` is set. The result is cached in `proxy/model-cache.json` — on subsequent restarts with the same model, the probe is skipped entirely.

| Variable | Type | Default | Description |
|---|---|---|---|
| `PROBE_UPPER_BOUND` | int | `32` | Maximum number of tools to test during binary search. |
| `PROBE_MAX_TOKENS` | int | `100` | `max_tokens` for each probe request. Keep low for speed. |
| `PROBE_TIMEOUT` | int | `30000` | Timeout in milliseconds for each individual probe fetch request. If a probe request hangs (e.g. the model is slow to start), it is aborted after this delay. |

**How the probe works:**

```
Binary search: lo=1, hi=32

  Test 16 tools → ❌ (model puts JSON in content text)
  Test  8 tools → ❌
  Test  4 tools → ✅ (model returns structured tool_calls)
  Test  6 tools → ✅
  Test  7 tools → ✅
  Test  8 tools → ❌ (already known)

  Result: max tools = 7
```

Each probe sends a non-streaming request with N dummy tools and `tool_choice: "required"`. A test passes if the response contains a `tool_calls` array (structured calling); it fails if the model puts the tool call JSON into the `content` text (unstructured fallback).

### Tool Promotion

| Variable | Type | Default | Description |
|---|---|---|---|
| `PROMOTION_MAX_AGE` | int | `10` | Number of requests without use before a promoted tool decays from the active set. Higher = promoted tools stay longer. |

### UseTool Meta-Tool

| Variable | Type | Default | Description |
|---|---|---|---|
| `USE_TOOL_DESC_MAX_LENGTH` | int | `80` | Max characters for each tool's description in the UseTool listing. Longer = more context for the model, but more tokens consumed. |

### Model Limits

| Variable | Type | Default | Description |
|---|---|---|---|
| `MAX_TOKENS_FALLBACK` | int | `4096` | Default `max_tokens` cap when model info is unavailable (e.g., non-LM Studio backends). Set to `0` to disable capping. |
| `CONTEXT_TO_MAX_TOKENS_RATIO` | int | `4` | `maxTokensCap = loadedContextLength / ratio`. A ratio of 4 means max output = 25% of loaded context. |

**Why max_tokens capping is needed:**

Claude Code sends `max_tokens=32000+` in every request. On local models with limited context windows, this causes:
1. The model attempts to fill the entire budget, leading to infinite repetition loops
2. Generation takes unreasonably long
3. Context overflow errors

The proxy caps it automatically:

```
Example: Qwen 3.5 loaded with 32768 context, ratio=4

  maxTokensCap = 32768 / 4 = 8192
  Claude sends max_tokens=32000
  Proxy sends max_tokens=8192 (capped)
```

### Internationalization

| Variable | Type | Default | Description |
|---|---|---|---|
| `LOCALE` | string | `en_US` | Locale for log messages and error strings. Only `en_US` is currently supported. |

### Chat Defaults

These variables configure defaults for chat clients (like Claudio). They are exposed via the `GET /config` endpoint and can be overridden per-message by the client.

| Variable | Type | Default | Description |
|---|---|---|---|
| `TEMPERATURE` | float | `0.7` | Default LLM temperature for chat requests. Lower = more deterministic; higher = more creative. |
| `SYSTEM_PROMPT` | string | (empty) | Optional system prompt prepended to every conversation. Useful for setting a persistent persona or context. |
| `ENABLE_THINKING` | `0`/`1` | `1` | When `1`, the proxy sends `thinking:{type:"enabled"}` to the model in every request, enabling extended reasoning/thinking mode. Set to `0` to disable. |

Locale files live in `proxy/locales/<locale>.json`. The `t()` function does `{{param}}` interpolation:

```json
{
  "probe.detected": "Max tools detected: {{max}}",
  "request.incoming": "→ {{model}} | {{msgs}} msgs | {{tools}} tools"
}
```

---

## Claude Code Configuration (`.env.claude`)

These variables are exported to Claude Code's environment by `start_agent_cli.sh`.

### Connection

| Variable | Type | Default | Description |
|---|---|---|---|
| `ANTHROPIC_MODEL` | string | (empty) | Model ID as shown by the LLM server. Leave empty for interactive selection at startup. |
| `ANTHROPIC_BASE_URL` | string | `http://127.0.0.1:${PROXY_PORT}` | Base URL for the Anthropic SDK. Points to the proxy. `${PROXY_PORT}` is resolved at startup. |
| `ANTHROPIC_API_KEY` | string | `local-proxy` | API key sent to the proxy. Any non-empty string works — the proxy ignores it, but the Anthropic SDK requires one. |

### Compatibility

| Variable | Type | Default | Description |
|---|---|---|---|
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `0`/`1` | `1` | Strip experimental beta fields (`defer_loading`, `eager_input_streaming`, `strict`) from tool schemas. Without this, LM Studio rejects requests with "Extra inputs are not permitted". |

### Sandbox Mode

| Variable | Type | Default | Description |
|---|---|---|---|
| `CLAUDE_CODE_SIMPLE` | `0`/`1` | `1` | Bare mode: skip OAuth, keychain, telemetry, background prefetches. Auth is strictly `ANTHROPIC_API_KEY`. |
| `DISABLE_AUTOUPDATER` | `0`/`1` | `1` | Prevent Claude Code from checking for updates. |
| `DISABLE_TELEMETRY` | `0`/`1` | `1` | Prevent Claude Code from sending usage telemetry to Anthropic. |

---

## Configuration Loading Order

```
                    ┌──────────────────────┐
                    │    Shell Environment  │  (highest priority)
                    └──────────┬───────────┘
                               │ overrides
                    ┌──────────v───────────┐
                    │    .env.claude        │
                    └──────────┬───────────┘
                               │ overrides
                    ┌──────────v───────────┐
                    │    .env.proxy         │  (lowest priority)
                    └──────────────────────┘
```

Variables set in the shell environment take precedence over file values. This allows per-session overrides:

```bash
# Override model for this session only
ANTHROPIC_MODEL=llama-3.1-8b sh start_agent_cli.sh
```

---

## Related Docs

- [Architecture](architecture.md) — internal structure and request flow
- [Tool Management](tool-management.md) — scoring, selection, UseTool deep dive
- [Startup Scripts](startup-scripts.md) — start_agent_cli.sh internals
