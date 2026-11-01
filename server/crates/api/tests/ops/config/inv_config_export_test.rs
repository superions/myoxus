// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant tests for config export endpoint (P91-CFG-B-T01).

use crate::helpers;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// INV-CFG-EXP-01: Export response is parseable JSON
#[tokio::test]
async fn inv_cfg_exp01_export_is_valid_json() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/admin/config/export")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");

  assert_eq!(resp.status(), StatusCode::OK, "export must return 200");
  let bytes = resp.into_body().collect().await.expect("body").to_bytes();
  let body: serde_json::Value = serde_json::from_slice(&bytes).expect("export must be valid JSON");
  assert!(body.is_object(), "export must be a JSON object");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-CFG-EXP-02: Export reflects DB overrides
#[tokio::test]
async fn inv_cfg_exp02_export_reflects_db_overrides() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  // Insert a DB override using flat dot-notation key.
  sqlx::query(
    "INSERT INTO app_configs (id, value, created_at, updated_at)
     VALUES ('server.name', to_jsonb($1::text), now(), now())
     ON CONFLICT (id) DO UPDATE SET value = to_jsonb($1::text), updated_at = now()",
  )
  .bind("ExportTestName")
  .execute(&pool)
  .await
  .expect("insert override");

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/admin/config/export")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");

  assert_eq!(resp.status(), StatusCode::OK);
  let bytes = resp.into_body().collect().await.expect("body").to_bytes();
  let body: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");

  assert_eq!(
    body["server.name"], "ExportTestName",
    "the consuming export tier must project the DB override"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id = 'server.name'")
    .execute(&pool)
    .await
    .expect("cleanup");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-CFG-EXP-03: Sensitive fields are redacted by default
#[tokio::test]
async fn inv_cfg_exp03_sensitive_redacted_by_default() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/admin/config/export")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");

  assert_eq!(resp.status(), StatusCode::OK);
  let bytes = resp.into_body().collect().await.expect("body").to_bytes();
  let body: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");

  // Any key that falls under a sensitive prefix should be REDACTED.
  if let Some(obj) = body.as_object() {
    for (key, val) in obj {
      if key.starts_with("crypto.") || key.starts_with("oauth.") || key.starts_with("copilot.providers.") {
        let s = val.as_str().unwrap_or("");
        assert!(
          s.contains("REDACTED") || s.contains("***"),
          "sensitive key {key} must be redacted, got: {s}"
        );
      }
    }
  }

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// The legacy query flag is accepted for request compatibility but can never
/// cross the effective resolver's secret boundary.
#[tokio::test]
async fn inv_cfg_exp05_include_secrets_flag_cannot_reveal_plaintext() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  for query in ["", "?include_secrets=true"] {
    let resp = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/api/admin/config/export{query}"))
          .header("cookie", format!("affine_session={session_id}"))
          .body(Body::empty())
          .expect("request"),
      )
      .await
      .expect("response");
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.expect("body").to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");
    assert_eq!(
      body["crypto.private_key"],
      myoxus_contracts::effective_config::MASKED_CONFIG_VALUE
    );
    assert!(
      !String::from_utf8_lossy(&bytes).contains("myoxus-change-me-private-key"),
      "the default plaintext key must not cross the export boundary"
    );
  }

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-CFG-EXP-04: Export requires admin auth
#[tokio::test]
async fn inv_cfg_exp04_export_requires_auth() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/admin/config/export")
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");

  let status = resp.status().as_u16();
  assert!(
    status == 401 || status == 403,
    "export without auth must return 401 or 403, got {status}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
