//! P103-A-01/A-02/A-05/A-06/B-04: Integration tests for cache read-path + compaction threshold + flush.
//!
//! ## Invariants tested
//!
//! - INV-P103-A-01: Negative metadata cache HIT is verified against DB.
//! - INV-P103-A-02: Soft-delete invalidates metadata cache immediately (no stale TTL).
//! - INV-P103-A-04b: Push invalidates metadata cache after auto-create.
//! - INV-P103-A-05: Compaction threshold from config — threshold=5 compacts at 5 updates.
//! - INV-P103-A-06: Root-doc threshold — root doc compacted at threshold_root_doc updates.
//! - INV-P103-B-04: flush_snapshot_cache deletes snapshot keys; flush_metadata_cache deletes metadata keys.
//!
//! Tests A-01/A-02/B-04 use InMemoryRedisAdapter (no real Redis/Postgres required for cache logic).
//! Tests A-05/A-06 require real Postgres to verify compaction wrote a snapshot row.

use crate::helpers;

use std::sync::Arc;

use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::doc_cache::{DocCache, RedisDocCacheConfig};
use myoxus_infrastructure::redis::InMemoryRedisAdapter;

fn make_cache() -> Arc<DocCache> {
  let redis = Arc::new(InMemoryRedisAdapter::new("test"));
  Arc::new(DocCache::new(redis, "myoxus", &RedisDocCacheConfig::default()))
}

// ── INV-P103-A-01 ─────────────────────────────────────────────────────────

/// INV-P103-A-01: Negative metadata cache entries are not authoritative.
///
/// A webclient can first observe DOC_NOT_FOUND, cache `exists=false`, and then
/// create the same doc through sync auto-create. A stale negative cache entry
/// must not keep returning DOC_NOT_FOUND while the DB row is live.
#[tokio::test]
async fn inv_p103_a_01_negative_metadata_cache_revalidates_db() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let cache = make_cache();

  let owner_id = helpers::create_user(&pool, "p103a01", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  // Create doc without any pushed updates so the merge path stays trivial.
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  // Manually poison the metadata cache with deleted_at=true while the DB row is
  // active. The load path must re-check DB for negative hits.
  cache
    .set_metadata(doc_id, &serde_json::json!({"exists": true, "deleted_at": true}))
    .await;

  let doc_svc_cached = DocService::new(doc_store).with_doc_cache(cache.clone());

  let result = doc_svc_cached
    .load
    .load_full_doc_with_meta(ws_id, doc_id)
    .await
    .expect("INV-P103-A-01: load must not error");

  assert!(
    result.exists,
    "INV-P103-A-01: DB-active doc must not be hidden by stale negative metadata cache"
  );
  let refreshed = cache
    .get_metadata(doc_id)
    .await
    .expect("INV-P103-A-01: cache should be refreshed from DB");
  assert_eq!(refreshed.get("exists").and_then(|v| v.as_bool()), Some(true));
  assert_eq!(refreshed.get("deleted_at").and_then(|v| v.as_bool()), Some(false));

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ── INV-P103-A-02 ─────────────────────────────────────────────────────────

/// INV-P103-A-02: soft_delete_doc invalidates metadata cache immediately.
///
/// After DocService::soft_delete_doc, the metadata cache must return None
/// for the doc (invalidated). Without P103-B-01, the stale entry would persist
/// until TTL expiry, causing subsequent loads to report the doc as still alive.
#[tokio::test]
async fn inv_p103_a_02_soft_delete_invalidates_metadata_cache() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let cache = make_cache();

  let owner_id = helpers::create_user(&pool, "p103a02", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  // Pre-populate the metadata cache as if the doc was loaded before deletion.
  cache
    .set_metadata(doc_id, &serde_json::json!({"exists": true, "deleted_at": false}))
    .await;

  assert!(
    cache.get_metadata(doc_id).await.is_some(),
    "INV-P103-A-02: cache must be populated before delete"
  );

  // Soft-delete via the facade (this is what P103-B-01 wires up).
  let doc_svc = DocService::new(doc_store).with_doc_cache(cache.clone());
  doc_svc
    .soft_delete_doc(doc_id)
    .await
    .expect("INV-P103-A-02: soft_delete_doc must succeed");

  // Cache must be cleared — no stale exists=true entry.
  assert!(
    cache.get_metadata(doc_id).await.is_none(),
    "INV-P103-A-02: metadata cache must be invalidated after soft_delete_doc"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ── INV-P103-A-05 ─────────────────────────────────────────────────────────

/// INV-P103-A-05: Compaction threshold read from config — threshold=5 compacts at 5 updates.
///
/// With `with_compaction_thresholds(5, 3)`, pushing 5 updates must trigger auto-compaction
/// and create a row in `doc_snapshots`. Without this fix, the hardcoded 500 would prevent
/// compaction in this test.
#[tokio::test]
async fn inv_p103_a_05_compaction_threshold_from_config() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));

  let owner_id = helpers::create_user(&pool, "p103a05", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  // threshold_default=5, threshold_root_doc=3
  let doc_svc = DocService::new(doc_store).with_compaction_thresholds(5, 3);

  for i in 0i64..5 {
    doc_svc
      .push_update(ws_id, doc_id, vec![0u8, 0u8], i, DocSpaceKind::Workspace)
      .await
      .expect("INV-P103-A-05: push_update must succeed");
  }

  let snap: Option<i32> = sqlx::query_scalar::<_, i32>("SELECT 1 FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_optional(&pool)
    .await
    .expect("INV-P103-A-05: snapshot query must not fail");

  assert!(
    snap.is_some(),
    "INV-P103-A-05: snapshot row must exist after 5 updates with threshold=5"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ── INV-P103-A-06 ─────────────────────────────────────────────────────────

/// INV-P103-A-06: Root-doc threshold — doc_id == workspace_id compacts at threshold_root_doc.
///
/// When doc_id equals workspace_id (root doc), the lower threshold_root_doc=3 applies.
/// Pushing 3 updates must trigger compaction even though threshold_default=10 would not.
#[tokio::test]
async fn inv_p103_a_06_root_doc_lower_threshold() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));

  let owner_id = helpers::create_user(&pool, "p103a06", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;

  // Root doc: doc_id == workspace_id. Insert the doc row with the workspace UUID.
  sqlx::query(
    r#"INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)
       VALUES ($1, $2, 'Root', 'owner', TRUE, $3, $3)
       ON CONFLICT (id) DO NOTHING"#,
  )
  .bind(ws_id)
  .bind(ws_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("INV-P103-A-06: insert root doc must succeed");

  // threshold_default=10 (would NOT compact at 3), threshold_root_doc=3
  let doc_svc = DocService::new(doc_store).with_compaction_thresholds(10, 3);

  for i in 0i64..3 {
    doc_svc
      .push_update(ws_id, ws_id, vec![0u8, 0u8], i, DocSpaceKind::Workspace)
      .await
      .expect("INV-P103-A-06: push_update must succeed");
  }

  let snap: Option<i32> = sqlx::query_scalar::<_, i32>("SELECT 1 FROM doc_snapshots WHERE doc_id = $1")
    .bind(ws_id)
    .fetch_optional(&pool)
    .await
    .expect("INV-P103-A-06: snapshot query must not fail");

  assert!(
    snap.is_some(),
    "INV-P103-A-06: root doc must be compacted at threshold_root_doc=3, not threshold_default=10"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ── INV-P103-A-03 / INV-P103-A-04 ────────────────────────────────────────

/// INV-P103-A-03: Timestamp cache HIT — second call returns from cache, not DB.
///
/// After get_space_doc_timestamps writes to cache, the next call must return the
/// same map without hitting the DB again. Verified by poisoning the cache with a
/// known map and checking it's returned.
#[tokio::test]
async fn inv_p103_a_03_timestamps_cache_read_hit() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let cache = make_cache();

  let owner_id = helpers::create_user(&pool, "p103a03", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;

  // Pre-populate cache with a known timestamps map (different from DB state).
  let mut fake_ts = std::collections::HashMap::new();
  fake_ts.insert("deadbeef-0000-0000-0000-000000000001".to_string(), 9999999999i64);
  cache.set_timestamps(ws_id, &fake_ts).await;

  let doc_svc = DocService::new(doc_store).with_doc_cache(cache.clone());
  let result = doc_svc
    .get_space_doc_timestamps(ws_id, None)
    .await
    .expect("INV-P103-A-03: get_space_doc_timestamps must succeed");

  assert_eq!(
    result, fake_ts,
    "INV-P103-A-03: get_space_doc_timestamps must return the cached map, not the DB state"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

/// INV-P103-A-04: Timestamp cache invalidated after push_update.
///
/// push_update calls invalidate_timestamps. After that, get_timestamps must return
/// None (cache miss) so the next call goes to DB and refreshes the cache.
#[tokio::test]
async fn inv_p103_a_04_timestamps_invalidated_on_push() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let cache = make_cache();

  let owner_id = helpers::create_user(&pool, "p103a04", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  // Pre-populate cache.
  let mut initial_ts = std::collections::HashMap::new();
  initial_ts.insert(doc_id.to_string(), 1_000_000i64);
  cache.set_timestamps(ws_id, &initial_ts).await;

  assert!(
    cache.get_timestamps(ws_id).await.is_some(),
    "INV-P103-A-04: cache must be populated before push"
  );

  let doc_svc = DocService::new(doc_store).with_doc_cache(cache.clone());
  doc_svc
    .push_update(ws_id, doc_id, vec![0u8, 0u8], 0, DocSpaceKind::Workspace)
    .await
    .expect("INV-P103-A-04: push_update must succeed");

  assert!(
    cache.get_timestamps(ws_id).await.is_none(),
    "INV-P103-A-04: timestamps cache must be invalidated after push_update"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

/// INV-P103-A-04b: push_update invalidates stale metadata.
///
/// The sync write path auto-creates a docs row on first push. If an earlier
/// load cached `exists=false`, push_update must clear that negative cache entry
/// immediately so the next load cannot return stale DOC_NOT_FOUND.
#[tokio::test]
async fn inv_p103_a_04b_metadata_invalidated_on_push_auto_create() {
  let pool = helpers::setup_pool().await;
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let cache = make_cache();

  let owner_id = helpers::create_user(&pool, "p103a04b", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = uuid::Uuid::new_v4();

  cache
    .set_metadata(doc_id, &serde_json::json!({"exists": false, "deleted_at": false}))
    .await;
  assert!(
    cache.get_metadata(doc_id).await.is_some(),
    "INV-P103-A-04b: metadata cache must be populated before push"
  );

  let doc_svc = DocService::new(doc_store).with_doc_cache(cache.clone());
  doc_svc
    .push_update(ws_id, doc_id, vec![0u8, 0u8], 0, DocSpaceKind::Workspace)
    .await
    .expect("INV-P103-A-04b: push_update must auto-create doc");

  assert!(
    cache.get_metadata(doc_id).await.is_none(),
    "INV-P103-A-04b: push_update must invalidate stale metadata cache"
  );
  let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM docs WHERE id = $1 AND deleted_at IS NULL)")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("INV-P103-A-04b: DB exists probe must succeed");
  assert!(exists, "INV-P103-A-04b: push_update must create a live doc row");

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ── INV-P103-B-04 ─────────────────────────────────────────────────────────

/// INV-P103-B-04a: flush_snapshot_cache is scoped — metadata keys survive.
///
/// After setting metadata, calling flush_snapshot_cache must NOT delete
/// metadata keys (different Redis namespace `doc_meta:*` vs `doc_snapshot:*`).
#[tokio::test]
async fn inv_p103_b_04a_flush_snapshot_cache_scoped() {
  let redis = Arc::new(InMemoryRedisAdapter::new("test"));
  let cache = Arc::new(DocCache::new(redis, "myoxus", &RedisDocCacheConfig::default()));
  let doc_id = uuid::Uuid::new_v4();

  cache
    .set_metadata(doc_id, &serde_json::json!({"exists": true, "deleted_at": false}))
    .await;
  assert!(
    cache.get_metadata(doc_id).await.is_some(),
    "INV-P103-B-04a: metadata must exist before flush"
  );

  let deleted = cache.flush_snapshot_cache().await;
  assert_eq!(deleted, 0, "INV-P103-B-04a: no snapshot keys set, deleted must be 0");
  assert!(
    cache.get_metadata(doc_id).await.is_some(),
    "INV-P103-B-04a: metadata must survive snapshot flush"
  );
}

/// INV-P103-B-04b: flush_metadata_cache clears all metadata keys.
///
/// After setting 2 metadata entries, flush_metadata_cache returns 2 and
/// subsequent get_metadata calls return None.
#[tokio::test]
async fn inv_p103_b_04b_flush_metadata_cache_clears_entries() {
  let redis = Arc::new(InMemoryRedisAdapter::new("test"));
  let cache = Arc::new(DocCache::new(redis, "myoxus", &RedisDocCacheConfig::default()));
  let doc_a = uuid::Uuid::new_v4();
  let doc_b = uuid::Uuid::new_v4();

  cache
    .set_metadata(doc_a, &serde_json::json!({"exists": true, "deleted_at": false}))
    .await;
  cache
    .set_metadata(doc_b, &serde_json::json!({"exists": false, "deleted_at": true}))
    .await;

  let deleted = cache.flush_metadata_cache().await;
  assert_eq!(deleted, 2, "INV-P103-B-04b: must delete exactly 2 metadata keys");
  assert!(
    cache.get_metadata(doc_a).await.is_none(),
    "INV-P103-B-04b: doc_a metadata must be flushed"
  );
  assert!(
    cache.get_metadata(doc_b).await.is_none(),
    "INV-P103-B-04b: doc_b metadata must be flushed"
  );
}

/// INV-P103-B-04c: flush_all_doc_caches clears metadata and timestamps.
///
/// After populating both metadata and timestamps, flush_all_doc_caches must
/// clear both namespaces and return a total deleted count >= 2.
#[tokio::test]
async fn inv_p103_b_04c_flush_all_clears_metadata_and_timestamps() {
  let redis = Arc::new(InMemoryRedisAdapter::new("test"));
  let cache = Arc::new(DocCache::new(redis, "myoxus", &RedisDocCacheConfig::default()));
  let doc_id = uuid::Uuid::new_v4();
  let ws_id = uuid::Uuid::new_v4();

  cache
    .set_metadata(doc_id, &serde_json::json!({"exists": true, "deleted_at": false}))
    .await;
  let mut ts = std::collections::HashMap::new();
  ts.insert(doc_id.to_string(), 12345i64);
  cache.set_timestamps(ws_id, &ts).await;

  let deleted = cache.flush_all_doc_caches().await;
  assert!(
    deleted >= 2,
    "INV-P103-B-04c: at least 2 keys must be deleted (meta + timestamps)"
  );
  assert!(
    cache.get_metadata(doc_id).await.is_none(),
    "INV-P103-B-04c: metadata must be flushed"
  );
  assert!(
    cache.get_timestamps(ws_id).await.is_none(),
    "INV-P103-B-04c: timestamps must be flushed"
  );
}
