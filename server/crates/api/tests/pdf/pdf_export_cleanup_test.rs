// SPDX-License-Identifier: AGPL-3.0-or-later
//! #314 integration tests — nightly cleanup of expired PDF export jobs.
//!
//! Invariants checked:
//! - PDFEXPCLEAN-01: a `done` job with `expires_at < NOW()` is removed from
//!   `pdf_export_jobs`, the matching `blobs` registry row is removed, and the
//!   storage object at `{workspace_id}/pdf-export/{blob_id}` is deleted.
//! - PDFEXPCLEAN-02: re-running the sweep on an already-cleaned table is a
//!   no-op (idempotent — the report counters are all zero).
//! - PDFEXPCLEAN-03: a job whose `expires_at` is still in the future is left
//!   untouched (cleanup must never reap live rows).
//! - PDFEXPCLEAN-04: when the storage backend errors on `delete_blob`, the
//!   sweep still purges the DB rows but increments `delete_errors` so an
//!   operator can investigate orphan storage objects.
//! - PDFEXPCLEAN-05: PDFREV-OPS-01 — a `running` row whose `started_at` is
//!   older than `STALLED_RUNNING_AFTER_SECONDS` is marked `failed` with
//!   `error_class = 'Stalled'` so it stops counting against the
//!   per-workspace concurrency cap.

use crate::helpers;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use tokio::sync::Mutex as AsyncMutex;

/// Serializes the four cleanup tests in this file. The sweep operates on the
/// `pdf_export_jobs` table globally, so without a lock two tests running in
/// parallel can race each other for the same expired rows.
fn cleanup_test_lock() -> &'static AsyncMutex<()> {
  static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| AsyncMutex::new(()))
}

use bytes::Bytes;
use myoxus_api::pdf_export_cleanup::{PdfExportCleanupReport, PdfExportCleanupService};
use myoxus_application::pdf_export::jobs::PdfExportJobStore;
use myoxus_application::ports::blob::BlobStore;
use myoxus_application::ports::{
  BlobReadResponse, BlobStoragePort, BlobWriteRequest, MultipartCompleteRequest, MultipartCreateRequest,
  MultipartCreateResponse, MultipartPartUrlRequest, MultipartPartUrlResponse, PortError, PortResult,
};
use sqlx::Row;
use uuid::Uuid;

async fn clean_expired_pdf_export_jobs(
  pool: &sqlx::PgPool,
  storage: &Arc<dyn BlobStoragePort>,
) -> myoxus_application::auth::AuthResult<PdfExportCleanupReport> {
  let jobs: Arc<dyn PdfExportJobStore> = Arc::new(myoxus_infrastructure::pdf_export::PgPdfExportJobStore::new(
    pool.clone(),
  ));
  let blobs: Arc<dyn BlobStore> = Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone()));
  PdfExportCleanupService::new(jobs, blobs, storage.clone())
    .clean_expired()
    .await
}

// ---------------------------------------------------------------------------
// In-memory storage adapter — records writes/deletes so the test can assert
// on storage-level cleanup. `fail_on_delete` flips one delete to an error to
// exercise PDFEXPCLEAN-04.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct TrackingStorage {
  objects: Mutex<HashMap<String, Bytes>>,
  delete_calls: Mutex<Vec<String>>,
  fail_on_delete: bool,
}

#[async_trait::async_trait]
impl BlobStoragePort for TrackingStorage {
  async fn write_blob(&self, req: BlobWriteRequest) -> PortResult<()> {
    self.objects.lock().unwrap().insert(req.key, req.body);
    Ok(())
  }
  async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
    let map = self.objects.lock().unwrap();
    let data = map
      .get(key)
      .ok_or_else(|| PortError::NotFound(key.to_string()))?
      .clone();
    let len = data.len() as u64;
    Ok(BlobReadResponse {
      key: key.to_string(),
      content_type: Some("application/pdf".to_string()),
      data,
      last_modified: None,
      content_length: len,
    })
  }
  async fn delete_blob(&self, key: &str) -> PortResult<()> {
    self.delete_calls.lock().unwrap().push(key.to_string());
    if self.fail_on_delete {
      return Err(PortError::Transport("simulated storage failure".to_string()));
    }
    self.objects.lock().unwrap().remove(key);
    Ok(())
  }
  async fn put_avatar(&self, key: &str, _data: Bytes, _content_type: &str) -> PortResult<String> {
    Ok(key.to_string())
  }
  async fn get_avatar(&self, _key: &str) -> PortResult<BlobReadResponse> {
    Err(PortError::NotFound("missing".to_string()))
  }
  async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }
  async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
    Err(PortError::InvalidInput("multipart unsupported".to_string()))
  }
  async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
    Err(PortError::InvalidInput("multipart unsupported".to_string()))
  }
  async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
    Err(PortError::InvalidInput("multipart unsupported".to_string()))
  }
  async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
    Err(PortError::InvalidInput("multipart unsupported".to_string()))
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async fn insert_done_job(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  doc_id: Uuid,
  requested_by: Uuid,
  expires_at_sql: &str,
) -> (Uuid, Uuid) {
  let blob_id = Uuid::new_v4();
  let blob_key = myoxus_application::pdf_export::jobs::pdf_export_blob_key(blob_id);
  let row = sqlx::query(&format!(
    "INSERT INTO pdf_export_jobs (workspace_id, doc_id, requested_by, template_id, \
       render_inputs, options_hash, status, sync_or_async, output_blob_id, \
       started_at, finished_at, expires_at) \
     VALUES ($1, $2, $3, 'default', '{{}}', $4, 'done', 'sync', $5, NOW(), NOW(), {expires_at_sql}) \
     RETURNING id"
  ))
  .bind(workspace_id)
  .bind(doc_id)
  .bind(requested_by)
  .bind(format!("test-hash-{blob_id}"))
  .bind(blob_id)
  .fetch_one(pool)
  .await
  .expect("insert pdf_export_jobs row");
  let job_id: Uuid = row.get("id");

  sqlx::query(
    "INSERT INTO blobs (workspace_id, key, size, mime, status, created_at) \
     VALUES ($1, $2, 1024, 'application/pdf', 'completed', NOW()) \
     ON CONFLICT DO NOTHING",
  )
  .bind(workspace_id)
  .bind(&blob_key)
  .execute(pool)
  .await
  .expect("insert blobs row");

  (job_id, blob_id)
}

async fn job_exists(pool: &sqlx::PgPool, job_id: Uuid) -> bool {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pdf_export_jobs WHERE id = $1")
    .bind(job_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0)
    > 0
}

async fn blob_row_exists(pool: &sqlx::PgPool, workspace_id: Uuid, key: &str) -> bool {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blobs WHERE workspace_id = $1 AND key = $2")
    .bind(workspace_id)
    .bind(key)
    .fetch_one(pool)
    .await
    .unwrap_or(0)
    > 0
}

async fn cleanup_residue(pool: &sqlx::PgPool, ws_id: Uuid) {
  sqlx::query("DELETE FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM blobs WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
}

// ---------------------------------------------------------------------------
// PDFEXPCLEAN-01: an expired done row is removed end-to-end
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexpclean01_expired_row_purged() {
  let _g = cleanup_test_lock().lock().await;
  let pool = helpers::setup_pool().await;
  // Drain any expired rows left behind by other (non-cleanup) tests that
  // may have inserted with backdated timestamps; we want a known baseline.
  sqlx::query("DELETE FROM pdf_export_jobs WHERE expires_at IS NOT NULL AND expires_at < NOW()")
    .execute(&pool)
    .await
    .ok();
  let user_id = helpers::create_user(&pool, "pdfclean01", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

  let storage_box: Arc<dyn BlobStoragePort> = Arc::new(TrackingStorage::default());
  let (job_id, blob_id) = insert_done_job(&pool, ws_id, doc_id, user_id, "NOW() - INTERVAL '1 day'").await;
  let storage_key = myoxus_worker::pdf_export_storage_key(ws_id, blob_id);

  // Pre-populate the tracking storage so delete_blob has something to remove.
  storage_box
    .write_blob(BlobWriteRequest {
      key: storage_key.clone(),
      content_type: Some("application/pdf".to_string()),
      body: Bytes::from_static(b"%PDF-1.4\n"),
    })
    .await
    .expect("seed storage");

  let report = clean_expired_pdf_export_jobs(&pool, &storage_box)
    .await
    .expect("cleanup must succeed");

  assert_eq!(report.expired_jobs, 1, "report.expired_jobs");
  assert_eq!(report.deleted_jobs, 1, "report.deleted_jobs");
  assert_eq!(report.deleted_blobs, 1, "report.deleted_blobs");
  assert_eq!(report.deleted_blob_rows, 1, "report.deleted_blob_rows");
  assert_eq!(report.delete_errors, 0, "report.delete_errors");

  assert!(!job_exists(&pool, job_id).await, "job row must be gone");
  assert!(
    !blob_row_exists(
      &pool,
      ws_id,
      &myoxus_application::pdf_export::jobs::pdf_export_blob_key(blob_id)
    )
    .await,
    "blob registry row must be gone"
  );

  let read = storage_box.read_blob(&storage_key).await;
  assert!(
    matches!(read, Err(PortError::NotFound(_))),
    "storage object must be gone"
  );

  cleanup_residue(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXPCLEAN-02: re-running on a clean table is a zero-op
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexpclean02_idempotent_rerun() {
  let _g = cleanup_test_lock().lock().await;
  let pool = helpers::setup_pool().await;
  sqlx::query("DELETE FROM pdf_export_jobs WHERE expires_at IS NOT NULL AND expires_at < NOW()")
    .execute(&pool)
    .await
    .ok();
  let user_id = helpers::create_user(&pool, "pdfclean02", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let storage_box: Arc<dyn BlobStoragePort> = Arc::new(TrackingStorage::default());

  // First sweep: pre-purge cleared the table, must report zero.
  let r1 = clean_expired_pdf_export_jobs(&pool, &storage_box)
    .await
    .expect("first sweep");
  assert_eq!(r1.expired_jobs, 0);
  assert_eq!(r1.deleted_jobs, 0);

  // Second sweep: still zero — no work, no error.
  let r2 = clean_expired_pdf_export_jobs(&pool, &storage_box)
    .await
    .expect("second sweep");
  assert_eq!(r2.expired_jobs, 0);
  assert_eq!(r2.deleted_jobs, 0);

  // Insert a single expired row, sweep, then sweep again.
  let (job_id, _) = insert_done_job(&pool, ws_id, doc_id, user_id, "NOW() - INTERVAL '2 hours'").await;
  let r3 = clean_expired_pdf_export_jobs(&pool, &storage_box)
    .await
    .expect("third sweep");
  assert_eq!(r3.expired_jobs, 1);
  assert!(!job_exists(&pool, job_id).await, "our row must be reaped");

  // Idempotent re-run: zero-op.
  let r4 = clean_expired_pdf_export_jobs(&pool, &storage_box)
    .await
    .expect("fourth sweep");
  assert_eq!(r4.expired_jobs, 0, "no rows should remain");

  cleanup_residue(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXPCLEAN-03: future-expiry rows must not be touched
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexpclean03_future_row_preserved() {
  let _g = cleanup_test_lock().lock().await;
  let pool = helpers::setup_pool().await;
  sqlx::query("DELETE FROM pdf_export_jobs WHERE expires_at IS NOT NULL AND expires_at < NOW()")
    .execute(&pool)
    .await
    .ok();
  let user_id = helpers::create_user(&pool, "pdfclean03", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let storage_box: Arc<dyn BlobStoragePort> = Arc::new(TrackingStorage::default());

  let (live_job, live_blob) = insert_done_job(&pool, ws_id, doc_id, user_id, "NOW() + INTERVAL '1 day'").await;
  let (expired_job, expired_blob) = insert_done_job(&pool, ws_id, doc_id, user_id, "NOW() - INTERVAL '1 hour'").await;
  let live_key = myoxus_application::pdf_export::jobs::pdf_export_blob_key(live_blob);
  let expired_key = myoxus_application::pdf_export::jobs::pdf_export_blob_key(expired_blob);

  let report = clean_expired_pdf_export_jobs(&pool, &storage_box)
    .await
    .expect("cleanup ok");

  assert_eq!(report.expired_jobs, 1, "only the expired row counts");
  assert_eq!(report.deleted_jobs, 1);

  assert!(job_exists(&pool, live_job).await, "live job must survive");
  assert!(
    blob_row_exists(&pool, ws_id, &live_key).await,
    "live blob row must survive"
  );
  assert!(!job_exists(&pool, expired_job).await, "expired job must be gone");
  assert!(
    !blob_row_exists(&pool, ws_id, &expired_key).await,
    "expired blob row must be gone"
  );

  cleanup_residue(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXPCLEAN-04: storage delete failure does not block DB row purging
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexpclean04_storage_failure_recorded_but_db_purged() {
  let _g = cleanup_test_lock().lock().await;
  let pool = helpers::setup_pool().await;
  sqlx::query("DELETE FROM pdf_export_jobs WHERE expires_at IS NOT NULL AND expires_at < NOW()")
    .execute(&pool)
    .await
    .ok();
  let user_id = helpers::create_user(&pool, "pdfclean04", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let storage_box: Arc<dyn BlobStoragePort> = Arc::new(TrackingStorage {
    fail_on_delete: true,
    ..Default::default()
  });

  let (job_id, blob_id) = insert_done_job(&pool, ws_id, doc_id, user_id, "NOW() - INTERVAL '6 hours'").await;

  let report = clean_expired_pdf_export_jobs(&pool, &storage_box)
    .await
    .expect("cleanup must succeed even when storage delete fails");

  assert_eq!(report.expired_jobs, 1);
  assert_eq!(report.deleted_jobs, 1, "DB rows must be purged regardless");
  assert_eq!(report.deleted_blobs, 0, "no successful blob deletes");
  assert_eq!(report.delete_errors, 1, "the failure was recorded");
  assert_eq!(report.deleted_blob_rows, 1, "blob registry row still purged");

  assert!(!job_exists(&pool, job_id).await);
  assert!(
    !blob_row_exists(
      &pool,
      ws_id,
      &myoxus_application::pdf_export::jobs::pdf_export_blob_key(blob_id)
    )
    .await
  );

  cleanup_residue(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXPCLEAN-05 (PDFREV-OPS-01): a `running` row whose `started_at` predates
// the stall window is reaped (status=failed, error_class=Stalled) so the
// per-workspace concurrency cap does not leak slots when a worker crashes.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexpclean05_stalled_running_row_reaped() {
  let _g = cleanup_test_lock().lock().await;
  let pool = helpers::setup_pool().await;
  // Other tests may have left expired rows behind — drain so the report
  // counters reflect only this test's row.
  sqlx::query("DELETE FROM pdf_export_jobs WHERE expires_at IS NOT NULL AND expires_at < NOW()")
    .execute(&pool)
    .await
    .ok();
  // Also drain pre-existing stalled rows so reaped_stalled_jobs is exact.
  sqlx::query("DELETE FROM pdf_export_jobs WHERE status = 'running' AND started_at < NOW() - INTERVAL '2 hours'")
    .execute(&pool)
    .await
    .ok();

  let user_id = helpers::create_user(&pool, "pdfclean05", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let storage_box: Arc<dyn BlobStoragePort> = Arc::new(TrackingStorage::default());

  // Insert a `running` row whose `started_at` is 3h old — past the 2h window.
  let stalled_id: Uuid = sqlx::query_scalar(
    "INSERT INTO pdf_export_jobs (workspace_id, doc_id, requested_by, template_id, \
       render_inputs, options_hash, status, sync_or_async, started_at) \
     VALUES ($1, $2, $3, 'default', '{}', $4, 'running', 'async', NOW() - INTERVAL '3 hours') \
     RETURNING id",
  )
  .bind(ws_id)
  .bind(doc_id)
  .bind(user_id)
  .bind(format!("stalled-hash-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert stalled running row");

  // And a fresh `running` row that is NOT past the window — it must be left alone.
  let fresh_id: Uuid = sqlx::query_scalar(
    "INSERT INTO pdf_export_jobs (workspace_id, doc_id, requested_by, template_id, \
       render_inputs, options_hash, status, sync_or_async, started_at) \
     VALUES ($1, $2, $3, 'default', '{}', $4, 'running', 'async', NOW() - INTERVAL '5 minutes') \
     RETURNING id",
  )
  .bind(ws_id)
  .bind(doc_id)
  .bind(user_id)
  .bind(format!("fresh-hash-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert fresh running row");

  let report = clean_expired_pdf_export_jobs(&pool, &storage_box)
    .await
    .expect("cleanup must succeed");

  assert_eq!(report.reaped_stalled_jobs, 1, "exactly one stalled row reaped");
  assert_eq!(report.expired_jobs, 0, "no expired-row work in this scenario");

  let stalled_row = sqlx::query("SELECT status::TEXT AS status, error_class FROM pdf_export_jobs WHERE id = $1")
    .bind(stalled_id)
    .fetch_one(&pool)
    .await
    .expect("stalled row must still exist (just rewritten)");
  let stalled_status: String = stalled_row.get("status");
  let stalled_class: Option<String> = stalled_row.try_get("error_class").unwrap_or(None);
  assert_eq!(stalled_status, "failed", "stalled row must be marked failed");
  assert_eq!(
    stalled_class.as_deref(),
    Some("Stalled"),
    "stalled row must carry stable error_class='Stalled'"
  );

  let fresh_status: String = sqlx::query_scalar("SELECT status::TEXT FROM pdf_export_jobs WHERE id = $1")
    .bind(fresh_id)
    .fetch_one(&pool)
    .await
    .expect("fresh row must still exist");
  assert_eq!(fresh_status, "running", "fresh running row must NOT be reaped");

  cleanup_residue(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}
