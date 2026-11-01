// SPDX-License-Identifier: AGPL-3.0-or-later
//! P100-SRV-H-08 — Invariant-first integration tests: copilot effective config.
//!
//! Invariant: `serverConfig.features` must NOT include "Copilot" when the
//! manual toggle `copilot.enabled = true` is set in app_configs BUT no provider
//! has both `enabled = true` AND a non-empty `api_key` in the server config.
//! Naming convention: `inv_{code}_{description}`.

use crate::helpers;

use serde_json::json;
use std::sync::OnceLock;
use tokio::sync::Mutex;

fn h08_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

// ---------------------------------------------------------------------------
// INV-H08 — copilot.enabled = true in app_configs but no provider api_key →
//           serverConfig.features must NOT contain "Copilot"
//
// Invariant: Clients use `serverConfig { features }` to decide whether to show
// AI buttons. If the manual toggle is on but no provider has api_key configured,
// AI calls will fail. The server must suppress the Copilot feature flag so
// clients hide AI UI rather than show broken functionality.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_h08_copilot_enabled_requires_provider() {
  let (app, pool, auth_store) = helpers::setup_app_with_config_override(|config| {
    // Keep this invariant hermetic: a developer machine or CI secret may
    // legitimately configure a Copilot provider, but this negative contract
    // must exercise "manual toggle on, no runnable provider" specifically.
    config.copilot.providers.clear();
    config.copilot.fallback_providers.clear();
  })
  .await;
  let _lock = h08_lock().lock().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Set copilot.enabled = true via adminUpdateConfig (simulates operator enabling AI in UI)
  let update_resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        mutation Update($updates: [UpdateAppConfigInput!]!) {
          admin {
            adminUpdateConfig(updates: $updates) { applied }
          }
        }
      "#,
      "variables": { "updates": [{"module": "copilot", "key": "enabled", "value": true}] }
    }),
  )
  .await;
  assert!(
    update_resp.get("errors").is_none(),
    "INV-H08: adminUpdateConfig failed: {update_resp}"
  );
  assert_eq!(
    update_resp["data"]["admin"]["adminUpdateConfig"]["applied"], true,
    "INV-H08: mutation must report applied=true"
  );

  // Query serverConfig.features — Copilot must NOT be present because no provider has api_key
  let config_resp = helpers::gql(&app, session_id, json!({ "query": "{ serverConfig { features } }" })).await;
  assert!(
    config_resp.get("errors").is_none(),
    "INV-H08: serverConfig query failed: {config_resp}"
  );

  let features: Vec<String> = config_resp["data"]["serverConfig"]["features"]
    .as_array()
    .expect("INV-H08: features must be an array")
    .iter()
    .filter_map(|v| v.as_str().map(String::from))
    .collect();

  assert!(
    !features.iter().any(|f| f.eq_ignore_ascii_case("Copilot")),
    "INV-H08: Copilot must NOT appear in features when manually enabled but no provider has api_key — got: {features:?}"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id = 'copilot.enabled'")
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[admin_id]).await;
}
