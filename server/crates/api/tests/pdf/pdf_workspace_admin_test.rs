// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-PDF-TPL-08-{06,07,08} integration tests for the admin-side PDF workspace
//! assignment GraphQL surface.
//!
//! Invariants:
//!
//! - INV-PDF-GQL-05 (`P-PDF-TPL-08-06`):
//!   `assignPdfTemplateToWorkspace` persists the row in
//!   `pdf_workspace_template_assignments` AND surfaces it via
//!   `pdfWorkspaceAssignments`. Idempotent — running the mutation twice yields
//!   exactly one row.
//! - INV-PDF-GQL-06 (`P-PDF-TPL-08-07`):
//!   `setWorkspaceDefaultPdfTemplate` flips `is_default = true` on the target
//!   row and `is_default = false` on whatever was the prior default, preserving
//!   the partial unique index `uniq_default_per_ws`. The PDF export settings
//!   row's `default_template_id` is updated in lock step.
//! - INV-PDF-GQL-07 (`P-PDF-TPL-08-08`):
//!   `unassignPdfTemplateFromWorkspace` is refused as long as the assignment
//!   carries `is_default = true`. The admin must clear the default first.
//!
//! Setup mirrors `pdf_workspace_readonly_test.rs`: it builds a router whose
//! [`ApiState`] has the production [`PgPdfTemplateRepository`],
//! [`PgPdfWorkspaceTemplateAssignmentRepository`], and
//! [`PgPdfWorkspaceBrandAssetRepository`] wired in, so the mutations roundtrip
//! through real SQLx code paths.

#![allow(clippy::too_many_lines)]

use crate::helpers;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_domain::entities::PdfTemplate;
use myoxus_infrastructure::pdf_export::{
  PgPdfTemplateRepository, PgPdfWorkspaceBrandAssetRepository, PgPdfWorkspaceTemplateAssignmentRepository,
};
use myoxus_infrastructure::storage::StorageAdapter;

// ---------------------------------------------------------------------------
// Test app builder with workspace-scoped PDF services wired
// ---------------------------------------------------------------------------

async fn setup_app() -> (axum::Router, PgPool, Arc<myoxus_infrastructure::auth::SqlxAuthStore>) {
  use myoxus_api::build_router_for_integration_tests as build_router;
  use myoxus_api::config::AppConfig;
  use myoxus_api::state::ApiState;
  use myoxus_application::admin::AdminService;
  use myoxus_application::auth::AuthService;
  use myoxus_application::doc::DocService;
  use myoxus_application::ports::blob_service::BlobService;
  use myoxus_application::workspace::WorkspaceService;
  use myoxus_infrastructure::admin::SqlxAdminStore;
  use myoxus_infrastructure::auth::SqlxAuthStore;
  use myoxus_infrastructure::blob::SqlxBlobStore;
  use myoxus_infrastructure::doc::SqlxDocStore;
  use myoxus_infrastructure::mail::LogMailAdapter;
  use myoxus_infrastructure::workspace::SqlxWorkspaceStore;

  let pool = helpers::setup_pool().await;
  let config = AppConfig::load().expect("config");

  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage_adapter = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let storage: Arc<dyn myoxus_application::ports::BlobStoragePort> = storage_adapter.clone();
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));

  let auth_service = AuthService::new(
    auth_store.clone(),
    mailer,
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);

  let template_repo: Arc<dyn myoxus_domain::repositories::PdfTemplateRepository> =
    Arc::new(PgPdfTemplateRepository::new(pool.clone()));
  let assignment_repo: Arc<dyn myoxus_domain::repositories::PdfWorkspaceTemplateAssignmentRepository> =
    Arc::new(PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone()));
  let brand_repo: Arc<dyn myoxus_domain::repositories::PdfWorkspaceBrandAssetRepository> =
    Arc::new(PgPdfWorkspaceBrandAssetRepository::new(pool.clone()));

  let state = ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  )
  .with_metrics_pool(pool.clone())
  .with_pdf_template_repo(template_repo)
  .with_pdf_assignment_repo(assignment_repo)
  .with_pdf_brand_repo(brand_repo);

  (build_router(state), pool, auth_store)
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async fn insert_template(pool: &PgPool, slug: &str, name: &str, created_by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  let slug = format!("{slug}-{}", Uuid::new_v4().simple());
  let manifest = json!({
    "schema_version": "2.0",
    "id": slug,
    "name": name,
    "description": "Workspace Admin PDF test fixture.",
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/workspace-admin",
      "source_revision": "1.0.0"
    },
    "entry": "main.typ",
    "assets": ["main.typ"],
    "capabilities": {}
  });
  let template = PdfTemplate {
    id,
    slug,
    name: name.to_string(),
    version: "1.0.0".to_string(),
    schema_version: "2.0".to_string(),
    manifest,
    created_by: Some(created_by),
    created_at: chrono::Utc::now(),
    deleted_at: None,
  };
  sqlx::query(
    r#"INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())"#,
  )
  .bind(template.id)
  .bind(&template.slug)
  .bind(&template.name)
  .bind(&template.version)
  .bind(&template.schema_version)
  .bind(&template.manifest)
  .bind(template.created_by)
  .execute(pool)
  .await
  .expect("insert pdf_templates row");
  id
}

async fn count_assignments(pool: &PgPool, ws: Uuid) -> i64 {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws)
    .fetch_one(pool)
    .await
    .expect("count assignments")
}

async fn assignment_is_default(pool: &PgPool, ws: Uuid, tpl: Uuid) -> Option<bool> {
  sqlx::query_scalar::<_, bool>(
    "SELECT is_default FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND template_id = $2",
  )
  .bind(ws)
  .bind(tpl)
  .fetch_optional(pool)
  .await
  .expect("read assignment.is_default")
}

async fn brand_default_template(pool: &PgPool, ws: Uuid) -> Option<Uuid> {
  sqlx::query_scalar::<_, Option<Uuid>>("SELECT default_template_id FROM pdf_export_settings WHERE workspace_id = $1")
    .bind(ws)
    .fetch_optional(pool)
    .await
    .expect("read pdf_export_settings.default_template_id")
    .flatten()
}

async fn cleanup_workspace(pool: &PgPool, ws: Uuid) {
  let _ = sqlx::query("DELETE FROM pdf_export_settings WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM document_brand_profiles WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM brand_assets WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws)
    .execute(pool)
    .await;
}

async fn cleanup_template(pool: &PgPool, tpl: Uuid) {
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE template_id = $1")
    .bind(tpl)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(tpl)
    .execute(pool)
    .await;
}

async fn cleanup_user(pool: &PgPool, user_id: Uuid) {
  let _ = sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
  let _ = sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await;
}

fn errors_array(body: &Value) -> Vec<String> {
  body
    .get("errors")
    .and_then(|v| v.as_array())
    .map(|arr| {
      arr
        .iter()
        .filter_map(|e| e.get("message").and_then(|m| m.as_str()).map(str::to_owned))
        .collect()
    })
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-05 — assign persists and lists
// ---------------------------------------------------------------------------

#[test]
fn inv_gql05_assign_persists_and_lists_for_workspace() {
  helpers::block_on_large_stack("inv-gql05-assign-persists-and-lists", || async {
    let (app, pool, auth_store) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;

    let ws = helpers::create_workspace(&pool, alice_id).await;
    let tpl = insert_template(&pool, "tpl-gql05", "Tpl GQL05", admin_id).await;

    // Workspace creation assigns the canonical system default.
    assert_eq!(count_assignments(&pool, ws).await, 1);

    // First call: creates the row.
    let body = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { assignPdfTemplateToWorkspace(workspaceId: $ws, templateId: $tpl) { workspaceId templateId isDefault assignedBy } } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl.to_string() }
    }),
  )
  .await;
    assert!(
      body.get("errors").is_none(),
      "INV-PDF-GQL-05: assign must succeed: {body}"
    );
    assert_eq!(
      body
        .pointer("/data/admin/assignPdfTemplateToWorkspace/templateId")
        .and_then(|v| v.as_str()),
      Some(tpl.to_string().as_str())
    );
    assert_eq!(
      body
        .pointer("/data/admin/assignPdfTemplateToWorkspace/isDefault")
        .and_then(|v| v.as_bool()),
      Some(false),
      "INV-PDF-GQL-05: new assignment must default to is_default=false"
    );
    assert_eq!(
      body
        .pointer("/data/admin/assignPdfTemplateToWorkspace/assignedBy")
        .and_then(|v| v.as_str()),
      Some(admin_id.to_string().as_str())
    );

    // Second call: idempotent. The system default plus this assignment remain.
    let body2 = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { assignPdfTemplateToWorkspace(workspaceId: $ws, templateId: $tpl) { templateId isDefault } } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl.to_string() }
    }),
  )
  .await;
    assert!(
      body2.get("errors").is_none(),
      "INV-PDF-GQL-05: second assign must be idempotent: {body2}"
    );
    assert_eq!(
      count_assignments(&pool, ws).await,
      2,
      "INV-PDF-GQL-05: idempotent assign must not duplicate rows"
    );

    // pdfWorkspaceAssignments must list the row.
    let listing = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query Q($ws: ID!) { admin { pdfWorkspaceAssignments(workspaceId: $ws) { templateId isDefault } } }",
        "variables": { "ws": ws.to_string() }
      }),
    )
    .await;
    assert!(
      listing.get("errors").is_none(),
      "INV-PDF-GQL-05: assignments listing must succeed: {listing}"
    );
    let rows = listing
      .pointer("/data/admin/pdfWorkspaceAssignments")
      .and_then(|v| v.as_array())
      .cloned()
      .expect("pdfWorkspaceAssignments array");
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|row| {
      row.pointer("/templateId").and_then(|v| v.as_str()) == Some(tpl.to_string().as_str())
        && row.pointer("/isDefault").and_then(Value::as_bool) == Some(false)
    }));

    // Non-admin sessions must be rejected on the listing too.
    let (bobby_id, bobby_session) = helpers::seed_user(&pool, &auth_store, "bobby").await;
    let bobby_listing = helpers::gql(
      &app,
      bobby_session,
      json!({
        "query": "query Q($ws: ID!) { admin { pdfWorkspaceAssignments(workspaceId: $ws) { templateId } } }",
        "variables": { "ws": ws.to_string() }
      }),
    )
    .await;
    assert!(
      !errors_array(&bobby_listing).is_empty(),
      "INV-PDF-GQL-05: non-admin must be rejected on pdfWorkspaceAssignments: {bobby_listing}"
    );

    // Cleanup
    cleanup_workspace(&pool, ws).await;
    cleanup_template(&pool, tpl).await;
    for uid in [alice_id, bobby_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-06 — set_default unsets previous default and updates brand row
// ---------------------------------------------------------------------------

#[test]
fn inv_gql06_set_default_unsets_previous_default() {
  helpers::block_on_large_stack("inv-gql06-set-default", || async {
    let (app, pool, auth_store) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;

    let ws = helpers::create_workspace(&pool, alice_id).await;
    let tpl_first = insert_template(&pool, "tpl-gql06-first", "First", admin_id).await;
    let tpl_second = insert_template(&pool, "tpl-gql06-second", "Second", admin_id).await;

    // Assign both, then make the first one the default.
    for tpl in [tpl_first, tpl_second] {
      let body = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!, $tpl: ID!) { admin { assignPdfTemplateToWorkspace(workspaceId: $ws, templateId: $tpl) { templateId } } }",
        "variables": { "ws": ws.to_string(), "tpl": tpl.to_string() }
      }),
    )
    .await;
      assert!(body.get("errors").is_none(), "assign must succeed: {body}");
    }

    let set_first = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { setWorkspaceDefaultPdfTemplate(workspaceId: $ws, templateId: $tpl) { workspaceId defaultTemplateId } } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl_first.to_string() }
    }),
  )
  .await;
    assert!(
      set_first.get("errors").is_none(),
      "INV-PDF-GQL-06: setting first default must succeed: {set_first}"
    );
    assert_eq!(
      set_first
        .pointer("/data/admin/setWorkspaceDefaultPdfTemplate/defaultTemplateId")
        .and_then(|v| v.as_str()),
      Some(tpl_first.to_string().as_str())
    );
    assert_eq!(assignment_is_default(&pool, ws, tpl_first).await, Some(true));
    assert_eq!(assignment_is_default(&pool, ws, tpl_second).await, Some(false));
    assert_eq!(brand_default_template(&pool, ws).await, Some(tpl_first));

    // Switch the default to the second template.
    let set_second = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { setWorkspaceDefaultPdfTemplate(workspaceId: $ws, templateId: $tpl) { defaultTemplateId } } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl_second.to_string() }
    }),
  )
  .await;
    assert!(
      set_second.get("errors").is_none(),
      "INV-PDF-GQL-06: switching default must succeed: {set_second}"
    );

    // The previous default must be cleared and the new one set — preserving the
    // partial-unique-index invariant `uniq_default_per_ws`.
    assert_eq!(
      assignment_is_default(&pool, ws, tpl_first).await,
      Some(false),
      "INV-PDF-GQL-06: previous default must be cleared"
    );
    assert_eq!(
      assignment_is_default(&pool, ws, tpl_second).await,
      Some(true),
      "INV-PDF-GQL-06: new default must be set"
    );
    let default_count: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND is_default = true",
    )
    .bind(ws)
    .fetch_one(&pool)
    .await
    .expect("count defaults");
    assert_eq!(
      default_count, 1,
      "INV-PDF-GQL-06: at most one default per workspace (partial unique index)"
    );
    assert_eq!(
      brand_default_template(&pool, ws).await,
      Some(tpl_second),
      "INV-PDF-GQL-06: brand_assets mirror must update in lock step"
    );

    // Setting a default for a template that is NOT assigned must fail.
    let tpl_unassigned = insert_template(&pool, "tpl-gql06-unassigned", "Unassigned", admin_id).await;
    let bad = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { setWorkspaceDefaultPdfTemplate(workspaceId: $ws, templateId: $tpl) { defaultTemplateId } } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl_unassigned.to_string() }
    }),
  )
  .await;
    assert!(
      !errors_array(&bad).is_empty(),
      "INV-PDF-GQL-06: cannot make an unassigned template the default: {bad}"
    );

    // Cleanup
    cleanup_workspace(&pool, ws).await;
    for tpl in [tpl_first, tpl_second, tpl_unassigned] {
      cleanup_template(&pool, tpl).await;
    }
    for uid in [alice_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}

// ---------------------------------------------------------------------------
// INV-PDF-GQL-07 — unassign refused while default
// ---------------------------------------------------------------------------

#[test]
fn inv_gql07_unassign_blocked_when_default() {
  helpers::block_on_large_stack("inv-gql07-unassign-default", || async {
    let (app, pool, auth_store) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;

    let ws = helpers::create_workspace(&pool, alice_id).await;
    let tpl_default = insert_template(&pool, "tpl-gql07-default", "Default", admin_id).await;
    let tpl_other = insert_template(&pool, "tpl-gql07-other", "Other", admin_id).await;

    for tpl in [tpl_default, tpl_other] {
      helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!, $tpl: ID!) { admin { assignPdfTemplateToWorkspace(workspaceId: $ws, templateId: $tpl) { templateId } } }",
        "variables": { "ws": ws.to_string(), "tpl": tpl.to_string() }
      }),
    )
    .await;
    }

    // Make tpl_default the workspace default.
    let set = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { setWorkspaceDefaultPdfTemplate(workspaceId: $ws, templateId: $tpl) { defaultTemplateId } } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl_default.to_string() }
    }),
  )
  .await;
    assert!(set.get("errors").is_none(), "set default must succeed: {set}");

    // Unassign the default → must be refused, row must still exist.
    let bad = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { unassignPdfTemplateFromWorkspace(workspaceId: $ws, templateId: $tpl) } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl_default.to_string() }
    }),
  )
  .await;
    let bad_errors = errors_array(&bad);
    assert!(
      !bad_errors.is_empty(),
      "INV-PDF-GQL-07: unassigning default must be refused: {bad}"
    );
    assert!(
      bad_errors.iter().any(|m| m.contains("default")),
      "INV-PDF-GQL-07: error message must mention the default constraint: {bad_errors:?}"
    );
    assert_eq!(
      assignment_is_default(&pool, ws, tpl_default).await,
      Some(true),
      "INV-PDF-GQL-07: refused unassign must not modify the row"
    );

    // Unassigning the non-default sibling must work.
    let ok = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { unassignPdfTemplateFromWorkspace(workspaceId: $ws, templateId: $tpl) } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl_other.to_string() }
    }),
  )
  .await;
    assert!(ok.get("errors").is_none(), "non-default unassign must succeed: {ok}");
    assert_eq!(
      ok.pointer("/data/admin/unassignPdfTemplateFromWorkspace")
        .and_then(|v| v.as_bool()),
      Some(true)
    );
    assert_eq!(
      assignment_is_default(&pool, ws, tpl_other).await,
      None,
      "INV-PDF-GQL-07: non-default sibling row must be removed"
    );

    // After clearing the default by re-pointing it to the still-assigned
    // template (none other left), set the default away from tpl_default by
    // re-assigning tpl_other and making it default; then unassign tpl_default.
    helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { assignPdfTemplateToWorkspace(workspaceId: $ws, templateId: $tpl) { templateId } } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl_other.to_string() }
    }),
  )
  .await;
    helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { setWorkspaceDefaultPdfTemplate(workspaceId: $ws, templateId: $tpl) { defaultTemplateId } } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl_other.to_string() }
    }),
  )
  .await;
    let final_unassign = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $tpl: ID!) { admin { unassignPdfTemplateFromWorkspace(workspaceId: $ws, templateId: $tpl) } }",
      "variables": { "ws": ws.to_string(), "tpl": tpl_default.to_string() }
    }),
  )
  .await;
    assert!(
      final_unassign.get("errors").is_none(),
      "INV-PDF-GQL-07: after losing default, the formerly-default row can be unassigned: {final_unassign}"
    );

    // Cleanup
    cleanup_workspace(&pool, ws).await;
    for tpl in [tpl_default, tpl_other] {
      cleanup_template(&pool, tpl).await;
    }
    for uid in [alice_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}
