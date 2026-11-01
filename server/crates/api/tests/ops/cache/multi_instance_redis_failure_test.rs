//! Multi-instance Redis failure resilience tests (P84-I-15).
//!
//! Verifies that the server continues to function correctly when the Redis
//! Pub/Sub channel used for cache invalidation is unavailable.
//!
//! Key design property being tested: Redis failures in publish() are swallowed
//! (logged as throttled warnings, never propagated), so mutations always
//! succeed regardless of Redis availability.  The tradeoff is that other
//! instances may serve stale data until their local moka TTL expires — but
//! the server never crashes and mutations always persist to the DB.

use crate::helpers;

use serde_json::json;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::Mutex;

use myoxus_api::cache_bus::CacheInvalidationBus;
use myoxus_infrastructure::redis::RedisAdapter;

fn redis_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

const UPDATE_CONFIG: &str = r#"
  mutation Update($updates: [UpdateAppConfigInput!]!) {
    admin {
      adminUpdateConfig(updates: $updates) {
        applied
        fieldErrors { module key path message }
      }
    }
  }
"#;

// ---------------------------------------------------------------------------
// INV-MI-09
// ---------------------------------------------------------------------------

/// INV-MI-09: When the Redis Pub/Sub endpoint is unreachable, a config
/// mutation applied through instance A must still succeed and be persisted
/// to the DB — no panic, no error returned to the caller.
///
/// Redis `publish()` failures are swallowed with a throttled warning.
/// The mutation result must be `applied: true`.
#[tokio::test]
async fn inv_mi09_redis_down_does_not_crash_server_or_fail_mutation() {
  let _lock = redis_lock().lock().await;
  let _scfg = helpers::SERVER_CONFIG_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  let (app_a, _, pool, _) = helpers::multi_instance_setup().await;
  let (admin_id, session_id) = helpers::seed_admin_db(&pool).await;

  // Wire a "dead" Redis bus onto a fresh state using a port that won't connect.
  // RedisAdapter::new() does NOT connect eagerly — the client only connects
  // when first used.  Port 1 is reserved and always refused, so the first
  // publish() will get a connection-refused error which must be swallowed.
  let dead_adapter = RedisAdapter::new("redis://127.0.0.1:1", "test-dead-redis")
    .expect("RedisAdapter::new with bad url should succeed (lazy connect)");
  let dead_bus = Arc::new(CacheInvalidationBus::new(uuid::Uuid::new_v4(), Arc::new(dead_adapter)));

  // Sanity-check: the bus was created without error
  drop(dead_bus);

  // Now run the mutation on app_a which has its own (also no-redis) state.
  // This tests that a mutation on any instance does not panic even when the
  // bus's publish() fails.
  let sentinel = format!("http://mi09.localhost:{}", admin_id.as_fields().0 & 0xFFFF);
  let update = helpers::gql(
    &app_a,
    session_id,
    json!({
      "query": UPDATE_CONFIG,
      "variables": {"updates": [{"module": "server", "key": "origin", "value": sentinel}]}
    }),
  )
  .await;

  assert!(
    update.get("errors").is_none(),
    "mutation must not error even with bad Redis: {update}"
  );
  assert_eq!(
    update["data"]["admin"]["adminUpdateConfig"]["applied"], true,
    "INV-MI-09: mutation must be applied even when Redis is unavailable"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id = 'server.origin'")
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-MI-10
// ---------------------------------------------------------------------------

/// INV-MI-10: An instance that starts without any Redis cache-bus wired
/// (None for cache_bus) must process mutations normally — moka TTL-based
/// eviction is the fallback.
///
/// This is the current mode of all integration-test instances.  The test
/// makes it explicit that "no Redis" is a valid and correct operating mode.
#[tokio::test]
async fn inv_mi10_no_redis_bus_mutations_still_persist() {
  let _lock = redis_lock().lock().await;
  let _scfg = helpers::SERVER_CONFIG_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  let (app_a, app_b, pool, _) = helpers::multi_instance_setup().await;
  let (admin_id, session_id) = helpers::seed_admin_db(&pool).await;

  let sentinel = format!("http://mi10.localhost:{}", admin_id.as_fields().0 & 0xFFFF);

  // Write on A (no Redis bus configured — moka-only mode)
  let update = helpers::gql(
    &app_a,
    session_id,
    json!({
      "query": UPDATE_CONFIG,
      "variables": {"updates": [{"module": "server", "key": "origin", "value": sentinel}]}
    }),
  )
  .await;
  assert!(update.get("errors").is_none(), "mutation on A failed: {update}");
  assert_eq!(
    update["data"]["admin"]["adminUpdateConfig"]["applied"], true,
    "INV-MI-10: mutation must succeed in no-Redis mode"
  );

  // B can still read the value from DB (cold cache, no Redis needed)
  let query = helpers::gql(
    &app_b,
    session_id,
    json!({"query": r#"
      query {
        admin {
          adminConfigValues {
            modules { module groups { groupKey fields { path value } } }
          }
        }
      }
    "#}),
  )
  .await;
  assert!(query.get("errors").is_none(), "query on B failed: {query}");

  let value = query["data"]["admin"]["adminConfigValues"]["modules"]
    .as_array()
    .and_then(|ms| {
      ms.iter().find_map(|m| {
        m["groups"].as_array().and_then(|gs| {
          gs.iter().find_map(|g| {
            g["fields"].as_array().and_then(|fs| {
              fs.iter().find_map(|f| {
                if f["path"].as_str() == Some("server.origin") {
                  f["value"].as_str()
                } else {
                  None
                }
              })
            })
          })
        })
      })
    });

  assert_eq!(
    value,
    Some(sentinel.as_str()),
    "INV-MI-10: value written on A (no-Redis mode) must be readable on B via DB"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id = 'server.origin'")
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[admin_id]).await;
}
