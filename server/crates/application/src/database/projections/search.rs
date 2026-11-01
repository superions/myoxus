// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl DatabaseProjectionService {
  /// P-DB-25: enqueue a single-row search index refresh. The job has a
  /// `delay_ms` so that rapid keystroke edits collapse into the most
  /// recent state (3s target, matching the typed-cell debounce).
  pub async fn enqueue_index_row(
    &self,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    delay_ms: i64,
  ) {
    let queue = self.job_queue.as_ref().cloned();
    if let Some(queue) = queue {
      let data = serde_json::json!({
        "workspace_id": workspace_id,
        "database_id": database_id,
        "row_id": row_id,
      });
      let outcome = queue.enqueue(DATABASE_QUEUE, JOB_INDEX_ROW, data, delay_ms).await;
      if let Err(error) = outcome {
        warn!(
          %workspace_id,
          %database_id,
          %row_id,
          error = %error,
          "failed to enqueue database indexRow job, falling back to inline refresh"
        );
        self.refresh_search_index_inline(workspace_id, row_id).await;
      }
    } else {
      self.refresh_search_index_inline(workspace_id, row_id).await;
    }
  }

  /// P-DB-25: worker-callable variant of `refresh_search_index_inline`.
  /// Takes an explicit `database_id` so the worker can validate the row
  /// is still in the database before refreshing the FTS document.
  pub async fn refresh_search_index_inline_job(
    &self,
    workspace_id: Option<WorkspaceId>,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
  ) -> DatabaseResult<()> {
    let started_at = Instant::now();
    let record = match self.row_repo.get_row(row_id).await? {
      Some(record) if record.row.database_id == database_id => record,
      Some(_) => {
        // The row was moved or the database was swapped underneath the
        // job. The cascade FK on the canonical rows table already
        // removed any orphan FTS row.
        debug!(
          database_id = %database_id,
          row_id = %row_id,
          "database index row job skipped: row belongs to a different database"
        );
        return Ok(());
      }
      None => {
        self.projection_repo.delete_search_row(row_id).await?;
        debug!(
          database_id = %database_id,
          row_id = %row_id,
          "database index row job: row not found, removed orphan FTS document"
        );
        return Ok(());
      }
    };
    let workspace_id = match workspace_id {
      Some(workspace_id) => workspace_id,
      None => {
        self
          .schema_repo
          .get_database(record.row.database_id)
          .await?
          .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database not found for search row"))?
          .database
          .workspace_id
      }
    };
    let title = record.row.title.clone();
    let (tsv_text, workspace_tags) = self.build_search_payload_from_record(workspace_id, &record).await?;
    match self
      .projection_repo
      .upsert_search_row(
        record.row.database_id,
        row_id,
        record.row.edit_revision,
        title,
        tsv_text,
        workspace_tags,
      )
      .await
    {
      Ok(()) => {}
      Err(RepositoryError::Conflict("database search projection changed") | RepositoryError::NotFound(_)) => {
        return Ok(());
      }
      Err(error) => return Err(error.into()),
    }
    debug!(
      %workspace_id,
      database_id = %database_id,
      row_id = %row_id,
      operation = JOB_INDEX_ROW,
      state = "complete",
      elapsed_ms = started_at.elapsed().as_millis(),
      "database index row job refreshed search and document references"
    );
    Ok(())
  }

  /// P-DB-25: worker-callable full-database reindex. Walks every row
  /// in the database and refreshes its FTS document. Idempotent: rows
  /// with up-to-date tsvectors are written back unchanged.
  pub async fn reindex_database_search(
    &self,
    workspace_id: Option<WorkspaceId>,
    database_id: DatabaseId,
  ) -> DatabaseResult<()> {
    let workspace_id = workspace_id.unwrap_or_else(Uuid::nil);
    debug!(
      workspace_id = %workspace_id,
      database_id = %database_id,
      "database reindex search starting"
    );
    self.reindex_database_search_inline(workspace_id, database_id).await?;
    info!(
      workspace_id = %workspace_id,
      database_id = %database_id,
      "database reindex search complete"
    );
    Ok(())
  }

  async fn refresh_search_index_inline(&self, workspace_id: WorkspaceId, row_id: DatabaseRowId) {
    let record = match self.row_repo.get_row(row_id).await {
      Ok(Some(record)) => record,
      Ok(None) => {
        let _ = self.projection_repo.delete_search_row(row_id).await;
        return;
      }
      Err(error) => {
        warn!(%row_id, error = %error, "inline search refresh: failed to load row");
        return;
      }
    };
    let title = record.row.title.clone();
    let Ok((tsv_text, workspace_tags)) = self.build_search_payload_from_record(workspace_id, &record).await else {
      warn!(%row_id, "inline search refresh: failed to resolve workspace tags");
      return;
    };
    if let Err(error) = self
      .projection_repo
      .upsert_search_row(
        record.row.database_id,
        row_id,
        record.row.edit_revision,
        title,
        tsv_text,
        workspace_tags,
      )
      .await
    {
      warn!(%row_id, error = %error, "inline search refresh: upsert failed");
    }
  }

  async fn build_search_payload_from_record(
    &self,
    workspace_id: WorkspaceId,
    record: &DatabaseRowRecord,
  ) -> DatabaseResult<(String, Vec<WorkspaceTagSearchProjection>)> {
    let mut text = String::new();
    let mut tag_ids = Vec::new();
    let mut seen_tag_ids = HashSet::new();
    for cell in &record.cells {
      if let DatabaseCellValueData::Tags(ids) = &cell.value {
        for tag_id in ids {
          if seen_tag_ids.insert(*tag_id) {
            tag_ids.push(*tag_id);
          }
        }
        continue;
      }
      if let Some(value_text) = Self::cell_value_search_text(&cell.value) {
        if !text.is_empty() {
          text.push(' ');
        }
        text.push_str(&value_text);
      }
    }
    let workspace_tags = if tag_ids.is_empty() {
      Vec::new()
    } else {
      let service = self
        .workspace_tags
        .as_ref()
        .cloned()
        .ok_or_else(|| DatabaseServiceError::new(ERR_STORAGE, "workspace tag service is not configured"))?;
      service
        .resolve_tags_for_index(workspace_id, &tag_ids)
        .await
        .map_err(|error| {
          if error.code == crate::workspace_tags::ERR_TAG_STORAGE {
            DatabaseServiceError::repository_storage(error.code, error.message)
          } else {
            DatabaseServiceError::new(error.code, error.message)
          }
        })?
        .iter()
        .map(WorkspaceTagSearchProjection::from)
        .collect::<Vec<_>>()
    };
    // Tags are indexed exactly once through the structured
    // `workspace_tags` projection. Copying the same tokens into `search_text`
    // would make that otherwise non-Tag payload impossible to refresh safely
    // after a rename or permanent deletion.
    Ok((text, workspace_tags))
  }

  fn cell_value_search_text(value: &DatabaseCellValueData) -> Option<String> {
    let mut values = Vec::new();
    match value {
      DatabaseCellValueData::Text(value) => values.push(value.clone()),
      DatabaseCellValueData::RichText(value) => values.push(value.plain_text.clone()),
      DatabaseCellValueData::Number(value) | DatabaseCellValueData::Percent(value) => values.push(value.to_string()),
      DatabaseCellValueData::Currency(value) => {
        values.push(value.amount.to_string());
        values.push(value.currency_code.clone());
      }
      DatabaseCellValueData::Duration(value) => values.push(value.minutes.to_string()),
      DatabaseCellValueData::Checkbox(value) => values.push(value.to_string()),
      DatabaseCellValueData::Date(value) => values.push(value.start.to_string()),
      DatabaseCellValueData::DateTime(value) => values.push(value.start.to_rfc3339()),
      DatabaseCellValueData::UniqueId(value) => values.push(value.display.clone()),
      DatabaseCellValueData::Select(value)
      | DatabaseCellValueData::Status(value)
      | DatabaseCellValueData::Url(value)
      | DatabaseCellValueData::Email(value)
      | DatabaseCellValueData::Phone(value) => values.push(value.clone()),
      DatabaseCellValueData::MultiSelect(values_list) => values.extend(values_list.iter().cloned()),
      DatabaseCellValueData::User(value)
      | DatabaseCellValueData::CreatedBy(value)
      | DatabaseCellValueData::UpdatedBy(value) => values.push(value.to_string()),
      DatabaseCellValueData::Users(user_ids) => values.extend(user_ids.iter().map(ToString::to_string)),
      DatabaseCellValueData::DocumentLink(value) => values.push(value.doc_id.to_string()),
      DatabaseCellValueData::Files(_)
      | DatabaseCellValueData::Tags(_)
      | DatabaseCellValueData::Relation(_)
      | DatabaseCellValueData::Rollup(_)
      | DatabaseCellValueData::Formula(_)
      | DatabaseCellValueData::CreatedTime(_)
      | DatabaseCellValueData::UpdatedTime(_) => {}
    }
    let text = values
      .into_iter()
      .filter(|value| !value.is_empty())
      .collect::<Vec<_>>()
      .join(" ");
    (!text.is_empty()).then_some(text)
  }

  async fn reindex_database_search_inline(
    &self,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
  ) -> DatabaseResult<()> {
    let page_size = self.limits.max_rows_per_page;
    let mut offset = 0i64;
    loop {
      let rows = self
        .view_query_repo
        .list_rows(
          database_id,
          PageRequest {
            limit: page_size,
            offset,
          },
        )
        .await?;
      if rows.is_empty() {
        break;
      }
      for record in &rows {
        let (tsv_text, workspace_tags) = self.build_search_payload_from_record(workspace_id, record).await?;
        match self
          .projection_repo
          .upsert_search_row(
            record.row.database_id,
            record.row.id,
            record.row.edit_revision,
            record.row.title.clone(),
            tsv_text,
            workspace_tags,
          )
          .await
        {
          Ok(()) => {}
          Err(RepositoryError::Conflict("database search projection changed") | RepositoryError::NotFound(_)) => {
            continue;
          }
          Err(error) => return Err(error.into()),
        }
      }
      if (rows.len() as i64) < page_size {
        break;
      }
      offset += page_size;
    }
    Ok(())
  }

  /// P-DB-25: enqueue a full-database search reindex. Issued when the
  /// schema changes (a new searchable column is added or an old one is
  /// retired) or when an operator requests a manual rebuild.
  pub async fn enqueue_reindex_search(&self, workspace_id: WorkspaceId, database_id: DatabaseId) -> DatabaseResult<()> {
    let queue = self.job_queue.as_ref().cloned();
    let Some(queue) = queue else {
      // Best-effort path: there is no Redis queue. The next
      // `enqueue_index_row` call will refresh each row on a debounce,
      // so a manual reindex is only required when the schema changes
      // and no further cell writes are expected. Run the reindex
      // inline in that case so the search index still converges.
      self.reindex_database_search_inline(workspace_id, database_id).await?;
      return Ok(());
    };
    let data = serde_json::json!({
      "workspace_id": workspace_id,
      "database_id": database_id,
    });
    queue
      .enqueue(DATABASE_QUEUE, JOB_REINDEX_SEARCH, data, 0)
      .await
      .map_err(|error| {
        error!(
          workspace_id = %workspace_id,
          database_id = %database_id,
          error = %error,
          "database reindexSearch enqueue failed: queue rejected payload"
        );
        DatabaseServiceError::new(
          ERR_NOT_FOUND,
          format!("failed to enqueue database reindexSearch: {error}"),
        )
      })?;
    info!(
      workspace_id = %workspace_id,
      database_id = %database_id,
      "database reindexSearch job enqueued"
    );
    Ok(())
  }

  /// Search the existing derived Database row index without exposing its
  /// persistence port to transport adapters.
  pub async fn search_rows(&self, filter: DatabaseSearchFilter) -> DatabaseResult<Vec<DatabaseSearchHit>> {
    Ok(self.projection_repo.search_rows(filter).await?)
  }
}
