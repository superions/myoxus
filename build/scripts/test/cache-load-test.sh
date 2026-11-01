#!/usr/bin/env bash
# P84-H-28: Simple load test — 100 parallel serverConfig queries via curl.
# Usage: ./cache-load-test.sh [API_URL]
# Default API_URL: http://localhost:3001
set -euo pipefail

API_URL="${1:-http://localhost:3001}"
ENDPOINT="${API_URL}/graphql"
N=100

echo "Sending ${N} parallel serverConfig queries to ${ENDPOINT} ..."
PAYLOAD='{"query":"query { serverConfig { name version credentialsRequirement } }"}'

START=$(date +%s%N)
seq "$N" | xargs -P 20 -I{} \
  curl -sf -o /dev/null -w "%{http_code}\n" \
    -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
  | sort | uniq -c | while read -r count code; do
    echo "  HTTP ${code}: ${count} responses"
  done
END=$(date +%s%N)

ELAPSED_MS=$(( (END - START) / 1000000 ))
echo "Done. Total time: ${ELAPSED_MS}ms for ${N} requests."
