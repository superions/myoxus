// SPDX-License-Identifier: AGPL-3.0-or-later
//! P100-SRV-H-09b/d — Invariant tests for copilot blob adoption.
//!
//! INV-H09B-01: adoptCopilotBlob copies bytes to workspace storage and creates a blobs DB record.
//! INV-H09B-02: adoptCopilotBlob rejects a key whose user segment != caller.
//! INV-H09B-03: adoptCopilotBlob rejects a key whose workspace segment != workspace_id param.
//! INV-H09D-01: Adopted blob has status=completed in the blobs table — immune to copilot cleanup.

use crate::helpers;

use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest};
use myoxus_infrastructure::storage::StorageAdapter;
use serde_json::json;
use sqlx::Row;
use std::sync::Arc;
use uuid::Uuid;

/// Write a fake copilot blob to the test storage backend.
async fn seed_copilot_blob(user_id: Uuid, workspace_id: Uuid, filename: &str, body: &[u8]) {
  let storage: Arc<dyn BlobStoragePort> = Arc::new(StorageAdapter::new_fs("./test-storage").expect("test storage"));
  let key = format!("{user_id}/{workspace_id}/{filename}");
  storage
    .write_blob(BlobWriteRequest {
      key,
      content_type: Some("image/png".to_string()),
      body: bytes::Bytes::copy_from_slice(body),
    })
    .await
    .expect("seed copilot blob");
}

/// INV-H09B-01: adoptCopilotBlob creates a blobs DB record with status=completed.
#[tokio::test]
async fn inv_h09b01_adopt_creates_db_record() {
  use axum::{body::Body, http::Request};
  use http_body_util::BodyExt;
  use tower::ServiceExt;
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "adopt01").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  // Pre-seed a copilot blob in the test object store.
  let filename = "generated.png";
  seed_copilot_blob(user_id, workspace_id, filename, b"\x89PNG fake image bytes").await;
  let copilot_key = format!("{user_id}/{workspace_id}/{filename}");

  let uri = format!("/api/copilot/blob/{copilot_key}");
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(&uri)
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(response.status(), 200);
  assert_eq!(response.headers()["cache-control"], "private, no-store");
  assert_eq!(response.headers()["content-security-policy"], "sandbox allow-downloads");
  assert_eq!(response.headers()["x-content-type-options"], "nosniff");
  assert_eq!(
    response.into_body().collect().await.unwrap().to_bytes().as_ref(),
    b"\x89PNG fake image bytes"
  );
  let (other_id, other_session) = helpers::seed_user(&pool, &auth_store, "adopt01_other").await;
  for (cookie, status) in [(None, 401), (Some(other_session), 403)] {
    let mut request = Request::builder().uri(&uri);
    if let Some(cookie) = cookie {
      request = request.header("cookie", format!("affine_session={cookie}"));
    }
    let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status().as_u16(), status);
  }
  let missing = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(format!("/api/copilot/blob/{user_id}/{workspace_id}/missing.png"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(missing.status(), 404);
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
    .bind(workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("revoke fixture membership");
  let revoked = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(&uri)
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(revoked.status(), 403);
  sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,'Owner','Accepted',now())")
    .bind(workspace_id).bind(user_id).execute(&pool).await.expect("restore fixture membership");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation Adopt($wsId: String!, $key: String!) {
        adoptCopilotBlob(workspaceId: $wsId, copilotBlobKey: $key)
      }"#,
      "variables": { "wsId": workspace_id.to_string(), "key": copilot_key }
    }),
  )
  .await;

  assert!(resp.get("errors").is_none(), "adoptCopilotBlob failed: {resp}");
  let new_key = resp["data"]["adoptCopilotBlob"].as_str().expect("new_key string");
  assert!(!new_key.is_empty(), "INV-H09B-01: returned key must not be empty");

  // Verify the blobs DB record exists with the correct workspace and status.
  let row = sqlx::query("SELECT workspace_id, status FROM blobs WHERE workspace_id = $1 AND key = $2")
    .bind(workspace_id)
    .bind(new_key)
    .fetch_one(&pool)
    .await
    .expect("INV-H09B-01: blobs row must exist after adoption");

  let stored_ws: Uuid = row.get("workspace_id");
  let stored_status: String = row.get("status");
  assert_eq!(
    stored_ws, workspace_id,
    "INV-H09B-01: workspace_id mismatch in blobs table"
  );
  assert_eq!(
    stored_status, "completed",
    "INV-H09B-01: blob status must be 'completed'"
  );

  let storage = StorageAdapter::new_fs("./test-storage").expect("test storage");
  storage
    .delete_blob(&copilot_key)
    .await
    .expect("remove source fixture blob");
  storage
    .delete_blob(&format!("{workspace_id}/{new_key}"))
    .await
    .expect("remove adopted fixture blob");

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id, other_id]).await;
}

/// INV-H09B-02: adoptCopilotBlob rejects a key whose user segment != caller.
#[tokio::test]
async fn inv_h09b02_adopt_rejects_wrong_user() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "adopt02a").await;
  let (other_id, _) = helpers::seed_user(&pool, &auth_store, "adopt02b").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  // Key with other_id as the user segment — caller is user_id, not other_id.
  let bad_key = format!("{other_id}/{workspace_id}/file.png");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation Adopt($wsId: String!, $key: String!) {
        adoptCopilotBlob(workspaceId: $wsId, copilotBlobKey: $key)
      }"#,
      "variables": { "wsId": workspace_id.to_string(), "key": bad_key }
    }),
  )
  .await;

  assert!(
    resp.get("errors").is_some(),
    "INV-H09B-02: must error when user segment does not match caller: {resp}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id, other_id]).await;
}

/// INV-H09B-03: adoptCopilotBlob rejects a key whose workspace segment != workspace_id param.
#[tokio::test]
async fn inv_h09b03_adopt_rejects_workspace_mismatch() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "adopt03").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  let other_ws = Uuid::new_v4(); // does not match workspace_id param
  let bad_key = format!("{user_id}/{other_ws}/file.png");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation Adopt($wsId: String!, $key: String!) {
        adoptCopilotBlob(workspaceId: $wsId, copilotBlobKey: $key)
      }"#,
      "variables": { "wsId": workspace_id.to_string(), "key": bad_key }
    }),
  )
  .await;

  assert!(
    resp.get("errors").is_some(),
    "INV-H09B-03: must error when workspace segment does not match workspace_id param: {resp}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// INV-H09D-01: Adopted blob lives in the blobs table — it is NOT subject to copilot cleanup.
///
/// The nightly cleanOrphanedCopilotBlobs job deletes objects under the copilot
/// storage prefix whose session has been deleted.  Adopted blobs are stored under
/// the workspace prefix (`{workspace_id}/{key}`) and tracked in the `blobs` table,
/// so they are completely outside the copilot cleanup scope.
/// This test verifies the post-adoption DB state proves permanent ownership.
#[tokio::test]
async fn inv_h09d01_adopted_blob_immune_to_copilot_cleanup() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "adopt04").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  let filename = "chart.png";
  seed_copilot_blob(user_id, workspace_id, filename, b"fake PNG data for chart").await;
  let copilot_key = format!("{user_id}/{workspace_id}/{filename}");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation Adopt($wsId: String!, $key: String!) {
        adoptCopilotBlob(workspaceId: $wsId, copilotBlobKey: $key)
      }"#,
      "variables": { "wsId": workspace_id.to_string(), "key": copilot_key }
    }),
  )
  .await;

  assert!(resp.get("errors").is_none(), "adoptCopilotBlob failed: {resp}");
  let new_key = resp["data"]["adoptCopilotBlob"].as_str().expect("new_key");

  // INV-H09D-01: the blob must reside in the `blobs` table with status=completed.
  // Objects in the blobs table are owned by the workspace and must never be
  // touched by the copilot orphan-cleanup job (which only scans copilot/ storage).
  let count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM blobs WHERE workspace_id = $1 AND key = $2 AND status = 'completed' AND deleted_at IS NULL",
  )
  .bind(workspace_id)
  .bind(new_key)
  .fetch_one(&pool)
  .await
  .expect("count query");

  assert_eq!(
    count, 1,
    "INV-H09D-01: adopted blob must have exactly one completed, non-deleted row in blobs table"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}
