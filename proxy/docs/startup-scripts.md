# Startup Scripts

> How `start_agent_cli.sh` orchestrates the proxy and Claude Code CLI.

---

## Overview

Starting from v1.1.0 the proxy lifecycle is managed automatically by its consumer:

| Consumer | How to start |
|---|---|
| **Claudio** (VS Code extension) | Open the project folder in VS Code — proxy starts automatically |
| **Claude Code CLI** | `sh start_agent_cli.sh` — single command for everything |

The old `start.sh` and `start_claude_code.sh` scripts have been removed.
Their functionality is now split between `start_agent_cli.sh` (CLI path)
and `ProxyManager` (VS Code / Claudio path).

---

## start_agent_cli.sh

A single script that:
1. Finds a free port (port discovery)
2. Spawns the proxy in the background
3. Waits for the proxy to be healthy
4. Presents an interactive model selector (if `ANTHROPIC_MODEL` is not set)
5. Launches Claude Code
6. Kills the proxy automatically when Claude Code exits

### Flow

```
start_agent_cli.sh [claude args...]
  │
  ├── register trap cleanup (EXIT INT TERM)
  │     └── on any exit: kill $PROXY_PID, wait, "Proxy stopped."
  │
  ├── load_env proxy/.env.proxy    ← graceful: skipped if missing
  ├── load_env proxy/.env.claude   ← graceful: skipped if missing
  │
  ├── find_free_port ${PROXY_PORT:-5678}
  │     ├── lsof -i :5678 → occupied → try 5679
  │     ├── lsof -i :5679 → occupied → try 5680
  │     └── lsof -i :5680 → free → PROXY_PORT=5680
  │
  ├── check prerequisites
  │     ├── node installed?              → die if missing
  │     └── LLM server at /v1/models?   → die if unreachable
  │
  ├── spawn proxy
  │     PROXY_PORT=5680 npx --prefix proxy tsx proxy/src/main.ts > proxy.log &
  │     PROXY_PID=$!
  │
  ├── health check loop (30 retries × 1s)
  │     ├── curl http://127.0.0.1:5680/health → 200 → break
  │     ├── process still alive? → die "exited unexpectedly"
  │     └── 30th attempt → warning (non-fatal; proxy may still be initializing)
  │
  ├── ANTHROPIC_BASE_URL="http://127.0.0.1:5680"
  │
  ├── model selection (only if ANTHROPIC_MODEL is empty)
  │     ├── GET TARGET_BASE/v1/models
  │     ├── filter out embedding models
  │     ├── display numbered list
  │     └── user picks → ANTHROPIC_MODEL=<selected>
  │
  ├── verify `claude` in PATH → die if missing
  │
  ├── claude "$@"   ← NOT exec (trap must stay active to kill the proxy)
  │
  └── (claude exits / Ctrl+C / SIGTERM)
        └── cleanup trap fires
              ├── kill $PROXY_PID (SIGTERM)
              ├── wait $PROXY_PID
              └── print "Proxy stopped."
```

### Failure modes

| Step | Failure | Behavior |
|---|---|---|
| `node` check | Node.js not in PATH | `die` with install instructions |
| LLM server check | Backend not reachable at `/v1/models` | `die` with hint to start LM Studio |
| Proxy spawn | `npx tsx` fails (`MODULE_NOT_FOUND`) | Proxy exits; health check `die`s with `check proxy.log` |
| Health check (30s) | Proxy starts but probe is slow | Non-fatal warning; Claude Code connects once proxy responds |
| Model query | No models returned | `die "No models found"` |
| `claude` check | Claude Code not installed | `die` with `npm install -g @anthropic-ai/claude-code` |

---

## The `load_env()` Function

```bash
load_env(file):
  if file does not exist → return 0 (graceful)
  for each line in file:
    skip comments (# ...) and blank lines
    parse KEY=VALUE
    trim whitespace from key and value
    if KEY is NOT already in environment:
      export KEY=VALUE
```

**Key behavior:** environment variables already in the shell take precedence over file values.
This allows per-session overrides without editing config files:

```bash
# Use a specific model for this session only
ANTHROPIC_MODEL=qwen/qwen3-235b-a22b sh start_agent_cli.sh

# Point to a different LLM backend
TARGET_URL=http://127.0.0.1:8000/v1/chat/completions sh start_agent_cli.sh
```

---

## Port Discovery

Each invocation of `start_agent_cli.sh` finds its own free port, so multiple agents
can run in parallel. The base port comes from `PROXY_PORT` in `.env.proxy`
(default: 5678).

```bash
find_free_port() {
  local port="${1:-5678}"
  while lsof -i :"$port" &>/dev/null 2>&1; do ((port++)); done
  echo "$port"
}
```

Example with two parallel sessions:

| Session | Ports tried | Port assigned | Claude Code connects to |
|---|---|---|---|
| Session 1 | 5678 (free) | 5678 | `http://127.0.0.1:5678` |
| Session 2 | 5678 (taken) → 5679 (free) | 5679 | `http://127.0.0.1:5679` |

---

## Design Decisions

| Decision | Reason |
|---|---|
| **`claude "$@"` instead of `exec claude`** | `exec` replaces the shell process and discards all registered traps — the proxy would become an orphan. Using a regular call keeps the trap active. |
| **Port discovery runs always** | Every invocation gets its own proxy on its own port, enabling parallel agents without any coordination. |
| **Graceful `.env` loading** | Missing `.env.proxy` or `.env.claude` does not abort the script — the proxy starts with built-in defaults. |
| **Health check is non-fatal after 30s** | The proxy's tool probe (binary search) can take up to 30s on slow models. The 30s limit warns the user but does not kill the proxy. Claude Code will connect once the proxy responds. |
| **Proxy log redirected to file** | Prevents proxy log lines from mixing with Claude Code's terminal UI. Check `proxy/proxy.log` for proxy-side errors. |

---

## Usage Scenarios

| Scenario | Command | What happens |
|---|---|---|
| Single agent | `sh start_agent_cli.sh` | Proxy on 5678, Claude Code starts |
| Two parallel agents | Two terminals, each `sh start_agent_cli.sh` | Proxy on 5678 and 5679, independent sessions |
| Override model | `ANTHROPIC_MODEL=llama3 sh start_agent_cli.sh` | Skips model selector, uses llama3 |
| CLI alongside Claudio | Both running simultaneously | Claudio has 5678, CLI finds 5679 (or next free) |
| Debug proxy | `sh start_agent_cli.sh` then `tail -f proxy/proxy.log` | Real-time proxy logs in second terminal |

---

## Environment Variable Flow

| Variable | Source | Who sets it | Who reads it |
|---|---|---|---|
| `PROXY_PORT` | `.env.proxy` + port discovery | `find_free_port` | Proxy HTTP server |
| `TARGET_URL` | `.env.proxy` | `load_env` | Proxy (forwarding), prereq check |
| `ANTHROPIC_BASE_URL` | Derived: `http://127.0.0.1:$PROXY_PORT` | Script | Claude Code CLI |
| `ANTHROPIC_MODEL` | `.env.claude` or interactive | Script | Claude Code CLI |
| `ANTHROPIC_API_KEY` | `.env.claude` | `load_env` | Claude Code (auth; ignored by proxy) |
| `CLAUDE_CODE_SIMPLE` | `.env.claude` or default `1` | Script | Claude Code (bare mode) |
| `DISABLE_AUTOUPDATER` | Default `1` | Script | Claude Code |
| `DISABLE_TELEMETRY` | Default `1` | Script | Claude Code |

---

## Related Docs

- [Proxy Lifecycle](lifecycle.md) — multi-instance architecture, port discovery, edge cases
- [Architecture](architecture.md) — internal proxy structure
- [Configuration](configuration.md) — all `.env.proxy` variables
- [Claudio Architecture](../../chat-extension/docs/architecture.md) — ProxyManager (VS Code lifecycle)
