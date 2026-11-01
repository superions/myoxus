//! Integration tests for complex blob storage scenarios (multipart, range requests, redirects).
use crate::helpers;

use axum::{body::Body, http::Request};
use bytes::Bytes;
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::AdminService;
use myoxus_application::auth::AuthService;
use myoxus_application::doc::DocService;
use myoxus_application::ports::blob::BlobStatus;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::admin::SqlxAdminStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

async fn setup_app() -> (axum::Router, Arc<ApiState>, PgPool) {
  let pool = helpers::setup_pool().await;

  let config = AppConfig::load().expect("AppConfig::load failed");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));

  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("StorageAdapter::new_fs failed"));

  let auth_service = AuthService::new(
    auth_store,
    Arc::new(myoxus_infrastructure::mail::LogMailAdapter),
    storage.clone(),
    3600,
    3600,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let blob_service = Arc::new(BlobService::new(
    blob_store,
    storage.clone(),
    "test-sign-key".to_string(),
  ));

  let state = Arc::new(ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  ));
  (build_router((*state).clone()), state, pool)
}

#[tokio::test]
// INV: blob upload creates a metadata row; download returns the correct bytes; HMAC presign URL resolves
async fn inv_blob_lifecycle_hmac_and_status_correct() {
  let (_app, state, pool) = setup_app().await;

  // 1. Setup User and Workspace
  let admin = state
    .auth()
    .store
    .fulfill_user("storage_admin@example.com", Some("Storage Admin"), None)
    .await
    .expect("test setup");
  let ws = state
    .workspace()
    .create_workspace(admin.id, None, None)
    .await
    .expect("create_workspace failed");
  let ws_id = ws.id;

  let blob_key = "test-file.txt";
  let content = Bytes::from("Hello Hardened Storage");
  let mime = "text/plain";

  // 2. Initialize Metadata
  let meta = state
    .blob()
    .initialize_upload(ws_id, blob_key, content.len() as u64, mime)
    .await
    .expect("test setup");
  assert_eq!(meta.status, BlobStatus::Pending);
  assert_eq!(meta.workspace_id, ws_id);
  assert_eq!(meta.key, blob_key);
  assert!(meta.blob_id != uuid::Uuid::nil());
  assert_eq!(meta.checksum, None);

  // 2. Generate and Verify HMAC Token (Parity with Legacy)
  let exp = chrono::Utc::now().timestamp() + 3600;
  let token = state
    .blob()
    .sign_upload("/upload", &[&ws_id.to_string(), blob_key], exp);

  assert!(
    state
      .blob()
      .verify_token("/upload", &[&ws_id.to_string(), blob_key], &token)
  );
  assert!(
    !state
      .blob()
      .verify_token("/upload", &[&ws_id.to_string(), "wrong-key"], &token)
  );

  // 3. Write Blob (Simulating Proxy Controller success)
  state
    .storage()
    .write_blob(myoxus_application::ports::BlobWriteRequest {
      key: format!("{}/{}", ws_id, blob_key),
      body: content.clone(),
      content_type: Some(mime.to_string()),
    })
    .await
    .expect("test setup");

  // 4. Complete Upload
  state
    .blob()
    .complete_upload(ws_id, blob_key)
    .await
    .expect("complete_upload failed");

  // 5. Verify and Read
  let read_res = state.blob().get_blob(ws_id, blob_key).await.expect("get_blob failed");
  assert_eq!(read_res.data, content);

  helpers::cleanup_users(&pool, &[admin.id]).await;
}

#[tokio::test]
// INV: blob download endpoint respects range headers and returns correct Content-Type
async fn inv_blob_download_range_and_headers_correct() {
  let (app, state, pool) = setup_app().await;

  let owner = state
    .auth()
    .store
    .fulfill_user("download_owner@example.com", Some("Download Owner"), None)
    .await
    .expect("test setup");
  let session = state
    .auth()
    .store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: owner.id,
      csrf_token: "csrf-download".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("test setup");

  let workspace = state
    .workspace()
    .create_workspace(owner.id, None, None)
    .await
    .expect("create_workspace failed");
  let key = "folder/download.txt";
  let payload = Bytes::from_static(b"Hello Download Endpoint");

  state
    .blob()
    .initialize_upload(workspace.id, key, payload.len() as u64, "text/plain")
    .await
    .expect("test setup");
  state
    .storage()
    .write_blob(myoxus_application::ports::BlobWriteRequest {
      key: format!("{}/{}", workspace.id, key),
      content_type: Some("text/plain".to_string()),
      body: payload.clone(),
    })
    .await
    .expect("test setup");
  state
    .blob()
    .complete_upload(workspace.id, key)
    .await
    .expect("complete_upload failed");

  let full = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/workspaces/{}/blobs/{}", workspace.id, key))
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::empty())
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  assert_eq!(full.status(), axum::http::StatusCode::OK);
  assert_eq!(
    full
      .headers()
      .get("content-disposition")
      .expect("download response must include content disposition")
      .to_str()
      .expect("content disposition header must be UTF-8"),
    "attachment; filename=\"download.txt\""
  );
  assert_eq!(
    full
      .headers()
      .get("cache-control")
      .expect("download response must include cache-control")
      .to_str()
      .expect("cache-control header must be UTF-8"),
    "private, max-age=3600"
  );
  let full_body = full
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  assert_eq!(full_body, payload);

  let ranged = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/workspaces/{}/blobs/{}", workspace.id, key))
        .header("cookie", format!("affine_session={}", session.id))
        .header("range", "bytes=0-4")
        .body(Body::empty())
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  assert_eq!(ranged.status(), axum::http::StatusCode::PARTIAL_CONTENT);
  assert_eq!(
    ranged
      .headers()
      .get("content-range")
      .expect("ranged response must include content-range")
      .to_str()
      .expect("content-range header must be UTF-8"),
    "bytes 0-4/23"
  );
  let ranged_body = ranged
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  assert_eq!(ranged_body, Bytes::from_static(b"Hello"));

  helpers::cleanup_users(&pool, &[owner.id]).await;
}

#[tokio::test]
// INV: uploading a comment attachment creates a blob_metadata row bound to the workspace
async fn inv_upload_comment_attachment_binds_blob_record() {
  let (app, state, pool) = setup_app().await;

  let owner = state
    .auth()
    .store
    .fulfill_user("comment_owner@example.com", Some("Comment Owner"), None)
    .await
    .expect("test setup");
  state
    .auth()
    .store
    .set_email_verified(owner.id, chrono::Utc::now())
    .await
    .expect("verify comment attachment owner");
  let session = state
    .auth()
    .store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: owner.id,
      csrf_token: "csrf-comment".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("test setup");

  let workspace = state
    .workspace()
    .create_workspace(owner.id, None, None)
    .await
    .expect("create_workspace failed");
  let doc = state
    .doc()
    .create_page(workspace.id, owner.id, Some("Attachment Doc".to_string()))
    .await
    .expect("test setup");

  let payload = b"comment attachment payload";
  let boundary = "X-BOUNDARY-COMMENT-ATTACH";
  let operations = serde_json::json!({
        "query": "mutation UploadCommentAttachment($workspaceId: String!, $docId: String!, $attachment: Upload!) { uploadCommentAttachment(workspaceId: $workspaceId, docId: $docId, attachment: $attachment) }",
        "variables": {
            "workspaceId": workspace.id.to_string(),
            "docId": doc.id.to_string(),
            "attachment": null
        }
    })
    .to_string();
  let map = serde_json::json!({ "0": ["variables.attachment"] }).to_string();

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
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"0\"; filename=\"comment.txt\"\r\n");
  body.extend_from_slice(b"Content-Type: text/plain\r\n\r\n");
  body.extend_from_slice(payload);
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(body))
        .expect("test setup"),
    )
    .await
    .expect("test setup");

  let json: serde_json::Value = serde_json::from_slice(
    &response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes(),
  )
  .expect("JSON parse failed");
  assert!(json.get("errors").is_none(), "unexpected graphql errors: {json}");
  let key = json["data"]["uploadCommentAttachment"]
    .as_str()
    .expect("expected JSON string field")
    .to_string();

  let stored_blob = state
    .blob()
    .get_blob(workspace.id, &key)
    .await
    .expect("get_blob failed");
  assert_eq!(stored_blob.data, Bytes::copy_from_slice(payload));

  let bound_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM comment_attachments WHERE workspace_id = $1 AND doc_id = $2 AND storage_key = $3",
  )
  .bind(workspace.id)
  .bind(doc.id)
  .bind(&key)
  .fetch_one(&pool)
  .await
  .expect("test setup");
  assert_eq!(bound_count, 1);

  helpers::cleanup_users(&pool, &[owner.id]).await;
}

#[tokio::test]
// INV: blob soft-delete sets deleted_at; retention GC is idempotent and does not fail on second run
async fn inv_blob_soft_delete_and_retention_gc_are_idempotent() {
  let (_app, state, pool) = setup_app().await;

  let owner = state
    .auth()
    .store
    .fulfill_user("gc_owner@example.com", Some("GC Owner"), None)
    .await
    .expect("test setup");
  let workspace = state
    .workspace()
    .create_workspace(owner.id, None, None)
    .await
    .expect("create_workspace failed");
  let key = "retention/old.bin";
  let payload = Bytes::from_static(b"retention-gc-payload");

  state
    .blob()
    .initialize_upload(workspace.id, key, payload.len() as u64, "application/octet-stream")
    .await
    .expect("test setup");
  state
    .storage()
    .write_blob(myoxus_application::ports::BlobWriteRequest {
      key: format!("{}/{}", workspace.id, key),
      content_type: Some("application/octet-stream".to_string()),
      body: payload,
    })
    .await
    .expect("test setup");
  state
    .blob()
    .complete_upload(workspace.id, key)
    .await
    .expect("complete_upload failed");

  // The retention query is intentionally global. Keep this invariant test on
  // an isolated historical cutoff so unrelated soft-delete fixtures cannot
  // alter its candidate count when the integration binary runs in parallel.
  let retention_cutoff = chrono::Utc::now() - chrono::Duration::days(36_500);
  let delete_at = retention_cutoff - chrono::Duration::hours(1);
  let first_soft_delete = state
    .blob()
    .soft_delete_blob(workspace.id, key, delete_at)
    .await
    .expect("test setup");
  let second_soft_delete = state
    .blob()
    .soft_delete_blob(workspace.id, key, delete_at)
    .await
    .expect("test setup");
  assert!(first_soft_delete);
  assert!(second_soft_delete);

  let metadata_after_delete = state
    .blob()
    .get_blob_metadata(workspace.id, key)
    .await
    .expect("get_blob_metadata failed");
  assert!(
    metadata_after_delete.is_none(),
    "soft-deleted blobs must be hidden from active metadata reads"
  );

  let candidates = state
    .blob()
    .list_blob_gc_candidates(retention_cutoff, 10)
    .await
    .expect("test setup");
  assert_eq!(candidates.len(), 1);
  assert_eq!(candidates[0].workspace_id, workspace.id);
  assert_eq!(candidates[0].key, key);

  let purged = state
    .blob()
    .purge_retained_deleted_blobs(retention_cutoff, 10)
    .await
    .expect("test setup");
  assert_eq!(purged, 1);

  let purged_again = state
    .blob()
    .purge_retained_deleted_blobs(retention_cutoff, 10)
    .await
    .expect("test setup");
  assert_eq!(purged_again, 0, "second purge pass must be idempotent");

  let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blobs WHERE workspace_id = $1 AND key = $2")
    .bind(workspace.id)
    .bind(key)
    .fetch_one(&pool)
    .await
    .expect("test setup");
  assert_eq!(remaining, 0);

  helpers::cleanup_users(&pool, &[owner.id]).await;
}

#[tokio::test]
// INV: createComment can link pre-uploaded attachment keys to a comment row in DB
async fn inv_create_comment_can_link_uploaded_attachment_keys() {
  let (app, state, pool) = setup_app().await;

  let owner = state
    .auth()
    .store
    .fulfill_user("comment_link_owner@example.com", Some("Comment Link Owner"), None)
    .await
    .expect("test setup");
  state
    .auth()
    .store
    .set_email_verified(owner.id, chrono::Utc::now())
    .await
    .expect("verify comment link owner");
  let session = state
    .auth()
    .store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: owner.id,
      csrf_token: "csrf-comment-link".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("test setup");

  let workspace = state
    .workspace()
    .create_workspace(owner.id, None, None)
    .await
    .expect("create_workspace failed");
  let doc = state
    .doc()
    .create_page(workspace.id, owner.id, Some("Attachment Link Doc".to_string()))
    .await
    .expect("test setup");

  let payload = b"attachment-for-comment-link";
  let boundary = "X-BOUNDARY-COMMENT-LINK-ATTACH";
  let operations = serde_json::json!({
        "query": "mutation UploadCommentAttachment($workspaceId: String!, $docId: String!, $attachment: Upload!) { uploadCommentAttachment(workspaceId: $workspaceId, docId: $docId, attachment: $attachment) }",
        "variables": {
            "workspaceId": workspace.id.to_string(),
            "docId": doc.id.to_string(),
            "attachment": null
        }
    })
    .to_string();
  let map = serde_json::json!({ "0": ["variables.attachment"] }).to_string();

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
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"0\"; filename=\"comment-link.txt\"\r\n");
  body.extend_from_slice(b"Content-Type: text/plain\r\n\r\n");
  body.extend_from_slice(payload);
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

  let upload_response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(body))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let upload_json: serde_json::Value = serde_json::from_slice(
    &upload_response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes(),
  )
  .expect("JSON parse failed");
  assert!(
    upload_json.get("errors").is_none(),
    "unexpected graphql errors: {upload_json}"
  );
  let attachment_key = upload_json["data"]["uploadCommentAttachment"]
    .as_str()
    .expect("test setup")
    .to_string();

  let create_comment_payload = serde_json::json!({
      "query": "mutation CreateComment($workspaceId: String!, $docId: String!, $body: JSON!, $attachmentKeys: [String!]) { createComment(workspaceId: $workspaceId, docId: $docId, body: $body, attachmentKeys: $attachmentKeys) { id } }",
      "variables": {
          "workspaceId": workspace.id.to_string(),
          "docId": doc.id.to_string(),
          "body": { "text": "comment with attachment" },
          "attachmentKeys": [attachment_key]
      }
  });

  let create_comment_response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(create_comment_payload.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let create_comment_json: serde_json::Value = serde_json::from_slice(
    &create_comment_response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes(),
  )
  .expect("JSON parse failed");
  assert!(
    create_comment_json.get("errors").is_none(),
    "unexpected graphql errors: {create_comment_json}"
  );
  let comment_id = uuid::Uuid::parse_str(
    create_comment_json["data"]["createComment"]["id"]
      .as_str()
      .expect("expected JSON string field"),
  )
  .expect("UUID parse failed");

  let linked_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM comment_attachments WHERE workspace_id = $1 AND doc_id = $2 AND storage_key = $3 AND comment_id = $4"
    )
    .bind(workspace.id)
    .bind(doc.id)
    .bind(
        create_comment_payload["variables"]["attachmentKeys"][0]
            .as_str()
            .expect("test setup"),
    )
    .bind(comment_id)
    .fetch_one(&pool)
    .await
    .expect("test setup");
  assert_eq!(linked_count, 1);

  helpers::cleanup_users(&pool, &[owner.id]).await;
}
