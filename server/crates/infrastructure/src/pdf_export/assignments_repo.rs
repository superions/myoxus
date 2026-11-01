// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed implementation of [`PdfWorkspaceTemplateAssignmentRepository`].
//!
//! `set_default` is the critical path: it must atomically clear any prior
//! `is_default=true` row for the workspace before marking the target row as
//! the new default, satisfying the partial unique index `uniq_default_per_ws`.

use super::brand_repo::{lock_pdf_workspace, record_pdf_workspace_audit};
use async_trait::async_trait;
use myoxus_domain::audit::AuditActor;
use serde_json::json;
use sqlx::{PgPool, Row};
use tracing::{error, instrument};
use uuid::Uuid;

use myoxus_domain::entities::PdfWorkspaceTemplateAssignment;
use myoxus_domain::repositories::{PdfWorkspaceTemplateAssignmentRepository, RepoResult, RepositoryError};

/// PostgreSQL-backed implementation of [`PdfWorkspaceTemplateAssignmentRepository`].
#[derive(Debug, Clone)]
pub struct PgPdfWorkspaceTemplateAssignmentRepository {
  pool: PgPool,
}

impl PgPdfWorkspaceTemplateAssignmentRepository {
  /// Construct from an existing connection pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in pdf assignment repository");
    RepositoryError::Storage(err.to_string())
  }

  fn map_row(row: sqlx::postgres::PgRow) -> PdfWorkspaceTemplateAssignment {
    PdfWorkspaceTemplateAssignment {
      workspace_id: row.get("workspace_id"),
      template_id: row.get("template_id"),
      is_default: row.get("is_default"),
      assigned_by: row.get("assigned_by"),
      assigned_at: row.get("assigned_at"),
    }
  }
}

#[async_trait]
impl PdfWorkspaceTemplateAssignmentRepository for PgPdfWorkspaceTemplateAssignmentRepository {
  #[instrument(skip(self), err)]
  async fn list_for_workspace(&self, ws: Uuid) -> RepoResult<Vec<PdfWorkspaceTemplateAssignment>> {
    let rows = sqlx::query(
      r#"
      SELECT workspace_id, template_id, is_default, assigned_by, assigned_at
      FROM pdf_workspace_template_assignments
      WHERE workspace_id = $1
      ORDER BY assigned_at ASC
      "#,
    )
    .bind(ws)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn list_for_template(&self, tpl: Uuid) -> RepoResult<Vec<PdfWorkspaceTemplateAssignment>> {
    let rows = sqlx::query(
      r#"
      SELECT workspace_id, template_id, is_default, assigned_by, assigned_at
      FROM pdf_workspace_template_assignments
      WHERE template_id = $1
      ORDER BY assigned_at ASC
      "#,
    )
    .bind(tpl)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn get(&self, ws: Uuid, tpl: Uuid) -> RepoResult<Option<PdfWorkspaceTemplateAssignment>> {
    let row = sqlx::query(
      r#"
      SELECT workspace_id, template_id, is_default, assigned_by, assigned_at
      FROM pdf_workspace_template_assignments
      WHERE workspace_id = $1 AND template_id = $2
      "#,
    )
    .bind(ws)
    .bind(tpl)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self, audit_actor), err)]
  async fn assign(&self, ws: Uuid, tpl: Uuid, assigned_by: Uuid, audit_actor: Option<AuditActor>) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    lock_pdf_workspace(&mut tx, ws).await?;
    let template = sqlx::query("SELECT slug, deleted_at FROM pdf_templates WHERE id = $1 FOR SHARE")
      .bind(tpl)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(RepositoryError::NotFound("pdf_template"))?;
    if template
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("deleted_at")
      .is_some()
    {
      return Err(RepositoryError::Validation(
        "pdf template has been soft-deleted and cannot be assigned".into(),
      ));
    }
    let existed: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND template_id = $2)",
    )
    .bind(ws)
    .bind(tpl)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query("INSERT INTO pdf_workspace_template_assignments (workspace_id, template_id, is_default, assigned_by, assigned_at) VALUES ($1, $2, false, $3, now()) ON CONFLICT (workspace_id, template_id) DO NOTHING")
      .bind(ws).bind(tpl).bind(assigned_by).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    let value = json!({"workspaceId":ws.to_string(),"templateId":tpl.to_string(),"templateSlug":template.get::<String,_>("slug")});
    // Preserve assign's audit-on-no-op contract; a missing unassign remains silent.
    record_pdf_workspace_audit(
      &mut tx,
      ws,
      audit_actor,
      "pdf_workspace.assign",
      existed.then(|| value.clone()),
      Some(value),
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self, audit_actor), err)]
  async fn unassign(&self, ws: Uuid, tpl: Uuid, audit_actor: Option<AuditActor>) -> RepoResult<bool> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    match lock_pdf_workspace(&mut tx, ws).await {
      Err(RepositoryError::NotFound("workspace")) => return Ok(false),
      other => other?,
    }
    let existing: Option<bool> = sqlx::query_scalar("SELECT is_default FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND template_id = $2 FOR UPDATE")
      .bind(ws).bind(tpl).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    let Some(is_default) = existing else {
      return Ok(false);
    };
    let default: Option<Uuid> = sqlx::query_scalar("SELECT default_template_id FROM pdf_export_settings WHERE scope = 'global' OR workspace_id = $1 ORDER BY CASE WHEN scope = 'workspace' THEN 0 ELSE 1 END LIMIT 1")
      .bind(ws).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.flatten();
    if is_default || default == Some(tpl) {
      return Err(RepositoryError::Validation(
        "cannot unassign the workspace default pdf template — set a different default first".into(),
      ));
    }
    sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND template_id = $2")
      .bind(ws)
      .bind(tpl)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    record_pdf_workspace_audit(
      &mut tx,
      ws,
      audit_actor,
      "pdf_workspace.unassign",
      Some(json!({"workspaceId":ws.to_string(),"templateId":tpl.to_string()})),
      None,
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(true)
  }

  /// Both default owners and their audit commit under the workspace lock.
  #[instrument(skip(self, audit_actor), err)]
  async fn set_default(
    &self,
    ws: Uuid,
    tpl: Uuid,
    updated_by: Uuid,
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    lock_pdf_workspace(&mut tx, ws).await?;
    let assigned: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND template_id = $2)",
    )
    .bind(ws)
    .bind(tpl)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if !assigned {
      return Err(RepositoryError::NotFound("pdf_workspace_template_assignment"));
    }
    let before = sqlx::query("SELECT default_template_id, default_paper_size, default_locale, default_color_profile_id, default_image_quality, ligatures_enabled FROM pdf_export_settings WHERE scope = 'global' OR workspace_id = $1 ORDER BY CASE WHEN scope = 'workspace' THEN 0 ELSE 1 END LIMIT 1")
      .bind(ws).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    let assignment_default: Option<Uuid> = sqlx::query_scalar(
      "SELECT template_id FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND is_default = true",
    )
    .bind(ws)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    // An assigned default can exist before the workspace settings row.
    let previous = assignment_default.or_else(|| {
      before
        .as_ref()
        .and_then(|row| row.get::<Option<Uuid>, _>("default_template_id"))
    });
    sqlx::query(
      "UPDATE pdf_workspace_template_assignments SET is_default = false WHERE workspace_id = $1 AND is_default = true",
    )
    .bind(ws)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query(
      "UPDATE pdf_workspace_template_assignments SET is_default = true WHERE workspace_id = $1 AND template_id = $2",
    )
    .bind(ws)
    .bind(tpl)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query("INSERT INTO pdf_export_settings (scope, workspace_id, default_template_id, default_paper_size, default_locale, default_color_profile_id, default_image_quality, ligatures_enabled, updated_at, updated_by) VALUES ('workspace', $1, $2, $3, $4, $5, $6, $7, now(), $8) ON CONFLICT (workspace_id) WHERE scope = 'workspace' DO UPDATE SET default_template_id = EXCLUDED.default_template_id, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by")
      .bind(ws).bind(tpl)
      .bind(before.as_ref().and_then(|row| row.get::<Option<String>, _>("default_paper_size")))
      .bind(before.as_ref().and_then(|row| row.get::<Option<String>, _>("default_locale")))
      .bind(before.as_ref().and_then(|row| row.get::<Option<Uuid>, _>("default_color_profile_id")))
      .bind(before.as_ref().and_then(|row| row.get::<Option<String>, _>("default_image_quality")))
      .bind(before.as_ref().map(|row| row.get::<bool, _>("ligatures_enabled")).unwrap_or(true))
      .bind(updated_by).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    record_pdf_workspace_audit(
      &mut tx,
      ws,
      audit_actor,
      "pdf_workspace.set_default",
      Some(json!({"workspaceId":ws.to_string(),"previousTemplateId":previous})),
      Some(json!({"workspaceId":ws.to_string(),"templateId":tpl.to_string()})),
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }
}
