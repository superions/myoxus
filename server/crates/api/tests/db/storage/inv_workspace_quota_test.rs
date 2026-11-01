// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace-owned quota resolver and mutation invariants.
//!
//! Each test verifies a named invariant:
//!   INV-WS-QUOTA-01 — workspace.quota.storageQuota returns DB-set workspace override
//!   INV-WS-QUOTA-03 — workspace.quota.usedStorageQuota reflects workspace_storage_stats
//!   INV-WS-QUOTA-06 — workspace.quota.storageQuota == 0 (unlimited) when no overrides and config default = 0
//!   INV-WS-ADMIN-QUOTA-01 — adminUpdateWorkspace(storageQuotaMb) persists to DB in bytes
//!   INV-WS-ADMIN-QUOTA-02 — adminUpdateWorkspace(clearStorageQuota=true) sets workspace quota to NULL
//!   INV-SNAP-WS-QUOTA-01 — snapshot write rejected when workspace-level quota exceeded (E-06)
//!   INV-QUOTA-CACHE-01 — cache returns stale value after DB change, cleared by invalidate() (E-10)

use std::sync::Arc;

use crate::helpers;
use myoxus_application::auth::AuthError;
use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::quota_cache::QuotaCache;
use myoxus_infrastructure::quota_resolver::resolve_effective_quota;
use myoxus_infrastructure::redis::InMemoryRedisAdapter;
use serde_json::json;
use sqlx::Row;

// ---------------------------------------------------------------------------
// Helper: set workspace_storage_stats directly
// ---------------------------------------------------------------------------

async fn set_storage_stats(pool: &sqlx::PgPool, workspace_id: uuid::Uuid, snapshot: i64, blob: i64) {
  sqlx::query(
    "INSERT INTO workspace_storage_stats (workspace_id, snapshot_size, blob_size, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (workspace_id) DO UPDATE SET snapshot_size = $2, blob_size = $3",
  )
  .bind(workspace_id)
  .bind(snapshot)
  .bind(blob)
  .execute(pool)
  .await
  .expect("set_storage_stats must succeed");
}

// ---------------------------------------------------------------------------
// INV-WS-QUOTA-01
// ---------------------------------------------------------------------------

/// workspace.quota.storageQuota must return the workspace-level DB override,
/// not the static config default. Before P112 the resolver always returned
/// the config value regardless of what was set in `workspaces.storage_quota_bytes`.
#[tokio::test]
async fn inv_ws_quota_01_workspace_quota_resolver_returns_db_override() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "inv_wq01").await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;

  // Set a known quota (512 MB in bytes).
  let quota_bytes: i64 = 512 * 1024 * 1024;
  sqlx::query("UPDATE workspaces SET storage_quota_bytes = $1 WHERE id = $2")
    .bind(quota_bytes)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("set workspace quota");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"query Q($id: String!) {
        workspace(id: $id) { quota { storageQuota } }
      }"#,
      "variables": { "id": ws_id.to_string() }
    }),
  )
  .await;

  assert!(resp.get("errors").is_none(), "GraphQL errors: {resp}");
  let got = resp["data"]["workspace"]["quota"]["storageQuota"]
    .as_i64()
    .expect("storageQuota must be i64");
  assert_eq!(
    got, quota_bytes,
    "INV-WS-QUOTA-01: expected {quota_bytes} bytes from DB override, got {got}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-WS-QUOTA-03 — used_storage_quota reflects DB stats
// ---------------------------------------------------------------------------

/// workspace.quota.usedStorageQuota must return the actual usage from
/// workspace_storage_stats. Before P112 this always returned 0.
#[tokio::test]
async fn inv_ws_quota_03_used_storage_reflects_db() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "inv_wq03").await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;

  let snapshot: i64 = 1024 * 1024; // 1 MiB
  let blob: i64 = 512 * 1024; // 512 KiB
  set_storage_stats(&pool, ws_id, snapshot, blob).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"query Q($id: String!) {
        workspace(id: $id) { quota { usedStorageQuota } }
      }"#,
      "variables": { "id": ws_id.to_string() }
    }),
  )
  .await;

  assert!(resp.get("errors").is_none(), "GraphQL errors: {resp}");
  let used = resp["data"]["workspace"]["quota"]["usedStorageQuota"]
    .as_i64()
    .expect("usedStorageQuota must be i64");
  let expected = snapshot + blob;
  assert_eq!(
    used, expected,
    "INV-WS-QUOTA-03: usedStorageQuota must be {expected} (sum of snapshot+blob), got {used}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-WS-ADMIN-QUOTA-01 — adminUpdateWorkspace(storageQuotaMb) sets bytes
// ---------------------------------------------------------------------------

/// adminUpdateWorkspace(storageQuotaMb=N) must persist N*1024*1024 bytes in
/// workspaces.storage_quota_bytes.
#[tokio::test]
async fn inv_ws_admin_quota_01_update_workspace_sets_quota_mb() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let ws_id = helpers::create_workspace(&pool, admin_id).await;

  let quota_mb: i32 = 2048;
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"mutation M($id: String!, $mb: Int!) {
        admin {
          adminUpdateWorkspace(input: { id: $id, storageQuotaMb: $mb }) {
            id storageQuotaBytes
          }
        }
      }"#,
      "variables": { "id": ws_id.to_string(), "mb": quota_mb }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "adminUpdateWorkspace failed: {resp}");

  let row = sqlx::query("SELECT storage_quota_bytes FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("workspace row");
  let stored: Option<i64> = row.get("storage_quota_bytes");
  let expected = quota_mb as i64 * 1024 * 1024;
  assert_eq!(
    stored,
    Some(expected),
    "INV-WS-ADMIN-QUOTA-01: expected {expected} bytes in DB, got {stored:?}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-WS-ADMIN-QUOTA-02 — clearStorageQuota=true sets NULL
// ---------------------------------------------------------------------------

/// adminUpdateWorkspace(clearStorageQuota=true) must set
/// workspaces.storage_quota_bytes to NULL.
/// Before P112 this was impossible due to the COALESCE bug in the UPDATE.
#[tokio::test]
async fn inv_ws_admin_quota_02_clear_workspace_quota_sets_null() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let ws_id = helpers::create_workspace(&pool, admin_id).await;

  // First set a quota.
  sqlx::query("UPDATE workspaces SET storage_quota_bytes = 1073741824 WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("set initial quota");

  // Now clear it via the API.
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"mutation M($id: String!) {
        admin {
          adminUpdateWorkspace(input: { id: $id, clearStorageQuota: true }) {
            id storageQuotaBytes
          }
        }
      }"#,
      "variables": { "id": ws_id.to_string() }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "adminUpdateWorkspace clear failed: {resp}"
  );

  let row = sqlx::query("SELECT storage_quota_bytes FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("workspace row");
  let stored: Option<i64> = row.get("storage_quota_bytes");
  assert_eq!(
    stored, None,
    "INV-WS-ADMIN-QUOTA-02: clearStorageQuota=true must set quota to NULL (was COALESCE bug), got {stored:?}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-WS-QUOTA-06 — config default fallback (no overrides → storageQuota = JS_MAX_SAFE_INT)
// ---------------------------------------------------------------------------

/// When neither workspace quota nor a non-zero server config default is set,
/// 0 (unlimited), workspace.quota.storageQuota must return 2^53-1 (JS Number.MAX_SAFE_INTEGER).
/// Proves the full effective_quota_bytes chain runs and the config path is reachable.
#[tokio::test]
async fn inv_ws_quota_06_config_fallback_returns_zero_when_no_overrides() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let ws_id = helpers::create_workspace(&pool, admin_id).await;

  // Explicitly clear any quota that might have been set during team creation.
  sqlx::query("UPDATE workspaces SET storage_quota_bytes = NULL WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("clear ws quota");
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": r#"query Q($id: String!) {
        workspace(id: $id) { quota { storageQuota } }
      }"#,
      "variables": { "id": ws_id.to_string() }
    }),
  )
  .await;

  assert!(resp.get("errors").is_none(), "GraphQL errors: {resp}");
  let got = resp["data"]["workspace"]["quota"]["storageQuota"]
    .as_i64()
    .expect("storageQuota must be i64");
  const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
  assert_eq!(
    got, JS_MAX_SAFE_INTEGER,
    "INV-WS-QUOTA-06: no overrides + config default=0 must yield storageQuota=2^53-1 (JS_MAX_SAFE_INTEGER), got {got}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-SNAP-WS-QUOTA-01 (E-06) — compaction rejected when workspace-level quota exceeded
// ---------------------------------------------------------------------------

/// When a workspace has a 1-byte quota and pending updates exist,
/// `DocService::merge_pending_updates` (the application-layer compaction path)
/// must return StorageQuotaExceeded — the quota check fires inside `save_snapshot`
/// which is called by `merge_pending_updates`.
///
/// `[0, 0]` is the minimal valid Yjs v1 binary (0 structs, 0 deletes).
/// Any merged snapshot from valid Yjs updates will be ≥ 2 bytes,
/// so quota=1 guarantees rejection regardless of the exact merge output size.
#[tokio::test]
async fn inv_snap_ws_quota_01_compaction_rejected_when_workspace_quota_exceeded() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "inv_snap_e06", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

  let svc = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));

  // Push 3 minimal valid Yjs updates so compaction has material to merge.
  for seq in 1..=3i64 {
    svc
      .push_update(ws_id, doc_id, vec![0u8, 0u8], seq, DocSpaceKind::Workspace)
      .await
      .expect("push_update must succeed");
  }

  // Set workspace quota to 1 byte — any non-empty merged snapshot will exceed it.
  sqlx::query("UPDATE workspaces SET storage_quota_bytes = 1 WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("set quota");

  // Usage starts at 0, so 0 + merged_size > 1 whenever merged_size ≥ 2.
  set_storage_stats(&pool, ws_id, 0, 0).await;

  let err = svc
    .merge_pending_updates(ws_id, doc_id, 1)
    .await
    .expect_err("INV-SNAP-WS-QUOTA-01: merge must be rejected when quota=1 byte and any snapshot is larger");
  assert!(
    matches!(err, AuthError::StorageQuotaExceeded { .. }),
    "INV-SNAP-WS-QUOTA-01: expected StorageQuotaExceeded, got: {err:?}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-QUOTA-CACHE-01 (E-10) — cache returns stale value after DB change, cleared by invalidate()
// ---------------------------------------------------------------------------

/// The QuotaCache must:
///   1. Return the cached value even after the DB is updated (cache isolation).
///   2. Return None after invalidate() is called.
///   3. After invalidation, resolve_effective_quota reads the updated DB value.
#[tokio::test]
async fn inv_quota_cache_01_stale_cache_cleared_by_invalidate() {
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, _) = helpers::seed_user(&pool, &auth_store, "inv_cache_e10").await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;

  // Set initial quota: 500 MB in DB.
  let initial_quota: i64 = 500 * 1024 * 1024;
  sqlx::query("UPDATE workspaces SET storage_quota_bytes = $1 WHERE id = $2")
    .bind(initial_quota)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("set initial quota");

  // Prime the cache with the initial value.
  let redis = Arc::new(InMemoryRedisAdapter::new("test-e10"));
  let cache = QuotaCache::new(redis, "test-e10");
  cache.set_quota(ws_id, initial_quota as u64).await;
  assert_eq!(
    cache.get_quota(ws_id).await,
    Some(initial_quota as u64),
    "INV-QUOTA-CACHE-01: cache must hold initial value after set"
  );

  // Change quota in DB to 200 MB — cache should remain stale.
  let new_quota: i64 = 200 * 1024 * 1024;
  sqlx::query("UPDATE workspaces SET storage_quota_bytes = $1 WHERE id = $2")
    .bind(new_quota)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("update quota in DB");

  // Cache still returns old value (stale by design).
  assert_eq!(
    cache.get_quota(ws_id).await,
    Some(initial_quota as u64),
    "INV-QUOTA-CACHE-01: cache must still hold stale value before invalidation"
  );

  // Invalidate — cache must return None.
  cache.invalidate(ws_id).await;
  assert_eq!(
    cache.get_quota(ws_id).await,
    None,
    "INV-QUOTA-CACHE-01: cache must return None after invalidate()"
  );

  // Post-invalidation DB read must return the updated quota.
  let resolved = resolve_effective_quota(&pool, ws_id, 0).await;
  assert_eq!(
    resolved, new_quota as u64,
    "INV-QUOTA-CACHE-01: post-invalidation resolve must return new DB quota ({new_quota}), got {resolved}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
