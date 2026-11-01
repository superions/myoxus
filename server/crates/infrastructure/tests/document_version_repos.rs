// SPDX-License-Identifier: AGPL-3.0-or-later
//! Repository-layer invariant tests for the document-versioning subsystem.
//!
//! These tests verify that the SQLx implementations of
//! [`DocumentVersionRepository`] and [`DocumentVersioningSettingsRepository`]
//! uphold the invariants documented in P-DOC-VER-01:
//!
//! - `inv_docver01`: Created version rows are persisted with the correct
//!   `doc_history_id` link.
//! - `inv_docver02`: The UNIQUE(doc_id, label) constraint is enforced at the
//!   repository layer (returns `RepositoryError::Conflict`).
//! - `inv_docver03`: Deleting the parent doc removes all `document_version`
//!   rows via CASCADE.
//! - `inv_docver04`: GC prunes only old unpinned label rows and keeps
//!   underlying `doc_histories` snapshots.
//!
//! All tests are self-contained and clean up their own artefacts.
//!
//! Mikropaket: P-DOC-VER-01

use chrono::Duration;
use chrono::Utc;
use futures_util::FutureExt;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::panic::AssertUnwindSafe;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;
use uuid::Uuid;
use yrs::{Doc, Text, Transact};

use myoxus_application::doc::DocService;
use myoxus_application::document_version::{
  DocumentEditCaptureRepository, DocumentHistorySaveRequest, DocumentVersionCreateService, GlobalEditCaptureSettings,
};
use myoxus_domain::entities::{
  AutoVersionTrigger, DocumentVersion, DocumentVersionCreateInput, DocumentVersionKind,
  WorkspaceEditCaptureSettingsPatch,
};
use myoxus_domain::repositories::{DocumentVersionRepository, DocumentVersioningSettingsRepository, RepositoryError};
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_version::{
  ConfigValuesReader, PgDocumentEditCaptureRepository, PgDocumentVersionRepository,
  PgDocumentVersioningSettingsRepository,
};

async fn setup_pool() -> PgPool {
  let url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  PgPoolOptions::new()
    .max_connections(2)
    .acquire_timeout(std::time::Duration::from_secs(30))
    .connect(&url)
    .await
    .expect("test DB connection failed")
}

async fn insert_history(pool: &PgPool, ws_id: Uuid, doc_id: Uuid, marker: &str) -> i64 {
  sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3) RETURNING id")
    .bind(doc_id)
    .bind(ws_id)
    .bind(marker.as_bytes())
    .fetch_one(pool)
    .await
    .expect("insert doc_history")
}

/// Seed helper: creates a user, workspace, doc, and doc_history row.
/// Returns `(user_id, workspace_id, doc_id, history_id)`.
async fn seed_base(pool: &PgPool) -> (Uuid, Uuid, Uuid, i64) {
  let user_id: Uuid = sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'RepoTest') RETURNING id")
    .bind(format!("docver-repo-{}@test.invalid", Uuid::new_v4()))
    .fetch_one(pool)
    .await
    .expect("insert user");

  let ws_id: Uuid =
    sqlx::query_scalar("INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'RepoTest WS') RETURNING id")
      .bind(user_id)
      .fetch_one(pool)
      .await
      .expect("insert workspace");

  let doc_id: Uuid = sqlx::query_scalar(
    "INSERT INTO docs (workspace_id, title, created_by) VALUES ($1, 'RepoTest Doc', $2) RETURNING id",
  )
  .bind(ws_id)
  .bind(user_id)
  .fetch_one(pool)
  .await
  .expect("insert doc");

  let history_id: i64 =
    sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3) RETURNING id")
      .bind(doc_id)
      .bind(ws_id)
      .bind(b"snap" as &[u8])
      .fetch_one(pool)
      .await
      .expect("insert doc_history");

  (user_id, ws_id, doc_id, history_id)
}

/// Cleanup helper: removes all seeded artefacts in reverse FK order.
async fn cleanup(pool: &PgPool, doc_id: Uuid, ws_id: Uuid, user_id: Uuid) {
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .ok();
}

fn text_update(content: &str) -> Vec<u8> {
  let doc = Doc::new();
  let text = doc.get_or_insert_text("content");
  let mut tx = doc.transact_mut();
  text.insert(&mut tx, 0, content);
  tx.encode_update_v1()
}

async fn seed_edit_capture_state(pool: &PgPool, content: &[u8]) -> (Uuid, Uuid, Uuid) {
  let (user_id, ws_id, doc_id, _) = seed_base(pool).await;
  sqlx::query("UPDATE docs SET external_id = $2, is_workspace_root = false WHERE id = $1")
    .bind(doc_id)
    .bind(format!("capture-{doc_id}"))
    .execute(pool)
    .await
    .expect("make document eligible for capture");
  sqlx::query("INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence) VALUES ($1, $2, $3, 1)")
    .bind(ws_id)
    .bind(doc_id)
    .bind(content)
    .execute(pool)
    .await
    .expect("insert persisted content");
  sqlx::query(
    "INSERT INTO document_edit_capture_state (workspace_id, doc_id, dirty_revision)
     VALUES ($1, $2, 1)",
  )
  .bind(ws_id)
  .bind(doc_id)
  .execute(pool)
  .await
  .expect("insert capture intent");
  (user_id, ws_id, doc_id)
}

fn make_version(
  doc_id: Uuid,
  ws_id: Uuid,
  history_id: i64,
  label: String,
  created_by: Uuid,
  created_at: chrono::DateTime<Utc>,
) -> DocumentVersion {
  DocumentVersion::new_for_create(DocumentVersionCreateInput {
    id: Uuid::new_v4(),
    doc_id,
    workspace_id: ws_id,
    doc_history_id: history_id,
    label,
    description: None,
    event: myoxus_domain::entities::DocumentVersionEvent::Manual,
    kind: DocumentVersionKind::Checkpoint,
    created_by,
    created_at,
    is_pinned: false,
    is_protected: false,
    policy_id: None,
    policy_snapshot: serde_json::json!({}),
    content_hash: None,
    metadata: serde_json::json!({}),
  })
}

#[tokio::test]
async fn explicit_history_save_is_unnamed_or_exactly_named_and_replay_safe() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let (user_id, ws_id, doc_id, _) = seed_base(&pool).await;
  let history = Arc::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
  let service = DocumentVersionCreateService::new(history, Arc::new(PgDocumentVersionRepository::new(pool.clone())));

  let unnamed_key = Uuid::new_v4();
  let unnamed = service
    .save_current(DocumentHistorySaveRequest {
      doc_id,
      workspace_id: ws_id,
      actor_id: user_id,
      request_key: unnamed_key,
      name: Some("   ".into()),
      description: None,
    })
    .await
    .expect("save unnamed state");
  assert!(unnamed.version.is_none());
  assert!(!unnamed.replayed);
  let replay = service
    .save_current(DocumentHistorySaveRequest {
      doc_id,
      workspace_id: ws_id,
      actor_id: user_id,
      request_key: unnamed_key,
      name: None,
      description: None,
    })
    .await
    .expect("replay unnamed state");
  assert_eq!(replay.history_id, unnamed.history_id);
  assert!(replay.replayed);

  let mismatched = service
    .save_current(DocumentHistorySaveRequest {
      doc_id,
      workspace_id: ws_id,
      actor_id: user_id,
      request_key: unnamed_key,
      name: Some("different".into()),
      description: None,
    })
    .await
    .expect_err("request-key reuse with different input must conflict");
  assert!(mismatched.to_string().contains("different input"));

  let invalid_description = service
    .save_current(DocumentHistorySaveRequest {
      doc_id,
      workspace_id: ws_id,
      actor_id: user_id,
      request_key: Uuid::new_v4(),
      name: None,
      description: Some("not valid without a name".into()),
    })
    .await
    .expect_err("unnamed descriptions must not be silently discarded");
  assert!(invalid_description.to_string().contains("only valid for a named"));

  let named = service
    .save_current(DocumentHistorySaveRequest {
      doc_id,
      workspace_id: ws_id,
      actor_id: user_id,
      request_key: Uuid::new_v4(),
      name: Some("Release candidate".into()),
      description: Some("Ready for review".into()),
    })
    .await
    .expect("save named state");
  let version = named.version.expect("named save creates a version reference");
  assert_eq!(
    version.label, "Release-candidate",
    "explicit labels retain the established validation/normalization path instead of a policy counter"
  );
  assert_eq!(version.description.as_deref(), Some("Ready for review"));
  assert_eq!(version.doc_history_id, named.history_id);

  let provenance: (Option<String>, Option<Uuid>) =
    sqlx::query_as("SELECT origin, actor_id FROM doc_histories WHERE id = $1")
      .bind(unnamed.history_id)
      .fetch_one(&pool)
      .await
      .expect("read unnamed provenance");
  assert_eq!(provenance, (Some("manual".into()), Some(user_id)));
  let request_count: i64 =
    sqlx::query_scalar("SELECT count(*) FROM document_history_capture_request WHERE workspace_id = $1 AND doc_id = $2")
      .bind(ws_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("count capture requests");
  assert_eq!(
    request_count, 2,
    "replay and rejected input must not create request rows"
  );

  cleanup(&pool, doc_id, ws_id, user_id).await;
}

// ---------------------------------------------------------------------------
// inv_docver01_create_persists_with_history_link
// ---------------------------------------------------------------------------
// Invariant: After `create()`, `get(id)` returns the row with the correct
// `doc_history_id` (i64 FK to doc_histories).
#[tokio::test]
async fn inv_docver01_create_persists_with_history_link() {
  myoxus_infrastructure::migrations::run(&setup_pool().await)
    .await
    .expect("migrate");
  let pool = setup_pool().await;
  let (user_id, ws_id, doc_id, history_id) = seed_base(&pool).await;
  let repo = PgDocumentVersionRepository::new(pool.clone());

  let mut version = make_version(
    doc_id,
    ws_id,
    history_id,
    format!("v1-{}", Uuid::new_v4().simple()),
    user_id,
    Utc::now(),
  );
  version.description = Some("initial version".to_string());

  repo.create(&version).await.expect("create must succeed");

  let fetched = repo
    .get(version.id)
    .await
    .expect("get must succeed")
    .expect("row must exist");

  assert_eq!(fetched.doc_history_id, history_id, "doc_history_id must match");
  assert_eq!(fetched.label, version.label, "label must round-trip");
  assert_eq!(fetched.description, version.description, "description must round-trip");

  cleanup(&pool, doc_id, ws_id, user_id).await;
}

#[tokio::test]
async fn inv_docver04_gc_keeps_pinned_protected_published_and_doc_history_snapshots() {
  myoxus_infrastructure::migrations::run(&setup_pool().await)
    .await
    .expect("migrate");
  let pool = setup_pool().await;
  let (user_id, ws_id, doc_id, first_history_id) = seed_base(&pool).await;
  let repo = PgDocumentVersionRepository::new(pool.clone());
  let base = Utc::now() - Duration::days(1);

  let versions = [
    (
      "pinned-old",
      first_history_id,
      true,
      false,
      DocumentVersionKind::Checkpoint,
      base,
    ),
    (
      "protected-old",
      insert_history(&pool, ws_id, doc_id, "protected").await,
      false,
      true,
      DocumentVersionKind::Checkpoint,
      base + Duration::seconds(1),
    ),
    (
      "published-old",
      insert_history(&pool, ws_id, doc_id, "published").await,
      false,
      false,
      DocumentVersionKind::Published,
      base + Duration::seconds(2),
    ),
    (
      "unpinned-old",
      insert_history(&pool, ws_id, doc_id, "old").await,
      false,
      false,
      DocumentVersionKind::Checkpoint,
      base + Duration::seconds(3),
    ),
    (
      "unpinned-middle",
      insert_history(&pool, ws_id, doc_id, "middle").await,
      false,
      false,
      DocumentVersionKind::Checkpoint,
      base + Duration::seconds(4),
    ),
    (
      "unpinned-new",
      insert_history(&pool, ws_id, doc_id, "new").await,
      false,
      false,
      DocumentVersionKind::Checkpoint,
      base + Duration::seconds(5),
    ),
  ];

  for (label, history_id, is_pinned, is_protected, kind, created_at) in versions {
    repo
      .create(&{
        let mut version = make_version(
          doc_id,
          ws_id,
          history_id,
          format!("{label}-{}", Uuid::new_v4().simple()),
          user_id,
          created_at,
        );
        version.is_pinned = is_pinned;
        version.is_protected = is_protected;
        version.kind = kind;
        version
      })
      .await
      .expect("create version");
  }

  let deleted = repo
    .gc_unpinned_older_than_count(doc_id, 1)
    .await
    .expect("gc unpinned versions");
  assert_eq!(deleted.len(), 2, "GC must prune old unpinned rows beyond retention");
  assert!(
    deleted
      .iter()
      .all(|version| !version.is_pinned && !version.is_protected && version.kind != DocumentVersionKind::Published),
    "GC must never return pinned, protected or published rows as deleted"
  );

  let remaining = repo.list_for_doc(doc_id).await.expect("list remaining versions");
  assert_eq!(
    remaining.len(),
    4,
    "pinned, protected, published + newest unprotected candidate must remain"
  );
  assert!(
    remaining.iter().any(|version| version.is_pinned),
    "pinned version must survive regardless of age"
  );
  assert!(
    remaining.iter().any(|version| version.is_protected),
    "protected version must survive regardless of age"
  );
  assert!(
    remaining
      .iter()
      .any(|version| version.kind == DocumentVersionKind::Published),
    "published version must survive regardless of age"
  );
  assert_eq!(
    remaining
      .iter()
      .filter(|version| !version.is_pinned && !version.is_protected && version.kind != DocumentVersionKind::Published)
      .count(),
    1,
    "only retention_count newest unprotected GC candidate may remain"
  );

  let history_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count histories");
  assert_eq!(
    history_count, 6,
    "GC must delete only document_version labels, never doc_histories snapshots"
  );

  cleanup(&pool, doc_id, ws_id, user_id).await;
}

// ---------------------------------------------------------------------------
// inv_docver02_unique_label_per_doc_enforced
// ---------------------------------------------------------------------------
// Invariant: `create()` with a duplicate (doc_id, label) pair returns
// `RepositoryError::Conflict`.
#[tokio::test]
async fn inv_docver02_unique_label_per_doc_enforced() {
  myoxus_infrastructure::migrations::run(&setup_pool().await)
    .await
    .expect("migrate");
  let pool = setup_pool().await;
  let (user_id, ws_id, doc_id, history_id) = seed_base(&pool).await;
  let repo = PgDocumentVersionRepository::new(pool.clone());

  let label = format!("unique-label-{}", Uuid::new_v4().simple());
  let first = make_version(doc_id, ws_id, history_id, label.clone(), user_id, Utc::now());
  let second = DocumentVersion {
    id: Uuid::new_v4(),
    label: label.clone(),
    ..first.clone()
  };

  repo.create(&first).await.expect("first create must succeed");
  let err = repo.create(&second).await.expect_err("duplicate label must fail");
  assert!(
    matches!(err, RepositoryError::Conflict(_)),
    "duplicate label must return Conflict, got: {:?}",
    err
  );

  cleanup(&pool, doc_id, ws_id, user_id).await;
}

#[tokio::test]
async fn inv_docver05_effective_settings_inherit_global_and_workspace_defaults() {
  myoxus_infrastructure::migrations::run(&setup_pool().await)
    .await
    .expect("migrate");
  let pool = setup_pool().await;
  let (user_id, ws_id, doc_id, _history_id) = seed_base(&pool).await;
  let config_values = Arc::new(RwLock::new(HashMap::new()));
  let reader: ConfigValuesReader = Arc::new({
    let config_values = config_values.clone();
    move || {
      let config_values = config_values.clone();
      Box::pin(async move { config_values.read().await.clone() })
    }
  });
  let repo = PgDocumentVersioningSettingsRepository::new(pool.clone()).with_config_values_reader(reader);

  let global_policy: (bool, Vec<String>) = sqlx::query_as(
    "SELECT enabled_by_default, auto_version_on FROM document_version_policy WHERE scope = 'global' AND is_default = true",
  )
  .fetch_one(&pool)
  .await
  .expect("read global document version policy");
  assert_eq!(
    global_policy,
    (true, vec!["on-pdf-export".to_string()]),
    "global policy seed must match the baseline PDF-export versioning default"
  );

  let baseline = repo.get(doc_id).await.expect("get built-in defaults");
  assert!(
    baseline.enabled,
    "built-in defaults must enable document versioning for fresh docs"
  );
  assert_eq!(
    baseline.auto_version_on,
    vec![AutoVersionTrigger::OnPdfExport],
    "built-in defaults must create versions on PDF export without requiring app_config seed rows"
  );

  for (id, value) in [
    ("document_versioning.default_enabled", serde_json::json!(true)),
    (
      "document_versioning.default_auto_version_on_pdf_export",
      serde_json::json!(true),
    ),
    ("document_versioning.default_retention_count", serde_json::json!(7)),
  ] {
    config_values.write().await.insert(id.to_string(), value);
  }

  let inherited = repo.get(doc_id).await.expect("get inherited settings");
  assert!(inherited.enabled, "missing doc row must inherit global enabled=true");
  assert_eq!(inherited.retention_count, 7, "retention must inherit global default");
  assert_eq!(
    inherited.auto_version_on,
    vec![AutoVersionTrigger::OnPdfExport],
    "PDF trigger must inherit from global default"
  );

  let inherited_targets = repo
    .list_enabled_for_trigger(AutoVersionTrigger::OnPdfExport)
    .await
    .expect("list inherited trigger targets");
  assert!(
    inherited_targets.iter().any(|target| target.doc_id == doc_id),
    "documents without explicit rows must be trigger targets when inherited defaults enable them"
  );

  sqlx::query(
    "INSERT INTO document_versioning_workspace_settings \
     (workspace_id, enabled, auto_version_on, retention_count, updated_by) \
     VALUES ($1, false, $2, 5, $3)",
  )
  .bind(ws_id)
  .bind(Vec::<String>::new())
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert workspace override");

  let workspace_override = repo.get(doc_id).await.expect("get workspace override settings");
  assert!(
    !workspace_override.enabled,
    "workspace override must beat global enabled=true"
  );
  assert_eq!(workspace_override.retention_count, 5);
  assert!(
    workspace_override.auto_version_on.is_empty(),
    "empty workspace trigger array must explicitly disable inherited triggers"
  );

  repo.set_enabled(doc_id, true).await.expect("set doc enabled");
  repo
    .set_triggers(doc_id, &[AutoVersionTrigger::Daily])
    .await
    .expect("set doc trigger");
  repo.set_retention_count(doc_id, 3).await.expect("set doc retention");

  let explicit_doc = repo.get(doc_id).await.expect("get explicit doc settings");
  assert!(explicit_doc.enabled, "explicit doc row must beat workspace override");
  assert_eq!(explicit_doc.retention_count, 3);
  assert_eq!(explicit_doc.auto_version_on, vec![AutoVersionTrigger::Daily]);

  cleanup(&pool, doc_id, ws_id, user_id).await;
}

#[tokio::test]
async fn workspace_history_patch_preserves_unsubmitted_admin_fields_and_rejects_stale_same_field() {
  myoxus_infrastructure::migrations::run(&setup_pool().await)
    .await
    .expect("migrate");
  let pool = setup_pool().await;
  let (user_id, ws_id, doc_id, _history_id) = seed_base(&pool).await;
  let repo = PgDocumentVersioningSettingsRepository::new(pool.clone());

  repo
    .set_workspace_override(
      ws_id,
      Some(true),
      Some(vec![AutoVersionTrigger::OnPublish, AutoVersionTrigger::Daily]),
      Some(12),
      user_id,
    )
    .await
    .expect("set legacy admin fields");
  let initial = repo
    .get_workspace_override(ws_id)
    .await
    .expect("read workspace settings")
    .expect("workspace exists");
  let revision = initial.edit_capture_revision();

  repo
    .patch_workspace_edit_capture(
      ws_id,
      WorkspaceEditCaptureSettingsPatch {
        edit_capture_enabled: Some(Some(false)),
        edit_capture_interval_ms: Some(Some(1_200_000)),
        ..Default::default()
      },
      &revision,
      user_id,
    )
    .await
    .expect("web patch");

  let after_web = repo
    .get_workspace_override(ws_id)
    .await
    .expect("read patched settings")
    .expect("workspace exists");
  assert_eq!(after_web.enabled, Some(true));
  assert_eq!(after_web.retention_count, Some(12));
  assert_eq!(
    after_web.auto_version_on,
    Some(vec![AutoVersionTrigger::OnPublish, AutoVersionTrigger::Daily])
  );
  assert_eq!(after_web.edit_capture_enabled, Some(false));
  assert_eq!(after_web.edit_capture_interval_ms, Some(1_200_000));

  repo
    .set_workspace_override(ws_id, None, None, None, user_id)
    .await
    .expect("admin reset legacy fields");
  let after_admin_reset = repo
    .get_workspace_override(ws_id)
    .await
    .expect("read reset settings")
    .expect("workspace exists");
  assert_eq!(after_admin_reset.enabled, None);
  assert_eq!(after_admin_reset.auto_version_on, None);
  assert_eq!(after_admin_reset.retention_count, None);
  assert_eq!(after_admin_reset.edit_capture_enabled, Some(false));
  assert_eq!(after_admin_reset.edit_capture_interval_ms, Some(1_200_000));

  let stale = repo
    .patch_workspace_edit_capture(
      ws_id,
      WorkspaceEditCaptureSettingsPatch {
        edit_capture_enabled: Some(Some(true)),
        ..Default::default()
      },
      &revision,
      user_id,
    )
    .await;
  assert!(
    matches!(stale, Err(RepositoryError::Conflict(_))),
    "a stale edit to the same capture field must conflict"
  );

  cleanup(&pool, doc_id, ws_id, user_id).await;
}

#[tokio::test]
async fn workspace_history_patch_allows_unrelated_admin_edit_from_same_revision() {
  myoxus_infrastructure::migrations::run(&setup_pool().await)
    .await
    .expect("migrate");
  let pool = setup_pool().await;
  let (user_id, ws_id, doc_id, _history_id) = seed_base(&pool).await;
  let repo = PgDocumentVersioningSettingsRepository::new(pool.clone());
  let initial = repo
    .get_workspace_override(ws_id)
    .await
    .expect("read workspace settings")
    .expect("workspace exists");
  let revision = initial.edit_capture_revision();

  repo
    .set_workspace_override(
      ws_id,
      Some(true),
      Some(vec![AutoVersionTrigger::OnPublish, AutoVersionTrigger::Daily]),
      Some(8),
      user_id,
    )
    .await
    .expect("concurrent admin edit");
  repo
    .patch_workspace_edit_capture(
      ws_id,
      WorkspaceEditCaptureSettingsPatch {
        edit_capture_enabled: Some(Some(false)),
        ..Default::default()
      },
      &revision,
      user_id,
    )
    .await
    .expect("unrelated capture edit must merge");

  let merged = repo
    .get_workspace_override(ws_id)
    .await
    .expect("read merged settings")
    .expect("workspace exists");
  assert_eq!(merged.enabled, Some(true));
  assert_eq!(merged.retention_count, Some(8));
  assert_eq!(
    merged.auto_version_on,
    Some(vec![AutoVersionTrigger::OnPublish, AutoVersionTrigger::Daily])
  );
  assert_eq!(merged.edit_capture_enabled, Some(false));

  cleanup(&pool, doc_id, ws_id, user_id).await;
}

// ---------------------------------------------------------------------------
// inv_docver03_cascade_delete_on_doc_removal
// ---------------------------------------------------------------------------
// Invariant: When the parent doc row is deleted, all document_version rows
// for that doc are removed via ON DELETE CASCADE.
#[tokio::test]
async fn inv_docver03_cascade_delete_on_doc_removal() {
  myoxus_infrastructure::migrations::run(&setup_pool().await)
    .await
    .expect("migrate");
  let pool = setup_pool().await;
  let (user_id, ws_id, doc_id, history_id) = seed_base(&pool).await;
  let repo = PgDocumentVersionRepository::new(pool.clone());

  let version = make_version(
    doc_id,
    ws_id,
    history_id,
    format!("cascade-test-{}", Uuid::new_v4().simple()),
    user_id,
    Utc::now(),
  );
  repo.create(&version).await.expect("create must succeed");

  // Delete the parent doc — triggers CASCADE on document_version
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("delete doc");

  let remaining = repo.list_for_doc(doc_id).await.expect("list_for_doc must succeed");
  assert!(
    remaining.is_empty(),
    "list_for_doc must return empty after doc cascade-delete"
  );

  let raw_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count check");
  assert_eq!(raw_count, 0, "SQL count must be 0 after cascade");

  cleanup(&pool, doc_id, ws_id, user_id).await;
}

#[tokio::test]
async fn inv_docver_mig01_existing_versions_get_monotonic_version_no() {
  myoxus_infrastructure::migrations::run(&setup_pool().await)
    .await
    .expect("migrate");
  let pool = setup_pool().await;
  let (user_id, ws_id, doc_id, first_history_id) = seed_base(&pool).await;
  let repo = PgDocumentVersionRepository::new(pool.clone());
  let created_at = Utc::now();

  for idx in 0..3 {
    let history_id = if idx == 0 {
      first_history_id
    } else {
      insert_history(&pool, ws_id, doc_id, &format!("seq-{idx}")).await
    };
    repo
      .create(&make_version(
        doc_id,
        ws_id,
        history_id,
        format!("seq-{idx}-{}", Uuid::new_v4().simple()),
        user_id,
        created_at,
      ))
      .await
      .expect("legacy repository insert must receive version_no from trigger");
  }

  let version_numbers: Vec<i64> =
    sqlx::query_scalar("SELECT version_no FROM document_version WHERE doc_id = $1 ORDER BY version_no")
      .bind(doc_id)
      .fetch_all(&pool)
      .await
      .expect("select version numbers");
  assert_eq!(
    version_numbers,
    vec![1, 2, 3],
    "DB trigger must allocate monotonic per-doc version_no values"
  );

  let duplicate = sqlx::query(
    "INSERT INTO document_version (doc_id, workspace_id, doc_history_id, version_no, label, created_by) VALUES ($1, $2, $3, 2, $4, $5)",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(first_history_id)
  .bind(format!("duplicate-no-{}", Uuid::new_v4().simple()))
  .bind(user_id)
  .execute(&pool)
  .await;
  assert!(duplicate.is_err(), "duplicate (doc_id, version_no) must be rejected");

  cleanup(&pool, doc_id, ws_id, user_id).await;
}

#[tokio::test]
async fn inv_docver_mig02_no_duplicate_document_version_table_created() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");

  let duplicate_tables: Vec<String> = sqlx::query_scalar(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~ '^document_version(_v[0-9]+|s|_new|_target)$' ORDER BY table_name",
  )
  .fetch_all(&pool)
  .await
  .expect("query duplicate version tables");
  assert!(
    duplicate_tables.is_empty(),
    "target model must extend document_version, not create duplicate core tables: {duplicate_tables:?}"
  );

  let required_columns: Vec<String> = sqlx::query_scalar(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_version' AND column_name = ANY($1) ORDER BY column_name",
  )
  .bind([
    "content_hash",
    "event",
    "is_protected",
    "kind",
    "metadata",
    "policy_id",
    "policy_snapshot",
    "updated_at",
    "updated_by",
    "version_no",
  ])
  .fetch_all(&pool)
  .await
  .expect("query document_version target columns");
  assert_eq!(
    required_columns,
    vec![
      "content_hash",
      "event",
      "is_protected",
      "kind",
      "metadata",
      "policy_id",
      "policy_snapshot",
      "updated_at",
      "updated_by",
      "version_no",
    ],
    "document_version must contain target-model columns"
  );
}

#[tokio::test]
async fn inv_edit_capture01_sustained_edits_keep_anchor_and_interval_changes_recompute_due() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let (user_id, ws_id, doc_id) = seed_edit_capture_state(&pool, &text_update("first")).await;
  let repo = PgDocumentEditCaptureRepository::new(pool.clone());
  let start = chrono::DateTime::from_timestamp_micros(Utc::now().timestamp_micros()).unwrap();
  let settings = GlobalEditCaptureSettings {
    interval_ms: 15 * 60 * 1000,
    ..GlobalEditCaptureSettings::default()
  };

  assert_eq!(
    repo.reconcile(&settings, start, 10).await.expect("schedule first edit"),
    1
  );
  let (anchor, due): (chrono::DateTime<Utc>, chrono::DateTime<Utc>) = sqlx::query_as(
    "SELECT first_pending_at, due_at FROM document_edit_capture_state WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws_id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("read initial schedule");
  assert_eq!(anchor, start);
  assert_eq!(due, start + Duration::minutes(15));

  sqlx::query(
    "UPDATE document_edit_capture_state SET dirty_revision=2, updated_at=$3 WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws_id)
  .bind(doc_id)
  .bind(start + Duration::minutes(5))
  .execute(&pool)
  .await
  .expect("record sustained edit");
  assert_eq!(
    repo
      .reconcile(&settings, start + Duration::minutes(5), 10)
      .await
      .unwrap(),
    0
  );

  let mut longer = settings.clone();
  longer.interval_ms = 30 * 60 * 1000;
  assert_eq!(
    repo.reconcile(&longer, start + Duration::minutes(6), 10).await.unwrap(),
    1
  );
  let (same_anchor, moved_due): (chrono::DateTime<Utc>, chrono::DateTime<Utc>) = sqlx::query_as(
    "SELECT first_pending_at, due_at FROM document_edit_capture_state WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws_id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(
    same_anchor, start,
    "later edits and interval changes preserve the first-edit anchor"
  );
  assert_eq!(moved_due, start + Duration::minutes(30));
  cleanup(&pool, doc_id, ws_id, user_id).await;
}

#[tokio::test]
async fn inv_edit_capture02_disable_reenable_and_trash_restart_the_interval_without_losing_dirty_revision() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let (user_id, ws_id, doc_id) = seed_edit_capture_state(&pool, &text_update("pending")).await;
  let repo = PgDocumentEditCaptureRepository::new(pool.clone());
  let start = chrono::DateTime::from_timestamp_micros(Utc::now().timestamp_micros()).unwrap();
  let mut disabled = GlobalEditCaptureSettings::default();
  disabled.enabled = false;
  repo.reconcile(&disabled, start, 10).await.unwrap();
  let (dirty, anchor, due): (i64, Option<chrono::DateTime<Utc>>, Option<chrono::DateTime<Utc>>) =
    sqlx::query_as(
      "SELECT dirty_revision, first_pending_at, due_at FROM document_edit_capture_state WHERE workspace_id=$1 AND doc_id=$2",
    )
    .bind(ws_id)
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(dirty, 1);
  assert!(anchor.is_none() && due.is_none());

  let enabled_at = start + Duration::minutes(2);
  repo
    .reconcile(&GlobalEditCaptureSettings::default(), enabled_at, 10)
    .await
    .unwrap();
  let due: chrono::DateTime<Utc> =
    sqlx::query_scalar("SELECT due_at FROM document_edit_capture_state WHERE workspace_id=$1 AND doc_id=$2")
      .bind(ws_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(due, enabled_at + Duration::hours(24));

  sqlx::query("UPDATE docs SET deleted_at=now() WHERE id=$1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .unwrap();
  repo
    .reconcile(&GlobalEditCaptureSettings::default(), enabled_at, 10)
    .await
    .unwrap();
  sqlx::query("UPDATE docs SET deleted_at=NULL WHERE id=$1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .unwrap();
  let resumed_at = enabled_at + Duration::minutes(4);
  repo
    .reconcile(&GlobalEditCaptureSettings::default(), resumed_at, 10)
    .await
    .unwrap();
  let resumed_due: chrono::DateTime<Utc> =
    sqlx::query_scalar("SELECT due_at FROM document_edit_capture_state WHERE workspace_id=$1 AND doc_id=$2")
      .bind(ws_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(resumed_due, resumed_at + Duration::hours(24));
  cleanup(&pool, doc_id, ws_id, user_id).await;
}

#[tokio::test]
async fn inv_edit_capture03_competing_workers_retry_failures_and_do_not_duplicate_after_restart() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let initial_update = text_update("captured once");
  let (user_id, ws_id, doc_id) = seed_edit_capture_state(&pool, &initial_update).await;
  let now = Utc::now();
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path,
        sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://history-capture.test/acme/repo.git',
       'main', 'content/', 'Bidirectional', 'HistoryCapture', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(ws_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert history-trigger profile");
  sqlx::query(
    "UPDATE document_edit_capture_state
     SET first_pending_at=$3, due_at=$3, configured_enabled=true,
         configured_interval_ms=900000, lifecycle_active=true
     WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws_id)
  .bind(doc_id)
  .bind(now)
  .execute(&pool)
  .await
  .unwrap();
  let repo_a = PgDocumentEditCaptureRepository::new(pool.clone());
  let repo_b = PgDocumentEditCaptureRepository::new(pool.clone());
  let settings = GlobalEditCaptureSettings {
    interval_ms: 15 * 60 * 1000,
    ..GlobalEditCaptureSettings::default()
  };
  sqlx::query(
    "INSERT INTO document_versioning_workspace_settings (workspace_id, edit_capture_enabled)
     VALUES ($1, false)",
  )
  .bind(ws_id)
  .execute(&pool)
  .await
  .unwrap();
  let disabled = repo_a.capture_due(&settings, now, 10).await.unwrap();
  assert_eq!(
    disabled.skipped, 1,
    "capture must recheck a fresh disable under its lock"
  );
  let disabled_due: Option<chrono::DateTime<Utc>> =
    sqlx::query_scalar("SELECT due_at FROM document_edit_capture_state WHERE workspace_id=$1 AND doc_id=$2")
      .bind(ws_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert!(disabled_due.is_none());
  sqlx::query("DELETE FROM document_versioning_workspace_settings WHERE workspace_id=$1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(
    "UPDATE document_edit_capture_state
     SET first_pending_at=$3, due_at=$3, configured_enabled=true,
         configured_interval_ms=900000, lifecycle_active=true
     WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws_id)
  .bind(doc_id)
  .bind(now)
  .execute(&pool)
  .await
  .unwrap();
  let (a, b) = tokio::join!(
    repo_a.capture_due(&settings, now, 10),
    repo_b.capture_due(&settings, now, 10)
  );
  let a = a.unwrap();
  let b = b.unwrap();
  assert_eq!(a.captured + b.captured, 1);
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE doc_id=$1 AND origin='automatic'")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(count, 1);
  let (receipt_count, outbox_count): (i64, i64) = sqlx::query_as(
    "SELECT
       (SELECT COUNT(*) FROM git_sync_history_capture_receipts WHERE profile_id=$1),
       (SELECT COUNT(*) FROM outbox_events WHERE event_type='history_captured' AND payload->>'profileId'=$1::text)",
  )
  .bind(profile_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!((receipt_count, outbox_count), (1, 1));
  assert_eq!(
    repo_a
      .capture_due(&settings, now + Duration::seconds(30), 10)
      .await
      .unwrap()
      .examined,
    0
  );

  sqlx::query("INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence) VALUES ($1,$2,$3,2)")
    .bind(ws_id)
    .bind(doc_id)
    .bind(&initial_update)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(
    "UPDATE document_edit_capture_state SET dirty_revision=2, first_pending_at=$3, due_at=$3 WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws_id)
  .bind(doc_id)
  .bind(now + Duration::minutes(16))
  .execute(&pool)
  .await
  .unwrap();
  let unchanged = repo_a
    .capture_due(&settings, now + Duration::minutes(16), 10)
    .await
    .unwrap();
  assert_eq!(unchanged.unchanged, 1);
  let count_after_noop: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE doc_id=$1 AND origin='automatic'")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(
    count_after_noop, 1,
    "unchanged materialization must not create a duplicate history row"
  );
  let receipts_after_noop: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_history_capture_receipts WHERE profile_id=$1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(receipts_after_noop, 1, "unchanged capture must not emit Git intent");

  sqlx::query("INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence) VALUES ($1,$2,$3,3)")
    .bind(ws_id)
    .bind(doc_id)
    .bind(b"not-yjs" as &[u8])
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(
    "UPDATE document_edit_capture_state SET dirty_revision=3, first_pending_at=$3, due_at=$3 WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws_id)
  .bind(doc_id)
  .bind(now + Duration::minutes(20))
  .execute(&pool)
  .await
  .unwrap();
  let failed = repo_a
    .capture_due(&settings, now + Duration::minutes(20), 10)
    .await
    .unwrap();
  assert_eq!(failed.failed, 1);
  let (retry_count, retry_at): (i32, chrono::DateTime<Utc>) = sqlx::query_as(
    "SELECT retry_count, next_retry_at FROM document_edit_capture_state WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws_id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(retry_count, 1);
  assert!(retry_at > now + Duration::minutes(20));
  let receipts_after_rollback: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_history_capture_receipts WHERE profile_id=$1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(
    receipts_after_rollback, 1,
    "failed capture transaction must not leave Git intent"
  );
  cleanup(&pool, doc_id, ws_id, user_id).await;
}

async fn cleanup_capture_fixture(pool: &PgPool, user: Uuid, source: Uuid, doc: Uuid, target: Uuid) {
  sqlx::query("DELETE FROM docs WHERE id=$1")
    .bind(doc)
    .execute(pool)
    .await
    .expect("clean capture document");
  sqlx::query("DELETE FROM workspaces WHERE id=ANY($1)")
    .bind([source, target])
    .execute(pool)
    .await
    .expect("clean capture workspaces");
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user)
    .execute(pool)
    .await
    .expect("clean capture actor");
}

#[tokio::test]
async fn inv_edit_capture04_repair_merges_revision_hash_pair_and_destination_policy_idempotently() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let (user, source, doc) = seed_edit_capture_state(&pool, &text_update("pending repair")).await;
  let target: Uuid =
    sqlx::query_scalar("INSERT INTO workspaces(owner_user_id,name) VALUES($1,'Capture destination') RETURNING id")
      .bind(user)
      .fetch_one(&pool)
      .await
      .unwrap();
  let outcome = AssertUnwindSafe(async {
    let now = chrono::DateTime::from_timestamp_micros(Utc::now().timestamp_micros()).unwrap();
    let anchor = now - Duration::minutes(20);
    let automatic = now - Duration::hours(1);
    sqlx::query(
      "UPDATE document_edit_capture_state SET dirty_revision=7,last_captured_revision=3,last_captured_content_hash=$3,
    last_capture_at=$4,first_pending_at=$5,due_at=$5,configured_enabled=true,configured_interval_ms=900000,
    lifecycle_active=true,retry_count=4,next_retry_at=$4 WHERE workspace_id=$1 AND doc_id=$2",
    )
    .bind(source)
    .bind(doc)
    .bind(vec![3u8])
    .bind(automatic)
    .bind(anchor)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
      "INSERT INTO document_edit_capture_state(workspace_id,doc_id,dirty_revision,last_captured_revision,
    last_captured_content_hash,first_pending_at,configured_enabled,configured_interval_ms,lifecycle_active)
    VALUES($1,$2,9,5,$3,$4,true,900000,true)",
    )
    .bind(target)
    .bind(doc)
    .bind(vec![5u8])
    .bind(anchor + Duration::minutes(2))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
      "INSERT INTO document_versioning_workspace_settings(workspace_id,edit_capture_interval_ms) VALUES($1,1800000)",
    )
    .bind(target)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE docs SET workspace_id=$2 WHERE id=$1")
      .bind(doc)
      .bind(target)
      .execute(&pool)
      .await
      .unwrap();
    let repo = PgDocumentEditCaptureRepository::new(pool.clone());
    assert_eq!(
      repo
        .capture_due(&GlobalEditCaptureSettings::default(), now, 1)
        .await
        .unwrap()
        .examined,
      0,
      "old-owner rows cannot consume a due batch"
    );
    assert_eq!(
      repo
        .reconcile(&GlobalEditCaptureSettings::default(), now, 1)
        .await
        .unwrap(),
      1
    );
    let row = sqlx::query("SELECT * FROM document_edit_capture_state WHERE doc_id=$1")
      .bind(doc)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(row.get::<Uuid, _>("workspace_id"), target);
    assert_eq!(row.get::<i64, _>("dirty_revision"), 9);
    assert_eq!(row.get::<Option<i64>, _>("last_captured_revision"), Some(5));
    assert_eq!(
      row.get::<Option<Vec<u8>>, _>("last_captured_content_hash"),
      Some(vec![5u8])
    );
    assert_eq!(
      row.get::<Option<chrono::DateTime<Utc>>, _>("last_capture_at"),
      Some(automatic)
    );
    assert_eq!(
      row.get::<Option<chrono::DateTime<Utc>>, _>("first_pending_at"),
      Some(anchor)
    );
    assert_eq!(
      row.get::<Option<chrono::DateTime<Utc>>, _>("due_at"),
      Some(anchor + Duration::minutes(30))
    );
    assert_eq!(row.get::<i32, _>("retry_count"), 0);
    assert!(row.get::<Option<chrono::DateTime<Utc>>, _>("next_retry_at").is_none());
    assert_eq!(
      repo
        .reconcile(&GlobalEditCaptureSettings::default(), now, 1)
        .await
        .unwrap(),
      0
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM document_edit_capture_state WHERE doc_id=$1")
        .bind(doc)
        .fetch_one(&pool)
        .await
        .unwrap(),
      1
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_histories WHERE doc_id=$1 AND origin='automatic'")
        .bind(doc)
        .fetch_one(&pool)
        .await
        .unwrap(),
      0,
      "repair is bookkeeping, never backfill"
    );
    cleanup(&pool, doc, source, user).await;
  })
  .catch_unwind()
  .await;
  cleanup_capture_fixture(&pool, user, source, doc, target).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_edit_capture05_bounded_repair_covers_clean_unknown_busy_and_disabled_owners() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let repo = PgDocumentEditCaptureRepository::new(pool.clone());
  let now = chrono::DateTime::from_timestamp_micros(Utc::now().timestamp_micros()).unwrap();
  let mut fixtures = Vec::new();
  let outcome = AssertUnwindSafe(async {
    for index in 0..4 {
      let (user, source, doc) = seed_edit_capture_state(&pool, &text_update("repair batch")).await;
      let target: Uuid =
        sqlx::query_scalar("INSERT INTO workspaces(owner_user_id,name) VALUES($1,'Repair target') RETURNING id")
          .bind(user)
          .fetch_one(&pool)
          .await
          .unwrap();
      fixtures.push((user, source, doc, target));
      // One clean row and three unknown acknowledgements; all require repair.
      sqlx::query(
        "UPDATE document_edit_capture_state SET last_captured_revision=$3,
      configured_enabled=true,configured_interval_ms=900000,lifecycle_active=true,first_pending_at=$4,due_at=$4
      WHERE workspace_id=$1 AND doc_id=$2",
      )
      .bind(source)
      .bind(doc)
      .bind((index == 0).then_some(1i64))
      .bind(now - Duration::minutes(20))
      .execute(&pool)
      .await
      .unwrap();
      sqlx::query("UPDATE docs SET workspace_id=$2 WHERE id=$1")
        .bind(doc)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
      sqlx::query("UPDATE doc_updates SET workspace_id=$2 WHERE doc_id=$1")
        .bind(doc)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
      if index == 1 {
        sqlx::query(
          "INSERT INTO document_versioning_workspace_settings(workspace_id,edit_capture_enabled) VALUES($1,false)",
        )
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
      }
    }
    let mut busy = pool.begin().await.unwrap();
    let held = fixtures[0];
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(format!("workspace-document:{}:{}", held.1, held.2))
      .execute(&mut *busy)
      .await
      .unwrap();
    let count = repo
      .reconcile(&GlobalEditCaptureSettings::default(), now, 2)
      .await
      .unwrap();
    assert!(
      (1..=2).contains(&count),
      "a busy document cannot block the bounded pass"
    );
    busy.rollback().await.unwrap();
    let mut repaired = count;
    for _ in 0..4 {
      repaired += repo
        .reconcile(&GlobalEditCaptureSettings::default(), now, 2)
        .await
        .unwrap();
    }
    assert_eq!(
      repaired, 4,
      "passes larger than the repair limit must converge, including clean rows"
    );
    for (index, (_, _, doc, target)) in fixtures.iter().enumerate() {
      let row = sqlx::query("SELECT * FROM document_edit_capture_state WHERE doc_id=$1")
        .bind(doc)
        .fetch_one(&pool)
        .await
        .unwrap();
      assert_eq!(row.get::<Uuid, _>("workspace_id"), *target);
      assert_eq!(
        row.get::<Option<i64>, _>("last_captured_revision"),
        (index == 0).then_some(1)
      );
      if index <= 1 {
        assert!(
          row.get::<Option<chrono::DateTime<Utc>>, _>("due_at").is_none(),
          "clean/disabled intent is unscheduled"
        );
      }
    }
    let disabled = fixtures[1];
    sqlx::query("UPDATE document_versioning_workspace_settings SET edit_capture_enabled=true WHERE workspace_id=$1")
      .bind(disabled.3)
      .execute(&pool)
      .await
      .unwrap();
    let resumed = now + Duration::minutes(3);
    assert_eq!(
      repo
        .reconcile(&GlobalEditCaptureSettings::default(), resumed, 2)
        .await
        .unwrap(),
      1
    );
    let due: chrono::DateTime<Utc> =
      sqlx::query_scalar("SELECT due_at FROM document_edit_capture_state WHERE doc_id=$1")
        .bind(disabled.2)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
      due,
      resumed + Duration::hours(24),
      "reactivation starts a fresh interval"
    );
    let summary = repo
      .capture_due(&GlobalEditCaptureSettings::default(), now, 1)
      .await
      .unwrap();
    assert_eq!(
      summary.captured, 0,
      "global 24h policy recomputes continuously runnable anchors"
    );
  })
  .catch_unwind()
  .await;
  for (user, source, doc, target) in fixtures {
    cleanup_capture_fixture(&pool, user, source, doc, target).await;
  }
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_edit_capture06_writer_and_capture_share_the_scoped_document_lock() {
  use myoxus_application::doc::{DocSpaceKind, DocUpdateStore, DocUpdateWrite, DocWriteTarget};
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let (user, workspace, doc) = seed_edit_capture_state(&pool, &text_update("before concurrent edit")).await;
  let outcome = AssertUnwindSafe(async {
    let repo = PgDocumentEditCaptureRepository::new(pool.clone());
    let settings = GlobalEditCaptureSettings {
      interval_ms: 900000,
      ..GlobalEditCaptureSettings::default()
    };
    let now = Utc::now();
    repo
      .reconcile(&settings, now - Duration::minutes(20), 10)
      .await
      .unwrap();
    let mut writer_lock = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(format!("workspace-document:{workspace}:{doc}"))
      .execute(&mut *writer_lock)
      .await
      .unwrap();
    assert_eq!(
      repo.capture_due(&settings, now, 10).await.unwrap().skipped,
      1,
      "capture must not bypass an active writer"
    );
    writer_lock.rollback().await.unwrap();
    let store = SqlxDocStore::new(pool.clone());
    let write = store.push_update(DocUpdateWrite {
      sync_operation_id: Some(Uuid::new_v4()),
      connection_context: None,
      workspace_id: workspace,
      target: DocWriteTarget::Internal(doc),
      validated_external_update: None,
      payload: text_update("concurrent accepted edit"),
      space_kind: DocSpaceKind::Workspace,
      actor_user_id: Some(user),
      client_format: None,
      client_capabilities: None,
      initial_provenance: None,
    });
    let (accepted, capture) = tokio::join!(write, repo.capture_due(&settings, now, 10));
    accepted.expect("accept concurrent write");
    capture.expect("concurrent capture pass");
    repo.reconcile(&settings, now + Duration::minutes(1), 10).await.unwrap();
    repo
      .capture_due(&settings, now + Duration::hours(25), 10)
      .await
      .unwrap();
    let state: (i64, i64, Option<chrono::DateTime<Utc>>) = sqlx::query_as(
      "SELECT dirty_revision,last_captured_revision,due_at FROM document_edit_capture_state WHERE doc_id=$1",
    )
    .bind(doc)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
      state.0, state.1,
      "every accepted revision is captured or retained as pending work"
    );
    assert!(state.2.is_none());
    let latest: Vec<u8> = sqlx::query_scalar(
      "SELECT snapshot FROM doc_histories WHERE doc_id=$1 AND origin='automatic' ORDER BY id DESC LIMIT 1",
    )
    .bind(doc)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
      latest,
      DocService::new(Arc::new(store))
        .load_full_doc(workspace, doc)
        .await
        .unwrap(),
      "capture contains the acknowledged server head"
    );
    assert_eq!(
      repo
        .capture_due(&settings, now + Duration::hours(26), 10)
        .await
        .unwrap()
        .captured,
      0,
      "completed revisions never duplicate on another pass"
    );
  })
  .catch_unwind()
  .await;
  cleanup_capture_fixture(&pool, user, workspace, doc, workspace).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_edit_capture07_unpolled_source_disable_breaks_move_schedule_continuity() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let (user, source, doc) = seed_edit_capture_state(&pool, &text_update("pending before disable")).await;
  let target: Uuid =
    sqlx::query_scalar("INSERT INTO workspaces(owner_user_id,name) VALUES($1,'Enabled destination') RETURNING id")
      .bind(user)
      .fetch_one(&pool)
      .await
      .unwrap();
  let outcome=AssertUnwindSafe(async {
  let now = chrono::DateTime::from_timestamp_micros(Utc::now().timestamp_micros()).unwrap();
  let settings = GlobalEditCaptureSettings {
    interval_ms: 900000,
    ..GlobalEditCaptureSettings::default()
  };
  let repo = PgDocumentEditCaptureRepository::new(pool.clone());
  repo
    .reconcile(&settings, now - Duration::minutes(20), 10)
    .await
    .unwrap();
  // Policy committed before Move; the worker has not yet cleared its old due state.
  sqlx::query("INSERT INTO document_versioning_workspace_settings(workspace_id,edit_capture_enabled) VALUES($1,false)")
    .bind(source)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("UPDATE docs SET workspace_id=$2 WHERE id=$1")
    .bind(doc)
    .bind(target)
    .execute(&pool)
    .await
    .unwrap();
  assert_eq!(repo.reconcile(&settings, now, 10).await.unwrap(), 1);
  let state:(i64,Option<i64>,chrono::DateTime<Utc>,chrono::DateTime<Utc>)=sqlx::query_as(
    "SELECT dirty_revision,last_captured_revision,first_pending_at,due_at FROM document_edit_capture_state WHERE doc_id=$1")
    .bind(doc).fetch_one(&pool).await.unwrap();
  assert_eq!((state.0, state.1), (1, None));
  assert_eq!(state.2, now);
  assert_eq!(state.3, now + Duration::minutes(15));
  }).catch_unwind().await;
  cleanup_capture_fixture(&pool, user, source, doc, target).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
