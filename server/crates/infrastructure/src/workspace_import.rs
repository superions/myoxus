// SPDX-License-Identifier: AGPL-3.0-or-later
//! SQLx persistence for the durable workspace-import aggregate.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::workspace_export::{WorkspaceExportProvenance, WorkspaceExportProvenancePort};
use myoxus_application::workspace_import::WorkspaceImportRepository;
use myoxus_domain::ids::{UserId, WorkspaceId, WorkspaceImportId};
use myoxus_domain::workspace_import::{
  WorkspaceImportCompensation, WorkspaceImportCompensationKind, WorkspaceImportIdMapping, WorkspaceImportMappingKind,
  WorkspaceImportOperation, WorkspaceImportPart, WorkspaceImportProgressStage, WorkspaceImportRecord,
  WorkspaceImportStatus,
};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use tracing::instrument;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct PgWorkspaceImportRepository {
  pool: PgPool,
}

impl PgWorkspaceImportRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn storage(error: sqlx::Error) -> AuthError {
    if crate::auth::is_terminal_account_error(&error) {
      return AuthError::NotFound("user".into());
    }
    AuthError::Storage(error.to_string())
  }

  async fn locked_record(
    tx: &mut Transaction<'_, Postgres>,
    import_id: WorkspaceImportId,
  ) -> AuthResult<WorkspaceImportRecord> {
    let row = sqlx::query(&format!("{} WHERE id = $1 FOR UPDATE", RECORD_SELECT))
      .bind(import_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::storage)?
      .ok_or_else(|| AuthError::NotFound("workspace import".to_string()))?;
    map_record(&row)
  }

  async fn updated_record(
    tx: &mut Transaction<'_, Postgres>,
    import_id: WorkspaceImportId,
  ) -> AuthResult<WorkspaceImportRecord> {
    let row = sqlx::query(&format!("{} WHERE id = $1", RECORD_SELECT))
      .bind(import_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::storage)?;
    map_record(&row)
  }
}

#[async_trait]
impl WorkspaceExportProvenancePort for PgWorkspaceImportRepository {
  #[instrument(skip(self))]
  async fn latest_obsidian_provenance(&self, workspace_id: Uuid) -> AuthResult<Vec<WorkspaceExportProvenance>> {
    let rows = sqlx::query(
      r#"
      SELECT mapping.kind, mapping.source_id, mapping.target_id
      FROM workspace_import_id_mappings AS mapping
      JOIN workspace_imports AS import ON import.id = mapping.import_id
      WHERE import.target_workspace_id = $1
        AND import.status = 'succeeded'
        AND import.selected_format = 'obsidian_zip'
      ORDER BY import.updated_at DESC, mapping.kind, mapping.source_id
      "#,
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    let mut seen = std::collections::HashSet::new();
    Ok(
      rows
        .into_iter()
        .filter_map(|row| {
          let kind: String = row.get("kind");
          let target_id = row.get::<Uuid, _>("target_id").to_string();
          seen
            .insert((kind.clone(), target_id.clone()))
            .then(|| WorkspaceExportProvenance {
              kind,
              source_path: row.get("source_id"),
              target_id,
            })
        })
        .collect(),
    )
  }
}

const RECORD_SELECT: &str = r#"
  SELECT id, actor_id, status, selected_format, staging_object_key, source_hash,
         source_size_bytes, config_fingerprint, preview, target_workspace_id,
         queued_operation, progress_stage, progress_current, progress_total,
         cancel_requested, error_code, error_message, created_at, updated_at,
         expires_at
  FROM workspace_imports
"#;

const RECORD_COLUMNS: &str = r#"id, actor_id, status, selected_format, staging_object_key, source_hash,
         source_size_bytes, config_fingerprint, preview, target_workspace_id,
         queued_operation, progress_stage, progress_current, progress_total,
         cancel_requested, error_code, error_message, created_at, updated_at,
         expires_at"#;

fn status(value: &str) -> AuthResult<WorkspaceImportStatus> {
  match value {
    "staged" => Ok(WorkspaceImportStatus::Staged),
    "previewed" => Ok(WorkspaceImportStatus::Previewed),
    "queued" => Ok(WorkspaceImportStatus::Queued),
    "running" => Ok(WorkspaceImportStatus::Running),
    "succeeded" => Ok(WorkspaceImportStatus::Succeeded),
    "failed" => Ok(WorkspaceImportStatus::Failed),
    "cancelled" => Ok(WorkspaceImportStatus::Cancelled),
    "cleanup_required" => Ok(WorkspaceImportStatus::CleanupRequired),
    "expired" => Ok(WorkspaceImportStatus::Expired),
    _ => Err(AuthError::Storage(
      "workspace import contains an invalid status".to_string(),
    )),
  }
}

fn operation(value: Option<String>) -> AuthResult<Option<WorkspaceImportOperation>> {
  value
    .map(|value| match value.as_str() {
      "preview" => Ok(WorkspaceImportOperation::Preview),
      "apply" => Ok(WorkspaceImportOperation::Apply),
      "cleanup" => Ok(WorkspaceImportOperation::Cleanup),
      _ => Err(AuthError::Storage(
        "workspace import contains an invalid operation".to_string(),
      )),
    })
    .transpose()
}

fn progress_stage(value: Option<String>) -> AuthResult<Option<WorkspaceImportProgressStage>> {
  value
    .map(|value| match value.as_str() {
      "validation" => Ok(WorkspaceImportProgressStage::Validation),
      "document_decode" => Ok(WorkspaceImportProgressStage::DocumentDecode),
      "asset_planning" => Ok(WorkspaceImportProgressStage::AssetPlanning),
      "database_planning" => Ok(WorkspaceImportProgressStage::DatabasePlanning),
      "target_creation" => Ok(WorkspaceImportProgressStage::TargetCreation),
      "document_materialization" => Ok(WorkspaceImportProgressStage::DocumentMaterialization),
      "database_materialization" => Ok(WorkspaceImportProgressStage::DatabaseMaterialization),
      "reference_rewrite" => Ok(WorkspaceImportProgressStage::ReferenceRewrite),
      "final_validation" => Ok(WorkspaceImportProgressStage::FinalValidation),
      "publication" => Ok(WorkspaceImportProgressStage::Publication),
      "compensation" => Ok(WorkspaceImportProgressStage::Compensation),
      _ => Err(AuthError::Storage(
        "workspace import contains an invalid progress stage".to_string(),
      )),
    })
    .transpose()
}

fn map_record(row: &sqlx::postgres::PgRow) -> AuthResult<WorkspaceImportRecord> {
  Ok(WorkspaceImportRecord {
    id: row.get("id"),
    actor_id: row.get("actor_id"),
    status: status(row.get::<String, _>("status").as_str())?,
    selected_format: row.get("selected_format"),
    staging_object_key: row.get("staging_object_key"),
    source_hash: row.get("source_hash"),
    source_size_bytes: row.get("source_size_bytes"),
    config_fingerprint: row.get("config_fingerprint"),
    preview: row.get("preview"),
    target_workspace_id: row.get("target_workspace_id"),
    queued_operation: operation(row.get("queued_operation"))?,
    progress_stage: progress_stage(row.get("progress_stage"))?,
    progress_current: row.get("progress_current"),
    progress_total: row.get("progress_total"),
    cancel_requested: row.get("cancel_requested"),
    error_code: row.get("error_code"),
    error_message: row.get("error_message"),
    created_at: row.get("created_at"),
    updated_at: row.get("updated_at"),
    expires_at: row.get("expires_at"),
  })
}

fn map_part(row: &sqlx::postgres::PgRow) -> WorkspaceImportPart {
  WorkspaceImportPart {
    import_id: row.get("import_id"),
    part_number: row.get("part_number"),
    object_key: row.get("object_key"),
    size_bytes: row.get("size_bytes"),
    content_hash: row.get("content_hash"),
    created_at: row.get("created_at"),
  }
}

fn mapping_kind(value: &str) -> AuthResult<WorkspaceImportMappingKind> {
  match value {
    "workspace" => Ok(WorkspaceImportMappingKind::Workspace),
    "document" => Ok(WorkspaceImportMappingKind::Document),
    "database" => Ok(WorkspaceImportMappingKind::Database),
    "view" => Ok(WorkspaceImportMappingKind::View),
    "field" => Ok(WorkspaceImportMappingKind::Field),
    "row" => Ok(WorkspaceImportMappingKind::Row),
    "asset" => Ok(WorkspaceImportMappingKind::Asset),
    _ => Err(AuthError::Storage(
      "workspace import contains an invalid mapping kind".to_string(),
    )),
  }
}

fn compensation_kind(value: &str) -> AuthResult<WorkspaceImportCompensationKind> {
  match value {
    "workspace" => Ok(WorkspaceImportCompensationKind::Workspace),
    "document" => Ok(WorkspaceImportCompensationKind::Document),
    "database" => Ok(WorkspaceImportCompensationKind::Database),
    "asset" => Ok(WorkspaceImportCompensationKind::Asset),
    _ => Err(AuthError::Storage(
      "workspace import contains an invalid compensation kind".to_string(),
    )),
  }
}

fn map_compensation(row: &sqlx::postgres::PgRow) -> AuthResult<WorkspaceImportCompensation> {
  Ok(WorkspaceImportCompensation {
    id: row.get("id"),
    import_id: row.get("import_id"),
    sequence: row.get("sequence"),
    kind: compensation_kind(row.get::<String, _>("kind").as_str())?,
    target_id: row.get("target_id"),
    completed_at: row.get("completed_at"),
    last_error: row.get("last_error"),
    created_at: row.get("created_at"),
  })
}

#[async_trait]
impl WorkspaceImportRepository for PgWorkspaceImportRepository {
  #[instrument(skip(self, record), fields(import_id = %record.id, actor_id = %record.actor_id))]
  async fn create(&self, record: WorkspaceImportRecord) -> AuthResult<WorkspaceImportRecord> {
    sqlx::query(
      r#"
      INSERT INTO workspace_imports (
        id, actor_id, status, selected_format, staging_object_key, source_hash,
        source_size_bytes, config_fingerprint, preview, target_workspace_id,
        queued_operation, progress_stage, progress_current, progress_total,
        cancel_requested, error_code, error_message, created_at, updated_at,
        expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20
      )
      "#,
    )
    .bind(record.id)
    .bind(record.actor_id)
    .bind(record.status.as_str())
    .bind(&record.selected_format)
    .bind(&record.staging_object_key)
    .bind(&record.source_hash)
    .bind(record.source_size_bytes)
    .bind(&record.config_fingerprint)
    .bind(&record.preview)
    .bind(record.target_workspace_id)
    .bind(record.queued_operation.map(WorkspaceImportOperation::as_str))
    .bind(record.progress_stage.map(WorkspaceImportProgressStage::as_str))
    .bind(record.progress_current)
    .bind(record.progress_total)
    .bind(record.cancel_requested)
    .bind(&record.error_code)
    .bind(&record.error_message)
    .bind(record.created_at)
    .bind(record.updated_at)
    .bind(record.expires_at)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?;
    Ok(record)
  }

  async fn get(&self, import_id: WorkspaceImportId) -> AuthResult<Option<WorkspaceImportRecord>> {
    let row = sqlx::query(&format!("{} WHERE id = $1", RECORD_SELECT))
      .bind(import_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::storage)?;
    row.as_ref().map(map_record).transpose()
  }

  async fn get_for_actor(
    &self,
    import_id: WorkspaceImportId,
    actor_id: UserId,
  ) -> AuthResult<Option<WorkspaceImportRecord>> {
    let row = sqlx::query(&format!("{} WHERE id = $1 AND actor_id = $2", RECORD_SELECT))
      .bind(import_id)
      .bind(actor_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::storage)?;
    row.as_ref().map(map_record).transpose()
  }

  #[instrument(skip(self, part), fields(import_id = %part.import_id, part_number = part.part_number))]
  async fn upsert_part(&self, actor_id: UserId, part: WorkspaceImportPart) -> AuthResult<WorkspaceImportPart> {
    let row = sqlx::query(
      r#"
      INSERT INTO workspace_import_parts (import_id, part_number, object_key, size_bytes, content_hash)
      SELECT $1, $2, $3, $4, $5
      FROM workspace_imports
      WHERE id = $1 AND actor_id = $6 AND status = 'staged'
      ON CONFLICT (import_id, part_number) DO UPDATE SET
        object_key = EXCLUDED.object_key,
        size_bytes = EXCLUDED.size_bytes,
        content_hash = EXCLUDED.content_hash
      WHERE workspace_import_parts.object_key = EXCLUDED.object_key
        AND workspace_import_parts.size_bytes = EXCLUDED.size_bytes
        AND workspace_import_parts.content_hash = EXCLUDED.content_hash
      RETURNING import_id, part_number, object_key, size_bytes, content_hash, created_at
      "#,
    )
    .bind(part.import_id)
    .bind(part.part_number)
    .bind(&part.object_key)
    .bind(part.size_bytes)
    .bind(&part.content_hash)
    .bind(actor_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::InvalidInput("workspace import part conflicts with durable staging state".to_string()))?;
    Ok(map_part(&row))
  }

  async fn list_parts(&self, import_id: WorkspaceImportId) -> AuthResult<Vec<WorkspaceImportPart>> {
    let rows = sqlx::query(
      r#"
      SELECT import_id, part_number, object_key, size_bytes, content_hash, created_at
      FROM workspace_import_parts WHERE import_id = $1 ORDER BY part_number
      "#,
    )
    .bind(import_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    Ok(rows.iter().map(map_part).collect())
  }

  async fn complete_upload(
    &self,
    import_id: WorkspaceImportId,
    actor_id: UserId,
    source_size_bytes: i64,
    source_hash: &str,
  ) -> AuthResult<WorkspaceImportRecord> {
    let row = sqlx::query(&format!(
      r#"
      UPDATE workspace_imports SET
        source_size_bytes = $3, source_hash = $4, updated_at = now()
      WHERE id = $1 AND actor_id = $2 AND status = 'staged'
        AND (source_hash = '' OR (source_hash = $4 AND source_size_bytes = $3))
      RETURNING {}
      "#,
      RECORD_COLUMNS
    ))
    .bind(import_id)
    .bind(actor_id)
    .bind(source_size_bytes)
    .bind(source_hash)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::InvalidInput("workspace import upload cannot be completed".to_string()))?;
    map_record(&row)
  }

  #[instrument(skip(self), fields(import_id = %import_id, operation = operation.as_str()))]
  async fn queue_operation(
    &self,
    import_id: WorkspaceImportId,
    actor_id: Option<UserId>,
    operation: WorkspaceImportOperation,
  ) -> AuthResult<(WorkspaceImportRecord, bool)> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let record = Self::locked_record(&mut tx, import_id).await?;
    if actor_id.is_some_and(|actor_id| actor_id != record.actor_id) {
      return Err(AuthError::ActionForbidden);
    }
    // Operator cleanup is an idempotent recovery action. Once compensation
    // completed, a repeated CLI/Admin request returns the durable failed
    // projection without enqueueing another job or reopening terminal state.
    if operation == WorkspaceImportOperation::Cleanup && record.status == WorkspaceImportStatus::Failed {
      tx.commit().await.map_err(Self::storage)?;
      return Ok((record, false));
    }
    if record.queued_operation == Some(operation)
      && matches!(
        record.status,
        WorkspaceImportStatus::Queued | WorkspaceImportStatus::Running
      )
    {
      tx.commit().await.map_err(Self::storage)?;
      return Ok((record, false));
    }
    let allowed = match operation {
      WorkspaceImportOperation::Preview => {
        record.status == WorkspaceImportStatus::Staged
          || (record.status == WorkspaceImportStatus::Failed && record.preview.is_none())
      }
      WorkspaceImportOperation::Apply => {
        record.status == WorkspaceImportStatus::Previewed
          || (record.status == WorkspaceImportStatus::Failed && record.preview.is_some())
      }
      WorkspaceImportOperation::Cleanup => record.status == WorkspaceImportStatus::CleanupRequired,
    };
    if !allowed || !record.status.can_transition_to(WorkspaceImportStatus::Queued) {
      return Err(AuthError::InvalidInput(format!(
        "workspace import operation {} is invalid from {}",
        operation.as_str(),
        record.status.as_str()
      )));
    }
    if operation == WorkspaceImportOperation::Preview && record.source_hash.is_empty() {
      return Err(AuthError::InvalidInput(
        "workspace import upload is incomplete".to_string(),
      ));
    }
    if operation == WorkspaceImportOperation::Apply
      && !record
        .preview
        .as_ref()
        .and_then(|preview| preview.get("applyAllowed"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
      return Err(AuthError::InvalidInput(
        "workspace import preview blocks apply".to_string(),
      ));
    }
    sqlx::query(
      r#"
      UPDATE workspace_imports SET status = 'queued', queued_operation = $2,
        cancel_requested = false, error_code = NULL, error_message = NULL,
        progress_stage = NULL, progress_stage_rank = 0,
        progress_current = 0, progress_total = 0,
        updated_at = now()
      WHERE id = $1
      "#,
    )
    .bind(import_id)
    .bind(operation.as_str())
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    let record = Self::updated_record(&mut tx, import_id).await?;
    tx.commit().await.map_err(Self::storage)?;
    Ok((record, true))
  }

  async fn restore_after_enqueue_failure(
    &self,
    import_id: WorkspaceImportId,
    operation: WorkspaceImportOperation,
  ) -> AuthResult<()> {
    let restored_status = match operation {
      WorkspaceImportOperation::Preview => "staged",
      WorkspaceImportOperation::Apply => "previewed",
      WorkspaceImportOperation::Cleanup => "cleanup_required",
    };
    let result = sqlx::query(
      r#"
      UPDATE workspace_imports SET status = $3, queued_operation = NULL,
        progress_stage = NULL, progress_stage_rank = 0,
        progress_current = 0, progress_total = 0, updated_at = now()
      WHERE id = $1 AND status = 'queued' AND queued_operation = $2
      "#,
    )
    .bind(import_id)
    .bind(operation.as_str())
    .bind(restored_status)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?;
    if result.rows_affected() != 1 {
      return Err(AuthError::InvalidInput(
        "workspace import enqueue failure could not restore durable state".to_string(),
      ));
    }
    Ok(())
  }

  async fn claim_operation(
    &self,
    import_id: WorkspaceImportId,
    operation: WorkspaceImportOperation,
  ) -> AuthResult<WorkspaceImportRecord> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let record = Self::locked_record(&mut tx, import_id).await?;
    if matches!(
      (operation, record.status),
      (WorkspaceImportOperation::Preview, WorkspaceImportStatus::Previewed)
        | (WorkspaceImportOperation::Apply, WorkspaceImportStatus::Succeeded)
        | (WorkspaceImportOperation::Cleanup, WorkspaceImportStatus::Failed)
        | (_, WorkspaceImportStatus::Cancelled)
    ) {
      tx.commit().await.map_err(Self::storage)?;
      return Ok(record);
    }
    if record.queued_operation != Some(operation) {
      return Err(AuthError::InvalidInput(
        "workspace import worker operation does not match durable state".to_string(),
      ));
    }
    if record.status == WorkspaceImportStatus::Running {
      tx.commit().await.map_err(Self::storage)?;
      return Ok(record);
    }
    if record.status != WorkspaceImportStatus::Queued {
      return Err(AuthError::InvalidInput("workspace import is not queued".to_string()));
    }
    sqlx::query("UPDATE workspace_imports SET status = 'running', updated_at = now() WHERE id = $1")
      .bind(import_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
    let record = Self::updated_record(&mut tx, import_id).await?;
    tx.commit().await.map_err(Self::storage)?;
    Ok(record)
  }

  async fn prepare_operation_replay(
    &self,
    import_id: WorkspaceImportId,
    operation: WorkspaceImportOperation,
  ) -> AuthResult<()> {
    let result = sqlx::query(
      r#"
      UPDATE workspace_imports SET progress_stage = NULL, progress_stage_rank = 0,
        progress_current = 0, progress_total = 0, updated_at = now()
      WHERE id = $1 AND status = 'running' AND queued_operation = $2
        AND (
          $2 <> 'apply'
          OR NOT EXISTS (
            SELECT 1 FROM workspace_import_compensations
            WHERE import_id = $1 AND completed_at IS NULL
          )
        )
      "#,
    )
    .bind(import_id)
    .bind(operation.as_str())
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?;
    if result.rows_affected() != 1 {
      return Err(AuthError::InvalidInput(
        "workspace import retry cannot replay before compensation completes".to_string(),
      ));
    }
    Ok(())
  }

  async fn store_preview(&self, import_id: WorkspaceImportId, preview: Value) -> AuthResult<WorkspaceImportRecord> {
    let row = sqlx::query(&format!(
      r#"
      UPDATE workspace_imports SET status = 'previewed', preview = $2,
        queued_operation = NULL, progress_current = progress_total,
        updated_at = now()
      WHERE id = $1 AND status = 'running' AND queued_operation = 'preview'
      RETURNING {}
      "#,
      RECORD_COLUMNS
    ))
    .bind(import_id)
    .bind(preview)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::InvalidInput("workspace import preview transition failed".to_string()))?;
    map_record(&row)
  }

  async fn mark_succeeded(
    &self,
    import_id: WorkspaceImportId,
    workspace_id: WorkspaceId,
    tags: &[myoxus_domain::workspace_tags::WorkspaceTag],
    assignments: &[(Uuid, Vec<Uuid>)],
  ) -> AuthResult<WorkspaceImportRecord> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let import = Self::locked_record(&mut tx, import_id).await?;
    if import.status != WorkspaceImportStatus::Running
      || import.queued_operation != Some(WorkspaceImportOperation::Apply)
      || import.actor_id == Uuid::nil()
    {
      return Err(AuthError::InvalidInput(
        "workspace import success transition failed".to_string(),
      ));
    }
    // Catalog and assignments become visible in the same transaction as the
    // hidden workspace. Any failure retains the existing compensation owner.
    crate::workspace_tags::PgWorkspaceTagRepository::import_tags_in_tx(
      &mut tx,
      workspace_id,
      import.actor_id,
      tags,
      assignments,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    let published = sqlx::query(
      r#"
      UPDATE workspaces
         SET lifecycle_state = 'active',
             lifecycle_owner_kind = NULL,
             lifecycle_owner_id = NULL,
             updated_at = now()
       WHERE id = $1
         AND owner_user_id = $2
         AND lifecycle_state = 'importing'
         AND lifecycle_owner_kind = 'import'
         AND lifecycle_owner_id = $3
         AND deleted_at IS NULL
      "#,
    )
    .bind(workspace_id)
    .bind(import.actor_id)
    .bind(import_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    if published.rows_affected() != 1 {
      return Err(AuthError::InvalidInput(
        "workspace import target cannot be published".to_string(),
      ));
    }
    sqlx::query(
      r#"
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
      VALUES ($1, $2, 'Owner', 'Accepted', now())
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'Owner', status = 'Accepted'
      "#,
    )
    .bind(workspace_id)
    .bind(import.actor_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    sqlx::query(
      r#"
      UPDATE workspace_imports SET status = 'succeeded', target_workspace_id = $2,
        queued_operation = NULL, progress_stage = 'publication',
        progress_current = GREATEST(progress_total, 1), progress_total = GREATEST(progress_total, 1),
        updated_at = now()
      WHERE id = $1
      "#,
    )
    .bind(import_id)
    .bind(workspace_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    let record = Self::updated_record(&mut tx, import_id).await?;
    tx.commit().await.map_err(Self::storage)?;
    Ok(record)
  }

  async fn mark_failed(
    &self,
    import_id: WorkspaceImportId,
    error_code: &str,
    error_message: &str,
    cleanup_required: bool,
  ) -> AuthResult<WorkspaceImportRecord> {
    let target = if cleanup_required { "cleanup_required" } else { "failed" };
    let row = sqlx::query(&format!(
      r#"
      UPDATE workspace_imports SET status = $2, queued_operation = NULL,
        error_code = $3, error_message = $4, updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING {}
      "#,
      RECORD_COLUMNS
    ))
    .bind(import_id)
    .bind(target)
    .bind(error_code)
    .bind(error_message)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::InvalidInput("workspace import failure transition failed".to_string()))?;
    map_record(&row)
  }

  async fn request_cancel(&self, import_id: WorkspaceImportId, actor_id: UserId) -> AuthResult<WorkspaceImportRecord> {
    let row = sqlx::query(&format!(
      r#"
      UPDATE workspace_imports SET
        status = CASE WHEN status = 'running' THEN status ELSE 'cancelled' END,
        cancel_requested = true,
        queued_operation = CASE WHEN status = 'running' THEN queued_operation ELSE NULL END,
        updated_at = now()
      WHERE id = $1 AND actor_id = $2
        AND status IN ('staged', 'previewed', 'queued', 'running')
      RETURNING {}
      "#,
      RECORD_COLUMNS
    ))
    .bind(import_id)
    .bind(actor_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::InvalidInput("workspace import cannot be cancelled".to_string()))?;
    map_record(&row)
  }

  async fn mark_cancelled(&self, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord> {
    let row = sqlx::query(&format!(
      r#"
      UPDATE workspace_imports SET status = 'cancelled', queued_operation = NULL,
        cancel_requested = true, updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING {}
      "#,
      RECORD_COLUMNS
    ))
    .bind(import_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::InvalidInput("workspace import cancel transition failed".to_string()))?;
    map_record(&row)
  }

  async fn complete_cleanup(&self, import_id: WorkspaceImportId) -> AuthResult<WorkspaceImportRecord> {
    let row = sqlx::query(&format!(
      r#"
      UPDATE workspace_imports SET status = 'failed', queued_operation = NULL,
        error_code = 'MIX_WORKSPACE_IMPORT_APPLY_BLOCKED',
        error_message = 'workspace import failed; recovery cleanup completed',
        updated_at = now()
      WHERE id = $1 AND status = 'running' AND queued_operation = 'cleanup'
      RETURNING {}
      "#,
      RECORD_COLUMNS
    ))
    .bind(import_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::InvalidInput("workspace import cleanup transition failed".to_string()))?;
    map_record(&row)
  }

  async fn update_progress(
    &self,
    import_id: WorkspaceImportId,
    stage: WorkspaceImportProgressStage,
    current: i64,
    total: i64,
  ) -> AuthResult<()> {
    if current < 0 || total < 0 || current > total {
      return Err(AuthError::InvalidInput(
        "workspace import progress is invalid".to_string(),
      ));
    }
    let result = sqlx::query(
      r#"
      UPDATE workspace_imports SET progress_stage = $2, progress_stage_rank = $5,
        progress_current = $3, progress_total = $4, updated_at = now()
      WHERE id = $1 AND status = 'running'
        AND ($5 > progress_stage_rank OR ($5 = progress_stage_rank AND $3 >= progress_current))
      "#,
    )
    .bind(import_id)
    .bind(stage.as_str())
    .bind(current)
    .bind(total)
    .bind(stage.rank())
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?;
    if result.rows_affected() != 1 {
      return Err(AuthError::InvalidInput(
        "workspace import progress regressed or job is not running".to_string(),
      ));
    }
    Ok(())
  }

  async fn upsert_id_mappings(&self, mappings: &[WorkspaceImportIdMapping]) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    for mapping in mappings {
      let row = sqlx::query(
        r#"
        INSERT INTO workspace_import_id_mappings (import_id, kind, source_id, target_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (import_id, kind, source_id) DO UPDATE SET target_id = EXCLUDED.target_id
        WHERE workspace_import_id_mappings.target_id = EXCLUDED.target_id
        RETURNING target_id
        "#,
      )
      .bind(mapping.import_id)
      .bind(mapping.kind.as_str())
      .bind(&mapping.source_id)
      .bind(mapping.target_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::storage)?;
      if row.is_none() {
        return Err(AuthError::InvalidInput(
          "workspace import id mapping conflicts with the immutable plan".to_string(),
        ));
      }
    }
    tx.commit().await.map_err(Self::storage)
  }

  async fn list_id_mappings(&self, import_id: WorkspaceImportId) -> AuthResult<Vec<WorkspaceImportIdMapping>> {
    let rows = sqlx::query(
      r#"
      SELECT import_id, kind, source_id, target_id, created_at
      FROM workspace_import_id_mappings
      WHERE import_id = $1 ORDER BY kind, source_id
      "#,
    )
    .bind(import_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    rows
      .iter()
      .map(|row| {
        Ok(WorkspaceImportIdMapping {
          import_id: row.get("import_id"),
          kind: mapping_kind(row.get::<String, _>("kind").as_str())?,
          source_id: row.get("source_id"),
          target_id: row.get("target_id"),
          created_at: row.get("created_at"),
        })
      })
      .collect()
  }

  async fn append_compensation(
    &self,
    import_id: WorkspaceImportId,
    sequence: i64,
    kind: WorkspaceImportCompensationKind,
    target_id: &str,
  ) -> AuthResult<WorkspaceImportCompensation> {
    let row = sqlx::query(
      r#"
      INSERT INTO workspace_import_compensations (import_id, sequence, kind, target_id)
      VALUES ($1, $2, $3, $4)
        ON CONFLICT (import_id, kind, target_id) DO UPDATE SET
          completed_at = NULL, last_error = NULL
      RETURNING id, import_id, sequence, kind, target_id, completed_at, last_error, created_at
      "#,
    )
    .bind(import_id)
    .bind(sequence)
    .bind(kind.as_str())
    .bind(target_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage)?;
    map_compensation(&row)
  }

  async fn pending_compensations(&self, import_id: WorkspaceImportId) -> AuthResult<Vec<WorkspaceImportCompensation>> {
    let rows = sqlx::query(
      r#"
      SELECT id, import_id, sequence, kind, target_id, completed_at, last_error, created_at
      FROM workspace_import_compensations
      WHERE import_id = $1 AND completed_at IS NULL
      ORDER BY sequence DESC
      "#,
    )
    .bind(import_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    rows.iter().map(map_compensation).collect()
  }

  async fn complete_compensation(&self, compensation_id: i64) -> AuthResult<()> {
    sqlx::query("UPDATE workspace_import_compensations SET completed_at = now(), last_error = NULL WHERE id = $1")
      .bind(compensation_id)
      .execute(&self.pool)
      .await
      .map_err(Self::storage)?;
    Ok(())
  }

  async fn fail_compensation(&self, compensation_id: i64, redacted_error: &str) -> AuthResult<()> {
    sqlx::query("UPDATE workspace_import_compensations SET last_error = $2 WHERE id = $1")
      .bind(compensation_id)
      .bind(redacted_error)
      .execute(&self.pool)
      .await
      .map_err(Self::storage)?;
    Ok(())
  }

  async fn cleanup_required_count(&self) -> AuthResult<i64> {
    sqlx::query_scalar("SELECT count(*) FROM workspace_imports WHERE status = 'cleanup_required'")
      .fetch_one(&self.pool)
      .await
      .map_err(Self::storage)
  }

  async fn claim_retention_candidates(
    &self,
    terminal_before: DateTime<Utc>,
    limit: i64,
  ) -> AuthResult<Vec<WorkspaceImportRecord>> {
    let rows = sqlx::query(&format!(
      r#"
      WITH candidates AS (
        SELECT id
        FROM workspace_imports
        WHERE (
          (status IN ('staged', 'previewed') AND expires_at <= now())
          OR (status IN ('succeeded', 'failed', 'cancelled') AND updated_at <= $1)
          OR (status = 'expired' AND EXISTS (
            SELECT 1 FROM workspace_import_parts WHERE import_id = workspace_imports.id
          ))
        )
        ORDER BY updated_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      ), expired AS (
        UPDATE workspace_imports AS imports
        SET status = 'expired', queued_operation = NULL,
            error_code = COALESCE(imports.error_code, 'MIX_WORKSPACE_IMPORT_EXPIRED'),
            error_message = COALESCE(imports.error_message, 'workspace import staging retention expired'),
            updated_at = CASE WHEN imports.status = 'expired' THEN imports.updated_at ELSE now() END
        FROM candidates
        WHERE imports.id = candidates.id
        RETURNING imports.*
      )
      SELECT {} FROM expired
      "#,
      RECORD_COLUMNS
    ))
    .bind(terminal_before)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    rows.iter().map(map_record).collect()
  }

  async fn purge_retained_artifacts(&self, import_id: WorkspaceImportId) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let locked = Self::locked_record(&mut tx, import_id).await?;
    if locked.status != WorkspaceImportStatus::Expired {
      return Err(AuthError::InvalidInput(
        "workspace import artifacts can only be purged after expiry".to_string(),
      ));
    }
    for table in [
      "workspace_import_parts",
      "workspace_import_id_mappings",
      "workspace_import_compensations",
    ] {
      sqlx::query(&format!("DELETE FROM {table} WHERE import_id = $1"))
        .bind(import_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::storage)?;
    }
    sqlx::query("UPDATE workspace_imports SET preview = NULL WHERE id = $1")
      .bind(import_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
    tx.commit().await.map_err(Self::storage)
  }
}
