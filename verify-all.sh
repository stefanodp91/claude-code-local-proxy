#!/usr/bin/env bash
# ===========================================================================
# verify-all.sh — run everything that can check itself, in one command.
#
# There are three kinds of check in this repository and they need different
# things, which is exactly what made them confusing to run by hand:
#
#   1. the automated suites   — no GPU, no model, no network. Always run.
#   2. the end-to-end scripts — need LM Studio with a model loaded. Run when
#                               one is reachable, skipped with a reason when not.
#   3. Claudio in VS Code     — needs a human looking at a screen. Never run
#                               here; the checklist is printed at the end.
#
# Usage, from anywhere:
#
#   sh /path/to/claude-code/verify-all.sh          # 1, and 2 if a model is up
#   sh /path/to/claude-code/verify-all.sh --fast   # 1 only
#
# It starts its own proxy for the end-to-end part and stops it afterwards,
# using the same lifecycle rules the launcher and Claudio use.
# ===========================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
FAST="${1:-}"
PROXY_PID=""
PROXY_PORT=""
FAILED=0

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
grey()  { printf '\033[0;90m%s\033[0m\n' "$*"; }

step() { printf '\n'; bold "── $* ─────────────────────────────────────────"; }

# Run a command, print one line of verdict, remember any failure.
#
# Each check keeps its own log and the path is printed when it fails. The first
# version of this shared one file and showed five lines of it, which hid the
# only thing worth seeing: a failing check whose *last* lines happened to be
# passes read as a mystery.
CHECK_N=0
check() { # label, command…
  local label="$1"; shift
  CHECK_N=$((CHECK_N + 1))
  local log="/tmp/verify-all-${CHECK_N}.log"
  if "$@" > "$log" 2>&1; then
    green "PASS  $label"
  else
    red "FAIL  $label"
    grey "      full output: $log"
    grep -E "FAIL|Error|error|✖|not ok" "$log" | head -8 | sed 's/^/      /'
    FAILED=1
  fi
}

cleanup() {
  if [ -n "$PROXY_PID" ]; then
    (cd "$ROOT/proxy" && node --import tsx src/cli/lifecycle.ts kill-group "$PROXY_PID" >/dev/null 2>&1)
  fi
}
trap cleanup EXIT INT TERM

# ── 1. The suites ─────────────────────────────────────────────────────────

step "Automated suites (no model needed)"

check "proxy — 446 tests"        sh -c "cd '$ROOT/proxy' && npm test"
check "proxy — typecheck"        sh -c "cd '$ROOT/proxy' && npm run typecheck"
check "claudio — 63 tests"       sh -c "cd '$ROOT/chat-extension' && npm test"
check "claudio — typecheck"      sh -c "cd '$ROOT/chat-extension' && npm run typecheck"
check "claudio — test typecheck" sh -c "cd '$ROOT/chat-extension' && npm run typecheck:test"

if [ "$FAST" = "--fast" ]; then
  step "Result"
  [ "$FAILED" -eq 0 ] && green "the suites pass. End-to-end skipped (--fast)." || red "something failed above."
  exit "$FAILED"
fi

# ── 2. End to end, against a real model ───────────────────────────────────

step "End-to-end (needs LM Studio with a model loaded)"

TARGET_BASE="${TARGET_URL:-http://127.0.0.1:1234/v1/chat/completions}"
TARGET_BASE="${TARGET_BASE%/v1/chat/completions}"

if ! curl -sf "$TARGET_BASE/v1/models" >/dev/null 2>&1; then
  grey "SKIP  no backend answering at $TARGET_BASE — load a model in LM Studio to run these."
  grey "      (everything above still ran)"
else
  MODEL="${ANTHROPIC_MODEL:-$(curl -sf "$TARGET_BASE/v1/models" | python3 -c "
import sys, json
models = [m['id'] for m in json.load(sys.stdin).get('data', []) if 'embed' not in m.get('id','').lower()]
print(models[0] if models else '')
" 2>/dev/null)}"
  grey "      model: ${MODEL:-unknown}"

  PROXY_PORT="$(cd "$ROOT/proxy" && node --import tsx src/cli/lifecycle.ts find-port 5678)"
  grey "      starting a proxy on port $PROXY_PORT (log: /tmp/verify-all-proxy.log)"
  # `set -m` gives the background job its own process group, and without it the
  # group kill in cleanup() reaches nothing: the subshell dies, npm and node
  # survive, and the port stays held. That is the same orphan this repository
  # fixed in ProxyManager and in start_agent_cli.sh — and it reappeared here,
  # in a script written after both, which is why the rule is worth stating
  # rather than remembering: a background job that must be killable needs its
  # own group.
  set -m
  (cd "$ROOT/proxy" && PROXY_PORT="$PROXY_PORT" npm start > /tmp/verify-all-proxy.log 2>&1) &
  PROXY_PID=$!
  set +m

  if (cd "$ROOT/proxy" && node --import tsx src/cli/lifecycle.ts wait-health "$PROXY_PORT" 60 "$PROXY_PID" >/dev/null); then
    green "PASS  proxy started and answered /health"
    export PROXY_URL="http://127.0.0.1:$PROXY_PORT"

    check "approval handshake (allow / deny / scope=turn / unknown id)" \
      sh -c "cd '$ROOT/chat-extension' && npx tsx scripts/approval-e2e.ts /tmp/verify-approval"
    check "plan mode, start to finish" \
      sh -c "cd '$ROOT/chat-extension' && npx tsx scripts/plan-mode-e2e.ts /tmp/verify-plan"

    # The CLI check starts a proxy of its own, so ours has to be gone first —
    # and *gone* means the port has stopped answering, not that the signal has
    # been sent. Without this wait the launcher's proxy raced ours for the port,
    # died, and the check reported a launcher that had not stopped anything.
    cleanup; PROXY_PID=""
    grey "      waiting for port $PROXY_PORT to be released"
    for _ in $(seq 1 20); do
      curl -sf "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1 || break
      sleep 0.5
    done

    check "Claude Code through the proxy (the CLI surface)" \
      sh -c "ANTHROPIC_MODEL='$MODEL' sh '$ROOT/proxy/scripts/cli-e2e.sh'"
  else
    red "FAIL  the proxy did not become healthy — see /tmp/verify-all-proxy.log"
    FAILED=1
  fi
fi

# ── 3. What only a person can check ───────────────────────────────────────

step "By hand, in VS Code (nothing above covers this)"

cat <<EOF
  A demo workspace is prepared for you, with a skill and a trusted hook:

    $ROOT/demo-workspace

  Open it in VS Code with Claudio attached, then ask for these four things
  and watch what happens:

    1. "Add a JSDoc comment above every function in src/, then write a
        README listing them"
       → the model writes .claudio/TODO.md by itself and ticks it off

    2. "Write me a commit message for a fix to slug()"
       → it loads the commit-style skill: rune in the subject, 'Skål.' last

    3. "Create src/config.js with a loadConfig function"
       → the hook complains about the missing 'use strict', and the model
         rewrites the file to fix it

    4. "Delete src/parser.js"
       → the approval modal — the path that crosses both processes

  And the one worth doing because it found the most bugs:

    5. "Plot y = x^2 with python and tell me what shape it is"
       → the PNG lands in .claudio/plots/ and the model describes a figure
         it is actually looking at
EOF

step "Result"
if [ "$FAILED" -eq 0 ]; then
  green "everything that can check itself, does."
else
  red "something failed above — the FAIL lines say what."
fi
exit "$FAILED"
