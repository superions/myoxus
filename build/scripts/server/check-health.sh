#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${MYOXUS_BASE_URL:-http://127.0.0.1:3001}"
ENDPOINT="${1:-ready}"

case "$ENDPOINT" in
  health|ready|live|metrics) ;;
  *)
    echo "Unsupported endpoint '$ENDPOINT' (allowed: health|ready|live|metrics)" >&2
    exit 2
    ;;
esac

curl -fsS "$BASE_URL/$ENDPOINT"
