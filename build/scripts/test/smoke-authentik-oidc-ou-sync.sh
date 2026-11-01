#!/usr/bin/env bash
# Authentik-compatible OIDC -> OU sync smoke gate.
#
# This script validates the versioned Authentik fixture matrix, starts the
# isolated Myoxus test infrastructure, and runs the server integration tests
# that drive Myoxus through real HTTP OIDC token/userinfo endpoints plus the
# SQLx-backed OU repositories. When MYOXUS_AUTHENTIK_DISCOVERY_URL is set, it
# also verifies that a live Authentik provider exposes the expected OIDC
# endpoint contract before the Myoxus tests run.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FIXTURE="$ROOT_DIR/server/crates/api/tests/fixtures/authentik_oidc_ou_matrix.json"
TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test}"

pass() { printf '  [PASS] %s\n' "$1"; }

echo "=== Myoxus Authentik OIDC OU Sync Smoke ==="
echo "Fixture: $FIXTURE"
echo ""

echo "1. Fixture matrix"
python3 - "$FIXTURE" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

groups = data.get("groups", [])
users = data.get("users", [])
counts = data.get("expectedCounts", {})
mapped = [group for group in groups if group.get("mapped")]

assert data.get("version") == 1, "fixture version must be 1"
assert len(groups) >= 10, "fixture must contain at least 10 groups"
assert len(users) >= 50, "fixture must contain at least 50 users"
assert len(groups) == counts.get("groups"), "group count drift"
assert len(users) == counts.get("users"), "user count drift"
assert len(mapped) == counts.get("mappedGroups"), "mapped group count drift"
assert any(group.get("role") == "reader" for group in mapped), "reader mapping missing"
assert any(group.get("role") == "member" for group in mapped), "member mapping missing"
assert any(group.get("role") == "manager" for group in mapped), "manager mapping missing"
assert any(not group.get("mapped") for group in groups), "unmapped provider group missing"
assert any(len(user.get("groups", [])) == 1 for user in users), "single-group user missing"
assert any(len(user.get("groups", [])) > 1 for user in users), "multi-group user missing"
assert any(user.get("expectedDenied") for user in users), "missing-groups deny user missing"

print("matrix-ok")
PY
pass "fixture matrix is structurally valid"
echo ""

if [ -n "${MYOXUS_AUTHENTIK_DISCOVERY_URL:-}" ]; then
  echo "2. Live Authentik discovery"
  DISCOVERY_JSON="$(curl -fsS "$MYOXUS_AUTHENTIK_DISCOVERY_URL")"
  DISCOVERY_JSON="$DISCOVERY_JSON" python3 - <<'PY'
import json
import os

data = json.loads(os.environ["DISCOVERY_JSON"])
required = {
    "authorization_endpoint": "/application/o/authorize/",
    "token_endpoint": "/application/o/token/",
    "userinfo_endpoint": "/application/o/userinfo/",
    "jwks_uri": "/jwks/",
}
for field, marker in required.items():
    value = data.get(field, "")
    assert marker in value, f"{field} does not look like an Authentik OIDC endpoint: {value}"
print("discovery-ok")
PY
  pass "live Authentik discovery exposes expected OIDC endpoints"
else
  echo "2. Live Authentik discovery"
  echo "  [SKIP] MYOXUS_AUTHENTIK_DISCOVERY_URL is not set"
fi
echo ""

echo "3. Isolated test infrastructure"
if [ "${MYOXUS_SKIP_TEST_STACK_UP:-0}" != "1" ]; then
  "$ROOT_DIR/build/scripts/test/stack-up.sh"
else
  echo "  [SKIP] stack-up disabled by MYOXUS_SKIP_TEST_STACK_UP=1"
fi
pass "test infrastructure ready"
echo ""

echo "4. OIDC/OU integration tests"
(
  cd "$ROOT_DIR/server"
  TEST_DATABASE_URL="$TEST_DATABASE_URL" cargo test -p myoxus-api oidc_ -- --test-threads=1
)
pass "OIDC/OU integration tests passed"
echo ""

echo "=== Authentik OIDC OU Sync Smoke: PASS ==="
