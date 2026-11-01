// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL adapter for the authoritative PDF export job store.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::pdf_export::jobs::{
  CompletedPdfExportJobInsert, ExpiredPdfExportJob, PdfExportAdminJob, PdfExportAdminJobFilter, PdfExportDownload,
  PdfExportJob, PdfExportJobCancellation, PdfExportJobCompletion, PdfExportJobInsert, PdfExportJobSignal,
  PdfExportJobStore, PdfExportRenderAuditProjection,
};
use myoxus_domain::repositories::{RepoResult, RepositoryError};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use tracing::{error, instrument};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct PgPdfExportJobStore {
  pool: PgPool,
}

impl PgPdfExportJobStore {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_error(error: sqlx::Error) -> RepositoryError {
    error!(error = %error, "database error in PDF export job store");
    RepositoryError::Storage(error.to_string())
  }

  fn map_job(row: &sqlx::postgres::PgRow) -> PdfExportJob {
    PdfExportJob {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      requested_by: row.get("requested_by"),
      template_id: row.try_get("template_id").unwrap_or_default(),
      status: row.get("status"),
      sync_or_async: row.try_get("sync_or_async").unwrap_or_else(|_| "async".to_string()),
      output_blob_id: row.try_get("output_blob_id").unwrap_or(None),
      error_class: row.try_get("error_class").unwrap_or(None),
      error_detail: row.try_get("error_detail").unwrap_or(None),
      render_inputs: row.try_get("render_inputs").unwrap_or_else(|_| serde_json::json!({})),
      created_at: row.get("created_at"),
      started_at: row.try_get("started_at").unwrap_or(None),
      finished_at: row.try_get("finished_at").unwrap_or(None),
      expires_at: row.try_get("expires_at").unwrap_or(None),
      page_count: row.try_get("page_count").unwrap_or(None),
      unmapped_font_families: row
        .try_get::<serde_json::Value, _>("unmapped_font_families")
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default(),
    }
  }

  const JOB_COLUMNS: &'static str = "id, workspace_id, doc_id, requested_by, template_id, \
    status::TEXT AS status, sync_or_async, output_blob_id, error_class, error_detail, render_inputs, \
    created_at, started_at, finished_at, expires_at, page_count, unmapped_font_families";
}

#[async_trait]
impl PdfExportJobStore for PgPdfExportJobStore {
  #[instrument(skip(self), err)]
  async fn get(&self, id: Uuid) -> RepoResult<Option<PdfExportJob>> {
    let sql = format!("SELECT {} FROM pdf_export_jobs WHERE id = $1", Self::JOB_COLUMNS);
    let row = sqlx::query(&sql)
      .bind(id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_error)?;
    Ok(row.as_ref().map(Self::map_job))
  }

  #[instrument(skip(self), err)]
  async fn get_download(&self, id: Uuid) -> RepoResult<Option<PdfExportDownload>> {
    let row = sqlx::query(
      "SELECT j.id, j.workspace_id, j.doc_id, j.requested_by, j.template_id, \
       j.status::TEXT AS status, j.sync_or_async, j.output_blob_id, j.error_class, j.error_detail, \
       j.render_inputs, j.created_at, j.started_at, j.finished_at, j.expires_at, j.page_count, \
       j.unmapped_font_families, d.title AS document_title FROM pdf_export_jobs j \
       LEFT JOIN docs d ON d.id = j.doc_id AND d.workspace_id = j.workspace_id WHERE j.id = $1",
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(row.map(|row| PdfExportDownload {
      job: Self::map_job(&row),
      document_title: row.try_get("document_title").unwrap_or(None),
    }))
  }

  #[instrument(skip(self, filter), err)]
  async fn list_admin(&self, filter: &PdfExportAdminJobFilter) -> RepoResult<Vec<PdfExportAdminJob>> {
    let mut query = QueryBuilder::<Postgres>::new(
      "SELECT j.id, j.workspace_id, j.doc_id, j.requested_by, j.template_id, \
       j.status::TEXT AS status, j.sync_or_async, j.output_blob_id, j.error_class, j.error_detail, \
       j.render_inputs, j.created_at, j.started_at, j.finished_at, j.expires_at, j.page_count, \
       j.unmapped_font_families, u.email AS requested_by_email, u.name AS requested_by_name, \
       audit.id AS audit_id, audit.template_version AS audit_template_version, \
       audit.render_appearance_hash AS audit_render_appearance_hash, audit.locale AS audit_locale, \
       audit.classification AS audit_classification, audit.l3_inputs AS audit_l3_inputs, \
       audit.document_version_id AS audit_document_version_id, \
       audit.document_metadata_snapshot AS audit_document_metadata_snapshot, \
       audit.metadata_validation AS audit_metadata_validation, audit.created_at AS audit_created_at \
       FROM pdf_export_jobs j LEFT JOIN users u ON u.id = j.requested_by LEFT JOIN LATERAL ( \
         SELECT id, template_version, render_appearance_hash, locale, classification, l3_inputs, \
                document_version_id, document_metadata_snapshot, metadata_validation, created_at \
         FROM pdf_export_render_audit a WHERE a.job_id = j.id ORDER BY a.created_at DESC LIMIT 1 \
       ) audit ON true WHERE j.created_at >= ",
    );
    query.push_bind(
      filter
        .created_after
        .unwrap_or_else(|| Utc::now() - chrono::Duration::hours(24)),
    );
    if let Some(before) = filter.created_before {
      query.push(" AND j.created_at <= ").push_bind(before);
    }
    if let Some(status) = filter.status.as_deref() {
      query
        .push(" AND j.status = ")
        .push_bind(status)
        .push("::pdf_export_status");
    }
    if let Some(workspace_id) = filter.workspace_id {
      query.push(" AND j.workspace_id = ").push_bind(workspace_id);
    }
    if let Some(user_id) = filter.user_id {
      query.push(" AND j.requested_by = ").push_bind(user_id);
    }
    query.push(" ORDER BY j.created_at DESC LIMIT ").push_bind(filter.limit);

    let rows = query.build().fetch_all(&self.pool).await.map_err(Self::map_error)?;
    Ok(
      rows
        .into_iter()
        .map(|row| {
          let job = Self::map_job(&row);
          let audit =
            row
              .try_get::<Option<Uuid>, _>("audit_id")
              .unwrap_or(None)
              .map(|id| PdfExportRenderAuditProjection {
                id,
                document_version_id: row.try_get("audit_document_version_id").unwrap_or(None),
                template_version: row
                  .try_get("audit_template_version")
                  .unwrap_or_else(|_| "unknown".to_string()),
                render_appearance_hash: row.try_get("audit_render_appearance_hash").unwrap_or_default(),
                locale: row.try_get("audit_locale").unwrap_or_else(|_| "en".to_string()),
                classification: row.try_get("audit_classification").unwrap_or(None),
                l3_inputs: row.try_get("audit_l3_inputs").unwrap_or_else(|_| serde_json::json!({})),
                document_metadata_snapshot: row
                  .try_get("audit_document_metadata_snapshot")
                  .unwrap_or_else(|_| serde_json::json!({})),
                metadata_validation: row
                  .try_get("audit_metadata_validation")
                  .unwrap_or_else(|_| serde_json::json!({})),
                created_at: row.try_get("audit_created_at").unwrap_or(job.created_at),
              });
          PdfExportAdminJob {
            job,
            requested_by_email: row.try_get("requested_by_email").unwrap_or(None),
            requested_by_name: row.try_get("requested_by_name").unwrap_or(None),
            audit,
          }
        })
        .collect(),
    )
  }

  #[instrument(skip(self), err)]
  async fn list_document(&self, doc_id: Uuid, limit: i64) -> RepoResult<Vec<PdfExportJob>> {
    let sql = format!(
      "SELECT {} FROM pdf_export_jobs WHERE doc_id = $1 ORDER BY created_at DESC LIMIT $2",
      Self::JOB_COLUMNS
    );
    let rows = sqlx::query(&sql)
      .bind(doc_id)
      .bind(limit)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_error)?;
    Ok(rows.iter().map(Self::map_job).collect())
  }

  #[instrument(skip(self), err)]
  async fn recent_signals(&self, since: DateTime<Utc>, limit: i64) -> RepoResult<Vec<PdfExportJobSignal>> {
    let rows = sqlx::query(
      "SELECT id, status::TEXT AS status, started_at, finished_at, error_class, page_count, created_at \
       FROM pdf_export_jobs WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2",
    )
    .bind(since)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(
      rows
        .into_iter()
        .map(|row| PdfExportJobSignal {
          id: row.get("id"),
          status: row.get("status"),
          started_at: row.try_get("started_at").unwrap_or(None),
          finished_at: row.try_get("finished_at").unwrap_or(None),
          error_class: row.try_get("error_class").unwrap_or(None),
          page_count: row.try_get("page_count").unwrap_or(None),
          created_at: row.get("created_at"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self, options_hash), err)]
  async fn find_recent_matching(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    options_hash: &str,
    requested_by: Uuid,
  ) -> RepoResult<Option<PdfExportJob>> {
    let sql = format!(
      "SELECT {} FROM pdf_export_jobs WHERE workspace_id = $1 AND doc_id = $2 AND options_hash = $3 \
       AND requested_by = $4 AND created_at > NOW() - INTERVAL '60 seconds' \
       AND status::TEXT != 'failed' ORDER BY created_at DESC LIMIT 1",
      Self::JOB_COLUMNS
    );
    let row = sqlx::query(&sql)
      .bind(workspace_id)
      .bind(doc_id)
      .bind(options_hash)
      .bind(requested_by)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_error)?;
    Ok(row.as_ref().map(Self::map_job))
  }

  #[instrument(skip(self, idempotency_key), err)]
  async fn find_recent_latest(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    template_id: &str,
    requested_by: Uuid,
    idempotency_key: &str,
  ) -> RepoResult<Option<PdfExportJob>> {
    let sql = format!(
      "SELECT {} FROM pdf_export_jobs WHERE workspace_id = $1 AND doc_id = $2 AND template_id = $3 \
       AND requested_by = $4 AND render_inputs->>'document_version_selector' = 'latest' \
       AND render_inputs->>'latest_idempotency_key' = $5 AND created_at > NOW() - INTERVAL '60 seconds' \
       AND status::TEXT != 'failed' ORDER BY created_at DESC LIMIT 1",
      Self::JOB_COLUMNS
    );
    let row = sqlx::query(&sql)
      .bind(workspace_id)
      .bind(doc_id)
      .bind(template_id)
      .bind(requested_by)
      .bind(idempotency_key)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_error)?;
    Ok(row.as_ref().map(Self::map_job))
  }

  #[instrument(skip(self), err)]
  async fn count_active_for_workspace(&self, workspace_id: Uuid) -> RepoResult<i64> {
    sqlx::query_scalar(
      "SELECT COUNT(*) FROM pdf_export_jobs WHERE workspace_id = $1 \
       AND status::TEXT IN ('queued', 'running') AND created_at > NOW() - INTERVAL '1 hour'",
    )
    .bind(workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_error)
  }

  #[instrument(skip(self, input), err)]
  async fn insert_completed(&self, input: &CompletedPdfExportJobInsert) -> RepoResult<PdfExportJob> {
    let unmapped = serde_json::to_value(&input.unmapped_font_families)
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let mut tx = self.pool.begin().await.map_err(Self::map_error)?;
    crate::mcp_idempotency::lock_document_write(&mut tx, Some(input.job.requested_by))
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let sql = format!(
      "INSERT INTO pdf_export_jobs (id, workspace_id, doc_id, requested_by, template_id, render_inputs, \
       options_hash, status, sync_or_async, output_blob_id, page_count, unmapped_font_families, \
       started_at, finished_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'done', 'sync', \
       $8, $9, $10, NOW(), NOW(), NOW() + INTERVAL '24 hours') RETURNING {}",
      Self::JOB_COLUMNS
    );
    let row = sqlx::query(&sql)
      .bind(input.job.id)
      .bind(input.job.workspace_id)
      .bind(input.job.doc_id)
      .bind(input.job.requested_by)
      .bind(&input.job.template_id)
      .bind(&input.job.render_inputs)
      .bind(&input.job.options_hash)
      .bind(input.output_blob_id)
      .bind(input.page_count)
      .bind(unmapped)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_error)?;
    let job = Self::map_job(&row);
    crate::mcp_idempotency::commit_document_write(
      &mut tx,
      myoxus_application::mcp::McpDocumentWriteCommit::PdfExport(&job),
    )
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    tx.commit().await.map_err(Self::map_error)?;
    Ok(job)
  }

  #[instrument(skip(self, input), err)]
  async fn insert_queued(&self, input: &PdfExportJobInsert) -> RepoResult<PdfExportJob> {
    let mut tx = self.pool.begin().await.map_err(Self::map_error)?;
    crate::mcp_idempotency::lock_document_write(&mut tx, Some(input.requested_by))
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let sql = format!(
      "INSERT INTO pdf_export_jobs (id, workspace_id, doc_id, requested_by, template_id, render_inputs, \
       options_hash, status, sync_or_async) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 'async') RETURNING {}",
      Self::JOB_COLUMNS
    );
    let row = sqlx::query(&sql)
      .bind(input.id)
      .bind(input.workspace_id)
      .bind(input.doc_id)
      .bind(input.requested_by)
      .bind(&input.template_id)
      .bind(&input.render_inputs)
      .bind(&input.options_hash)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_error)?;
    let job = Self::map_job(&row);
    crate::mcp_idempotency::commit_document_write(
      &mut tx,
      myoxus_application::mcp::McpDocumentWriteCommit::PdfExport(&job),
    )
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    tx.commit().await.map_err(Self::map_error)?;
    Ok(job)
  }

  #[instrument(skip(self, detail), err)]
  async fn cancel_queued(&self, id: Uuid, detail: &str) -> RepoResult<Option<PdfExportJobCancellation>> {
    let row = sqlx::query(
      "UPDATE pdf_export_jobs SET status = 'failed', error_class = 'Cancelled', error_detail = $2, \
       finished_at = NOW() WHERE id = $1 AND status = 'queued' \
       RETURNING workspace_id, doc_id, template_id, requested_by",
    )
    .bind(id)
    .bind(detail)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(row.map(|row| PdfExportJobCancellation {
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      template_id: row.get("template_id"),
      requested_by: row.get("requested_by"),
    }))
  }

  #[instrument(skip(self, detail), err)]
  async fn mark_enqueue_failed(&self, id: Uuid, detail: &str) -> RepoResult<()> {
    sqlx::query(
      "UPDATE pdf_export_jobs SET status = 'failed', error_class = 'EnqueueError', \
       error_detail = $2, finished_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .bind(detail)
    .execute(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn claim_queued(&self, id: Uuid) -> RepoResult<Option<DateTime<Utc>>> {
    sqlx::query_scalar(
      "UPDATE pdf_export_jobs SET status = 'running', started_at = NOW() \
       WHERE id = $1 AND status = 'queued' RETURNING created_at",
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_error)
  }

  #[instrument(skip(self, completion), err)]
  async fn complete(&self, completion: &PdfExportJobCompletion) -> RepoResult<()> {
    let unmapped = serde_json::to_value(&completion.unmapped_font_families)
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    sqlx::query(
      "UPDATE pdf_export_jobs SET status = 'done', output_blob_id = $2, page_count = $3, \
       unmapped_font_families = $4, render_inputs = jsonb_set(render_inputs, '{renderer_diagnostics}', $5), \
       finished_at = NOW(), expires_at = NOW() + INTERVAL '24 hours' \
       WHERE id = $1",
    )
    .bind(completion.id)
    .bind(completion.output_blob_id)
    .bind(completion.page_count)
    .bind(unmapped)
    .bind(&completion.renderer_diagnostics)
    .execute(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(())
  }

  #[instrument(skip(self, error_detail, renderer_diagnostics), err)]
  async fn fail(
    &self,
    id: Uuid,
    error_class: &str,
    error_detail: &str,
    renderer_diagnostics: Option<&serde_json::Value>,
  ) -> RepoResult<()> {
    sqlx::query(
      "UPDATE pdf_export_jobs SET status = 'failed', error_class = $2, error_detail = $3, finished_at = NOW(), \
       render_inputs = CASE WHEN $4::jsonb IS NULL THEN render_inputs \
         ELSE jsonb_set(render_inputs, '{renderer_diagnostics}', $4) END WHERE id = $1",
    )
    .bind(id)
    .bind(error_class)
    .bind(error_detail)
    .bind(renderer_diagnostics)
    .execute(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(())
  }

  async fn reap_stalled(&self, stalled_after_seconds: i64) -> RepoResult<u64> {
    let result = sqlx::query(
      "UPDATE pdf_export_jobs SET status = 'failed', error_class = 'Stalled', \
       error_detail = 'worker crashed mid-render — reaped by nightly sweep', finished_at = NOW() \
       WHERE status = 'running' AND started_at IS NOT NULL \
         AND started_at < NOW() - make_interval(secs => $1)",
    )
    .bind(stalled_after_seconds as f64)
    .execute(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(result.rows_affected())
  }

  async fn list_expired(&self, limit: i64) -> RepoResult<Vec<ExpiredPdfExportJob>> {
    let rows = sqlx::query(
      "SELECT id, workspace_id, output_blob_id FROM pdf_export_jobs \
       WHERE expires_at IS NOT NULL AND expires_at < NOW() LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_error)?;
    Ok(
      rows
        .into_iter()
        .map(|row| ExpiredPdfExportJob {
          id: row.get("id"),
          workspace_id: row.get("workspace_id"),
          output_blob_id: row.try_get("output_blob_id").unwrap_or(None),
        })
        .collect(),
    )
  }

  async fn delete_expired(&self, ids: &[Uuid]) -> RepoResult<u64> {
    if ids.is_empty() {
      return Ok(0);
    }
    let result = sqlx::query("DELETE FROM pdf_export_jobs WHERE id = ANY($1)")
      .bind(ids)
      .execute(&self.pool)
      .await
      .map_err(Self::map_error)?;
    Ok(result.rows_affected())
  }
}
