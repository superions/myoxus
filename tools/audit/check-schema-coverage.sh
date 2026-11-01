#!/usr/bin/env bash
# Diffs client GraphQL operations against server resolver coverage.
# Prints all client-declared root operations and all server pub async fn
# in the graphql/ layer for manual comparison.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "=== Client GraphQL Operations ==="
find "$REPO_ROOT/client" -name "*.gql" -o -name "*.graphql" | \
  xargs grep -h "^query\|^mutation\|^subscription" 2>/dev/null | \
  sed 's/[({].*//' | sort -u | head -50

echo ""
echo "=== Server GraphQL Resolvers (pub async fn in graphql/) ==="
grep -rn "^  pub async fn\|^    pub async fn" \
  "$REPO_ROOT/server/crates/api/src/graphql/" --include='*.rs' | \
  sed 's/.*pub async fn \([a-z_]*\).*/\1/' | sort -u | head -50
