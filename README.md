# Claude Code — Leaked Source (2026-03-31)

> **On March 31, 2026, the full source code of Anthropic's Claude Code CLI was leaked** via a `.map` file exposed in their npm registry.

---


## How It Leaked

[Chaofan Shou (@Fried_rice)](https://x.com/Fried_rice) discovered the leak and posted it publicly:

> **"Claude code source code has been leaked via a map file in their npm registry!"**
>
> — [@Fried_rice, March 31, 2026](https://x.com/Fried_rice/status/2038894956459290963)

The source map file in the published npm package contained a reference to the full, unobfuscated TypeScript source, which was downloadable as a zip archive from Anthropic's R2 storage bucket.

---

## Overview

Claude Code is Anthropic's official CLI tool that lets you interact with Claude directly from the terminal to perform software engineering tasks — editing files, running commands, searching codebases, managing git workflows, and more.

This repository contains the leaked source code in `claude_code/src/`.

- **Leaked on**: 2026-03-31
- **Language**: TypeScript
- **Runtime**: Bun
- **Terminal UI**: React + [Ink](https://github.com/vadimdemedes/ink) (React for CLI)
- **Scale**: ~1,900 files, 512,000+ lines of code

---

## Anthropic-to-OpenAI Proxy (v1.1.0)

This repository includes a **Node.js translation proxy** (`proxy/`) that lets Claude Code work with any local LLM through an OpenAI-compatible API. The proxy sits between Claude Code and the LLM backend, translating Anthropic Messages API requests into OpenAI Chat Completions format and back.

### Quick Start

```bash
# One-time setup
cd proxy && npm install && cd ..
```

#### Option A — Claudio (VS Code extension)

Install the extension (`chat-extension/`) and open the repo in VS Code.
The proxy starts automatically. The chat panel shows `● Connected` when ready.
No separate terminal needed.

#### Option B — Claude Code CLI

```bash
sh start_agent_cli.sh
# Finds a free port, spawns the proxy, waits for health,
# lets you pick a model interactively, then launches Claude Code.
# Proxy is killed automatically when you exit.
```

### Supported Backends

| Backend | Default URL | Model info | max_tokens auto-cap |
|---|---|---|---|
| LM Studio | `http://127.0.0.1:1234/v1/chat/completions` | ✅ full | ✅ automatic |
| ollama | `http://127.0.0.1:11434/v1/chat/completions` | ❌ | ⚠️ uses `MAX_TOKENS_FALLBACK` |
| vLLM | `http://127.0.0.1:8000/v1/chat/completions` | ❌ | ⚠️ uses `MAX_TOKENS_FALLBACK` |
| text-generation-webui | `http://127.0.0.1:5000/v1/chat/completions` | ❌ | ⚠️ uses `MAX_TOKENS_FALLBACK` |

> LM Studio exposes a proprietary `/api/v0/models` endpoint that the proxy uses to read context length, architecture, and capabilities. Other backends get full translation support but without automatic model metadata.

### Key Features

- **Full SSE streaming** — Anthropic SSE events translated from OpenAI SSE chunks in real-time
- **Dynamic tool selection** — Additive scoring algorithm selects the optimal tool subset for models with limited tool support
- **UseTool meta-tool** — Overflow tools remain accessible via an auto-generated meta-tool, with transparent rewriting
- **Auto-promotion** — Tools used via UseTool are promoted into the active set for future requests
- **Tool limit auto-detection** — Binary search probe determines the model's max tool count at startup
- **Persistent model cache** — `maxTools` per model stored in `proxy/model-cache.json`; probe is skipped on subsequent restarts with the same model
- **Split initialization** — HTTP server responds immediately (health check passes); tool probe runs in the background
- **Slash command interceptor** — `/commit`, `/diff`, `/review`, `/status`, `/version`, `/compact`, `/brief`, `/plan` are handled by the proxy before the LLM is called
- **Workspace tool + agentic loop** — Models can explore the filesystem (list/read) via up to 10 agentic rounds to gather context before responding
- **Model info** — Fetches architecture, context window, and capabilities from LM Studio's internal API
- **max_tokens capping** — Prevents runaway generation on local models (Claude Code sends 32000+)
- **Hexagonal architecture** — Clean separation into domain, application, and infrastructure layers
- **i18n** — Externalized log/error messages with `{{param}}` interpolation

### Documentation

Full proxy documentation in [`proxy/docs/`](proxy/docs/):

- [Quick Setup](proxy/docs/quick-setup.md) — minimum configuration to get up and running (includes prerequisites)
- [Architecture](proxy/docs/architecture.md) — hexagonal structure, request flow, SSE state machine, slash commands, workspace tool
- [Configuration](proxy/docs/configuration.md) — complete reference for all environment variables
- [Tool Management](proxy/docs/tool-management.md) — scoring algorithm, UseTool, promotion, probe, persistent cache
- [Startup Scripts](proxy/docs/startup-scripts.md) — start_agent_cli.sh internals
- [Proxy Lifecycle](proxy/docs/lifecycle.md) — multi-instance architecture and port discovery

---

## Claudio — VS Code Chat Extension (v0.1.0)

**Claudio** is a VS Code extension that provides a chat UI for interacting with the proxy directly from the editor — no terminal required.

```
┌──────────────────────────────────┐
│  VS Code Activity Bar            │
│  ┌──────────────────────────┐    │
│  │ Claudio Sidebar          │    │
│  │                          │    │
│  │  ● Connected             │    │
│  │                          │    │
│  │  User: explain main.ts   │    │
│  │                          │    │
│  │  AI: main.ts is the...   │    │
│  │  (streaming...)          │    │
│  │                          │    │
│  │  [Type a message...]  ▶  │    │
│  └──────────────────────────┘    │
└──────────────────────────────────┘
```

### Features

- **Streaming chat** — real-time responses with Markdown and math formulas (KaTeX)
- **Python code execution** — run code snippets in the chat with auto-managed venv
- **File attachments** — attach text files and images to the conversation
- **Slash commands** — `/files`, `/simplify`, `/copy`, `/branch`, `/commit-push-pr`, `/pr-comments`, `/clear`
- **Health monitoring** — live connection indicator, automatic reconnection
- **i18n** — English and Italian interface

### Quick Install

```bash
cd chat-extension
npm install
cd src/webview-ui && npm install && cd ../..
npm run build
npm run package
code --install-extension claudio-0.1.0.vsix
```

Reload VS Code → the Claudio icon appears in the Activity Bar.

### Configuration

In VS Code settings (Ctrl+, → search "Claudio"):

```json
{
  "claudio.proxyHost": "http://127.0.0.1",
  "claudio.proxyPort": 5678
}
```

All other settings (temperature, system prompt, model info, locale) are read automatically from the proxy's `/config` endpoint.

### Documentation

- [Claudio README](chat-extension/README.md) — full standalone guide
- [Quick Start](chat-extension/docs/quick-start.md) — beginner step-by-step guide
- [Architecture](chat-extension/docs/architecture.md) — internal structure for contributors
- [Slash Commands](chat-extension/docs/slash-commands.md) — complete command reference
- [Troubleshooting](chat-extension/docs/troubleshooting.md) — problem resolution

---

## Directory Structure

```
claude_code/src/
├── main.tsx                 # Entrypoint (Commander.js-based CLI parser)
├── commands.ts              # Command registry
├── tools.ts                 # Tool registry
├── Tool.ts                  # Tool type definitions
├── QueryEngine.ts           # LLM query engine (core Anthropic API caller)
├── context.ts               # System/user context collection
├── cost-tracker.ts          # Token cost tracking
│
├── commands/                # Slash command implementations (~50)
├── tools/                   # Agent tool implementations (~40)
├── components/              # Ink UI components (~140)
├── hooks/                   # React hooks
├── services/                # External service integrations
├── screens/                 # Full-screen UIs (Doctor, REPL, Resume)
├── types/                   # TypeScript type definitions
├── utils/                   # Utility functions
│
├── bridge/                  # IDE integration bridge (VS Code, JetBrains)
├── coordinator/             # Multi-agent coordinator
├── plugins/                 # Plugin system
├── skills/                  # Skill system
├── keybindings/             # Keybinding configuration
├── vim/                     # Vim mode
├── voice/                   # Voice input
├── remote/                  # Remote sessions
├── server/                  # Server mode
├── memdir/                  # Memory directory (persistent memory)
├── tasks/                   # Task management
├── state/                   # State management
├── migrations/              # Config migrations
├── schemas/                 # Config schemas (Zod)
├── entrypoints/             # Initialization logic
├── ink/                     # Ink renderer wrapper
├── buddy/                   # Companion sprite (Easter egg)
├── native-ts/               # Native TypeScript utils
├── outputStyles/            # Output styling
├── query/                   # Query pipeline
└── upstreamproxy/           # Proxy configuration
```

---

## Core Architecture

### 1. Tool System (`claude_code/src/tools/`)

Every tool Claude Code can invoke is implemented as a self-contained module. Each tool defines its input schema, permission model, and execution logic.

| Tool | Description |
|---|---|
| `BashTool` | Shell command execution |
| `FileReadTool` | File reading (images, PDFs, notebooks) |
| `FileWriteTool` | File creation / overwrite |
| `FileEditTool` | Partial file modification (string replacement) |
| `GlobTool` | File pattern matching search |
| `GrepTool` | ripgrep-based content search |
| `WebFetchTool` | Fetch URL content |
| `WebSearchTool` | Web search |
| `AgentTool` | Sub-agent spawning |
| `SkillTool` | Skill execution |
| `MCPTool` | MCP server tool invocation |
| `LSPTool` | Language Server Protocol integration |
| `NotebookEditTool` | Jupyter notebook editing |
| `TaskCreateTool` / `TaskUpdateTool` | Task creation and management |
| `SendMessageTool` | Inter-agent messaging |
| `TeamCreateTool` / `TeamDeleteTool` | Team agent management |
| `EnterPlanModeTool` / `ExitPlanModeTool` | Plan mode toggle |
| `EnterWorktreeTool` / `ExitWorktreeTool` | Git worktree isolation |
| `ToolSearchTool` | Deferred tool discovery |
| `CronCreateTool` | Scheduled trigger creation |
| `RemoteTriggerTool` | Remote trigger |
| `SleepTool` | Proactive mode wait |
| `SyntheticOutputTool` | Structured output generation |

### 2. Command System (`claude_code/src/commands/`)

User-facing slash commands invoked with `/` prefix.

| Command | Description |
|---|---|
| `/commit` | Create a git commit |
| `/review` | Code review |
| `/compact` | Context compression |
| `/mcp` | MCP server management |
| `/config` | Settings management |
| `/doctor` | Environment diagnostics |
| `/login` / `/logout` | Authentication |
| `/memory` | Persistent memory management |
| `/skills` | Skill management |
| `/tasks` | Task management |
| `/vim` | Vim mode toggle |
| `/diff` | View changes |
| `/cost` | Check usage cost |
| `/theme` | Change theme |
| `/context` | Context visualization |
| `/pr_comments` | View PR comments |
| `/resume` | Restore previous session |
| `/share` | Share session |
| `/desktop` | Desktop app handoff |
| `/mobile` | Mobile app handoff |

### 3. Service Layer (`claude_code/src/services/`)

| Service | Description |
|---|---|
| `api/` | Anthropic API client, file API, bootstrap |
| `mcp/` | Model Context Protocol server connection and management |
| `oauth/` | OAuth 2.0 authentication flow |
| `lsp/` | Language Server Protocol manager |
| `analytics/` | GrowthBook-based feature flags and analytics |
| `plugins/` | Plugin loader |
| `compact/` | Conversation context compression |
| `policyLimits/` | Organization policy limits |
| `remoteManagedSettings/` | Remote managed settings |
| `extractMemories/` | Automatic memory extraction |
| `tokenEstimation.ts` | Token count estimation |
| `teamMemorySync/` | Team memory synchronization |

### 4. Bridge System (`claude_code/src/bridge/`)

A bidirectional communication layer connecting IDE extensions (VS Code, JetBrains) with the Claude Code CLI.

- `bridgeMain.ts` — Bridge main loop
- `bridgeMessaging.ts` — Message protocol
- `bridgePermissionCallbacks.ts` — Permission callbacks
- `replBridge.ts` — REPL session bridge
- `jwtUtils.ts` — JWT-based authentication
- `sessionRunner.ts` — Session execution management

### 5. Permission System (`claude_code/src/hooks/toolPermission/`)

Checks permissions on every tool invocation. Either prompts the user for approval/denial or automatically resolves based on the configured permission mode (`default`, `plan`, `bypassPermissions`, `auto`, etc.).

### 6. Feature Flags

Dead code elimination via Bun's `bun:bundle` feature flags:

```typescript
import { feature } from 'bun:bundle'

// Inactive code is completely stripped at build time
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

Notable flags: `PROACTIVE`, `KAIROS`, `BRIDGE_MODE`, `DAEMON`, `VOICE_MODE`, `AGENT_TRIGGERS`, `MONITOR_TOOL`

---

## Key Files in Detail

### `claude_code/src/QueryEngine.ts` (~46K lines)

The core engine for LLM API calls. Handles streaming responses, tool-call loops, thinking mode, retry logic, and token counting.

### `claude_code/src/Tool.ts` (~29K lines)

Defines base types and interfaces for all tools — input schemas, permission models, and progress state types.

### `claude_code/src/commands.ts` (~25K lines)

Manages registration and execution of all slash commands. Uses conditional imports to load different command sets per environment.

### `claude_code/src/main.tsx`

Commander.js-based CLI parser + React/Ink renderer initialization. At startup, parallelizes MDM settings, keychain prefetch, and GrowthBook initialization for faster boot.

---

## Tech Stack

| Category | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript (strict) |
| Terminal UI | [React](https://react.dev) + [Ink](https://github.com/vadimdemedes/ink) |
| CLI Parsing | [Commander.js](https://github.com/tj/commander.js) (extra-typings) |
| Schema Validation | [Zod v4](https://zod.dev) |
| Code Search | [ripgrep](https://github.com/BurntSushi/ripgrep) (via GrepTool) |
| Protocols | [MCP SDK](https://modelcontextprotocol.io), LSP |
| API | [Anthropic SDK](https://docs.anthropic.com) |
| Telemetry | OpenTelemetry + gRPC |
| Feature Flags | GrowthBook |
| Auth | OAuth 2.0, JWT, macOS Keychain |

---

## Notable Design Patterns

### Parallel Prefetch

Startup time is optimized by prefetching MDM settings, keychain reads, and API preconnect in parallel — before heavy module evaluation begins.

```typescript
// main.tsx — fired as side-effects before other imports
startMdmRawRead()
startKeychainPrefetch()
```

### Lazy Loading

Heavy modules (OpenTelemetry ~400KB, gRPC ~700KB) are deferred via dynamic `import()` until actually needed.

### Agent Swarms

Sub-agents are spawned via `AgentTool`, with `coordinator/` handling multi-agent orchestration. `TeamCreateTool` enables team-level parallel work.

### Skill System

Reusable workflows defined in `skills/` and executed through `SkillTool`. Users can add custom skills.

### Plugin Architecture

Built-in and third-party plugins are loaded through the `plugins/` subsystem.

---

## Disclaimer

This repository archives source code that was leaked from Anthropic's npm registry on **2026-03-31**. All original source code is the property of [Anthropic](https://www.anthropic.com).
