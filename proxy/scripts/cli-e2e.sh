#!/usr/bin/env bash
# ===========================================================================
# cli-e2e.sh — verify the *other* surface: Claude Code through the proxy.
#
# Everything else in this repo tests the proxy as Claudio's agent. This checks
# the path where the proxy is a pure translator and the CLI keeps its own loop,
# its own tools and its own prompts — the half that `X-Workspace-Root` switches
# off, and the half no automated suite exercises end to end.
#
# Two turns, because they fail differently:
#
#   1. a plain answer     — translation, streaming, and the max_tokens cap;
#   2. a turn using a CLI tool — the tool_use / tool_result round trip, which is
#      the part that breaks silently: a mistranslated tool result does not throw,
#      it produces an answer about the wrong thing.
#
# Needs, and cannot run in CI without any of them:
#   - LM Studio (or another backend) serving /v1/models with a model loaded
#   - Claude Code installed  (npm install -g @anthropic-ai/claude-code)
#
# Usage:
#   ANTHROPIC_MODEL="qwen/qwen3.8-27b" sh proxy/scripts/cli-e2e.sh
#
# Last run: 2026-08-27, qwen/qwen3.8-27b — both turns as expected.
# ===========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WS="$(mktemp -d)"
FAILED=0

cleanup() { rm -rf "$WS"; }
trap cleanup EXIT

check() { # label, haystack, needle
  if printf '%s' "$2" | grep -qi -- "$3"; then
    printf 'PASS  %s\n' "$1"
  else
    printf 'FAIL  %s\n      wanted %s in: %s\n' "$1" "$3" "$(printf '%s' "$2" | tail -3)"
    FAILED=1
  fi
}

command -v claude >/dev/null 2>&1 || {
  echo "claude not found — install it: npm install -g @anthropic-ai/claude-code" >&2
  exit 2
}
: "${ANTHROPIC_MODEL:?set ANTHROPIC_MODEL to a model id the backend has loaded}"

printf 'export const VERSION = "4.2.0";\nexport const NAME = "demo";\n' > "$WS/version.ts"

echo "── turn 1: a plain answer ─────────────────────────────────────────────"
plain="$(cd "$WS" && sh "$ROOT/start_agent_cli.sh" --print \
  "Reply with exactly three words: local proxy works" 2>&1)"
check "the CLI gets an answer back through the proxy" "$plain" "local proxy works"
check "the launcher stops the proxy it started" "$plain" "Proxy stopped"

echo
echo "── turn 2: the CLI's own tools ────────────────────────────────────────"
tooled="$(cd "$WS" && sh "$ROOT/start_agent_cli.sh" --print --dangerously-skip-permissions \
  "Read version.ts in this directory and tell me the VERSION value. Use your Read tool." 2>&1)"
check "a tool result round-trips and the answer uses it" "$tooled" "4\.2\.0"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "both turns as expected"
else
  echo "something changed — read the FAILs above"
fi
exit "$FAILED"
