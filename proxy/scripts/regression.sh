#!/usr/bin/env bash
#
# regression.sh — Fix 8 refactor regression suite.
#
# Runs a series of curl requests against a live proxy + LM Studio and prints
# a normalized output that captures STRUCTURAL invariants of the proxy:
#
#   - HTTP status codes of deterministic endpoints
#   - Sorted unique SSE event types for each chat turn
#   - Shape of JSON responses (keys only, not values)
#   - Filesystem state after each turn (count of files per dir)
#
# The goal is a diffable snapshot that flags regressions introduced by the
# Fix 8 refactor WITHOUT being sensitive to LLM non-determinism (specific
# text content, slug names, etc.).
#
# Prerequisites:
#   - Proxy running on $PROXY_PORT (default 5678)
#   - LM Studio running on 127.0.0.1:1234 with nemotron-cascade-2-30b-a3b@4bit loaded
#
# Usage:
#   ./proxy/scripts/regression.sh > /tmp/regression-baseline.txt
#   # ... refactor step ...
#   ./proxy/scripts/regression.sh > /tmp/regression-phase-N.txt
#   diff /tmp/regression-baseline.txt /tmp/regression-phase-N.txt
#
set -u
PROXY_URL="${PROXY_URL:-http://127.0.0.1:5678}"
WORKSPACE="${REGRESSION_WORKSPACE:-/tmp/claudio-regression-workspace}"

section() { printf '\n########## %s ##########\n' "$1"; }
status_only() { curl -sf -o /dev/null -w '%{http_code}' "$@" 2>&1; }

# Normalize a raw SSE body into: sorted unique event names + count of each.
# Ignores data payload (too non-deterministic).
sse_events() {
  grep -oE '^event: [a-z_]+' "$1" 2>/dev/null | sed 's/^event: //' | sort | uniq -c | awk '{printf "%s:%d\n", $2, $1}'
}

# Normalize a JSON response into its top-level key names (sorted).
json_keys() {
  python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(",".join(sorted(d.keys())) if isinstance(d, dict) else "NON_DICT")'
}

# ─── Pre-flight ────────────────────────────────────────────────────────────────

rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE"
echo '# Regression test workspace' > "$WORKSPACE/README.md"

# ─── S1–S2: deterministic GETs ─────────────────────────────────────────────────

section "S1 GET /health"
echo "status: $(status_only $PROXY_URL/health)"
curl -sf $PROXY_URL/health | json_keys

section "S2 GET /config"
echo "status: $(status_only $PROXY_URL/config)"
curl -sf $PROXY_URL/config | json_keys

section "S3 GET /commands"
echo "status: $(status_only $PROXY_URL/commands)"
curl -sf $PROXY_URL/commands | json_keys

# ─── S4–S8: agent-mode transitions ─────────────────────────────────────────────

section "S4 POST /agent-mode ask"
curl -s -o /tmp/reg-s4.json -w 'status: %{http_code}\n' \
  -X POST $PROXY_URL/agent-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"ask"}'
cat /tmp/reg-s4.json | json_keys

section "S5 POST /agent-mode auto"
curl -s -o /tmp/reg-s5.json -w 'status: %{http_code}\n' \
  -X POST $PROXY_URL/agent-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"auto"}'
cat /tmp/reg-s5.json | json_keys

section "S6 POST /agent-mode plan"
curl -s -o /tmp/reg-s6.json -w 'status: %{http_code}\n' \
  -X POST $PROXY_URL/agent-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"plan"}'
cat /tmp/reg-s6.json | json_keys

section "S7 POST /agent-mode invalid (expect 400)"
curl -s -o /tmp/reg-s7.json -w 'status: %{http_code}\n' \
  -X POST $PROXY_URL/agent-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"nonsense"}'
cat /tmp/reg-s7.json | json_keys

section "S8 GET /agent-mode (should be plan after S6 then error from S7)"
echo "status: $(status_only $PROXY_URL/agent-mode)"
curl -sf $PROXY_URL/agent-mode | json_keys

# ─── S9: /v1/messages/:id/approve on unknown id ────────────────────────────────

section "S9 POST /v1/messages/unknown/approve"
curl -s -o /tmp/reg-s9.json -w 'status: %{http_code}\n' \
  -X POST $PROXY_URL/v1/messages/nonexistent/approve \
  -H "Content-Type: application/json" \
  -d '{"approved":true,"scope":"once"}'
cat /tmp/reg-s9.json | json_keys

# ─── P: Plan mode tests (LLM-dependent, SEED an existing plan to avoid Nemotron typo flakiness) ──

section "P1 Plan mode create — seeded workspace"
# Pre-seed a plan file so the "existing plan" injection path is tested
# deterministically. This bypasses Nemotron's path-typo flakiness on the first
# plan creation. The refactor preserves this injection path; that's what we test.
mkdir -p "$WORKSPACE/.claudio/plans"
cat > "$WORKSPACE/.claudio/plans/existing-plan.md" <<'EOF'
# Existing Plan

## Context
A pre-seeded plan file used by the regression suite to test plan-mode refinement
without relying on Nemotron to correctly type a fresh path.

## Steps
1. Read this plan
2. Do nothing
EOF

curl -s -X POST $PROXY_URL/agent-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"plan"}' > /dev/null

echo "plans dir before P1: $(ls "$WORKSPACE/.claudio/plans/" 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//')"

section "P2 Plan mode refine — update existing plan"
curl -N -s -X POST $PROXY_URL/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-workspace-root: $WORKSPACE" \
  -d '{"model":"default","max_tokens":4096,"temperature":0,"stream":true,"messages":[{"role":"user","content":"Add a Verification section to the existing plan."}]}' \
  > /tmp/reg-p2.sse 2>&1
echo "event types:"
sse_events /tmp/reg-p2.sse
echo "plans dir file count after refine: $(ls "$WORKSPACE/.claudio/plans/"*.md 2>/dev/null | wc -l | tr -d ' ')"
echo "existing-plan.md still exists: $([ -f "$WORKSPACE/.claudio/plans/existing-plan.md" ] && echo YES || echo NO)"

section "P3 Plan mode exit — procedi"
curl -N -s -X POST $PROXY_URL/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-workspace-root: $WORKSPACE" \
  -d '{"model":"default","max_tokens":2048,"temperature":0,"stream":true,"messages":[{"role":"user","content":"proceed with the plan"}]}' \
  > /tmp/reg-p3.sse 2>&1
echo "event types:"
sse_events /tmp/reg-p3.sse
echo "has plan_mode_exit_suggestion: $(grep -c plan_mode_exit_suggestion /tmp/reg-p3.sse)"

# ─── A1: Ask mode — single action ──────────────────────────────────────────────

section "A1 Ask mode baseline event types"
curl -s -X POST $PROXY_URL/agent-mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"ask"}' > /dev/null
rm -rf "$WORKSPACE"/regression-a.txt
curl -N -s -X POST $PROXY_URL/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-workspace-root: $WORKSPACE" \
  -d '{"model":"default","max_tokens":3072,"temperature":0,"stream":true,"messages":[{"role":"user","content":"Create a file named regression-a.txt with content A"}]}' \
  > /tmp/reg-a1.sse 2>&1 &
A1_PID=$!
# Wait for tool_request_pending
for i in $(seq 1 60); do
  REQID=$(grep -o 'request_id":"[^"]*"' /tmp/reg-a1.sse 2>/dev/null | head -1 | sed 's/request_id":"//; s/"$//')
  [ -n "$REQID" ] && break
  sleep 1
done
echo "got request_id: $([ -n "$REQID" ] && echo YES || echo NO)"
if [ -n "$REQID" ]; then
  curl -s -X POST "$PROXY_URL/v1/messages/${REQID}/approve" \
    -H "Content-Type: application/json" \
    -d '{"approved":true,"scope":"once"}' > /dev/null
fi
wait $A1_PID 2>/dev/null
echo "event types:"
sse_events /tmp/reg-a1.sse
echo "file created: $([ -f "$WORKSPACE/regression-a.txt" ] && echo YES || echo NO)"

# ─── SUMMARY ───────────────────────────────────────────────────────────────────

section "FINAL STATE"
echo "workspace files:"
find "$WORKSPACE" -type f 2>/dev/null | sed "s|$WORKSPACE|WS|" | sort
echo "plans dir listing:"
ls "$WORKSPACE/.claudio/plans/" 2>/dev/null | sort
