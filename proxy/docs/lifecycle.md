# Proxy Lifecycle Management

> How the proxy process is started, monitored, and stopped automatically by each consumer.

---

## Overview

Previously the proxy had to be started manually in a dedicated terminal (`cd proxy && npm start`).
Starting from v1.1.0 the proxy lifecycle is **bound to its consumer**:

| Consumer | Proxy starts when | Proxy stops when |
|---|---|---|
| **Claudio** (VS Code extension) | VS Code window opens | VS Code window closes / extension deactivates |
| **Claude Code CLI** | `sh start_agent_cli.sh` runs | Claude Code exits (Ctrl+C or `/exit`) |

Neither workflow requires a separate terminal or manual `npm start`.

---

## Multi-Instance Architecture

Each consumer spawns its **own** proxy process on its **own** dynamically-discovered free port.
Processes are completely independent — they share nothing except `model-cache.json`
(last-write-wins race condition, not critical).

This allows multiple agents to run in parallel without port conflicts.

```
+──────────────────+  +──────────────────+  +──────────────────+
│  VS Code (win 1) │  │  VS Code (win 2) │  │ start_agent_cli  │
│                  │  │                  │  │                  │
│  ProxyManager    │  │  ProxyManager    │  │  find_free_port  │
│  port: 5678      │  │  port: 5679      │  │  port: 5680      │
│  PID:  12345     │  │  PID:  12346     │  │  PID:  12347     │
│       ↕          │  │       ↕          │  │       ↕          │
│  Claudio chat    │  │  Claudio chat    │  │  claude CLI      │
+────────┬─────────+  +────────┬─────────+  +────────┬─────────+
         │                    │                      │
         +────────────────────+──────────────────────+
                              │
                    +─────────▼─────────+
                    │   LLM Backend     │
                    │  (LM Studio :1234)│
                    +───────────────────+
```

---

## Port Discovery

At startup each consumer finds the first available TCP port starting from `claudio.proxyPort`
(default 5678).

**TypeScript — ProxyManager (`net.createServer` probe):**

```
findFreePort(5678)
  ├── try to bind :5678 → EADDRINUSE → try 5679
  ├── try to bind :5679 → EADDRINUSE → try 5680
  └── try to bind :5680 → success → resolve(5680)
```

**Bash — start_agent_cli.sh (`lsof` probe):**

```
find_free_port 5678
  ├── lsof -i :5678 → occupied → port=5679
  ├── lsof -i :5679 → occupied → port=5680
  └── lsof -i :5680 → free → echo 5680
```

| Implementation | Method | Where used |
|---|---|---|
| TypeScript | `net.createServer()` — attempts to bind, releases immediately | `ProxyManager.findFreePort()` |
| Bash | `lsof -i :<port>` — checks if port is in use | `start_agent_cli.sh` `find_free_port()` |

---

## Claudio Workflow

```
VS Code opens the project folder
  │
  └── activate() — activation.ts
        │
        ├── loadVsCodeSettings()
        │     claudio.proxyDir = "/path/to/repo/proxy"
        │     claudio.autoStartProxy = true
        │     claudio.proxyPort = 5678 (base)
        │
        ├── ProxyManager.start(basePort=5678)
        │     │
        │     ├── cleanupOrphan()
        │     │     └── read .claudio-proxy.pid → SIGTERM old process (if any)
        │     │
        │     ├── findFreePort(5678) → 5679 (example)
        │     │
        │     ├── parseEnvFile(proxy/.env.proxy)
        │     │
        │     ├── spawn: npx --prefix proxy tsx proxy/src/main.ts
        │     │         env: { PROXY_PORT: "5679", ... }
        │     │
        │     ├── write PID to globalStoragePath/.claudio-proxy.pid
        │     │
        │     └── waitForHealth(5679, 30s)
        │           └── polls http://127.0.0.1:5679/health every 1s
        │
        ├── setProxyPortOverride(5679)
        │     └── loadVsCodeSettings() now returns port=5679 for this session
        │
        └── ChatSession — connects to http://127.0.0.1:5679
              HealthChecker polls /health every 10s → ● Connected

VS Code window closes / extension deactivated
  │
  └── context.subscriptions.dispose()
        └── ProxyManager.dispose() → stop()
              ├── SIGTERM to proxy process
              ├── wait 5s → SIGKILL if still alive
              └── delete .claudio-proxy.pid
```

**VS Code settings that control this behavior:**

| Setting | Type | Default | Description |
|---|---|---|---|
| `claudio.proxyDir` | string | `""` | Absolute path to `proxy/`. Supports `${workspaceFolder}`. Empty = use external proxy. |
| `claudio.autoStartProxy` | boolean | `true` | Enable/disable automatic proxy lifecycle management. |
| `claudio.proxyPort` | number | `5678` | Base port for discovery. Actual port may be higher. |
| `claudio.proxyHost` | string | `http://127.0.0.1` | Proxy host (unchanged by ProxyManager). |

---

## CLI Workflow

```
sh start_agent_cli.sh
  │
  ├── register trap cleanup (EXIT INT TERM)
  │     └── on exit: kill $PROXY_PID, wait, "Proxy stopped."
  │
  ├── load_env proxy/.env.proxy    (graceful: skip if missing)
  ├── load_env proxy/.env.claude   (graceful: skip if missing)
  │
  ├── find_free_port 5678 → PROXY_PORT=5680 (example)
  │
  ├── prerequisite checks
  │     ├── node installed?            → die if missing
  │     └── LLM server /v1/models?    → die if unreachable
  │
  ├── spawn proxy
  │     PROXY_PORT=5680 npx --prefix proxy tsx proxy/src/main.ts > proxy.log &
  │     PROXY_PID=$!
  │
  ├── health check loop (30 retries × 1s)
  │     ├── curl http://127.0.0.1:5680/health → OK → break
  │     ├── process alive? → die if crashed
  │     └── 30th retry → warn (non-fatal, tool probe may still be running)
  │
  ├── ANTHROPIC_BASE_URL=http://127.0.0.1:5680
  │
  ├── model selection (if ANTHROPIC_MODEL empty)
  │     └── query TARGET_BASE/v1/models → numbered menu → user picks
  │
  ├── verify `claude` in PATH → die if missing
  │
  ├── claude "$@"    ← NOT exec (trap must stay active)
  │
  └── (claude exits or user presses Ctrl+C)
        └── trap fires → kill proxy → "Proxy stopped."
```

---

## ProxyManager Class Reference

File: [chat-extension/src/extension/proxy/proxy-manager.ts](../../chat-extension/src/extension/proxy/proxy-manager.ts)

| Member | Signature | Description |
|---|---|---|
| `actualPort` | `number` | Port the proxy is listening on. Set after `start()` resolves. |
| `isRunning` | `boolean` (getter) | True if the child process is alive. |
| `start(basePort)` | `async (number) → void` | Finds a free port, spawns proxy, waits for health. |
| `stop()` | `void` | SIGTERM → SIGKILL after 5s. Only acts if `isOwner`. |
| `dispose()` | `void` | Calls `stop()`. VS Code calls this on deactivation. |
| `findFreePort(start)` | `private async` | `net.createServer()` probe loop. |
| `cleanupOrphan()` | `private async` | Reads PID file, kills leftover process from previous crash. |
| `parseEnvFile(path)` | `private` | KEY=VALUE parser; returns `{}` if file is absent. |
| `waitForHealth(port, ms)` | `private async` | Polls `/health` every 1s up to `ms` milliseconds. |

---

## Edge Cases

| Case | Scenario | Behavior | Implementation |
|---|---|---|---|
| CL1 | Multiple VS Code windows open | Each spawns its own proxy on its own port | `findFreePort()` always finds a genuinely free port |
| CL2 | VS Code crashes (kill -9) | Orphan proxy cleaned up on next launch | PID written to `.claudio-proxy.pid`; `cleanupOrphan()` runs on `activate()` |
| CL3 | Proxy crashes mid-session | No auto-restart; HealthChecker turns indicator red | `process.on('exit')` logs to OutputChannel; user reloads VS Code |
| CL4 | `npm install` not run in `proxy/` | VS Code error message shown with actionable fix | Stderr watch for `MODULE_NOT_FOUND` / `tsx: not found` |
| CL5 | Node.js not installed | VS Code error notification | `spawn` `ENOENT` handler → `showErrorMessage` |
| CL6 | `waitForHealth` times out (slow model load) | Non-fatal; session continues | `stop()` not called; HealthChecker resumes polling |
| CL7 | `.env.proxy` missing | Proxy uses built-in defaults | `parseEnvFile()` returns `{}` gracefully |
| CL8 | LLM server not running when proxy starts | Proxy starts normally; uses `MAX_TOKENS_FALLBACK` | No special handling; user can start LM Studio any time |
| CL9 | CLI session while Claudio is already running | CLI spawns on a different port (e.g. 5679) | `find_free_port` skips all occupied ports |

---

## Environment Variable Flow

| Variable | Source | Set by | Used by |
|---|---|---|---|
| `PROXY_PORT` | `.env.proxy` / port discovery | ProxyManager / `find_free_port` | Proxy HTTP server bind |
| `TARGET_URL` | `.env.proxy` | load_env / ProxyManager env | Proxy → LLM forwarding |
| `ANTHROPIC_BASE_URL` | Derived from `PROXY_PORT` | `activation.ts` / `start_agent_cli.sh` | Claude Code CLI (API base URL) |
| `ANTHROPIC_MODEL` | `.env.claude` / interactive menu | `start_agent_cli.sh` | Claude Code CLI |
| `ANTHROPIC_API_KEY` | `.env.claude` | `start_agent_cli.sh` | Claude Code CLI (auth, ignored by proxy) |
| `CLAUDE_CODE_SIMPLE` | `.env.claude` or hardcoded | `start_agent_cli.sh` | Claude Code (bare mode) |

---

## Related Docs

- [Startup Scripts](startup-scripts.md) — `start_agent_cli.sh` detailed reference
- [Architecture](architecture.md) — internal proxy structure
- [Quick Setup](quick-setup.md) — getting started from scratch
- [Claudio Architecture](../../chat-extension/docs/architecture.md) — VS Code extension internals
