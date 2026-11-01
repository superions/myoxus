// SPDX-License-Identifier: AGPL-3.0-or-later
//! Portable import, mapping and job persistence over the existing Database repository.
mod workspace_content;

use super::*;

impl PgDatabaseRepository {
  /// Inherent helper used by the import-job repository methods below to
  /// map a single `database_import_jobs` row into the domain
  /// `DatabaseImportJobRecord`.
  fn map_import_job(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseImportJobRecord> {
    let status_str: String = row.try_get("status").map_err(Self::map_sqlx_error)?;
    let status =
      DatabaseImportJobStatus::from_db(&status_str).map_err(|err| RepositoryError::Validation(err.to_string()))?;
    let kind_str: String = row.try_get("kind").map_err(Self::map_sqlx_error)?;
    let kind = DatabaseImportJobKind::from_db(&kind_str).map_err(|err| RepositoryError::Validation(err.to_string()))?;
    Ok(DatabaseImportJobRecord {
      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
      database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
      actor_id: row.try_get("actor_id").map_err(Self::map_sqlx_error)?,
      kind,
      idempotency_key: row.try_get("idempotency_key").map_err(Self::map_sqlx_error)?,
      status,
      attempt_count: row.try_get("attempt_count").map_err(Self::map_sqlx_error)?,
      cancellation_requested_at: row.try_get("cancellation_requested_at").map_err(Self::map_sqlx_error)?,
      cancelled_at: row.try_get("cancelled_at").map_err(Self::map_sqlx_error)?,
      started_at: row.try_get("started_at").map_err(Self::map_sqlx_error)?,
      finished_at: row.try_get("finished_at").map_err(Self::map_sqlx_error)?,
      last_error_code: row.try_get("last_error_code").map_err(Self::map_sqlx_error)?,
      last_error_message: row.try_get("last_error_message").map_err(Self::map_sqlx_error)?,
      payload_summary: row.try_get("payload_summary_json").map_err(Self::map_sqlx_error)?,
      result: row.try_get("result_json").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
    })
  }
}

#[async_trait]
impl DatabaseImportExportRepository for PgDatabaseRepository {
  #[instrument(skip(self, database, fields, views, field_roles, view_roles, rows, updated_rows, row_templates, row_sources, workspace_tags, import_job_result), fields(mode = ?mode, database_id = %database.id, workspace_id = %database.workspace_id))]
  async fn apply_database_snapshot_import(
    &self,
    mode: DatabaseJsonImportMode,
    target_database_id: Option<DatabaseId>,
    target_precondition: Option<DatabaseEditPrecondition>,
    database: Database,
    fields: Vec<DatabaseField>,
    views: Vec<DatabaseView>,
    field_roles: Vec<DatabaseFieldRole>,
    view_roles: Vec<DatabaseViewRole>,
    rows: Vec<DatabaseRowRecord>,
    updated_rows: Vec<DatabaseRowRecord>,
    row_templates: Vec<DatabaseRowTemplate>,
    row_sources: Vec<(DatabaseRowId, DatabaseTaskSource)>,
    workspace_tags: Vec<myoxus_domain::workspace_tags::WorkspaceTag>,
    import_job_id: Option<DatabaseImportJobId>,
    import_job_result: Option<Value>,
  ) -> RepoResult<DatabaseRecord> {
    let mut import_job_result = import_job_result;
    let mut tx = self.begin_write().await?;
    if let Some(result) = &import_job_result {
      if !result.is_object() {
        return Err(RepositoryError::Validation(
          "prepared import result must be an object".into(),
        ));
      }
      let job_id = import_job_id
        .filter(|_| mode == DatabaseJsonImportMode::Create)
        .ok_or_else(|| RepositoryError::Validation("prepared import result requires a Create job".into()))?;
      // Serialize cancellation and duplicate delivery before allocating product
      // contents. The committed job result is the apply receipt, not readback.
      let job = sqlx::query(
        "SELECT id, workspace_id, database_id, actor_id, kind, idempotency_key, status,
                attempt_count, cancellation_requested_at, cancelled_at, started_at, finished_at,
                last_error_code, last_error_message, payload_summary_json, result_json, created_at
         FROM database_import_jobs WHERE id=$1 FOR UPDATE",
      )
      .bind(job_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .ok_or(RepositoryError::NotFound("database import job"))?;
      let job = Self::map_import_job(job)?;
      if job.workspace_id != database.workspace_id
        || job.actor_id != database.created_by
        || job.actor_id.is_none()
        || job.kind != DatabaseImportJobKind::BulkImport
      {
        return Err(RepositoryError::Validation(
          "import job does not match prepared content".into(),
        ));
      }
      if job.status == DatabaseImportJobStatus::Succeeded {
        let original_id = job
          .database_id
          .ok_or_else(|| RepositoryError::Storage("succeeded import job has no database".into()))?;
        tx.rollback().await.map_err(Self::map_sqlx_error)?;
        return self
          .get_record(original_id)
          .await?
          .ok_or(RepositoryError::NotFound("database"));
      }
      if job.status == DatabaseImportJobStatus::Cancelled || job.cancellation_requested_at.is_some() {
        return Err(RepositoryError::Validation("MIX_DATABASE_IMPORT_CANCELLED".into()));
      }
    }
    if let Some(target_id) = target_database_id {
      let precondition = target_precondition
        .ok_or_else(|| RepositoryError::Validation("replace/merge target precondition missing".into()))?;
      let actual_revision = if mode == DatabaseJsonImportMode::Merge {
        // Merge changes no Database key. FK writers may retain KEY SHARE while
        // the Parent graph is locked; FOR UPDATE would invert that ordering.
        sqlx::query_scalar("SELECT edit_revision FROM workspace_databases WHERE id=$1 FOR NO KEY UPDATE")
          .bind(target_id)
          .fetch_optional(&mut *tx)
          .await
          .map_err(Self::map_sqlx_error)?
          .ok_or(RepositoryError::NotFound("database"))?
      } else {
        Self::lock_entity_edit_revision(&mut tx, "workspace_databases", target_id, "database").await?
      };
      Self::assert_edit_precondition(actual_revision, precondition, "database edit revision")?;
      Self::assert_database_workspace(&mut tx, target_id, precondition).await?;
    } else if target_precondition.is_some() {
      return Err(RepositoryError::Validation(
        "create import must not carry a target precondition".into(),
      ));
    }
    if mode == DatabaseJsonImportMode::Merge {
      for tag in &workspace_tags {
        crate::workspace_tags::PgWorkspaceTagRepository::insert_tag_in_tx(&mut tx, tag)
          .await
          .map_err(Self::map_sqlx_error)?;
      }
    }
    let fallback_actor = database.updated_by.or(database.created_by).unwrap_or_default();
    let result_database_id = match mode {
      DatabaseJsonImportMode::Create => {
        let database_id = database.id;
        let record = Self::insert_initial_state_in_tx(
          &mut tx,
          DatabaseInitialState {
            database,
            fields,
            views,
            roles: field_roles,
            view_roles,
            rows,
            row_templates,
            workspace_tags,
          },
          import_job_id,
        )
        .await?;
        if let Some(result) = &mut import_job_result {
          let summary = result
            .as_object_mut()
            .ok_or_else(|| RepositoryError::Validation("prepared import result must be an object".into()))?;
          // Persist the writer's canonical record, including database-normalized
          // timestamps and fields, rather than the application's planned copy.
          summary.insert(
            "database".into(),
            serde_json::to_value(record)
              .map_err(|_| RepositoryError::Storage("import database result serialization failed".into()))?,
          );
        }
        database_id
      }
      DatabaseJsonImportMode::Replace => {
        let target_id =
          target_database_id.ok_or_else(|| RepositoryError::Validation("replace target missing".into()))?;
        let managed: bool = sqlx::query_scalar(
          "SELECT EXISTS(SELECT 1 FROM database_profiles WHERE database_id=$1 AND profile_kind='project')",
        )
        .bind(target_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
        if managed {
          Self::lock_managed_admission(&mut tx, target_id).await?;
          if database.id != target_id
            || !fields.is_empty()
            || !views.is_empty()
            || !field_roles.is_empty()
            || !view_roles.is_empty()
          {
            return Err(RepositoryError::Validation(
              "managed content Replace cannot alter definitions".into(),
            ));
          }
          for tag in &workspace_tags {
            crate::workspace_tags::PgWorkspaceTagRepository::insert_tag_in_tx(&mut tx, tag)
              .await
              .map_err(Self::map_sqlx_error)?;
          }
          sqlx::query("DELETE FROM workspace_database_rows WHERE database_id=$1")
            .bind(target_id)
            .execute(&mut *tx)
            .await
            .map_err(Self::map_sqlx_error)?;
          sqlx::query("DELETE FROM workspace_database_row_templates WHERE database_id=$1")
            .bind(target_id)
            .execute(&mut *tx)
            .await
            .map_err(Self::map_sqlx_error)?;
          Self::insert_snapshot_rows_and_templates(
            &mut tx,
            target_id,
            fallback_actor,
            &rows,
            &row_templates,
            import_job_id,
          )
          .await?;
          target_id
        } else {
          let deleted = sqlx::query("DELETE FROM workspace_databases WHERE id = $1")
            .bind(target_id)
            .execute(&mut *tx)
            .await
            .map_err(Self::map_sqlx_error)?;
          if deleted.rows_affected() != 1 {
            return Err(RepositoryError::NotFound("database"));
          }
          let database_id = database.id;
          Self::insert_initial_state_in_tx(
            &mut tx,
            DatabaseInitialState {
              database,
              fields,
              views,
              roles: field_roles,
              view_roles,
              rows,
              row_templates,
              workspace_tags,
            },
            import_job_id,
          )
          .await?;
          database_id
        }
      }
      DatabaseJsonImportMode::Merge => {
        let target_id = target_database_id.ok_or_else(|| RepositoryError::Validation("merge target missing".into()))?;
        let exists =
          sqlx::query_scalar::<_, Uuid>("SELECT id FROM workspace_databases WHERE id = $1 FOR NO KEY UPDATE")
            .bind(target_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(Self::map_sqlx_error)?;
        if exists.is_none() {
          return Err(RepositoryError::NotFound("database"));
        }
        Self::insert_snapshot_fields_and_views(&mut tx, &fields, &views).await?;
        Self::insert_snapshot_rows(&mut tx, target_id, &rows, import_job_id).await?;
        let edited_fields = rows
          .iter()
          .chain(&updated_rows)
          .flat_map(|row| {
            row
              .cells
              .iter()
              .filter(|cell| cell.field_type == DatabaseFieldType::Relation)
              .map(|cell| cell.field_id)
          })
          .collect::<Vec<_>>();
        let parent_policy =
          Self::prepare_project_mutation(&mut tx, target_id, &edited_fields, !rows.is_empty()).await?;
        if let Some(policy) = parent_policy.as_ref() {
          let patches = rows
            .iter()
            .chain(&updated_rows)
            .flat_map(|row| {
              row
                .cells
                .iter()
                .map(|cell| (row.row.id, cell.field_id, Some(cell.value.clone())))
            })
            .collect::<Vec<_>>();
          Self::validate_task_relations_proposal(&mut tx, target_id, policy, &patches).await?;
        }
        // All final Row identities exist before either pass projects Relations.
        // Evaluate the combined proposal first, so overwrite can remove an old
        // edge before a new Row adds its admitted replacement.
        Self::update_snapshot_rows(&mut tx, &updated_rows, fallback_actor).await?;
        Self::insert_snapshot_cells_and_templates(&mut tx, target_id, fallback_actor, &rows, &row_templates).await?;
        if let Some(policy) = parent_policy.as_ref() {
          Self::validate_project_hierarchy(&mut tx, target_id, policy).await?;
        }
        target_id
      }
    };
    Self::insert_snapshot_sources(&mut tx, result_database_id, &row_sources).await?;
    if let Some(result) = import_job_result {
      // Keep the frozen public summary and native contents in one commit, so a
      // failed post-commit read cannot turn a queue retry into another Database.
      sqlx::query(
        "UPDATE database_import_jobs SET database_id=$2,status='succeeded',result_json=$3,
          finished_at=now(),last_error_code=NULL,last_error_message=NULL WHERE id=$1",
      )
      .bind(import_job_id)
      .bind(result_database_id)
      .bind(result)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    self
      .get_record(result_database_id)
      .await?
      .ok_or(RepositoryError::NotFound("database"))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // P-DB-27: CSV mapping templates — saved revisions per (workspace, name)
  // with the latest revision flagged as `is_current`. Implemented as plain
  // upsert + soft-demote so the wizard's "reuse template" dropdown stays
  // a single SELECT.
  // ─────────────────────────────────────────────────────────────────────────

  async fn save_csv_mapping_template(
    &self,
    template: NewDatabaseCsvMappingTemplate,
  ) -> RepoResult<DatabaseCsvMappingTemplate> {
    let NewDatabaseCsvMappingTemplate {
      workspace_id,
      name,
      dialect,
      first_row_is_header,
      mapping,
      created_by,
    } = template;

    let dialect_json = serde_json::to_value(&dialect)
      .map_err(|err| RepositoryError::Validation(format!("csv dialect is not serializable: {err}")))?;
    let mapping_json = serde_json::to_value(&mapping)
      .map_err(|err| RepositoryError::Validation(format!("csv mapping is not serializable: {err}")))?;

    let mut tx = self.begin_write().await?;

    let next_revision: i32 = sqlx::query_scalar::<_, Option<i32>>(
      r#"
        SELECT MAX(revision)
        FROM workspace_database_csv_mapping_templates
        WHERE workspace_id = $1 AND name = $2
      "#,
    )
    .bind(workspace_id)
    .bind(&name)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .map(|value| value + 1)
    .unwrap_or(1);

    sqlx::query(
      r#"
        UPDATE workspace_database_csv_mapping_templates
           SET is_current = FALSE
         WHERE workspace_id = $1 AND name = $2 AND is_current = TRUE
      "#,
    )
    .bind(workspace_id)
    .bind(&name)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    let row: (DatabaseCsvMappingTemplateId, DateTime<Utc>, DateTime<Utc>) = sqlx::query_as(
      r#"
        INSERT INTO workspace_database_csv_mapping_templates (
          workspace_id,
          name,
          revision,
          is_current,
          dialect_json,
          first_row_is_header,
          mapping_json,
          created_by
        )
        VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7)
        RETURNING id, created_at, updated_at
      "#,
    )
    .bind(workspace_id)
    .bind(&name)
    .bind(next_revision)
    .bind(dialect_json)
    .bind(first_row_is_header)
    .bind(mapping_json)
    .bind(created_by)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    tx.commit().await.map_err(Self::map_sqlx_error)?;

    Ok(DatabaseCsvMappingTemplate {
      id: row.0,
      workspace_id,
      name,
      revision: next_revision,
      is_current: true,
      dialect,
      first_row_is_header,
      mapping,
      created_by,
      created_at: row.1,
      updated_at: row.2,
    })
  }

  async fn list_csv_mapping_templates(&self, workspace_id: WorkspaceId) -> RepoResult<Vec<DatabaseCsvMappingTemplate>> {
    let records = sqlx::query_as::<
      _,
      (
        DatabaseCsvMappingTemplateId,
        String,
        i32,
        serde_json::Value,
        bool,
        serde_json::Value,
        UserId,
        DateTime<Utc>,
        DateTime<Utc>,
      ),
    >(
      r#"
        SELECT id,
               name,
               revision,
               dialect_json,
               first_row_is_header,
               mapping_json,
               created_by,
               created_at,
               updated_at
          FROM workspace_database_csv_mapping_templates
         WHERE workspace_id = $1 AND is_current = TRUE
         ORDER BY updated_at DESC, name ASC
      "#,
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;

    records
      .into_iter()
      .map(
        |(id, name, revision, dialect_json, first_row_is_header, mapping_json, created_by, created_at, updated_at)| {
          let dialect: DatabaseCsvDialect = serde_json::from_value(dialect_json).map_err(|err| {
            RepositoryError::Validation(format!("stored csv mapping template dialect is invalid: {err}"))
          })?;
          let mapping: Vec<DatabaseCsvAppliedColumnMapping> = serde_json::from_value(mapping_json).map_err(|err| {
            RepositoryError::Validation(format!("stored csv mapping template mapping is invalid: {err}"))
          })?;
          Ok::<_, RepositoryError>(DatabaseCsvMappingTemplate {
            id,
            workspace_id,
            name,
            revision,
            is_current: true,
            dialect,
            first_row_is_header,
            mapping,
            created_by,
            created_at,
            updated_at,
          })
        },
      )
      .collect()
  }

  async fn get_csv_mapping_template_by_name(
    &self,
    workspace_id: WorkspaceId,
    name: &str,
  ) -> RepoResult<Option<DatabaseCsvMappingTemplate>> {
    let record = sqlx::query_as::<
      _,
      (
        DatabaseCsvMappingTemplateId,
        String,
        i32,
        serde_json::Value,
        bool,
        serde_json::Value,
        UserId,
        DateTime<Utc>,
        DateTime<Utc>,
      ),
    >(
      r#"
        SELECT id,
               name,
               revision,
               dialect_json,
               first_row_is_header,
               mapping_json,
               created_by,
               created_at,
               updated_at
          FROM workspace_database_csv_mapping_templates
         WHERE workspace_id = $1 AND name = $2 AND is_current = TRUE
         LIMIT 1
      "#,
    )
    .bind(workspace_id)
    .bind(name)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;

    let Some((id, name, revision, dialect_json, first_row_is_header, mapping_json, created_by, created_at, updated_at)) =
      record
    else {
      return Ok(None);
    };

    let dialect: DatabaseCsvDialect = serde_json::from_value(dialect_json)
      .map_err(|err| RepositoryError::Validation(format!("stored csv mapping template dialect is invalid: {err}")))?;
    let mapping: Vec<DatabaseCsvAppliedColumnMapping> = serde_json::from_value(mapping_json)
      .map_err(|err| RepositoryError::Validation(format!("stored csv mapping template mapping is invalid: {err}")))?;

    Ok(Some(DatabaseCsvMappingTemplate {
      id,
      workspace_id,
      name,
      revision,
      is_current: true,
      dialect,
      first_row_is_header,
      mapping,
      created_by,
      created_at,
      updated_at,
    }))
  }

  async fn delete_csv_mapping_template(&self, workspace_id: WorkspaceId, name: &str) -> RepoResult<u64> {
    let result = sqlx::query(
      r#"
        DELETE FROM workspace_database_csv_mapping_templates
         WHERE workspace_id = $1 AND name = $2
      "#,
    )
    .bind(workspace_id)
    .bind(name)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(result.rows_affected())
  }

  // ──────────────────────────────────────────────────────────────────────────
  // P-DB-26 (reopen 2026-07-08): background import/export job persistence,
  // idempotency, cancellation and compensation.
  // ──────────────────────────────────────────────────────────────────────────

  async fn create_import_job(&self, job: &DatabaseImportJobRecord) -> RepoResult<DatabaseImportJobRecord> {
    let status = job.status.as_str();
    let kind = job.kind.as_str();
    let inserted = sqlx::query(
      r#"
        INSERT INTO database_import_jobs
          (id, workspace_id, database_id, actor_id, kind, idempotency_key, status,
           attempt_count, payload_summary_json, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, workspace_id, database_id, actor_id, kind, idempotency_key, status,
                  attempt_count, cancellation_requested_at, cancelled_at, started_at, finished_at,
                  last_error_code, last_error_message, payload_summary_json, result_json, created_at
      "#,
    )
    .bind(job.id)
    .bind(job.workspace_id)
    .bind(job.database_id)
    .bind(job.actor_id)
    .bind(kind)
    .bind(&job.idempotency_key)
    .bind(status)
    .bind(job.attempt_count)
    .bind(&job.payload_summary)
    .bind(job.created_at)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    let row = inserted.ok_or({
      RepositoryError::Conflict("database_import_jobs live idempotency key already exists for this workspace")
    })?;
    Self::map_import_job(row)
  }

  async fn get_import_job(&self, job_id: DatabaseImportJobId) -> RepoResult<Option<DatabaseImportJobRecord>> {
    let row = sqlx::query(
      r#"
        SELECT id, workspace_id, database_id, actor_id, kind, idempotency_key, status,
               attempt_count, cancellation_requested_at, cancelled_at, started_at, finished_at,
               last_error_code, last_error_message, payload_summary_json, result_json, created_at
        FROM database_import_jobs
        WHERE id = $1
      "#,
    )
    .bind(job_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    row.map(Self::map_import_job).transpose()
  }

  async fn get_live_import_job_by_idempotency_key(
    &self,
    workspace_id: WorkspaceId,
    idempotency_key: &str,
  ) -> RepoResult<Option<DatabaseImportJobRecord>> {
    let row = sqlx::query(
      r#"
        SELECT id, workspace_id, database_id, actor_id, kind, idempotency_key, status,
               attempt_count, cancellation_requested_at, cancelled_at, started_at, finished_at,
               last_error_code, last_error_message, payload_summary_json, result_json, created_at
        FROM database_import_jobs
        WHERE workspace_id = $1
          AND idempotency_key = $2
          AND status IN ('queued', 'running', 'succeeded')
        ORDER BY created_at DESC
        LIMIT 1
      "#,
    )
    .bind(workspace_id)
    .bind(idempotency_key)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    row.map(Self::map_import_job).transpose()
  }

  async fn mark_import_job_running(
    &self,
    job_id: DatabaseImportJobId,
    database_id: Option<DatabaseId>,
  ) -> RepoResult<()> {
    // Allow the running transition from `failed` so a retry can
    // advance the previous failed row (the partial unique index
    // permits this). `succeeded` and `cancelled` are terminal and
    // must not be reset.
    sqlx::query(
      r#"
        UPDATE database_import_jobs
        SET status = 'running',
            started_at = now(),
            database_id = COALESCE(database_id, $2),
            attempt_count = attempt_count + 1,
            finished_at = NULL,
            last_error_code = NULL,
            last_error_message = NULL
        WHERE id = $1
          AND status IN ('queued', 'running', 'failed')
      "#,
    )
    .bind(job_id)
    .bind(database_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn mark_import_job_succeeded(&self, job_id: DatabaseImportJobId, result: &Value) -> RepoResult<()> {
    sqlx::query(
      r#"
        UPDATE database_import_jobs
        SET status = 'succeeded',
            result_json = $2,
            finished_at = now(),
            last_error_code = NULL,
            last_error_message = NULL
        WHERE id = $1 AND status NOT IN ('succeeded', 'cancelled')
      "#,
    )
    .bind(job_id)
    .bind(result)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn mark_import_job_failed(
    &self,
    job_id: DatabaseImportJobId,
    error_code: &str,
    error_message: &str,
    attempt_count: i32,
  ) -> RepoResult<()> {
    sqlx::query(
      r#"
        UPDATE database_import_jobs
        SET status = 'failed',
            last_error_code = $2,
            last_error_message = $3,
            finished_at = now(),
            attempt_count = GREATEST(attempt_count, $4)
        WHERE id = $1 AND status NOT IN ('succeeded', 'cancelled')
      "#,
    )
    .bind(job_id)
    .bind(error_code)
    .bind(error_message)
    .bind(attempt_count)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn request_import_job_cancellation(&self, job_id: DatabaseImportJobId) -> RepoResult<DatabaseImportJobRecord> {
    let row = sqlx::query(
      r#"
        UPDATE database_import_jobs
        SET cancellation_requested_at = COALESCE(cancellation_requested_at, now())
        WHERE id = $1
          AND status IN ('queued', 'running', 'succeeded', 'failed')
        RETURNING id, workspace_id, database_id, actor_id, kind, idempotency_key, status,
                  attempt_count, cancellation_requested_at, cancelled_at, started_at, finished_at,
                  last_error_code, last_error_message, payload_summary_json, result_json, created_at
      "#,
    )
    .bind(job_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database import job"))?;
    Self::map_import_job(row)
  }

  async fn mark_import_job_cancelled(&self, job_id: DatabaseImportJobId, result: &Value) -> RepoResult<()> {
    sqlx::query(
      r#"
        UPDATE database_import_jobs
        SET status = 'cancelled',
            cancelled_at = now(),
            finished_at = now(),
            result_json = COALESCE(result_json, $2)
        WHERE id = $1 AND status NOT IN ('succeeded', 'cancelled')
      "#,
    )
    .bind(job_id)
    .bind(result)
    .execute(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(())
  }

  async fn is_import_job_cancellation_requested(&self, job_id: DatabaseImportJobId) -> RepoResult<bool> {
    let row = sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
      r#"
        SELECT cancellation_requested_at
        FROM database_import_jobs
        WHERE id = $1
      "#,
    )
    .bind(job_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(row.flatten().is_some())
  }

  async fn delete_rows_by_job_id(&self, job_id: DatabaseImportJobId) -> RepoResult<usize> {
    let mut tx = self.begin_write().await?;
    let (workspace_id, database_id): (Uuid, Option<Uuid>) =
      sqlx::query_as("SELECT workspace_id,database_id FROM database_import_jobs WHERE id=$1 FOR SHARE")
        .bind(job_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database import job"))?;
    let database_id =
      database_id.ok_or_else(|| RepositoryError::Validation("import cleanup has no admitted database owner".into()))?;
    let owner=sqlx::query("SELECT COALESCE(p.profile_kind,'generic') AS profile_kind,myoxus_database_source_admitted(d.managed_installation) AS admitted FROM workspace_databases d LEFT JOIN database_profiles p ON p.database_id=d.id WHERE d.id=$1 AND d.workspace_id=$2 FOR KEY SHARE OF d")
      .bind(database_id).bind(workspace_id).fetch_optional(&mut *tx).await.map_err(Self::map_sqlx_error)?.ok_or(RepositoryError::NotFound("import database"))?;
    if owner.get::<String, _>("profile_kind") == "project" && !owner.get::<bool, _>("admitted") {
      return Err(RepositoryError::Validation(
        "managed schema unavailable during import cleanup".into(),
      ));
    }
    // Provenance survives a native move, but is never authority to delete a Row
    // from a different current owner than the job's admitted container.
    sqlx::query("DELETE FROM workspace_database_row_search WHERE row_id IN (SELECT id FROM workspace_database_rows WHERE created_by_job_id=$1 AND database_id=$2)")
      .bind(job_id).bind(database_id).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    let result = sqlx::query("DELETE FROM workspace_database_rows WHERE created_by_job_id=$1 AND database_id=$2")
      .bind(job_id)
      .bind(database_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(result.rows_affected() as usize)
  }
}
