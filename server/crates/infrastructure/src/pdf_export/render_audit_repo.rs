// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed implementation of [`PdfExportRenderAuditRepository`]
//! (`P-PDF-TPL-AUDIT-01-01..04`).
//!
//! The render-audit log is on the synchronous critical path of every
//! `start_pdf_export` mutation — a DB failure here aborts the render so
//! a missing audit entry never goes unnoticed. The repository
//! deliberately keeps the surface small: insert, two narrow listing
//! queries, and a CLI-driven purge. Render audit entries are immutable;
//! no update/delete-one methods exist.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use tracing::{debug, error, instrument};
use uuid::Uuid;

use myoxus_domain::entities::PdfExportRenderAudit;
use myoxus_domain::repositories::{PdfExportRenderAuditRepository, RepoResult, RepositoryError};

#[derive(Debug, Clone)]
pub struct PgPdfExportRenderAuditRepository {
  pool: PgPool,
}

impl PgPdfExportRenderAuditRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in pdf export render audit repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("pdf_export_render_audit"),
      sqlx::Error::Database(ref dbe) if dbe.code().as_deref() == Some("23503") => {
        RepositoryError::Conflict("pdf_export_render_audit FK violation")
      }
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> PdfExportRenderAudit {
    PdfExportRenderAudit {
      id: row.get("id"),
      job_id: row.get("job_id"),
      actor_id: row.get("actor_id"),
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      doc_version_label: row.get("doc_version_label"),
      document_version_id: row.get("document_version_id"),
      template_id: row.get("template_id"),
      template_version: row.get("template_version"),
      render_appearance_hash: row.get("render_appearance_hash"),
      locale: row.get("locale"),
      classification: row.get("classification"),
      l3_inputs: row.get("l3_inputs"),
      document_metadata_snapshot: row.get("document_metadata_snapshot"),
      metadata_validation: row.get("metadata_validation"),
      created_at: row.get("created_at"),
    }
  }
}

#[async_trait]
impl PdfExportRenderAuditRepository for PgPdfExportRenderAuditRepository {
  #[instrument(skip(self, entry), fields(job_id = %entry.job_id, actor_id = %entry.actor_id), err)]
  async fn record(&self, entry: &PdfExportRenderAudit) -> RepoResult<()> {
    // Allow the caller to leave id + created_at at sentinel values
    // (`Uuid::nil`, default timestamp) and let the DB defaults fill them.
    let id = if entry.id.is_nil() { Uuid::new_v4() } else { entry.id };
    sqlx::query(
      r#"
      INSERT INTO pdf_export_render_audit
          (id, job_id, actor_id, workspace_id, doc_id, doc_version_label,
           template_id, template_version, render_appearance_hash,
           locale, classification, l3_inputs, document_version_id,
           document_metadata_snapshot, metadata_validation, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
              $13, $14, $15, COALESCE($16, now()))
      "#,
    )
    .bind(id)
    .bind(entry.job_id)
    .bind(entry.actor_id)
    .bind(entry.workspace_id)
    .bind(entry.doc_id)
    .bind(entry.doc_version_label.as_deref())
    .bind(entry.template_id)
    .bind(&entry.template_version)
    .bind(&entry.render_appearance_hash)
    .bind(&entry.locale)
    .bind(entry.classification.as_deref())
    .bind(&entry.l3_inputs)
    .bind(entry.document_version_id)
    .bind(&entry.document_metadata_snapshot)
    .bind(&entry.metadata_validation)
    .bind(if entry.created_at == DateTime::<Utc>::default() {
      None
    } else {
      Some(entry.created_at)
    })
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    debug!(audit_id = %id, job_id = %entry.job_id, "render audit row written");
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn list_for_workspace(&self, workspace_id: Uuid, limit: i64) -> RepoResult<Vec<PdfExportRenderAudit>> {
    let rows = sqlx::query(
      r#"
      SELECT id, job_id, actor_id, workspace_id, doc_id, doc_version_label, document_version_id,
             template_id, template_version, render_appearance_hash,
             locale, classification, l3_inputs, document_metadata_snapshot,
             metadata_validation, created_at
      FROM pdf_export_render_audit
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT $2
      "#,
    )
    .bind(workspace_id)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn list_for_actor(&self, actor_id: Uuid, limit: i64) -> RepoResult<Vec<PdfExportRenderAudit>> {
    let rows = sqlx::query(
      r#"
      SELECT id, job_id, actor_id, workspace_id, doc_id, doc_version_label, document_version_id,
             template_id, template_version, render_appearance_hash,
             locale, classification, l3_inputs, document_metadata_snapshot,
             metadata_validation, created_at
      FROM pdf_export_render_audit
      WHERE actor_id = $1
      ORDER BY created_at DESC
      LIMIT $2
      "#,
    )
    .bind(actor_id)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn purge_before(&self, before: DateTime<Utc>) -> RepoResult<u64> {
    let result = sqlx::query("DELETE FROM pdf_export_render_audit WHERE created_at < $1")
      .bind(before)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(result.rows_affected())
  }
}
