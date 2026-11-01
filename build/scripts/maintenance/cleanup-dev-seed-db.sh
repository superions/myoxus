#!/usr/bin/env bash
# Reset the local development database to the seed dataset without touching the
# isolated test database.
#
# Default mode is a dry-run. Use `--apply` only after reading the printed
# protection list and candidate counts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.selfhost.yml"
MODE="dry-run"

case "${1:-}" in
  ""|"--dry-run") MODE="dry-run" ;;
  "--apply") MODE="apply" ;;
  *)
    echo "Usage: $0 [--dry-run|--apply]" >&2
    exit 2
    ;;
esac

PSQL=(docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U "${POSTGRES_USER:-myoxus}" -d "${POSTGRES_DB:-myoxus}" -v ON_ERROR_STOP=1 -P pager=off)
CLI=(docker compose -f "$COMPOSE_FILE" exec -T api myoxus-cli)

report_sql() {
  cat <<'SQL'
WITH seed_users AS (
  SELECT id, email
    FROM users
   WHERE email IN ('admin@myoxus.local', 'alice@myoxus.local', 'bobby@myoxus.local')
),
seed_org_units AS (
  SELECT id, slug, name
    FROM organization_unit
   WHERE slug IN ('myoxus-organisation', 'alpha', 'beta')
),
protected_workspaces AS (
  SELECT DISTINCT w.id, w.name, COALESCE(ou.slug, u.email, '<unknown>') AS owner_key
    FROM workspaces w
    LEFT JOIN users u ON u.id = w.owner_user_id
    LEFT JOIN organization_unit_workspace ouw
      ON ouw.workspace_id = w.id
     AND ouw.relationship = 'owner'
    LEFT JOIN organization_unit ou ON ou.id = ouw.unit_id
   WHERE w.deleted_at IS NULL
     AND (
       u.email IN ('admin@myoxus.local', 'alice@myoxus.local', 'bobby@myoxus.local')
       OR ou.slug IN ('alpha', 'beta')
     )
     AND (
       w.name IN ('Myoxus Admin', 'Alice', 'Bobby', 'Alpha', 'Beta')
       OR ou.slug IN ('alpha', 'beta')
     )
),
unprotected_workspaces AS (
  SELECT w.id, w.name, u.email AS owner_email, w.created_at
    FROM workspaces w
    LEFT JOIN users u ON u.id = w.owner_user_id
   WHERE w.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM protected_workspaces p WHERE p.id = w.id)
),
protected_non_root_docs AS (
  SELECT d.id, d.workspace_id, w.name AS workspace_name, d.title, d.original_doc_id, d.created_at
    FROM docs d
    JOIN protected_workspaces w ON w.id = d.workspace_id
   WHERE d.deleted_at IS NULL
     AND NOT d.is_workspace_root
),
seed_userspace_docs AS (
  SELECT d.id, u.email, d.title, d.original_doc_id, d.created_at
    FROM docs d
    JOIN seed_users u ON u.id = d.userspace_owner_id
   WHERE d.deleted_at IS NULL
),
protected_instances AS (
  SELECT i.id, i.workspace_id, w.name AS workspace_name, c.slug, i.workspace_doc_id
    FROM workspace_template_instances i
    JOIN protected_workspaces w ON w.id = i.workspace_id
    JOIN template_catalog_entries c ON c.id = i.template_id
),
protected_root_payloads AS (
  SELECT p.id AS workspace_id, p.name AS workspace_name
    FROM protected_workspaces p
   WHERE EXISTS (
       SELECT 1 FROM doc_updates u
        WHERE u.workspace_id = p.id
          AND u.doc_id = p.id
     )
      OR EXISTS (
       SELECT 1 FROM doc_snapshots s
        WHERE s.workspace_id = p.id
          AND s.doc_id = p.id
     )
),
personal_seed_template_policies AS (
  SELECT p.id, w.name AS workspace_name
    FROM workspace_template_policies p
    JOIN workspaces w ON w.id = p.workspace_id
    JOIN seed_users u ON u.id = w.owner_user_id
   WHERE NOT EXISTS (
       SELECT 1
         FROM organization_unit_workspace ouw
        WHERE ouw.workspace_id = w.id
          AND ouw.relationship = 'owner'
   )
)
SELECT 'seed_users' AS section, COUNT(*)::text AS count, COALESCE(string_agg(email, ', ' ORDER BY email), '') AS details FROM seed_users
UNION ALL
SELECT 'seed_org_units', COUNT(*)::text, COALESCE(string_agg(slug, ', ' ORDER BY slug), '') FROM seed_org_units
UNION ALL
SELECT 'protected_workspaces', COUNT(*)::text, COALESCE(string_agg(name || ' [' || owner_key || ']', ', ' ORDER BY name), '') FROM protected_workspaces
UNION ALL
SELECT 'unprotected_workspaces_to_delete', COUNT(*)::text, COALESCE(string_agg(name || ' ' || id::text, ', ' ORDER BY created_at), '') FROM unprotected_workspaces
UNION ALL
SELECT 'protected_non_root_docs_to_delete', COUNT(*)::text, COALESCE((
  SELECT string_agg(workspace_name || '=' || docs::text, ', ' ORDER BY workspace_name)
    FROM (
      SELECT workspace_name, COUNT(*) AS docs
        FROM protected_non_root_docs
       GROUP BY workspace_name
    ) grouped
), '') FROM protected_non_root_docs
UNION ALL
SELECT 'seed_userspace_docs_to_delete', COUNT(*)::text, COALESCE((
  SELECT string_agg(email || '=' || docs::text, ', ' ORDER BY email)
    FROM (
      SELECT email, COUNT(*) AS docs
        FROM seed_userspace_docs
       GROUP BY email
    ) grouped
), '') FROM seed_userspace_docs
UNION ALL
SELECT 'protected_template_instances_to_reset', COUNT(*)::text, COALESCE(string_agg(workspace_name || ':' || slug, ', ' ORDER BY workspace_name, slug), '') FROM protected_instances
UNION ALL
SELECT 'protected_root_doc_payloads_present', COUNT(*)::text, COALESCE(string_agg(workspace_name || ' ' || workspace_id::text, ', ' ORDER BY workspace_name), '') FROM protected_root_payloads
UNION ALL
SELECT 'personal_template_policies_to_delete', COUNT(*)::text, COALESCE((
  SELECT string_agg(workspace_name || '=' || policies::text, ', ' ORDER BY workspace_name)
    FROM (
      SELECT workspace_name, COUNT(*) AS policies
        FROM personal_seed_template_policies
       GROUP BY workspace_name
    ) grouped
), '') FROM personal_seed_template_policies;
SQL
}

apply_sql() {
  cat <<'SQL'
BEGIN;

WITH seed_users AS (
  SELECT id, email
    FROM users
   WHERE email IN ('admin@myoxus.local', 'alice@myoxus.local', 'bobby@myoxus.local')
),
protected_workspaces AS (
  SELECT DISTINCT w.id
    FROM workspaces w
    LEFT JOIN users u ON u.id = w.owner_user_id
    LEFT JOIN organization_unit_workspace ouw
      ON ouw.workspace_id = w.id
     AND ouw.relationship = 'owner'
    LEFT JOIN organization_unit ou ON ou.id = ouw.unit_id
   WHERE w.deleted_at IS NULL
     AND (
       u.email IN ('admin@myoxus.local', 'alice@myoxus.local', 'bobby@myoxus.local')
       OR ou.slug IN ('alpha', 'beta')
     )
     AND (
       w.name IN ('Myoxus Admin', 'Alice', 'Bobby', 'Alpha', 'Beta')
       OR ou.slug IN ('alpha', 'beta')
     )
),
deleted_instances AS (
  DELETE FROM workspace_template_instances i
   USING protected_workspaces p
   WHERE i.workspace_id = p.id
   RETURNING i.id
),
deleted_doc_updates AS (
  DELETE FROM doc_updates u
   USING protected_workspaces p
   WHERE u.workspace_id = p.id
   RETURNING u.id
),
deleted_doc_snapshots AS (
  DELETE FROM doc_snapshots s
   USING protected_workspaces p
   WHERE s.workspace_id = p.id
   RETURNING s.doc_id
),
deleted_workspace_docs AS (
  DELETE FROM docs d
   USING protected_workspaces p
   WHERE d.workspace_id = p.id
     AND NOT d.is_workspace_root
   RETURNING d.id
),
deleted_userspace_docs AS (
  DELETE FROM docs d
   USING seed_users u
   WHERE d.userspace_owner_id = u.id
   RETURNING d.id
),
deleted_personal_template_policies AS (
  DELETE FROM workspace_template_policies p
   USING workspaces w, seed_users u
   WHERE p.workspace_id = w.id
     AND w.owner_user_id = u.id
     AND NOT EXISTS (
       SELECT 1
         FROM organization_unit_workspace ouw
        WHERE ouw.workspace_id = w.id
          AND ouw.relationship = 'owner'
     )
   RETURNING p.id
),
unprotected_workspaces AS (
  SELECT w.id
    FROM workspaces w
   WHERE w.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM protected_workspaces p WHERE p.id = w.id)
),
deleted_unprotected_workspaces AS (
  DELETE FROM workspaces w
   USING unprotected_workspaces u
   WHERE w.id = u.id
   RETURNING w.id
)
SELECT 'deleted_template_instances' AS action, COUNT(*)::bigint AS rows FROM deleted_instances
UNION ALL
SELECT 'deleted_protected_doc_updates', COUNT(*)::bigint FROM deleted_doc_updates
UNION ALL
SELECT 'deleted_protected_doc_snapshots', COUNT(*)::bigint FROM deleted_doc_snapshots
UNION ALL
SELECT 'deleted_protected_non_root_docs', COUNT(*)::bigint FROM deleted_workspace_docs
UNION ALL
SELECT 'deleted_seed_userspace_docs', COUNT(*)::bigint FROM deleted_userspace_docs
UNION ALL
SELECT 'deleted_personal_template_policies', COUNT(*)::bigint FROM deleted_personal_template_policies
UNION ALL
SELECT 'deleted_unprotected_workspaces', COUNT(*)::bigint FROM deleted_unprotected_workspaces;

COMMIT;
SQL
}

protected_workspace_rows_sql() {
  cat <<'SQL'
WITH seed_users AS (
  SELECT id, email
    FROM users
   WHERE email IN ('admin@myoxus.local', 'alice@myoxus.local', 'bobby@myoxus.local')
),
protected_workspaces AS (
  SELECT DISTINCT w.id, w.name
    FROM workspaces w
    LEFT JOIN users u ON u.id = w.owner_user_id
    LEFT JOIN organization_unit_workspace ouw
      ON ouw.workspace_id = w.id
     AND ouw.relationship = 'owner'
    LEFT JOIN organization_unit ou ON ou.id = ouw.unit_id
   WHERE w.deleted_at IS NULL
     AND (
       u.email IN ('admin@myoxus.local', 'alice@myoxus.local', 'bobby@myoxus.local')
       OR ou.slug IN ('alpha', 'beta')
     )
     AND (
       w.name IN ('Myoxus Admin', 'Alice', 'Bobby', 'Alpha', 'Beta')
       OR ou.slug IN ('alpha', 'beta')
     )
)
SELECT id::text || '|' || name
  FROM protected_workspaces
 ORDER BY name;
SQL
}

reseed_protected_root_docs() {
  echo
  echo "Reseeding protected workspace root docs..."
  local rows
  rows="$("${PSQL[@]}" -tA < <(protected_workspace_rows_sql))"
  if [[ -z "$rows" ]]; then
    echo "  No protected workspaces found."
    return
  fi
  while IFS='|' read -r workspace_id workspace_name; do
    [[ -z "$workspace_id" ]] && continue
    echo "  - $workspace_name ($workspace_id)"
    "${CLI[@]}" workspaces seed-root-doc "$workspace_id" </dev/null
  done <<< "$rows"
}

echo "Mode: $MODE"
echo
echo "Dry-run report / protection list"
"${PSQL[@]}" < <(report_sql)

if [[ "$MODE" != "apply" ]]; then
  echo
  echo "No changes written. Re-run with --apply after reviewing the report."
  exit 0
fi

echo
echo "Applying cleanup..."
"${PSQL[@]}" < <(apply_sql)
reseed_protected_root_docs

echo
echo "Post-cleanup report"
"${PSQL[@]}" < <(report_sql)
