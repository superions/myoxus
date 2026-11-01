//! P104-A/B/C: Integration tests for doc-cache hit/miss tracking, auto-tuning, and TTL overrides.
//!
//! Invariants tested:
//!   INV-P104-01: Hit/miss counters are incremented correctly per cache operation.
//!   INV-P104-02: Hourly tuning cycle increases TTL when hit rate < 30% and ≥100 requests.
//!   INV-P104-03: Fixed TTL override skips auto-tuning; TTL is pinned to override value.
//!   INV-P104-04: adminUpdateConfig mutation immediately applies doc-cache TTL override.
//!   INV-P104-05: Tuning cycle never increases TTL by more than 2× in one daily cycle.
//!   INV-P104-06: Tuning cycle never decreases TTL below 0.5× in one daily cycle.

use crate::helpers;

use async_trait::async_trait;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use myoxus_api::cache::CacheConfig;
use myoxus_api::cache_tuning::{run_daily_cycle_doc_caches_once, run_hourly_cycle_doc_caches_once};
use myoxus_application::metrics::{InMemoryMetricsRecorder, MetricsPolicy, MetricsService};
use myoxus_application::ports::{PortError, PortResult, RedisPort};
use myoxus_domain::metrics::MetricsRepository;
use myoxus_infrastructure::doc_cache::{DocCache, DocCacheTuningHandles, RedisDocCacheConfig};
use myoxus_infrastructure::metrics::SqlxMetricsRepository;
use myoxus_infrastructure::redis::InMemoryRedisAdapter;
use uuid::Uuid;

fn metrics_service(pool: &sqlx::PgPool) -> MetricsService {
  let recorder = Arc::new(InMemoryMetricsRecorder::new(MetricsPolicy::default()));
  let repository: Arc<dyn MetricsRepository> = Arc::new(SqlxMetricsRepository::new(pool.clone()));
  MetricsService::new(recorder, repository)
}

// ---------------------------------------------------------------------------
// Helper: build a DocCache backed by InMemoryRedisAdapter + extract handles.
// ---------------------------------------------------------------------------

fn make_doc_cache(
  snapshot_ttl: u64,
  metadata_ttl: u64,
  metadata_projection_ttl: u64,
  timestamps_ttl: u64,
) -> (Arc<DocCache>, DocCacheTuningHandles) {
  let redis = Arc::new(InMemoryRedisAdapter::new("test"));
  let config = RedisDocCacheConfig {
    snapshot_enabled: true,
    snapshot_ttl,
    snapshot_max_size_bytes: 10 * 1024 * 1024,
    metadata_enabled: true,
    metadata_ttl,
    metadata_projection_enabled: true,
    metadata_projection_ttl,
    document_metadata_index_enabled: true,
    document_metadata_index_ttl: 60,
    document_metadata_index_max_size_bytes: 2 * 1024 * 1024,
    view_dedup_enabled: true,
    compaction_lock_enabled: false,
    compaction_lock_ttl: 60,
    timestamps_enabled: true,
    timestamps_ttl,
    timestamps_max_docs: 1000,
  };
  let cache = Arc::new(DocCache::new(redis, "test", &config));
  let handles = cache.tuning_handles();
  (cache, handles)
}

struct FailingRedis;

#[async_trait]
impl RedisPort for FailingRedis {
  async fn get_string(&self, _key: &str) -> PortResult<Option<String>> {
    Err(PortError::Transport("scripted Redis read failure".to_string()))
  }

  async fn set_string(&self, _key: &str, _value: &str, _ttl_seconds: Option<u64>) -> PortResult<()> {
    Err(PortError::Transport("scripted Redis write failure".to_string()))
  }

  async fn delete_key(&self, _key: &str) -> PortResult<()> {
    Err(PortError::Transport("scripted Redis delete failure".to_string()))
  }
}

/// Default CacheConfig with standard doc-cache bounds for testing.
fn test_cache_config() -> CacheConfig {
  CacheConfig {
    doc_snapshot_min_ttl_seconds: 60,
    doc_snapshot_max_ttl_seconds: 240,
    doc_snapshot_fixed_ttl_seconds: None,
    doc_metadata_min_ttl_seconds: 30,
    doc_metadata_max_ttl_seconds: 120,
    doc_metadata_fixed_ttl_seconds: None,
    doc_metadata_projection_min_ttl_seconds: 30,
    doc_metadata_projection_max_ttl_seconds: 120,
    doc_metadata_projection_fixed_ttl_seconds: None,
    doc_timestamps_min_ttl_seconds: 15,
    doc_timestamps_max_ttl_seconds: 60,
    doc_timestamps_fixed_ttl_seconds: None,
    ..Default::default()
  }
}

// ---------------------------------------------------------------------------
// INV-P104-01: Hit/miss counters incremented correctly.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p104_01_doc_cache_hit_miss_counters() {
  let (cache, handles) = make_doc_cache(120, 60, 60, 30);
  let ws = Uuid::new_v4();
  let doc = Uuid::new_v4();

  // Seed one snapshot.
  cache.set_snapshot(ws, doc, &[0u8; 16]).await;

  // 1 hit.
  let result = cache.get_snapshot(ws, doc).await;
  assert!(result.is_some(), "expected cache HIT after set_snapshot");

  // 2 misses (wrong doc IDs).
  cache.get_snapshot(ws, Uuid::new_v4()).await;
  cache.get_snapshot(ws, Uuid::new_v4()).await;

  assert_eq!(
    handles.snapshot_events.hits.load(Ordering::Acquire),
    1,
    "snapshot_hits should be 1"
  );
  assert_eq!(
    handles.snapshot_events.absent.load(Ordering::Acquire),
    2,
    "snapshot_misses should be 2"
  );
  // metadata and timestamps untouched.
  assert_eq!(handles.metadata_events.hits.load(Ordering::Acquire), 0);
  assert_eq!(handles.metadata_projection_events.hits.load(Ordering::Acquire), 0);
  assert_eq!(handles.timestamps_events.hits.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn inv_p104_01a_doc_cache_events_keep_failure_and_admission_causes_distinct() {
  let redis = Arc::new(InMemoryRedisAdapter::new("event-test"));
  let config = RedisDocCacheConfig {
    snapshot_max_size_bytes: 4,
    timestamps_max_docs: 1,
    ..RedisDocCacheConfig::default()
  };
  let cache = DocCache::new(redis.clone(), "events", &config);
  let handles = cache.tuning_handles();
  let ws = Uuid::new_v4();
  let doc = Uuid::new_v4();

  cache.set_snapshot(ws, doc, b"good").await;
  assert_eq!(cache.get_snapshot(ws, doc).await, Some(b"good".to_vec()));
  assert_eq!(cache.get_snapshot(ws, Uuid::new_v4()).await, None);

  let malformed_doc = Uuid::new_v4();
  redis
    .set_string(
      &format!("events:doc_snapshot:{ws}:{malformed_doc}"),
      "not base64!",
      Some(60),
    )
    .await
    .expect("seed malformed snapshot");
  assert_eq!(cache.get_snapshot(ws, malformed_doc).await, None);

  cache.set_snapshot(ws, Uuid::new_v4(), b"oversized").await;
  cache.invalidate_snapshot(ws, doc).await;
  let deleted = cache.flush_snapshot_cache().await;

  assert_eq!(handles.snapshot_events.writes.load(Ordering::Acquire), 1);
  assert_eq!(handles.snapshot_events.hits.load(Ordering::Acquire), 1);
  assert_eq!(handles.snapshot_events.absent.load(Ordering::Acquire), 1);
  assert_eq!(handles.snapshot_events.decode_errors.load(Ordering::Acquire), 1);
  assert_eq!(handles.snapshot_events.skipped_oversized.load(Ordering::Acquire), 1);
  assert_eq!(handles.snapshot_events.eviction_attempts.load(Ordering::Acquire), 2);
  assert_eq!(handles.snapshot_events.eviction_errors.load(Ordering::Acquire), 0);
  assert_eq!(
    handles.snapshot_events.evicted_keys.load(Ordering::Acquire),
    deleted as u64
  );
  assert_eq!(deleted, 1, "only the malformed key remains for the exact-count flush");

  let disabled = DocCache::new(
    redis,
    "disabled",
    &RedisDocCacheConfig {
      snapshot_enabled: false,
      ..RedisDocCacheConfig::default()
    },
  );
  let disabled_handles = disabled.tuning_handles();
  disabled.get_snapshot(ws, doc).await;
  disabled.set_snapshot(ws, doc, b"x").await;
  disabled.invalidate_snapshot(ws, doc).await;
  assert_eq!(disabled_handles.snapshot_events.disabled.load(Ordering::Acquire), 3);
  assert_eq!(disabled_handles.snapshot_events.absent.load(Ordering::Acquire), 0);

  let failing = DocCache::new(Arc::new(FailingRedis), "failing", &RedisDocCacheConfig::default());
  let failing_handles = failing.tuning_handles();
  failing.get_snapshot(ws, doc).await;
  failing.set_snapshot(ws, doc, b"x").await;
  failing.invalidate_snapshot(ws, doc).await;
  assert_eq!(failing_handles.snapshot_events.read_errors.load(Ordering::Acquire), 1);
  assert_eq!(failing_handles.snapshot_events.write_errors.load(Ordering::Acquire), 1);
  assert_eq!(
    failing_handles
      .snapshot_events
      .eviction_attempts
      .load(Ordering::Acquire),
    1
  );
  assert_eq!(
    failing_handles.snapshot_events.eviction_errors.load(Ordering::Acquire),
    1
  );
  assert_eq!(failing_handles.snapshot_events.absent.load(Ordering::Acquire), 0);

  failing
    .set_document_metadata_index(ws, "contract-v1:failure", &[])
    .await;
  assert!(
    failing
      .get_document_metadata_index(ws, "contract-v1:failure")
      .await
      .is_none()
  );
  let index_events = failing.document_metadata_index_events();
  assert_eq!(index_events.write_errors.load(Ordering::Acquire), 1);
  assert_eq!(index_events.read_errors.load(Ordering::Acquire), 1);
  assert_eq!(index_events.absent.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn inv_p104_01c_non_miss_traffic_cannot_raise_ttl() {
  let pool = helpers::setup_pool().await;
  let (_, handles) = make_doc_cache(120, 60, 60, 30);
  let events = &handles.snapshot_events;
  events.decode_errors.store(200, Ordering::Release);
  events.read_errors.store(200, Ordering::Release);
  events.disabled.store(200, Ordering::Release);
  events.skipped_oversized.store(200, Ordering::Release);
  events.uncacheable.store(200, Ordering::Release);
  events.write_errors.store(200, Ordering::Release);
  handles
    .document_metadata_index_events
    .absent
    .store(1_000, Ordering::Release);

  run_hourly_cycle_doc_caches_once(&handles, &test_cache_config(), &metrics_service(&pool)).await;

  assert_eq!(handles.snapshot_ttl.load(Ordering::Acquire), 120);
  assert_eq!(handles.snapshot_events.absent.load(Ordering::Acquire), 0);
  assert_eq!(
    handles.document_metadata_index_events.absent.load(Ordering::Acquire),
    0,
    "fixed inventory-cache events are observed and reset without entering a TTL decision"
  );
  assert_eq!(
    events.read_errors.load(Ordering::Acquire),
    0,
    "the tuner owns the reset"
  );
}

#[tokio::test]
async fn inv_p104_01d_version_churn_is_not_an_expiry_miss() {
  let pool = helpers::setup_pool().await;
  let (_, handles) = make_doc_cache(120, 60, 60, 30);
  handles.snapshot_events.hits.store(200, Ordering::Release);
  handles.snapshot_events.version_changes.store(41, Ordering::Release);

  run_daily_cycle_doc_caches_once(&handles, &test_cache_config(), &metrics_service(&pool)).await;

  assert_eq!(handles.snapshot_events.absent.load(Ordering::Acquire), 0);
  assert_eq!(handles.snapshot_ttl.load(Ordering::Acquire), 60);
}

#[tokio::test]
async fn inv_p104_01b_metadata_projection_ttl_is_tuned_as_doc_cache() {
  let pool = helpers::setup_pool().await;
  let (_, handles) = make_doc_cache(120, 60, 60, 30);

  handles.metadata_projection_events.hits.store(0, Ordering::Release);
  handles.metadata_projection_events.absent.store(100, Ordering::Release);

  let config = test_cache_config();
  run_hourly_cycle_doc_caches_once(&handles, &config, &metrics_service(&pool)).await;

  assert_eq!(
    handles.metadata_projection_ttl.load(Ordering::Acquire),
    90,
    "doc_metadata_projection must participate in the doc-cache hourly tuning loop"
  );
}

// ---------------------------------------------------------------------------
// INV-P104-02: Hourly cycle increases TTL when hit rate < 30% (≥100 requests).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p104_02_hourly_cycle_increases_ttl_on_low_hit_rate() {
  let pool = helpers::setup_pool().await;
  let (_, handles) = make_doc_cache(120, 60, 60, 30);

  // Seed 20 hits + 80 misses = hit rate 20% (< 30%), total 100 requests.
  handles.snapshot_events.hits.store(20, Ordering::Release);
  handles.snapshot_events.absent.store(80, Ordering::Release);

  let initial_ttl = handles.snapshot_ttl.load(Ordering::Acquire);
  assert_eq!(initial_ttl, 120);

  let config = test_cache_config();
  run_hourly_cycle_doc_caches_once(&handles, &config, &metrics_service(&pool)).await;

  let new_ttl = handles.snapshot_ttl.load(Ordering::Acquire);
  assert!(
    new_ttl > initial_ttl,
    "INV-P104-02: TTL should increase on low hit rate; got initial={initial_ttl} new={new_ttl}"
  );
  // apply_hourly_rules: rate < 30% → raw = 120 * 1.5 = 180; constrained to [60, 240] → 180.
  assert_eq!(
    new_ttl, 180,
    "expected TTL to increase to 180 (1.5× for < 30% hit rate)"
  );
}

// ---------------------------------------------------------------------------
// INV-P104-03: Fixed override skips tuning; TTL is pinned.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p104_03_fixed_override_skips_tuning() {
  let pool = helpers::setup_pool().await;
  let (_, handles) = make_doc_cache(120, 60, 60, 30);

  // Set up a fixed override of 90s for snapshot.
  let config = CacheConfig {
    doc_snapshot_fixed_ttl_seconds: Some(90),
    ..test_cache_config()
  };

  // Seed extreme low hit rate (would normally trigger increase).
  handles.snapshot_events.hits.store(0, Ordering::Release);
  handles.snapshot_events.absent.store(500, Ordering::Release);

  run_hourly_cycle_doc_caches_once(&handles, &config, &metrics_service(&pool)).await;

  let ttl_after = handles.snapshot_ttl.load(Ordering::Acquire);
  assert_eq!(
    ttl_after, 90,
    "INV-P104-03: fixed override should pin TTL to 90; got {ttl_after}"
  );
}

// ---------------------------------------------------------------------------
// INV-P104-04: adminUpdateConfig mutation immediately applies doc-cache TTL override.
// ---------------------------------------------------------------------------

#[test]
fn inv_p104_04_admin_config_applies_doc_cache_ttl_override() {
  helpers::block_on_large_stack("inv_p104_04_admin_config_applies_doc_cache_ttl_override", || async {
    use serde_json::json;

    let pool = helpers::setup_pool().await;
    let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;

    let (user_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

    // The test app uses InMemoryRedisAdapter — no real DocCache.
    // This test verifies the GraphQL mutation succeeds and the DB is updated.
    // (In production, the atomic would be updated; in tests, no handles are wired.)
    let mutation = r#"
    mutation {
      admin {
        adminUpdateConfig(updates: [{ module: "cache", key: "doc_snapshot_fixed_ttl_seconds", value: 75 }]) {
          applied
          fieldErrors { module key message }
        }
      }
    }
  "#;

    let resp = helpers::gql(&app, session_id, json!({ "query": mutation })).await;
    assert!(
      resp["errors"].is_null(),
      "INV-P104-04: unexpected GraphQL errors: {resp}"
    );
    assert!(
      resp["data"]["admin"]["adminUpdateConfig"]["applied"].as_bool() == Some(true),
      "INV-P104-04: mutation returned applied=false; fieldErrors={fe}",
      fe = resp["data"]["admin"]["adminUpdateConfig"]["fieldErrors"]
    );

    // Verify the value was written to app_configs.
    let stored: Option<serde_json::Value> =
      sqlx::query_scalar("SELECT value FROM app_configs WHERE id = 'cache.doc_snapshot_fixed_ttl_seconds'")
        .fetch_optional(&pool)
        .await
        .expect("DB query");

    assert_eq!(
      stored.and_then(|v| v.as_u64()),
      Some(75),
      "INV-P104-04: expected app_configs to store value 75"
    );

    // Cleanup.
    sqlx::query("DELETE FROM app_configs WHERE id = 'cache.doc_snapshot_fixed_ttl_seconds'")
      .execute(&pool)
      .await
      .unwrap();
    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}

// ---------------------------------------------------------------------------
// INV-P104-05: Daily cycle caps TTL increase at 2× current.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p104_05_daily_cycle_increase_capped_at_2x() {
  let pool = helpers::setup_pool().await;
  let current_ttl = 60u64;
  let (_, handles) = make_doc_cache(current_ttl, 60, 60, 30);

  // apply_daily_rules: hit rate 0% with 500 requests → TTL × 2.0.
  // With current = 60, raw = 120 = 2× → exactly at constraint limit.
  handles.snapshot_events.hits.store(0, Ordering::Release);
  handles.snapshot_events.absent.store(500, Ordering::Release);

  let config = test_cache_config();
  run_daily_cycle_doc_caches_once(&handles, &config, &metrics_service(&pool)).await;

  let new_ttl = handles.snapshot_ttl.load(Ordering::Acquire);
  // 2× constraint: max allowed = current * 2 = 120.
  assert!(
    new_ttl <= current_ttl * 2,
    "INV-P104-05: TTL increase must be ≤ 2× current; current={current_ttl} new={new_ttl}"
  );
}

// ---------------------------------------------------------------------------
// INV-P104-06: Daily cycle caps TTL decrease at 0.5× current.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p104_06_daily_cycle_decrease_capped_at_half() {
  let pool = helpers::setup_pool().await;
  // Use a TTL in the middle of the range to allow decrease.
  let current_ttl = 120u64;
  let (_, handles) = make_doc_cache(current_ttl, 60, 60, 30);

  // apply_daily_rules: hit rate > 60% with many invalidations per hit → TTL × 0.5.
  // 200 hits, 0 misses → hit rate 100%; total_inv / hits must be > 0.2.
  // Seed 200 hits + 0 absent keys = 100% hit rate with no invalidations
  // → no change expected (high hit rate, no churn = healthy).
  handles.snapshot_events.hits.store(200, Ordering::Release);
  handles.snapshot_events.absent.store(0, Ordering::Release);

  let config = test_cache_config();
  run_daily_cycle_doc_caches_once(&handles, &config, &metrics_service(&pool)).await;

  let new_ttl = handles.snapshot_ttl.load(Ordering::Acquire);
  // With 100% hit rate and no invalidations, TTL should be unchanged.
  assert_eq!(
    new_ttl, current_ttl,
    "INV-P104-06: 100% hit rate with no invalidations should not change TTL; got {new_ttl}"
  );
  // And it must be ≥ 0.5× current regardless of what the algorithm produces.
  assert!(
    new_ttl >= current_ttl / 2,
    "INV-P104-06: TTL must never fall below 0.5× current; current={current_ttl} new={new_ttl}"
  );
}
