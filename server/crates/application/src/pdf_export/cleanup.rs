// SPDX-License-Identifier: AGPL-3.0-or-later
//! Application-owned cleanup of expired PDF export artifacts.

use std::sync::Arc;

use crate::{
  auth::{AuthError, AuthResult},
  pdf_export::jobs::{PdfExportJobStore, pdf_export_blob_key},
  ports::{BlobStoragePort, blob::BlobStore},
};
use chrono::Utc;
use serde::Serialize;
use tracing::instrument;

const BATCH_LIMIT: i64 = 1000;
pub const STALLED_RUNNING_AFTER_SECONDS: i64 = 2 * 60 * 60;

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct PdfExportCleanupReport {
  pub expired_jobs: usize,
  pub deleted_jobs: u64,
  pub deleted_blobs: usize,
  pub deleted_blob_rows: u64,
  pub delete_errors: usize,
  pub reaped_stalled_jobs: u64,
}

/// Coordinates job-state, object-storage and blob-registry cleanup while each
/// persistence detail remains owned by its capability-specific port.
pub struct PdfExportCleanupService {
  jobs: Arc<dyn PdfExportJobStore>,
  blobs: Arc<dyn BlobStore>,
  storage: Arc<dyn BlobStoragePort>,
}

impl PdfExportCleanupService {
  pub fn new(jobs: Arc<dyn PdfExportJobStore>, blobs: Arc<dyn BlobStore>, storage: Arc<dyn BlobStoragePort>) -> Self {
    Self { jobs, blobs, storage }
  }

  #[instrument(skip_all, name = "pdf_export.clean_expired")]
  pub async fn clean_expired(&self) -> AuthResult<PdfExportCleanupReport> {
    let reaped_stalled_jobs = self
      .jobs
      .reap_stalled(STALLED_RUNNING_AFTER_SECONDS)
      .await
      .map_err(store_error)?;
    let expired = self.jobs.list_expired(BATCH_LIMIT).await.map_err(store_error)?;
    if expired.is_empty() {
      return Ok(PdfExportCleanupReport {
        reaped_stalled_jobs,
        ..PdfExportCleanupReport::default()
      });
    }

    let mut deleted_blobs = 0;
    let mut deleted_blob_rows = 0;
    let mut delete_errors = 0;
    let mut job_ids = Vec::with_capacity(expired.len());

    for job in &expired {
      job_ids.push(job.id);
      let Some(blob_id) = job.output_blob_id else { continue };
      let key = pdf_export_blob_key(blob_id);
      let storage_key = format!("{}/{}", job.workspace_id, key);
      match self.storage.delete_blob(&storage_key).await {
        Ok(()) => deleted_blobs += 1,
        Err(error) => {
          delete_errors += 1;
          tracing::warn!(%error, %key, "failed to delete expired PDF object; registry cleanup continues");
        }
      }
      let parsed_key = crate::ports::blob::BlobKey::parse(&key).map_err(AuthError::Storage)?;
      // Blob metadata has a two-stage lifecycle: hard deletion deliberately
      // rejects active rows. Expired exports are terminal, so transition the
      // metadata before removing it permanently.
      self
        .blobs
        .soft_delete_blob_metadata(job.workspace_id, &parsed_key, Utc::now())
        .await?;
      if self
        .blobs
        .hard_delete_blob_metadata(job.workspace_id, &parsed_key)
        .await?
      {
        deleted_blob_rows += 1;
      }
    }

    let deleted_jobs = self.jobs.delete_expired(&job_ids).await.map_err(store_error)?;
    Ok(PdfExportCleanupReport {
      expired_jobs: expired.len(),
      deleted_jobs,
      deleted_blobs,
      deleted_blob_rows,
      delete_errors,
      reaped_stalled_jobs,
    })
  }
}

fn store_error(error: myoxus_domain::repositories::RepositoryError) -> AuthError {
  AuthError::Storage(error.to_string())
}
