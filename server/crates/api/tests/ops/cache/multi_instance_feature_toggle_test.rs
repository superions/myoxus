//! Multi-instance feature-toggle propagation tests (P84-I-13).
//!
//! Verifies that feature-flag changes applied through instance A are visible
//! on instance B, which shares the same PostgreSQL database but has its own
//! cold moka-cache.
//!
//! Because both instances start with empty caches every read that is a cache
//! miss goes directly to the DB — the authoritative store.  This validates the
//! DB-consistency invariant for user-feature overrides independent of Redis
//! Pub/Sub.

use crate::helpers;

use serde_json::{Value, json};
use std::sync::OnceLock;
use tokio::sync::Mutex;

fn feature_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

// ---------------------------------------------------------------------------
// Query / mutation constants
// ---------------------------------------------------------------------------

const UPDATE_FEATURES: &str = r#"
  mutation UpdateFeatures($id: String!, $features: [FeatureType!]!) {
    admin { updateUserFeatures(id: $id, features: $features) }
  }
"#;

const GET_USER_FEATURES: &str = r#"
  query GetFeatures($id: String!) {
    admin {
      userById(id: $id) {
        features
      }
    }
  }
"#;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

fn has_feature(resp: &Value, feature: &str) -> bool {
  resp["data"]["admin"]["userById"]["features"]
    .as_array()
    .map(|arr| arr.iter().any(|f| f.as_str() == Some(feature)))
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// INV-MI-03
// ---------------------------------------------------------------------------

/// INV-MI-03: A feature-flag change written through instance A must be
/// readable through instance B when B's cache is cold (cache miss → DB read).
///
/// `UnlimitedCopilot` is toggled for a regular user via A's admin session.
/// B's cold cache forces a DB hit on the feature-override table, returning
/// the updated feature set.
#[tokio::test]
async fn inv_mi03_feature_toggle_on_a_visible_on_b() {
  let _lock = feature_lock().lock().await;
  let (app_a, app_b, pool, _) = helpers::multi_instance_setup().await;
  let (admin_id, session_id) = helpers::seed_admin_db(&pool).await;

  // Create a regular (non-admin) user as the toggle target.
  let target_id = helpers::create_user(&pool, "regular", false).await;

  // Enable UnlimitedCopilot via instance A
  let update = helpers::gql(
    &app_a,
    session_id,
    json!({
      "query": UPDATE_FEATURES,
      "variables": {"id": target_id.to_string(), "features": ["UnlimitedCopilot"]}
    }),
  )
  .await;
  assert!(
    update.get("errors").is_none(),
    "updateUserFeatures on A failed: {update}"
  );

  // Query via instance B (cold cache → DB read) using admin userById to bypass ACL
  let query = helpers::gql(
    &app_b,
    session_id,
    json!({
      "query": GET_USER_FEATURES,
      "variables": {"id": target_id.to_string()}
    }),
  )
  .await;
  assert!(
    query.get("errors").is_none(),
    "user features query on B failed: {query}"
  );
  assert!(
    has_feature(&query, "UnlimitedCopilot"),
    "INV-MI-03: UnlimitedCopilot set on A must be visible on B, got: {query}"
  );

  // Cleanup
  sqlx::query("DELETE FROM user_features WHERE user_id = $1")
    .bind(target_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}

// ---------------------------------------------------------------------------
// INV-MI-04
// ---------------------------------------------------------------------------

/// INV-MI-04: After removing a feature through instance A, instance B must
/// no longer report that feature for the same user (immediate DB consistency).
///
/// Grants UnlimitedCopilot through A, then revokes it through A, then checks
/// that B (cold cache) reflects the revocation.
#[tokio::test]
async fn inv_mi04_feature_revoke_on_a_not_visible_on_b() {
  let _lock = feature_lock().lock().await;
  let (app_a, app_b, pool, _) = helpers::multi_instance_setup().await;
  let (admin_id, session_id) = helpers::seed_admin_db(&pool).await;

  let target_id = helpers::create_user(&pool, "regular", false).await;

  // Grant
  helpers::gql(
    &app_a,
    session_id,
    json!({
      "query": UPDATE_FEATURES,
      "variables": {"id": target_id.to_string(), "features": ["UnlimitedCopilot"]}
    }),
  )
  .await;

  // Revoke (empty features list removes all overrides)
  let revoke = helpers::gql(
    &app_a,
    session_id,
    json!({
      "query": UPDATE_FEATURES,
      "variables": {"id": target_id.to_string(), "features": []}
    }),
  )
  .await;
  assert!(revoke.get("errors").is_none(), "revoke on A failed: {revoke}");

  // B must NOT see UnlimitedCopilot anymore (admin userById bypasses ACL)
  let query = helpers::gql(
    &app_b,
    session_id,
    json!({
      "query": GET_USER_FEATURES,
      "variables": {"id": target_id.to_string()}
    }),
  )
  .await;
  assert!(query.get("errors").is_none(), "query on B failed: {query}");
  assert!(
    !has_feature(&query, "UnlimitedCopilot"),
    "INV-MI-04: revoked feature must not be visible on B, got: {query}"
  );

  // Cleanup
  sqlx::query("DELETE FROM user_features WHERE user_id = $1")
    .bind(target_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}
