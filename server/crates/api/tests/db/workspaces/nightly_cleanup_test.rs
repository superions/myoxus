//! Nightly cleanup job integration tests.
//!
//! Verifies that all cleanup SQL queries execute successfully against the
//! real test database and that they target the correct tables/columns.
//! These tests catch schema drift (e.g. referencing non-existent columns).

use crate::helpers;
use std::sync::Arc;

use myoxus_application::maintenance::RetentionService;
use myoxus_domain::entities::{DocumentVersion, DocumentVersionCreateInput, DocumentVersionEvent, DocumentVersionKind};
use myoxus_domain::repositories::{DocumentVersionRepository, RepositoryError};
use myoxus_infrastructure::document_version::PgDocumentVersionRepository;
use myoxus_infrastructure::maintenance::SqlxRetentionRepository;

fn version_for_history(
  doc_id: uuid::Uuid,
  workspace_id: uuid::Uuid,
  history_id: i64,
  actor_id: uuid::Uuid,
  label: &str,
) -> DocumentVersion {
  DocumentVersion::new_for_create(DocumentVersionCreateInput {
    id: uuid::Uuid::new_v4(),
    doc_id,
    workspace_id,
    doc_history_id: history_id,
    label: label.to_string(),
    description: None,
    event: DocumentVersionEvent::Manual,
    kind: DocumentVersionKind::Checkpoint,
    created_by: actor_id,
    created_at: chrono::Utc::now(),
    is_pinned: false,
    is_protected: false,
    policy_id: None,
    policy_snapshot: serde_json::json!({}),
    content_hash: None,
    metadata: serde_json::json!({}),
  })
}

// ── Test: cleanExpiredHistories targets doc_histories, NOT doc_snapshots ──

#[tokio::test]
async fn nightly_clean_expired_histories_preserves_every_named_reference_and_current_snapshot() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  // Create a workspace + doc + history entry older than 30 days
  let ws_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'NightlyTest')")
    .bind(ws_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("DB operation");
  let doc_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'TestDoc')")
    .bind(doc_id)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("DB operation");

  let unreferenced_id: i64 = sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at) VALUES ($1, $2, $3, NOW() - INTERVAL '60 days') RETURNING id")
    .bind(doc_id).bind(ws_id).bind(&b"old-unreferenced"[..]).fetch_one(&pool).await.expect("DB operation");
  let mut referenced_ids = Vec::new();
  for (label, event, kind, pinned, protected) in [
    ("named", "manual", "checkpoint", false, false),
    ("pinned", "manual", "milestone", true, false),
    ("protected", "daily", "checkpoint", false, true),
    ("pdf", "pdf_export", "exported", false, false),
  ] {
    let history_id: i64 = sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at) VALUES ($1, $2, $3, NOW() - INTERVAL '60 days') RETURNING id")
      .bind(doc_id).bind(ws_id).bind(label.as_bytes()).fetch_one(&pool).await.expect("insert referenced history");
    sqlx::query("INSERT INTO document_version (doc_id, workspace_id, doc_history_id, label, created_by, event, kind, is_pinned, is_protected) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")
      .bind(doc_id).bind(ws_id).bind(history_id).bind(label).bind(admin_id).bind(event).bind(kind).bind(pinned).bind(protected)
      .execute(&pool).await.expect("insert history reference");
    referenced_ids.push(history_id);
  }
  let recent_id: i64 = sqlx::query_scalar(
    "INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(&b"recent"[..])
  .fetch_one(&pool)
  .await
  .expect("insert recent history");

  // Insert a doc_snapshot (must NOT be deleted)
  sqlx::query("INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence) VALUES ($1, $2, $3, 1)")
    .bind(doc_id)
    .bind(ws_id)
    .bind(&b"current-content"[..])
    .execute(&pool)
    .await
    .expect("DB operation");

  let service = RetentionService::new(Arc::new(SqlxRetentionRepository::new(pool.clone())));
  assert_eq!(service.clean_document_histories(30).await.expect("clean histories"), 1);
  let remaining: Vec<i64> = sqlx::query_scalar("SELECT id FROM doc_histories WHERE doc_id = $1 ORDER BY id")
    .bind(doc_id)
    .fetch_all(&pool)
    .await
    .expect("read remaining histories");
  let mut expected = referenced_ids;
  expected.push(recent_id);
  expected.sort_unstable();
  assert_eq!(
    remaining, expected,
    "all named references and recent unnamed history survive"
  );
  assert!(!remaining.contains(&unreferenced_id));

  // Verify doc_snapshot is still there (CRITICAL: must not be deleted)
  let snapshot_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("DB operation");
  assert_eq!(snapshot_count, 1, "doc_snapshot must NOT be deleted by history cleanup");

  // Cleanup
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace-scoped test data");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn nightly_history_cleanup_skips_contended_naming_and_reports_stale_history() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let ws_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'NamingRace')")
    .bind(ws_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("insert workspace");
  let doc_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'NamingRace')")
    .bind(doc_id)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("insert document");
  let history_id: i64 = sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at) VALUES ($1, $2, $3, NOW() - INTERVAL '60 days') RETURNING id")
    .bind(doc_id).bind(ws_id).bind(&b"contended"[..]).fetch_one(&pool).await.expect("insert history");

  let mut naming = pool.begin().await.expect("begin naming transaction");
  sqlx::query("SELECT id FROM doc_histories WHERE id = $1 FOR UPDATE")
    .bind(history_id)
    .fetch_one(&mut *naming)
    .await
    .expect("lock history for naming");
  let cleanup_pool = pool.clone();
  let cleanup = tokio::spawn(async move {
    RetentionService::new(Arc::new(SqlxRetentionRepository::new(cleanup_pool)))
      .clean_document_histories(30)
      .await
  });
  tokio::time::sleep(std::time::Duration::from_millis(400)).await;
  sqlx::query("INSERT INTO document_version (doc_id, workspace_id, doc_history_id, label, created_by) VALUES ($1, $2, $3, 'named while cleanup ran', $4)")
    .bind(doc_id).bind(ws_id).bind(history_id).bind(admin_id).execute(&mut *naming).await.expect("name locked history");
  naming.commit().await.expect("commit naming");
  assert_eq!(cleanup.await.expect("join cleanup").expect("cleanup result"), 0);
  assert!(
    sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM doc_histories WHERE id = $1)")
      .bind(history_id)
      .fetch_one(&pool)
      .await
      .expect("read named history")
  );

  let stale_history_id: i64 = sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at) VALUES ($1, $2, $3, NOW() - INTERVAL '60 days') RETURNING id")
    .bind(doc_id).bind(ws_id).bind(&b"stale"[..]).fetch_one(&pool).await.expect("insert stale history");
  RetentionService::new(Arc::new(SqlxRetentionRepository::new(pool.clone())))
    .clean_document_histories(30)
    .await
    .expect("expire stale history");
  let error = PgDocumentVersionRepository::new(pool.clone())
    .create(&version_for_history(
      doc_id,
      ws_id,
      stale_history_id,
      admin_id,
      "too late",
    ))
    .await
    .expect_err("expired history cannot be named");
  assert!(matches!(error, RepositoryError::NotFound("document history")));

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup workspace");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanExpiredUserSessions SQL is valid ──

#[tokio::test]
async fn nightly_clean_expired_sessions_sql_valid() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  // This must not error — verifies the column exists
  let result = sqlx::query("DELETE FROM sessions WHERE expires_at < NOW()")
    .execute(&pool)
    .await;
  assert!(
    result.is_ok(),
    "cleanExpiredUserSessions SQL must be valid: {:?}",
    result.err()
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanExpiredNotifications SQL is valid ──

#[tokio::test]
async fn nightly_clean_expired_notifications_sql_valid() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let result = sqlx::query("DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'")
    .execute(&pool)
    .await;
  assert!(
    result.is_ok(),
    "cleanExpiredNotifications SQL must be valid: {:?}",
    result.err()
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanExpiredPendingBlobs SQL is valid ──

#[tokio::test]
async fn nightly_clean_expired_pending_blobs_sql_valid() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let result = sqlx::query("DELETE FROM blobs WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'")
    .execute(&pool)
    .await;
  assert!(
    result.is_ok(),
    "cleanExpiredPendingBlobs SQL must be valid: {:?}",
    result.err()
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanProcessedOutboxEvents SQL is valid ──

#[tokio::test]
async fn nightly_clean_processed_outbox_events_sql_valid() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let result = sqlx::query(
    "DELETE FROM outbox_events WHERE processed_at IS NOT NULL AND processed_at < NOW() - INTERVAL '7 days'",
  )
  .execute(&pool)
  .await;
  assert!(
    result.is_ok(),
    "cleanProcessedOutboxEvents SQL must be valid: {:?}",
    result.err()
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanMergedDocUpdates SQL is valid ──

#[tokio::test]
async fn nightly_clean_merged_doc_updates_sql_valid() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let result = sqlx::query(
    "DELETE FROM doc_updates du USING doc_snapshots ds WHERE du.doc_id = ds.doc_id AND du.sequence <= ds.last_sequence",
  )
  .execute(&pool)
  .await;
  assert!(
    result.is_ok(),
    "cleanMergedDocUpdates SQL must be valid: {:?}",
    result.err()
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanOrphanedSessionLinks SQL references correct columns ──

#[tokio::test]
async fn nightly_clean_orphaned_session_links_sql_valid() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  // NIGHTLY-ROB-01: The query must reference session_id and root_session_id,
  // NOT linked_session_id (which does not exist on session_links).
  let result = sqlx::query(
    "DELETE FROM session_links sl WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = sl.session_id) OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = sl.root_session_id)"
  ).execute(&pool).await;
  assert!(
    result.is_ok(),
    "cleanOrphanedSessionLinks SQL must be valid: {:?}",
    result.err()
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: doc_snapshots must NEVER be targeted by nightly cleanup ──

#[tokio::test]
async fn nightly_must_never_delete_doc_snapshots() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let ws_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'SnapshotProtectionTest')")
    .bind(ws_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("DB operation");
  let doc_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'OldDoc')")
    .bind(doc_id)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("DB operation");

  // Create a very old snapshot (100 days)
  sqlx::query("INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at) VALUES ($1, $2, $3, 1, NOW() - INTERVAL '100 days')")
    .bind(doc_id).bind(ws_id).bind(&b"precious-content"[..]).execute(&pool).await.expect("DB operation");

  // Run ALL nightly cleanup SQLs — none of them should touch doc_snapshots
  let _ = sqlx::query("DELETE FROM sessions WHERE expires_at < NOW()")
    .execute(&pool)
    .await;
  RetentionService::new(Arc::new(SqlxRetentionRepository::new(pool.clone())))
    .clean_document_histories(30)
    .await
    .expect("clean histories");
  let _ = sqlx::query("DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'")
    .execute(&pool)
    .await;
  let _ = sqlx::query("DELETE FROM blobs WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'")
    .execute(&pool)
    .await;
  let _ = sqlx::query(
    "DELETE FROM outbox_events WHERE processed_at IS NOT NULL AND processed_at < NOW() - INTERVAL '7 days'",
  )
  .execute(&pool)
  .await;
  let _ = sqlx::query(
    "DELETE FROM doc_updates du USING doc_snapshots ds WHERE du.doc_id = ds.doc_id AND du.sequence <= ds.last_sequence",
  )
  .execute(&pool)
  .await;

  // The 100-day-old snapshot MUST still exist
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("DB operation");
  assert_eq!(count, 1, "CRITICAL: doc_snapshot was deleted by a nightly cleanup job!");

  // Cleanup
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace-scoped test data");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: git_sync_profiles table exists (used by cleanStaleGitSyncRepos) ──

#[tokio::test]
async fn nightly_git_sync_profiles_table_exists() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let result = sqlx::query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM git_sync_profiles")
    .fetch_one(&pool)
    .await;
  assert!(result.is_ok(), "git_sync_profiles table must exist: {:?}", result.err());

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanExpiredUserSessions deletes expired, preserves valid ──

#[tokio::test]
async fn nightly_sessions_deletes_expired_preserves_valid() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let expired_id = uuid::Uuid::new_v4();
  let valid_id = uuid::Uuid::new_v4();
  sqlx::query(
    "INSERT INTO sessions (id, user_id, expires_at, refresh_after) VALUES ($1, $2, NOW() - INTERVAL '1 day', NOW())",
  )
  .bind(expired_id)
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("DB operation");
  sqlx::query(
    "INSERT INTO sessions (id, user_id, expires_at, refresh_after) VALUES ($1, $2, NOW() + INTERVAL '7 days', NOW())",
  )
  .bind(valid_id)
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("DB operation");

  let result = sqlx::query("DELETE FROM sessions WHERE expires_at < NOW()")
    .execute(&pool)
    .await
    .expect("DB operation");
  assert!(result.rows_affected() >= 1, "should delete expired session");

  let valid_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE id = $1)")
    .bind(valid_id)
    .fetch_one(&pool)
    .await
    .expect("DB operation");
  assert!(valid_exists, "valid session must be preserved");

  // Cleanup
  sqlx::query("DELETE FROM sessions WHERE id = $1")
    .bind(valid_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace-scoped test data");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanExpiredNotifications deletes old, preserves recent ──

#[tokio::test]
async fn nightly_notifications_deletes_old_preserves_recent() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let old_id = uuid::Uuid::new_v4();
  let recent_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO notifications (id, user_id, notification_type, created_at) VALUES ($1, $2, 'mention', NOW() - INTERVAL '120 days')")
    .bind(old_id).bind(admin_id).execute(&pool).await.expect("DB operation");
  sqlx::query("INSERT INTO notifications (id, user_id, notification_type, created_at) VALUES ($1, $2, 'mention', NOW() - INTERVAL '10 days')")
    .bind(recent_id).bind(admin_id).execute(&pool).await.expect("DB operation");

  sqlx::query("DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'")
    .execute(&pool)
    .await
    .expect("DB operation");
  // Check that OUR specific old notification is gone (rows_affected() >= 1 is racy
  // when parallel tests run the same DELETE and delete it first).
  let old_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM notifications WHERE id = $1)")
    .bind(old_id)
    .fetch_one(&pool)
    .await
    .expect("DB operation");
  assert!(
    !old_exists,
    "old notification must have been deleted by the cleanup query"
  );

  let recent_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM notifications WHERE id = $1)")
    .bind(recent_id)
    .fetch_one(&pool)
    .await
    .expect("DB operation");
  assert!(recent_exists, "recent notification must be preserved");

  // Cleanup
  sqlx::query("DELETE FROM notifications WHERE id = $1")
    .bind(recent_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace-scoped test data");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanProcessedOutboxEvents deletes old processed, preserves unprocessed ──

#[tokio::test]
async fn nightly_outbox_deletes_old_processed_preserves_unprocessed() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let ws_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'OutboxTest')")
    .bind(ws_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("DB operation");

  use futures_util::FutureExt;
  let result = std::panic::AssertUnwindSafe(async {
    let old_id = uuid::Uuid::new_v4();
    let unprocessed_id = uuid::Uuid::new_v4();
    let task_id = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, processed_at, created_at) VALUES ($1, 'workspace', $2, 'mention', NOW() - INTERVAL '14 days', NOW() - INTERVAL '14 days')")
      .bind(old_id).bind(ws_id.to_string()).execute(&pool).await.expect("DB operation");
    sqlx::query("INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, created_at) VALUES ($1, 'workspace', $2, 'mention', NOW() - INTERVAL '14 days')")
      .bind(unprocessed_id).bind(ws_id.to_string()).execute(&pool).await.expect("DB operation");

    sqlx::query("INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, processed_at, created_at) VALUES ($1, 'database_task', $2, 'database_task_notification', jsonb_build_object('deliveryComplete',false), NOW() - INTERVAL '14 days', NOW() - INTERVAL '14 days')")
      .bind(task_id).bind(ws_id.to_string()).execute(&pool).await.expect("insert handed-off unfinished Task intent");

    // Exercise the real retention adapter: queue handoff alone must not destroy
    // the receipt needed by an unfinished or retryable Task delivery.
    use myoxus_application::maintenance::RetentionRepository;
    let retention = SqlxRetentionRepository::new(pool.clone());
    retention
      .clean_processed_outbox_events(7)
      .await
      .expect("run processed outbox retention");
    let task_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM outbox_events WHERE id=$1)")
      .bind(task_id)
      .fetch_one(&pool)
      .await
      .expect("read pending Task receipt");
    assert!(
      task_exists,
      "accepted but unfinished Task delivery must survive retention"
    );
    sqlx::query("UPDATE outbox_events SET payload=jsonb_set(payload,'{deliveryComplete}','true'::jsonb) WHERE id=$1")
      .bind(task_id)
      .execute(&pool)
      .await
      .expect("record terminal Task delivery");
    retention
      .clean_processed_outbox_events(7)
      .await
      .expect("retain only unfinished delivery");
    let task_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM outbox_events WHERE id=$1)")
      .bind(task_id)
      .fetch_one(&pool)
      .await
      .expect("read completed Task receipt");
    assert!(
      !task_exists,
      "completed Task receipt follows the original processed-at retention"
    );

    // Verify OUR specific old processed event is gone (rows_affected() >= 1 is racy
    // when parallel tests run the same DELETE and delete it first).
    let old_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM outbox_events WHERE id = $1)")
      .bind(old_id)
      .fetch_one(&pool)
      .await
      .expect("DB operation");
    assert!(!old_exists, "old processed outbox event must have been deleted");

    let unprocessed_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM outbox_events WHERE id = $1)")
      .bind(unprocessed_id)
      .fetch_one(&pool)
      .await
      .expect("DB operation");
    assert!(unprocessed_exists, "unprocessed event must be preserved");
  }).catch_unwind().await;

  sqlx::query("DELETE FROM outbox_events WHERE aggregate_id=$1")
    .bind(ws_id.to_string())
    .execute(&pool)
    .await
    .expect("cleanup owned outbox events");
  sqlx::query("DELETE FROM workspaces WHERE id=$1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup owned workspace");
  helpers::cleanup_users(&pool, &[admin_id]).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

// ── Test: cleanExpiredPendingBlobs deletes old pending, preserves completed ──

#[tokio::test]
async fn nightly_blobs_deletes_old_pending_preserves_completed() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let ws_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'BlobTest')")
    .bind(ws_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("DB operation");

  sqlx::query("INSERT INTO blobs (workspace_id, key, size, mime, status, created_at) VALUES ($1, 'old-pending', 100, 'application/octet-stream', 'pending', NOW() - INTERVAL '48 hours')")
    .bind(ws_id).execute(&pool).await.expect("DB operation");
  sqlx::query("INSERT INTO blobs (workspace_id, key, size, mime, status, created_at) VALUES ($1, 'completed-old', 200, 'application/octet-stream', 'completed', NOW() - INTERVAL '48 hours')")
    .bind(ws_id).execute(&pool).await.expect("DB operation");

  sqlx::query("DELETE FROM blobs WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'")
    .execute(&pool)
    .await
    .expect("DB operation");

  // Verify OUR specific old-pending blob was deleted (rows_affected() >= 1 would
  // be racy if another test ran the same DELETE first and got it before us).
  let old_pending_exists: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM blobs WHERE workspace_id = $1 AND key = 'old-pending')")
      .bind(ws_id)
      .fetch_one(&pool)
      .await
      .expect("DB operation");
  assert!(!old_pending_exists, "old pending blob must have been deleted");

  let completed_exists: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM blobs WHERE workspace_id = $1 AND key = 'completed-old')")
      .bind(ws_id)
      .fetch_one(&pool)
      .await
      .expect("DB operation");
  assert!(completed_exists, "completed blob must be preserved");

  // Cleanup: blobs before workspace (no CASCADE on workspace_id for blobs)
  sqlx::query("DELETE FROM blobs WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete blobs");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace-scoped test data");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: reconcileStorageStats SQL is valid and updates stats ──

#[tokio::test]
async fn nightly_reconcile_storage_stats_sql_valid() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let ws_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'StorageStatsTest')")
    .bind(ws_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("DB operation");

  // Run the reconcile SQL scoped to our test workspace.
  // The full table-wide INSERT-SELECT (no WHERE w.id = $1) is racy in parallel
  // tests: between our SELECT and INSERT, another test can delete a different
  // workspace, causing a FK violation on workspace_storage_stats.  Scoping to
  // our own workspace proves the SQL structure is correct without that race.
  let result = sqlx::query(
    r#"INSERT INTO workspace_storage_stats (workspace_id, snapshot_size, blob_size, updated_at)
       SELECT w.id,
         COALESCE((SELECT SUM(length(payload))::bigint FROM doc_snapshots ds WHERE ds.workspace_id = w.id), 0),
         COALESCE((SELECT SUM(size)::bigint FROM blobs b WHERE b.workspace_id = w.id AND b.status = 'completed'), 0),
         now()
       FROM workspaces w WHERE w.deleted_at IS NULL AND w.id = $1
       ON CONFLICT (workspace_id) DO UPDATE SET
         snapshot_size = EXCLUDED.snapshot_size, blob_size = EXCLUDED.blob_size, updated_at = now()"#,
  )
  .bind(ws_id)
  .execute(&pool)
  .await;
  assert!(
    result.is_ok(),
    "reconcileStorageStats SQL must be valid: {:?}",
    result.err()
  );

  // Verify our workspace got a stats row
  let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_storage_stats WHERE workspace_id = $1)")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("DB operation");
  assert!(exists, "reconcile must create stats row for workspace");

  // Cleanup: stats before workspace (no CASCADE for storage_stats)
  sqlx::query("DELETE FROM workspace_storage_stats WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace_storage_stats");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace-scoped test data");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: reconcileStorageStats daily snapshot SQL is valid ──

#[tokio::test]
async fn nightly_reconcile_storage_stats_daily_snapshot_sql_valid() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let ws_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'DailySnapshotTest')")
    .bind(ws_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("DB operation");
  sqlx::query("INSERT INTO workspace_storage_stats (workspace_id, snapshot_size, blob_size) VALUES ($1, 42, 99)")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("DB operation");

  let result = sqlx::query(
    r#"INSERT INTO workspace_storage_stats_daily (workspace_id, day, snapshot_size, blob_size)
       SELECT s.workspace_id, CURRENT_DATE, s.snapshot_size, s.blob_size
       FROM workspace_storage_stats s
       WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.id = s.workspace_id)
       ON CONFLICT (workspace_id, day) DO UPDATE SET
         snapshot_size = EXCLUDED.snapshot_size, blob_size = EXCLUDED.blob_size"#,
  )
  .execute(&pool)
  .await;
  assert!(result.is_ok(), "daily snapshot SQL must be valid: {:?}", result.err());

  let exists: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_storage_stats_daily WHERE workspace_id = $1)")
      .bind(ws_id)
      .fetch_one(&pool)
      .await
      .expect("DB operation");
  assert!(exists, "daily snapshot must be created");

  // Cleanup: daily → stats → workspace (correct FK order)
  sqlx::query("DELETE FROM workspace_storage_stats_daily WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete daily storage stats");
  sqlx::query("DELETE FROM workspace_storage_stats WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace_storage_stats");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace-scoped test data");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: all nightly cleanup SQLs succeed on empty tables (no-op edge case) ──

#[tokio::test]
async fn nightly_all_cleanups_succeed_on_empty_tables() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  // Each cleanup SQL must succeed even when the target table has no matching rows.
  let queries = vec![
    "DELETE FROM sessions WHERE expires_at < NOW()",
    "DELETE FROM doc_histories WHERE created_at < NOW() - INTERVAL '30 days'",
    "DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days'",
    "DELETE FROM blobs WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'",
    "DELETE FROM outbox_events WHERE processed_at IS NOT NULL AND processed_at < NOW() - INTERVAL '7 days'",
    "DELETE FROM doc_updates du USING doc_snapshots ds WHERE du.doc_id = ds.doc_id AND du.sequence <= ds.last_sequence",
  ];
  for sql in queries {
    let result = sqlx::query(sql).execute(&pool).await;
    assert!(
      result.is_ok(),
      "nightly SQL must not error on empty table: {sql} — {:?}",
      result.err()
    );
  }

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ── Test: cleanExpiredHistories preserves recent histories ──

#[tokio::test]
async fn nightly_histories_preserves_recent() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let ws_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'RecentHistTest')")
    .bind(ws_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("DB operation");
  let doc_id = uuid::Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Doc')")
    .bind(doc_id)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("DB operation");

  // Insert a recent history (5 days old — within 30-day retention)
  sqlx::query("INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at) VALUES ($1, $2, $3, NOW() - INTERVAL '5 days')")
    .bind(doc_id).bind(ws_id).bind(&b"recent"[..]).execute(&pool).await.expect("DB operation");

  let result = sqlx::query("DELETE FROM doc_histories WHERE created_at < NOW() - INTERVAL '30 days'")
    .execute(&pool)
    .await
    .expect("DB operation");
  assert_eq!(result.rows_affected(), 0, "recent history must NOT be deleted");

  // Cleanup
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace-scoped test data");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}
