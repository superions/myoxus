#!/usr/bin/env bash
# Admin frontend smoke test — verifies all admin pages load after a rebuild.
#
# Runs against the LIVE stack (requires stack-up.sh). Tests every admin
# GraphQL query and tRPC endpoint with an admin session. Catches:
# - SQL type mismatches (panics)
# - Missing fields/resolvers
# - Auth issues
# - Serialization errors
#
# Usage:
#   build/scripts/server/smoke-admin.sh
#
# Exit codes:
#   0 = all pages load correctly
#   1 = one or more pages failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib-auth-smoke.sh"

API="http://localhost:3001"
ADMIN_EMAIL="admin@myoxus.local"
ADMIN_PASS="AdminMyoxus2026"
PASS=0
FAIL=0

RED='\033[0;31m'
GRN='\033[0;32m'
NC='\033[0m'

# Login
SIGN_IN_ERR="$(mktemp)"
SESSION="$(smoke_admin_sign_in "$API" "$ADMIN_EMAIL" "$ADMIN_PASS" 2>"$SIGN_IN_ERR" || true)"

if [ -z "$SESSION" ]; then
  echo -e "${RED}FAIL${NC} Could not sign in as admin ($(cat "$SIGN_IN_ERR"))"
  rm -f "$SIGN_IN_ERR"
  exit 1
fi
rm -f "$SIGN_IN_ERR"

check_graphql() {
  local label="$1"
  local query="$2"

  local resp
  resp=$(curl -s -w "\n%{http_code}" "$API/graphql" \
    -H 'Content-Type: application/json' \
    -H "Cookie: affine_session=$SESSION" \
    -d "$query" 2>&1)

  local http_code
  http_code=$(echo "$resp" | tail -1)
  local body
  body=$(echo "$resp" | sed '$d')

  if [ "$http_code" != "200" ]; then
    echo -e "${RED}FAIL${NC} $label (HTTP $http_code)"
    FAIL=$((FAIL+1))
    return
  fi

  if echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('data') is not None and 'errors' not in d else 1)" 2>/dev/null; then
    echo -e "${GRN}PASS${NC} $label"
    PASS=$((PASS+1))
  else
    echo -e "${RED}FAIL${NC} $label (errors in response)"
    echo "  $body" | head -1
    FAIL=$((FAIL+1))
  fi
}

check_trpc() {
  local label="$1"
  local url="$2"

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" "$API$url" \
    -H "Cookie: affine_session=$SESSION" 2>&1)

  if [ "$http_code" = "200" ]; then
    echo -e "${GRN}PASS${NC} $label"
    PASS=$((PASS+1))
  else
    echo -e "${RED}FAIL${NC} $label (HTTP $http_code)"
    FAIL=$((FAIL+1))
  fi
}

echo "=== Admin Page Smoke Tests ==="
echo ""

# Dashboard
check_graphql "Dashboard" '{"query":"query { admin { adminDashboard { syncActiveUsers syncActiveUsersTimeline { minute activeUsers } syncWindow { from to timezone bucket requestedSize effectiveSize } copilotConversations workspaceStorageBytes blobStorageBytes workspaceStorageHistory { date value } blobStorageHistory { date value } storageWindow { from to timezone bucket requestedSize effectiveSize } generatedAt } } }"}'

# Workspaces
check_graphql "Workspaces list" '{"query":"query adminWorkspaces($filter: ListWorkspaceInput!) { admin { adminWorkspaces(filter: $filter) { id name owner { id name email } memberCount snapshotSize blobSize workspaceType gitSyncEnabled } } }","variables":{"filter":{"first":5}}}'
check_graphql "Workspaces count" '{"query":"query adminWorkspacesCount($filter: ListWorkspaceInput!) { admin { adminWorkspacesCount(filter: $filter) } }","variables":{"filter":{}}}'

# Users
check_graphql "Users list" '{"query":"query { users(filter: { first: 5 }) { id name email } }"}'
check_graphql "Users count" '{"query":"query { usersCount(filter: {}) }"}'

# Settings
check_graphql "Structured config" '{"query":"query { admin { adminConfigValues { revision modules { module } } } }"}'
check_graphql "serverConfig" '{"query":"query { serverConfig { version name type features initialized } }"}'

# Logging
check_graphql "Logging config" '{"query":"query { admin { loggingConfig { modules { group level } output { filePath rotation maxFiles pathValid } diskUsage { totalBytes fileCount freeBytes } } } }"}'

# Orphaned workspaces
check_graphql "Orphaned workspaces" '{"query":"query { orphanedWorkspaces(skip: 0, take: 5) { id name } }"}'

# Template Registry (must not crash even when disabled)
check_graphql "Template catalog" '{"query":"query { templateRegistry { templateCatalog { id title } templateCatalogCount } }"}'

# Queue tRPC
check_trpc "Queue list" "/api/queue/trpc/queue.list?batch=1&input=%7B%220%22%3A%7B%7D%7D"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
