// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant tests for the `serverConfig.deploymentType` configuration signal.
//!
//! These tests verify that:
//! - The default deployment type wire value is "Standalone" (INV-DT-01)
//! - Both `type` and `deploymentType` fields are consistent (INV-DT-02)
//! - The admin config system exposes `server.deployment_type` (INV-DT-03)
//! - Admin config mutation can change the deployment type (INV-DT-04)
//! - Invalid values are rejected by validation (INV-DT-05)
//!
//! Config values: `standalone` / `cloud`. Wire values: `"Standalone"` /
//! `"Cloud"`. Active Myoxus contracts must not expose upstream brand names.

use crate::helpers;

use serde_json::json;
use std::sync::Mutex;

/// INV-DT-01 + INV-DT-02: Default config returns wire value "Standalone" for
/// both fields, and both fields
/// are always consistent.
#[tokio::test]
async fn inv_dt01_deployment_type_default_and_consistency() {
  let _guard = helpers::DEPLOYMENT_TYPE_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("deployment type lock");
  // Pre-cleanup BEFORE setup_app so load_config_overrides_from_db sees clean state.
  let pool = helpers::setup_pool().await;
  sqlx::query("DELETE FROM app_configs WHERE id = 'server.deployment_type'")
    .execute(&pool)
    .await
    .expect("clear deployment type before default assertion");
  let (app, _pool, _auth_store) = helpers::setup_app_with_pool(pool).await;

  let res = helpers::gql_anon(&app, json!({ "query": "{ serverConfig { type deploymentType } }" })).await;

  assert!(res.get("errors").is_none(), "serverConfig query failed: {res}");
  let sc = &res["data"]["serverConfig"];
  assert_eq!(
    sc["deploymentType"], "Standalone",
    "default deploymentType must be Standalone"
  );
  assert_eq!(sc["type"], "Standalone", "default type must be Standalone");
  assert_eq!(
    sc["deploymentType"], sc["type"],
    "deploymentType and type must be consistent"
  );
}

/// INV-DT-02: Introspection exposes only the two Myoxus deployment values.
/// This catches a reintroduction of upstream-branded enum members even when
/// the default resolver happens to return the standalone branch.
#[tokio::test]
async fn inv_dt02_deployment_type_schema_uses_myoxus_vocabulary() {
  let app = helpers::setup_app().await.0;
  let res = helpers::gql_anon(
    &app,
    json!({
      "query": "{ __type(name: \"ServerDeploymentType\") { enumValues { name } } }"
    }),
  )
  .await;

  assert!(res.get("errors").is_none(), "enum introspection failed: {res}");
  let mut values = res["data"]["__type"]["enumValues"]
    .as_array()
    .expect("ServerDeploymentType enum values")
    .iter()
    .map(|value| value["name"].as_str().expect("enum value name"))
    .collect::<Vec<_>>();
  values.sort_unstable();
  assert_eq!(values, vec!["Cloud", "Standalone"]);
}

/// INV-DT-03: server.deployment_type appears in admin config with default "standalone".
#[test]
fn inv_dt03_deployment_type_in_admin_config() {
  helpers::block_on_large_stack("inv_dt03_deployment_type_in_admin_config", || async {
    let _guard = helpers::DEPLOYMENT_TYPE_LOCK
      .get_or_init(|| Mutex::new(()))
      .lock()
      .expect("deployment type lock");
    let pool = helpers::setup_pool().await;
    sqlx::query("DELETE FROM app_configs WHERE id = 'server.deployment_type'")
      .execute(&pool)
      .await
      .expect("clear deployment type before Admin projection assertion");
    let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

    // Use adminConfigValues (not adminConfigSchema) to get actual field values
    let res = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
        query {
          admin {
            adminConfigValues {
              modules {
                module
                groups {
                  fields {
                    path
                    value
                  }
                }
              }
            }
          }
        }
      "#
      }),
    )
    .await;

    assert!(res.get("errors").is_none(), "adminConfigValues query failed: {res}");

    let modules = res["data"]["admin"]["adminConfigValues"]["modules"]
      .as_array()
      .expect("modules array");
    let server_module = modules
      .iter()
      .find(|m| m["module"] == "server")
      .expect("server module must exist");

    let groups = server_module["groups"].as_array().expect("groups");
    let all_fields: Vec<_> = groups
      .iter()
      .flat_map(|g| g["fields"].as_array().map_or_else(Vec::new, |a| a.to_vec()))
      .collect();

    let dt_field = all_fields
      .iter()
      .find(|f| f["path"] == "server.deployment_type")
      .expect("server.deployment_type field must exist in admin config");

    assert_eq!(
      dt_field["value"], "standalone",
      "default admin config value for server.deployment_type must be 'standalone'"
    );

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

/// INV-DT-04: The restart-bound override is pending until a new runtime starts.
#[tokio::test]
async fn inv_dt04_deployment_type_update_via_admin() {
  let _guard = helpers::DEPLOYMENT_TYPE_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("deployment type lock");
  let pool = helpers::setup_pool().await;
  sqlx::query("DELETE FROM app_configs WHERE id = 'server.deployment_type'")
    .execute(&pool)
    .await
    .expect("clear deployment type before restart assertion");
  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Update deployment type to "cloud"
  let update_res = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        mutation U($u: [UpdateAppConfigInput!]!) {
          admin {
            adminUpdateConfig(updates: $u) {
              applied
              fieldErrors { path message }
            }
          }
        }
      "#,
      "variables": { "u": [{"module": "server", "key": "deployment_type", "value": "cloud"}] }
    }),
  )
  .await;

  assert!(update_res.get("errors").is_none(), "mutation failed: {update_res}");
  assert_eq!(
    update_res["data"]["admin"]["adminUpdateConfig"]["applied"], true,
    "mutation must be applied"
  );

  // The existing process retains its startup value.
  let sc_res = helpers::gql_anon(&app, json!({ "query": "{ serverConfig { type deploymentType } }" })).await;

  assert!(sc_res.get("errors").is_none(), "serverConfig query failed: {sc_res}");
  let sc = &sc_res["data"]["serverConfig"];
  assert_eq!(
    sc["deploymentType"], "Standalone",
    "restart-bound value must not change in the running process"
  );
  assert_eq!(sc["type"], "Standalone");

  // A newly constructed runtime applies the persisted override.
  let restarted = helpers::setup_app().await.0;
  let restarted_res = helpers::gql_anon(
    &restarted,
    json!({ "query": "{ serverConfig { type deploymentType } }" }),
  )
  .await;
  assert_eq!(restarted_res["data"]["serverConfig"]["deploymentType"], "Cloud");
  assert_eq!(restarted_res["data"]["serverConfig"]["type"], "Cloud");

  // Release the override so later runtimes return to the file/default value.
  sqlx::query("DELETE FROM app_configs WHERE id = 'server.deployment_type'")
    .execute(&pool)
    .await
    .expect("cleanup deployment type override");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-DT-06: ENV override `MYOXUS__SERVER__DEPLOYMENT_TYPE=cloud` overrides YAML default.
///
/// The config load runs in a child copy of this test binary so no process-wide
/// environment mutation can leak into another integration test.
#[test]
fn inv_dt06_deployment_type_env_override() {
  const CHILD_MARKER: &str = "MYOXUS_TEST_DEPLOYMENT_TYPE_CHILD";
  if std::env::var_os(CHILD_MARKER).is_some() {
    let config = myoxus_api::config::AppConfig::load().expect("load config with environment override");
    assert_eq!(config.server.deployment_type, "cloud");
    return;
  }

  let output = std::process::Command::new(std::env::current_exe().expect("integration test executable"))
    .arg("--exact")
    .arg("inv_deployment_type_test::inv_dt06_deployment_type_env_override")
    .arg("--nocapture")
    .env(CHILD_MARKER, "1")
    .env("MYOXUS__SERVER__DEPLOYMENT_TYPE", "cloud")
    .output()
    .expect("run isolated deployment config test");
  assert!(
    output.status.success(),
    "environment override child failed\nstdout: {}\nstderr: {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
}

/// INV-DT-05: Invalid deployment type values are rejected.
#[tokio::test]
async fn inv_dt05_deployment_type_rejects_invalid_value() {
  let _guard = helpers::DEPLOYMENT_TYPE_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("deployment type lock");
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let res = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        mutation U($u: [UpdateAppConfigInput!]!) {
          admin {
            adminUpdateConfig(updates: $u) {
              applied
              fieldErrors { path message }
            }
          }
        }
      "#,
      "variables": { "u": [{"module": "server", "key": "deployment_type", "value": "banana"}] }
    }),
  )
  .await;

  assert!(
    res.get("errors").is_none(),
    "mutation should return structured errors, not GQL errors: {res}"
  );
  assert_eq!(
    res["data"]["admin"]["adminUpdateConfig"]["applied"], false,
    "invalid deployment type must be rejected"
  );

  let field_errors = res["data"]["admin"]["adminUpdateConfig"]["fieldErrors"]
    .as_array()
    .expect("fieldErrors array");
  assert!(
    field_errors
      .iter()
      .any(|error| error["path"] == "server.deployment_type"),
    "the descriptor-owned field error must identify server.deployment_type: {field_errors:?}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
