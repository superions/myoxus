// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::database::access;
use crate::database::{
  DATABASE_QUEUE, DatabaseImportExportService, DatabaseResult, DatabaseServiceError, ERR_CSV_TOO_LARGE, ERR_FORBIDDEN,
  ERR_NOT_FOUND, ERR_STORAGE, JOB_BULK_EXPORT, JOB_BULK_IMPORT,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::Utc;
use myoxus_domain::database::{
  DatabaseCsvDelimiter, DatabaseCsvDialect, DatabaseCsvImportOptions, DatabaseImportJobKind, DatabaseImportJobRecord,
  DatabaseImportJobStatus,
};
use myoxus_domain::ids::{DatabaseId, DatabaseImportJobId, UserId, WorkspaceId};
use myoxus_domain::permission::WorkspaceAction;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

impl DatabaseImportExportService {
  // ─── P-DB-26: bulk import / export job bookkeeping ──────────────────
  //
  // The service treats `database.bulkImport` and `database.bulkExport` as
  // async jobs that:
  //   * persist a `DatabaseImportJobRecord` keyed by `(workspace_id,
  //     idempotency_key)` so a sequential retry of a failed or cancelled
  //     job can reuse the same key (the partial unique index only
  //     protects live states);
  //   * read `cancellation_requested_at` while planning rows and commit the
  //     Database, rows and imported workspace tags in one transaction;
  //   * tag every committed row with `created_by_job_id` so provenance and
  //     operator diagnostics remain exact without partial product state;
  //   * return the final summary (success, failure, or cancel) through
  //     `result_json` so retries are idempotent at the worker layer.

  /// P-DB-26: enqueue a `database.bulkImport` job for the async worker.
  ///
  /// Creates the `database_import_jobs` row first so the operator can
  /// cancel and inspect the job before the worker even picks it up. If a
  /// live job with the same `(workspace_id, idempotency_key)` already
  /// exists, its identity is retained. An explicitly repeated call re-enqueues
  /// a queued job; running and succeeded jobs return without another handoff.
  /// Failed and cancelled jobs remain eligible for a fresh row.
  /// Queued retries supply the original title/content/options again; the
  /// native job ID fences effects, rather than storing or hashing that payload.
  #[allow(clippy::too_many_arguments)]
  pub async fn enqueue_bulk_import_job(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    idempotency_key: String,
    payload_summary: serde_json::Value,
    database_title: String,
    content: &[u8],
    options: DatabaseCsvImportOptions,
  ) -> DatabaseResult<DatabaseImportJobRecord> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    if content.len() > self.limits.csv_max_bytes {
      return Err(DatabaseServiceError::new(
        ERR_CSV_TOO_LARGE,
        "CSV file exceeds configured limit",
      ));
    }
    let existing = self
      .import_export_repo
      .get_live_import_job_by_idempotency_key(workspace_id, &idempotency_key)
      .await?;
    if let Some(existing) = &existing {
      if existing.workspace_id != workspace_id
        || existing.actor_id != Some(actor)
        || existing.kind != DatabaseImportJobKind::BulkImport
      {
        return Err(DatabaseServiceError::new(
          ERR_FORBIDDEN,
          "import job does not match requested actor or kind",
        ));
      }
      warn!(
        workspace_id = %workspace_id,
        actor_id = %actor,
        idempotency_key = %idempotency_key,
        existing_job_id = %existing.id,
        existing_status = existing.status.as_str(),
        "database bulk import enqueue reuses existing live job"
      );
      if existing.status != DatabaseImportJobStatus::Queued {
        return Ok(existing.clone());
      }
    }
    let queue = self.job_queue.as_ref().cloned();
    let Some(queue) = queue else {
      error!(
        workspace_id = %workspace_id,
        actor_id = %actor,
        "database bulk import enqueue failed: job queue not configured"
      );
      return Err(DatabaseServiceError::new(
        ERR_NOT_FOUND,
        "database job queue is not configured; bulk import cannot run asynchronously",
      ));
    };
    // Explicit producer replay repairs an uncertain Redis handoff using the
    // same native job identity; native apply arbitrates duplicate deliveries.
    let record = if let Some(existing) = existing {
      existing
    } else {
      let now = Utc::now();
      let record = DatabaseImportJobRecord {
        id: Uuid::new_v4(),
        workspace_id,
        database_id: None,
        actor_id: Some(actor),
        kind: DatabaseImportJobKind::BulkImport,
        idempotency_key: idempotency_key.clone(),
        status: DatabaseImportJobStatus::Queued,
        attempt_count: 0,
        cancellation_requested_at: None,
        cancelled_at: None,
        started_at: None,
        finished_at: None,
        last_error_code: None,
        last_error_message: None,
        payload_summary,
        result: None,
        created_at: now,
      };
      self.import_export_repo.create_import_job(&record).await?;
      record
    };
    queue
      .enqueue(
        DATABASE_QUEUE,
        JOB_BULK_IMPORT,
        serde_json::json!({
          "import_job_id": record.id,
          "actor_id": record.actor_id,
          "database_title": database_title,
          "content_base64": STANDARD.encode(content),
          "options": options,
          "workspace_id": record.workspace_id,
          "idempotency_key": record.idempotency_key,
        }),
        0,
      )
      .await
      .map_err(|error| {
        error!(
          workspace_id = %workspace_id,
          actor_id = %actor,
          import_job_id = %record.id,
          error = %error,
          "database bulk import enqueue failed: queue rejected payload"
        );
        DatabaseServiceError::new(ERR_NOT_FOUND, format!("failed to enqueue database bulkImport: {error}"))
      })?;
    info!(
      workspace_id = %workspace_id,
      actor_id = %actor,
      import_job_id = %record.id,
      kind = record.kind.as_str(),
      "database bulk import job enqueued"
    );
    Ok(record)
  }

  /// P-DB-26: enqueue a `database.bulkExport` job. Same semantics as
  /// [`enqueue_bulk_import_job`] — the job row is created first so the
  /// operator can cancel and inspect it before the worker picks it up.
  /// The current worker implementation mirrors the import path: no
  /// per-row lineage is required because exports do not create rows.
  pub async fn enqueue_bulk_export_job(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    idempotency_key: String,
    payload_summary: serde_json::Value,
  ) -> DatabaseResult<DatabaseImportJobRecord> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    let database = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    if database.database.workspace_id != workspace_id {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "export database does not belong to this workspace",
      ));
    }
    let existing = self
      .import_export_repo
      .get_live_import_job_by_idempotency_key(workspace_id, &idempotency_key)
      .await?;
    if let Some(existing) = &existing {
      if existing.workspace_id != workspace_id
        || existing.actor_id != Some(actor)
        || existing.kind != DatabaseImportJobKind::BulkExport
      {
        return Err(DatabaseServiceError::new(
          ERR_FORBIDDEN,
          "export job does not match requested actor or kind",
        ));
      }
      if existing.database_id.is_none_or(|db| db != database_id) {
        warn!(
          workspace_id = %workspace_id,
          actor_id = %actor,
          database_id = %database_id,
          idempotency_key = %idempotency_key,
          existing_job_id = %existing.id,
          existing_database_id = ?existing.database_id,
          "database bulk export enqueue refused: idempotency_key reused across databases"
        );
        return Err(DatabaseServiceError::new(
          "MIX_DATABASE_BULK_IDEMPOTENCY_MISMATCH",
          format!(
            "an existing import job already uses idempotency_key='{}' for a different database",
            idempotency_key
          ),
        ));
      }
      warn!(
        workspace_id = %workspace_id,
        actor_id = %actor,
        database_id = %database_id,
        idempotency_key = %idempotency_key,
        existing_job_id = %existing.id,
        existing_status = existing.status.as_str(),
        "database bulk export enqueue reuses existing live job"
      );
      if existing.status != DatabaseImportJobStatus::Queued {
        return Ok(existing.clone());
      }
    }
    let queue = self.job_queue.as_ref().cloned();
    let Some(queue) = queue else {
      error!(
        workspace_id = %workspace_id,
        actor_id = %actor,
        database_id = %database_id,
        "database bulk export enqueue failed: job queue not configured"
      );
      return Err(DatabaseServiceError::new(
        ERR_NOT_FOUND,
        "database job queue is not configured; bulk export cannot run asynchronously",
      ));
    };
    // Explicit producer replay repairs an uncertain Redis handoff using the
    // same native job identity; native apply arbitrates duplicate deliveries.
    let record = if let Some(existing) = existing {
      existing
    } else {
      let now = Utc::now();
      let record = DatabaseImportJobRecord {
        id: Uuid::new_v4(),
        workspace_id,
        database_id: Some(database_id),
        actor_id: Some(actor),
        kind: DatabaseImportJobKind::BulkExport,
        idempotency_key: idempotency_key.clone(),
        status: DatabaseImportJobStatus::Queued,
        attempt_count: 0,
        cancellation_requested_at: None,
        cancelled_at: None,
        started_at: None,
        finished_at: None,
        last_error_code: None,
        last_error_message: None,
        payload_summary,
        result: None,
        created_at: now,
      };
      self.import_export_repo.create_import_job(&record).await?;
      record
    };
    queue
      .enqueue(
        DATABASE_QUEUE,
        JOB_BULK_EXPORT,
        serde_json::json!({
          "import_job_id": record.id,
          "actor_id": record.actor_id,
          "workspace_id": record.workspace_id,
          "database_id": record.database_id,
          "idempotency_key": record.idempotency_key,
        }),
        0,
      )
      .await
      .map_err(|error| {
        error!(
          workspace_id = %workspace_id,
          actor_id = %actor,
          database_id = %database_id,
          import_job_id = %record.id,
          error = %error,
          "database bulk export enqueue failed: queue rejected payload"
        );
        DatabaseServiceError::new(ERR_NOT_FOUND, format!("failed to enqueue database bulkExport: {error}"))
      })?;
    info!(
      workspace_id = %workspace_id,
      actor_id = %actor,
      database_id = %database_id,
      import_job_id = %record.id,
      kind = record.kind.as_str(),
      "database bulk export job enqueued"
    );
    Ok(record)
  }

  /// Read the durable bulk import/export job under its current workspace
  /// read permission.
  pub async fn get_bulk_operation_job(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    job_id: DatabaseImportJobId,
  ) -> DatabaseResult<Option<DatabaseImportJobRecord>> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    let record = match self.import_export_repo.get_import_job(job_id).await? {
      Some(record) => record,
      None => return Ok(None),
    };
    if record.workspace_id != workspace_id {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "import job does not belong to this workspace",
      ));
    }
    Ok(Some(record))
  }

  /// P-DB-26: request operator-driven cancellation of a bulk
  /// import/export job. Sets `cancellation_requested_at` exactly once.
  /// Import planning observes this flag before apply; the native job lock
  /// arbitrates cancellation against the atomic content/result commit.
  /// The worker records the terminal cancelled state.
  pub async fn request_bulk_operation_cancellation(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    job_id: DatabaseImportJobId,
  ) -> DatabaseResult<DatabaseImportJobRecord> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    let record = match self.import_export_repo.get_import_job(job_id).await? {
      Some(record) => record,
      None => {
        return Err(DatabaseServiceError::new(
          ERR_NOT_FOUND,
          format!("import job {job_id} not found"),
        ));
      }
    };
    if record.workspace_id != workspace_id {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "import job does not belong to this workspace",
      ));
    }
    match record.status {
      DatabaseImportJobStatus::Queued | DatabaseImportJobStatus::Running | DatabaseImportJobStatus::Failed => {
        self.import_export_repo.request_import_job_cancellation(job_id).await?;
        info!(
          workspace_id = %workspace_id,
          actor_id = %actor,
          import_job_id = %job_id,
          prior_status = record.status.as_str(),
          kind = record.kind.as_str(),
          "database bulk job cancellation requested"
        );
      }
      DatabaseImportJobStatus::Succeeded => {
        warn!(
          workspace_id = %workspace_id,
          actor_id = %actor,
          import_job_id = %job_id,
          "database bulk job cancellation rejected: job already succeeded"
        );
        return Err(DatabaseServiceError::new(
          "MIX_DATABASE_BULK_ALREADY_SUCCEEDED",
          "import job already succeeded; nothing to cancel",
        ));
      }
      DatabaseImportJobStatus::Cancelled => {
        debug!(
          workspace_id = %workspace_id,
          actor_id = %actor,
          import_job_id = %job_id,
          "database bulk job cancellation idempotent: job already cancelled"
        );
        return Ok(record);
      }
    }
    let updated = self.import_export_repo.get_import_job(job_id).await?.ok_or_else(|| {
      error!(
        workspace_id = %workspace_id,
        import_job_id = %job_id,
        "database bulk job vanished between request_import_job_cancellation and reload"
      );
      DatabaseServiceError::new(ERR_NOT_FOUND, "import job vanished mid-flight")
    })?;
    Ok(updated)
  }

  // ─── P-DB-26: worker-side execution ──────────────────────────────────

  /// P-DB-26: worker entry point for `database.bulkImport`. Looks up the
  /// durable job row, applies idempotent short-circuits, marks the row
  /// `running`, dispatches the import, then records the final status
  /// (`succeeded` / `failed` / `cancelled`).
  ///
  /// Idempotency contract:
  ///   * If the job is already `Succeeded` the prior `result_json` is
  ///     returned untouched — calling it twice with the same job id
  ///     yields the same payload.
  ///   * If the job is already `Cancelled` (operator pre-cancel), the
  ///     worker treats that as a no-op and returns the (possibly empty)
  ///     `result_json`. The operator's cancel is the source of truth.
  ///   * If the job is `Queued` or `Failed`, the worker tries to mark it
  ///     `Running` and dispatches. A `failed` record can therefore be
  ///     retried under the same `(workspace_id, idempotency_key)` once
  ///     the failed row falls outside the live uniqueness window — the
  ///     migration's partial unique index makes this safe.
  ///
  /// `content` carries the raw CSV bytes. Bulk imports are size-capped
  /// at the queue boundary; if a CSV exceeds the cap the operator must
  /// split it before re-enqueueing.
  ///
  /// `bulk_insert_actor_id` is the user the import runs on behalf of —
  /// always the same actor that created the original job.
  pub async fn run_bulk_import_job(
    &self,
    job_id: DatabaseImportJobId,
    bulk_insert_actor_id: UserId,
    database_title: String,
    content: Vec<u8>,
    options: DatabaseCsvImportOptions,
  ) -> DatabaseResult<serde_json::Value> {
    let record = self
      .import_export_repo
      .get_import_job(job_id)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, format!("import job {job_id} not found")))?;
    if record.actor_id != Some(bulk_insert_actor_id) {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "import job belongs to another actor",
      ));
    }
    access::assert_workspace(
      &self.permission,
      bulk_insert_actor_id,
      record.workspace_id,
      WorkspaceAction::CreateDoc,
    )
    .await?;
    if record.kind != DatabaseImportJobKind::BulkImport {
      return Err(DatabaseServiceError::new(
        "MIX_DATABASE_BULK_KIND_MISMATCH",
        format!("import job {job_id} is kind={:?}, expected BulkImport", record.kind),
      ));
    }
    match record.status {
      DatabaseImportJobStatus::Succeeded => {
        info!(
          workspace_id = %record.workspace_id,
          import_job_id = %job_id,
          attempt_count = record.attempt_count,
          "database bulk import short-circuit: job already succeeded; returning prior result"
        );
        return record.result.ok_or_else(|| {
          DatabaseServiceError::repository_storage(ERR_STORAGE, "committed import result is unavailable")
        });
      }
      DatabaseImportJobStatus::Cancelled => {
        info!(
          workspace_id = %record.workspace_id,
          import_job_id = %job_id,
          "database bulk import short-circuit: job already cancelled"
        );
        let prior = record
          .result
          .clone()
          .unwrap_or_else(|| serde_json::json!({ "status": "cancelled" }));
        return Ok(prior);
      }
      DatabaseImportJobStatus::Queued | DatabaseImportJobStatus::Failed | DatabaseImportJobStatus::Running => {}
    }
    debug!(
      workspace_id = %record.workspace_id,
      import_job_id = %job_id,
      actor_id = %bulk_insert_actor_id,
      prior_status = record.status.as_str(),
      content_bytes = content.len(),
      "database bulk import dispatching"
    );
    // `mark_import_job_running` increments attempt_count atomically
    // inside the SQL update (see `database_import_jobs` migration). The
    // CSV import is the source of truth for the database id — it is
    // created mid-import, so we pass `None` and let the import stage
    // stamp `database_id` on success.
    self.import_export_repo.mark_import_job_running(job_id, None).await?;
    let result = self
      .import_csv_with_job(
        bulk_insert_actor_id,
        record.workspace_id,
        database_title,
        &content,
        options,
        Some(job_id),
      )
      .await;
    // Native apply and its result commit together. Always read that authority
    // before classifying an error, including a lost post-commit response.
    let retained = self.import_export_repo.get_import_job(job_id).await?.ok_or_else(|| {
      DatabaseServiceError::repository_storage(ERR_STORAGE, "import job disappeared during execution")
    })?;
    if retained.workspace_id != record.workspace_id
      || retained.actor_id != Some(bulk_insert_actor_id)
      || retained.kind != DatabaseImportJobKind::BulkImport
    {
      return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "import job identity changed"));
    }
    if retained.status == DatabaseImportJobStatus::Succeeded {
      return retained.result.ok_or_else(|| {
        DatabaseServiceError::repository_storage(ERR_STORAGE, "committed import result is unavailable")
      });
    }
    if retained.status == DatabaseImportJobStatus::Cancelled {
      return Ok(
        retained
          .result
          .unwrap_or_else(|| serde_json::json!({"status":"cancelled"})),
      );
    }
    match result {
      Ok(_) => Err(DatabaseServiceError::repository_storage(
        ERR_STORAGE,
        "native import did not retain its result",
      )),
      // A storage error is not evidence of rollback. Leave the job available
      // for native result readback rather than publishing a false failure.
      Err(err) if err.is_retryable_storage_failure() => Err(err),
      Err(err) if err.code == "MIX_DATABASE_IMPORT_CANCELLED" => {
        let summary = serde_json::json!({
          "status": "cancelled",
          "code": err.code,
          "message": err.message,
        });
        // Cancellation is observed while planning, before the atomic
        // Database/row/tag transaction starts. Persist the terminal status;
        // there is no partial product state to compensate.
        self
          .import_export_repo
          .mark_import_job_cancelled(job_id, &summary)
          .await?;
        let retained = self.import_export_repo.get_import_job(job_id).await?.ok_or_else(|| {
          DatabaseServiceError::repository_storage(ERR_STORAGE, "import job disappeared during execution")
        })?;
        if retained.status == DatabaseImportJobStatus::Succeeded {
          return retained.result.ok_or_else(|| {
            DatabaseServiceError::repository_storage(ERR_STORAGE, "committed import result is unavailable")
          });
        }
        if retained.status == DatabaseImportJobStatus::Cancelled {
          info!(
            workspace_id = %record.workspace_id,
            import_job_id = %job_id,
            actor_id = %bulk_insert_actor_id,
            reason = %err.message,
            "database bulk import cancelled before atomic apply"
          );
          return Ok(
            retained
              .result
              .unwrap_or_else(|| serde_json::json!({"status":"cancelled"})),
          );
        }
        Ok(summary)
      }
      Err(err) => {
        let summary = serde_json::json!({
          "status": "failed",
          "code": err.code,
          "message": err.message,
        });
        // The SQL update has already incremented the attempt counter
        // for this dispatch; surface the post-increment value.
        let final_attempt_count = record.attempt_count + 1;
        self
          .import_export_repo
          .mark_import_job_failed(job_id, err.code, err.message.as_str(), final_attempt_count)
          .await?;
        let retained = self.import_export_repo.get_import_job(job_id).await?.ok_or_else(|| {
          DatabaseServiceError::repository_storage(ERR_STORAGE, "import job disappeared during execution")
        })?;
        if retained.status == DatabaseImportJobStatus::Succeeded {
          return retained.result.ok_or_else(|| {
            DatabaseServiceError::repository_storage(ERR_STORAGE, "committed import result is unavailable")
          });
        }
        // A concurrent cancellation can make the conditional failure update a no-op.
        if retained.status == DatabaseImportJobStatus::Cancelled {
          return Ok(
            retained
              .result
              .unwrap_or_else(|| serde_json::json!({"status":"cancelled"})),
          );
        }
        warn!(
          workspace_id = %record.workspace_id,
          import_job_id = %job_id,
          actor_id = %bulk_insert_actor_id,
          error_code = err.code,
          error = %err,
          attempt_count = final_attempt_count,
          "database bulk import failed; job is retryable via same idempotency_key"
        );
        Ok(summary)
      }
    }
  }

  /// P-DB-26: worker entry point for `database.bulkExport`. The current
  /// implementation does the export inline: exports read from the
  /// existing snapshot, do not create rows, and therefore cannot leave
  /// partial state behind. The job row exists so the operator has
  /// cancel and retry visibility alongside imports.
  pub async fn run_bulk_export_job(
    &self,
    job_id: DatabaseImportJobId,
    bulk_insert_actor_id: UserId,
  ) -> DatabaseResult<serde_json::Value> {
    let record = self
      .import_export_repo
      .get_import_job(job_id)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, format!("import job {job_id} not found")))?;
    if record.kind != DatabaseImportJobKind::BulkExport {
      return Err(DatabaseServiceError::new(
        "MIX_DATABASE_BULK_KIND_MISMATCH",
        format!("import job {job_id} is kind={:?}, expected BulkExport", record.kind),
      ));
    }
    if record.actor_id != Some(bulk_insert_actor_id) {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "export job belongs to another actor",
      ));
    }
    let database_id = record.database_id.ok_or_else(|| {
      error!(
        workspace_id = %record.workspace_id,
        import_job_id = %job_id,
        "database bulk export rejected: job row has no database_id"
      );
      DatabaseServiceError::new(ERR_NOT_FOUND, format!("bulk export job {job_id} has no database_id"))
    })?;
    access::assert_workspace(
      &self.permission,
      bulk_insert_actor_id,
      record.workspace_id,
      WorkspaceAction::Read,
    )
    .await?;
    let database = access::get_database(&self.permission, &self.schema_repo, bulk_insert_actor_id, database_id).await?;
    if database.database.workspace_id != record.workspace_id {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "export database does not belong to this workspace",
      ));
    }
    match record.status {
      DatabaseImportJobStatus::Succeeded => {
        info!(
          workspace_id = %record.workspace_id,
          import_job_id = %job_id,
          "database bulk export short-circuit: job already succeeded"
        );
        return record.result.ok_or_else(|| {
          DatabaseServiceError::repository_storage(ERR_STORAGE, "committed export result is unavailable")
        });
      }
      DatabaseImportJobStatus::Cancelled => {
        info!(
          workspace_id = %record.workspace_id,
          import_job_id = %job_id,
          "database bulk export short-circuit: job already cancelled"
        );
        return Ok(
          record
            .result
            .unwrap_or_else(|| serde_json::json!({ "status": "cancelled" })),
        );
      }
      DatabaseImportJobStatus::Queued | DatabaseImportJobStatus::Failed | DatabaseImportJobStatus::Running => {}
    }
    debug!(
      workspace_id = %record.workspace_id,
      import_job_id = %job_id,
      actor_id = %bulk_insert_actor_id,
      database_id = %database_id,
      prior_status = record.status.as_str(),
      "database bulk export dispatching"
    );
    if self
      .import_export_repo
      .is_import_job_cancellation_requested(job_id)
      .await?
    {
      let summary = serde_json::json!({ "status": "cancelled" });
      self
        .import_export_repo
        .mark_import_job_cancelled(job_id, &summary)
        .await?;
      let retained = self.import_export_repo.get_import_job(job_id).await?.ok_or_else(|| {
        DatabaseServiceError::repository_storage(ERR_STORAGE, "export job disappeared during execution")
      })?;
      if retained.workspace_id != record.workspace_id
        || retained.actor_id != Some(bulk_insert_actor_id)
        || retained.kind != DatabaseImportJobKind::BulkExport
        || retained.database_id != Some(database_id)
      {
        return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "export job identity changed"));
      }
      if retained.status == DatabaseImportJobStatus::Succeeded {
        return retained.result.ok_or_else(|| {
          DatabaseServiceError::repository_storage(ERR_STORAGE, "committed export result is unavailable")
        });
      }
      if retained.status == DatabaseImportJobStatus::Cancelled {
        return Ok(
          retained
            .result
            .unwrap_or_else(|| serde_json::json!({"status":"cancelled"})),
        );
      }
      return Err(DatabaseServiceError::repository_storage(
        ERR_STORAGE,
        "export did not retain a terminal result",
      ));
    }
    let _attempt_count = record.attempt_count + 1;
    self
      .import_export_repo
      .mark_import_job_running(job_id, Some(database_id))
      .await?;
    let export = self
      .export_csv(
        bulk_insert_actor_id,
        database_id,
        None,
        DatabaseCsvDialect {
          delimiter: DatabaseCsvDelimiter::Comma,
          ..Default::default()
        },
      )
      .await?;
    let summary = serde_json::json!({
      "status": "succeeded",
      "database_id": database_id,
      "bytes": export.content.len(),
      "file_name": export.file_name,
    });
    self
      .import_export_repo
      .mark_import_job_succeeded(job_id, &summary)
      .await?;
    let retained = self.import_export_repo.get_import_job(job_id).await?.ok_or_else(|| {
      DatabaseServiceError::repository_storage(ERR_STORAGE, "export job disappeared during execution")
    })?;
    if retained.workspace_id != record.workspace_id
      || retained.actor_id != Some(bulk_insert_actor_id)
      || retained.kind != DatabaseImportJobKind::BulkExport
      || retained.database_id != Some(database_id)
    {
      return Err(DatabaseServiceError::new(ERR_FORBIDDEN, "export job identity changed"));
    }
    if retained.status == DatabaseImportJobStatus::Succeeded {
      return retained.result.ok_or_else(|| {
        DatabaseServiceError::repository_storage(ERR_STORAGE, "committed export result is unavailable")
      });
    }
    if retained.status == DatabaseImportJobStatus::Cancelled {
      return Ok(
        retained
          .result
          .unwrap_or_else(|| serde_json::json!({"status":"cancelled"})),
      );
    }
    Err(DatabaseServiceError::repository_storage(
      ERR_STORAGE,
      "export did not retain a terminal result",
    ))
  }
}
