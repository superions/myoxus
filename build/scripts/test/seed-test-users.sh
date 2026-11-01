#!/usr/bin/env bash
# Provision the standard manual-test dataset for Myoxus.
#
# Creates three users (admin, Alice, Bobby), personal workspaces, two
# organization units (Alpha, Beta) with matching OU-owned workspaces, and
# five deliberately varied complex manual-test documents in every active
# workspace, plus a server-backed Database QA board for visual
# table/list/kanban/gallery/calendar/timeline checks.
# Idempotent: safe to run multiple times against the same database.
#
# Prerequisites:
#   - PostgreSQL container healthy  (build/scripts/server/stack-up.sh)
#   - Running API container with `myoxus-cli`, or a local Rust toolchain able
#     to build `myoxus-cli`.
#   - Optional: MYOXUS_SEED_CLI_MODE=local forces the local Rust CLI even when
#     an API container is running; MYOXUS_SEED_CLI_MODE=container requires the
#     container CLI.
#   - MYOXUS_SEED_CLI_BIN selects an existing local CLI executable, avoiding a
#     rebuild when operating a revision-bound native development instance.
#
# Usage (from anywhere in the repo):
#   build/scripts/test/seed-test-users.sh
#
# Credentials provisioned:
#   Admin:  admin@myoxus.local  /  AdminMyoxus2026
#   Alice:  alice@myoxus.local  /  AliceMyoxus2026
#   Bobby:  bobby@myoxus.local  /  BobbyMyoxus2026
#
# Organization model:
#   Myoxus Organisation
#     ├─ Alpha — admin as manager, Alice as member, workspace "Alpha"
#     └─ Beta  — admin as manager, Bobby as member, workspace "Beta"
#
# All credentials are for LOCAL DEVELOPMENT ONLY.  Never use in production.

set -euo pipefail

# Passwords are intentionally provisioned below for the local-only fixture.
# Disable caller-supplied xtrace before any credential-bearing command can be
# expanded; otherwise `bash -x` would defeat the argv-safe stdin transport.
if [[ $- == *x* ]]; then
    set +x
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/build/server/docker-compose.selfhost.yml"
PSQL=(docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U "${POSTGRES_USER:-myoxus}" -d "${POSTGRES_DB:-myoxus}")
CLI_MODE="${MYOXUS_SEED_CLI_MODE:-auto}"
SEED_DOC_DIR="$REPO_ROOT/build/fixtures/seed-documents/complex"
SEED_DOC_CONTAINER_DIR="/tmp/seed-documents/complex"
SEED_DOC_PREFIX="manual-test-complex-v1"
SEED_DOC_CONTENT_VERSION="4"

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC}  $*"; }
info() { echo -e "${YELLOW}[..]${NC}  $*"; }
fail() { echo -e "${RED}[!!]${NC}  $*" >&2; }

if [[ "$CLI_MODE" != "local" ]] \
    && docker compose -f "$COMPOSE_FILE" ps -q api >/dev/null 2>&1 \
    && docker compose -f "$COMPOSE_FILE" exec -T api myoxus-cli --version >/dev/null 2>&1; then
    CLI=(docker compose -f "$COMPOSE_FILE" exec -T api myoxus-cli)
    CLI_RUNS_IN_API_CONTAINER=true
else
    if [[ "$CLI_MODE" == "container" ]]; then
        fail "MYOXUS_SEED_CLI_MODE=container was requested but no usable API-container myoxus-cli was found"
        exit 1
    fi
    if [[ -z "${MYOXUS__DATABASE__URL:-}" ]]; then
        postgres_password="${POSTGRES_PASSWORD:-}"
        postgres_password_file="${MYOXUS_POSTGRES_PASSWORD_FILE:-$REPO_ROOT/build/server/runtime-secrets/postgres_password}"
        if [[ -z "$postgres_password" && -r "$postgres_password_file" ]]; then
            postgres_password="$(<"$postgres_password_file")"
        fi
        postgres_password="${postgres_password:-myoxus}"
        export MYOXUS__DATABASE__URL="postgres://${POSTGRES_USER:-myoxus}:${postgres_password}@127.0.0.1:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-myoxus}"
        unset postgres_password
    fi
    if [[ -n "${MYOXUS_SEED_CLI_BIN:-}" ]]; then
        if [[ ! -f "$MYOXUS_SEED_CLI_BIN" || ! -x "$MYOXUS_SEED_CLI_BIN" ]]; then
            fail "MYOXUS_SEED_CLI_BIN must select an executable local CLI"
            exit 1
        fi
        CLI=("$MYOXUS_SEED_CLI_BIN")
    else
        CLI=(cargo run -q --manifest-path Cargo.toml -p myoxus-cli --)
    fi
    CLI_RUNS_IN_API_CONTAINER=false
fi

run_cli() {
    if [[ "$CLI_RUNS_IN_API_CONTAINER" == "true" ]]; then
        "${CLI[@]}" "$@"
    else
        (
            cd "$REPO_ROOT/server"
            "${CLI[@]}" "$@"
        )
    fi
}

# ---------------------------------------------------------------------------
# Helper: run CLI command, only suppress stderr for "already exists" cases
# ---------------------------------------------------------------------------
cli_idempotent() {
    # Run command; if it fails with exit ≠ 0, print error but continue.
    if ! "$@" 2>/tmp/seed_err; then
        local msg
        msg="$(cat /tmp/seed_err)"
        # Treat "already exists" / "duplicate" errors as success.
        if echo "$msg" | grep -qiE "(already exists|duplicate|conflict)"; then
            return 0
        fi
        fail "Command failed: $*"
        fail "  → $msg"
        return 1
    fi
}

set_seed_password() {
    local identity="$1"
    local password="$2"
    printf '%s\n' "$password" \
        | run_cli users set-password "$identity" --password-stdin >/dev/null
}

psql_exec() {
    "${PSQL[@]}" -v ON_ERROR_STOP=1 "$@"
}

get_user_id() {
    run_cli users get "$1" --json 2>/dev/null \
        | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -1
}

sync_seed_documents_to_api_container() {
    [[ "$CLI_RUNS_IN_API_CONTAINER" == "true" ]] || return 0

    info "Copying complex seed document fixtures into the API container..."
    # Copy the named parent into existing /tmp; repeated copies merge at the
    # same path. Import uses the explicit source list, not stale directory files.
    docker compose -f "$COMPOSE_FILE" cp "$REPO_ROOT/build/fixtures/seed-documents" api:/tmp >/dev/null
}

seed_complex_documents() {
    if [[ ! -d "$SEED_DOC_DIR" ]]; then
        fail "Complex seed document directory is missing: $SEED_DOC_DIR"
        exit 1
    fi

    local seed_source_files=()
    local source_file
    while IFS= read -r source_file; do
        seed_source_files+=("$source_file")
    done < <(find "$SEED_DOC_DIR" -maxdepth 1 -type f -name '*.md' | sort)

    if [[ "${#seed_source_files[@]}" -lt 5 ]]; then
        fail "Expected at least five complex seed documents in $SEED_DOC_DIR"
        exit 1
    fi

    sync_seed_documents_to_api_container

    local seed_cli_files=()
    local seed_storage_root
    if [[ "$CLI_RUNS_IN_API_CONTAINER" == "true" ]]; then
        seed_storage_root="${MYOXUS__STORAGE__ROOT:-${MYOXUS_STORAGE_ROOT:-/opt/myoxus/data/storage}}"
        for source_file in "${seed_source_files[@]}"; do
            seed_cli_files+=("$SEED_DOC_CONTAINER_DIR/$(basename "$source_file")")
        done
    else
        seed_storage_root="${MYOXUS__STORAGE__ROOT:-${MYOXUS_STORAGE_ROOT:-$REPO_ROOT/build/server/data/storage}}"
        seed_cli_files=("${seed_source_files[@]}")
    fi

    info "Seeding ${#seed_cli_files[@]} complex test documents into every active workspace..."
    local workspace_count=0
    local workspace_id workspace_name user_email
    while IFS='|' read -r workspace_id workspace_name user_email; do
        [[ -n "$workspace_id" ]] || continue
        workspace_count=$((workspace_count + 1))
        info "  Workspace ${workspace_name:-$workspace_id} ($workspace_id) via $user_email"
        run_cli import-file \
            --user "$user_email" \
            --workspace "$workspace_id" \
            --seed-key-prefix "$SEED_DOC_PREFIX" \
            --storage-root "$seed_storage_root" \
            "${seed_cli_files[@]}" </dev/null >/dev/null
    done < <(
        psql_exec -At -F '|' <<'SQL'
SELECT DISTINCT ON (w.id)
       w.id::text,
       COALESCE(NULLIF(replace(replace(w.name, E'\n', ' '), '|', '/'), ''), w.id::text) AS workspace_name,
       u.email
  FROM workspaces w
  JOIN workspace_memberships wm
    ON wm.workspace_id = w.id
   AND wm.status = 'Accepted'
  JOIN users u
    ON u.id = wm.user_id
 WHERE w.deleted_at IS NULL
 ORDER BY w.id,
          CASE wm.role::text
            WHEN 'Owner' THEN 0
            WHEN 'Admin' THEN 1
            WHEN 'Collaborator' THEN 2
            ELSE 3
          END,
          u.email;
SQL
    )

    if [[ "$workspace_count" -eq 0 ]]; then
        fail "No active workspaces with accepted members found for complex document seeding"
        exit 1
    fi

    ok "Complex seed documents checked for $workspace_count active workspace(s)"
}

seed_database_qa_board() {
    info "Seeding Database QA boards into every active workspace..."
    psql_exec -P pager=off <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.myoxus_seed_uuid(seed text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (
    substr(md5(seed), 1, 8) || '-' ||
    substr(md5(seed), 9, 4) || '-' ||
    substr(md5(seed), 13, 4) || '-' ||
    substr(md5(seed), 17, 4) || '-' ||
    substr(md5(seed), 21, 12)
  )::uuid;
$$;

CREATE OR REPLACE FUNCTION pg_temp.myoxus_seed_database_view_config(
    view_kind text,
    config jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF view_kind = 'table' AND (
        NOT (config ? 'searchFieldIds') OR
        jsonb_array_length(config->'searchFieldIds') = 0
    ) THEN
        RAISE EXCEPTION 'Database QA board contains a non-canonical table config';
    END IF;
    IF view_kind = 'timeline' AND (
        config ? 'dateFieldId' OR
        NOT (config ? 'startFieldId') OR
        NOT (config ? 'endFieldId') OR
        NOT (config ? 'zoom')
    ) THEN
        RAISE EXCEPTION 'Database QA board contains a non-canonical timeline config';
    END IF;
    IF view_kind = 'gantt' AND (
        NOT (config ? 'startFieldId') OR
        NOT (config ? 'endFieldId') OR
        NOT (config ? 'dependencyFieldId') OR
        NOT (config ? 'zoom')
    ) THEN
        RAISE EXCEPTION 'Database QA board contains a non-canonical gantt config';
    END IF;
    RETURN config;
END;
$$;

DO $$
DECLARE
    v_admin uuid;
    v_workspace record;
    v_database_id uuid;
    v_title_field_id uuid;
    v_status_field_id uuid;
    v_due_field_id uuid;
    v_notes_field_id uuid;
    v_score_field_id uuid;
    v_progress_field_id uuid;
    v_reference_field_id uuid;
    v_tags_field_id uuid;
    v_dependency_field_id uuid;
    v_priority_tag_id uuid;
    v_critical_tag_id uuid;
    v_release_tag_id uuid;
    v_row record;
    v_row_id uuid;
BEGIN
    SELECT id INTO v_admin
      FROM users
     WHERE email = 'admin@myoxus.local'
     LIMIT 1;
    IF v_admin IS NULL THEN
        RAISE EXCEPTION 'admin@myoxus.local is missing; run user seeding first';
    END IF;

    FOR v_workspace IN
        SELECT w.id, COALESCE(NULLIF(w.name, ''), w.id::text) AS name
          FROM workspaces w
         WHERE w.deleted_at IS NULL
         ORDER BY w.name, w.id
    LOOP
        v_database_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:database');
        v_title_field_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:field:title');
        v_status_field_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:field:status');
        v_due_field_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:field:due');
        v_notes_field_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:field:notes');
        v_score_field_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:field:score');
        v_progress_field_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:field:progress');
        v_reference_field_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:field:reference');
        v_tags_field_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:field:tags');
        v_dependency_field_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:field:dependency');
        v_priority_tag_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:tag:priority');
        v_critical_tag_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:tag:critical');
        v_release_tag_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:tag:release');

        INSERT INTO workspace_tags (
            id, workspace_id, name, slug, color_role, description, created_by, updated_by
        ) VALUES
          (v_priority_tag_id, v_workspace.id, 'Priority', 'database-qa-priority', 'tag.red',
           'Seeded Database QA tag for single- and multi-tag visual states.', v_admin, v_admin),
          (v_critical_tag_id, v_workspace.id, 'Critical', 'database-qa-critical', 'tag.red',
           'Seeded Database QA tag for repeated-color accent visual states.', v_admin, v_admin),
          (v_release_tag_id, v_workspace.id, 'Release', 'database-qa-release', 'tag.blue',
           'Seeded Database QA tag for deterministic mixed card accents.', v_admin, v_admin)
        ON CONFLICT (id) DO UPDATE
          SET workspace_id = EXCLUDED.workspace_id,
              name = EXCLUDED.name,
              slug = EXCLUDED.slug,
              color_role = EXCLUDED.color_role,
              description = EXCLUDED.description,
              archived_at = NULL,
              updated_by = EXCLUDED.updated_by,
              updated_at = now();

        INSERT INTO workspace_databases (
            id, workspace_id, title, description, created_by, updated_by
        ) VALUES (
            v_database_id,
            v_workspace.id,
            'Database QA Board',
            'Seeded manual QA board with table, kanban, gallery, calendar, timeline and progress views.',
            v_admin,
            v_admin
        )
        ON CONFLICT (id) DO UPDATE
          SET workspace_id = EXCLUDED.workspace_id,
              title = EXCLUDED.title,
              description = EXCLUDED.description,
              updated_by = EXCLUDED.updated_by,
              updated_at = now();

        INSERT INTO workspace_database_fields (
            id, database_id, name, field_type, config_json, position, required
        ) VALUES
          (v_title_field_id, v_database_id, 'Title', 'title',
           jsonb_build_object('kind', 'title'), 0, true),
          (v_status_field_id, v_database_id, 'Status', 'select',
           jsonb_build_object(
             'kind', 'select',
             'options', jsonb_build_array(
               jsonb_build_object('id', 'todo', 'name', 'To do', 'position', 0, 'colorRole', 'blue'),
               jsonb_build_object('id', 'progress', 'name', 'In progress', 'position', 1, 'colorRole', 'orange'),
               jsonb_build_object('id', 'done', 'name', 'Done', 'position', 2, 'colorRole', 'green')
             )
           ), 1, false),
          (v_due_field_id, v_database_id, 'Due', 'date_time',
           jsonb_build_object(
             'kind', 'date_time',
             'defaultTimeZone', 'Europe/Berlin',
             'allowReminders', true
           ), 2, false),
          (v_notes_field_id, v_database_id, 'Notes', 'text',
           jsonb_build_object('kind', 'text', 'multiline', true), 3, true),
          (v_score_field_id, v_database_id, 'Score', 'number',
           jsonb_build_object('kind', 'number', 'format', 'decimal'), 4, false),
          (v_progress_field_id, v_database_id, 'Progress', 'percent',
           jsonb_build_object('kind', 'percent', 'minValue', 0, 'maxValue', 100), 5, false),
          (v_reference_field_id, v_database_id, 'Reference', 'url',
           jsonb_build_object('kind', 'url'), 6, false),
          (v_tags_field_id, v_database_id, 'Tags', 'tags',
           jsonb_build_object('kind', 'tags', 'maxCount', NULL), 7, false),
          (v_dependency_field_id, v_database_id, 'Depends on', 'relation',
           jsonb_build_object(
             'kind', 'relation',
             'targetDatabaseId', v_database_id::text,
             'allowMultiple', true,
             'reciprocalFieldId', NULL,
             'maxTargets', NULL
           ), 8, false)
        ON CONFLICT (id) DO UPDATE
          SET database_id = EXCLUDED.database_id,
              name = EXCLUDED.name,
              field_type = EXCLUDED.field_type,
              config_json = EXCLUDED.config_json,
              position = EXCLUDED.position,
              required = EXCLUDED.required,
              updated_at = now();

        INSERT INTO workspace_database_views (
            id, database_id, name, view_kind, config_json, position
        ) VALUES
          (
            pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:view:table'),
            v_database_id,
            'Table',
            'table',
            pg_temp.myoxus_seed_database_view_config('table', jsonb_build_object(
              'kind', 'table',
              'sort', jsonb_build_array(),
              'filter', jsonb_build_array(),
              'filterTree', NULL,
              'group', NULL,
              'subgroup', NULL,
              'titleFieldId', v_title_field_id::text,
              'searchFieldIds', jsonb_build_array(
                v_title_field_id::text,
                v_notes_field_id::text,
                v_reference_field_id::text
              ),
              'visibleFieldIds', jsonb_build_array(
                v_status_field_id::text,
                v_due_field_id::text,
                v_notes_field_id::text,
                v_score_field_id::text,
                v_progress_field_id::text,
                v_reference_field_id::text,
                v_tags_field_id::text
              ),
              'fieldWidths', jsonb_build_object(
                v_status_field_id::text, 160,
                v_due_field_id::text, 160,
                v_notes_field_id::text, 280,
                v_score_field_id::text, 120,
                v_progress_field_id::text, 140,
                v_reference_field_id::text, 180
              )
            )),
            0
          ),
          (
            pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:view:list'),
            v_database_id,
            'List',
            'list',
            jsonb_build_object(
              'kind', 'list',
              'sort', jsonb_build_array(),
              'filter', jsonb_build_array(),
              'filterTree', NULL,
              'group', NULL,
              'subgroup', NULL,
              'density', 'default',
              'titleFieldId', v_title_field_id::text,
              'showFieldLabels', true,
              'visibleFieldIds', jsonb_build_array(
                v_status_field_id::text,
                v_due_field_id::text,
                v_notes_field_id::text,
                v_score_field_id::text,
                v_progress_field_id::text,
                v_reference_field_id::text,
                v_tags_field_id::text
              )
            ),
            1
          ),
          (
            pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:view:kanban'),
            v_database_id,
            'Kanban',
            'kanban',
            jsonb_build_object(
              'kind', 'kanban',
              'sort', jsonb_build_array(),
              'filter', jsonb_build_array(),
              'filterTree', NULL,
              'coverFieldId', NULL,
              'cardDensity', 'default',
              'groupFieldId', v_status_field_id::text,
              'titleFieldId', v_title_field_id::text,
              'visibleFieldIds', jsonb_build_array(
                v_due_field_id::text,
                v_notes_field_id::text,
                v_tags_field_id::text
              )
            ),
            2
          ),
          (
            pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:view:gallery'),
            v_database_id,
            'Gallery',
            'gallery',
            jsonb_build_object(
              'kind', 'gallery',
              'sort', jsonb_build_array(),
              'filter', jsonb_build_array(),
              'filterTree', NULL,
              'group', NULL,
              'subgroup', NULL,
              'cardDensity', 'default',
              'coverFieldId', NULL,
              'titleFieldId', v_title_field_id::text,
              'showEmptyCover', true,
              'visibleFieldIds', jsonb_build_array(
                v_status_field_id::text,
                v_due_field_id::text,
                v_notes_field_id::text,
                v_score_field_id::text,
                v_progress_field_id::text
              )
            ),
            3
          ),
          (
            pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:view:calendar'),
            v_database_id,
            'Calendar',
            'calendar',
            jsonb_build_object(
              'kind', 'calendar',
              'sort', jsonb_build_array(),
              'filter', jsonb_build_array(),
              'filterTree', NULL,
              'group', NULL,
              'subgroup', NULL,
              'dateMode', 'month',
              'dateFieldId', v_due_field_id::text,
              'initialRange', 'current_month',
              'titleFieldId', v_title_field_id::text,
              'visibleFieldIds', jsonb_build_array(
                v_status_field_id::text,
                v_notes_field_id::text,
                v_score_field_id::text,
                v_progress_field_id::text
              )
            ),
            4
          ),
          (
            pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:view:timeline'),
            v_database_id,
            'Timeline',
            'timeline',
            pg_temp.myoxus_seed_database_view_config('timeline', jsonb_build_object(
              'kind', 'timeline',
              'sort', jsonb_build_array(),
              'filter', jsonb_build_array(),
              'filterTree', NULL,
              'order', 'asc',
              'groupBy', 'month',
              'startFieldId', v_due_field_id::text,
              'endFieldId', NULL,
              'zoom', 'month',
              'titleFieldId', v_title_field_id::text,
              'visibleFieldIds', jsonb_build_array(
                v_status_field_id::text,
                v_notes_field_id::text,
                v_score_field_id::text,
                v_progress_field_id::text
              )
            )),
            5
          ),
          (
            pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:view:progress'),
            v_database_id,
            'Progress',
            'progress',
            jsonb_build_object(
              'kind', 'progress',
              'sort', jsonb_build_array(),
              'filter', jsonb_build_array(),
              'filterTree', NULL,
              'groupFieldId', v_status_field_id::text,
              'progressFieldId', v_progress_field_id::text,
              'titleFieldId', v_title_field_id::text,
              'visibleFieldIds', jsonb_build_array(
                v_status_field_id::text,
                v_due_field_id::text,
                v_notes_field_id::text,
                v_progress_field_id::text
              )
            ),
            6
          ),
          (
            pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:view:gantt'),
            v_database_id,
            'Gantt',
            'gantt',
            pg_temp.myoxus_seed_database_view_config('gantt', jsonb_build_object(
              'kind', 'gantt',
              'sort', jsonb_build_array(),
              'filter', jsonb_build_array(),
              'filterTree', NULL,
              'group', jsonb_build_object(
                'fieldId', v_status_field_id::text,
                'descending', false,
                'showEmptyGroups', true
              ),
              'startFieldId', v_due_field_id::text,
              'endFieldId', NULL,
              'dependencyFieldId', v_dependency_field_id::text,
              'zoom', 'month',
              'titleFieldId', v_title_field_id::text,
              'visibleFieldIds', jsonb_build_array(
                v_status_field_id::text,
                v_notes_field_id::text,
                v_score_field_id::text,
                v_progress_field_id::text
              )
            )),
            7
          )
        ON CONFLICT (id) DO UPDATE
          SET database_id = EXCLUDED.database_id,
              name = EXCLUDED.name,
              view_kind = EXCLUDED.view_kind,
              config_json = EXCLUDED.config_json,
              position = EXCLUDED.position,
              updated_at = now();

        FOR v_row IN
            SELECT *
              FROM (VALUES
                ('todo-1', 'Scope database editing', 'todo', '2026-07-06T07:00:00Z', NULL, true, 'Europe/Berlin', 'Create fields, rename headers and verify inline row editing.', 31, 10, 'https://example.com/db/scope', 0, 0),
                ('todo-2', 'Import sample CSV', 'todo', '2026-07-07T08:30:00Z', NULL, false, 'Europe/Berlin', 'Preview detected column types before applying the import.', 42, 20, 'https://example.com/db/import', 1, 1),
                ('todo-3', 'Review relation fields', 'todo', '2026-07-08T09:00:00Z', '2026-07-10T16:00:00Z', false, 'Europe/Berlin', 'Check relation and lookup behavior against linked documents.', 53, 30, 'https://example.com/db/relations', 2, 2),
                ('progress-1', 'Polish table UX', 'progress', '2026-07-09T12:00:00Z', NULL, false, 'UTC', 'Validate add-row, add-field and direct cell editing controls.', 64, 45, 'https://example.com/db/table', 3, 3),
                ('progress-2', 'Kanban drag QA', 'progress', '2026-07-10T07:00:00Z', '2026-07-10T15:00:00Z', false, 'Europe/Berlin', 'Move cards within and across status columns and verify persistence.', 75, 60, 'https://example.com/db/kanban', 4, 2),
                ('progress-3', 'Gallery card QA', 'progress', '2026-07-11T07:00:00Z', NULL, true, 'Europe/Berlin', 'Check compact cards, visible fields and row action menus.', 86, 75, 'https://example.com/db/gallery', 5, 0),
                ('done-1', 'Calendar smoke', 'done', '2026-07-12T10:00:00Z', '2026-07-12T11:30:00Z', false, 'Europe/Berlin', 'Confirm due-date placement in the month view.', 97, 100, 'https://example.com/db/calendar', 6, 1),
                ('done-2', 'Timeline smoke', 'done', '2026-07-13T07:00:00Z', NULL, true, 'Europe/Berlin', 'Confirm date grouping and row action affordances.', 108, 100, 'https://example.com/db/timeline', 7, 2),
                ('done-3', 'Automation panel smoke', 'done', '2026-07-14T13:00:00Z', NULL, false, 'Europe/Berlin', 'Verify the database automations panel renders next to editor views.', 119, 100, 'https://example.com/db/automation', 8, 0)
              ) AS rows(row_key, title, status_value, due_start, due_end, due_all_day, due_time_zone, notes, score, progress_value, reference_url, row_position, tag_state)
        LOOP
            v_row_id := pg_temp.myoxus_seed_uuid(v_workspace.id::text || ':database-qa-board:row:' || v_row.row_key);

            INSERT INTO workspace_database_rows (
                id, database_id, doc_id, title, position, created_by, updated_by
            ) VALUES (
                v_row_id,
                v_database_id,
                NULL,
                v_row.title,
                v_row.row_position,
                v_admin,
                v_admin
            )
            ON CONFLICT (id) DO UPDATE
              SET database_id = EXCLUDED.database_id,
                  doc_id = NULL,
                  title = EXCLUDED.title,
                  position = EXCLUDED.position,
                  updated_by = EXCLUDED.updated_by,
                  updated_at = now();

            INSERT INTO workspace_database_cell_values (
                row_id, field_id, database_id, value_json, updated_by
            )
            VALUES
              (v_row_id, v_status_field_id, v_database_id, to_jsonb(v_row.status_value::text), v_admin),
              (v_row_id, v_due_field_id, v_database_id, jsonb_build_object(
                'start', v_row.due_start::text,
                'end', v_row.due_end::text,
                'allDay', v_row.due_all_day,
                'timeZone', v_row.due_time_zone
              ), v_admin),
              (v_row_id, v_notes_field_id, v_database_id, to_jsonb(v_row.notes::text), v_admin),
              (v_row_id, v_score_field_id, v_database_id, to_jsonb(v_row.score::numeric), v_admin),
              (v_row_id, v_progress_field_id, v_database_id, to_jsonb(v_row.progress_value::numeric), v_admin),
              (v_row_id, v_reference_field_id, v_database_id, to_jsonb(v_row.reference_url::text), v_admin),
              (v_row_id, v_tags_field_id, v_database_id,
               CASE v_row.tag_state
                 WHEN 1 THEN jsonb_build_array(v_priority_tag_id::text)
                 WHEN 2 THEN jsonb_build_array(v_priority_tag_id::text, v_release_tag_id::text)
                 WHEN 3 THEN jsonb_build_array(v_priority_tag_id::text, v_critical_tag_id::text)
                 ELSE '[]'::jsonb
               END,
               v_admin),
              (v_row_id, v_dependency_field_id, v_database_id, '[]'::jsonb, v_admin)
            ON CONFLICT (row_id, field_id) DO UPDATE
              SET database_id = EXCLUDED.database_id,
                  value_json = EXCLUDED.value_json,
                  updated_by = EXCLUDED.updated_by,
                  updated_at = now();
        END LOOP;

        -- This board is a deterministic local visual fixture, not a user data
        -- surface. Reconcile rows created by interrupted interaction tests so
        -- rerunning the documented seed always restores its stated 9-row
        -- contract instead of accumulating ambiguous "Untitled row" cards.
        EXECUTE format(
          'DELETE FROM %I
            WHERE database_id = $1
              AND id NOT IN (
                SELECT pg_temp.myoxus_seed_uuid(
                  $2 || '':database-qa-board:row:'' || row_key
                )
                  FROM unnest(ARRAY[
                    ''todo-1'', ''todo-2'', ''todo-3'',
                    ''progress-1'', ''progress-2'', ''progress-3'',
                    ''done-1'', ''done-2'', ''done-3''
                  ]) AS row_keys(row_key)
              )',
          'workspace_' || 'database_rows'
        ) USING v_database_id, v_workspace.id::text;

        -- Database rows are independent records in the current domain model.
        -- Earlier seed revisions created metadata-only docs here, which looked
        -- available to GraphQL but could only render a 404 without canonical
        -- Yjs/root-document state. Remove those local QA artifacts instead of
        -- preserving the obsolete row-as-document assumption.
        DELETE FROM docs
         WHERE workspace_id = v_workspace.id
           AND meta->>'seed_kind' = 'database-qa-board-row';
    END LOOP;
END $$;

\echo 'Database QA boards'
SELECT w.name AS workspace,
       d.title AS database,
       COUNT(r.id)::bigint AS rows,
       COUNT(*) FILTER (WHERE cv.value_json = '"todo"'::jsonb)::bigint AS todo,
       COUNT(*) FILTER (WHERE cv.value_json = '"progress"'::jsonb)::bigint AS progress,
       COUNT(*) FILTER (WHERE cv.value_json = '"done"'::jsonb)::bigint AS done
  FROM workspaces w
  JOIN workspace_databases d
    ON d.workspace_id = w.id
   AND d.title = 'Database QA Board'
  JOIN workspace_database_rows r
    ON r.database_id = d.id
  JOIN workspace_database_fields f
    ON f.database_id = d.id
   AND f.name = 'Status'
  JOIN workspace_database_cell_values cv
    ON cv.row_id = r.id
   AND cv.field_id = f.id
 WHERE w.deleted_at IS NULL
 GROUP BY w.id, w.name, d.id, d.title
 ORDER BY w.name;
SQL
    ok "Database QA boards checked"
}

# ---------------------------------------------------------------------------
# 1. Admin user
# ---------------------------------------------------------------------------
info "Ensuring admin user..."
cli_idempotent run_cli users create \
    --email    "admin@myoxus.local" \
    --name     "Admin"

# Password reset — guarantees the documented credential regardless of any
# prior bootstrap (e.g. stack-up.sh seeds admin with a different password).
set_seed_password "admin@myoxus.local" "AdminMyoxus2026"

info "Promoting admin@myoxus.local to admin..."
run_cli users set-admin "admin@myoxus.local"
ok "Admin:  admin@myoxus.local"

# ---------------------------------------------------------------------------
# 2. Alice
# ---------------------------------------------------------------------------
info "Ensuring Alice..."
cli_idempotent run_cli users create \
    --email    "alice@myoxus.local" \
    --name     "Alice"
set_seed_password "alice@myoxus.local" "AliceMyoxus2026"
ok "Alice:  alice@myoxus.local"

# ---------------------------------------------------------------------------
# 3. Bobby
# ---------------------------------------------------------------------------
info "Ensuring Bobby..."
cli_idempotent run_cli users create \
    --email    "bobby@myoxus.local" \
    --name     "Bobby"
set_seed_password "bobby@myoxus.local" "BobbyMyoxus2026"
ok "Bobby:  bobby@myoxus.local"

# ---------------------------------------------------------------------------
# 4. Resolve user IDs via --json (field order: "id" comes before "name")
# ---------------------------------------------------------------------------
ALICE_ID="$(get_user_id "alice@myoxus.local")"
BOBBY_ID="$(get_user_id "bobby@myoxus.local")"
ADMIN_ID="$(get_user_id "admin@myoxus.local")"

[[ -n "$ADMIN_ID" ]] || { fail "Could not resolve Admin's user ID"; exit 1; }
[[ -n "$ALICE_ID" ]] || { fail "Could not resolve Alice's user ID"; exit 1; }
[[ -n "$BOBBY_ID" ]] || { fail "Could not resolve Bobby's user ID"; exit 1; }

# ---------------------------------------------------------------------------
# 5. Organization units and workspaces.
# ---------------------------------------------------------------------------
info "Ensuring organization units Alpha/Beta..."
psql_exec \
    -v admin_id="$ADMIN_ID" \
    -v alice_id="$ALICE_ID" \
    -v bobby_id="$BOBBY_ID" <<'SQL'
CREATE TEMP TABLE _seed_user_ids (
  admin_id uuid NOT NULL,
  alice_id uuid NOT NULL,
  bobby_id uuid NOT NULL
);

INSERT INTO _seed_user_ids VALUES (:'admin_id'::uuid, :'alice_id'::uuid, :'bobby_id'::uuid);

DO $$
DECLARE
    v_org uuid;
    v_root_type uuid;
    v_team_type uuid;
    v_admin uuid;
    v_alice uuid;
    v_bobby uuid;
    v_root uuid;
    v_alpha uuid;
    v_beta uuid;
    v_alpha_ws uuid;
    v_beta_ws uuid;
BEGIN
    SELECT admin_id, alice_id, bobby_id
      INTO v_admin, v_alice, v_bobby
      FROM _seed_user_ids;

    SELECT id INTO v_org FROM organization WHERE key = 'myoxus';
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'Default organization (key=myoxus) missing. Start the API once so migrations run.';
    END IF;

    -- Keep the tenant display name aligned with the local-dev OU root. Fresh
    -- databases get this from migration 0121; existing local databases need
    -- the seed to repair the visible Admin overview without a compatibility
    -- path or one-off manual SQL.
    UPDATE organization
       SET name = 'Myoxus Organisation',
           slug = 'myoxus',
           updated_at = now()
     WHERE id = v_org
       AND (name IS DISTINCT FROM 'Myoxus Organisation'
            OR slug IS DISTINCT FROM 'myoxus');

    SELECT id INTO v_root_type
      FROM organization_unit_type
      WHERE organization_id = v_org
        AND key IN ('organisation', 'mx.organisation', 'wt.organisation')
      ORDER BY CASE key
        WHEN 'organisation' THEN 0
        WHEN 'mx.organisation' THEN 1
        WHEN 'wt.organisation' THEN 2
        ELSE 9
      END
      LIMIT 1;
    IF v_root_type IS NULL THEN
        RAISE EXCEPTION 'No root-capable organization unit type found.';
    END IF;

    SELECT id INTO v_team_type
      FROM organization_unit_type
      WHERE organization_id = v_org
        AND key IN ('team', 'mx.team', 'wt.team', 'kvk.team', 'kvg.team')
      ORDER BY CASE key
        WHEN 'team' THEN 0
        WHEN 'mx.team' THEN 1
        WHEN 'wt.team' THEN 2
        WHEN 'kvk.team' THEN 3
        WHEN 'kvg.team' THEN 4
        ELSE 9
      END
      LIMIT 1;
    IF v_team_type IS NULL THEN
        RAISE EXCEPTION 'No team organization unit type found.';
    END IF;

    -- Personal workspaces created by the CLI predate the org owner columns in
    -- some local databases. The seed makes them explicit user-owned workspaces.
    UPDATE workspaces w
       SET owner_principal_type = 'user'::owner_principal_type,
           owner_principal_id = w.owner_user_id,
           created_by_user_id = COALESCE(w.created_by_user_id, w.owner_user_id),
           management_unit_id = NULL,
           updated_at = now()
     WHERE w.owner_user_id IS NOT NULL
       AND w.deleted_at IS NULL
       AND NOT EXISTS (
           SELECT 1
             FROM organization_unit_workspace ouw
            WHERE ouw.workspace_id = w.id
              AND ouw.relationship = 'owner'
       );

    SELECT id INTO v_root
      FROM organization_unit
      WHERE organization_id = v_org
        AND parent_unit_id IS NULL
        AND slug = 'myoxus-organisation';
    IF v_root IS NULL THEN
        INSERT INTO organization_unit (
            organization_id, parent_unit_id, unit_type_id, name, slug,
            description, status, metadata, created_by
        ) VALUES (
            v_org, NULL, v_root_type, 'Myoxus Organisation', 'myoxus-organisation',
            'Root unit for local development data.', 'active',
            jsonb_build_object('seed', 'manual-test', 'seed_version', 3, 'purpose', 'local-dev-root'),
            v_admin
        )
        RETURNING id INTO v_root;
    ELSE
        UPDATE organization_unit
           SET unit_type_id = v_root_type,
               name = 'Myoxus Organisation',
               description = 'Root unit for local development data.',
               status = 'active',
               metadata = metadata || jsonb_build_object('seed', 'manual-test', 'seed_version', 3, 'purpose', 'local-dev-root'),
               updated_at = now()
         WHERE id = v_root;
    END IF;

    SELECT id INTO v_alpha
      FROM organization_unit
      WHERE organization_id = v_org
        AND parent_unit_id = v_root
        AND slug = 'alpha';
    IF v_alpha IS NULL THEN
        INSERT INTO organization_unit (
            organization_id, parent_unit_id, unit_type_id, name, slug,
            description, status, metadata, created_by
        ) VALUES (
            v_org, v_root, v_team_type, 'Alpha', 'alpha',
            'Alpha team for local development.', 'active',
            jsonb_build_object('seed', 'manual-test', 'seed_version', 3, 'workspace_key', 'alpha'),
            v_admin
        )
        RETURNING id INTO v_alpha;
    ELSE
        UPDATE organization_unit
           SET parent_unit_id = v_root,
               unit_type_id = v_team_type,
               name = 'Alpha',
               description = 'Alpha team for local development.',
               status = 'active',
               metadata = metadata || jsonb_build_object('seed', 'manual-test', 'seed_version', 3, 'workspace_key', 'alpha'),
               updated_at = now()
         WHERE id = v_alpha;
    END IF;

    SELECT id INTO v_beta
      FROM organization_unit
      WHERE organization_id = v_org
        AND parent_unit_id = v_root
        AND slug = 'beta';
    IF v_beta IS NULL THEN
        INSERT INTO organization_unit (
            organization_id, parent_unit_id, unit_type_id, name, slug,
            description, status, metadata, created_by
        ) VALUES (
            v_org, v_root, v_team_type, 'Beta', 'beta',
            'Beta team for local development.', 'active',
            jsonb_build_object('seed', 'manual-test', 'seed_version', 3, 'workspace_key', 'beta'),
            v_admin
        )
        RETURNING id INTO v_beta;
    ELSE
        UPDATE organization_unit
           SET parent_unit_id = v_root,
               unit_type_id = v_team_type,
               name = 'Beta',
               description = 'Beta team for local development.',
               status = 'active',
               metadata = metadata || jsonb_build_object('seed', 'manual-test', 'seed_version', 3, 'workspace_key', 'beta'),
               updated_at = now()
         WHERE id = v_beta;
    END IF;

    INSERT INTO user_features (user_id, feature_name, activated, reason)
    VALUES (v_admin, 'manager', true, 'seed: organization manager')
    ON CONFLICT (user_id, feature_name) DO UPDATE
      SET activated = true,
          reason = EXCLUDED.reason,
          updated_at = now();

    INSERT INTO organization_unit_member (unit_id, user_id, role, source, metadata)
    VALUES
      (v_root, v_admin, 'manager', 'manual', jsonb_build_object('seed', 'manual-test')),
      (v_alpha, v_admin, 'manager', 'manual', jsonb_build_object('seed', 'manual-test')),
      (v_alpha, v_alice, 'member', 'manual', jsonb_build_object('seed', 'manual-test')),
      (v_beta, v_admin, 'manager', 'manual', jsonb_build_object('seed', 'manual-test')),
      (v_beta, v_bobby, 'member', 'manual', jsonb_build_object('seed', 'manual-test'))
    ON CONFLICT (unit_id, user_id) DO UPDATE
      SET role = EXCLUDED.role,
          source = EXCLUDED.source,
          metadata = organization_unit_member.metadata || EXCLUDED.metadata,
          updated_at = now();

    SELECT ouw.workspace_id INTO v_alpha_ws
      FROM organization_unit_workspace ouw
      JOIN workspaces w ON w.id = ouw.workspace_id
      WHERE ouw.unit_id = v_alpha
        AND ouw.relationship = 'owner'
        AND w.deleted_at IS NULL
      LIMIT 1;
    IF v_alpha_ws IS NULL THEN
        INSERT INTO workspaces (
            owner_user_id, name, public,
            owner_principal_type, owner_principal_id, management_unit_id, created_by_user_id
        ) VALUES (
            NULL, 'Alpha', false,
            'ou', v_alpha, v_alpha, v_admin
        )
        RETURNING id INTO v_alpha_ws;
    ELSE
        UPDATE workspaces
           SET owner_user_id = NULL,
               name = 'Alpha',
               owner_principal_type = 'ou',
               owner_principal_id = v_alpha,
               management_unit_id = v_alpha,
               is_personal_workspace = false,
               created_by_user_id = COALESCE(created_by_user_id, v_admin),
               deleted_at = NULL,
               updated_at = now()
         WHERE id = v_alpha_ws;
    END IF;

    SELECT ouw.workspace_id INTO v_beta_ws
      FROM organization_unit_workspace ouw
      JOIN workspaces w ON w.id = ouw.workspace_id
      WHERE ouw.unit_id = v_beta
        AND ouw.relationship = 'owner'
        AND w.deleted_at IS NULL
      LIMIT 1;
    IF v_beta_ws IS NULL THEN
        INSERT INTO workspaces (
            owner_user_id, name, public,
            owner_principal_type, owner_principal_id, management_unit_id, created_by_user_id
        ) VALUES (
            NULL, 'Beta', false,
            'ou', v_beta, v_beta, v_admin
        )
        RETURNING id INTO v_beta_ws;
    ELSE
        UPDATE workspaces
           SET owner_user_id = NULL,
               name = 'Beta',
               owner_principal_type = 'ou',
               owner_principal_id = v_beta,
               management_unit_id = v_beta,
               is_personal_workspace = false,
               created_by_user_id = COALESCE(created_by_user_id, v_admin),
               deleted_at = NULL,
               updated_at = now()
         WHERE id = v_beta_ws;
    END IF;

    INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
    VALUES
      (v_alpha, v_alpha_ws, 'owner'),
      (v_beta, v_beta_ws, 'owner')
    ON CONFLICT (unit_id, workspace_id, relationship) DO UPDATE
      SET updated_at = now();

    INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by)
    VALUES
      (v_alpha_ws, v_alpha_ws, 'Alpha', true, v_admin, v_admin),
      (v_beta_ws, v_beta_ws, 'Beta', true, v_admin, v_admin)
    ON CONFLICT (id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id,
          title = EXCLUDED.title,
          is_workspace_root = true,
          updated_by = EXCLUDED.updated_by,
          updated_at = now();

    INSERT INTO workspace_memberships (
        workspace_id, user_id, role, status, invited_by_user_id, joined_at
    )
    VALUES
      (v_alpha_ws, v_admin, 'Admin', 'Accepted', v_admin, now()),
      (v_alpha_ws, v_alice, 'Collaborator', 'Accepted', v_admin, now()),
      (v_beta_ws, v_admin, 'Admin', 'Accepted', v_admin, now()),
      (v_beta_ws, v_bobby, 'Collaborator', 'Accepted', v_admin, now())
    ON CONFLICT (workspace_id, user_id) DO UPDATE
      SET role = EXCLUDED.role,
          status = EXCLUDED.status,
          invited_by_user_id = EXCLUDED.invited_by_user_id,
          joined_at = COALESCE(workspace_memberships.joined_at, EXCLUDED.joined_at),
          updated_at = now();

    INSERT INTO workspace_template_policies (
        id, workspace_id, template_id, selection_mode, selected_revision_id,
        provisioning_mode, is_enabled, created_at, updated_at
    )
    SELECT gen_random_uuid(), target.workspace_id, dp.template_id, dp.selection_mode, NULL,
           dp.provisioning_mode, true, now(), now()
      FROM (VALUES (v_alpha_ws), (v_beta_ws)) AS target(workspace_id)
      JOIN template_default_policies dp ON dp.apply_to_new_workspaces = true
      JOIN template_catalog_entries c ON c.id = dp.template_id
     WHERE c.source = 'builtin'
       AND c.status = 'active'
    ON CONFLICT (workspace_id, template_id) DO NOTHING;

    -- The manual dataset keeps builtin-template auto-provisioning on the two
    -- OU workspaces only. Personal seed workspaces are used for admin/user
    -- smoke flows and must not silently recreate template documents.
    DELETE FROM workspace_template_policies p
     USING workspaces w
     WHERE p.workspace_id = w.id
       AND w.owner_user_id IN (v_admin, v_alice, v_bobby)
       AND NOT EXISTS (
           SELECT 1
             FROM organization_unit_workspace ouw
            WHERE ouw.workspace_id = w.id
              AND ouw.relationship = 'owner'
       );

    RAISE NOTICE 'Seeded organization units: root %, alpha % -> workspace %, beta % -> workspace %',
      v_root, v_alpha, v_alpha_ws, v_beta, v_beta_ws;
END $$;
SQL
ok "Organization model seeded (Alpha/Beta as OUs with OU-owned workspaces)"

info "Seeding root documents where missing..."
run_cli workspaces seed-root-doc all --admin-user-id "$ADMIN_ID" >/dev/null
ok "Workspace root documents checked"

seed_complex_documents

seed_database_qa_board

info "Verifying seed dataset..."
psql_exec -P pager=off <<'SQL'
\echo 'Users'
SELECT email, name, is_admin, status
  FROM users
  WHERE email IN ('admin@myoxus.local', 'alice@myoxus.local', 'bobby@myoxus.local')
  ORDER BY email;

\echo 'Organization units'
SELECT ou.name AS unit, out.label AS type, u.email AS user_email, oum.role
  FROM organization_unit ou
  JOIN organization_unit_type out ON out.id = ou.unit_type_id
  LEFT JOIN organization_unit_member oum ON oum.unit_id = ou.id
  LEFT JOIN users u ON u.id = oum.user_id
  WHERE ou.slug IN ('myoxus-organisation', 'alpha', 'beta')
  ORDER BY ou.name, oum.role DESC, u.email;

\echo 'Workspaces'
SELECT w.name AS workspace,
       w.owner_principal_type::text AS owner_type,
       ou.name AS owner_unit,
       u.email AS user_email,
       wm.role AS workspace_role
  FROM workspaces w
  LEFT JOIN organization_unit ou ON ou.id = w.owner_principal_id
  LEFT JOIN workspace_memberships wm ON wm.workspace_id = w.id
  LEFT JOIN users u ON u.id = wm.user_id
  WHERE w.deleted_at IS NULL
    AND (w.name IN ('Alpha', 'Beta') OR u.email IN ('admin@myoxus.local', 'alice@myoxus.local', 'bobby@myoxus.local'))
  ORDER BY w.name, wm.role DESC, u.email;

\echo 'Complex seed documents per workspace'
SELECT w.name AS workspace,
       COUNT(d.id)::bigint AS complex_seed_documents
  FROM workspaces w
  LEFT JOIN docs d
    ON d.workspace_id = w.id
   AND d.deleted_at IS NULL
   AND d.meta->>'seed_kind' = 'complex-test-document'
 WHERE w.deleted_at IS NULL
 GROUP BY w.id, w.name
 ORDER BY w.name;

\echo 'Database QA board status coverage'
SELECT w.name AS workspace,
       d.title AS database,
       COUNT(r.id)::bigint AS rows,
       COUNT(*) FILTER (WHERE cv.value_json = '"todo"'::jsonb)::bigint AS todo,
       COUNT(*) FILTER (WHERE cv.value_json = '"progress"'::jsonb)::bigint AS progress,
       COUNT(*) FILTER (WHERE cv.value_json = '"done"'::jsonb)::bigint AS done
  FROM workspaces w
  JOIN workspace_databases d
    ON d.workspace_id = w.id
   AND d.title = 'Database QA Board'
  JOIN workspace_database_rows r
    ON r.database_id = d.id
  JOIN workspace_database_fields f
    ON f.database_id = d.id
   AND f.name = 'Status'
  JOIN workspace_database_cell_values cv
    ON cv.row_id = r.id
   AND cv.field_id = f.id
 WHERE w.deleted_at IS NULL
 GROUP BY w.id, w.name, d.id, d.title
 ORDER BY w.name;
SQL
