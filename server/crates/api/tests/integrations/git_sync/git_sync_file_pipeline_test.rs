//! Git Sync file pipeline integration tests.
//!
//! Tests the file-level sync pipeline: MIME policy enforcement via API,
//! file binding CRUD, file baseline CRUD, version link creation, and
//! file conflict persistence. Requires TEST_DATABASE_URL.

use crate::helpers;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::body::Body;
use axum::http::Request;
use bytes::Bytes;
use http_body_util::BodyExt;
use myoxus_api::git_sync_engine::conflicts::resolve_file_conflict_with_prepared_git_repo;
use myoxus_api::git_sync_engine::executor::{cleanup_file_promotions, execute_file_myoxus_actions_durable};
use myoxus_application::git_sync::backend::{
  ChangedFile, GitAuth, GitError, GitPushReceipt, GitRemoteRefStatus, GitRepositoryPort,
};
use myoxus_application::git_sync::file_reconcile::{FileReconcileAction, blob_key_for_content, blob_key_for_repo_path};
use myoxus_application::ports::{
  BlobReadResponse, BlobStoragePort, BlobWriteRequest, MultipartCompleteRequest, MultipartCreateRequest,
  MultipartCreateResponse, MultipartPartUrlRequest, MultipartPartUrlResponse, PortError, PortResult,
};
use myoxus_domain::git_sync::{
  AuthMethod, ConflictResolution, GitSyncFileConflict, GitSyncProfile, SyncDirection, TriggerMode,
};
use myoxus_infrastructure::git_sync::SqlxGitSyncStore;
use serde_json::json;
use sqlx::Row;
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Default)]
struct FileConflictGitRepo {
  files: HashMap<String, Vec<u8>>,
}

#[async_trait]
impl GitRepositoryPort for FileConflictGitRepo {
  async fn probe_remote(
    &self,
    _url: &str,
    branch: Option<&str>,
    _auth: &GitAuth,
  ) -> Result<myoxus_application::git_sync::GitRemoteProbe, GitError> {
    Ok(myoxus_application::git_sync::GitRemoteProbe {
      branch: branch.map(str::to_string),
      observed_remote_oid: branch.map(|_| "abcdef".repeat(7)[..40].to_string()),
    })
  }

  async fn clone_repo(&self, _url: &str, _path: &Path, _branch: &str, _auth: &GitAuth) -> Result<(), GitError> {
    Ok(())
  }

  async fn open_repo(&self, _path: &Path) -> Result<(), GitError> {
    Ok(())
  }

  async fn fetch(&self, _auth: &GitAuth) -> Result<(), GitError> {
    Ok(())
  }

  async fn checkout_branch(&self, _branch: &str) -> Result<(), GitError> {
    Ok(())
  }

  async fn reset_to_remote(&self, _branch: &str) -> Result<String, GitError> {
    self.head_oid().await
  }

  async fn head_oid(&self) -> Result<String, GitError> {
    Ok("abcdef".repeat(7)[..40].to_string())
  }

  async fn remote_branch_oid(&self, _branch: &str, _auth: &GitAuth) -> Result<String, GitError> {
    self.head_oid().await
  }

  async fn changed_files(&self, _from: Option<&str>, _to: Option<&str>) -> Result<Vec<ChangedFile>, GitError> {
    Ok(Vec::new())
  }

  async fn read_file(&self, path: &str) -> Result<Vec<u8>, GitError> {
    self
      .files
      .get(path)
      .cloned()
      .ok_or_else(|| GitError::NotFound(path.to_string()))
  }

  async fn write_file(&self, _path: &str, _content: &[u8]) -> Result<(), GitError> {
    Ok(())
  }

  async fn delete_file(&self, _path: &str) -> Result<(), GitError> {
    Ok(())
  }

  async fn rename_file(&self, _from: &str, _to: &str) -> Result<(), GitError> {
    Ok(())
  }

  async fn commit(&self, _message: &str, _author_name: &str, _author_email: &str) -> Result<String, GitError> {
    Ok("abcdef".repeat(7)[..40].to_string())
  }

  async fn push(&self, branch: &str, intended_oid: &str, _auth: &GitAuth) -> Result<GitPushReceipt, GitError> {
    Ok(GitPushReceipt {
      branch: branch.to_string(),
      local_commit_oid: intended_oid.to_string(),
      remote_ref_status: GitRemoteRefStatus::Updated,
      observed_remote_oid: intended_oid.to_string(),
    })
  }
}

#[derive(Clone, Default)]
struct FileConflictBlobStorage {
  blobs: Arc<Mutex<HashMap<String, Bytes>>>,
}

impl FileConflictBlobStorage {
  fn get(&self, key: &str) -> Option<Bytes> {
    self.blobs.lock().expect("blob lock").get(key).cloned()
  }
}

#[async_trait]
impl BlobStoragePort for FileConflictBlobStorage {
  async fn write_blob(&self, req: BlobWriteRequest) -> PortResult<()> {
    self.blobs.lock().expect("blob lock").insert(req.key, req.body);
    Ok(())
  }

  async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
    let data = self.get(key).ok_or_else(|| PortError::NotFound(key.to_string()))?;
    Ok(BlobReadResponse {
      key: key.to_string(),
      content_type: Some("application/octet-stream".to_string()),
      content_length: data.len() as u64,
      data,
      last_modified: None,
    })
  }

  async fn delete_blob(&self, key: &str) -> PortResult<()> {
    self.blobs.lock().expect("blob lock").remove(key);
    Ok(())
  }

  async fn put_avatar(&self, _key: &str, _data: Bytes, _content_type: &str) -> PortResult<String> {
    Err(PortError::InvalidInput(
      "avatar storage is not part of this test".into(),
    ))
  }

  async fn get_avatar(&self, key: &str) -> PortResult<BlobReadResponse> {
    self.read_blob(key).await
  }

  async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }

  async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
    Err(PortError::InvalidInput(
      "multipart upload is not part of this test".into(),
    ))
  }

  async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
    Err(PortError::InvalidInput(
      "multipart upload is not part of this test".into(),
    ))
  }

  async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
    Err(PortError::InvalidInput(
      "multipart upload is not part of this test".into(),
    ))
  }

  async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
    Ok(())
  }
}

#[tokio::test]
async fn pulled_file_objects_are_staged_and_rollback_only_removes_new_objects() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (workspace_id, profile_id) = seed_profile(&pool, admin_id).await;
  let store = SqlxGitSyncStore::new(pool.clone());
  let storage = FileConflictBlobStorage::default();
  let repo = FileConflictGitRepo::default();
  let bytes = b"content-addressed git asset".to_vec();
  let content_hash = myoxus_application::markdown::content_hash(std::str::from_utf8(&bytes).expect("fixture is UTF-8"));
  let final_key = format!("{workspace_id}/{}", blob_key_for_content(profile_id, &content_hash));
  let action = FileReconcileAction::PullToMyoxus {
    repo_path: "assets/logo.bin".to_string(),
    content_hash,
    bytes: bytes.clone(),
    mime_type: "application/octet-stream".to_string(),
  };

  let first_run_id = seed_running_run(&pool, profile_id).await;
  let first = execute_file_myoxus_actions_durable(
    std::slice::from_ref(&action),
    &repo,
    &storage,
    workspace_id,
    profile_id,
    &store,
    first_run_id,
  )
  .await;
  assert!(
    first.errors.is_empty(),
    "first pull must stage and promote: {:?}",
    first.errors
  );
  assert_eq!(first.pulled.len(), 1);
  assert!(first.pulled[0].newly_promoted);
  assert_eq!(storage.get(&final_key).as_deref(), Some(bytes.as_slice()));
  let first_stage = first.pulled[0]
    .stage_key
    .as_deref()
    .expect("durable execution must retain a stage until DB outcome");
  assert!(
    storage.get(first_stage).is_some(),
    "durable execution must retain its recoverable stage"
  );
  let ledger: (Option<bool>, bool) = sqlx::query_as(
    "SELECT newly_promoted, db_committed
     FROM git_sync_blob_promotions WHERE run_id = $1",
  )
  .bind(first_run_id)
  .fetch_one(&pool)
  .await
  .expect("durable promotion ledger");
  assert_eq!(ledger, (Some(true), false));

  cleanup_file_promotions(&store, &storage, &first.pulled, false)
    .await
    .expect("rollback cleanup");
  assert!(
    storage.get(&final_key).is_none(),
    "rollback must remove the uncommitted object"
  );
  assert!(storage.get(first_stage).is_none(), "rollback must remove the stage");
  let first_ledger_exists: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_blob_promotions WHERE run_id = $1)")
      .bind(first_run_id)
      .fetch_one(&pool)
      .await
      .expect("ledger rollback check");
  assert!(!first_ledger_exists);

  storage
    .write_blob(BlobWriteRequest {
      key: final_key.clone(),
      content_type: Some("application/octet-stream".to_string()),
      body: Bytes::copy_from_slice(&bytes),
    })
    .await
    .expect("seed committed object");
  let second = execute_file_myoxus_actions_durable(
    std::slice::from_ref(&action),
    &repo,
    &storage,
    workspace_id,
    profile_id,
    &store,
    first_run_id,
  )
  .await;
  assert!(second.errors.is_empty());
  assert!(!second.pulled[0].newly_promoted);
  cleanup_file_promotions(&store, &storage, &second.pulled, false)
    .await
    .expect("rollback cleanup must ignore existing object");
  assert_eq!(
    storage.get(&final_key).as_deref(),
    Some(bytes.as_slice()),
    "rollback must preserve an object that existed before this run"
  );

  // A normal upload can acquire a newly promoted object after the failed SQL
  // attempt releases its locks. Compensation must recheck current normal
  // metadata rather than trusting the attempt's earlier ownership receipt.
  storage
    .delete_blob(&final_key)
    .await
    .expect("remove this fixture's retained object");
  let concurrent = execute_file_myoxus_actions_durable(
    &[action],
    &repo,
    &storage,
    workspace_id,
    profile_id,
    &store,
    first_run_id,
  )
  .await;
  assert!(concurrent.errors.is_empty());
  assert!(concurrent.pulled[0].newly_promoted);
  let blob_key = concurrent.pulled[0].blob_key.clone();
  let blobs = myoxus_application::ports::blob_service::BlobService::new(
    Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone())),
    Arc::new(storage.clone()),
    "fixture-key".into(),
  );
  blobs
    .upload_single_part_blob(
      workspace_id,
      &blob_key,
      Bytes::copy_from_slice(&bytes),
      "application/octet-stream",
      Some("application/octet-stream".into()),
      None,
    )
    .await
    .expect("concurrent normal upload takes ownership");
  cleanup_file_promotions(&store, &storage, &concurrent.pulled, false)
    .await
    .expect("reference-aware rollback cleanup");
  assert_eq!(
    blobs
      .get_blob(workspace_id, &blob_key)
      .await
      .expect("normal owner remains readable")
      .data
      .as_ref(),
    bytes.as_slice()
  );
  assert!(storage.get(concurrent.pulled[0].stage_key.as_ref().unwrap()).is_none());
  sqlx::query("DELETE FROM blobs WHERE workspace_id=$1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup fixture's normal blob metadata");
  sqlx::query("DELETE FROM workspace_storage_stats WHERE workspace_id=$1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup fixture's normal accounting");

  cleanup(&pool, workspace_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

async fn seed_running_run(pool: &sqlx::PgPool, profile_id: Uuid) -> Uuid {
  let run_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_runs
       (id, profile_id, direction, trigger_source, status, started_at, job_id)
     VALUES ($1, $2, 'GitToMyoxus', 'Manual', 'Running', now(), $3)",
  )
  .bind(run_id)
  .bind(profile_id)
  .bind(format!("git-sync-{run_id}"))
  .execute(pool)
  .await
  .expect("running Git-Sync run");
  run_id
}

/// Helper: create a workspace + git sync profile directly in DB.
async fn seed_profile(pool: &sqlx::PgPool, admin_id: Uuid) -> (Uuid, Uuid) {
  let ws_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name, public) VALUES ($1, $2, 'FilePipelineTest', false)")
    .bind(ws_id)
    .bind(admin_id)
    .execute(pool)
    .await
    .expect("create workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Owner', 'Accepted', now())
     ON CONFLICT (workspace_id, user_id) DO NOTHING",
  )
  .bind(ws_id)
  .bind(admin_id)
  .execute(pool)
  .await
  .expect("create workspace membership");

  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://example.com/repo.git', 'main', 'content/', 'Bidirectional', 'Manual', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(ws_id)
  .bind(admin_id)
  .execute(pool)
  .await
  .expect("create profile");

  (ws_id, profile_id)
}

/// Helper: create a sync run for a profile (needed for version links and file conflicts).
async fn seed_run(pool: &sqlx::PgPool, profile_id: Uuid) -> Uuid {
  let run_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_runs (id, profile_id, direction, status)
     VALUES ($1, $2, 'Bidirectional', 'Pending')",
  )
  .bind(run_id)
  .bind(profile_id)
  .execute(pool)
  .await
  .expect("create run");
  run_id
}

/// Helper: cleanup test data.
async fn cleanup(pool: &sqlx::PgPool, ws_id: Uuid, _admin_id: Uuid) {
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .expect("cleanup owned Git fixture workspace");
}

// ─── Helper: build multipart form body for ZIP upload ────────────────────

fn build_zip_upload_body(ws_id: Uuid, boundary: &str) -> Vec<u8> {
  let zip_bytes: Vec<u8> = vec![0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00];
  let operations = json!({
    "query": "mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }",
    "variables": { "workspaceId": ws_id.to_string(), "blob": null }
  }).to_string();
  let map = json!({ "0": ["variables.blob"] }).to_string();

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
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"0\"; filename=\"test.zip\"\r\n");
  body.extend_from_slice(b"Content-Type: application/zip\r\n\r\n");
  body.extend_from_slice(&zip_bytes);
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
  body
}

/// Helper: set MIME policy config in app_configs (cleanup + insert).
async fn set_mime_config(pool: &sqlx::PgPool, mode: &str) {
  sqlx::query("DELETE FROM app_configs WHERE id LIKE 'git_sync.mime%'")
    .execute(pool)
    .await
    .ok();
  sqlx::query("INSERT INTO app_configs (id, value) VALUES ('git_sync.mime_blocklist_admin', $1)")
    .bind(serde_json::json!(["application/zip"]))
    .execute(pool)
    .await
    .expect("set blocklist config");
  sqlx::query("INSERT INTO app_configs (id, value) VALUES ('git_sync.mime_validation_mode', $1)")
    .bind(serde_json::json!(mode))
    .execute(pool)
    .await
    .expect("set mode config");
}

async fn upload_zip(app: &axum::Router, ws_id: Uuid, session_id: Uuid) -> serde_json::Value {
  let boundary = "X-BOUNDARY-MIME-TEST";
  let body = build_zip_upload_body(ws_id, boundary);
  let resp = app
    .clone()
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(axum::body::Body::from(body))
        .expect("request"),
    )
    .await
    .expect("response");
  let resp_bytes = http_body_util::BodyExt::collect(resp.into_body())
    .await
    .expect("body")
    .to_bytes();
  serde_json::from_slice(&resp_bytes).expect("json")
}

// ─── Tests 1+2: MIME policy strict rejects, warn allows (sequential) ────
//
// These two scenarios share global `app_configs` rows and must not run in
// parallel with each other. Combined into one test function to avoid races.

#[tokio::test]
async fn mime_policy_strict_rejects_and_warn_allows_zip_upload() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let pool = helpers::setup_pool().await;
  set_mime_config(&pool, "strict").await;
  let (mut app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let ws_id = helpers::create_workspace(&pool, admin_id).await;

  // ── Phase 1: strict mode blocks ZIP ──
  let result = upload_zip(&app, ws_id, session_id).await;
  assert!(
    result.get("errors").is_some(),
    "ZIP upload must be rejected in strict mode, got: {result}"
  );
  let error_msg = result["errors"][0]["message"].as_str().unwrap_or("");
  assert!(
    error_msg.contains("blocklisted") || error_msg.contains("MIME"),
    "error must mention MIME policy, got: {error_msg}"
  );

  // ── Phase 2: warn mode allows ZIP ──
  set_mime_config(&pool, "warn").await;
  let (warn_app, _, _) = helpers::setup_app_with_pool(pool.clone()).await;
  app = warn_app;

  let result = upload_zip(&app, ws_id, session_id).await;
  assert!(
    result.get("errors").is_none(),
    "ZIP upload must succeed in warn mode, got: {result}"
  );
  assert!(
    result["data"]["setBlob"].is_string(),
    "setBlob must return the blob key, got: {result}"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id LIKE 'git_sync.mime%'")
    .execute(&pool)
    .await
    .ok();
  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Test 3: File binding CRUD ──────────────────────────────────────────

#[tokio::test]
async fn file_binding_crud_insert_read_tombstone() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;

  let binding_id = Uuid::new_v4();
  let repo_path = "assets/image.png";

  // Insert a file binding
  sqlx::query(
    "INSERT INTO git_sync_file_bindings (id, profile_id, workspace_id, blob_key, repo_path, content_hash, mime_type, file_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
  )
  .bind(binding_id)
  .bind(profile_id)
  .bind(ws_id)
  .bind("blob-key-abc123")
  .bind(repo_path)
  .bind("sha256:deadbeef")
  .bind("image/png")
  .bind(4096_i64)
  .execute(&pool)
  .await
  .expect("insert file binding");

  // Read back via non-tombstoned query (same pattern as store method)
  let rows: Vec<sqlx::postgres::PgRow> = sqlx::query(
    "SELECT id, blob_key, repo_path, content_hash, mime_type, file_size, tombstoned
     FROM git_sync_file_bindings WHERE profile_id = $1 AND tombstoned = false",
  )
  .bind(profile_id)
  .fetch_all(&pool)
  .await
  .expect("read file bindings");

  assert_eq!(rows.len(), 1, "exactly one active file binding must exist");
  assert_eq!(rows[0].get::<String, _>("blob_key"), "blob-key-abc123");
  assert_eq!(rows[0].get::<String, _>("repo_path"), repo_path);
  assert_eq!(rows[0].get::<String, _>("content_hash"), "sha256:deadbeef");
  assert_eq!(rows[0].get::<String, _>("mime_type"), "image/png");
  assert_eq!(rows[0].get::<i64, _>("file_size"), 4096);

  // Tombstone the binding
  let affected = sqlx::query(
    "UPDATE git_sync_file_bindings SET tombstoned = true, updated_at = now()
     WHERE profile_id = $1 AND repo_path = $2 AND tombstoned = false",
  )
  .bind(profile_id)
  .bind(repo_path)
  .execute(&pool)
  .await
  .expect("tombstone file binding")
  .rows_affected();
  assert_eq!(affected, 1, "tombstone must affect exactly one row");

  // Verify it no longer appears in non-tombstoned query
  let after: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::bigint FROM git_sync_file_bindings WHERE profile_id = $1 AND tombstoned = false",
  )
  .bind(profile_id)
  .fetch_one(&pool)
  .await
  .expect("fetch git sync row");
  assert_eq!(after, 0, "tombstoned binding must not appear in active query");

  // Verify the row still physically exists
  let total: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_file_bindings WHERE id = $1")
    .bind(binding_id)
    .fetch_one(&pool)
    .await
    .expect("fetch git sync row");
  assert_eq!(total, 1, "tombstoned row must still exist in DB");

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Test 4: File baseline CRUD ─────────────────────────────────────────

#[tokio::test]
async fn file_baseline_crud_insert_upsert_delete() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;

  let baseline_id = Uuid::new_v4();
  let blob_key = "blob-key-baseline-test";

  // Insert a file baseline
  sqlx::query(
    "INSERT INTO git_sync_file_baselines (id, profile_id, blob_key, content_hash, commit_oid)
     VALUES ($1, $2, $3, $4, $5)",
  )
  .bind(baseline_id)
  .bind(profile_id)
  .bind(blob_key)
  .bind("sha256:initial")
  .bind("abc123def")
  .execute(&pool)
  .await
  .expect("insert file baseline");

  // Read back
  let rows: Vec<sqlx::postgres::PgRow> =
    sqlx::query("SELECT id, blob_key, content_hash, commit_oid FROM git_sync_file_baselines WHERE profile_id = $1")
      .bind(profile_id)
      .fetch_all(&pool)
      .await
      .expect("read file baselines");

  assert_eq!(rows.len(), 1, "exactly one file baseline must exist");
  assert_eq!(rows[0].get::<String, _>("content_hash"), "sha256:initial");
  assert_eq!(
    rows[0].get::<Option<String>, _>("commit_oid"),
    Some("abc123def".to_string())
  );

  // Upsert with a new content_hash (ON CONFLICT profile_id, blob_key)
  sqlx::query(
    "INSERT INTO git_sync_file_baselines (id, profile_id, blob_key, content_hash, commit_oid)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (profile_id, blob_key) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       commit_oid = EXCLUDED.commit_oid,
       synced_at = now()",
  )
  .bind(Uuid::new_v4()) // new id (ignored on conflict)
  .bind(profile_id)
  .bind(blob_key)
  .bind("sha256:updated")
  .bind("def456ghi")
  .execute(&pool)
  .await
  .expect("upsert file baseline");

  // Verify the hash is updated
  let updated_hash: String =
    sqlx::query_scalar("SELECT content_hash FROM git_sync_file_baselines WHERE profile_id = $1 AND blob_key = $2")
      .bind(profile_id)
      .bind(blob_key)
      .fetch_one(&pool)
      .await
      .expect("read updated baseline");
  assert_eq!(
    updated_hash, "sha256:updated",
    "content_hash must be updated after upsert"
  );

  // Delete it
  let deleted = sqlx::query("DELETE FROM git_sync_file_baselines WHERE profile_id = $1 AND blob_key = $2")
    .bind(profile_id)
    .bind(blob_key)
    .execute(&pool)
    .await
    .expect("delete file baseline")
    .rows_affected();
  assert_eq!(deleted, 1, "delete must affect exactly one row");

  // Verify it's gone
  let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_file_baselines WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("fetch git sync row");
  assert_eq!(remaining, 0, "deleted baseline must be gone");

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Test 5: Version link creation and query ────────────────────────────

#[tokio::test]
async fn version_link_insert_and_query_by_run() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let run_id = seed_run(&pool, profile_id).await;

  let link_id = Uuid::new_v4();
  let history_id = Uuid::new_v4();

  // Insert a version link
  sqlx::query(
    "INSERT INTO git_sync_version_links
       (id, profile_id, run_id, sync_object_kind, sync_object_id, direction,
        git_commit_oid, myoxus_history_id, repo_path, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
  )
  .bind(link_id)
  .bind(profile_id)
  .bind(run_id)
  .bind("file")
  .bind("blob-key-version-test")
  .bind("push")
  .bind("abc123")
  .bind(history_id)
  .bind("assets/photo.jpg")
  .bind("sha256:linktest")
  .execute(&pool)
  .await
  .expect("insert version link");

  // Query by run
  let rows: Vec<sqlx::postgres::PgRow> = sqlx::query(
    "SELECT id, profile_id, run_id, sync_object_kind, sync_object_id,
            direction, git_commit_oid, myoxus_history_id, repo_path, content_hash
     FROM git_sync_version_links WHERE run_id = $1 ORDER BY created_at ASC",
  )
  .bind(run_id)
  .fetch_all(&pool)
  .await
  .expect("query version links");

  assert_eq!(rows.len(), 1, "exactly one version link must exist for this run");
  assert_eq!(rows[0].get::<Uuid, _>("id"), link_id);
  assert_eq!(rows[0].get::<Uuid, _>("profile_id"), profile_id);
  assert_eq!(rows[0].get::<Uuid, _>("run_id"), run_id);
  assert_eq!(rows[0].get::<String, _>("sync_object_kind"), "file");
  assert_eq!(rows[0].get::<String, _>("sync_object_id"), "blob-key-version-test");
  assert_eq!(rows[0].get::<String, _>("direction"), "push");
  assert_eq!(
    rows[0].get::<Option<String>, _>("git_commit_oid"),
    Some("abc123".to_string())
  );
  assert_eq!(rows[0].get::<Option<Uuid>, _>("myoxus_history_id"), Some(history_id));
  assert_eq!(rows[0].get::<String, _>("repo_path"), "assets/photo.jpg");
  assert_eq!(
    rows[0].get::<Option<String>, _>("content_hash"),
    Some("sha256:linktest".to_string())
  );

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Test 6: File conflict persistence ──────────────────────────────────

#[tokio::test]
async fn file_conflict_insert_and_query() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let run_id = seed_run(&pool, profile_id).await;

  let conflict_id = Uuid::new_v4();

  // Insert a file conflict
  sqlx::query(
    "INSERT INTO git_sync_file_conflicts
       (id, profile_id, run_id, repo_path, conflict_type, resolution,
        git_hash, myoxus_hash, baseline_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
  )
  .bind(conflict_id)
  .bind(profile_id)
  .bind(run_id)
  .bind("assets/logo.png")
  .bind("BothModified")
  .bind("Open")
  .bind("sha256:githash")
  .bind("sha256:myoxushash")
  .bind("sha256:baselinehash")
  .execute(&pool)
  .await
  .expect("insert file conflict");

  // Query it back
  let row = sqlx::query(
    "SELECT id, profile_id, run_id, repo_path, conflict_type, resolution,
            git_hash, myoxus_hash, baseline_hash
     FROM git_sync_file_conflicts WHERE id = $1",
  )
  .bind(conflict_id)
  .fetch_one(&pool)
  .await
  .expect("query file conflict");

  assert_eq!(row.get::<Uuid, _>("id"), conflict_id);
  assert_eq!(row.get::<Uuid, _>("profile_id"), profile_id);
  assert_eq!(row.get::<Uuid, _>("run_id"), run_id);
  assert_eq!(row.get::<String, _>("repo_path"), "assets/logo.png");
  assert_eq!(row.get::<String, _>("conflict_type"), "BothModified");
  assert_eq!(row.get::<String, _>("resolution"), "Open");
  assert_eq!(
    row.get::<Option<String>, _>("git_hash"),
    Some("sha256:githash".to_string())
  );
  assert_eq!(
    row.get::<Option<String>, _>("myoxus_hash"),
    Some("sha256:myoxushash".to_string())
  );
  assert_eq!(
    row.get::<Option<String>, _>("baseline_hash"),
    Some("sha256:baselinehash".to_string())
  );

  // Verify cascade: deleting the profile should cascade to file conflicts
  sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
    .bind(profile_id)
    .execute(&pool)
    .await
    .expect("delete profile");

  let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_file_conflicts WHERE id = $1")
    .bind(conflict_id)
    .fetch_one(&pool)
    .await
    .expect("fetch git sync row");
  assert_eq!(remaining, 0, "file conflict must be cascaded when profile is deleted");

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn graphql_file_conflicts_bindings_and_status_include_file_pipeline_state() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let run_id = seed_run(&pool, profile_id).await;
  let binding_id = Uuid::new_v4();
  let blob_key = "git-sync/test-profile/assets/logo.png";

  sqlx::query(
    "INSERT INTO git_sync_file_bindings
       (id, profile_id, workspace_id, blob_key, repo_path, content_hash, mime_type, file_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
  )
  .bind(binding_id)
  .bind(profile_id)
  .bind(ws_id)
  .bind(blob_key)
  .bind("assets/logo.png")
  .bind("sha256:file")
  .bind("image/png")
  .bind(128_i64)
  .execute(&pool)
  .await
  .expect("insert file binding");

  sqlx::query(
    "INSERT INTO git_sync_file_conflicts
       (id, profile_id, run_id, binding_id, blob_key, repo_path, conflict_type, resolution,
        git_hash, myoxus_hash, baseline_hash)
     VALUES ($1, $2, $3, $4, $5, $6, 'BothModified', 'Open', $7, $8, $9)",
  )
  .bind(Uuid::new_v4())
  .bind(profile_id)
  .bind(run_id)
  .bind(binding_id)
  .bind(blob_key)
  .bind("assets/logo.png")
  .bind("sha256:git")
  .bind("sha256:myoxus")
  .bind("sha256:base")
  .execute(&pool)
  .await
  .expect("insert file conflict");

  let primed_status = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query($workspaceId: String!) { workspace(id: $workspaceId) { gitSyncStatus { openFileConflicts openConflicts } } }",
      "variables": { "workspaceId": ws_id.to_string() }
    }),
  )
  .await;
  assert!(
    primed_status.get("errors").is_none(),
    "status priming query must succeed: {primed_status}"
  );
  assert_eq!(
    primed_status["data"]["workspace"]["gitSyncStatus"]["openFileConflicts"],
    1
  );

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        query($workspaceId: String!) {
          workspace(id: $workspaceId) {
            gitSyncStatus {
              openConflicts
              totalBindings
              openDocConflicts
              openFileConflicts
              totalDocBindings
              totalFileBindings
            }
            gitSyncFileConflicts {
              runId
              bindingId
              blobKey
              repoPath
              gitHash
              myoxusHash
              baselineHash
            }
            gitSyncFileBindings {
              id
              blobKey
              repoPath
              contentHash
              mimeType
              fileSize
              tombstoned
            }
          }
        }
      "#,
      "variables": { "workspaceId": ws_id.to_string() }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "file git-sync query must succeed: {resp}");
  let status = &resp["data"]["workspace"]["gitSyncStatus"];
  assert_eq!(status["openDocConflicts"], 0);
  assert_eq!(status["openFileConflicts"], 1);
  assert_eq!(status["openConflicts"], 1);
  assert_eq!(status["totalDocBindings"], 0);
  assert_eq!(status["totalFileBindings"], 1);
  assert_eq!(status["totalBindings"], 1);

  let conflicts = resp["data"]["workspace"]["gitSyncFileConflicts"]
    .as_array()
    .expect("file conflicts array");
  assert_eq!(conflicts.len(), 1);
  assert_eq!(
    conflicts[0]["bindingId"].as_str().expect("bindingId"),
    binding_id.to_string()
  );
  assert_eq!(conflicts[0]["blobKey"].as_str(), Some(blob_key));
  assert_eq!(conflicts[0]["repoPath"].as_str(), Some("assets/logo.png"));

  let bindings = resp["data"]["workspace"]["gitSyncFileBindings"]
    .as_array()
    .expect("file bindings array");
  assert_eq!(bindings.len(), 1);
  assert_eq!(bindings[0]["blobKey"].as_str(), Some(blob_key));
  assert_eq!(bindings[0]["mimeType"].as_str(), Some("image/png"));
  assert_eq!(bindings[0]["fileSize"].as_i64(), Some(128));

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn graphql_resolve_file_conflict_myoxus_wins_updates_baseline_and_status() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let run_id = seed_run(&pool, profile_id).await;
  let binding_id = Uuid::new_v4();
  let conflict_id = Uuid::new_v4();
  let blob_key = blob_key_for_repo_path(profile_id, "assets/myoxus-wins.png");

  sqlx::query(
    "INSERT INTO git_sync_file_bindings
       (id, profile_id, workspace_id, blob_key, repo_path, content_hash, mime_type, file_size)
     VALUES ($1, $2, $3, $4, 'assets/myoxus-wins.png', 'sha256:myoxus', 'image/png', 64)",
  )
  .bind(binding_id)
  .bind(profile_id)
  .bind(ws_id)
  .bind(&blob_key)
  .execute(&pool)
  .await
  .expect("insert file binding");
  sqlx::query(
    "INSERT INTO git_sync_file_conflicts
       (id, profile_id, run_id, binding_id, blob_key, repo_path, conflict_type, resolution,
        git_hash, myoxus_hash, baseline_hash)
     VALUES ($1, $2, $3, $4, $5, 'assets/myoxus-wins.png', 'BothModified', 'Open',
       'sha256:git', 'sha256:myoxus', 'sha256:base')",
  )
  .bind(conflict_id)
  .bind(profile_id)
  .bind(run_id)
  .bind(binding_id)
  .bind(&blob_key)
  .execute(&pool)
  .await
  .expect("insert file conflict");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        mutation($input: ResolveFileConflictInput!) {
          resolveGitSyncFileConflict(input: $input)
        }
      "#,
      "variables": {
        "input": {
          "conflictId": conflict_id.to_string(),
          "resolution": "MyoxusWins"
        }
      }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "resolve file conflict must succeed: {resp}"
  );
  assert_eq!(resp["data"]["resolveGitSyncFileConflict"], true);

  let marker: String = sqlx::query_scalar("SELECT resolution FROM git_sync_file_conflicts WHERE id = $1")
    .bind(conflict_id)
    .fetch_one(&pool)
    .await
    .expect("fetch file conflict marker");
  assert_eq!(marker, "MyoxusWins");
  let baseline_hash: String =
    sqlx::query_scalar("SELECT content_hash FROM git_sync_file_baselines WHERE profile_id = $1 AND blob_key = $2")
      .bind(profile_id)
      .bind(&blob_key)
      .fetch_one(&pool)
      .await
      .expect("fetch file baseline");
  assert_eq!(
    baseline_hash, "sha256:git",
    "baseline must track current Git state so the next sync pushes Myoxus"
  );

  let status = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query($workspaceId: String!) { workspace(id: $workspaceId) { gitSyncStatus { openFileConflicts openConflicts } } }",
      "variables": { "workspaceId": ws_id.to_string() }
    }),
  )
  .await;
  assert!(status.get("errors").is_none(), "status query must succeed: {status}");
  assert_eq!(status["data"]["workspace"]["gitSyncStatus"]["openFileConflicts"], 0);
  assert_eq!(status["data"]["workspace"]["gitSyncStatus"]["openConflicts"], 0);

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn graphql_resolve_file_conflict_rejects_manual_merge_without_mutating_marker() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let run_id = seed_run(&pool, profile_id).await;
  let conflict_id = Uuid::new_v4();

  sqlx::query(
    "INSERT INTO git_sync_file_conflicts
       (id, profile_id, run_id, repo_path, conflict_type, resolution,
        git_hash, myoxus_hash, baseline_hash)
     VALUES ($1, $2, $3, 'assets/manual-merge.png', 'BothModified', 'Open',
       'sha256:git', 'sha256:myoxus', 'sha256:base')",
  )
  .bind(conflict_id)
  .bind(profile_id)
  .bind(run_id)
  .execute(&pool)
  .await
  .expect("insert file conflict");

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        mutation($input: ResolveFileConflictInput!) {
          resolveGitSyncFileConflict(input: $input)
        }
      "#,
      "variables": {
        "input": {
          "conflictId": conflict_id.to_string(),
          "resolution": "ManualMerge"
        }
      }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_some(),
    "ManualMerge must be rejected for file conflicts: {resp}"
  );

  let marker: String = sqlx::query_scalar("SELECT resolution FROM git_sync_file_conflicts WHERE id = $1")
    .bind(conflict_id)
    .fetch_one(&pool)
    .await
    .expect("fetch file conflict marker");
  assert_eq!(marker, "Open", "rejected file resolution must not mutate marker");

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn file_conflict_git_wins_materializes_git_bytes_into_blob_binding_and_baseline() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  use futures_util::FutureExt;
  let outcome = std::panic::AssertUnwindSafe(async {
    let run_id = seed_run(&pool, profile_id).await;
    let binding_id = Uuid::new_v4();
    let conflict_id = Uuid::new_v4();
    let repo_path = "assets/git-wins.png";
    let blob_key = blob_key_for_repo_path(profile_id, repo_path);
    let git_bytes = b"\x89PNG\r\n\x1a\nresolved-git-bytes".to_vec();

    sqlx::query(
      "INSERT INTO git_sync_file_bindings
       (id, profile_id, workspace_id, blob_key, repo_path, content_hash, mime_type, file_size)
     VALUES ($1, $2, $3, $4, $5, 'sha256:myoxus', 'image/png', 8)",
    )
    .bind(binding_id)
    .bind(profile_id)
    .bind(ws_id)
    .bind(&blob_key)
    .bind(repo_path)
    .execute(&pool)
    .await
    .expect("insert file binding");
    sqlx::query(
      "INSERT INTO git_sync_file_conflicts
       (id, profile_id, run_id, binding_id, blob_key, repo_path, conflict_type, resolution,
        git_hash, myoxus_hash, baseline_hash)
     VALUES ($1, $2, $3, $4, $5, $6, 'BothModified', 'Open',
       'sha256:git', 'sha256:myoxus', 'sha256:base')",
    )
    .bind(conflict_id)
    .bind(profile_id)
    .bind(run_id)
    .bind(binding_id)
    .bind(&blob_key)
    .bind(repo_path)
    .execute(&pool)
    .await
    .expect("insert file conflict");

    let store = SqlxGitSyncStore::new(pool.clone());
    let conflict: GitSyncFileConflict = store.get_file_conflict(conflict_id).await.expect("load file conflict");
    let profile = store.get_profile(profile_id).await.expect("load profile");
    let git_repo = FileConflictGitRepo {
      files: HashMap::from([(repo_path.to_string(), git_bytes.clone())]),
    };
    let blob_storage = FileConflictBlobStorage::default();

    let mut observed = conflict.clone();
    observed.id = Uuid::new_v4();
    sqlx::query("UPDATE git_sync_runs SET status='Failed',finished_at=now() WHERE id=$1")
      .bind(run_id)
      .execute(&pool)
      .await
      .unwrap();
    observed.run_id = seed_run(&pool, profile_id).await;
    store.create_file_conflict(&observed).await.unwrap();
    let repeated = store.get_file_conflicts_by_profile(profile_id, false).await.unwrap();
    assert_eq!(repeated.len(), 1);
    assert_eq!(repeated[0].id, conflict.id);
    assert_eq!(
      repeated[0].run_id, run_id,
      "a later observation does not replace live provenance"
    );
    observed.baseline_hash = None;
    store.create_file_conflict(&observed).await.unwrap();
    let replacement = store
      .get_file_conflicts_by_profile(profile_id, false)
      .await
      .unwrap()
      .pop()
      .unwrap();
    assert_ne!(
      replacement.id, conflict.id,
      "changed null/non-null input is a new decision"
    );
    assert!(
      resolve_file_conflict_with_prepared_git_repo(
        &store,
        &conflict,
        &profile,
        ConflictResolution::GitWins,
        admin_id,
        &blob_storage,
        Some(&git_repo),
        Some("abcdef")
      )
      .await
      .is_err()
    );
    assert!(
      blob_storage.get(&blob_key).is_none(),
      "a superseded Open clone must not materialize old Git bytes"
    );
    let conflict = replacement;

    resolve_file_conflict_with_prepared_git_repo(
      &store,
      &conflict,
      &profile,
      ConflictResolution::GitWins,
      admin_id,
      &blob_storage,
      Some(&git_repo),
      Some("abcdef"),
    )
    .await
    .expect("resolve file conflict with git bytes");

    assert_eq!(
      blob_storage.get(&blob_key).as_deref(),
      Some(git_bytes.as_slice()),
      "GitWins must write Git bytes into the Myoxus blob store"
    );
    let row = sqlx::query("SELECT content_hash, file_size, tombstoned FROM git_sync_file_bindings WHERE id = $1")
      .bind(binding_id)
      .fetch_one(&pool)
      .await
      .expect("fetch updated file binding");
    assert_eq!(row.get::<String, _>("content_hash"), "sha256:git");
    assert_eq!(row.get::<i64, _>("file_size"), git_bytes.len() as i64);
    assert!(!row.get::<bool, _>("tombstoned"));
    let baseline_hash: String =
      sqlx::query_scalar("SELECT content_hash FROM git_sync_file_baselines WHERE profile_id = $1 AND blob_key = $2")
        .bind(profile_id)
        .bind(&blob_key)
        .fetch_one(&pool)
        .await
        .expect("fetch updated file baseline");
    assert_eq!(baseline_hash, "sha256:git");
    let marker: String = sqlx::query_scalar("SELECT resolution FROM git_sync_file_conflicts WHERE id = $1")
      .bind(conflict.id)
      .fetch_one(&pool)
      .await
      .expect("fetch file conflict marker");
    assert_eq!(marker, "GitWins");
  })
  .catch_unwind()
  .await;
  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

// ─── Test 7: REST upload blocked by strict MIME policy ──────────────────

#[tokio::test]
async fn mime_policy_rest_upload_blocked_in_strict_mode() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let pool = helpers::setup_pool().await;
  set_mime_config(&pool, "strict").await;
  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let ws_id = helpers::create_workspace(&pool, admin_id).await;

  // Create a blob upload via GraphQL first (this is how the client gets a signed URL)
  let create_resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation CreateBlobUpload($workspaceId: String!, $key: String!, $size: Int!, $mime: String!) { createBlobUpload(workspaceId: $workspaceId, key: $key, size: $size, mime: $mime) { method uploadUrl blobKey } }",
      "variables": {
        "workspaceId": ws_id.to_string(),
        "key": "blocked.zip",
        "size": 8,
        "mime": "application/zip"
      }
    }),
  )
  .await;

  // If createBlobUpload already catches the MIME policy, that's also valid
  if create_resp.get("errors").is_some() {
    let msg = create_resp["errors"][0]["message"].as_str().unwrap_or("");
    assert!(
      msg.contains("blocklisted") || msg.contains("MIME") || msg.contains("unsupported"),
      "error must reference MIME policy, got: {msg}"
    );
  } else {
    // Got a signed URL — try the REST upload
    let upload_url = create_resp["data"]["createBlobUpload"]["uploadUrl"]
      .as_str()
      .unwrap_or("");
    if !upload_url.is_empty() {
      let zip_bytes: Vec<u8> = vec![0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00];
      let resp = app
        .clone()
        .oneshot(
          Request::builder()
            .method("PUT")
            .uri(upload_url)
            .header("content-type", "application/zip")
            .body(Body::from(zip_bytes))
            .expect("request"),
        )
        .await
        .expect("response");
      let status = resp.status().as_u16();
      assert_eq!(status, 415, "REST upload of blocked MIME must return 415, got {status}");
    } else {
      // GRAPHQL method — try via setBlob multipart which we know works
      let result = upload_zip(&app, ws_id, session_id).await;
      assert!(
        result.get("errors").is_some(),
        "setBlob must reject ZIP in strict mode, got: {result}"
      );
    }
  }

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id LIKE 'git_sync.mime%'")
    .execute(&pool)
    .await
    .ok();
  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Test 8: Multipart complete blocked by MIME policy ──────────────────

#[tokio::test]
async fn mime_policy_multipart_complete_blocked_in_strict_mode() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let pool = helpers::setup_pool().await;
  set_mime_config(&pool, "strict").await;
  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let ws_id = helpers::create_workspace(&pool, admin_id).await;

  // Try via setBlob (GraphQL multipart upload) — this is the primary upload path
  let result = upload_zip(&app, ws_id, session_id).await;
  assert!(
    result.get("errors").is_some(),
    "setBlob must reject ZIP in strict mode for multipart path, got: {result}"
  );
  let error_msg = result["errors"][0]["message"].as_str().unwrap_or("");
  assert!(
    error_msg.contains("blocklisted") || error_msg.contains("MIME"),
    "error must mention MIME policy, got: {error_msg}"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id LIKE 'git_sync.mime%'")
    .execute(&pool)
    .await
    .ok();
  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Test 9: Default config allows common types ─────────────────────────

#[tokio::test]
async fn mime_policy_default_allows_common_types() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let pool = helpers::setup_pool().await;
  sqlx::query("DELETE FROM app_configs WHERE id LIKE 'git_sync.mime%'")
    .execute(&pool)
    .await
    .ok();
  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let ws_id = helpers::create_workspace(&pool, admin_id).await;

  // Upload a PNG via setBlob (GraphQL multipart)
  let png_header: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  let boundary = "X-BOUNDARY-PNG-TEST";
  let operations = json!({
    "query": "mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }",
    "variables": { "workspaceId": ws_id.to_string(), "blob": null }
  })
  .to_string();
  let map = json!({ "0": ["variables.blob"] }).to_string();

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
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"0\"; filename=\"test.png\"\r\n");
  body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
  body.extend_from_slice(&png_header);
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(body))
        .expect("request"),
    )
    .await
    .expect("response");
  let resp_bytes = BodyExt::collect(resp.into_body()).await.expect("body").to_bytes();
  let result: serde_json::Value = serde_json::from_slice(&resp_bytes).expect("json");

  assert!(
    result.get("errors").is_none(),
    "PNG upload must succeed with default config, got: {result}"
  );
  assert!(
    result["data"]["setBlob"].is_string(),
    "setBlob must return a blob key, got: {result}"
  );

  // Cleanup
  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── MIME enforcement regression: createBlobUpload does NOT check MIME ───

/// createBlobUpload is a session-init call (no bytes transferred yet).
/// MIME policy must NOT be enforced here — only at finalization time.
/// Regression test: even with strict mode + blocklisted MIME, the init must succeed.
#[tokio::test]
async fn create_blob_upload_does_not_enforce_mime_policy() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let pool = helpers::setup_pool().await;
  set_mime_config(&pool, "strict").await;
  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let ws_id = helpers::create_workspace(&pool, admin_id).await;

  // createBlobUpload with a blocklisted MIME type → must succeed
  let result = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation CreateBlobUpload($workspaceId: String!, $key: String!, $size: Int!, $mime: String!) { createBlobUpload(workspaceId: $workspaceId, key: $key, size: $size, mime: $mime) { method uploadUrl blobKey } }",
      "variables": {
        "workspaceId": ws_id.to_string(),
        "key": "session-init-test.zip",
        "size": 1024,
        "mime": "application/zip"
      }
    }),
  )
  .await;

  // The init call must NOT reject based on MIME policy
  assert!(
    result.get("errors").is_none(),
    "createBlobUpload must not enforce MIME policy at session init, got: {result}"
  );
  assert!(
    result["data"]["createBlobUpload"]["blobKey"].is_string(),
    "createBlobUpload must return a blob key even for blocklisted MIME, got: {result}"
  );

  // Cleanup
  sqlx::query("DELETE FROM app_configs WHERE id LIKE 'git_sync.mime%'")
    .execute(&pool)
    .await
    .ok();
  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}
