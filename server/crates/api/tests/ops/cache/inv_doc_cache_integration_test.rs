//! P102-CACHE-10: Integration tests for doc cache (CACHE-01..05).
//!
//! ## Invariants tested
//!
//! - INV-DOC-CACHE-01: Snapshot cache HIT returns same payload as DB load (correctness).
//! - INV-DOC-CACHE-17: Push → Load → Push → Load lifecycle produces consistent results
//!   regardless of cache state.
//! - INV-DOC-CACHE-18: When all caches are disabled, DocCache behaves as transparent
//!   pass-through (no panics, same correctness as uncached path).
//! - INV-DOC-CACHE-19: Real Redis pattern flushes stay inside the configured
//!   namespace and exercise the production DocCache flush path.
//!
//! Most tests use `InMemoryRedisAdapter`; the namespace regression uses the
//! isolated matrix Redis service through the production adapter.

use myoxus_domain::database::DatabaseViewRepository;
use std::collections::HashMap;
use std::sync::Arc;

use myoxus_application::{doc::DocCachePort, ports::RedisPort};
use myoxus_domain::database::{DatabasePageIdentity, DatabaseProfileKind};
use myoxus_domain::entities::DocumentMetadataIndexRow;
use myoxus_domain::repositories::PageRequest;
use myoxus_infrastructure::doc_cache::{DocCache, RedisDocCacheConfig};
use myoxus_infrastructure::redis::{InMemoryRedisAdapter, RedisAdapter};
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use uuid::Uuid;

use crate::helpers;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn make_cache() -> Arc<DocCache> {
  let redis = Arc::new(InMemoryRedisAdapter::new("test"));
  Arc::new(DocCache::new(redis, "myoxus", &RedisDocCacheConfig::default()))
}

fn make_disabled_cache() -> Arc<DocCache> {
  let redis = Arc::new(InMemoryRedisAdapter::new("test"));
  Arc::new(DocCache::new(
    redis,
    "myoxus",
    &RedisDocCacheConfig {
      snapshot_enabled: false,
      metadata_enabled: false,
      metadata_projection_enabled: false,
      view_dedup_enabled: false,
      compaction_lock_enabled: false,
      timestamps_enabled: false,
      ..Default::default()
    },
  ))
}

// ── INV-DOC-CACHE-01 ─────────────────────────────────────────────────────────

/// INV-DOC-CACHE-01: Snapshot set → get returns identical payload.
///
/// If set_snapshot serialises differently than get_snapshot deserialises,
/// the cache would corrupt document data. This invariant ensures round-trip
/// fidelity for arbitrary binary Yjs payloads.
#[tokio::test]
async fn inv_p102_cache_01_snapshot_roundtrip_fidelity() {
  let cache = make_cache();
  let ws = Uuid::new_v4();
  let doc = Uuid::new_v4();
  // Simulate a realistic Yjs binary payload (arbitrary bytes including 0x00).
  let payload: Vec<u8> = (0u8..=255u8).collect();
  cache.set_snapshot(ws, doc, &payload).await;
  let cached = cache
    .get_snapshot(ws, doc)
    .await
    .expect("snapshot must be cached after set");
  assert_eq!(
    cached, payload,
    "INV-DOC-CACHE-01: cached payload must be bit-for-bit identical to stored payload"
  );
}

// ── INV-DOC-CACHE-17 ─────────────────────────────────────────────────────────

/// INV-DOC-CACHE-17: Full lifecycle — set, verify, invalidate, miss, re-set, verify again.
///
/// Simulates the push_update → cache invalidate → load → cache populate cycle.
/// After invalidation the cache must not serve stale data.
#[tokio::test]
async fn inv_p102_cache_17_full_lifecycle_with_caching() {
  let cache = make_cache();
  let ws = Uuid::new_v4();
  let doc = Uuid::new_v4();
  let payload_v1 = b"yjs-state-v1".to_vec();
  let payload_v2 = b"yjs-state-v2".to_vec();

  // Step 1: cache first payload
  cache.set_snapshot(ws, doc, &payload_v1).await;
  assert_eq!(
    cache.get_snapshot(ws, doc).await,
    Some(payload_v1.clone()),
    "INV-DOC-CACHE-17: v1 payload must be cached"
  );

  // Step 2: simulate push_update — invalidate cache
  cache.invalidate_snapshot(ws, doc).await;
  assert!(
    cache.get_snapshot(ws, doc).await.is_none(),
    "INV-DOC-CACHE-17: after invalidation cache must return None (not stale v1)"
  );

  // Step 3: load path re-populates cache with v2
  cache.set_snapshot(ws, doc, &payload_v2).await;
  assert_eq!(
    cache.get_snapshot(ws, doc).await,
    Some(payload_v2.clone()),
    "INV-DOC-CACHE-17: v2 payload must be cached after re-population"
  );

  // Step 4: timestamps cache also works correctly in this lifecycle
  let mut ts = HashMap::new();
  ts.insert(doc.to_string(), 1_700_000_000_i64);
  cache.set_timestamps(ws, &ts).await;
  assert!(
    cache.get_timestamps(ws).await.is_some(),
    "INV-DOC-CACHE-17: timestamps must be cached"
  );
  cache.invalidate_timestamps(ws).await;
  assert!(
    cache.get_timestamps(ws).await.is_none(),
    "INV-DOC-CACHE-17: timestamps cache must be cleared after invalidation"
  );
}

// ── INV-DOC-CACHE-18 ─────────────────────────────────────────────────────────

/// INV-DOC-CACHE-18: All caches disabled — system must not panic and must return None.
///
/// When `DocCachePort` methods are called on a fully-disabled cache, no Redis
/// operations are performed and all getters return `None`. This ensures the
/// graceful-degradation contract: the system falls back to DB without any error.
#[tokio::test]
async fn inv_p102_cache_18_all_caches_disabled() {
  let cache = make_disabled_cache();
  let ws = Uuid::new_v4();
  let doc = Uuid::new_v4();

  // All getters must return None even after set operations.
  cache.set_snapshot(ws, doc, b"data").await;
  assert!(
    cache.get_snapshot(ws, doc).await.is_none(),
    "INV-DOC-CACHE-18: disabled snapshot cache must return None"
  );

  let meta = serde_json::json!({"title": "Test"});
  cache.set_metadata(doc, &meta).await;
  assert!(
    cache.get_metadata(doc).await.is_none(),
    "INV-DOC-CACHE-18: disabled metadata cache must return None"
  );

  let mut ts = HashMap::new();
  ts.insert("doc".to_string(), 1_i64);
  cache.set_timestamps(ws, &ts).await;
  assert!(
    cache.get_timestamps(ws).await.is_none(),
    "INV-DOC-CACHE-18: disabled timestamps cache must return None"
  );

  // View dedup: disabled → always returns false (no dedup, callers fall back to DashSet).
  let user = Uuid::new_v4();
  let date = chrono::Utc::now().date_naive();
  let is_unique = cache.check_and_set_view_dedup(user, ws, "doc-abc", date).await;
  assert!(!is_unique, "INV-DOC-CACHE-18: disabled view dedup must return false");

  // Compaction lock: disabled → always grants (no distributed coordination).
  let lock_token = Uuid::new_v4();
  assert!(
    cache.acquire_compaction_lock(doc, lock_token).await,
    "INV-DOC-CACHE-18: disabled compaction lock must always grant"
  );
  assert!(
    cache.acquire_compaction_lock(doc, lock_token).await,
    "INV-DOC-CACHE-18: disabled compaction lock must always grant (second call)"
  );
}

// ── DocCachePort trait object dispatch ───────────────────────────────────────

/// Verifies that DocCache can be used as `Arc<dyn DocCachePort>` (trait object safety).
///
/// This is required for injection into DocLoadService / DocWriteService / DocCompactionService.
#[tokio::test]
async fn inv_p102_cache_trait_object_dispatch() {
  let cache: Arc<dyn DocCachePort> = make_cache();
  let ws = Uuid::new_v4();
  let doc = Uuid::new_v4();
  cache.set_snapshot(ws, doc, b"payload").await;
  let result = cache.get_snapshot(ws, doc).await;
  assert_eq!(
    result,
    Some(b"payload".to_vec()),
    "DocCachePort trait dispatch must work correctly"
  );
}

// ── INV-DOC-CACHE-19 ────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_doc_cache_19_real_redis_pattern_flush_is_namespace_scoped() {
  let redis_url = std::env::var("TEST_REDIS_URL")
    .or_else(|_| std::env::var("REDIS_URL"))
    .unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let suffix = Uuid::new_v4();
  // Glob metacharacters are valid key bytes and must remain literal when the
  // adapter scopes a SCAN pattern to its configured namespace.
  let namespace_a = format!("wlp06:{suffix}:cache*[a]");
  let namespace_b = format!("wlp06:{suffix}:cache-b");
  let redis_a = Arc::new(RedisAdapter::new(&redis_url, &namespace_a).expect("Redis adapter A"));
  let redis_b = Arc::new(RedisAdapter::new(&redis_url, &namespace_b).expect("Redis adapter B"));
  let cache_a = DocCache::new(redis_a.clone(), "myoxus", &RedisDocCacheConfig::default());
  let cache_b = DocCache::new(redis_b.clone(), "myoxus", &RedisDocCacheConfig::default());
  let workspace = Uuid::new_v4();
  let document = Uuid::new_v4();

  cache_a.set_snapshot(workspace, document, b"snapshot-a").await;
  cache_a.set_metadata(document, &serde_json::json!({"owner": "a"})).await;
  cache_b.set_snapshot(workspace, document, b"snapshot-b").await;
  redis_a
    .set_string("cli-cleanup-marker", "a", None)
    .await
    .expect("set A marker");
  redis_b
    .set_string("cli-cleanup-marker", "b", None)
    .await
    .expect("set B marker");

  assert_eq!(cache_a.flush_snapshot_cache().await, 1);
  assert_eq!(cache_a.get_snapshot(workspace, document).await, None);
  assert!(cache_a.get_metadata(document).await.is_some());
  assert_eq!(
    cache_b.get_snapshot(workspace, document).await,
    Some(b"snapshot-b".to_vec())
  );

  let deleted = redis_a.delete_by_pattern("*").await.expect("logical wildcard cleanup");
  assert!(deleted >= 2, "wildcard must remove the remaining A namespace keys");
  assert_eq!(
    redis_a.get_string("cli-cleanup-marker").await.expect("read A marker"),
    None
  );
  assert_eq!(
    redis_b.get_string("cli-cleanup-marker").await.expect("read B marker"),
    Some("b".to_string()),
    "logical wildcard must not cross the configured namespace"
  );
  assert_eq!(
    cache_b.get_snapshot(workspace, document).await,
    Some(b"snapshot-b".to_vec())
  );

  redis_b.delete_by_pattern("*").await.expect("clean B namespace");
}

fn metadata_index_row(doc_id: Uuid, external_id: &str) -> DocumentMetadataIndexRow {
  DocumentMetadataIndexRow {
    doc_id,
    external_id: external_id.to_string(),
    created_by: None,
    updated_by: None,
    journal_date: None,
    is_template: false,
    template_state: None,
    template_origin: None,
    template_category: None,
    template_tags: None,
    primary_mode: None,
    page_width: None,
    edgeless_color_theme: None,
    integration_type: None,
    status_id: None,
    document_type_id: None,
    current_version_id: None,
    dirty_since_current_version: false,
    review_due_at: None,
    valid_until: None,
    classification_id: None,
  }
}

#[tokio::test]
async fn inv_wlp08_document_metadata_index_is_shared_and_caches_empty_results_in_real_redis() {
  let redis_url = std::env::var("TEST_REDIS_URL")
    .or_else(|_| std::env::var("REDIS_URL"))
    .unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let namespace = format!("wlp08:index:{}", Uuid::new_v4());
  let redis_a = Arc::new(RedisAdapter::new(&redis_url, &namespace).expect("Redis adapter A"));
  let redis_b = Arc::new(RedisAdapter::new(&redis_url, &namespace).expect("Redis adapter B"));
  let cache_a = DocCache::new(redis_a.clone(), "myoxus", &RedisDocCacheConfig::default());
  let cache_b = DocCache::new(redis_b, "myoxus", &RedisDocCacheConfig::default());
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();

  cache_a
    .set_document_metadata_index(workspace_id, "contract-v1:1", &[])
    .await;
  assert_eq!(
    cache_b.get_document_metadata_index(workspace_id, "contract-v1:1").await,
    Some(Vec::new()),
    "an empty inventory is a shared cached value"
  );

  let rows = vec![metadata_index_row(doc_id, "external-document-id")];
  cache_b
    .set_document_metadata_index(workspace_id, "contract-v1:2", &rows)
    .await;
  assert_eq!(
    cache_a.get_document_metadata_index(workspace_id, "contract-v1:2").await,
    Some(rows),
    "a second instance reads the same actor-independent rows and external identity"
  );
  assert_eq!(
    cache_a
      .get_document_metadata_index(workspace_id, "contract-v1:missing")
      .await,
    None
  );

  let events = cache_a.document_metadata_index_events();
  assert_eq!(events.writes.load(std::sync::atomic::Ordering::Acquire), 1);
  assert_eq!(events.hits.load(std::sync::atomic::Ordering::Acquire), 1);
  assert_eq!(events.absent.load(std::sync::atomic::Ordering::Acquire), 1);
  assert_eq!(events.read_errors.load(std::sync::atomic::Ordering::Acquire), 0);
  redis_a.delete_by_pattern("*").await.expect("clean WLP-08 namespace");
}

#[tokio::test]
async fn inv_wlp08_document_metadata_index_admission_events_are_not_cache_misses() {
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let redis = Arc::new(InMemoryRedisAdapter::new(format!("wlp08-admission-{}", Uuid::new_v4())));
  let oversized = DocCache::new(
    redis.clone(),
    "myoxus",
    &RedisDocCacheConfig {
      document_metadata_index_max_size_bytes: 1,
      ..Default::default()
    },
  );
  oversized
    .set_document_metadata_index(
      workspace_id,
      "contract-v1:oversized",
      &[metadata_index_row(doc_id, "external")],
    )
    .await;
  assert!(
    oversized
      .get_document_metadata_index(workspace_id, "contract-v1:oversized")
      .await
      .is_none()
  );
  let oversized_events = oversized.document_metadata_index_events();
  assert_eq!(
    oversized_events
      .skipped_oversized
      .load(std::sync::atomic::Ordering::Acquire),
    1
  );
  assert_eq!(
    oversized_events.absent.load(std::sync::atomic::Ordering::Acquire),
    1,
    "only the subsequent Redis lookup is an absent-key event"
  );

  let disabled = DocCache::new(
    redis,
    "myoxus",
    &RedisDocCacheConfig {
      document_metadata_index_enabled: false,
      ..Default::default()
    },
  );
  disabled
    .set_document_metadata_index(workspace_id, "contract-v1:disabled", &[])
    .await;
  assert!(
    disabled
      .get_document_metadata_index(workspace_id, "contract-v1:disabled")
      .await
      .is_none()
  );
  let disabled_events = disabled.document_metadata_index_events();
  assert_eq!(disabled_events.disabled.load(std::sync::atomic::Ordering::Acquire), 2);
  assert_eq!(disabled_events.absent.load(std::sync::atomic::Ordering::Acquire), 0);
}

#[tokio::test]
async fn inv_wlp09_database_page_inventory_is_typed_shared_and_caches_empty_pages() {
  let redis_url = std::env::var("TEST_REDIS_URL")
    .or_else(|_| std::env::var("REDIS_URL"))
    .unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let namespace = format!("wlp09:inventory:{}", Uuid::new_v4());
  let redis_a = Arc::new(RedisAdapter::new(&redis_url, &namespace).expect("Redis adapter A"));
  let redis_b = Arc::new(RedisAdapter::new(&redis_url, &namespace).expect("Redis adapter B"));
  let cache_a = DocCache::new(redis_a.clone(), "myoxus", &RedisDocCacheConfig::default());
  let cache_b = DocCache::new(redis_b, "myoxus", &RedisDocCacheConfig::default());
  let workspace_id = Uuid::new_v4();

  cache_a
    .set_database_page_inventory(workspace_id, "active", 100, 0, "contract-v1:0", &[])
    .await;
  assert_eq!(
    cache_b
      .get_database_page_inventory(workspace_id, "active", 100, 0, "contract-v1:0")
      .await,
    Some(Vec::new())
  );

  let now = chrono::Utc::now();
  let rows = vec![DatabasePageIdentity {
    system_role: None,
    id: Uuid::new_v4(),
    profile_kind: DatabaseProfileKind::Generic,
    title: "Inventory database".to_string(),
    description: Some("cached without counts".to_string()),
    deleted_at: None,
    edit_revision: 7,
    created_at: now,
    updated_at: now,
  }];
  cache_b
    .set_database_page_inventory(workspace_id, "active", 100, 0, "contract-v1:1", &rows)
    .await;
  assert_eq!(
    cache_a
      .get_database_page_inventory(workspace_id, "active", 100, 0, "contract-v1:1")
      .await,
    Some(rows)
  );
  assert!(
    cache_a
      .get_database_page_inventory(workspace_id, "trashed", 100, 0, "contract-v1:1")
      .await
      .is_none(),
    "lifecycle is part of the typed inventory key"
  );
  let events = cache_a.database_page_inventory_events();
  assert_eq!(events.hits.load(std::sync::atomic::Ordering::Acquire), 1);
  assert_eq!(events.absent.load(std::sync::atomic::Ordering::Acquire), 1);
  redis_a.delete_by_pattern("*").await.expect("clean WLP-09 namespace");
}

#[tokio::test]
async fn inv_wlp09_empty_to_created_uses_new_revision_across_postgres_and_redis_instances() {
  let pool = helpers::setup_pool().await;
  let owner_id = helpers::create_user(&pool, "wlp09-empty-created", false).await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let repository = PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
  let page = PageRequest { limit: 100, offset: 0 };
  let initial = repository
    .list_database_page_identities_versioned(
      workspace_id,
      page.clone(),
      myoxus_domain::database::DatabaseLifecycleFilter::Active,
    )
    .await
    .expect("read initial empty inventory");
  assert!(initial.rows.is_empty());

  let redis_url = std::env::var("TEST_REDIS_URL")
    .or_else(|_| std::env::var("REDIS_URL"))
    .unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let namespace = format!("wlp09:empty-created:{}", Uuid::new_v4());
  let redis_a = Arc::new(RedisAdapter::new(&redis_url, &namespace).expect("Redis adapter A"));
  let redis_b = Arc::new(RedisAdapter::new(&redis_url, &namespace).expect("Redis adapter B"));
  let cache_a = DocCache::new(redis_a.clone(), "myoxus", &RedisDocCacheConfig::default());
  let cache_b = DocCache::new(redis_b, "myoxus", &RedisDocCacheConfig::default());
  let initial_version = format!("contract-v1:{}", initial.revision);
  cache_a
    .set_database_page_inventory(workspace_id, "active", 100, 0, &initial_version, &initial.rows)
    .await;
  assert_eq!(
    cache_b
      .get_database_page_inventory(workspace_id, "active", 100, 0, &initial_version)
      .await,
    Some(Vec::new())
  );

  let database_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by)
     VALUES ($1, $2, 'Created after empty cache', $3, $3)",
  )
  .bind(database_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("create Database after cached empty inventory");

  let created = repository
    .list_database_page_identities_versioned(
      workspace_id,
      page,
      myoxus_domain::database::DatabaseLifecycleFilter::Active,
    )
    .await
    .expect("read created inventory");
  assert!(created.revision > initial.revision);
  assert_eq!(created.rows.len(), 1);
  let created_version = format!("contract-v1:{}", created.revision);
  assert!(
    cache_b
      .get_database_page_inventory(workspace_id, "active", 100, 0, &created_version)
      .await
      .is_none(),
    "the old cached-empty version cannot satisfy the post-create revision"
  );
  cache_b
    .set_database_page_inventory(workspace_id, "active", 100, 0, &created_version, &created.rows)
    .await;
  assert_eq!(
    cache_a
      .get_database_page_inventory(workspace_id, "active", 100, 0, &created_version)
      .await,
    Some(created.rows)
  );

  redis_a.delete_by_pattern("*").await.expect("clean WLP-09 namespace");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("clean WLP-09 workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("clean WLP-09 owner");
}
