#!/usr/bin/env bash
# Checks for duplicate implementations:
# - pub async fn with identical names across application and infrastructure crates
# - reqwest::Client::new() calls that should use a shared HTTP client
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT/server"

echo "=== Checking for potential duplicate implementations ==="

echo ""
echo "--- pub async fn with identical names across crates ---"
grep -rn "^pub async fn " crates/{application,infrastructure}/src/ --include='*.rs' \
  | sed 's/.*:\(pub async fn [a-z_]*\).*/\1/' \
  | sort | uniq -d | head -20

echo ""
echo "--- reqwest::Client::new() calls (should use shared client) ---"
grep -rn "reqwest::Client::new()" crates/ --include='*.rs' | grep -v test | grep -v '#\[cfg(test' || true

echo ""
echo "=== Done ==="
