# Quick Setup

> Minimum configuration to get the proxy and Claude Code running with a local LLM.

## Prerequisites

| Requirement | Verify |
|---|---|
| **Bun** >= 1.3 | `bun --version` |
| **Claude Code** installed globally | `claude --version` |
| **LLM server** running (LM Studio, ollama, vLLM, ...) | `curl http://127.0.0.1:1234/v1/models` |

---

## 1. Configure the Proxy

Create (or edit) `proxy/.env.proxy` with two variables:

```env
PROXY_PORT=5678
TARGET_URL=http://127.0.0.1:1234/v1/chat/completions
```

| Variable | Purpose | When to change |
|---|---|---|
| `PROXY_PORT` | Port the proxy listens on | If 5678 is already in use |
| `TARGET_URL` | Your LLM server endpoint | If using ollama (`:11434`), vLLM (`:8000`), etc. |

Everything else has sensible defaults and can be ignored for a first run.

### Common backend URLs

```
LM Studio:              http://127.0.0.1:1234/v1/chat/completions
ollama:                 http://127.0.0.1:11434/v1/chat/completions
vLLM:                   http://127.0.0.1:8000/v1/chat/completions
text-generation-webui:  http://127.0.0.1:5000/v1/chat/completions
```

---

## 2. Configure Claude Code

Create (or edit) `proxy/.env.claude`:

```env
ANTHROPIC_MODEL=qwen/qwen3.5-35b-a3b
ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}
ANTHROPIC_API_KEY=local-proxy
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
CLAUDE_CODE_SIMPLE=1
DISABLE_AUTOUPDATER=1
DISABLE_TELEMETRY=1
```

| Variable | Purpose | Notes |
|---|---|---|
| `ANTHROPIC_MODEL` | Model ID loaded in the LLM server | Leave empty for interactive selection at startup |
| `ANTHROPIC_BASE_URL` | Points Claude Code to the proxy | `${PROXY_PORT}` is resolved automatically |
| `ANTHROPIC_API_KEY` | API key (any non-empty string) | The proxy ignores it, but the SDK requires one |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | Strip beta fields from tool schemas | Without this, LM Studio rejects requests |
| `CLAUDE_CODE_SIMPLE` | Disable OAuth, keychain, telemetry | Sandbox mode for local use |
| `DISABLE_AUTOUPDATER` | No update checks | Prevents connections to Anthropic |
| `DISABLE_TELEMETRY` | No telemetry | Prevents connections to Anthropic |

**Tip:** if you don't know your model's exact ID, leave `ANTHROPIC_MODEL` empty. The launcher will query the server and show a selection menu.

---

## 3. Launch

### Option A: all-in-one

```bash
sh start.sh
```

This will:
1. Verify prerequisites (bun, LLM server, free port)
2. Start the proxy in the background
3. Wait for the health check to pass
4. Launch Claude Code
5. On exit, automatically shut down the proxy

### Option B: separate terminals

```bash
# Terminal 1: start the proxy
cd proxy && bun start

# Terminal 2: launch Claude Code
sh start_claude_code.sh
```

### Option C: interactive model selection

Clear `ANTHROPIC_MODEL` in `.env.claude`:

```env
ANTHROPIC_MODEL=
```

At startup you'll see:

```
No model configured (ANTHROPIC_MODEL is empty).
Querying available models from http://127.0.0.1:1234/v1/models ...

Available models:
  1) qwen/qwen3.5-35b-a3b
  2) nemotron-cascade-2-30b-a3b@6bit
  3) llama-3.1-8b-instruct

Select a model [1-3]: _
```

---

## Bare Minimum Configuration

If you want the absolute minimum and accept all defaults:

**`proxy/.env.proxy`** (2 lines):
```env
PROXY_PORT=5678
TARGET_URL=http://127.0.0.1:1234/v1/chat/completions
```

**`proxy/.env.claude`** (3 lines):
```env
ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}
ANTHROPIC_API_KEY=local-proxy
CLAUDE_CODE_SIMPLE=1
```

Then:
```bash
sh start.sh
```

The proxy will:
- Auto-detect the model loaded in LM Studio
- Auto-detect the tool calling limit via binary search probe
- Prompt you to choose a model interactively

```
+──────────+       +───────+       +──────────+
│ Claude   │ :5678 │       │ :1234 │ LM       │
│ Code     │──────>│ Proxy │──────>│ Studio   │
│          │<──────│       │<──────│          │
+──────────+       +───────+       +──────────+
```

---

## Verify

After startup, check that everything is working:

```bash
# Proxy health check
curl http://127.0.0.1:5678/health
# Expected: {"status":"ok","target":"http://127.0.0.1:1234/v1/chat/completions"}
```

If Claude Code starts and shows the `>` prompt, the setup is complete.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Port 5678 already in use" | Proxy already running | `lsof -i :5678` to find the process, then `kill <PID>` |
| "LLM server not reachable" | LLM server not started | Start LM Studio and load a model |
| "Extra inputs are not permitted" | Beta fields not stripped | Add `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` to `.env.claude` |
| "claude command not found" | Claude Code not installed | `npm install -g @anthropic-ai/claude-code` |
| Proxy starts but Claude gets no response | Model doesn't support tool calling | Check `proxy/proxy.log` — if it says "Model does not support tool calling", switch model |
| Truncated or repetitive output | max_tokens too high | The proxy caps this automatically. If it persists, lower `CONTEXT_TO_MAX_TOKENS_RATIO` in `.env.proxy` |

---

## Next Steps

- [Full Configuration Reference](proxy-configuration.md) — all advanced variables (scoring, probe, promotion, limits)
- [Tool Management](tool-management.md) — how dynamic tool selection works
- [Architecture](proxy-architecture.md) — internal proxy structure
- [Startup Scripts](startup-scripts.md) — start.sh and start_claude_code.sh details
