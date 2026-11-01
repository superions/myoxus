//! P37-G: Integration tests for workspace storage quota enforcement.
//!
//! Invariants tested:
//!   - INV-Q-01: Blob upload exceeding quota returns STORAGE_QUOTA_EXCEEDED
//!   - INV-Q-02: Blob upload within quota succeeds
//!   - INV-Q-03: Admin can set/read storageQuotaBytes on a workspace

use crate::helpers::{cleanup_users, create_workspace, gql, seed_admin, setup_app};
use serde_json::json;
use sqlx::Row;

/// INV-Q-01: Blob upload exceeding workspace quota returns STORAGE_QUOTA_EXCEEDED.
#[tokio::test]
async fn inv_q01_blob_upload_rejected_when_quota_exceeded() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, admin_sid) = seed_admin(&pool, &auth_store).await;
  let ws_id = create_workspace(&pool, admin_id).await;

  // Set a tiny quota (100 bytes)
  sqlx::query("UPDATE workspaces SET storage_quota_bytes = 100 WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("setting storage quota must succeed");

  // Seed storage stats so current usage is 50 bytes
  sqlx::query(
    "INSERT INTO workspace_storage_stats (workspace_id, snapshot_size, blob_size, updated_at) VALUES ($1, 30, 20, now()) ON CONFLICT (workspace_id) DO UPDATE SET snapshot_size = 30, blob_size = 20",
  )
  .bind(ws_id)
  .execute(&pool)
  .await
  .expect("seeding storage stats must succeed");

  // Try uploading a 60-byte blob (50 + 60 = 110 > 100 quota) via setBlob
  let boundary = "QUOTA-TEST";
  let operations = json!({
    "query": "mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }",
    "variables": { "workspaceId": ws_id.to_string(), "blob": null }
  }).to_string();
  let map = json!({ "0": ["variables.blob"] }).to_string();
  let content = vec![0u8; 60];

  let mut body = Vec::new();
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"operations\"\r\n\r\n");
  body.extend_from_slice(operations.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"map\"\r\n\r\n");
  body.extend_from_slice(map.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"0\"; filename=\"big.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n");
  body.extend_from_slice(&content);
  body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

  use axum::{body::Body, http::Request};
  use http_body_util::BodyExt;
  use tower::ServiceExt;

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={admin_sid}"))
        .body(Body::from(body))
        .expect("multipart request must be buildable"),
    )
    .await
    .expect("blob upload request must not fail at transport level");
  let bytes = resp
    .into_body()
    .collect()
    .await
    .expect("response body must be collectable")
    .to_bytes();
  let result: serde_json::Value = serde_json::from_slice(&bytes).expect("response body must be valid JSON");

  assert!(result.get("errors").is_some(), "expected quota error, got: {result}");
  assert_eq!(
    result["errors"][0]["extensions"]["name"], "STORAGE_QUOTA_EXCEEDED",
    "error name must be STORAGE_QUOTA_EXCEEDED: {result}"
  );

  // Cleanup: supplementary tables not covered by cleanup_users
  sqlx::query("DELETE FROM workspace_storage_stats WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace_storage_stats");
  sqlx::query("DELETE FROM blobs WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete blobs");
  cleanup_users(&pool, &[admin_id]).await;
}

/// INV-Q-02: Blob upload within quota succeeds normally.
#[tokio::test]
async fn inv_q02_blob_upload_succeeds_within_quota() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, admin_sid) = seed_admin(&pool, &auth_store).await;
  let ws_id = create_workspace(&pool, admin_id).await;

  // Set a generous quota (10 KB)
  sqlx::query("UPDATE workspaces SET storage_quota_bytes = 10240 WHERE id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("setting storage quota must succeed");

  // Upload a small blob (20 bytes)
  let boundary = "QUOTA-OK";
  let operations = json!({
    "query": "mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }",
    "variables": { "workspaceId": ws_id.to_string(), "blob": null }
  }).to_string();
  let map = json!({ "0": ["variables.blob"] }).to_string();
  let content = vec![0u8; 20];

  let mut body = Vec::new();
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"operations\"\r\n\r\n");
  body.extend_from_slice(operations.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"map\"\r\n\r\n");
  body.extend_from_slice(map.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"0\"; filename=\"small.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n");
  body.extend_from_slice(&content);
  body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

  use axum::{body::Body, http::Request};
  use http_body_util::BodyExt;
  use tower::ServiceExt;

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={admin_sid}"))
        .body(Body::from(body))
        .expect("multipart request must be buildable"),
    )
    .await
    .expect("blob upload request must not fail at transport level");
  let bytes = resp
    .into_body()
    .collect()
    .await
    .expect("response body must be collectable")
    .to_bytes();
  let result: serde_json::Value = serde_json::from_slice(&bytes).expect("response body must be valid JSON");

  assert!(result.get("errors").is_none(), "expected success, got errors: {result}");
  assert_eq!(result["data"]["setBlob"], "small.bin");

  // Cleanup: supplementary tables not covered by cleanup_users
  sqlx::query("DELETE FROM workspace_storage_stats WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace_storage_stats");
  sqlx::query("DELETE FROM blobs WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete blobs");
  cleanup_users(&pool, &[admin_id]).await;
}

/// INV-Q-03: Admin can set and read storageQuotaBytes via admin mutation.
#[tokio::test]
async fn inv_q03_admin_set_read_storage_quota_bytes() {
  let (app, pool, auth_store) = setup_app().await;
  let (admin_id, admin_sid) = seed_admin(&pool, &auth_store).await;
  let ws_id = create_workspace(&pool, admin_id).await;

  // Set quota via admin mutation
  let set_result = gql(
    &app,
    admin_sid,
    json!({
      "query": "mutation UpdateWorkspace($input: AdminUpdateWorkspaceInput!) { admin { adminUpdateWorkspace(input: $input) { id storageQuotaBytes } } }",
      "variables": {
        "input": {
          "id": ws_id.to_string(),
          "storageQuotaBytes": 5242880_i64
        }
      }
    }),
  )
  .await;
  assert!(set_result.get("errors").is_none(), "set quota failed: {set_result}");
  assert_eq!(
    set_result["data"]["admin"]["adminUpdateWorkspace"]["storageQuotaBytes"],
    5242880
  );

  // Verify in DB
  let db_quota: Option<i64> = sqlx::query("SELECT storage_quota_bytes FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .expect("workspace quota row must be fetchable")
    .get("storage_quota_bytes");
  assert_eq!(db_quota, Some(5242880), "DB must reflect set quota");

  // Cleanup: supplementary tables not covered by cleanup_users
  sqlx::query("DELETE FROM workspace_storage_stats WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("cleanup: delete workspace_storage_stats");
  cleanup_users(&pool, &[admin_id]).await;
}
