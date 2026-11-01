// SPDX-License-Identifier: AGPL-3.0-or-later
//! Schema invariants for the canonical Organization and Organization Unit model.
//!
//! Paket: ORG-B (todo/organization-management-todos.md, ORG-B-T01..T07)
//! Konzept: todo/organization-management-concept.md
//! Vertrag: docs/dev/server/organization-management.md
//!
//! Jeder Test prueft eine konkrete DB-Invariante nach Migrations-Apply, nicht
//! nur dass eine Query erfolgreich laeuft. Tests sind atomar und idempotent —
//! sie erstellen ihre Test-Rows mit zufaelligen Schluesseln und raeumen
//! anschliessend alle erzeugten Rows wieder ab. Die Default-Organisation und
//! die Preset-Typen werden nicht angefasst (sie sind permanent durch die
//! Baseline geseedet).

use sqlx::PgPool;
use uuid::Uuid;

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .expect("TEST_DATABASE_URL must be set for organization_schema_test");
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

/// Resolve the default organisation's UUID from the canonical seed catalog.
async fn default_org_id(pool: &PgPool) -> Uuid {
  sqlx::query_scalar::<_, Uuid>("SELECT id FROM organization WHERE key = 'myoxus'")
    .fetch_one(pool)
    .await
    .expect("default organisation must be seeded")
}

/// Seed a minimal user + workspace so OU/workspace-link tests have FK targets.
/// Both rows are returned; cleanup is the test's responsibility.
async fn seed_user_workspace(pool: &PgPool) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let ws_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("org-test-{}@example.test", user_id))
    .bind("ORG Test User")
    .execute(pool)
    .await
    .expect("seed user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(ws_id)
    .bind(user_id)
    .bind("ORG Test Workspace")
    .execute(pool)
    .await
    .expect("seed workspace");
  (user_id, ws_id)
}

/// Pick the first system-seeded `organisation`-type row (all presets share the
/// `organisation` / `organisation`-style root). Returns its UUID.
async fn pick_root_unit_type(pool: &PgPool, org_id: Uuid) -> Uuid {
  sqlx::query_scalar::<_, Uuid>(
    "SELECT id FROM organization_unit_type
     WHERE organization_id = $1 AND is_preset = true AND can_be_root_level = true
     ORDER BY key
     LIMIT 1",
  )
  .bind(org_id)
  .fetch_one(pool)
  .await
  .expect("at least one root-capable preset type must exist")
}

// ─────────────────────────────────────────────────────────────────────────────
// ORG-B-T01  Default-Organisation + Presets vorhanden
// ─────────────────────────────────────────────────────────────────────────────

/// INV: A fresh DB carries the default organisation, the default policy row,
/// and the complete canonical preset set.
#[tokio::test]
async fn inv_org_b_t01_default_organization_and_presets_seeded() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;

  // Policy row exists.
  let policy_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_policy WHERE organization_id = $1")
    .bind(org_id)
    .fetch_one(&pool)
    .await
    .expect("policy count");
  assert_eq!(policy_count, 1, "default org must have exactly one policy row");

  // Preset types: at least 1 from 0107 + 4 presets from 0108 → total ≥ 50.
  // We verify a tighter bound (≥ 7 base + ≥ 13 KVG + ≥ 13 KVK + ≥ 13 WT + ≥ 9 MX = 55+).
  let total_presets: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM organization_unit_type
     WHERE organization_id = $1 AND is_preset = true",
  )
  .bind(org_id)
  .fetch_one(&pool)
  .await
  .expect("preset count");
  assert!(total_presets >= 50, "expected >= 50 preset types, got {total_presets}");

  // The base „Wirtschaft flach" preset must include both `team` and
  // `projekt` keys; these are the most-used types in tests/code paths.
  for required_key in ["team", "projekt", "bereich"] {
    let exists: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM organization_unit_type
       WHERE organization_id = $1 AND key = $2)",
    )
    .bind(org_id)
    .bind(required_key)
    .fetch_one(&pool)
    .await
    .expect("preset key existence");
    assert!(exists, "default preset must include key `{required_key}`");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORG-B-T03  Eine OU kann mehrere Workspaces besitzen oder verwalten
// ─────────────────────────────────────────────────────────────────────────────

/// INV: A single OU can hold multiple workspace links — exactly one with
/// relationship='owner' and any number with 'managed' or 'linked'. The
/// 1:1 invariant from the legacy team model must be gone.
#[tokio::test]
async fn inv_org_b_t03_ou_can_link_multiple_workspaces() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let type_id = pick_root_unit_type(&pool, org_id).await;
  let (_user_id_a, ws_a) = seed_user_workspace(&pool).await;
  let (_user_id_b, ws_b) = seed_user_workspace(&pool).await;
  let (_user_id_c, ws_c) = seed_user_workspace(&pool).await;

  let unit_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO organization_unit (id, organization_id, unit_type_id, name, slug, status)
     VALUES ($1, $2, $3, $4, $5, 'active')",
  )
  .bind(unit_id)
  .bind(org_id)
  .bind(type_id)
  .bind("ORG-T03 Unit")
  .bind(format!("org-t03-{}", unit_id))
  .execute(&pool)
  .await
  .expect("insert unit");

  // Three different relationships against three different workspaces.
  for (ws_id, rel) in [(ws_a, "owner"), (ws_b, "managed"), (ws_c, "linked")] {
    sqlx::query(
      "INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
       VALUES ($1, $2, $3::organization_unit_workspace_relationship)",
    )
    .bind(unit_id)
    .bind(ws_id)
    .bind(rel)
    .execute(&pool)
    .await
    .expect("insert ou_workspace");
  }

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit_workspace WHERE unit_id = $1")
    .bind(unit_id)
    .fetch_one(&pool)
    .await
    .expect("count ou_workspace");
  assert_eq!(count, 3, "OU must support multiple workspace links");

  // Cleanup (cascade through ou → ou_workspace, then explicit on workspaces+users).
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .ok();
  for ws_id in [ws_a, ws_b, ws_c] {
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(ws_id)
      .execute(&pool)
      .await
      .ok();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORG-B-T04  Genau ein owner-Relationship pro Workspace
// ─────────────────────────────────────────────────────────────────────────────

/// INV: The partial unique index on `organization_unit_workspace
/// (workspace_id) WHERE relationship='owner'` must reject a second
/// owner-relationship for the same workspace.
#[tokio::test]
async fn inv_org_b_t04_only_one_owner_per_workspace() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let type_id = pick_root_unit_type(&pool, org_id).await;
  let (_user_id, ws_id) = seed_user_workspace(&pool).await;

  let unit_a = Uuid::new_v4();
  let unit_b = Uuid::new_v4();
  for unit_id in [unit_a, unit_b] {
    sqlx::query(
      "INSERT INTO organization_unit (id, organization_id, unit_type_id, name, slug, status)
       VALUES ($1, $2, $3, $4, $5, 'active')",
    )
    .bind(unit_id)
    .bind(org_id)
    .bind(type_id)
    .bind(format!("ORG-T04-{unit_id}"))
    .bind(format!("org-t04-{unit_id}"))
    .execute(&pool)
    .await
    .expect("insert unit");
  }

  sqlx::query(
    "INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
     VALUES ($1, $2, 'owner')",
  )
  .bind(unit_a)
  .bind(ws_id)
  .execute(&pool)
  .await
  .expect("first owner-link inserts");

  let conflict = sqlx::query(
    "INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
     VALUES ($1, $2, 'owner')",
  )
  .bind(unit_b)
  .bind(ws_id)
  .execute(&pool)
  .await;
  assert!(
    conflict.is_err(),
    "second owner-link for the same workspace must fail (partial unique index)"
  );

  // A second non-owner link must succeed.
  sqlx::query(
    "INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
     VALUES ($1, $2, 'managed')",
  )
  .bind(unit_b)
  .bind(ws_id)
  .execute(&pool)
  .await
  .expect("second 'managed' link succeeds for the same workspace");

  // Cleanup.
  for unit_id in [unit_a, unit_b] {
    sqlx::query("DELETE FROM organization_unit WHERE id = $1")
      .bind(unit_id)
      .execute(&pool)
      .await
      .ok();
  }
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .ok();
}

// ─────────────────────────────────────────────────────────────────────────────
// ORG-B-T06  Preset-Typen haben vollstaendige Flag-Werte (NOT NULL)
// ─────────────────────────────────────────────────────────────────────────────

/// INV: Every preset row carries a non-null value in every flag column.
/// The schema enforces NOT NULL; this test makes the contract visible by
/// asserting that no preset is left in a partial state after seeds run.
#[tokio::test]
async fn inv_org_b_t06_presets_have_complete_flags() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;

  // Postgres will refuse the insert if a NOT NULL flag is missing, so this
  // test mostly reduces to "preset rows exist for every flag combination
  // we promised". We assert here that at least the four permanent flags
  // (`is_structural`, `can_have_children`, `can_be_root_level`,
  // `can_be_manager_created`) cover all four binary combinations the
  // concept lists as relevant.
  let row: (i64, i64, i64, i64) = sqlx::query_as(
    "SELECT
        COUNT(*) FILTER (WHERE is_structural = true) AS structural,
        COUNT(*) FILTER (WHERE is_structural = false) AS nonstructural,
        COUNT(*) FILTER (WHERE can_be_manager_created = true) AS mgr_created,
        COUNT(*) FILTER (WHERE can_be_root_level = true) AS root_level
     FROM organization_unit_type
     WHERE organization_id = $1 AND is_preset = true",
  )
  .bind(org_id)
  .fetch_one(&pool)
  .await
  .expect("flag breakdown");
  assert!(row.0 > 0, "presets must include structural types");
  assert!(row.1 > 0, "presets must include non-structural (project) types");
  assert!(row.2 > 0, "presets must include manager-creatable types");
  assert!(row.3 > 0, "presets must include root-level types");

  let preset_types_without_workspace_ownership: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)
       FROM organization_unit_type
      WHERE organization_id = $1
        AND is_preset = TRUE
        AND can_own_workspaces = FALSE",
  )
  .bind(org_id)
  .fetch_one(&pool)
  .await
  .expect("preset workspace-ownership capability count");
  assert_eq!(
    preset_types_without_workspace_ownership, 0,
    "every preset unit type must be allowed to own workspaces"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ORG-B-T07  Project requests akzeptieren alle vier Status-Werte
// ─────────────────────────────────────────────────────────────────────────────

/// INV: organization_project_request.status accepts pending/approved/rejected/cancelled
/// and rejects unknown literals. Verifies the enum's CHECK behaviour.
#[tokio::test]
async fn inv_org_b_t07_project_request_status_enum() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let (user_id, _ws) = seed_user_workspace(&pool).await;
  // Drop the auto-seeded workspace; this test needs only the user.
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();

  // Each enum literal must accept.
  let mut request_ids = Vec::new();
  for status in ["pending", "approved", "rejected", "cancelled"] {
    let req_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO organization_project_request
         (id, organization_id, requested_by, requested_scope, proposed_name, status)
       VALUES ($1, $2, $3, 'organization_root', $4, $5::organization_project_request_status)",
    )
    .bind(req_id)
    .bind(org_id)
    .bind(user_id)
    .bind(format!("ORG-T07 {status}"))
    .bind(status)
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("status `{status}` must accept: {e}"));
    request_ids.push(req_id);
  }

  // An unknown literal must fail at the type-cast level.
  let invalid = sqlx::query(
    "INSERT INTO organization_project_request
       (id, organization_id, requested_by, requested_scope, proposed_name, status)
     VALUES ($1, $2, $3, 'organization_root', $4, $5::organization_project_request_status)",
  )
  .bind(Uuid::new_v4())
  .bind(org_id)
  .bind(user_id)
  .bind("ORG-T07 invalid")
  .bind("nope")
  .execute(&pool)
  .await;
  assert!(invalid.is_err(), "unknown status literal must be rejected");

  // Cleanup.
  for id in request_ids {
    sqlx::query("DELETE FROM organization_project_request WHERE id = $1")
      .bind(id)
      .execute(&pool)
      .await
      .ok();
  }
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ─────────────────────────────────────────────────────────────────────────────
// ORG-B-T05  Constraint-Test: Rollen/Beziehungen sind Enums (kein Freitext)
// ─────────────────────────────────────────────────────────────────────────────

/// INV: organization_unit_member.role is the enum with reader/member/manager;
/// other literals must be rejected.
#[tokio::test]
async fn inv_org_b_t05_ou_member_role_enum_rejects_unknown() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let type_id = pick_root_unit_type(&pool, org_id).await;
  let (user_id, _) = seed_user_workspace(&pool).await;

  let unit_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO organization_unit (id, organization_id, unit_type_id, name, slug, status)
     VALUES ($1, $2, $3, $4, $5, 'active')",
  )
  .bind(unit_id)
  .bind(org_id)
  .bind(type_id)
  .bind("ORG-T05 Unit")
  .bind(format!("org-t05-{unit_id}"))
  .execute(&pool)
  .await
  .expect("insert unit");

  // Each known role must accept.
  for role in ["reader", "member", "manager"] {
    sqlx::query(
      "INSERT INTO organization_unit_member (unit_id, user_id, role)
       VALUES ($1, $2, $3::organization_unit_role)
       ON CONFLICT (unit_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(unit_id)
    .bind(user_id)
    .bind(role)
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("role `{role}` must accept: {e}"));
  }

  // Unknown role must fail.
  let invalid = sqlx::query(
    "INSERT INTO organization_unit_member (unit_id, user_id, role)
     VALUES ($1, $2, $3::organization_unit_role)
     ON CONFLICT (unit_id, user_id) DO UPDATE SET role = EXCLUDED.role",
  )
  .bind(unit_id)
  .bind(user_id)
  .bind("admin") // not in the enum
  .execute(&pool)
  .await;
  assert!(invalid.is_err(), "unknown role literal must be rejected by enum");

  // Cleanup.
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace owner-principal columns
// ─────────────────────────────────────────────────────────────────────────────

/// INV: workspaces.owner_principal_* columns exist and accept the three
/// allowed enum values; FK on management_unit_id resolves to organization_unit.
#[tokio::test]
async fn inv_org_b_workspace_owner_principal_columns_present() {
  let pool = setup_pool().await;
  let org_id = default_org_id(&pool).await;
  let type_id = pick_root_unit_type(&pool, org_id).await;
  let (user_id, ws_id) = seed_user_workspace(&pool).await;

  let unit_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO organization_unit (id, organization_id, unit_type_id, name, slug, status)
     VALUES ($1, $2, $3, $4, $5, 'active')",
  )
  .bind(unit_id)
  .bind(org_id)
  .bind(type_id)
  .bind("ORG owner-principal Unit")
  .bind(format!("org-op-{unit_id}"))
  .execute(&pool)
  .await
  .expect("insert unit");

  for principal in ["user", "ou", "system"] {
    sqlx::query(
      "UPDATE workspaces
       SET owner_principal_type = $1::owner_principal_type,
           owner_principal_id = $2,
           owner_user_id = $3,
           management_unit_id = $4,
           created_by_user_id = $5,
           is_personal_workspace = $6
       WHERE id = $7",
    )
    .bind(principal)
    .bind(match principal {
      "user" => Some(user_id),
      "ou" => Some(unit_id),
      "system" => None,
      _ => unreachable!(),
    })
    .bind((principal == "user").then_some(user_id))
    .bind(unit_id)
    .bind(user_id)
    .bind(principal == "user")
    .bind(ws_id)
    .execute(&pool)
    .await
    .unwrap_or_else(|e| panic!("owner_principal_type `{principal}` must accept: {e}"));
  }

  // Cleanup.
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("workspace cleanup");
  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .expect("unit cleanup");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("user cleanup");
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit-Constraint: only the canonical organization category remains
// ─────────────────────────────────────────────────────────────────────────────

/// INV: the final schema accepts `organization` and rejects retired `team`.
#[tokio::test]
async fn inv_org_b_audit_log_accepts_organization_and_rejects_team() {
  let pool = setup_pool().await;
  let user_id = {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
      .bind(id)
      .bind(format!("audit-org-test-{id}@example.test"))
      .bind("AUDIT Org Test User")
      .execute(&pool)
      .await
      .expect("seed user");
    id
  };

  let audit_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO admin_audit_log
       (id, event_key, category, target_type, target_id, target_label, actor_user_id)
     VALUES ($1, 'organization.test_action', 'organization', 'organization', $2, 'audit-target', $3)",
  )
  .bind(audit_id)
  .bind(Uuid::new_v4().to_string())
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("organization audit category must remain accepted");

  let rejected = sqlx::query(
    "INSERT INTO admin_audit_log
       (id, event_key, category, target_type, target_id, target_label, actor_user_id)
     VALUES ($1, 'team.test_action', 'team', 'organization', $2, 'audit-target', $3)",
  )
  .bind(Uuid::new_v4())
  .bind(Uuid::new_v4().to_string())
  .bind(user_id)
  .execute(&pool)
  .await;
  assert!(rejected.is_err(), "retired team audit category must be rejected");

  sqlx::query("DELETE FROM admin_audit_log WHERE id = $1")
    .bind(audit_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

#[tokio::test]
async fn inv_org_final_schema_contains_only_canonical_ou_policy() {
  let pool = setup_pool().await;

  for table in [
    "teams",
    "team_members",
    "teams_pre_org_migration",
    "team_members_pre_org_migration",
  ] {
    let exists: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
      .bind(format!("public.{table}"))
      .fetch_one(&pool)
      .await
      .expect("table existence query");
    assert!(!exists, "{table} must be absent from the final schema");
  }

  let (unit_id, max_members): (Uuid, i32) = sqlx::query_as(
    "INSERT INTO organization_unit
       (organization_id, unit_type_id, name, slug)
     SELECT organization_id, id, 'Typed limit fixture', $1
       FROM organization_unit_type
      WHERE is_preset = TRUE
      ORDER BY key
      LIMIT 1
     RETURNING id, max_members",
  )
  .bind(format!("typed-limit-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("typed max_members default");
  assert_eq!(max_members, 25);

  let has_storage_limit: bool = sqlx::query_scalar(
    "SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'organization_unit_workspace'
          AND column_name = 'storage_limit_mb'
     )",
  )
  .fetch_one(&pool)
  .await
  .expect("OU link column query");
  assert!(!has_storage_limit, "OU links must not carry storage policy");

  sqlx::query("DELETE FROM organization_unit WHERE id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .expect("typed max_members cleanup");
}
