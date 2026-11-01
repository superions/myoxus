// SPDX-License-Identifier: AGPL-3.0-or-later
//! Initial document sync provenance tests.

use chrono::{Duration, Utc};
use myoxus_application::doc::{DocService, DocSpaceKind, InitialDocumentProvenance, InitialDocumentProvenanceMode};
use myoxus_application::git_sync::doc_reconcile_plan::SyncAction;
use myoxus_application::git_sync::reconcile::ReconcileAction;
use myoxus_domain::git_sync::{AuthMethod, GitSyncProfile, SyncDirection, TriggerMode};
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_metadata::initial_sync_audit::{
  ImportedWorkspaceDocumentCreate, ensure_imported_workspace_document,
};
use serde_json::Value;
use sqlx::Row;
use std::sync::Arc;
use uuid::Uuid;

fn doc_service(pool: &sqlx::PgPool) -> DocService {
  DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
}

fn provenance(idempotency_key: &str) -> InitialDocumentProvenance {
  InitialDocumentProvenance {
    idempotency_key: Some(idempotency_key.to_string()),
    client_family: Some("electron".to_string()),
    client_version: Some("test".to_string()),
    client_instance_id: Some(Uuid::new_v4().to_string()),
    provenance_mode: InitialDocumentProvenanceMode::OfflineSync,
    client_created_at: Some(Utc::now() - Duration::hours(3)),
    client_updated_at: Some(Utc::now() - Duration::hours(1)),
    client_created_by: None,
    client_updated_by: None,
    historical_user_mapping_id: None,
    source_property_doc_revision: Some("rev-1".to_string()),
  }
}

#[tokio::test]
async fn inv_docmeta_initial_sync01_offline_origin_applies_times_with_server_idempotency() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-owner", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let input = provenance("initial-sync-01");
  let expected_created_at = input.client_created_at.expect("created at");
  let expected_updated_at = input.client_updated_at.expect("updated at");

  doc_service(&pool)
    .push_internal_update_with_context(
      workspace_id,
      doc_id,
      vec![0, 0],
      0,
      DocSpaceKind::Workspace,
      Some(user_id),
      Some("myoxus-native".to_string()),
      Some("document-metadata,sync,offline-origin-v1".to_string()),
      Some(input),
    )
    .await
    .expect("initial push with provenance");

  let row =
    sqlx::query("SELECT created_by, updated_by, created_at, updated_at FROM docs WHERE id = $1 AND workspace_id = $2")
      .bind(doc_id)
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("created docs row");
  let created_by: Option<Uuid> = row.get("created_by");
  let updated_by: Option<Uuid> = row.get("updated_by");
  let created_at: chrono::DateTime<Utc> = row.get("created_at");
  let updated_at: chrono::DateTime<Utc> = row.get("updated_at");
  assert_eq!(created_by, Some(user_id));
  assert_eq!(updated_by, Some(user_id));
  assert_eq!(created_at.timestamp(), expected_created_at.timestamp());
  assert_eq!(updated_at.timestamp(), expected_updated_at.timestamp());

  let audit = sqlx::query(
    "SELECT resolution_kind, decision_code, idempotency_key, rejected_fields FROM document_initial_sync_audit WHERE doc_id = $1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("initial sync audit");
  assert_eq!(audit.get::<String, _>("resolution_kind"), "created");
  assert_eq!(
    audit.get::<String, _>("decision_code"),
    "client_provenance_partially_rejected"
  );
  assert_eq!(
    audit.get::<String, _>("idempotency_key"),
    format!("server-first-sync:{workspace_id}:{doc_id}")
  );
  assert_eq!(
    audit.get::<Value, _>("rejected_fields"),
    serde_json::json!({ "idempotencyKey": "server_derived" })
  );

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_docmeta_initial_sync02_native_first_push_without_provenance_uses_server_observation() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-native-reject", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();

  let before = Utc::now();
  doc_service(&pool)
    .push_internal_update_with_context(
      workspace_id,
      doc_id,
      vec![0, 0],
      0,
      DocSpaceKind::Workspace,
      Some(user_id),
      Some("myoxus-native".to_string()),
      None,
      None,
    )
    .await
    .expect("native first push without provenance must materialize");
  let after = Utc::now();

  let doc = sqlx::query("SELECT created_at, updated_at FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("server-observed document");
  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("update count");
  let audit = sqlx::query(
    "SELECT provenance_mode, decision_code, idempotency_key, raw_provenance, rejected_fields \
       FROM document_initial_sync_audit WHERE doc_id = $1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("server-observed audit");
  let created_at = doc.get::<chrono::DateTime<Utc>, _>("created_at");
  let updated_at = doc.get::<chrono::DateTime<Utc>, _>("updated_at");
  assert!(created_at >= before && created_at <= after);
  assert_eq!(updated_at, created_at);
  assert_eq!(update_count, 1);
  assert_eq!(audit.get::<String, _>("provenance_mode"), "server_observed_first_sync");
  assert_eq!(audit.get::<String, _>("decision_code"), "server_observed_first_sync");
  assert_eq!(
    audit.get::<String, _>("idempotency_key"),
    format!("server-first-sync:{workspace_id}:{doc_id}")
  );
  assert_eq!(audit.get::<Value, _>("raw_provenance"), Value::Null);
  assert_eq!(audit.get::<Value, _>("rejected_fields"), serde_json::json!({}));

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_docmeta_initial_sync02b_legacy_offline_claim_without_capability_is_neutralized() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-legacy-neutralized", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let claimed_created_at = Utc::now() - Duration::days(30);
  let mut legacy = provenance("client-invented-key");
  legacy.client_instance_id = Some("legacy-worker-instance".to_string());
  legacy.client_created_at = Some(claimed_created_at);
  legacy.client_updated_at = Some(claimed_created_at + Duration::hours(1));
  let before = Utc::now();

  doc_service(&pool)
    .push_internal_update_with_context(
      workspace_id,
      doc_id,
      vec![0, 0],
      0,
      DocSpaceKind::Workspace,
      Some(user_id),
      Some("myoxus-native".to_string()),
      Some("document-metadata,sync".to_string()),
      Some(legacy),
    )
    .await
    .expect("legacy offline claim must be downgraded, not rejected");
  let after = Utc::now();

  let doc = sqlx::query("SELECT created_at, updated_at FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("downgraded document");
  let audit = sqlx::query(
    "SELECT provenance_mode, decision_code, idempotency_key, normalized_provenance, rejected_fields \
       FROM document_initial_sync_audit WHERE doc_id = $1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("downgrade audit");
  let created_at = doc.get::<chrono::DateTime<Utc>, _>("created_at");
  assert!(created_at >= before && created_at <= after);
  assert_ne!(created_at.timestamp(), claimed_created_at.timestamp());
  assert_eq!(doc.get::<chrono::DateTime<Utc>, _>("updated_at"), created_at);
  assert_eq!(audit.get::<String, _>("provenance_mode"), "server_observed_first_sync");
  assert_eq!(
    audit.get::<String, _>("decision_code"),
    "client_offline_provenance_rejected"
  );
  assert_eq!(
    audit.get::<String, _>("idempotency_key"),
    format!("server-first-sync:{workspace_id}:{doc_id}")
  );
  let rejected = audit.get::<Value, _>("rejected_fields");
  assert_eq!(
    rejected.get("clientCapabilities").and_then(Value::as_str),
    Some("offline_origin_v1_required")
  );
  assert_eq!(
    rejected.get("clientInstanceId").and_then(Value::as_str),
    Some("stable_uuid_required")
  );
  let normalized = audit.get::<Value, _>("normalized_provenance");
  assert!(normalized.get("clientInstanceId").is_some_and(Value::is_null));
  assert!(normalized.get("clientCreatedAt").is_some_and(Value::is_null));
  assert!(!normalized.to_string().contains("legacy-worker-instance"));

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_docmeta_initial_sync02c_client_push_cannot_claim_explicit_import() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-untrusted-import", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let claimed_created_at = Utc::now() - Duration::days(60);
  let mut untrusted = provenance("untrusted-explicit-import-key");
  untrusted.provenance_mode = InitialDocumentProvenanceMode::ExplicitImport;
  untrusted.client_created_at = Some(claimed_created_at);
  untrusted.client_updated_at = Some(claimed_created_at + Duration::hours(1));
  let before = Utc::now();

  doc_service(&pool)
    .push_internal_update_with_context(
      workspace_id,
      doc_id,
      vec![0, 0],
      0,
      DocSpaceKind::Workspace,
      Some(user_id),
      Some("myoxus-native".to_string()),
      Some("document-metadata,sync,offline-origin-v1".to_string()),
      Some(untrusted),
    )
    .await
    .expect("client explicit-import claim must downgrade without blocking sync");
  let after = Utc::now();

  let created_at: chrono::DateTime<Utc> = sqlx::query_scalar("SELECT created_at FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("downgraded document timestamp");
  let audit = sqlx::query(
    "SELECT provenance_mode, decision_code, idempotency_key, rejected_fields \
       FROM document_initial_sync_audit WHERE doc_id = $1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("downgraded explicit-import audit");

  assert!(created_at >= before && created_at <= after);
  assert_ne!(created_at.timestamp(), claimed_created_at.timestamp());
  assert_eq!(audit.get::<String, _>("provenance_mode"), "server_observed_first_sync");
  assert_eq!(
    audit.get::<String, _>("decision_code"),
    "client_explicit_import_rejected"
  );
  assert_eq!(
    audit.get::<String, _>("idempotency_key"),
    format!("server-first-sync:{workspace_id}:{doc_id}")
  );
  assert_eq!(
    audit.get::<Value, _>("rejected_fields").get("provenanceMode"),
    Some(&serde_json::json!("explicit_import_requires_server_path"))
  );

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_docmeta_initial_sync03_later_provenance_does_not_rewrite_system_facts() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-existing", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, user_id).await;
  let before = sqlx::query("SELECT created_at, updated_at FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("existing doc");
  let before_created_at: chrono::DateTime<Utc> = before.get("created_at");
  let before_updated_at: chrono::DateTime<Utc> = before.get("updated_at");

  let mut late = provenance("initial-sync-existing-late");
  late.client_created_at = Some(Utc::now() - Duration::days(30));
  late.client_updated_at = Some(Utc::now() - Duration::days(20));
  doc_service(&pool)
    .push_internal_update_with_context(
      workspace_id,
      doc_id,
      vec![0, 0],
      0,
      DocSpaceKind::Workspace,
      Some(user_id),
      Some("myoxus-native".to_string()),
      Some("document-metadata,sync,offline-origin-v1".to_string()),
      Some(late),
    )
    .await
    .expect("later provenance is ignored");

  let after = sqlx::query("SELECT created_at, updated_at FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("existing doc after push");
  assert_eq!(after.get::<chrono::DateTime<Utc>, _>("created_at"), before_created_at);
  assert_eq!(after.get::<chrono::DateTime<Utc>, _>("updated_at"), before_updated_at);

  let resolution_kind: String = sqlx::query_scalar(
    "SELECT resolution_kind FROM document_initial_sync_audit WHERE doc_id = $1 AND idempotency_key = $2",
  )
  .bind(doc_id)
  .bind(format!("server-first-sync:{workspace_id}:{doc_id}"))
  .fetch_one(&pool)
  .await
  .expect("ignored provenance audit");
  assert_eq!(resolution_kind, "ignored_existing_document");

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_docmeta_initial_sync04_explicit_import_without_user_mapping_keeps_actor_as_system_fact() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-import-actor", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let historical_created_by = Uuid::new_v4();
  let historical_updated_by = Uuid::new_v4();
  let mut input = provenance("initial-sync-import-no-mapping");
  input.provenance_mode = InitialDocumentProvenanceMode::ExplicitImport;
  input.client_created_by = Some(historical_created_by);
  input.client_updated_by = Some(historical_updated_by);

  let mut tx = pool.begin().await.expect("begin explicit import transaction");
  ensure_imported_workspace_document(
    &mut tx,
    ImportedWorkspaceDocumentCreate {
      doc_id,
      workspace_id,
      title: "Imported document",
      actor_user_id: user_id,
      client_format: "myoxus-test-import",
      provenance: &input,
      update_existing_title: false,
    },
  )
  .await
  .expect("explicit import without mapping");
  tx.commit().await.expect("commit explicit import transaction");

  let row = sqlx::query("SELECT created_by, updated_by FROM docs WHERE id = $1 AND workspace_id = $2")
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("created docs row");
  assert_eq!(row.get::<Option<Uuid>, _>("created_by"), Some(user_id));
  assert_eq!(row.get::<Option<Uuid>, _>("updated_by"), Some(user_id));
  assert_ne!(row.get::<Option<Uuid>, _>("created_by"), Some(historical_created_by));
  assert_ne!(row.get::<Option<Uuid>, _>("updated_by"), Some(historical_updated_by));

  let audit = sqlx::query(
    "SELECT provenance_mode, decision_code, rejected_fields, normalized_provenance \
       FROM document_initial_sync_audit WHERE doc_id = $1 AND idempotency_key = 'initial-sync-import-no-mapping'",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("initial sync audit");
  assert_eq!(audit.get::<String, _>("provenance_mode"), "explicit_import");
  assert_eq!(
    audit.get::<String, _>("decision_code"),
    "client_provenance_partially_rejected"
  );
  let rejected = audit.get::<Value, _>("rejected_fields");
  assert_eq!(
    rejected.get("clientCreatedBy").and_then(Value::as_str),
    Some("historical_user_mapping_required")
  );
  assert_eq!(
    rejected.get("clientUpdatedBy").and_then(Value::as_str),
    Some("historical_user_mapping_required")
  );
  let normalized = audit.get::<Value, _>("normalized_provenance");
  let historical_created_by = historical_created_by.to_string();
  let historical_updated_by = historical_updated_by.to_string();
  assert_eq!(
    normalized.get("clientCreatedBy").and_then(Value::as_str),
    Some(historical_created_by.as_str()),
    "historical actor must remain visible as audit context"
  );
  assert_eq!(
    normalized.get("clientUpdatedBy").and_then(Value::as_str),
    Some(historical_updated_by.as_str()),
    "historical actor must remain visible as audit context"
  );

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_docmeta_initial_sync07_git_sync_import_uses_provenance_audit_for_docs_create() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-git-import", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  crate::helpers::create_workspace_root_doc(&pool, workspace_id, user_id).await;
  let profile_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let sync_id = Uuid::new_v4();
  let now = Utc::now();
  let profile = GitSyncProfile {
    id: profile_id,
    workspace_id,
    owner_id: user_id,
    repo_url: format!("https://example.invalid/{workspace_id}/repo.git"),
    branch: "main".to_string(),
    root_path: "content/".to_string(),
    manifest_path: myoxus_application::git_sync::export::GIT_SYNC_MANIFEST_PATH.to_string(),
    scope_revision: 0,
    sync_direction: SyncDirection::GitToMyoxus,
    trigger_mode: TriggerMode::Manual,
    polling_interval_secs: None,
    cron_expression: None,
    cron_timezone: None,
    cron_misfire_policy: None,
    cron_next_scheduled_at: None,
    cron_pending_misfire_scheduled_for: None,
    auth_method: AuthMethod::HttpsToken,
    credential_id: None,
    enabled: true,
    max_mirror_storage_mb: None,
    created_at: now,
    updated_at: now,
  };
  let action = SyncAction {
    binding_id: Uuid::nil(),
    doc_id,
    sync_id,
    action: ReconcileAction::CreateInMyoxus,
    repo_path: Some("content/imported.md".to_string()),
  };
  let git_files = vec![(
    "content/imported.md".to_string(),
    "# Imported From Git\n\nBody.".to_string(),
  )];

  crate::helpers::commit_git_sync_import(&pool, &profile, &[action], &git_files)
    .await
    .expect("Git-Sync import must commit through the post-push transaction");

  let doc = sqlx::query("SELECT title, created_by, updated_by FROM docs WHERE id = $1 AND workspace_id = $2")
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("git-imported docs row");
  assert_eq!(
    doc.get::<String, _>("title"),
    "Imported",
    "Git files without frontmatter derive the document title from the repo path, not from a Markdown H1"
  );
  assert_eq!(doc.get::<Option<Uuid>, _>("created_by"), Some(user_id));
  assert_eq!(doc.get::<Option<Uuid>, _>("updated_by"), Some(user_id));

  let snapshot_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("snapshot count");
  assert_eq!(
    snapshot_count, 1,
    "git imports persist their Yjs snapshot in the same action"
  );

  let audit = sqlx::query(
    "SELECT actor_user_id, provenance_mode, resolution_kind, decision_code, idempotency_key, normalized_provenance \
     FROM document_initial_sync_audit WHERE doc_id = $1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("git import initial sync audit");
  assert_eq!(audit.get::<Option<Uuid>, _>("actor_user_id"), Some(user_id));
  assert_eq!(audit.get::<String, _>("provenance_mode"), "explicit_import");
  assert_eq!(audit.get::<String, _>("resolution_kind"), "created");
  assert_eq!(audit.get::<String, _>("decision_code"), "client_provenance_applied");
  assert_eq!(
    audit.get::<String, _>("idempotency_key"),
    format!("git-sync-import:{profile_id}:{sync_id}:{doc_id}")
  );
  let normalized = audit.get::<Value, _>("normalized_provenance");
  assert_eq!(normalized.get("clientFamily").and_then(Value::as_str), Some("git-sync"));
  assert_eq!(
    normalized.get("sourcePropertyDocRevision").and_then(Value::as_str),
    Some("content/imported.md")
  );

  crate::helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}
