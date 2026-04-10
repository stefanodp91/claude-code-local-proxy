# Proxy Changelog

All notable changes to the Anthropic-to-OpenAI proxy are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.0] — 2026-04-10

### Added — Proxy lifecycle management

- **`start_agent_cli.sh`**: new unified CLI script replacing `start.sh` + `start_claude_code.sh`.
  Performs port discovery (`find_free_port`), spawns the proxy, waits for `/health`, presents an
  interactive model selector if `ANTHROPIC_MODEL` is unset, launches Claude Code, and kills the
  proxy automatically on exit via `trap`.

- **Port discovery** (`find_free_port` in bash): each CLI session finds the first available port
  starting from `PROXY_PORT` (default 5678) using `lsof`. Multiple parallel agents run on
  independent ports without conflicts.

### Removed

- **`start.sh`**: functionality absorbed by `start_agent_cli.sh`.
- **`start_claude_code.sh`**: functionality absorbed by `start_agent_cli.sh`.

### Added — Previously unreleased

- **Slash command interceptor** (`src/application/slashCommandInterceptor.ts`): intercepts slash
  commands from incoming requests before the LLM is called. Three result types:
  - `synthetic` — immediate SSE response without any LLM call (e.g. `/status`, `/version`)
  - `enrich` — replaces the last message with enriched content, then proceeds to LLM (e.g. `/commit`, `/diff`, `/review`)
  - `passthrough` — not a handled command, normal flow continues
  - Proxy-handled: `/status`, `/version`, `/commit`, `/diff`, `/review`, `/compact`, `/brief`, `/plan`
  - Client-handled (registry only): `/copy`, `/files`, `/simplify`, `/branch`, `/commit-push-pr`, `/pr-comments`, `/clear`
  - Blocked Anthropic-specific commands return a synthetic explanatory message

- **Workspace tool** (`src/application/workspaceTool.ts`): OpenAI-format tool for filesystem
  exploration inside the workspace root:
  - `action: "list"` — lists directory contents
  - `action: "read"` — reads file content (max 50KB)
  - `safeResolve()` — prevents path traversal outside the workspace root
  - Static summary fallback: when models don't support tools, injects workspace context as system prompt

- **Agentic workspace exploration loop** (`src/infrastructure/server.ts`): when the client sends
  `X-Workspace-Root` and `maxTools > 0`, runs up to 10 non-streaming rounds with only the
  `workspace` tool. Final result is streamed as a single Anthropic SSE response.

- **Persistent model cache** (`src/infrastructure/persistentCache.ts`): JSON file-backed cache
  storing `{ "<modelId>": { "maxTools": N } }` in `proxy/model-cache.json`. Skips the binary
  search probe on subsequent starts with the same model.

- **Split initialization** (`src/main.ts` + `src/infrastructure/server.ts`):
  - `proxy.initialize()` — fast path (~100–300ms): locale + model info
  - `proxy.start()` — HTTP server starts; health check passes here
  - `proxy.initializeTools()` — background (3–30s): cache check or probe + wires translators.
    Requests before completion receive `503 Proxy is still initializing`.

- **`PROBE_TIMEOUT` config variable**: timeout per probe fetch request (default: 30,000ms).

- **Chat defaults** exposed via `GET /config`:
  - `TEMPERATURE` — LLM temperature (default: 0.7)
  - `SYSTEM_PROMPT` — prepended system prompt (default: empty)
  - `ENABLE_THINKING` — send `thinking:{type:"enabled"}` (default: 1)

- **`GET /config` endpoint**: returns proxy runtime config including model info, temperature,
  system prompt, locale, maxTokensFallback. Used by Claudio to auto-configure.

- **`GET /commands` endpoint**: returns the full slash command registry. Used by Claudio for
  command autocomplete.

---

## [1.0.0] — 2026-03-31

### Added

- Initial Anthropic-to-OpenAI translation proxy
- Full SSE streaming: Anthropic SSE events translated from OpenAI SSE chunks via `StreamStateMachine`
- Dynamic tool selection with additive scoring algorithm (core tools, promoted, history, forced choice)
- `UseTool` meta-tool: overflow tools in a single meta-tool, transparently rewritten to the real tool name
- Auto-promotion with decay: tools invoked via UseTool are promoted for `PROMOTION_MAX_AGE` requests
- Binary search tool probe (`ToolProbe.detect()`): auto-detects model's maximum tool count at startup
- Model info fetch from LM Studio's `/api/v0/models`: architecture, quantization, context length, capabilities
- `max_tokens` capping: caps Claude Code's `max_tokens=32000+` to `loadedContextLength / CONTEXT_TO_MAX_TOKENS_RATIO`
- Hexagonal architecture: domain (pure types + i18n), application (translators + tool manager), infrastructure (server + config + logger)
- i18n: locale files in `proxy/locales/`, `t()` function with `{{param}}` interpolation
- Thinking block translation: `reasoning_content` → Anthropic `thinking` content blocks
- Stop reason mapping: `finish_reason` → `stop_reason` (end_turn, tool_use, max_tokens)
