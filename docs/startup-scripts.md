# Startup Scripts

> How `start.sh` and `start_claude_code.sh` orchestrate the proxy and Claude Code.

## Overview

Two scripts manage the full lifecycle from proxy startup to Claude Code session teardown.

```
                          ┌───────────────────────┐
                          │       start.sh         │
                          │                        │
                          │  1. Load .env.proxy    │
                          │  2. Check prerequisites│
                          │  3. Start proxy (bg)   │
                          │  4. Health check       │
                          │  5. Call launcher ──────┼──────┐
                          │  6. Cleanup on exit    │      │
                          └───────────────────────┘      │
                                                         v
                                              ┌───────────────────────┐
                                              │ start_claude_code.sh   │
                                              │                        │
                                              │  1. Load .env.proxy    │
                                              │  2. Load .env.claude   │
                                              │  3. Resolve vars       │
                                              │  4. Model selection    │
                                              │  5. Verify claude      │
                                              │  6. exec claude        │
                                              └───────────────────────┘
```

**Key distinction:**
- `start.sh` is the **orchestrator** — starts the proxy, manages its lifecycle, delegates to the launcher
- `start_claude_code.sh` is the **launcher** — configures env vars and exec's into Claude Code. Can run standalone if the proxy is already running.

---

## start.sh — Full Stack Orchestrator

### Flow

```
start.sh
  │
  ├── Set strict mode (set -euo pipefail)
  ├── Register cleanup trap (EXIT, INT, TERM)
  │
  ├── Load .env.proxy
  │     ├── PROXY_PORT=5678
  │     ├── TARGET_URL=http://127.0.0.1:1234/v1/chat/completions
  │     └── DEBUG=0
  │
  ├── Check prerequisites
  │     ├── bun installed?           → die if missing
  │     ├── LLM server reachable?    → curl /v1/models → die if down
  │     └── Port available?          → lsof check → die if taken
  │
  ├── Start proxy in background
  │     ├── bun run proxy/src/main.ts > proxy/proxy.log 2>&1 &
  │     └── Capture PID: PROXY_PID=$!
  │
  ├── Health check loop
  │     ├── Poll http://127.0.0.1:5678/health
  │     ├── Max 10 retries × 0.5s = 5s timeout
  │     ├── Check process still alive between retries
  │     └── Die if timeout or process crashed
  │
  ├── Launch Claude Code
  │     └── start_claude_code.sh "$@"   ← NOT exec (preserves trap)
  │
  └── (Claude Code exits)
        └── Cleanup trap fires
              ├── kill $PROXY_PID
              ├── wait $PROXY_PID
              └── "Proxy stopped."
```

### Critical Design: No `exec` in start.sh

```
start.sh                         start_claude_code.sh
┌──────────────────────┐         ┌──────────────────────┐
│  trap cleanup EXIT   │         │                      │
│                      │ calls   │                      │
│  start_claude_code ──┼────────>│  exec claude         │
│                      │         │  (replaces this      │
│  (waits for return)  │         │   shell process)     │
│                      │         └──────────────────────┘
│  cleanup() runs ◄────┤
│  kills proxy         │
└──────────────────────┘
```

If `start.sh` used `exec` to call the launcher, it would replace itself and the cleanup trap would be lost — the proxy would become an orphan process when the user presses Ctrl+C.

---

## start_claude_code.sh — Claude Code Launcher

### Flow

```
start_claude_code.sh
  │
  ├── Set strict mode (set -euo pipefail)
  │
  ├── load_env("proxy/.env.proxy")
  │     └── PROXY_PORT, TARGET_URL, DEBUG
  │
  ├── load_env("proxy/.env.claude")
  │     └── ANTHROPIC_MODEL, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY,
  │         CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, sandbox flags
  │
  ├── Resolve ${PROXY_PORT} in ANTHROPIC_BASE_URL
  │     "http://127.0.0.1:${PROXY_PORT}" → "http://127.0.0.1:5678"
  │
  ├── Model selection (if ANTHROPIC_MODEL is empty)
  │     ├── Query http://127.0.0.1:1234/v1/models
  │     ├── Parse JSON with Python (filter embedding models)
  │     ├── Display numbered menu:
  │     │     Available models:
  │     │       1) qwen/qwen3.5-35b-a3b
  │     │       2) nemotron-cascade-2-30b-a3b@6bit
  │     │     Select a model [1-2]: _
  │     └── User selects → ANTHROPIC_MODEL set
  │
  ├── Verify `claude` command is in PATH
  │     └── die if missing (with install instructions)
  │
  ├── Check proxy health (non-fatal warning)
  │     └── curl /health → yellow warning if unreachable
  │
  ├── Set sandbox environment
  │     ├── CLAUDE_CODE_SIMPLE=1
  │     ├── DISABLE_AUTOUPDATER=1
  │     └── DISABLE_TELEMETRY=1
  │
  ├── Print launch info
  │     Launching Claude Code
  │       Model:    qwen/qwen3.5-35b-a3b
  │       Proxy:    http://127.0.0.1:5678
  │       Target:   http://127.0.0.1:1234/v1/chat/completions
  │
  └── exec claude "$@"
        └── Replaces shell with claude process
            (safe: no cleanup needed in this script)
```

### The `load_env()` Function

```bash
load_env(file):
  for each line in file:
    skip comments (# ...) and blank lines
    parse KEY=VALUE
    trim whitespace from key and value
    if KEY is NOT already set in environment:
      export KEY=VALUE
```

**Key behavior:** environment variables override file values. This allows:

```bash
# Per-session override (shell env wins over .env.claude)
ANTHROPIC_MODEL=llama-3.1-8b sh start_claude_code.sh
```

### Load Order Matters

`.env.proxy` is loaded **before** `.env.claude` because `.env.claude` references `${PROXY_PORT}` which comes from `.env.proxy`:

```
Step 1: load .env.proxy  →  PROXY_PORT=5678 now in env
Step 2: load .env.claude  →  ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}
Step 3: resolve           →  ANTHROPIC_BASE_URL=http://127.0.0.1:5678
```

---

## Environment Variable Flow

| Variable | Source | Set By | Used By |
|---|---|---|---|
| `PROXY_PORT` | `.env.proxy` | start.sh / load_env | start.sh (health URL), start_claude_code.sh (resolve) |
| `TARGET_URL` | `.env.proxy` | start.sh / load_env | start.sh (prereq check), proxy (forward requests) |
| `DEBUG` | `.env.proxy` | start.sh / load_env | proxy (verbose logging) |
| `ANTHROPIC_MODEL` | `.env.claude` or interactive | start_claude_code.sh | claude CLI (model selection) |
| `ANTHROPIC_BASE_URL` | `.env.claude` + resolved | start_claude_code.sh | claude CLI (API endpoint) |
| `ANTHROPIC_API_KEY` | `.env.claude` | start_claude_code.sh | claude CLI (auth, ignored by proxy) |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `.env.claude` | start_claude_code.sh | claude CLI (strip beta fields) |
| `CLAUDE_CODE_SIMPLE` | `.env.claude` or script | start_claude_code.sh | claude CLI (bare mode) |
| `DISABLE_AUTOUPDATER` | `.env.claude` or script | start_claude_code.sh | claude CLI (no updates) |
| `DISABLE_TELEMETRY` | `.env.claude` or script | start_claude_code.sh | claude CLI (no telemetry) |

---

## Usage Scenarios

### Scenario 1: Full Stack (`start.sh`)

```bash
sh start.sh
```

| Step | Action | Failure Mode |
|---|---|---|
| 1 | Load `.env.proxy` | Die: "Missing config file" |
| 2 | Check bun installed | Die: "bun not found" |
| 3 | Check LLM server at `/v1/models` | Die: "LLM server not reachable" |
| 4 | Check port 5678 free | Die: "Port 5678 already in use" |
| 5 | Start proxy background | — |
| 6 | Health check (5s timeout) | Die: "Proxy not healthy" or "exited unexpectedly" |
| 7 | Launch `start_claude_code.sh` | (see below) |
| 8 | User works in Claude Code | — |
| 9 | User exits (Ctrl+C or `/exit`) | Cleanup trap kills proxy |

### Scenario 2: Standalone Launcher (`start_claude_code.sh`)

```bash
# Proxy already running (started manually or by another process)
sh start_claude_code.sh
```

| Step | Action | Failure Mode |
|---|---|---|
| 1 | Load `.env.proxy` + `.env.claude` | Die: "Missing config file" |
| 2 | Resolve `${PROXY_PORT}` | — |
| 3 | Model selection (if empty) | Die: "Cannot reach LLM server" |
| 4 | Check `claude` in PATH | Die: "claude command not found" |
| 5 | Check proxy health | **Warning only** (non-fatal) |
| 6 | `exec claude` | — |

### Scenario 3: Proxy Only (`cd proxy && bun start`)

```bash
cd proxy && bun start
```

Starts just the proxy server. Useful for development or when connecting Claude Code from a different terminal/machine.

---

## Design Decisions

| Decision | Reason |
|---|---|
| **No `exec` in start.sh** | Preserves the cleanup trap. `exec` replaces the shell process, discarding all traps — the proxy would become an orphan on Ctrl+C. |
| **`exec` in start_claude_code.sh** | Safe because this script has no cleanup responsibilities. Replacing the shell with `claude` avoids an unnecessary parent process. |
| **Env overrides file values** | Allows per-session overrides (`ANTHROPIC_MODEL=... sh start.sh`) without editing config files. |
| **Health check with process check** | Between retries, verify `PROXY_PID` is still alive. Detects crashes immediately instead of waiting for the full 5s timeout. |
| **Proxy warning is non-fatal** | `start_claude_code.sh` may run standalone with a proxy on a different host/port. Blocking on health check would prevent this use case. |
| **Model selection is interactive** | When `ANTHROPIC_MODEL` is empty, queries the LLM server and presents a numbered menu. Filters out embedding models automatically. |
| **Logs to proxy/proxy.log** | Proxy stdout/stderr redirected to file. Prevents proxy logs from mixing with Claude Code's terminal UI. |

---

## Related Docs

- [Architecture](proxy-architecture.md) — internal proxy structure
- [Configuration](proxy-configuration.md) — all environment variables
- [Tool Management](tool-management.md) — scoring, selection, UseTool
