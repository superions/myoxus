// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant test: P100-SRV-D — canonical client download URL roundtrip.
//!
//! Invariant: after `adminUpdateConfig` sets `client.download_url`,
//! serverConfig { client { downloadUrl } } must return the set value.
//! Without the key set, serverConfig returns an empty string.

use crate::helpers;

use serde_json::json;
use std::sync::Mutex;

/// INV-D-01: serverConfig.client.download_url defaults to empty string.
#[tokio::test]
async fn inv_d_client_download_url_default_empty() {
  let _guard = helpers::DOWNLOAD_URL_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("download url lock");
  // Delete stale value BEFORE setup_app so load_config_overrides_from_db sees a clean state.
  let pool = helpers::setup_pool().await;
  sqlx::query("DELETE FROM app_configs WHERE id = 'client.download_url'")
    .execute(&pool)
    .await
    .expect("cleanup: delete stale downloadUrl config");
  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "query { serverConfig { client { downloadUrl } } }"}),
  )
  .await;

  assert!(resp.get("errors").is_none(), "query failed: {resp}");
  assert_eq!(
    resp["data"]["serverConfig"]["client"]["downloadUrl"], "",
    "default downloadUrl must be empty string"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-D-02: A live canonical update is projected through serverConfig.
#[tokio::test]
async fn inv_d_client_download_url_roundtrip() {
  let _guard = helpers::DOWNLOAD_URL_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("download url lock");
  let pool = helpers::setup_pool().await;
  sqlx::query("DELETE FROM app_configs WHERE id = 'client.download_url'")
    .execute(&pool)
    .await
    .expect("cleanup: delete stale downloadUrl config");
  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Prime the public projection so this roundtrip fails if the Admin mutation
  // stops invalidating the already-populated serverConfig cache.
  let before = helpers::gql(
    &app,
    session_id,
    json!({"query": "query { serverConfig { client { downloadUrl } } }"}),
  )
  .await;
  assert!(before.get("errors").is_none(), "initial query failed: {before}");
  assert_eq!(before["data"]["serverConfig"]["client"]["downloadUrl"], "");

  let expected_url = format!("https://download-{}.example.test", uuid::Uuid::new_v4());
  // Set through the one retained Admin mutation.
  let set_resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation Update($value: JSON!) { admin { adminUpdateConfig(updates:[{module:\"client\", key:\"download_url\", value:$value}]) { applied } } }",
      "variables": { "value": expected_url }
    }),
  )
  .await;
  assert!(set_resp.get("errors").is_none(), "mutation failed: {set_resp}");

  // Verify serverConfig returns the set value
  let get_resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "query { serverConfig { client { downloadUrl } } }"}),
  )
  .await;
  assert!(get_resp.get("errors").is_none(), "query failed: {get_resp}");
  assert_eq!(
    get_resp["data"]["serverConfig"]["client"]["downloadUrl"], expected_url,
    "downloadUrl must reflect the Admin update even when serverConfig was cached"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id = 'client.download_url'")
    .execute(&pool)
    .await
    .expect("cleanup: delete downloadUrl config");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}
