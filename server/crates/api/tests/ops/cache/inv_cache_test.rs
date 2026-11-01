//! P83 — Invariant-first integration tests: cache coherence.
//!
//! Tests verify that within a single server instance, mutations correctly
//! invalidate the moka in-process cache so that subsequent reads reflect the
//! updated state rather than stale cached data.
//!
//! Naming convention: `inv_{code}_{description}`.
//!
//! These tests are serialised via a per-suite mutex to prevent concurrent
//! cache interactions from producing false results.

use crate::helpers;

use std::sync::OnceLock;

use serde_json::json;
use tokio::sync::Mutex;

fn cache_inv_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

// ---------------------------------------------------------------------------
// INV-CACHE-02 — user features cache is invalidated after updateUserFeatures
//
// Invariant: after an admin toggles a feature flag via `updateUserFeatures`,
// a subsequent `currentUser { features }` query by the affected user must
// reflect the new feature set.  A stale cache read would silently serve the
// old flags — a data contract violation.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cache02_user_features_update_reflected_after_mutation() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let _lock = cache_inv_lock().lock().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "inv-cache02").await;

  const FEATURES_QUERY: &str = r#"query { currentUser { features } }"#;

  // 1. Prime the features cache — read initial feature set.
  let before = helpers::gql(&app, user_session, helpers::gql_query(FEATURES_QUERY)).await;
  assert!(
    before.get("errors").is_none(),
    "INV-CACHE-02: initial features query failed: {before}"
  );
  let features_before = before["data"]["currentUser"]["features"]
    .as_array()
    .expect("INV-CACHE-02: features must be an array");
  // Static defaults must stay neutral; the mutation below proves cache
  // invalidation by enabling and disabling the optional capability explicitly.
  assert!(
    !features_before.iter().any(|v| v == "UnlimitedCopilot"),
    "INV-CACHE-02: UnlimitedCopilot must not be a static default feature"
  );
  for forbidden in [
    "FreePlan",
    "ProPlan",
    "TeamPlan",
    "LifetimeProPlan",
    "UnlimitedWorkspace",
  ] {
    assert!(
      !features_before.iter().any(|v| v == forbidden),
      "INV-CACHE-02: static defaults must not advertise {forbidden}: {features_before:?}"
    );
  }

  // 2. Admin enables UnlimitedCopilot — mutation must invalidate the cache.
  let toggle_on = helpers::gql(
    &app,
    admin_session,
    json!({"query": format!("mutation {{ admin {{ updateUserFeatures(id:\"{user_id}\", features:[UnlimitedCopilot]) }} }}")}),
  )
  .await;
  assert!(
    toggle_on.get("errors").is_none(),
    "INV-CACHE-02: updateUserFeatures enable failed: {toggle_on}"
  );

  // 3. Re-read features — cache must have been invalidated.
  let enabled = helpers::gql(&app, user_session, helpers::gql_query(FEATURES_QUERY)).await;
  assert!(
    enabled.get("errors").is_none(),
    "INV-CACHE-02: post-enable features query failed: {enabled}"
  );
  let features_enabled = enabled["data"]["currentUser"]["features"]
    .as_array()
    .expect("INV-CACHE-02: features must be an array");
  assert!(
    features_enabled.iter().any(|v| v == "UnlimitedCopilot"),
    "INV-CACHE-02: UnlimitedCopilot must be visible after enable — cache was not invalidated"
  );

  // 4. Disable again and prove the user-facing feature list follows.
  let toggle_off = helpers::gql(
    &app,
    admin_session,
    json!({"query": format!("mutation {{ admin {{ updateUserFeatures(id:\"{user_id}\", features:[]) }} }}")}),
  )
  .await;
  assert!(
    toggle_off.get("errors").is_none(),
    "INV-CACHE-02: updateUserFeatures disable failed: {toggle_off}"
  );
  let after = helpers::gql(&app, user_session, helpers::gql_query(FEATURES_QUERY)).await;
  assert!(
    after.get("errors").is_none(),
    "INV-CACHE-02: post-disable features query failed: {after}"
  );
  let features_after = after["data"]["currentUser"]["features"]
    .as_array()
    .expect("INV-CACHE-02: features must be an array");
  assert!(
    !features_after.iter().any(|v| v == "UnlimitedCopilot"),
    "INV-CACHE-02: UnlimitedCopilot must be absent after disable — cache was not invalidated"
  );

  helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
}
