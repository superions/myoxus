// SPDX-License-Identifier: AGPL-3.0-or-later
//! Concurrency gates for document sync provenance and metadata materialization.

use chrono::{Duration, Utc};
use myoxus_application::doc::{DocService, DocSpaceKind, InitialDocumentProvenance, InitialDocumentProvenanceMode};
use myoxus_application::git_sync::doc_reconcile_plan::SyncAction;
use myoxus_application::git_sync::reconcile::ReconcileAction;
use myoxus_domain::git_sync::{AuthMethod, GitSyncProfile, SyncDirection, TriggerMode};
use myoxus_infrastructure::doc::SqlxDocStore;
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
    client_created_at: Some(Utc::now() - Duration::minutes(15)),
    client_updated_at: Some(Utc::now() - Duration::minutes(5)),
    client_created_by: None,
    client_updated_by: None,
    historical_user_mapping_id: None,
    source_property_doc_revision: None,
  }
}

#[tokio::test]
async fn inv_docmeta_initial_sync_concurrency01_replay_writes_one_audit_and_monotonic_updates() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-race", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let first = provenance("initial-sync-race-key");
  let second = first.clone();
  let service_a = doc_service(&pool);
  let service_b = doc_service(&pool);

  let push_a = service_a.push_internal_update_with_context(
    workspace_id,
    doc_id,
    vec![0, 0],
    0,
    DocSpaceKind::Workspace,
    Some(user_id),
    Some("myoxus-native".to_string()),
    Some("document-metadata,sync,offline-origin-v1".to_string()),
    Some(first),
  );
  let push_b = service_b.push_internal_update_with_context(
    workspace_id,
    doc_id,
    vec![0, 0],
    0,
    DocSpaceKind::Workspace,
    Some(user_id),
    Some("myoxus-native".to_string()),
    Some("document-metadata,sync,offline-origin-v1".to_string()),
    Some(second),
  );
  let (a, b) = tokio::join!(push_a, push_b);
  a.expect("first push");
  b.expect("second push");

  let docs_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("docs count");
  let audit_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_initial_sync_audit WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("audit count");
  let sequences: Vec<i64> = sqlx::query_scalar("SELECT sequence FROM doc_updates WHERE doc_id = $1 ORDER BY sequence")
    .bind(doc_id)
    .fetch_all(&pool)
    .await
    .expect("sequences");
  assert_eq!(docs_count, 1);
  assert_eq!(
    audit_count, 1,
    "idempotent replay must not create duplicate provenance decisions"
  );
  assert_eq!(sequences, vec![1, 2]);

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_docmeta_initial_sync_concurrency02_conflicting_provenance_has_one_create_decision() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-conflict-race", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let mut first = provenance("initial-sync-conflict-a");
  first.client_instance_id = Some(Uuid::new_v4().to_string());
  first.client_created_at = Some(Utc::now() - Duration::hours(4));
  first.client_updated_at = Some(Utc::now() - Duration::hours(3));
  let mut second = provenance("initial-sync-conflict-b");
  second.client_instance_id = Some(Uuid::new_v4().to_string());
  second.client_created_at = Some(Utc::now() - Duration::hours(2));
  second.client_updated_at = Some(Utc::now() - Duration::hours(1));
  let service_a = doc_service(&pool);
  let service_b = doc_service(&pool);

  let push_a = service_a.push_internal_update_with_context(
    workspace_id,
    doc_id,
    vec![0, 0],
    0,
    DocSpaceKind::Workspace,
    Some(user_id),
    Some("myoxus-native".to_string()),
    Some("document-metadata,sync,offline-origin-v1".to_string()),
    Some(first),
  );
  let push_b = service_b.push_internal_update_with_context(
    workspace_id,
    doc_id,
    vec![1, 1],
    0,
    DocSpaceKind::Workspace,
    Some(user_id),
    Some("myoxus-native".to_string()),
    Some("document-metadata,sync,offline-origin-v1".to_string()),
    Some(second),
  );
  let (a, b) = tokio::join!(push_a, push_b);
  a.expect("first conflicting push");
  b.expect("second conflicting push");

  let docs_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("docs count");
  assert_eq!(docs_count, 1);

  let doc_row = sqlx::query("SELECT created_at, updated_at FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("created doc row");
  let doc_created_at: chrono::DateTime<Utc> = doc_row.get("created_at");
  let doc_updated_at: chrono::DateTime<Utc> = doc_row.get("updated_at");
  let audit_rows = sqlx::query(
    "SELECT resolution_kind, applied_created_at, applied_updated_at \
       FROM document_initial_sync_audit WHERE doc_id = $1",
  )
  .bind(doc_id)
  .fetch_all(&pool)
  .await
  .expect("audit rows");
  let created_rows = audit_rows
    .iter()
    .filter(|row| row.get::<String, _>("resolution_kind") == "created")
    .collect::<Vec<_>>();
  assert_eq!(created_rows.len(), 1, "exactly one transaction may create docs");
  assert_eq!(
    audit_rows.len(),
    1,
    "normal and offline sync retries share the server-derived first-sync key"
  );
  assert_eq!(
    doc_created_at,
    created_rows[0].get::<chrono::DateTime<Utc>, _>("applied_created_at")
  );
  assert_eq!(
    doc_updated_at,
    created_rows[0].get::<chrono::DateTime<Utc>, _>("applied_updated_at")
  );
  let sequences: Vec<i64> = sqlx::query_scalar("SELECT sequence FROM doc_updates WHERE doc_id = $1 ORDER BY sequence")
    .bind(doc_id)
    .fetch_all(&pool)
    .await
    .expect("sequences");
  assert_eq!(sequences, vec![1, 2]);

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_docmeta_initial_sync_concurrency03_import_and_offline_sync_have_one_create_decision() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "initial-sync-import-offline-race", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let sync_id = Uuid::new_v4();
  let profile_id = Uuid::new_v4();
  let now = Utc::now();
  let profile = GitSyncProfile {
    id: profile_id,
    workspace_id,
    owner_id: user_id,
    repo_url: "https://example.invalid/race.git".to_string(),
    branch: "main".to_string(),
    root_path: "content/".to_string(),
    manifest_path: myoxus_application::git_sync::export::GIT_SYNC_MANIFEST_PATH.to_string(),
    scope_revision: 0,
    sync_direction: SyncDirection::Bidirectional,
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
  let import_action = SyncAction {
    binding_id: Uuid::nil(),
    doc_id,
    sync_id,
    action: ReconcileAction::CreateInMyoxus,
    repo_path: Some("content/race-import.md".to_string()),
  };
  let git_files = vec![(
    "content/race-import.md".to_string(),
    "# Race Import\n\nImported.".to_string(),
  )];
  let offline = provenance("initial-sync-import-offline-race");
  let service = doc_service(&pool);

  let import_actions = vec![import_action];
  let import_push = crate::helpers::commit_git_sync_import(&pool, &profile, &import_actions, &git_files);
  let offline_push = service.push_internal_update_with_context(
    workspace_id,
    doc_id,
    vec![2, 2],
    0,
    DocSpaceKind::Workspace,
    Some(user_id),
    Some("myoxus-native".to_string()),
    Some("document-metadata,sync,offline-origin-v1".to_string()),
    Some(offline),
  );
  let (import_result, offline_result) = tokio::join!(import_push, offline_push);
  import_result.expect("Git-Sync import side must commit through the post-push transaction");
  offline_result.expect("offline sync side must succeed");

  let docs_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("docs count");
  assert_eq!(docs_count, 1);

  let snapshot_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("snapshot count");
  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("update count");
  assert_eq!(snapshot_count, 1, "git import must persist its snapshot exactly once");
  assert_eq!(update_count, 1, "offline sync must persist its update exactly once");

  let audit_rows = sqlx::query(
    "SELECT resolution_kind, provenance_mode, idempotency_key \
       FROM document_initial_sync_audit WHERE doc_id = $1 ORDER BY resolution_kind, provenance_mode",
  )
  .bind(doc_id)
  .fetch_all(&pool)
  .await
  .expect("audit rows");
  let created_count = audit_rows
    .iter()
    .filter(|row| row.get::<String, _>("resolution_kind") == "created")
    .count();
  let ignored_count = audit_rows
    .iter()
    .filter(|row| row.get::<String, _>("resolution_kind") == "ignored_existing_document")
    .count();
  let modes = audit_rows
    .iter()
    .map(|row| row.get::<String, _>("provenance_mode"))
    .collect::<std::collections::BTreeSet<_>>();
  assert_eq!(created_count, 1, "only one race participant may win first-create");
  assert_eq!(
    ignored_count, 1,
    "the losing race participant must be audited as ignored"
  );
  assert!(
    modes.contains("explicit_import") && modes.contains("offline_sync"),
    "race audit must preserve both participant modes: {modes:?}"
  );

  crate::helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_docmeta_membership_changes_allow_document_update_foreign_keys() {
  use futures_util::FutureExt;
  use myoxus_application::workspace::WorkspaceStore;
  use myoxus_domain::entities::WorkspaceRole;
  use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
  use std::panic::{AssertUnwindSafe, resume_unwind};

  let pool = crate::helpers::setup_pool().await;
  let membership_pool = sqlx::postgres::PgPoolOptions::new()
    .max_connections(1)
    .connect_with(pool.connect_options().as_ref().clone())
    .await
    .expect("connect dedicated membership backend");
  let owner = crate::helpers::create_user(&pool, "doc-membership-lock-owner", false).await;
  let member = crate::helpers::create_user(&pool, "doc-membership-lock-member", false).await;
  let mut jobs = tokio::task::JoinSet::new();
  let body = AssertUnwindSafe(async {
    let workspace = crate::helpers::create_workspace(&pool, owner).await;
    crate::helpers::add_workspace_member(&pool, workspace, member).await;
    let document = crate::helpers::create_doc(&pool, workspace, owner).await;
    let membership_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
      .fetch_one(&membership_pool)
      .await
      .expect("membership backend PID");
    for remove in [false, true] {
      // Hold exactly the canonical Doc row lock used by push_update before its
      // INSERT. The native membership trigger must wait here while retaining
      // its Workspace governance fence; its FK compatibility is then observable.
      let mut doc_tx = pool.begin().await.expect("start document transaction");
      sqlx::query("SELECT id FROM docs WHERE id=$1 AND workspace_id=$2 FOR UPDATE")
        .bind(document)
        .bind(workspace)
        .fetch_one(&mut *doc_tx)
        .await
        .expect("hold native Doc row lock");
      let document_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *doc_tx)
        .await
        .expect("document backend PID");
      let store = SqlxWorkspaceStore::new(membership_pool.clone(), crate::helpers::database_starter_catalog());
      jobs.spawn(async move {
        if remove {
          store.delete_member(workspace, member).await
        } else {
          store.update_member_role(workspace, member, WorkspaceRole::Reader).await
        }
      });
      let native_statement = if remove {
        "%DELETE FROM workspace_memberships m%"
      } else {
        "%UPDATE workspace_memberships m%"
      };
      tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
          let blocked: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
              SELECT 1 FROM pg_stat_activity
              WHERE pid=$1 AND wait_event_type='Lock'
                AND $2=ANY(pg_blocking_pids(pid)) AND query LIKE $3
            )
          "#,
          )
          .bind(membership_pid)
          .bind(document_pid)
          .bind(native_statement)
          .fetch_one(&pool)
          .await
          .expect("observe native membership trigger Doc wait");
          if blocked {
            break;
          }
          tokio::task::yield_now().await;
        }
      })
      .await
      .expect("membership holds Workspace fence and waits on the owned Doc transaction");
      // This is the real doc_updates insertion/FK path, not a simulated
      // KEY SHARE probe. FOR UPDATE on Workspace would close the wait cycle.
      let sequence = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        sqlx::query_scalar::<_, i64>(
          r#"
          INSERT INTO doc_updates(doc_id, workspace_id, payload, sequence)
          VALUES ($1, $2, $3,
            GREATEST(
              COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE doc_id=$1 AND workspace_id=$2), 0),
              COALESCE((SELECT last_sequence FROM doc_snapshots WHERE doc_id=$1 AND workspace_id=$2), 0)
            ) + 1)
          RETURNING sequence
        "#,
        )
        .bind(document)
        .bind(workspace)
        .bind(vec![0_u8, 0])
        .fetch_one(&mut *doc_tx),
      )
      .await
      .expect("document INSERT FK must pass the membership Workspace fence")
      .expect("native document update INSERT succeeds");
      assert_eq!(sequence, if remove { 2 } else { 1 });
      doc_tx
        .commit()
        .await
        .expect("commit document update before releasing trigger");
      tokio::time::timeout(std::time::Duration::from_secs(5), jobs.join_next())
        .await
        .expect("native membership operation finishes after Doc commit")
        .expect("membership job exists")
        .expect("membership job does not panic")
        .expect("membership change commits without deadlock");
      let role: Option<String> =
        sqlx::query_scalar("SELECT role::text FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
          .bind(workspace)
          .bind(member)
          .fetch_optional(&pool)
          .await
          .expect("read committed membership");
      assert_eq!(role.as_deref(), if remove { None } else { Some("Reader") });
      let materialized: bool = sqlx::query_scalar("SELECT metadata_materialized_at IS NOT NULL FROM docs WHERE id=$1")
        .bind(document)
        .fetch_one(&pool)
        .await
        .expect("read metadata trigger result");
      assert!(materialized, "membership metadata trigger remains active");
    }
    let sequences: Vec<i64> = sqlx::query_scalar("SELECT sequence FROM doc_updates WHERE doc_id=$1 ORDER BY sequence")
      .bind(document)
      .fetch_all(&pool)
      .await
      .expect("read persisted native update stream");
    assert_eq!(sequences, vec![1, 2]);
  })
  .catch_unwind()
  .await;
  jobs.abort_all();
  while jobs.join_next().await.is_some() {}
  membership_pool.close().await;
  crate::helpers::cleanup_users(&pool, &[owner, member]).await;
  if let Err(error) = body {
    resume_unwind(error);
  }
}
