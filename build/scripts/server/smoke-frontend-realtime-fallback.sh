#!/usr/bin/env bash
set -euo pipefail

FRONTEND_BASE_URL="${FRONTEND_BASE_URL:-http://127.0.0.1:3010}"

check_status() {
  local name="$1"
  local code="$2"
  shift 2
  local allowed=("$@")
  for expected in "${allowed[@]}"; do
    if [[ "$code" == "$expected" ]]; then
      echo "[PASS] $name returned HTTP $code"
      return 0
    fi
  done
  echo "[FAIL] $name returned HTTP $code (allowed: ${allowed[*]})" >&2
  exit 1
}

echo "[INFO] Frontend base: $FRONTEND_BASE_URL"

invalid_poll_code="$(curl -sS -o /tmp/myoxus-rt-invalid-poll.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/socket.io/?EIO=4&transport=invalid")"
check_status "socket.io invalid transport" "$invalid_poll_code" 400

poll_code_1="$(curl -sS -o /tmp/myoxus-rt-poll-1.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/socket.io/?EIO=4&transport=polling")"
check_status "socket.io polling recovery run1" "$poll_code_1" 200

poll_code_2="$(curl -sS -o /tmp/myoxus-rt-poll-2.out -w '%{http_code}' \
  "$FRONTEND_BASE_URL/socket.io/?EIO=4&transport=polling")"
check_status "socket.io polling recovery run2" "$poll_code_2" 200

sse_url="$FRONTEND_BASE_URL/api/copilot/chat/00000000-0000-0000-0000-000000000000/stream-object?messageId=fallback"

curl -sS -N "$sse_url" > /tmp/myoxus-rt-sse-abort.out &
sse_pid=$!
sleep 0.2
kill "$sse_pid" 2>/dev/null || true
wait "$sse_pid" 2>/dev/null || true
echo "[PASS] copilot sse client-abort simulation"

sse_code="$(curl -sS -o /tmp/myoxus-rt-sse-recovery.out -w '%{http_code}' "$sse_url")"
check_status "copilot sse recovery after abort" "$sse_code" 200
if ! grep -q 'event: error' /tmp/myoxus-rt-sse-recovery.out; then
  echo "[FAIL] copilot sse recovery payload missing error event" >&2
  exit 1
fi

echo "[PASS] frontend realtime fallback smoke suite"
