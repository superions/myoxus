//! P84-H-25: Integration tests for user features moka cache layer.
//!
//! Invariants tested:
//! - INV-CACHE-UF-01: currentUser.features is present without plan defaults
//! - INV-CACHE-UF-02: updateUserFeatures invalidates the cache, re-query reflects changes

use crate::helpers;

use serde_json::json;

/// INV-CACHE-UF-01: A freshly created user exposes a feature array without
/// reintroducing plan-/billing-shaped defaults.
#[tokio::test]
async fn inv_cache_uf01_user_features_do_not_advertise_plan_defaults() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "feat-cache").await;

  let resp = helpers::gql(&app, session_id, json!({"query": "query { currentUser { features } }"})).await;
  assert!(resp.get("errors").is_none(), "features query failed: {resp}");

  let features = resp["data"]["currentUser"]["features"]
    .as_array()
    .expect("features must be an array");
  for forbidden in [
    "FreePlan",
    "ProPlan",
    "TeamPlan",
    "LifetimeProPlan",
    "UnlimitedWorkspace",
  ] {
    assert!(
      !features.iter().any(|v| v == forbidden),
      "default user features must not include {forbidden}: {features:?}"
    );
  }

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// INV-CACHE-UF-02: After an admin toggles UnlimitedCopilot off via
/// updateUserFeatures, a subsequent currentUser query reflects the change
/// (the moka user-features cache was invalidated).
#[tokio::test]
async fn inv_cache_uf02_user_features_reflects_toggle() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "feat-toggle").await;

  // 1. Baseline: optional copilot capability is not enabled by default.
  let before = helpers::gql(
    &app,
    user_session,
    json!({"query": "query { currentUser { features } }"}),
  )
  .await;
  let features_before = before["data"]["currentUser"]["features"].as_array().expect("features");
  assert!(
    !features_before.iter().any(|v| v == "UnlimitedCopilot"),
    "UnlimitedCopilot must not be a static default feature"
  );

  // 2. Admin enables UnlimitedCopilot; the next read must observe it.
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({"query": format!(
      "mutation {{ admin {{ updateUserFeatures(id:\"{user_id}\", features:[UnlimitedCopilot]) }} }}"
    )}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "enable mutation failed: {resp}");

  let enabled = helpers::gql(
    &app,
    user_session,
    json!({"query": "query { currentUser { features } }"}),
  )
  .await;
  let features_enabled = enabled["data"]["currentUser"]["features"].as_array().expect("features");
  assert!(
    features_enabled.iter().any(|v| v == "UnlimitedCopilot"),
    "UnlimitedCopilot must be visible after enable mutation"
  );

  // 3. Admin removes UnlimitedCopilot again with an empty capability list.
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({"query": format!(
      "mutation {{ admin {{ updateUserFeatures(id:\"{user_id}\", features:[]) }} }}"
    )}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "mutation failed: {resp}");

  // 4. Re-query: UnlimitedCopilot must be gone (cache was invalidated)
  let after = helpers::gql(
    &app,
    user_session,
    json!({"query": "query { currentUser { features } }"}),
  )
  .await;
  let features_after = after["data"]["currentUser"]["features"].as_array().expect("features");
  assert!(
    !features_after.iter().any(|v| v == "UnlimitedCopilot"),
    "UnlimitedCopilot must be removed after toggle"
  );

  // Cleanup
  helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
}
