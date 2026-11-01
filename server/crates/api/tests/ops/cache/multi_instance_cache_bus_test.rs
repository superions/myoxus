//! Cross-instance cache invalidation via Redis Pub/Sub bus (P84-I).
//!
//! ## Invariant tested
//!
//! - INV-MI-10: When instance A publishes a cache invalidation via the
//!   `CacheInvalidationBus`, instance B's subscriber receives the message
//!   and evicts the corresponding moka-cache entry within 200 ms.
//!
//! ## Why this test matters
//!
//! Multi-instance tests in `multi_instance_config_sync_test.rs` etc. verify
//! DB-level consistency using *cold* caches (cache miss → DB read).  They do
//! NOT verify that a *hot* moka cache on instance B gets invalidated when
//! instance A mutates a value.
//!
//! This test fills that gap: it primes instance B's moka cache directly, then
//! verifies the Pub/Sub subscriber evicts the entry after a cross-instance
//! invalidation message.
//!
//! ## Test design
//!
//! - Direct `QueryCache` + `CacheInvalidationBus` usage (no HTTP round-trip)
//!   to keep the test focused and deterministic.
//! - Uses the test-stack Redis (:6380) via `REDIS_URL` env var.
//! - If Redis is unavailable, the test is skipped (infrastructure gap, not
//!   an application bug).

use std::sync::Arc;
use std::sync::OnceLock;

use tokio::sync::Mutex;
use uuid::Uuid;

use myoxus_api::cache::QueryCache;
use myoxus_api::cache_bus::CacheInvalidationBus;
use myoxus_infrastructure::redis::RedisAdapter;

fn bus_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

/// Build a `RedisAdapter` for the test stack, or `None` if Redis is down.
fn redis_adapter() -> Option<Arc<RedisAdapter>> {
  let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  match RedisAdapter::new(&url, "cache_bus_test") {
    Ok(a) => Some(Arc::new(a)),
    Err(_) => None,
  }
}

// ── INV-MI-10 ────────────────────────────────────────────────────────────────

/// INV-MI-10: Cache invalidation published by instance A is received by
/// instance B's subscriber within 200 ms, evicting the hot moka entry.
///
/// Setup:
///   1. Both instances share the same Redis (test-stack :6380).
///   2. Instance B's QueryCache is primed with a test key.
///   3. A CacheBus subscriber runs on instance B.
///   4. Instance A publishes an invalidation for that key.
///   5. After 200 ms, instance B's cache must not contain the key.
///
/// Failure mode: if Pub/Sub is broken, the key remains in B's moka cache.
#[tokio::test]
async fn inv_mi10_cache_bus_invalidates_hot_cache_on_remote_instance() {
  let _lock = bus_lock().lock().await;

  let Some(adapter_a) = redis_adapter() else {
    eprintln!("  [SKIP] Redis unavailable — skipping INV-MI-10");
    return;
  };
  let adapter_b = adapter_a.clone(); // share the same Redis server

  // Instance UUIDs — must be distinct so subscriber skips self-originated messages.
  let instance_a = Uuid::new_v4();
  let instance_b = Uuid::new_v4();
  assert_ne!(instance_a, instance_b);

  // Create QueryCache for instance B using default cache config.
  let config_b = myoxus_api::cache::CacheConfig::default();
  let cache_b = QueryCache::new(&config_b);

  // Prime instance B's server-config moka cache with a sentinel value.
  let test_key = format!("test.inv_mi10.{}", instance_b.as_simple());
  let test_value = serde_json::json!("primed-by-instance-b");
  cache_b.server_config.insert(test_key.clone(), test_value.clone()).await;

  // Verify the entry is present before the test.
  assert!(
    cache_b.server_config.get(&test_key).await.is_some(),
    "INV-MI-10: test key must be primed in instance B's moka cache before the test"
  );

  // Start Cache Bus subscriber on instance B.
  // The subscriber runs as a background tokio task that listens on the Pub/Sub
  // channel and calls QueryCache::invalidate_* when it receives messages from
  // other instances.
  let (_subscriber_handle, sub_ready) =
    CacheInvalidationBus::start_subscriber(cache_b.clone(), adapter_b, instance_b, None);

  // Wait until the subscriber has actually subscribed to the Redis channel
  // (not just a fixed sleep — the oneshot fires when SUBSCRIBE succeeds).
  sub_ready.await.expect("INV-MI-10: subscriber ready signal dropped");

  // Create Cache Bus for instance A and publish an invalidation.
  let bus_a = Arc::new(CacheInvalidationBus::new(instance_a, adapter_a));
  bus_a.publish("server_config", &test_key).await;

  // Wait for Pub/Sub propagation (local Redis → should be fast, 200 ms is generous).
  tokio::time::sleep(std::time::Duration::from_millis(200)).await;

  // Instance B's cache must no longer contain the key.
  let cached = cache_b.server_config.get(&test_key).await;
  assert!(
    cached.is_none(),
    "INV-MI-10: instance B's moka entry for '{test_key}' must have been evicted \
     by the cross-instance Cache Bus invalidation from instance A. \
     Got: {cached:?}"
  );
}

/// Configuration notifications bypass the removed app-config moka cache and
/// wake the one shared ConfigOverrides refresh owner on remote instances.
#[tokio::test]
async fn config_notification_wakes_the_shared_refresh_path() {
  let _lock = bus_lock().lock().await;
  let Some(adapter_a) = redis_adapter() else {
    eprintln!("  [SKIP] Redis unavailable — skipping config refresh wake-up");
    return;
  };
  let instance_a = Uuid::new_v4();
  let instance_b = Uuid::new_v4();
  let cache = QueryCache::new(&myoxus_api::cache::CacheConfig::default());
  let (refresh_tx, mut refresh_rx) = tokio::sync::mpsc::unbounded_channel();
  let (_subscriber, ready) =
    CacheInvalidationBus::start_subscriber(cache, adapter_a.clone(), instance_b, Some(refresh_tx));
  ready.await.expect("config subscriber ready");

  CacheInvalidationBus::new(instance_a, adapter_a)
    .publish("app_config", "all")
    .await;
  tokio::time::timeout(std::time::Duration::from_secs(1), refresh_rx.recv())
    .await
    .expect("remote config notification must wake refresh")
    .expect("refresh channel must remain open");
}

// ── INV-MI-11 ────────────────────────────────────────────────────────────────

/// INV-MI-11: The Cache Bus subscriber does NOT process self-originated
/// invalidation messages.
///
/// When instance A publishes and instance A also has a subscriber running, the
/// subscriber must skip the message (source == local instance_id). This prevents
/// a no-op double-invalidation that would waste resources.
///
/// Verified by: Instance A primes its own cache, publishes, waits 200 ms.
/// The key must still be present (not evicted by self-message).
///
/// Note: This tests the *subscriber* skip-self logic, not the *publisher*
/// publish-self logic.  In production, instance A's mutation handler already
/// invalidates local caches before publishing, so self-eviction via Pub/Sub
/// is always redundant.  The skip prevents a spurious second eviction.
#[tokio::test]
async fn inv_mi11_cache_bus_subscriber_skips_self_originated_messages() {
  let _lock = bus_lock().lock().await;

  let Some(adapter) = redis_adapter() else {
    eprintln!("  [SKIP] Redis unavailable — skipping INV-MI-11");
    return;
  };

  let instance_id = Uuid::new_v4();

  let config = myoxus_api::cache::CacheConfig::default();
  let cache = QueryCache::new(&config);

  // Prime the cache.
  let test_key = format!("test.inv_mi11.{}", instance_id.as_simple());
  let test_value = serde_json::json!("primed");
  cache.server_config.insert(test_key.clone(), test_value).await;

  assert!(
    cache.server_config.get(&test_key).await.is_some(),
    "INV-MI-11: test key must be primed before the test"
  );

  // Start subscriber with the same instance_id as the publisher.
  let (_subscriber, sub_ready) =
    CacheInvalidationBus::start_subscriber(cache.clone(), adapter.clone(), instance_id, None);
  sub_ready.await.expect("INV-MI-11: subscriber ready signal dropped");

  // Publish from the same instance.
  let bus = Arc::new(CacheInvalidationBus::new(instance_id, adapter));
  bus.publish("server_config", &test_key).await;

  tokio::time::sleep(std::time::Duration::from_millis(200)).await;

  // Cache must still contain the key — self-messages are skipped.
  let still_there = cache.server_config.get(&test_key).await;
  assert!(
    still_there.is_some(),
    "INV-MI-11: cache entry must NOT be evicted by a self-originated message. \
     The subscriber should have skipped the message from the same instance_id."
  );

  // Cleanup: evict the test key so it doesn't pollute other tests.
  cache.server_config.invalidate(&test_key).await;
}
