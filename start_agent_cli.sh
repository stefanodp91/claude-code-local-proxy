#!/usr/bin/env bash
# Re-exec with bash if invoked as `sh script.sh`.
# On macOS /bin/sh is bash in POSIX mode: BASH_VERSION is set but process
# substitution and mapfile are disabled. Check the actual process name instead.
if [ "$(ps -p $$ -o comm= 2>/dev/null)" = "sh" ] || [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
# ===========================================================================
# start_agent_cli.sh — Launch Claude Code connected to a fresh local proxy
#
# Each invocation spawns its own proxy process on a dynamically-discovered
# free port, so multiple agents can run in parallel without conflicts.
# The proxy is killed automatically when Claude Code exits.
#
# Usage:
#   sh start_agent_cli.sh [claude options...]
#
# Prerequisites:
#   - Node.js 18+  (node, npx)
#   - Claude Code  (npm install -g @anthropic-ai/claude-code)
#   - LM Studio (or another LLM backend) running and serving /v1/models
#   - proxy/node_modules present (cd proxy && npm install)
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

# ── Cleanup trap ──────────────────────────────────────────────────────────
# Kills the proxy when Claude Code exits (normally or via Ctrl+C).
# If PROXY_PID is empty (proxy was not started by this script), no action.

cleanup() {
  if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    echo ""
    yellow "Stopping proxy (PID $PROXY_PID)…"
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
    green "Proxy stopped."
  fi
}
trap cleanup EXIT INT TERM

# ── Load .env files ────────────────────────────────────────────────────────
# Each KEY=VALUE line is exported unless already set in the environment,
# so shell variables override file values (e.g. ANTHROPIC_MODEL=... sh start_agent_cli.sh).
# Missing files are silently skipped — the proxy uses its built-in defaults.

load_env() {
  local file="$1"
  [[ ! -f "$file" ]] && return 0
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    key="$(echo "$key" | xargs)"
    value="$(echo "$value" | xargs)"
    if [[ -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < "$file"
}

load_env "$SCRIPT_DIR/proxy/.env.proxy"
load_env "$SCRIPT_DIR/proxy/.env.claude"

# ── Port discovery ─────────────────────────────────────────────────────────
# Find the first free TCP port starting from PROXY_PORT (default 5678).
# Each invocation gets its own port → multiple parallel agents are supported.

find_free_port() {
  local port="${1:-5678}"
  while lsof -i :"$port" &>/dev/null 2>&1; do ((port++)); done
  echo "$port"
}

PROXY_PORT="$(find_free_port "${PROXY_PORT:-5678}")"
TARGET_URL="${TARGET_URL:-http://127.0.0.1:1234/v1/chat/completions}"
TARGET_BASE="${TARGET_URL%/v1/chat/completions}"

# ── Prerequisite checks ────────────────────────────────────────────────────

command -v node &>/dev/null \
  || die "node not found. Install Node.js 18+ from https://nodejs.org"

curl -sf "$TARGET_BASE/v1/models" &>/dev/null \
  || die "LLM server not reachable at $TARGET_BASE — start LM Studio (or your backend) first."

# ── Start proxy ────────────────────────────────────────────────────────────

PROXY_LOG="$SCRIPT_DIR/proxy/proxy.log"
bold "Starting proxy on port ${PROXY_PORT}... (log: $PROXY_LOG)"

PROXY_PORT="${PROXY_PORT}" npm --prefix "$SCRIPT_DIR/proxy" run start \
  > "$PROXY_LOG" 2>&1 &
PROXY_PID=$!

# ── Wait for proxy health ──────────────────────────────────────────────────

HEALTH_URL="http://127.0.0.1:${PROXY_PORT}/health"
for i in $(seq 1 30); do
  if curl -sf "$HEALTH_URL" &>/dev/null; then
    green "Proxy ready (PID $PROXY_PID, port $PROXY_PORT)"
    break
  fi
  kill -0 "$PROXY_PID" 2>/dev/null \
    || die "Proxy exited unexpectedly. Check $PROXY_LOG"
  if [[ $i -eq 30 ]]; then
    yellow "WARNING: Proxy did not respond within 30s (tool probe may still be running)."
    yellow "Claude Code will connect once the proxy is ready."
    break
  fi
  sleep 1
done

# ── Configure Claude Code environment ─────────────────────────────────────

export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}"
export CLAUDE_CODE_SIMPLE="${CLAUDE_CODE_SIMPLE:-1}"
export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"
export DISABLE_TELEMETRY="${DISABLE_TELEMETRY:-1}"

# ── Model selection ────────────────────────────────────────────────────────

if [[ -z "${ANTHROPIC_MODEL:-}" ]]; then
  echo ""
  bold "No model configured (ANTHROPIC_MODEL is empty)."
  echo "Querying available models from $TARGET_BASE/v1/models …"
  echo ""

  models_json="$(curl -sf "$TARGET_BASE/v1/models" 2>/dev/null)" \
    || die "Cannot reach LLM server at $TARGET_BASE/v1/models"

  mapfile -t models < <(
    echo "$models_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('data', []):
    mid = m.get('id', '')
    if 'embed' in mid.lower():
        continue
    print(mid)
" 2>/dev/null
  )

  if [[ ${#models[@]} -eq 0 ]]; then
    die "No models found on the LLM server."
  fi

  bold "Available models:"
  for i in "${!models[@]}"; do
    printf "  %s) %s\n" "$((i + 1))" "${models[$i]}"
  done
  echo ""

  while true; do
    printf "Select a model [1-%d]: " "${#models[@]}"
    read -r choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#models[@]} )); then
      ANTHROPIC_MODEL="${models[$((choice - 1))]}"
      break
    fi
    yellow "Invalid choice. Enter a number between 1 and ${#models[@]}."
  done

  echo ""
  green "Selected model: $ANTHROPIC_MODEL"
  echo ""
fi

export ANTHROPIC_MODEL

# ── Launch Claude Code ─────────────────────────────────────────────────────
# NOT exec: the EXIT trap must remain active to kill the proxy on exit.

command -v claude &>/dev/null \
  || die "'claude' not found. Install it: npm install -g @anthropic-ai/claude-code"

bold "Launching Claude Code"
echo "  Model:   $ANTHROPIC_MODEL"
echo "  Proxy:   $ANTHROPIC_BASE_URL"
echo "  Target:  $TARGET_URL"
echo ""

claude "$@"
