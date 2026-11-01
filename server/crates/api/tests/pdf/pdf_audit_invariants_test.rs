// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-28-{04..06}` invariant tests for the PDF-Export-V2 admin
//! audit trail.
//!
//! These three tests close the audit-log coverage gap left after
//! `P-PDF-TPL-07/08/09/FONT-01` — the *mutations* already emit
//! `pdf_*.{action}` events (verified individually in
//! `pdf_template_admin_test.rs` / `pdf_brand_admin_test.rs` /
//! `pdf_font_lifecycle_test.rs`) but the **shape** of those events —
//! actor, before-state, after-state — was never asserted as a separate
//! invariant. P-PDF-TPL-28 makes the shape load-bearing.
//!
//! Naming follows the `inv_audit_{nn}_{description}` convention so the
//! tests slot into the same admin_audit_log family as
//! `inv_audit_log_test.rs`.
//!
//! - `INV-AUDIT-PDF-04` (`P-PDF-TPL-28-04`):
//!   `uploadPdfTemplate` must create an `admin_audit_log` row with
//!   `event_key = 'pdf_template.upload'`,
//!   `category = 'pdf_export_config'`, and `actor_user_id = <admin>`.
//!   The existing `inv_gql01_template_upload_persists_files_and_audit_log`
//!   asserts presence; this re-asserts it from the audit-shape angle so
//!   future drift in either test catches the regression.
//!
//! - `INV-AUDIT-PDF-05` (`P-PDF-TPL-28-05`):
//!   `updateDocumentBrandingColors` records both `old_value` and `new_value`.
//!   Two consecutive calls must produce two audit rows whose
//!   `old_value.primary` matches the prior call's `new_value.primary`.
//!   This is the load-bearing forensic property — admins must be able to
//!   reconstruct the brand-colour timeline from the audit log alone.
//!
//! - `INV-AUDIT-PDF-06` (`P-PDF-TPL-28-06`):
//!   `approvePdfFont` records the calling admin's user-id in
//!   `actor_user_id`. The transition itself is already audited (see
//!   `pdf_font::transition_status`); this invariant guards against
//!   accidental anonymisation of the actor field.
//!
//! - `INV-AUDIT-PDF-07` (`P-PDF-TPL-28-07`):
//!   `rejectPdfFont` requires an operator reason and persists it in
//!   `admin_audit_log.new_value.reason`, so the UI-level rejection note is
//!   not lost between the admin action and forensic review.

#![allow(clippy::too_many_lines)]

use crate::helpers;
use futures_util::FutureExt;
use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::Row;
use uuid::Uuid;

use myoxus_application::audit::AuditRecorder;
use myoxus_infrastructure::audit::PgAuditLogStore;
use myoxus_infrastructure::pdf_export::{
  PdfBlobStore, PgPdfFontRepository, PgPdfTemplateRepository, PgPdfWorkspaceBrandAssetRepository,
  PgPdfWorkspaceTemplateAssignmentRepository,
};
use myoxus_infrastructure::storage::StorageAdapter;

// ---------------------------------------------------------------------------
// Test app builder. Mirrors the pattern from the other PDF admin tests but
// wires every PDF-V2 repo + the real audit recorder so any of the audit
// invariants can be exercised against a single router instance.
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
  // Per-test storage dir to keep concurrent test runs isolated.
  let storage_dir = format!("./test-storage/pdf-audit-{}", Uuid::new_v4());
  let storage_adapter = Arc::new(StorageAdapter::new_fs(&storage_dir).expect("storage"));
  let storage_op = storage_adapter.operator();
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
  let font_repo: Arc<dyn myoxus_domain::repositories::PdfFontRepository> =
    Arc::new(PgPdfFontRepository::new(pool.clone()));
  let pdf_blob_store = Arc::new(PdfBlobStore::new(storage_op));

  let audit_store: Arc<dyn myoxus_domain::audit::AuditLogStore> = Arc::new(PgAuditLogStore::new(pool.clone()));
  let audit_recorder = AuditRecorder::new(audit_store);

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
  .with_pdf_brand_repo(brand_repo)
  .with_pdf_font_repo(font_repo)
  .with_pdf_blob_store(pdf_blob_store)
  .with_audit_recorder(audit_recorder);

  (build_router(state), pool, auth_store)
}

// ---------------------------------------------------------------------------
// Cleanup helpers — every test must leave the DB unchanged so concurrent
// test runs do not see each other's audit rows / fonts / brand-asset rows.
// (`feedback_test_cleanup_mandatory`).
// ---------------------------------------------------------------------------

async fn cleanup_user(pool: &PgPool, user_id: Uuid) {
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("remove owned test rows");
}

async fn cleanup_workspace(pool: &PgPool, ws: Uuid) {
  sqlx::query("DELETE FROM pdf_export_settings WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM document_brand_profiles WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM brand_assets WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws)
    .execute(pool)
    .await
    .expect("remove owned test rows");
}

async fn cleanup_font(pool: &PgPool, font_id: Uuid) {
  let _ = sqlx::query("DELETE FROM pdf_fonts WHERE id = $1")
    .bind(font_id)
    .execute(pool)
    .await;
}

// ---------------------------------------------------------------------------
// INV-AUDIT-PDF-05 — updateDocumentBrandingColors records before-state and after-state
// ---------------------------------------------------------------------------
//
// Two consecutive calls must produce two audit rows whose `old_value` /
// `new_value` colour pair forms a contiguous timeline:
//
//   call 1: null      → primary = "#112233"   (before = null, after = #112233)
//   call 2: #112233   → primary = "#445566"   (before = #112233, after = #445566)
//
// The chained property — call N's `before` matches call N-1's `after` — is
// the load-bearing forensic invariant: an admin paging through the audit log
// must be able to reconstruct the colour timeline without joining anything
// else.

#[test]
fn inv_audit_pdf_05_document_branding_color_change_records_before_and_after() {
  helpers::block_on_large_stack("inv-audit-pdf-05-document-branding-colors", || async {
    let (app, pool, auth_store) = setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;
    let ws = helpers::create_workspace(&pool, alice_id).await;

    let call_update = |primary_value: Option<String>, accent_value: Option<String>| {
      let app = app.clone();
      async move {
        let body = helpers::gql(
        &app,
        admin_session,
        json!({
          "query": "mutation M($ws: ID!, $p: String, $a: String) { admin { updateDocumentBrandingColors(workspaceId: $ws, primary: $p, accent: $a) { workspaceId brandColorPrimary brandColorAccent } } }",
          "variables": { "ws": ws.to_string(), "p": primary_value, "a": accent_value }
        }),
      )
      .await;
        assert!(
          body.get("errors").is_none(),
          "updateDocumentBrandingColors must succeed: {body}"
        );
      }
    };

    // 1st change: null → custom pair
    call_update(Some("#112233".to_string()), Some("#445566".to_string())).await;
    // 2nd change: custom pair → custom pair
    call_update(Some("#445566".to_string()), Some("#778899".to_string())).await;

    // Pull the two audit rows in chronological order.
    let rows = sqlx::query(
      r#"SELECT old_value, new_value, created_at
       FROM admin_audit_log
       WHERE actor_user_id = $1 AND event_key = 'document_branding.update_colors'
       ORDER BY created_at ASC"#,
    )
    .bind(admin_id)
    .fetch_all(&pool)
    .await
    .expect("DB query failed");

    assert_eq!(
      rows.len(),
      2,
      "INV-AUDIT-PDF-05: expected exactly 2 document_branding.update_colors audit rows for this admin, got {}",
      rows.len()
    );

    // Row 1: before pair is the effective seeded workspace branding snapshot;
    // the resolver materializes this default so audit consumers can see the
    // complete forensic transition instead of a partial "null -> custom"
    // placeholder. Row 2 below then proves the previous custom value is carried
    // forward unchanged.
    let before1: Value = rows[0].try_get("old_value").expect("old_value");
    let after1: Value = rows[0].try_get("new_value").expect("new_value");
    let before1_primary = before1.get("primary").and_then(|v| v.as_str());
    let before1_accent = before1.get("accent").and_then(|v| v.as_str());
    assert!(
      before1_primary.is_some() && before1_accent.is_some(),
      "INV-AUDIT-PDF-05: row 1 before must contain the effective seeded branding pair, got {before1}"
    );
    assert_ne!(
      before1_primary,
      Some("#112233"),
      "INV-AUDIT-PDF-05: row 1 before.primary must be the prior value, not the requested value: {before1}"
    );
    assert_eq!(
      after1.get("primary").and_then(|v| v.as_str()),
      Some("#112233"),
      "INV-AUDIT-PDF-05: row 1 after.primary must be #112233, got {after1}"
    );
    assert_eq!(
      after1.get("accent").and_then(|v| v.as_str()),
      Some("#445566"),
      "INV-AUDIT-PDF-05: row 1 after.accent must be #445566, got {after1}"
    );

    // Row 2: before pair equals row 1 after; after pair is complete again.
    let before2: Value = rows[1].try_get("old_value").expect("old_value");
    let after2: Value = rows[1].try_get("new_value").expect("new_value");
    assert_eq!(
      before2.get("primary").and_then(|v| v.as_str()),
      Some("#112233"),
      "INV-AUDIT-PDF-05: row 2 before.primary must equal row 1 after.primary, got {before2}"
    );
    assert_eq!(
      after2.get("primary").and_then(|v| v.as_str()),
      Some("#445566"),
      "INV-AUDIT-PDF-05: row 2 after.primary must be #445566, got {after2}"
    );
    assert_eq!(
      before2.get("accent").and_then(|v| v.as_str()),
      Some("#445566"),
      "INV-AUDIT-PDF-05: row 2 before.accent must equal row 1 after.accent, got {before2}"
    );
    assert_eq!(
      after2.get("accent").and_then(|v| v.as_str()),
      Some("#778899"),
      "INV-AUDIT-PDF-05: row 2 after.accent must be #778899, got {after2}"
    );

    // Cleanup
    cleanup_workspace(&pool, ws).await;
    for uid in [alice_id, admin_id] {
      cleanup_user(&pool, uid).await;
    }
  });
}

// ---------------------------------------------------------------------------
// INV-AUDIT-PDF-06 — approvePdfFont records the calling admin's actor id
// ---------------------------------------------------------------------------
//
// The mutation already records before+after status (see
// `pdf_font::transition_status`). This invariant guards the *actor* column
// — the calling admin must show up in `admin_audit_log.actor_user_id`, not
// `null`, so we can answer "who approved this font?" without trawling
// secondary logs.

#[tokio::test]
async fn inv_audit_pdf_06_font_approval_records_actor_user_id() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  // Seed a `pending` font directly so we don't have to ship a real font
  // file through the multipart pipeline. The approve mutation only reads
  // the row by id, transitions the status, and records an audit event.
  let font_id = Uuid::new_v4();
  let unique_sha = format!("audit06-{}", Uuid::new_v4().simple());
  sqlx::query(
    r#"INSERT INTO pdf_fonts (
         id, family_name, style, weight,
         license, license_status, blob_key, sha256,
         uploaded_by, uploaded_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, 'pending', $6, $7,
         $8, NOW()
       )"#,
  )
  .bind(font_id)
  .bind("AuditTest Sans")
  .bind("Regular")
  .bind(400_i32)
  .bind("OFL-1.1")
  .bind(format!("pdf-fonts/{unique_sha}.ttf"))
  .bind(&unique_sha)
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("seed pending font");

  // Call approvePdfFont as the admin.
  let body = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($id: ID!) { admin { approvePdfFont(id: $id) { id licenseStatus } } }",
      "variables": { "id": font_id.to_string() }
    }),
  )
  .await;
  assert!(body.get("errors").is_none(), "approvePdfFont must succeed: {body}");
  let new_status = body
    .pointer("/data/admin/approvePdfFont/licenseStatus")
    .and_then(|v| v.as_str())
    .expect("licenseStatus on response");
  assert_eq!(
    new_status, "Approved",
    "INV-AUDIT-PDF-06: status must transition to Approved, got {new_status}"
  );

  // Assert: admin_audit_log row exists for `pdf_font.approve` AND
  // its `actor_user_id` is the calling admin.
  let row = sqlx::query(
    r#"SELECT actor_user_id, event_key, category, old_value, new_value
       FROM admin_audit_log
       WHERE event_key = 'pdf_font.approve' AND target_id = $1
       ORDER BY created_at DESC LIMIT 1"#,
  )
  .bind(font_id.to_string())
  .fetch_optional(&pool)
  .await
  .expect("DB query failed")
  .expect("INV-AUDIT-PDF-06: pdf_font.approve audit row must exist");

  let actor: Option<Uuid> = row.try_get("actor_user_id").expect("actor_user_id column");
  assert_eq!(
    actor,
    Some(admin_id),
    "INV-AUDIT-PDF-06: actor_user_id must be the calling admin"
  );
  let category: String = row.try_get("category").expect("category column");
  assert_eq!(
    category, "pdf_export_config",
    "INV-AUDIT-PDF-06: category must be pdf_export_config, got {category}"
  );

  // Bonus: verify before/after carry the status transition. The shape
  // is `licenseStatus` (string).
  let before: Value = row.try_get("old_value").expect("old_value");
  let after: Value = row.try_get("new_value").expect("new_value");
  assert_eq!(
    before.get("licenseStatus").and_then(|v| v.as_str()),
    Some("pending"),
    "INV-AUDIT-PDF-06: before.licenseStatus must be 'pending', got {before}"
  );
  assert_eq!(
    after.get("licenseStatus").and_then(|v| v.as_str()),
    Some("approved"),
    "INV-AUDIT-PDF-06: after.licenseStatus must be 'approved', got {after}"
  );

  // Cleanup
  cleanup_font(&pool, font_id).await;
  cleanup_user(&pool, admin_id).await;
}

// ---------------------------------------------------------------------------
// INV-AUDIT-PDF-07 — rejectPdfFont records the required operator reason
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_audit_pdf_07_font_reject_records_reason() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  let font_id = Uuid::new_v4();
  let unique_sha = format!("audit07-{}", Uuid::new_v4().simple());
  sqlx::query(
    r#"INSERT INTO pdf_fonts (
         id, family_name, style, weight,
         license, license_status, blob_key, sha256,
         uploaded_by, uploaded_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, 'pending', $6, $7,
         $8, NOW()
       )"#,
  )
  .bind(font_id)
  .bind("AuditReject Sans")
  .bind("Regular")
  .bind(400_i32)
  .bind("custom")
  .bind(format!("pdf-fonts/{unique_sha}.ttf"))
  .bind(&unique_sha)
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("seed pending font");

  let reason = "License terms do not permit server-side embedding";
  let body = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($id: ID!, $reason: String!) { admin { rejectPdfFont(id: $id, reason: $reason) { id licenseStatus } } }",
      "variables": { "id": font_id.to_string(), "reason": reason }
    }),
  )
  .await;
  assert!(body.get("errors").is_none(), "rejectPdfFont must succeed: {body}");
  assert_eq!(
    body
      .pointer("/data/admin/rejectPdfFont/licenseStatus")
      .and_then(|v| v.as_str()),
    Some("Rejected"),
    "INV-AUDIT-PDF-07: response must report Rejected"
  );

  let row = sqlx::query(
    r#"SELECT actor_user_id, new_value
       FROM admin_audit_log
       WHERE event_key = 'pdf_font.reject' AND target_id = $1
       ORDER BY created_at DESC LIMIT 1"#,
  )
  .bind(font_id.to_string())
  .fetch_optional(&pool)
  .await
  .expect("DB query failed")
  .expect("INV-AUDIT-PDF-07: pdf_font.reject audit row must exist");

  let actor: Option<Uuid> = row.try_get("actor_user_id").expect("actor_user_id column");
  assert_eq!(
    actor,
    Some(admin_id),
    "INV-AUDIT-PDF-07: actor_user_id must be the calling admin"
  );
  let after: Value = row.try_get("new_value").expect("new_value");
  assert_eq!(
    after.get("licenseStatus").and_then(|v| v.as_str()),
    Some("rejected"),
    "INV-AUDIT-PDF-07: after.licenseStatus must be rejected, got {after}"
  );
  assert_eq!(
    after.get("reason").and_then(|v| v.as_str()),
    Some(reason),
    "INV-AUDIT-PDF-07: audit reason must preserve the operator note, got {after}"
  );

  cleanup_font(&pool, font_id).await;
  cleanup_user(&pool, admin_id).await;
}

// ---------------------------------------------------------------------------
// INV-AUDIT-PDF-04 — setWorkspaceDefaultPdfTemplate records previous AND new
//                    default-template-id (`P-PDF-TPL-28-03` shape check)
// ---------------------------------------------------------------------------
//
// Originally tracked as 28-04 (template_upload audit shape) — but
// `inv_gql01_template_upload_persists_files_and_audit_log` already covers
// the upload path. The genuinely uncovered shape was the `set_default`
// mutation: prior to this Mikropaket the audit emitted only the *new*
// template id, dropping the previous default. Set two different defaults
// in sequence and assert the second event surfaces the first as
// `old_value.previousTemplateId`.

#[tokio::test]
async fn inv_audit_pdf_04_set_default_template_records_previous_and_new() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (alice_id, _alice_session) = helpers::seed_user(&pool, &auth_store, "alice").await;
  let ws = helpers::create_workspace(&pool, alice_id).await;

  // Two distinct templates so the two defaults are detectably different.
  // Slugs must be globally unique per `idx_pdf_templates_slug_active`, so
  // we suffix with a random nonce to keep concurrent test runs isolated.
  let nonce = Uuid::new_v4().simple();
  let slug_a = format!("audit04-a-{nonce}");
  let slug_b = format!("audit04-b-{nonce}");
  let tpl_a = insert_template(&pool, &slug_a, admin_id).await;
  let tpl_b = insert_template(&pool, &slug_b, admin_id).await;

  let result = std::panic::AssertUnwindSafe(async {
  // Both must be assigned to the workspace before `setDefault` can target them.
  for tpl in [tpl_a, tpl_b] {
    let body = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($ws: ID!, $t: ID!) { admin { assignPdfTemplateToWorkspace(workspaceId: $ws, templateId: $t) { templateId } } }",
        "variables": { "ws": ws.to_string(), "t": tpl.to_string() }
      }),
    )
    .await;
    assert!(body.get("errors").is_none(), "assign must succeed: {body}");
  }

  // Workspace creation can seed an assigned default before a settings mirror.
  let previous: Option<Uuid> = sqlx::query_scalar(
    "SELECT template_id FROM pdf_workspace_template_assignments WHERE workspace_id=$1 AND is_default=true",
  )
  .bind(ws)
  .fetch_optional(&pool)
  .await
  .expect("read actual initial default");
  let body1 = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $t: ID!) { admin { setWorkspaceDefaultPdfTemplate(workspaceId: $ws, templateId: $t) { workspaceId } } }",
      "variables": { "ws": ws.to_string(), "t": tpl_a.to_string() }
    }),
  )
  .await;
  assert!(body1.get("errors").is_none(), "set_default a must succeed: {body1}");

  // 2nd default: previous = tpl_a, new = tpl_b
  let body2 = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation M($ws: ID!, $t: ID!) { admin { setWorkspaceDefaultPdfTemplate(workspaceId: $ws, templateId: $t) { workspaceId } } }",
      "variables": { "ws": ws.to_string(), "t": tpl_b.to_string() }
    }),
  )
  .await;
  assert!(body2.get("errors").is_none(), "set_default b must succeed: {body2}");

  // Pull the two `set_default` audit rows in order.
  let rows = sqlx::query(
    r#"SELECT old_value, new_value, created_at
       FROM admin_audit_log
       WHERE actor_user_id = $1 AND event_key = 'pdf_workspace.set_default'
       ORDER BY created_at ASC"#,
  )
  .bind(admin_id)
  .fetch_all(&pool)
  .await
  .expect("DB query failed");
  assert_eq!(
    rows.len(),
    2,
    "INV-AUDIT-PDF-04: expected 2 set_default audit rows, got {}",
    rows.len()
  );

  // Row 1 records the actual initial default, including seeded assignments.
  let before1: Value = rows[0].try_get("old_value").expect("old_value");
  let after1: Value = rows[0].try_get("new_value").expect("new_value");
  assert_eq!(
    before1.get("previousTemplateId"),
    Some(&json!(previous)),
    "INV-AUDIT-PDF-04: row 1 before must match the actual prior default"
  );
  assert_eq!(
    after1.get("templateId").and_then(|v| v.as_str()),
    Some(tpl_a.to_string()).as_deref(),
    "INV-AUDIT-PDF-04: row 1 after.templateId must be tpl_a, got {after1}"
  );

  // Row 2: previousTemplateId = tpl_a (the row 1 after), templateId = tpl_b
  let before2: Value = rows[1].try_get("old_value").expect("old_value");
  let after2: Value = rows[1].try_get("new_value").expect("new_value");
  assert_eq!(
    before2.get("previousTemplateId").and_then(|v| v.as_str()),
    Some(tpl_a.to_string()).as_deref(),
    "INV-AUDIT-PDF-04: row 2 before.previousTemplateId must equal row 1 after.templateId, got {before2}"
  );
  assert_eq!(
    after2.get("templateId").and_then(|v| v.as_str()),
    Some(tpl_b.to_string()).as_deref(),
    "INV-AUDIT-PDF-04: row 2 after.templateId must be tpl_b, got {after2}"
  );

  }).catch_unwind().await;

  // Cleanup
  let _ = sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
    .bind(ws)
    .execute(&pool)
    .await;
  cleanup_workspace(&pool, ws).await;
  for tpl in [tpl_a, tpl_b] {
    let _ = sqlx::query("DELETE FROM pdf_template_files WHERE template_id = $1")
      .bind(tpl)
      .execute(&pool)
      .await;
    let _ = sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
      .bind(tpl)
      .execute(&pool)
      .await;
  }
  for uid in [alice_id, admin_id] {
    cleanup_user(&pool, uid).await;
  }
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

/// Insert a minimal PDF template directly into the DB so we don't need to
/// run a full multipart upload roundtrip just to get a valid `pdf_templates`
/// row. The manifest is a stub that satisfies the JSON schema; the V2 hot
/// path never reads this template at render time.
async fn insert_template(pool: &PgPool, slug: &str, created_by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  let manifest = json!({
    "schema_version": "2.0",
    "id": slug,
    "name": slug,
    "version": "1.0.0",
    "engine": { "name": "typst", "version": "0.15.x" },
    "provenance": {
      "license_spdx": "AGPL-3.0-or-later",
      "copyright_notice": "Copyright 2026 Myoxus test contributors",
      "source_url": "https://example.test/templates/pdf-audit",
      "source_revision": "1.0.0"
    },
    "entry": "main.typ",
    "assets": ["main.typ"],
    "capabilities": {}
  });
  sqlx::query(
    r#"INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())"#,
  )
  .bind(id)
  .bind(slug)
  .bind(slug)
  .bind("1.0.0")
  .bind("2.0")
  .bind(&manifest)
  .bind(created_by)
  .execute(pool)
  .await
  .expect("insert pdf_templates");
  id
}

#[tokio::test]
async fn template_metadata_partial_writes_preserve_each_other_and_the_locked_audit_chain() {
  use myoxus_domain::audit::AuditActor;
  use myoxus_domain::repositories::PdfTemplateRepository;
  let (_app, pool, auth) = setup_app().await;
  let (admin, _session) = helpers::seed_admin(&pool, &auth).await;
  let id = insert_template(&pool, &format!("audit-partial-{}", Uuid::new_v4()), admin).await;
  let repo = PgPdfTemplateRepository::new(pool.clone());
  let result=std::panic::AssertUnwindSafe(async {
    let original=repo.get_by_id(id).await.unwrap().unwrap();
    let (name,description)=tokio::join!(
      repo.update_metadata(id,Some("Parallel name"),None,Some(AuditActor::user(admin,None))),
      repo.update_metadata(id,None,Some("Parallel description"),Some(AuditActor::user(admin,None))));
    name.expect("name write");description.expect("description write");
    let row=repo.get_by_id(id).await.unwrap().unwrap();
    assert_eq!(row.name,"Parallel name");assert_eq!(row.manifest["name"],"Parallel name");
    assert_eq!(row.manifest["description"],"Parallel description");
    assert_eq!(row.manifest["capabilities"],original.manifest["capabilities"]);
    let chain:Vec<(Value,Value)>=sqlx::query_as("SELECT old_value,new_value FROM admin_audit_log WHERE target_id=$1 AND event_key='pdf_template.update_metadata' ORDER BY created_at,id")
      .bind(id.to_string()).fetch_all(&pool).await.unwrap();
    assert_eq!(chain.len(),2);
    // Transaction start timestamps do not establish row-lock acquisition order.
    let first=chain.iter().position(|(old,_)|old["name"]==original.name && old["description"].is_null()).expect("audit starts at the original row");
    let last=&chain[1-first];
    assert_eq!(last.0["name"],chain[first].1["name"]);
    assert_eq!(last.0["description"],chain[first].1["description"]);
    assert_eq!(last.1["name"],row.name);
    assert_eq!(last.1["description"],row.manifest["description"]);
  }).catch_unwind().await;
  sqlx::query("DELETE FROM pdf_templates WHERE id=$1")
    .bind(id)
    .execute(&pool)
    .await
    .expect("remove template");
  cleanup_user(&pool, admin).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic)
  }
}
