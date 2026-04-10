# Quick Setup

> Complete guide to get the proxy and Claude Code running with a local LLM — from scratch.

---

## Step 0: Prerequisites

First, verify that all required tools are installed.

### Node.js 18+

The proxy runs on Node.js. It is the only required runtime.

```bash
node --version   # must show v18.x.x or higher
npm --version    # must show 9.x or higher
```

If you don't have Node.js: download it from **https://nodejs.org** (choose "LTS"). npm is included automatically.

**Linux (Ubuntu/Debian):**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**macOS with Homebrew:**
```bash
brew install node
```

### Git

Required for the repository and for the `/commit`, `/diff`, `/review` commands.

```bash
git --version   # any 2.x version is fine
```

If you don't have git: **https://git-scm.com/downloads**

### Claude Code CLI

The Claude command-line interface (which the proxy intercepts).

```bash
npm install -g @anthropic-ai/claude-code
claude --version   # must work
```

### LM Studio (or alternative backend)

The LLM backend that processes requests. LM Studio is recommended for the first setup because it provides the proxy with additional model information.

1. Download **LM Studio** from https://lmstudio.ai
2. Open the application and go to the **Discover** or **Models** section
3. Download a model (e.g. Qwen 3.5, Llama 3.1, Nemotron)
4. Load the model in the **Chat** tab
5. Go to **Settings → Local Server** and start the local server (default port: 1234)
6. Verify the server is active:
   ```bash
   curl http://127.0.0.1:1234/v1/models
   # must respond with a JSON listing the available models
   ```

**Alternative backends:**

| Backend | Default URL | Notes |
|---------|-------------|-------|
| LM Studio | `http://127.0.0.1:1234/v1/chat/completions` | Recommended (provides model info) |
| ollama | `http://127.0.0.1:11434/v1/chat/completions` | `ollama serve` to start |
| vLLM | `http://127.0.0.1:8000/v1/chat/completions` | — |
| text-generation-webui | `http://127.0.0.1:5000/v1/chat/completions` | — |

> **Windows note:** `start_agent_cli.sh` requires a bash shell. Use **WSL2** (Windows Subsystem for Linux) to run it. Alternative: start the proxy manually from PowerShell with `cd proxy && npm start`, then start Claude Code separately.

---

## Step 1: Install proxy dependencies (one-time)

```bash
cd proxy
npm install
cd ..
```

This installs `tsx` (TypeScript runner) and the devDependencies. No need to repeat this step on subsequent restarts.

---

## Step 2: Configure the proxy

Create (or edit) `proxy/.env.proxy` with the essential variables:

```env
PROXY_PORT=5678
TARGET_URL=http://127.0.0.1:1234/v1/chat/completions
```

| Variable | Purpose | When to change |
|---|---|---|
| `PROXY_PORT` | Port the proxy listens on | If 5678 is already occupied |
| `TARGET_URL` | LLM server endpoint | If using ollama (`:11434`), vLLM (`:8000`), etc. |

Everything else has sensible defaults and can be ignored for the first run.

---

## Step 3: Configure Claude Code

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
| `ANTHROPIC_MODEL` | ID of the model loaded in the LLM server | Leave empty for interactive selection at startup |
| `ANTHROPIC_BASE_URL` | Points Claude Code to the proxy | `${PROXY_PORT}` is resolved automatically |
| `ANTHROPIC_API_KEY` | API key (any non-empty string) | Ignored by the proxy, but required by the SDK |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | Removes beta fields from tool schemas | Without this, LM Studio rejects requests |
| `CLAUDE_CODE_SIMPLE` | Disables OAuth, keychain, telemetry | Sandbox mode for local use |
| `DISABLE_AUTOUPDATER` | No update checks | Avoids connections to Anthropic |
| `DISABLE_TELEMETRY` | No telemetry | Avoids connections to Anthropic |

**Tip:** if you don't know the exact model ID, leave `ANTHROPIC_MODEL` empty. The launcher will show an interactive selection menu at startup.

---

## Step 4: Start

### Option A: Claudio — VS Code extension (recommended)

If you have the Claudio extension installed (see [Claudio Quick Start](../../chat-extension/docs/quick-start.md)):

1. Open the repository root in VS Code
2. The proxy starts automatically (no dedicated terminal needed)
3. The Claudio panel shows `● Connected` when ready

The `.vscode/settings.json` file already present in the repo configures everything automatically:
```json
{
  "claudio.proxyDir": "${workspaceFolder}/proxy",
  "claudio.autoStartProxy": true
}
```

### Option B: CLI — all-in-one

```bash
sh start_agent_cli.sh
```

The script:
1. Finds a free port starting from 5678 (port discovery)
2. Starts the proxy in the background on that port
3. Waits for the health check to pass
4. Shows a model selection menu (if `ANTHROPIC_MODEL` is empty)
5. Launches Claude Code
6. On exit (Ctrl+C or `/exit`), kills the proxy automatically

### Option C: separate terminals (advanced / debugging)

```bash
# Terminal 1: start the proxy
cd proxy && npm start

# Terminal 2: start Claude Code (pointing to the running proxy)
ANTHROPIC_BASE_URL=http://127.0.0.1:5678 \
ANTHROPIC_MODEL=<model-id> \
ANTHROPIC_API_KEY=local-proxy \
CLAUDE_CODE_SIMPLE=1 \
claude
```

### Interactive model selection

Leave `ANTHROPIC_MODEL` empty in `.env.claude` (or don't set it):

```env
ANTHROPIC_MODEL=
```

`start_agent_cli.sh` will automatically show:

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

## Absolute minimum configuration

If you want the bare minimum and accept all defaults:

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
cd proxy && npm install && cd ..
sh start_agent_cli.sh
```

The proxy:
- Automatically detects the model loaded in LM Studio
- Automatically detects the tool limit via binary search probe (may take 5–30s in background)
- Asks you to choose a model if `ANTHROPIC_MODEL` is empty

```
+──────────+       +───────+       +──────────+
│ Claude   │ :5678 │       │ :1234 │ LM       │
│ Code     │──────>│ Proxy │──────>│ Studio   │
│          │<──────│       │<──────│          │
+──────────+       +───────+       +──────────+
```

---

## Verification

After starting, verify everything works:

```bash
# Proxy health check
curl http://127.0.0.1:5678/health
# Expected: {"status":"ok","target":"http://127.0.0.1:1234/v1/chat/completions"}

# Full configuration (available after the probe completes)
curl http://127.0.0.1:5678/config
# Expected: JSON with model.id, temperature, maxTokensFallback, etc.
```

If Claude Code starts and shows the `>` prompt, the setup is complete.

---

## Troubleshooting

| Symptom | Cause | Solution |
|---|---|---|
| `LLM server not reachable` | LLM server not started | Start LM Studio and load a model |
| `Extra inputs are not permitted` | Beta fields not removed | Add `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` to `.env.claude` |
| `claude command not found` | Claude Code not installed | `npm install -g @anthropic-ai/claude-code` |
| `node not found` | Node.js not installed | Follow Step 0 |
| Proxy responds `503` | `initializeTools()` still running | Wait 5–30s for the background probe, then retry |
| Proxy started but Claude doesn't respond | Model doesn't support tool calling | Check `proxy/proxy.log` — if it says "Model does not support tool calling", switch models |
| Truncated or repetitive output | `max_tokens` too high | The proxy caps it automatically. If it persists, lower `CONTEXT_TO_MAX_TOKENS_RATIO` in `.env.proxy` |
| `npx: command not found` | npm not installed | Install Node.js from https://nodejs.org |
| `model-cache.json` shows `maxTools: N` | Cache hit — probe skipped | Expected behavior. Delete `proxy/model-cache.json` to force re-detection |

---

## LLM backend with ollama

If you're using ollama instead of LM Studio:

```bash
# Start ollama (if not already running as a service)
ollama serve

# Pull a model (e.g. qwen2.5)
ollama pull qwen2.5:7b

# Verify the server is active
curl http://127.0.0.1:11434/v1/models
```

In `proxy/.env.proxy`:
```env
TARGET_URL=http://127.0.0.1:11434/v1/chat/completions
```

Note: with ollama the proxy cannot automatically detect the context length. Set `MAX_TOKENS_FALLBACK` to a value appropriate for the model:
```env
MAX_TOKENS_FALLBACK=8192
```

---

## Next steps

- [Configuration Reference](configuration.md) — all advanced variables (scoring, probe, promotion, limits)
- [Tool Management](tool-management.md) — how dynamic tool selection works
- [Architecture](architecture.md) — proxy internal structure
- [Startup Scripts](startup-scripts.md) — start_agent_cli.sh details
- [Proxy Lifecycle](lifecycle.md) — multi-instance architecture and port discovery
- [Claudio Quick Start](../../chat-extension/docs/quick-start.md) — install the VS Code extension
