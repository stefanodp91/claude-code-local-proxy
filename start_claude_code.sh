#!/usr/bin/env bash
# ===========================================================================
# start_claude_code.sh — Launch Claude Code connected to the local proxy
#
# Can be called standalone (proxy must already be running) or from start.sh.
# Loads .env.proxy and .env.claude, resolves variables, prompts for the
# model if not configured, then exec's into `claude`.
# ===========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Helpers ────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

# ── Load .env files ───────────────────────────────────────────────────────

load_env() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    die "Missing config file: $file"
  fi
  # Source only KEY=VALUE lines, skip comments and blanks
  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    # Trim whitespace
    key="$(echo "$key" | xargs)"
    value="$(echo "$value" | xargs)"
    # Only set if not already in environment (env overrides file)
    if [[ -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < "$file"
}

# Load proxy config first (needed for PROXY_PORT)
load_env "$SCRIPT_DIR/proxy/.env.proxy"

# Load claude config
load_env "$SCRIPT_DIR/proxy/.env.claude"

# ── Resolve ${PROXY_PORT} in ANTHROPIC_BASE_URL ──────────────────────────

ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL/\$\{PROXY_PORT\}/$PROXY_PORT}"
export ANTHROPIC_BASE_URL

# ── Derive TARGET_URL base (strip /v1/chat/completions) ──────────────────

TARGET_BASE="${TARGET_URL%/v1/chat/completions}"

# ── Model selection ───────────────────────────────────────────────────────

if [[ -z "${ANTHROPIC_MODEL:-}" ]]; then
  echo ""
  bold "No model configured (ANTHROPIC_MODEL is empty)."
  echo "Querying available models from $TARGET_BASE/v1/models ..."
  echo ""

  # Fetch model list
  models_json="$(curl -sf "$TARGET_BASE/v1/models" 2>/dev/null)" \
    || die "Cannot reach LLM server at $TARGET_BASE/v1/models — is it running?"

  # Parse model IDs into an array
  mapfile -t models < <(
    echo "$models_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('data', []):
    mid = m.get('id', '')
    # Skip embedding models
    if 'embed' in mid.lower():
        continue
    print(mid)
" 2>/dev/null
  )

  if [[ ${#models[@]} -eq 0 ]]; then
    die "No models found on the LLM server."
  fi

  # Display numbered list
  bold "Available models:"
  for i in "${!models[@]}"; do
    printf "  %s) %s\n" "$((i + 1))" "${models[$i]}"
  done
  echo ""

  # Prompt user
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

# ── Verify claude is installed ────────────────────────────────────────────

if ! command -v claude &>/dev/null; then
  die "'claude' command not found. Install Claude Code first: npm install -g @anthropic-ai/claude-code"
fi

# ── Verify proxy is reachable ─────────────────────────────────────────────

if ! curl -sf "$ANTHROPIC_BASE_URL/health" &>/dev/null; then
  yellow "WARNING: Proxy not reachable at $ANTHROPIC_BASE_URL/health"
  yellow "Make sure the proxy is running (./start.sh or: cd proxy && bun start)"
  echo ""
fi

# ── Sandbox environment ───────────────────────────────────────────────────
# Bare mode: skip OAuth, keychain, telemetry, background prefetches.
# Auth is strictly ANTHROPIC_API_KEY from .env.claude.

export CLAUDE_CODE_SIMPLE="${CLAUDE_CODE_SIMPLE:-1}"
export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"
export DISABLE_TELEMETRY="${DISABLE_TELEMETRY:-1}"

# ── Launch ────────────────────────────────────────────────────────────────

bold "Launching Claude Code"
echo "  Model:    $ANTHROPIC_MODEL"
echo "  Proxy:    $ANTHROPIC_BASE_URL"
echo "  Target:   $TARGET_URL"
echo ""

exec claude "$@"
