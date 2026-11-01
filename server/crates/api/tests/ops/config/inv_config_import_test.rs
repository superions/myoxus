// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant tests for config import endpoint (P91-CFG-B-T02).

use crate::helpers;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

/// INV-CFG-IMP-01: Partial import only updates specified keys
#[tokio::test]
async fn inv_cfg_imp01_partial_import_only_updates_specified() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Seed a pre-existing value for server.name.
  sqlx::query(
    "INSERT INTO app_configs (id, value, created_at, updated_at)
     VALUES ('server.name', to_jsonb('Before'::text), now(), now())
     ON CONFLICT (id) DO UPDATE SET value = to_jsonb('Before'::text), updated_at = now()",
  )
  .execute(&pool)
  .await
  .expect("seed");

  // Import only copilot.enabled — server.name must not be touched.
  let body = json!({ "config": { "copilot.enabled": true } }).to_string();
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/admin/config/import")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(body))
        .expect("request"),
    )
    .await
    .expect("response");

  assert_eq!(resp.status(), StatusCode::OK);
  let response_body = to_bytes(resp.into_body(), 64 * 1024).await.expect("response body");
  let response_json: serde_json::Value = serde_json::from_slice(&response_body).expect("config import JSON response");
  assert!(matches!(
    response_json["writeback"].as_str(),
    Some("written" | "unchanged" | "disabled" | "failed")
  ));

  // server.name must still be 'Before'.
  let row: Option<(serde_json::Value,)> = sqlx::query_as("SELECT value FROM app_configs WHERE id = 'server.name'")
    .fetch_optional(&pool)
    .await
    .expect("query");
  let val = row.expect("server.name must still exist").0;
  assert_eq!(
    val.as_str(),
    Some("Before"),
    "partial import must not touch server.name"
  );
  let audit_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM admin_audit_log \
     WHERE actor_user_id = $1 AND category = 'config' AND target_id = 'copilot.enabled'",
  )
  .bind(admin_id)
  .fetch_one(&pool)
  .await
  .expect("import audit row");
  assert_eq!(audit_count, 1, "REST imports must audit every committed config change");

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id IN ('server.name', 'copilot.enabled')")
    .execute(&pool)
    .await
    .expect("cleanup");
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1 AND category = 'config'")
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("cleanup config audit row");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// A malformed out-of-band row must reject the whole batch before commit.
/// This guards against an error response that nevertheless changes durable
/// configuration, which would prevent callers from refreshing or auditing it.
#[tokio::test]
async fn invalid_persisted_row_rejects_batch_without_committing() {
  let (_app, pool, _auth_store) = helpers::setup_app().await;
  let unknown_path = format!("review.invalid_out_of_band_path.{}", Uuid::new_v4());
  let target_path = "copilot.enabled";
  let before = sqlx::query_scalar::<_, serde_json::Value>("SELECT value FROM app_configs WHERE id = $1")
    .bind(target_path)
    .fetch_optional(&pool)
    .await
    .expect("read target before rejected batch");
  sqlx::query("INSERT INTO app_configs (id, value) VALUES ($1, 'true'::jsonb)")
    .bind(&unknown_path)
    .execute(&pool)
    .await
    .expect("seed invalid out-of-band row");

  let result = myoxus_infrastructure::app_config::write_config_batch(
    &pool,
    &[myoxus_infrastructure::app_config::ConfigMutation::Set {
      path: target_path.to_string(),
      value: json!(!before.as_ref().and_then(serde_json::Value::as_bool).unwrap_or(false)),
    }],
    myoxus_infrastructure::app_config::ConfigBatchMode::Partial,
    None,
    &myoxus_api::config::AppConfigStartupValidator,
  )
  .await;
  let after = sqlx::query_scalar::<_, serde_json::Value>("SELECT value FROM app_configs WHERE id = $1")
    .bind(target_path)
    .fetch_optional(&pool)
    .await;
  sqlx::query("DELETE FROM app_configs WHERE id = $1")
    .bind(&unknown_path)
    .execute(&pool)
    .await
    .expect("cleanup invalid row");
  match &before {
    Some(value) => {
      sqlx::query(
        "INSERT INTO app_configs (id, value) VALUES ($1, $2) \
         ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      )
      .bind(target_path)
      .bind(value)
      .execute(&pool)
      .await
      .expect("restore target row");
    }
    None => {
      sqlx::query("DELETE FROM app_configs WHERE id = $1")
        .bind(target_path)
        .execute(&pool)
        .await
        .expect("restore absent target row");
    }
  }

  let error = result.expect_err("invalid persisted row must reject the batch");
  assert!(
    matches!(error, myoxus_infrastructure::app_config::ConfigWriteError::UnknownPath(path) if path == unknown_path)
  );
  let after = after.expect("query rejected mutation");
  assert_eq!(after, before, "rejected batch must not commit any mutation");
}

/// INV-CFG-IMP-02: Import requires admin auth
#[tokio::test]
async fn inv_cfg_imp02_import_requires_admin() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let body = json!({ "config": { "copilot.enabled": true } }).to_string();
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/admin/config/import")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .expect("request"),
    )
    .await
    .expect("response");

  let status = resp.status().as_u16();
  assert!(
    status == 401 || status == 403,
    "INV-CFG-IMP-02: unauthenticated import must return 401 or 403, got {status}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-CFG-IMP-03: Import with null value removes key
#[tokio::test]
async fn inv_cfg_imp03_null_value_removes_key() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Seed a value
  sqlx::query(
    "INSERT INTO app_configs (id, value, created_at, updated_at)
     VALUES ('copilot.enabled', 'true'::jsonb, now(), now())
     ON CONFLICT (id) DO UPDATE SET value = 'true'::jsonb, updated_at = now()",
  )
  .execute(&pool)
  .await
  .expect("seed");

  // Import null → should remove the key.
  let body = json!({ "config": { "copilot.enabled": null } }).to_string();
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/admin/config/import")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(body))
        .expect("request"),
    )
    .await
    .expect("response");

  assert_eq!(resp.status(), StatusCode::OK);

  let row: Option<(serde_json::Value,)> = sqlx::query_as("SELECT value FROM app_configs WHERE id = 'copilot.enabled'")
    .fetch_optional(&pool)
    .await
    .expect("query");

  assert!(
    row.is_none(),
    "INV-CFG-IMP-03: null import should remove the key, but it still exists"
  );

  let removal_audit_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM admin_audit_log \
     WHERE actor_user_id = $1 AND category = 'config' \
       AND target_id = 'copilot.enabled' AND new_value = 'null'::jsonb",
  )
  .bind(admin_id)
  .fetch_one(&pool)
  .await
  .expect("remove audit row");
  assert_eq!(
    removal_audit_count, 1,
    "releasing an override must be distinguishable in the config audit log"
  );

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1 AND category = 'config'")
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("cleanup config audit row");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
