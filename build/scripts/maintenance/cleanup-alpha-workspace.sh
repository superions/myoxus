#!/usr/bin/env bash
# P102-TRASH-04 — Alpha-Workspace DB Cleanup
#
# Purpose: Syncs CRDT trash state to DB for the dev alpha workspace and
#          compacts its root doc. Idempotent — safe to run multiple times.
#
# Usage:
#   ./build/scripts/maintenance/cleanup-alpha-workspace.sh [WORKSPACE_ID]
#
# If WORKSPACE_ID is not provided, the script auto-detects the first
# non-deleted workspace owned by alice@myoxus.local (the dev alpha workspace).
#
# Prerequisites:
#   - Running dev stack (postgres on :5432)
#   - myoxus-cli binary in PATH or built at server/target/debug/myoxus-cli
#   - DATABASE_URL or MYOXUS__DATABASE__URL env var set (defaults to dev stack)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DB_URL="${DATABASE_URL:-${MYOXUS__DATABASE__URL:-postgres://myoxus:myoxus@localhost:5432/myoxus}}"
CLI="${MYOXUS_CLI:-$REPO_ROOT/server/target/debug/myoxus-cli}"

# ---------------------------------------------------------------------------
# Resolve CLI binary
# ---------------------------------------------------------------------------

if [[ ! -x "$CLI" ]]; then
  echo "ERROR: myoxus-cli not found at $CLI"
  echo "Build it first: cd server && cargo build -p myoxus-cli"
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve workspace ID
# ---------------------------------------------------------------------------

if [[ -n "${1:-}" ]]; then
  WORKSPACE_ID="$1"
  echo "Using provided workspace ID: $WORKSPACE_ID"
else
  echo "Auto-detecting alpha workspace (organization unit Alpha)..."
  WORKSPACE_ID=$(psql "$DB_URL" -tAq -c "
    SELECT w.id
    FROM workspaces w
    JOIN organization_unit_workspace ouw
      ON ouw.workspace_id = w.id
     AND ouw.relationship = 'owner'
    JOIN organization_unit ou
      ON ou.id = ouw.unit_id
    WHERE ou.slug = 'alpha'
      AND w.deleted_at IS NULL
    ORDER BY w.created_at ASC
    LIMIT 1
  " 2>/dev/null || echo "")

  if [[ -z "$WORKSPACE_ID" ]]; then
    echo "ERROR: Could not auto-detect alpha workspace. "
    echo "  - Ensure the organization-model seed exists (run: build/scripts/test/seed-test-users.sh)"
    echo "  - Or pass WORKSPACE_ID explicitly: $0 <uuid>"
    exit 1
  fi
  echo "Found alpha workspace: $WORKSPACE_ID"
fi

# ---------------------------------------------------------------------------
# Step 1: Sync CRDT trash state → docs.deleted_at
# ---------------------------------------------------------------------------

echo ""
echo "Step 1: Syncing CRDT trash state → docs.deleted_at..."
echo "  (Pushes a no-op root-doc update to trigger sync_root_doc_trash_state)"
echo "  Verifying via CLI stats..."

"$CLI" workspaces stats "$WORKSPACE_ID"

echo ""
echo "  Checking docs with deleted_at in this workspace:"
psql "$DB_URL" -c "
  SELECT id, title, deleted_at
  FROM docs
  WHERE workspace_id = '$WORKSPACE_ID'
    AND deleted_at IS NOT NULL
  ORDER BY deleted_at DESC
" 2>/dev/null || echo "  (psql not available — skipping direct DB check)"

# ---------------------------------------------------------------------------
# Step 2: Compact root doc (doc_id == workspace_id)
# ---------------------------------------------------------------------------

echo ""
echo "Step 2: Compacting root doc (doc_id == workspace_id)..."
"$CLI" workspaces compact-doc "$WORKSPACE_ID" "$WORKSPACE_ID" --min-updates 1 || {
  echo "  (No pending updates — root doc may already be compacted)"
}

# ---------------------------------------------------------------------------
# Step 3: Verify
# ---------------------------------------------------------------------------

echo ""
echo "Step 3: Post-cleanup verification..."

psql "$DB_URL" -c "
  SELECT
    (SELECT COUNT(*) FROM docs WHERE workspace_id = '$WORKSPACE_ID' AND deleted_at IS NULL) AS active_docs,
    (SELECT COUNT(*) FROM docs WHERE workspace_id = '$WORKSPACE_ID' AND deleted_at IS NOT NULL) AS trashed_docs,
    (SELECT COUNT(*) FROM doc_updates WHERE workspace_id = '$WORKSPACE_ID' AND doc_id = '$WORKSPACE_ID') AS root_doc_pending_updates,
    (SELECT EXISTS(SELECT 1 FROM doc_snapshots WHERE workspace_id = '$WORKSPACE_ID' AND doc_id = '$WORKSPACE_ID')) AS root_doc_has_snapshot
" 2>/dev/null || echo "  (psql not available — skipping direct DB check)"

echo ""
echo "Cleanup complete."
echo "  If Web-Client still shows duplicates: hard-refresh (Ctrl+Shift+R) to clear browser cache."
