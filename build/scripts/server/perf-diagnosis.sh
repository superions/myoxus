#!/usr/bin/env bash
# Performance diagnosis script for the Myoxus server stack.
# Measures latency at different layers to identify bottlenecks.
#
# Usage: build/scripts/server/perf-diagnosis.sh
#
# Requires: curl, awk, a running stack (stack-up.sh)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

API_DIRECT="http://localhost:3001"
API_NGINX="http://192.168.30.10:3010"
ADMIN_EMAIL="admin@myoxus.local"
ADMIN_PASS="AdminMyoxus2026"
N=10

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
NC='\033[0m'

measure() {
  local label="$1"; shift
  # warm up
  "$@" > /dev/null 2>&1 || true
  "$@" > /dev/null 2>&1 || true

  local times=""
  for ((i=0; i<N; i++)); do
    times="$times $("$@" 2>/dev/null || echo 0)"
  done

  local stats
  stats=$(echo "$times" | awk '{
    sum=0; min=999; max=0;
    for(i=1;i<=NF;i++){
      sum+=$i;
      if($i<min) min=$i;
      if($i>max) max=$i;
    }
    avg=sum/NF*1000;
    printf "%.1f %.1f %.1f", avg, min*1000, max*1000
  }')
  local avg=$(echo "$stats" | cut -d' ' -f1)
  local min=$(echo "$stats" | cut -d' ' -f2)
  local max=$(echo "$stats" | cut -d' ' -f3)

  local color=$GRN
  if awk "BEGIN{exit !($avg > 50)}" 2>/dev/null; then color=$YLW; fi
  if awk "BEGIN{exit !($avg > 200)}" 2>/dev/null; then color=$RED; fi

  printf "  %-40s ${color}%6s ms${NC}  (min %s / max %s)\n" "$label" "$avg" "$min" "$max"
}

ct() { curl -s -o /dev/null -w "%{time_total}" "$@"; }

WS_ID="af702bcc-6ba5-4257-89b5-4410be4d12d2"

echo "=== Myoxus Performance Diagnosis ==="
echo "Iterations: $N"
echo ""

SESSION=$(curl -s -c - "$API_DIRECT/api/auth/sign-in" -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" 2>&1 | grep -oP 'affine_session\s+\K\S+')

if [ -z "$SESSION" ]; then echo "ERROR: sign-in failed"; exit 1; fi
echo "Session: ${SESSION:0:8}..."
echo ""

echo "--- Layer 1: Direct API (localhost:3001) ---"
measure "health (no DB)"          ct "$API_DIRECT/health"
measure "auth/session"            ct "$API_DIRECT/api/auth/session" -H "Cookie: affine_session=$SESSION"
measure "serverConfig (5 queries)" ct "$API_DIRECT/graphql" -H 'Content-Type: application/json' -d '{"query":"query{serverConfig{version baseUrl name features type initialized}}"}'
measure "getWorkspaces"           ct "$API_DIRECT/graphql" -H 'Content-Type: application/json' -H "Cookie: affine_session=$SESSION" -d '{"query":"query{workspaces{id initialized workspaceType owner{id}}}"}'
measure "currentUser (full)"      ct "$API_DIRECT/graphql" -H 'Content-Type: application/json' -H "Cookie: affine_session=$SESSION" -d '{"query":"query{currentUser{id name email features copilot{tokens{limit used}}}}"}'
measure "getWorkspaceInfo"        ct "$API_DIRECT/graphql" -H 'Content-Type: application/json' -H "Cookie: affine_session=$SESSION" -d "{\"query\":\"query{workspace(id:\\\"$WS_ID\\\"){permissions{Workspace_Read Workspace_Sync}role workspaceType}}\"}"
measure "workspace doc (binary)"  ct "$API_DIRECT/api/workspaces/$WS_ID/docs/$WS_ID" -H "Cookie: affine_session=$SESSION"
measure "socket.io handshake"     ct "$API_DIRECT/socket.io/?EIO=4&transport=polling" -H "Cookie: affine_session=$SESSION"
measure "branding/theme.css"      ct "$API_DIRECT/api/branding/theme.css"
echo ""

echo "--- Layer 2: Via Nginx (full stack) ---"
measure "HTML page (/)"           ct "$API_NGINX/"
measure "auth/session"            ct "$API_NGINX/api/auth/session" -H "Cookie: affine_session=$SESSION"
measure "serverConfig"            ct "$API_NGINX/graphql" -H 'Content-Type: application/json' -d '{"query":"query{serverConfig{version}}"}'
measure "getWorkspaces"           ct "$API_NGINX/graphql" -H 'Content-Type: application/json' -H "Cookie: affine_session=$SESSION" -d '{"query":"query{workspaces{id}}"}'
measure "workspace doc"           ct "$API_NGINX/api/workspaces/$WS_ID/docs/$WS_ID" -H "Cookie: affine_session=$SESSION"
measure "socket.io"               ct "$API_NGINX/socket.io/?EIO=4&transport=polling" -H "Cookie: affine_session=$SESSION"
echo ""

echo "--- Layer 3: Middleware overhead ---"
measure "GraphQL w/ operationName" ct "$API_DIRECT/graphql" -H 'Content-Type: application/json' -d '{"operationName":"serverConfig","query":"query serverConfig{serverConfig{version}}"}'
measure "GraphQL w/o operationName" ct "$API_DIRECT/graphql" -H 'Content-Type: application/json' -d '{"query":"query{serverConfig{version}}"}'
echo ""

echo "--- Layer 4: Concurrent load (5 parallel) ---"
echo -n "  5x parallel serverConfig:               "
START=$(date +%s%N)
for i in $(seq 5); do
  ct "$API_DIRECT/graphql" -H 'Content-Type: application/json' -d '{"query":"query{serverConfig{version}}"}' &
done
wait
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
echo "${ELAPSED_MS} ms total"
echo ""

echo "--- Environment ---"
LOG_LEVEL=$(docker compose -f "$REPO_ROOT/build/server/docker-compose.selfhost.yml" exec -T api printenv MYOXUS__LOGGING__LEVEL 2>/dev/null || echo "unknown")
echo "  Log level: $LOG_LEVEL"
if [ "$LOG_LEVEL" = "trace" ]; then
  printf "  ${RED}WARNING: trace = massive overhead from sqlx/tungstenite/axum${NC}\n"
  echo "  → set to 'info' for production, 'debug' for investigation"
fi

CONTAINER_MEM=$(docker stats --no-stream --format "{{.MemUsage}}" server-api-1 2>/dev/null || echo "?")
CONTAINER_CPU=$(docker stats --no-stream --format "{{.CPUPerc}}" server-api-1 2>/dev/null || echo "?")
echo "  API container: CPU=$CONTAINER_CPU  MEM=$CONTAINER_MEM"
echo ""

echo "--- Thresholds ---"
printf "  ${GRN}< 50ms${NC} = good    ${YLW}50-200ms${NC} = investigate    ${RED}> 200ms${NC} = problem\n"
