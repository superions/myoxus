// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authoritative persistence contract for PDF export jobs.
//!
//! Transport layers consume typed job projections and transitions through this
//! port. They never receive SQL rows or construct product-table queries.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::repositories::RepoResult;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Workspace-relative blob-registry key; the normal blob owner adds the workspace
/// once when addressing object storage.
pub fn pdf_export_blob_key(blob_id: Uuid) -> String {
  format!("pdf-export/{blob_id}")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdfExportJob {
  pub id: Uuid,
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub requested_by: Uuid,
  pub template_id: String,
  pub status: String,
  pub sync_or_async: String,
  pub output_blob_id: Option<Uuid>,
  pub error_class: Option<String>,
  pub error_detail: Option<String>,
  pub render_inputs: serde_json::Value,
  pub created_at: DateTime<Utc>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
  pub expires_at: Option<DateTime<Utc>>,
  pub page_count: Option<i32>,
  pub unmapped_font_families: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdfExportRenderAuditProjection {
  pub id: Uuid,
  pub document_version_id: Option<Uuid>,
  pub template_version: String,
  pub render_appearance_hash: String,
  pub locale: String,
  pub classification: Option<String>,
  pub l3_inputs: serde_json::Value,
  pub document_metadata_snapshot: serde_json::Value,
  pub metadata_validation: serde_json::Value,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdfExportAdminJob {
  pub job: PdfExportJob,
  pub requested_by_email: Option<String>,
  pub requested_by_name: Option<String>,
  pub audit: Option<PdfExportRenderAuditProjection>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PdfExportAdminJobFilter {
  pub status: Option<String>,
  pub workspace_id: Option<Uuid>,
  pub user_id: Option<Uuid>,
  pub created_after: Option<DateTime<Utc>>,
  pub created_before: Option<DateTime<Utc>>,
  pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdfExportJobSignal {
  pub id: Uuid,
  pub status: String,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
  pub error_class: Option<String>,
  pub page_count: Option<i32>,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PdfExportJobInsert {
  pub id: Uuid,
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub requested_by: Uuid,
  pub template_id: String,
  pub render_inputs: serde_json::Value,
  pub options_hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PdfExportJobCompletion {
  /// Bounded report observed by the worker, stored with the pinned render input.
  pub renderer_diagnostics: serde_json::Value,
  pub id: Uuid,
  pub output_blob_id: Uuid,
  pub page_count: i32,
  pub unmapped_font_families: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiredPdfExportJob {
  pub id: Uuid,
  pub workspace_id: Uuid,
  pub output_blob_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompletedPdfExportJobInsert {
  pub job: PdfExportJobInsert,
  pub output_blob_id: Uuid,
  pub page_count: i32,
  pub unmapped_font_families: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfExportJobCancellation {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub template_id: String,
  pub requested_by: Uuid,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PdfExportDownload {
  pub job: PdfExportJob,
  pub document_title: Option<String>,
}

#[async_trait]
pub trait PdfExportJobStore: Send + Sync {
  async fn get(&self, id: Uuid) -> RepoResult<Option<PdfExportJob>>;
  async fn get_download(&self, id: Uuid) -> RepoResult<Option<PdfExportDownload>>;
  async fn list_admin(&self, filter: &PdfExportAdminJobFilter) -> RepoResult<Vec<PdfExportAdminJob>>;
  async fn list_document(&self, doc_id: Uuid, limit: i64) -> RepoResult<Vec<PdfExportJob>>;
  async fn recent_signals(&self, since: DateTime<Utc>, limit: i64) -> RepoResult<Vec<PdfExportJobSignal>>;
  async fn find_recent_matching(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    options_hash: &str,
    requested_by: Uuid,
  ) -> RepoResult<Option<PdfExportJob>>;
  async fn find_recent_latest(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    template_id: &str,
    requested_by: Uuid,
    idempotency_key: &str,
  ) -> RepoResult<Option<PdfExportJob>>;
  async fn count_active_for_workspace(&self, workspace_id: Uuid) -> RepoResult<i64>;
  async fn insert_completed(&self, input: &CompletedPdfExportJobInsert) -> RepoResult<PdfExportJob>;
  async fn insert_queued(&self, input: &PdfExportJobInsert) -> RepoResult<PdfExportJob>;
  async fn cancel_queued(&self, id: Uuid, detail: &str) -> RepoResult<Option<PdfExportJobCancellation>>;
  async fn mark_enqueue_failed(&self, id: Uuid, detail: &str) -> RepoResult<()>;
  /// Atomically claim a queued job and return its stable creation timestamp.
  async fn claim_queued(&self, id: Uuid) -> RepoResult<Option<DateTime<Utc>>>;
  async fn complete(&self, completion: &PdfExportJobCompletion) -> RepoResult<()>;
  /// Persist terminal failure together with an observed, content-free report.
  /// None means the pipeline failed before a report was available.
  async fn fail(
    &self,
    id: Uuid,
    error_class: &str,
    error_detail: &str,
    renderer_diagnostics: Option<&serde_json::Value>,
  ) -> RepoResult<()>;
  async fn reap_stalled(&self, stalled_after_seconds: i64) -> RepoResult<u64>;
  async fn list_expired(&self, limit: i64) -> RepoResult<Vec<ExpiredPdfExportJob>>;
  async fn delete_expired(&self, ids: &[Uuid]) -> RepoResult<u64>;
}

/// Explicit fail-fast adapter for narrow API tests that do not mount PDF
/// export. Production composition must replace it with the PostgreSQL owner.
#[derive(Debug, Default)]
pub struct UnavailablePdfExportJobStore;

#[async_trait]
impl PdfExportJobStore for UnavailablePdfExportJobStore {
  async fn get(&self, _id: Uuid) -> RepoResult<Option<PdfExportJob>> {
    Err(unavailable())
  }

  async fn get_download(&self, _id: Uuid) -> RepoResult<Option<PdfExportDownload>> {
    Err(unavailable())
  }

  async fn list_admin(&self, _filter: &PdfExportAdminJobFilter) -> RepoResult<Vec<PdfExportAdminJob>> {
    Err(unavailable())
  }

  async fn list_document(&self, _doc_id: Uuid, _limit: i64) -> RepoResult<Vec<PdfExportJob>> {
    Err(unavailable())
  }

  async fn recent_signals(&self, _since: DateTime<Utc>, _limit: i64) -> RepoResult<Vec<PdfExportJobSignal>> {
    Err(unavailable())
  }

  async fn find_recent_matching(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _options_hash: &str,
    _requested_by: Uuid,
  ) -> RepoResult<Option<PdfExportJob>> {
    Err(unavailable())
  }

  async fn find_recent_latest(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _template_id: &str,
    _requested_by: Uuid,
    _idempotency_key: &str,
  ) -> RepoResult<Option<PdfExportJob>> {
    Err(unavailable())
  }

  async fn count_active_for_workspace(&self, _workspace_id: Uuid) -> RepoResult<i64> {
    Err(unavailable())
  }

  async fn insert_completed(&self, _input: &CompletedPdfExportJobInsert) -> RepoResult<PdfExportJob> {
    Err(unavailable())
  }

  async fn insert_queued(&self, _input: &PdfExportJobInsert) -> RepoResult<PdfExportJob> {
    Err(unavailable())
  }

  async fn cancel_queued(&self, _id: Uuid, _detail: &str) -> RepoResult<Option<PdfExportJobCancellation>> {
    Err(unavailable())
  }

  async fn mark_enqueue_failed(&self, _id: Uuid, _detail: &str) -> RepoResult<()> {
    Err(unavailable())
  }

  async fn claim_queued(&self, _id: Uuid) -> RepoResult<Option<DateTime<Utc>>> {
    Err(unavailable())
  }

  async fn complete(&self, _completion: &PdfExportJobCompletion) -> RepoResult<()> {
    Err(unavailable())
  }

  async fn fail(
    &self,
    _id: Uuid,
    _error_class: &str,
    _error_detail: &str,
    _renderer_diagnostics: Option<&serde_json::Value>,
  ) -> RepoResult<()> {
    Err(unavailable())
  }

  async fn reap_stalled(&self, _stalled_after_seconds: i64) -> RepoResult<u64> {
    Err(unavailable())
  }

  async fn list_expired(&self, _limit: i64) -> RepoResult<Vec<ExpiredPdfExportJob>> {
    Err(unavailable())
  }

  async fn delete_expired(&self, _ids: &[Uuid]) -> RepoResult<u64> {
    Err(unavailable())
  }
}

fn unavailable() -> myoxus_domain::repositories::RepositoryError {
  myoxus_domain::repositories::RepositoryError::Storage("PDF export job store is not configured".to_string())
}
