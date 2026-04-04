#!/usr/bin/env bash
# ===========================================================================
# start.sh — Start the Anthropic-to-OpenAI proxy and Claude Code
#
# 1. Loads .env.proxy
# 2. Checks prerequisites (bun, LLM server)
# 3. Starts the proxy in the background
# 4. Waits for the proxy health check
# 5. Launches Claude Code via start_claude_code.sh
# 6. On exit, shuts down the proxy
# ===========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_PID=""

# ── Helpers ────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

# ── Cleanup on exit ───────────────────────────────────────────────────────

cleanup() {
  if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    echo ""
    yellow "Shutting down proxy (PID $PROXY_PID)..."
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
    green "Proxy stopped."
  fi
}
trap cleanup EXIT INT TERM

# ── Load .env.proxy ───────────────────────────────────────────────────────

ENV_PROXY="$SCRIPT_DIR/proxy/.env.proxy"
[[ -f "$ENV_PROXY" ]] || die "Missing config file: $ENV_PROXY"

while IFS='=' read -r key value; do
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$key" ]] && continue
  key="$(echo "$key" | xargs)"
  value="$(echo "$value" | xargs)"
  if [[ -z "${!key:-}" ]]; then
    export "$key=$value"
  fi
done < "$ENV_PROXY"

PROXY_PORT="${PROXY_PORT:-5678}"
TARGET_URL="${TARGET_URL:-http://127.0.0.1:1234/v1/chat/completions}"
DEBUG="${DEBUG:-0}"

export PROXY_PORT TARGET_URL DEBUG

# ── Prerequisites ─────────────────────────────────────────────────────────

echo ""
bold "=== Anthropic-to-OpenAI Proxy ==="
echo ""

# Check bun
if ! command -v bun &>/dev/null; then
  die "'bun' not found. Install it: curl -fsSL https://bun.sh/install | bash"
fi
echo "  bun:        $(bun --version)"

# Check LLM server
TARGET_BASE="${TARGET_URL%/v1/chat/completions}"
if curl -sf "$TARGET_BASE/v1/models" &>/dev/null; then
  echo "  LLM server: $TARGET_BASE (reachable)"
else
  die "LLM server not reachable at $TARGET_BASE/v1/models — is it running?"
fi

echo "  Proxy port: $PROXY_PORT"
echo "  Debug:      $( [[ "$DEBUG" == "1" ]] && echo "ON" || echo "OFF" )"
echo ""

# ── Check port availability ───────────────────────────────────────────────

if lsof -i :"$PROXY_PORT" &>/dev/null; then
  die "Port $PROXY_PORT is already in use. Change PROXY_PORT in .env.proxy or stop the other process."
fi

# ── Start proxy ───────────────────────────────────────────────────────────

PROXY_LOG="$SCRIPT_DIR/proxy/proxy.log"
bold "Starting proxy... (log: $PROXY_LOG)"
bun run "$SCRIPT_DIR/proxy/src/main.ts" > "$PROXY_LOG" 2>&1 &
PROXY_PID=$!

# ── Wait for health check ────────────────────────────────────────────────

HEALTH_URL="http://127.0.0.1:${PROXY_PORT}/health"
MAX_RETRIES=30
RETRY_DELAY=1

for i in $(seq 1 $MAX_RETRIES); do
  if curl -sf "$HEALTH_URL" &>/dev/null; then
    green "Proxy is ready (PID $PROXY_PID)"
    echo ""
    break
  fi
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    die "Proxy process exited unexpectedly."
  fi
  if [[ $i -eq $MAX_RETRIES ]]; then
    die "Proxy did not become healthy after $MAX_RETRIES retries."
  fi
  sleep "$RETRY_DELAY"
done

# ── Launch Claude Code ────────────────────────────────────────────────────
# Do NOT use exec here — exec replaces this process, which would discard
# the cleanup trap and leave the proxy running as an orphan on Ctrl+C.

"$SCRIPT_DIR/start_claude_code.sh" "$@"
