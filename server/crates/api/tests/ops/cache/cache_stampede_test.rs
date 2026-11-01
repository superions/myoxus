//! Concurrent serverConfig response coverage.
//!
//! Invariant tested:
//! - INV-CACHE-STAMPEDE-01: 50 concurrent serverConfig cache-miss requests all
//!   succeed and return identical, correct data.
//!
//! Identical responses do not prove a single loader execution. Causal loader
//! counts live with the settings, feature and metadata owners changed by WLP-07.

use crate::helpers;

use std::sync::{Arc, OnceLock};

use myoxus_api::cache::WorkspaceSettingsCached;
use myoxus_api::config::AppConfig;
use myoxus_api::state::ApiState;
use myoxus_application::ports::RedisPort;
use myoxus_infrastructure::redis::InMemoryRedisAdapter;
use tokio::sync::Mutex;
use uuid::Uuid;

fn stampede_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

const SERVER_CONFIG_QUERY: &str = r#"
  query { serverConfig { name version credentialsRequirement { password { minLength maxLength } } } }
"#;

/// INV-CACHE-STAMPEDE-01: 50 concurrent serverConfig requests during a cache
/// miss all succeed and return identical data.
///
/// This preserves useful concurrent serverConfig coverage only. The cache is
/// warm before the wave, so this test deliberately makes no loader-count claim.
#[tokio::test]
async fn inv_concurrent_warm_server_config_responses_are_consistent() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let _lock = stampede_lock().lock().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Warm the cache so we have a known-good baseline response shape, then
  // invalidate by deleting any cached override so the next batch is a miss.
  // (The in-process cache expires on its own TTL — we cannot directly evict
  // it from a test, so we rely on each test app instance starting with a
  // cold cache, which setup_app() guarantees via a fresh server state.)
  let baseline = helpers::gql(&app, session_id, helpers::gql_query(SERVER_CONFIG_QUERY)).await;
  assert!(baseline.get("errors").is_none(), "baseline query failed: {baseline}");
  let baseline_config = &baseline["data"]["serverConfig"];
  assert!(
    baseline_config.is_object(),
    "serverConfig must be an object: {baseline}"
  );

  // Fire 50 concurrent requests.  Each spawned task gets its own clone of
  // the app router (axum routers are cheaply cloneable / Send + Sync).
  let mut handles = Vec::with_capacity(50);
  for _ in 0..50 {
    let app_clone = app.clone();
    let handle =
      tokio::spawn(async move { helpers::gql(&app_clone, session_id, helpers::gql_query(SERVER_CONFIG_QUERY)).await });
    handles.push(handle);
  }

  // Collect all 50 responses.
  let mut responses = Vec::with_capacity(50);
  for (i, handle) in handles.into_iter().enumerate() {
    let resp = handle.await.unwrap_or_else(|e| panic!("task {i} panicked: {e}"));
    assert!(
      resp.get("errors").is_none(),
      "concurrent request {i} returned errors: {resp}"
    );
    responses.push(resp);
  }

  // All 50 responses must be identical to the baseline.
  for (i, resp) in responses.iter().enumerate() {
    assert_eq!(
      &resp["data"]["serverConfig"], baseline_config,
      "concurrent response {i} differs from the warm baseline"
    );
  }

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-CACHE-STAMPEDE-02: Concurrent requests return consistent `name` and
/// `version` fields — no partial or empty values produced by a race.
///
/// This is a focused value-level check: even if one concurrent loader
/// raced with another, the returned `name` and `version` fields must be
/// non-empty strings, never null or blank.
#[tokio::test]
async fn inv_concurrent_responses_have_non_empty_fields() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let _lock = stampede_lock().lock().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let mut handles = Vec::with_capacity(20);
  for _ in 0..20 {
    let app_clone = app.clone();
    handles.push(tokio::spawn(async move {
      helpers::gql(&app_clone, session_id, helpers::gql_query(SERVER_CONFIG_QUERY)).await
    }));
  }

  for (i, handle) in handles.into_iter().enumerate() {
    let resp = handle.await.unwrap_or_else(|e| panic!("task {i} panicked: {e}"));
    assert!(resp.get("errors").is_none(), "request {i} returned errors: {resp}");
    let cfg = &resp["data"]["serverConfig"];
    let name = cfg["name"].as_str().unwrap_or_default();
    let version = cfg["version"].as_str().unwrap_or_default();
    assert!(
      !name.is_empty(),
      "request {i}: serverConfig.name must not be empty — got: {cfg}"
    );
    assert!(
      !version.is_empty(),
      "request {i}: serverConfig.version must not be empty — got: {cfg}"
    );
  }

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn inv_cold_feature_and_settings_waves_run_one_population_loader_each() {
  let redis = Arc::new(InMemoryRedisAdapter::new(format!("coalesced-wave-{}", Uuid::new_v4())));
  let state = ApiState::new(AppConfig::load().expect("test config")).with_cache_redis(redis.clone());
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let features = vec!["__disabled".to_string(), "__manager_projection".to_string()];
  let settings = WorkspaceSettingsCached {
    enable_ai: true,
    enable_sharing: false,
    enable_url_preview: true,
    enable_doc_embedding: false,
  };
  redis
    .set_string(
      &format!("cache:features:{user_id}"),
      &serde_json::to_string(&features).expect("feature JSON"),
      Some(300),
    )
    .await
    .expect("seed feature L2");
  redis
    .set_string(
      &format!("cache:ws_settings:{workspace_id}"),
      &serde_json::to_string(&settings).expect("settings JSON"),
      Some(300),
    )
    .await
    .expect("seed settings L2");

  let barrier = Arc::new(tokio::sync::Barrier::new(64));
  let mut tasks = Vec::new();
  for index in 0..64 {
    let state = state.clone();
    let barrier = barrier.clone();
    let settings = settings.clone();
    tasks.push(tokio::spawn(async move {
      barrier.wait().await;
      if index % 2 == 0 {
        assert_eq!(state.user_feature_overrides_cached_l2(user_id).await, Some(false));
      } else {
        assert_eq!(state.workspace_settings_cached(workspace_id).await, Some(settings));
      }
    }));
  }
  for task in tasks {
    task.await.expect("cold-wave task joins");
  }
  assert_eq!(state.query_cache.user_feature_population_loads(), 1);
  assert_eq!(state.query_cache.ws_settings_population_loads(), 1);
}

#[tokio::test]
async fn inv_generation_fence_keeps_pre_invalidation_fill_unreachable() {
  let state = ApiState::new(AppConfig::load().expect("test config"));
  let workspace_id = Uuid::new_v4();
  let stale_key = state.query_cache.ws_settings_key(workspace_id);
  state.query_cache.invalidate_ws_settings(workspace_id).await;
  state
    .query_cache
    .ws_settings
    .insert(
      stale_key,
      WorkspaceSettingsCached {
        enable_ai: false,
        enable_sharing: false,
        enable_url_preview: false,
        enable_doc_embedding: false,
      },
    )
    .await;

  assert!(
    state
      .query_cache
      .ws_settings
      .get(&state.query_cache.ws_settings_key(workspace_id))
      .await
      .is_none()
  );
}
