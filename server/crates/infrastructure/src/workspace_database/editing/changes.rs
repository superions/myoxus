// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_automation::PgWorkspaceAutomationRepository;
use crate::workspace_database::*;

impl PgDatabaseRepository {
  /// Remove one canonical workspace Tag from every matching Database `Tags`
  /// cell while the caller's transaction remains open.
  ///
  /// This is intentionally crate-private: permanent Tag deletion is the only
  /// cross-aggregate operation that needs it, while this module remains the
  /// owner of physical Database tables, cell revisions and derived-value
  /// staleness. Unrelated Tag IDs retain their original order.
  pub(crate) async fn remove_workspace_tag_from_cells_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    updated_by: UserId,
  ) -> RepoResult<Vec<DatabaseId>> {
    let rows = sqlx::query(
      r#"
        SELECT cell.row_id, cell.field_id, cell.database_id, cell.value_json
        FROM workspace_database_cell_values cell
        JOIN workspace_database_fields field
          ON field.id = cell.field_id
         AND field.database_id = cell.database_id
         AND field.field_type = 'tags'
        JOIN workspace_databases database ON database.id = cell.database_id
        WHERE database.workspace_id = $1
          AND jsonb_typeof(cell.value_json) = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(cell.value_json) item(value)
            WHERE item.value = $2::text
          )
        ORDER BY cell.database_id, cell.row_id, cell.field_id
        FOR UPDATE OF cell
      "#,
    )
    .bind(workspace_id)
    .bind(tag_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    let mut affected_database_ids = BTreeSet::new();
    for row in rows {
      let row_id: DatabaseRowId = row.try_get("row_id").map_err(Self::map_sqlx_error)?;
      let field_id: DatabaseFieldId = row.try_get("field_id").map_err(Self::map_sqlx_error)?;
      let database_id: DatabaseId = row.try_get("database_id").map_err(Self::map_sqlx_error)?;
      let mut tag_ids = serde_json::from_value::<Vec<Uuid>>(row.try_get("value_json").map_err(Self::map_sqlx_error)?)
        .map_err(|error| RepositoryError::Validation(error.to_string()))?;
      tag_ids.retain(|candidate| *candidate != tag_id);
      let value_json = serde_json::to_value(tag_ids).map_err(|error| RepositoryError::Validation(error.to_string()))?;

      sqlx::query(
        r#"
          UPDATE workspace_database_cell_values
          SET value_json = $3,
              updated_by = $4,
              edit_revision = edit_revision + 1,
              updated_at = now()
          WHERE row_id = $1 AND field_id = $2
        "#,
      )
      .bind(row_id)
      .bind(field_id)
      .bind(value_json)
      .bind(updated_by)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;

      Self::mark_rollups_stale_for_target_cell_change(tx, row_id, field_id).await?;
      Self::mark_formulas_stale_for_cell_change(tx, row_id, field_id).await?;
      affected_database_ids.insert(database_id);
    }
    Ok(affected_database_ids.into_iter().collect())
  }

  pub(crate) fn map_cell_value_to_json(value: &DatabaseCellValueData) -> RepoResult<Value> {
    match value {
      DatabaseCellValueData::Text(value) => Ok(Value::String(value.clone())),
      DatabaseCellValueData::RichText(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Number(value) => serde_json::Number::from_f64(*value)
        .map(Value::Number)
        .ok_or_else(|| RepositoryError::Validation("number cell value must be finite".to_string())),
      DatabaseCellValueData::Percent(value) => serde_json::Number::from_f64(*value)
        .map(Value::Number)
        .ok_or_else(|| RepositoryError::Validation("percent cell value must be finite".to_string())),
      DatabaseCellValueData::Currency(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Duration(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Checkbox(value) => Ok(Value::Bool(*value)),
      DatabaseCellValueData::Date(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::DateTime(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Files(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::UniqueId(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Select(value) => Ok(Value::String(value.clone())),
      DatabaseCellValueData::MultiSelect(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Tags(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Status(value) => Ok(Value::String(value.clone())),
      DatabaseCellValueData::User(value) => Ok(Value::String(value.to_string())),
      DatabaseCellValueData::Users(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::DocumentLink(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Relation(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Rollup(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Formula(value) => {
        serde_json::to_value(value).map_err(|error| RepositoryError::Validation(error.to_string()))
      }
      DatabaseCellValueData::Url(value) | DatabaseCellValueData::Email(value) | DatabaseCellValueData::Phone(value) => {
        Ok(Value::String(value.clone()))
      }
      DatabaseCellValueData::CreatedTime(_)
      | DatabaseCellValueData::CreatedBy(_)
      | DatabaseCellValueData::UpdatedTime(_)
      | DatabaseCellValueData::UpdatedBy(_) => Err(RepositoryError::Validation(
        "database projection values are not stored as cell values".to_string(),
      )),
    }
  }

  pub(crate) fn map_cell_value_from_json(
    field_type: DatabaseFieldType,
    value: Value,
  ) -> RepoResult<DatabaseCellValueData> {
    match field_type {
      DatabaseFieldType::Title => Err(RepositoryError::Validation(
        "title values are stored on the database row title column, not cell_values".to_string(),
      )),
      DatabaseFieldType::Text => value
        .as_str()
        .map(|value| DatabaseCellValueData::Text(value.to_string()))
        .ok_or_else(|| RepositoryError::Validation("text cell value must be a string".to_string())),
      DatabaseFieldType::RichText => serde_json::from_value::<DatabaseRichTextValue>(value)
        .map(DatabaseCellValueData::RichText)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Number => value
        .as_f64()
        .filter(|value| value.is_finite())
        .map(DatabaseCellValueData::Number)
        .ok_or_else(|| RepositoryError::Validation("number cell value must be a finite number".to_string())),
      DatabaseFieldType::Percent => value
        .as_f64()
        .filter(|value| value.is_finite())
        .map(DatabaseCellValueData::Percent)
        .ok_or_else(|| RepositoryError::Validation("percent cell value must be a finite number".to_string())),
      DatabaseFieldType::Currency => serde_json::from_value::<DatabaseCurrencyValue>(value)
        .map(DatabaseCellValueData::Currency)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Duration => serde_json::from_value::<DatabaseDurationValue>(value)
        .map(DatabaseCellValueData::Duration)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Checkbox => value
        .as_bool()
        .map(DatabaseCellValueData::Checkbox)
        .ok_or_else(|| RepositoryError::Validation("checkbox cell value must be a boolean".to_string())),
      DatabaseFieldType::Date => serde_json::from_value::<DatabaseDateValue>(value)
        .map(DatabaseCellValueData::Date)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::DateTime => serde_json::from_value::<DatabaseDateTimeValue>(value)
        .map(DatabaseCellValueData::DateTime)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Files => serde_json::from_value::<DatabaseFilesValue>(value)
        .map(DatabaseCellValueData::Files)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::UniqueId => serde_json::from_value::<DatabaseUniqueIdValue>(value)
        .map(DatabaseCellValueData::UniqueId)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Select => value
        .as_str()
        .map(|value| DatabaseCellValueData::Select(value.to_string()))
        .ok_or_else(|| RepositoryError::Validation("select cell value must be an option id".to_string())),
      DatabaseFieldType::MultiSelect => serde_json::from_value::<Vec<String>>(value)
        .map(DatabaseCellValueData::MultiSelect)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Tags => serde_json::from_value::<Vec<Uuid>>(value)
        .map(DatabaseCellValueData::Tags)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Status => value
        .as_str()
        .map(|value| DatabaseCellValueData::Status(value.to_string()))
        .ok_or_else(|| RepositoryError::Validation("status cell value must be an option id".to_string())),
      DatabaseFieldType::User => value
        .as_str()
        .and_then(|value| Uuid::parse_str(value).ok())
        .map(DatabaseCellValueData::User)
        .ok_or_else(|| RepositoryError::Validation("user cell value must be a user id".to_string())),
      DatabaseFieldType::Users => serde_json::from_value::<Vec<UserId>>(value)
        .map(DatabaseCellValueData::Users)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::DocumentLink => serde_json::from_value::<DatabaseDocumentLinkValue>(value)
        .map(DatabaseCellValueData::DocumentLink)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Relation => serde_json::from_value::<Vec<DatabaseRowId>>(value)
        .map(DatabaseCellValueData::Relation)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Rollup => serde_json::from_value::<DatabaseRollupValue>(value)
        .map(DatabaseCellValueData::Rollup)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Formula => serde_json::from_value::<DatabaseFormulaValue>(value)
        .map(DatabaseCellValueData::Formula)
        .map_err(|error| RepositoryError::Validation(error.to_string())),
      DatabaseFieldType::Url => value
        .as_str()
        .map(|value| DatabaseCellValueData::Url(value.to_string()))
        .ok_or_else(|| RepositoryError::Validation("url cell value must be a string".to_string())),
      DatabaseFieldType::Email => value
        .as_str()
        .map(|value| DatabaseCellValueData::Email(value.to_string()))
        .ok_or_else(|| RepositoryError::Validation("email cell value must be a string".to_string())),
      DatabaseFieldType::Phone => value
        .as_str()
        .map(|value| DatabaseCellValueData::Phone(value.to_string()))
        .ok_or_else(|| RepositoryError::Validation("phone cell value must be a string".to_string())),
      DatabaseFieldType::CreatedTime
      | DatabaseFieldType::CreatedBy
      | DatabaseFieldType::UpdatedTime
      | DatabaseFieldType::UpdatedBy => Err(RepositoryError::Validation(
        "database projection fields do not have stored cell values".to_string(),
      )),
    }
  }

  pub(in crate::workspace_database) fn map_row(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseRow> {
    let row_kind = DatabaseRowKind::from_str(
      row
        .try_get::<String, _>("row_kind")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseRow {
      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
      // `doc_id` is the stable physical column; the handwritten domain name
      // states that this is optional page content, not Row identity.
      content_document_id: row.try_get("doc_id").map_err(Self::map_sqlx_error)?,
      row_kind,
      title: row.try_get("title").map_err(Self::map_sqlx_error)?,
      position: row.try_get("position").map_err(Self::map_sqlx_error)?,
      created_by: row.try_get("created_by").map_err(Self::map_sqlx_error)?,
      updated_by: row.try_get("updated_by").map_err(Self::map_sqlx_error)?,
      edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
      deleted_at: row.try_get("deleted_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) fn map_cell(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseCellValue> {
    let field_type = DatabaseFieldType::from_str(
      row
        .try_get::<String, _>("field_type")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let value_json: Value = row.try_get("value_json").map_err(Self::map_sqlx_error)?;
    Ok(DatabaseCellValue {
      row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
      field_id: row.try_get("field_id").map_err(Self::map_sqlx_error)?,
      field_type,
      value: Self::map_cell_value_from_json(field_type, value_json)?,
      updated_by: row.try_get("updated_by").map_err(Self::map_sqlx_error)?,
      edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) async fn list_cell_revisions_for_rows(
    &self,
    row_ids: &[DatabaseRowId],
  ) -> RepoResult<Vec<DatabaseCellRevision>> {
    Self::list_cell_revisions_for_rows_in(&self.pool, row_ids).await
  }

  pub(in crate::workspace_database) async fn list_cell_revisions_for_rows_in(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
    row_ids: &[DatabaseRowId],
  ) -> RepoResult<Vec<DatabaseCellRevision>> {
    if row_ids.is_empty() {
      return Ok(Vec::new());
    }
    let rows = sqlx::query(
      r#"
        SELECT row_id, field_id, edit_revision, value_json IS NOT NULL AS has_value
        FROM workspace_database_cell_values
        WHERE row_id = ANY($1)
        ORDER BY row_id, field_id
      "#,
    )
    .bind(row_ids)
    .fetch_all(executor)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows
      .into_iter()
      .map(|row| {
        Ok(DatabaseCellRevision {
          row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
          field_id: row.try_get("field_id").map_err(Self::map_sqlx_error)?,
          edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
          has_value: row.try_get("has_value").map_err(Self::map_sqlx_error)?,
        })
      })
      .collect()
  }

  /// Common row-insert path used by both [`DatabaseEditingRepository::create_row`]
  /// and the atomic snapshot-import transaction.
  /// The `created_by_job_id` is optional and is stamped so a
  /// cancelled/failed background import can scope compensating deletes
  /// to exactly the rows it created.
  #[expect(
    clippy::too_many_arguments,
    reason = "the repository port requires explicit row identity and edit precondition fields"
  )]
  pub(in crate::workspace_database) async fn insert_row(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    row_kind: DatabaseRowKind,
    title: String,
    created_by: UserId,
    created_by_job_id: Option<DatabaseImportJobId>,
    cells: Vec<DatabaseCellValue>,
    precondition: DatabaseEditPrecondition,
    capture: Option<DatabaseTaskCaptureReceipt>,
    content_document_id: Option<DocId>,
  ) -> RepoResult<DatabaseRowRecord> {
    let mut tx = self.begin_write().await?;
    if let Some(fence) = precondition.automation_effect {
      if crate::workflow_runtime::lock_runtime_effect(&mut tx, &fence)
        .await?
        .is_some()
      {
        Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
        let existing = self
          .get_row(row_id)
          .await?
          .filter(|row| row.row.database_id == database_id && row.row.deleted_at.is_none())
          .ok_or(RepositoryError::NotFound("automation result"))?;
        tx.commit().await.map_err(Self::map_sqlx_error)?;
        return Ok(existing);
      }
    }

    if capture.is_none() && precondition.creation_template.is_some() {
      Self::lock_row_template_database(&mut tx, database_id, precondition).await?;
    }
    if let Some(receipt) = capture.as_ref() {
      // Serialize retries before any native Row/Cell/sequence write. The receipt
      // stays identity-only and cannot cascade away when the target is purged.
      let admitted = sqlx::query("INSERT INTO database_task_capture_receipts (actor_id, workspace_id, request_id, fingerprint, database_id, row_id, edit_revision, source_json) VALUES ($1,$2,$3,$4,$5,$6,1,$7) ON CONFLICT DO NOTHING")
        .bind(receipt.actor_id).bind(receipt.workspace_id).bind(receipt.request_id)
        .bind(&receipt.fingerprint).bind(database_id).bind(row_id)
        .bind(serde_json::to_value(&receipt.source).map_err(|e| RepositoryError::Storage(e.to_string()))?)
        .execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
      if admitted.rows_affected() == 0 {
        return Err(RepositoryError::Conflict("database task capture replay"));
      }
      // Workspace-content move manifests lock the workspace root before any
      // Database. Root-origin capture must use that same order; leaf origins
      // retain the normal Database-before-document order.
      if receipt.source.document_id == receipt.workspace_id {
        Self::lock_task_capture_source(&mut tx, receipt).await?;
      }
      if precondition.creation_template.is_some() {
        Self::lock_row_template_database(&mut tx, database_id, precondition).await?;
      }
      let fields = cells.iter().map(|cell| cell.field_id).collect::<Vec<_>>();
      Self::fence_task_relation_writers(&mut tx, database_id, &fields, true).await?;
      let destination = sqlx::query_scalar::<_, Uuid>("SELECT d.id FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id WHERE d.id=$1 AND d.workspace_id=$2 AND d.deleted_at IS NULL AND p.profile_kind='project' FOR SHARE OF d,p")
        .bind(database_id).bind(receipt.workspace_id).fetch_optional(&mut *tx).await.map_err(Self::map_sqlx_error)?;
      if destination.is_none() {
        return Err(RepositoryError::Validation("capture destination unavailable".into()));
      }
      if receipt.source.document_id != receipt.workspace_id {
        Self::lock_task_capture_source(&mut tx, receipt).await?;
      }
    }
    if capture.is_none() {
      let fields = cells.iter().map(|cell| cell.field_id).collect::<Vec<_>>();
      Self::fence_task_relation_writers(&mut tx, database_id, &fields, true).await?;
    }
    if let Some((template_id, expected_revision)) = precondition.creation_template {
      // Capture can precede body preparation. Hold the real mutable source until
      // Row/content/intent publication; Force never permits a stale template.
      let actual=sqlx::query_scalar::<_,i64>("SELECT edit_revision FROM workspace_database_row_templates WHERE id=$1 AND database_id=$2 AND row_kind=$3 AND enabled FOR SHARE")
        .bind(template_id).bind(database_id).bind(row_kind.as_str()).fetch_optional(&mut *tx).await.map_err(Self::map_sqlx_error)?;
      if actual != Some(expected_revision) || expected_revision < 1 {
        return Err(RepositoryError::Conflict("database row template edit revision"));
      }
    }
    if let Some((view_id, expected_revision)) = precondition.creation_view {
      // Share-lock the actual View until insertion commits. A settings update
      // cannot retarget the captured creation intent between validation/write.
      let revision = sqlx::query_scalar::<_, i64>(
        "SELECT edit_revision FROM workspace_database_views WHERE id = $1 AND database_id = $2 FOR SHARE",
      )
      .bind(view_id)
      .bind(database_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .ok_or(RepositoryError::NotFound("database view"))?;
      Self::assert_edit_precondition(
        revision,
        DatabaseEditPrecondition::new(Some(expected_revision), false),
        "database view edit revision",
      )?;
    }
    let directly_edited_fields = cells.iter().map(|cell| cell.field_id).collect::<Vec<_>>();
    let project_policy = Self::prepare_project_mutation(&mut tx, database_id, &directly_edited_fields, true).await?;
    if let Some(fence) = precondition.automation_effect {
      Self::assert_review_capture_in_tx(&mut tx, database_id, row_id, created_by, capture.as_ref(), fence).await?;
    }
    let position = sqlx::query_scalar::<_, Option<i32>>(
      "SELECT COALESCE(MAX(position), -1) + 1 FROM workspace_database_rows WHERE database_id = $1",
    )
    .bind(database_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .unwrap_or(0);

    if let Some(doc_id) = content_document_id {
      // The prepared body is unpublished as a Row until this transaction. Hold
      // its current workspace/lifecycle through Row+Cell+intent publication.
      sqlx::query_scalar::<_, DocId>(
        r#"
        SELECT doc.id FROM docs doc JOIN workspace_databases database
          ON database.workspace_id=doc.workspace_id AND database.id=$2
        WHERE doc.id=$1 AND doc.deleted_at IS NULL AND NOT doc.blocked AND database.deleted_at IS NULL
        FOR NO KEY UPDATE OF doc
      "#,
      )
      .bind(doc_id)
      .bind(database_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .ok_or(RepositoryError::NotFound("live Row content document"))?;
      let owned: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_database_rows WHERE doc_id=$1)")
        .bind(doc_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      if owned {
        return Err(RepositoryError::Conflict("Row content document already owned"));
      }
    }
    let row = sqlx::query(
        r#"
        INSERT INTO workspace_database_rows
          (id, database_id, row_kind, title, position, created_by, updated_by, created_by_job_id, doc_id)
        VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)
        RETURNING id, database_id, doc_id, row_kind, title, position, created_by, updated_by, edit_revision, created_at, updated_at, deleted_at, created_by_job_id
      "#,
    )
    .bind(row_id)
    .bind(database_id)
    .bind(row_kind.as_str())
    .bind(&title)
    .bind(position)
    .bind(created_by)
    .bind(created_by_job_id)
    .bind(content_document_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    let mut cells = cells;
    let generated = Self::allocate_unique_id_cells(&mut tx, database_id, row_id, created_by).await?;
    if generated
      .iter()
      .any(|generated| cells.iter().any(|cell| cell.field_id == generated.field_id))
    {
      return Err(RepositoryError::Validation(
        "unique id cells are server-generated and cannot be supplied by clients".into(),
      ));
    }
    cells.extend(generated);

    for cell in &cells {
      let value_json = Self::map_cell_value_to_json(&cell.value)?;
      sqlx::query(
        r#"
          INSERT INTO workspace_database_cell_values
            (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
          VALUES ($1, $2, $3, (SELECT database_id FROM workspace_database_rows WHERE id = $1), $4, 1, now())
        "#,
      )
      .bind(row_id)
      .bind(cell.field_id)
      .bind(value_json)
      .bind(created_by)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      if let Some(policy) = project_policy.as_ref() {
        Self::validate_task_relations_after_write(&mut tx, database_id, policy).await?;
      }
      if let DatabaseCellValueData::Relation(target_row_ids) = &cell.value {
        Self::sync_relation_edges_and_reciprocals(&mut tx, row_id, cell.field_id, target_row_ids, created_by).await?;
        Self::mark_rollups_stale_for_relation_change(&mut tx, row_id, cell.field_id).await?;
      }
      Self::mark_rollups_stale_for_target_cell_change(&mut tx, row_id, cell.field_id).await?;
      Self::mark_formulas_stale_for_cell_change(&mut tx, row_id, cell.field_id).await?;
    }

    if let Some(policy) = project_policy.as_ref() {
      let derived_fields = Self::apply_project_side_effects(
        &mut tx,
        database_id,
        row_id,
        &directly_edited_fields,
        created_by,
        policy,
      )
      .await?;
      Self::validate_project_hierarchy(&mut tx, database_id, policy).await?;
      for field_id in derived_fields {
        let field_type = sqlx::query_scalar::<_, String>(
          "SELECT field_type FROM workspace_database_fields WHERE database_id = $1 AND id = $2",
        )
        .bind(database_id)
        .bind(field_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
        let value_json = sqlx::query_scalar::<_, Value>(
          "SELECT value_json FROM workspace_database_cell_values WHERE row_id = $1 AND field_id = $2 AND value_json IS NOT NULL",
        )
        .bind(row_id)
        .bind(field_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
        if let Some(value_json) = value_json {
          let field_type =
            DatabaseFieldType::from_str(&field_type).map_err(|error| RepositoryError::Validation(error.to_string()))?;
          cells.push(DatabaseCellValue {
            row_id,
            field_id,
            field_type,
            value: Self::map_cell_value_from_json(field_type, value_json)?,
            updated_by: Some(created_by),
            edit_revision: 1,
            updated_at: Utc::now(),
          });
        }
      }
    }

    let fields = Self::list_fields_for(&mut *tx, database_id).await?;
    let views = Self::list_views_for(&mut *tx, database_id).await?;
    if let Some(policy) = project_policy.as_ref() {
      let task = row_kind == DatabaseRowKind::Task;
      validate_project_task_temporal_ranges(
        &fields,
        &views,
        task
          .then(|| Self::project_role_field(policy, "task.startDate"))
          .flatten(),
        task.then(|| Self::project_role_field(policy, "task.dueDate")).flatten(),
        &cells,
        row.try_get("created_at").map_err(Self::map_sqlx_error)?,
        row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
        &HashMap::new(),
        true,
      )
      .map_err(RepositoryError::Validation)?;
    } else {
      validate_database_temporal_ranges(
        &fields,
        &views,
        &cells,
        row.try_get("created_at").map_err(Self::map_sqlx_error)?,
        row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
        &HashMap::new(),
      )
      .map_err(RepositoryError::Validation)?;
    }
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    if let Some(receipt) = capture.as_ref() {
      sqlx::query("INSERT INTO database_row_source_links (row_id,source_workspace_id,source_document_id,source_external_id,block_id,selection_anchor) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(row_id).bind(receipt.source.source_workspace_id).bind(receipt.source.document_id)
        .bind(&receipt.source.external_id).bind(&receipt.source.block_id).bind(&receipt.source.selection_anchor)
        .execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
      Self::replace_document_references(&mut tx, receipt.workspace_id, database_id, row_id).await?;
    }
    if content_document_id.is_some() {
      let workspace = sqlx::query_scalar::<_, WorkspaceId>("SELECT workspace_id FROM workspace_databases WHERE id=$1")
        .bind(database_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      Self::replace_document_references(&mut tx, workspace, database_id, row_id).await?;
    }
    let intent_changes = cells
      .iter()
      .map(|cell| DatabaseCommittedCellChange {
        row_id,
        field_id: cell.field_id,
        previous_value: None,
        value: Some(cell.value.clone()),
        edit_revision: cell.edit_revision,
      })
      .collect::<Vec<_>>();
    Self::insert_task_notification_intents(&mut tx, database_id, created_by, &intent_changes, true).await?;
    if precondition.automation_effect.is_none() {
      Self::insert_automation_event(
        &mut tx,
        database_id,
        row_id,
        created_by,
        myoxus_domain::workspace_automation::WorkspaceAutomationTriggerType::RowCreated,
        None,
        None,
        None,
      )
      .await?;
    }
    if let Some(fence) = precondition.automation_effect {
      crate::workflow_runtime::acknowledge_runtime_effect(
        &mut tx,
        &fence,
        serde_json::json!({"row_id":row_id,"database_id":database_id}),
      )
      .await?;
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(DatabaseRowRecord {
      row: Self::map_row(row)?,
      cell_revisions: cells
        .iter()
        .map(|cell| DatabaseCellRevision {
          row_id: cell.row_id,
          field_id: cell.field_id,
          edit_revision: 1,
          has_value: true,
        })
        .collect(),
      cells,
    })
  }

  pub(crate) async fn allocate_unique_id_cells(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    actor: UserId,
  ) -> RepoResult<Vec<DatabaseCellValue>> {
    let unique_fields_sql = format!(
      r#"
        SELECT id, config_json
        FROM {DATABASE_FIELDS_TABLE}
        WHERE database_id = $1 AND field_type = 'unique_id'
        ORDER BY position ASC, id ASC
      "#,
    );
    let unique_fields = sqlx::query(&unique_fields_sql)
      .bind(database_id)
      .fetch_all(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut cells = Vec::new();
    for field_row in unique_fields {
      let field_id: DatabaseFieldId = field_row.try_get("id").map_err(Self::map_sqlx_error)?;
      let config_json: Value = field_row.try_get("config_json").map_err(Self::map_sqlx_error)?;
      let config: DatabaseFieldConfig =
        serde_json::from_value(config_json).map_err(|error| RepositoryError::Validation(error.to_string()))?;
      let DatabaseFieldConfig::UniqueId(config) = config else {
        return Err(RepositoryError::Validation(
          "unique id sequence allocation requires unique id field config".to_string(),
        ));
      };
      let sequence: i64 = sqlx::query_scalar(
        r#"
          INSERT INTO database_unique_id_sequences (database_id, field_id, next_value, created_at, updated_at)
          VALUES ($1, $2, $3 + 1, now(), now())
          ON CONFLICT (field_id) DO UPDATE
            SET next_value = database_unique_id_sequences.next_value + 1,
                updated_at = now()
          RETURNING next_value - 1
        "#,
      )
      .bind(database_id)
      .bind(field_id)
      .bind(config.start_number)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      cells.push(DatabaseCellValue {
        row_id,
        field_id,
        field_type: DatabaseFieldType::UniqueId,
        value: DatabaseCellValueData::UniqueId(DatabaseUniqueIdValue {
          display: format_database_unique_id(&config.prefix, sequence, config.padding),
          prefix: config.prefix,
          sequence,
        }),
        updated_by: Some(actor),
        edit_revision: 1,
        updated_at: chrono::Utc::now(),
      });
    }

    Ok(cells)
  }
}

impl PgDatabaseRepository {
  #[instrument(skip(self, title, cells), fields(database_id = %database_id, row_id = %row_id))]
  pub(in crate::workspace_database) async fn persist_create_row(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    row_kind: DatabaseRowKind,
    title: String,
    created_by: UserId,
    cells: Vec<DatabaseCellValue>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    self
      .insert_row(
        database_id,
        row_id,
        row_kind,
        title,
        created_by,
        None,
        cells,
        precondition,
        None,
        None,
      )
      .await
  }

  pub(in crate::workspace_database) async fn persist_get_row(
    &self,
    row_id: DatabaseRowId,
  ) -> RepoResult<Option<DatabaseRowRecord>> {
    let Some(row) = sqlx::query(
      r#"
        SELECT r.id, r.database_id, r.doc_id, r.title, r.position,
               r.row_kind, r.created_by, r.updated_by, r.edit_revision, r.created_at, r.updated_at,
               r.deleted_at AS deleted_at
        FROM workspace_database_rows r
        WHERE r.id = $1
      "#,
    )
    .bind(row_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    else {
      return Ok(None);
    };
    let mut record = DatabaseRowRecord {
      row: Self::map_row(row)?,
      cells: Vec::new(),
      cell_revisions: Vec::new(),
    };
    let cell_rows = sqlx::query(
      r#"
        SELECT cv.row_id, cv.field_id, f.field_type, cv.value_json, cv.updated_by, cv.edit_revision, cv.updated_at
        FROM workspace_database_cell_values cv
        JOIN workspace_database_fields f ON f.id = cv.field_id
        WHERE cv.row_id = $1 AND cv.value_json IS NOT NULL
        ORDER BY f.position ASC, f.id ASC
      "#,
    )
    .bind(row_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    record.cells = cell_rows
      .into_iter()
      .map(Self::map_cell)
      .collect::<RepoResult<Vec<_>>>()?;
    record.cell_revisions = self.list_cell_revisions_for_rows(&[row_id]).await?;
    record.cells.extend(self.list_rollup_cells_for_rows(&[row_id]).await?);
    record.cells.extend(self.list_formula_cells_for_rows(&[row_id]).await?);
    Ok(Some(record))
  }

  #[instrument(skip(self), fields(database_id = %database_id, row_id = %row_id, position))]
  pub(in crate::workspace_database) async fn persist_update_row_position(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    position: i32,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    let mut tx = self.begin_write().await?;
    Self::lock_managed_admission(&mut tx, database_id).await?;

    let locked_rows = sqlx::query(
      r#"
        SELECT id, edit_revision
        FROM workspace_database_rows
        WHERE database_id = $1
        ORDER BY position ASC, id ASC
        FOR UPDATE
      "#,
    )
    .bind(database_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    let rows = locked_rows
      .iter()
      .map(|row| row.try_get::<DatabaseRowId, _>("id").map_err(Self::map_sqlx_error))
      .collect::<RepoResult<Vec<_>>>()?;
    let actual_revision = locked_rows.iter().find_map(|row| {
      let id = row.try_get::<DatabaseRowId, _>("id").ok()?;
      (id == row_id)
        .then(|| row.try_get::<i64, _>("edit_revision").ok())
        .flatten()
    });
    let Some(actual_revision) = actual_revision else {
      return Err(RepositoryError::NotFound("database row"));
    };
    Self::assert_edit_precondition(actual_revision, precondition, "database row edit revision")?;

    let mut ordered_rows = rows
      .into_iter()
      .filter(|candidate_id| *candidate_id != row_id)
      .collect::<Vec<_>>();
    let insert_at = (position.max(0) as usize).min(ordered_rows.len());
    ordered_rows.insert(insert_at, row_id);

    let result = sqlx::query(
      r#"
        UPDATE workspace_database_rows row
        SET position = ordered.ordinality::int - 1,
            updated_by = CASE WHEN row.id = $3 THEN $4 ELSE row.updated_by END,
            edit_revision = row.edit_revision
              + CASE WHEN row.id = $3 OR row.position <> ordered.ordinality::int - 1 THEN 1 ELSE 0 END,
            updated_at = CASE
              WHEN row.id = $3 OR row.position <> ordered.ordinality::int - 1 THEN now()
              ELSE row.updated_at
            END
        FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, ordinality)
        WHERE row.database_id = $1 AND row.id = ordered.id
      "#,
    )
    .bind(database_id)
    .bind(&ordered_rows)
    .bind(row_id)
    .bind(updated_by)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if result.rows_affected() != ordered_rows.len() as u64 {
      return Err(RepositoryError::NotFound("database row"));
    }

    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    self
      .get_row(row_id)
      .await?
      .ok_or(RepositoryError::NotFound("database row"))
  }

  pub(in crate::workspace_database) async fn persist_update_cell_value(
    &self,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
    reminder_reschedules: Option<Vec<DatabaseRowReminderReschedule>>,
  ) -> RepoResult<DatabaseCellWriteOutcome> {
    let mut tx = self.begin_write().await?;
    if let Some(fence) = precondition.automation_effect {
      crate::workflow_runtime::lock_runtime_effect(&mut tx, &fence).await?;
    }
    PgWorkspaceAutomationRepository::lock_document_review_tasks(&mut tx, &[row_id]).await?;
    let result = self
      .update_cell_value_in_tx(
        &mut tx,
        row_id,
        field_id,
        value,
        updated_by,
        precondition,
        reminder_reschedules,
      )
      .await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(result)
  }
  pub(in crate::workspace_database) async fn update_cell_value_in_tx(
    &self,
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
    reminder_reschedules: Option<Vec<DatabaseRowReminderReschedule>>,
  ) -> RepoResult<DatabaseCellWriteOutcome> {
    let updates_date_time = matches!(value, DatabaseCellValueData::DateTime(_));
    let value_json = Self::map_cell_value_to_json(&value)?;
    let relation_target_row_ids = match &value {
      DatabaseCellValueData::Relation(row_ids) => Some(row_ids.clone()),
      _ => None,
    };
    if let Some(fence) = precondition.automation_effect {
      if crate::workflow_runtime::lock_runtime_effect(tx, &fence)
        .await?
        .is_some()
      {
        let existing = self
          .get_row(row_id)
          .await?
          .filter(|row| row.row.deleted_at.is_none())
          .ok_or(RepositoryError::NotFound("automation result"))?;
        Self::assert_database_workspace(tx, existing.row.database_id, precondition).await?;
        let cell = existing
          .cells
          .into_iter()
          .find(|cell| cell.field_id == field_id)
          .ok_or(RepositoryError::NotFound("automation result cell"))?;
        return Ok(DatabaseCellWriteOutcome {
          change: DatabaseCommittedCellChange {
            row_id,
            field_id,
            previous_value: Some(cell.value.clone()),
            value: Some(cell.value.clone()),
            edit_revision: cell.edit_revision,
          },
          cell,
        });
      }
    }

    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_rows WHERE id = $1")
        .bind(row_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database row"))?;
    let project_policy = Self::prepare_project_mutation(tx, database_id, &[field_id], false).await?;
    sqlx::query_scalar::<_, DatabaseRowId>(
      r#"SELECT id FROM workspace_database_rows
         WHERE id=$1 AND (NOT $2 OR deleted_at IS NULL) FOR UPDATE"#,
    )
    .bind(row_id)
    .bind(
      project_policy
        .as_ref()
        .is_some_and(|policy| policy.parent_before.is_some() || policy.blocker_before.is_some()),
    )
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database row"))?;
    Self::assert_project_task_sources_live(tx, database_id, &[row_id], project_policy.is_some()).await?;
    let previous_value = Self::previous_cell_value(tx, row_id, field_id, Some(&value)).await?;
    let actual_revision = sqlx::query_scalar::<_, i64>(
      "SELECT edit_revision FROM workspace_database_cell_values WHERE row_id = $1 AND field_id = $2",
    )
    .bind(row_id)
    .bind(field_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .unwrap_or(0);
    Self::assert_edit_precondition(actual_revision, precondition, "database cell edit revision")?;
    let locked_reminders = if updates_date_time {
      Self::lock_cell_reminder_generations(tx, row_id, field_id).await?
    } else {
      Vec::new()
    };
    let reminder_reschedules = reminder_reschedules.unwrap_or_default();
    if updates_date_time && locked_reminders.len() != reminder_reschedules.len() {
      return Err(RepositoryError::Conflict("database reminder schedule revision"));
    }
    let reminder_reschedules = reminder_reschedules
      .into_iter()
      .map(|reschedule| (reschedule.reminder_id, reschedule))
      .collect::<HashMap<_, _>>();
    for locked in &locked_reminders {
      let reminder_id: Uuid = locked.try_get("id").map_err(Self::map_sqlx_error)?;
      let schedule_revision: i64 = locked.try_get("schedule_revision").map_err(Self::map_sqlx_error)?;
      if reminder_reschedules
        .get(&reminder_id)
        .is_none_or(|reschedule| reschedule.expected_schedule_revision != schedule_revision)
      {
        return Err(RepositoryError::Conflict("database reminder schedule revision"));
      }
    }
    let row = sqlx::query(
      r#"
        INSERT INTO workspace_database_cell_values
          (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
        VALUES ($1, $2, $3, (SELECT database_id FROM workspace_database_rows WHERE id = $1), $4, 1, now())
        ON CONFLICT (row_id, field_id) DO UPDATE
          SET value_json = EXCLUDED.value_json,
              database_id = EXCLUDED.database_id,
              updated_by = EXCLUDED.updated_by,
              edit_revision = workspace_database_cell_values.edit_revision + 1,
              updated_at = now()
        RETURNING row_id, field_id,
          (SELECT field_type FROM workspace_database_fields WHERE id = $2) AS field_type,
          value_json, updated_by, edit_revision, updated_at
      "#,
    )
    .bind(row_id)
    .bind(field_id)
    .bind(value_json)
    .bind(updated_by)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    for reschedule in reminder_reschedules.values() {
      let updated = Self::reschedule_reminder_generation(tx, reschedule).await?;
      if updated.rows_affected() != 1 {
        return Err(RepositoryError::Conflict("database reminder schedule revision"));
      }
    }
    if updates_date_time {
      // A notification job may still be waiting after enqueue changed the
      // Reminder to `fired`; revision invalidation makes that old job a no-op.
      Self::invalidate_fired_cell_reminders(tx, row_id, field_id).await?;
    }
    if let Some(policy) = project_policy.as_ref() {
      Self::validate_task_relations_after_write(tx, database_id, policy).await?;
    }
    if let Some(target_row_ids) = relation_target_row_ids {
      Self::sync_relation_edges_and_reciprocals(tx, row_id, field_id, &target_row_ids, updated_by).await?;
      Self::mark_rollups_stale_for_relation_change(tx, row_id, field_id).await?;
    }
    Self::mark_rollups_stale_for_target_cell_change(tx, row_id, field_id).await?;
    Self::mark_formulas_stale_for_cell_change(tx, row_id, field_id).await?;
    if let Some(policy) = project_policy.as_ref() {
      Self::apply_project_side_effects(tx, database_id, row_id, &[field_id], updated_by, policy).await?;
      Self::validate_project_hierarchy(tx, database_id, policy).await?;
      Self::validate_project_task_dates_after_write(
        tx,
        database_id,
        row_id,
        policy,
        &HashMap::from([(field_id, Some(value.clone()))]),
      )
      .await?;
    }
    Self::assert_database_workspace(tx, database_id, precondition).await?;
    let cell = Self::map_cell(row)?;
    Self::insert_row_change_intents(
      tx,
      database_id,
      updated_by,
      &[DatabaseCommittedCellChange {
        row_id,
        field_id,
        previous_value: previous_value.clone(),
        value: Some(cell.value.clone()),
        edit_revision: cell.edit_revision,
      }],
      precondition,
    )
    .await?;
    if let Some(fence) = precondition.automation_effect {
      crate::workflow_runtime::acknowledge_runtime_effect(
        tx,
        &fence,
        serde_json::json!({"row_id":row_id,"field_id":field_id}),
      )
      .await?;
    }
    Ok(DatabaseCellWriteOutcome {
      change: DatabaseCommittedCellChange {
        row_id,
        field_id,
        previous_value,
        value: Some(cell.value.clone()),
        edit_revision: cell.edit_revision,
      },
      cell,
    })
  }

  pub(in crate::workspace_database) async fn persist_clear_cell_value(
    &self,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseCellClearOutcome> {
    let mut tx = self.begin_write().await?;
    if let Some(fence) = precondition.automation_effect {
      if crate::workflow_runtime::lock_runtime_effect(&mut tx, &fence)
        .await?
        .is_some()
      {
        let existing = self
          .get_row(row_id)
          .await?
          .filter(|row| row.row.deleted_at.is_none())
          .ok_or(RepositoryError::NotFound("automation result"))?;
        Self::assert_database_workspace(&mut tx, existing.row.database_id, precondition).await?;
        let revision = existing
          .cell_revisions
          .into_iter()
          .find(|slot| slot.field_id == field_id)
          .ok_or(RepositoryError::NotFound("automation result cell"))?;
        let value = existing
          .cells
          .iter()
          .find(|cell| cell.field_id == field_id)
          .map(|cell| cell.value.clone());
        tx.commit().await.map_err(Self::map_sqlx_error)?;
        return Ok(DatabaseCellClearOutcome {
          change: DatabaseCommittedCellChange {
            row_id,
            field_id,
            previous_value: value.clone(),
            value,
            edit_revision: revision.edit_revision,
          },
          revision,
        });
      }
    }

    PgWorkspaceAutomationRepository::lock_document_review_tasks(&mut tx, &[row_id]).await?;

    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_rows WHERE id = $1")
        .bind(row_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("database row"))?;
    let project_policy = Self::prepare_project_mutation(&mut tx, database_id, &[field_id], false).await?;
    sqlx::query_scalar::<_, DatabaseRowId>(
      r#"SELECT id FROM workspace_database_rows
         WHERE id=$1 AND (NOT $2 OR deleted_at IS NULL) FOR UPDATE"#,
    )
    .bind(row_id)
    .bind(
      project_policy
        .as_ref()
        .is_some_and(|policy| policy.parent_before.is_some() || policy.blocker_before.is_some()),
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database row"))?;
    Self::assert_project_task_sources_live(&mut tx, database_id, &[row_id], project_policy.is_some()).await?;
    let actual_revision = sqlx::query_scalar::<_, i64>(
      "SELECT edit_revision FROM workspace_database_cell_values WHERE row_id = $1 AND field_id = $2",
    )
    .bind(row_id)
    .bind(field_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .unwrap_or(0);
    Self::assert_edit_precondition(actual_revision, precondition, "database cell edit revision")?;
    let previous_value = Self::previous_cell_value(&mut tx, row_id, field_id, None).await?;
    Self::clear_relation_edges_and_reciprocals(&mut tx, row_id, field_id, updated_by).await?;
    Self::mark_rollups_stale_for_relation_change(&mut tx, row_id, field_id).await?;
    Self::mark_rollups_stale_for_target_cell_change(&mut tx, row_id, field_id).await?;
    Self::mark_formulas_stale_for_cell_change(&mut tx, row_id, field_id).await?;
    let revision = sqlx::query_scalar::<_, i64>(
      r#"
        INSERT INTO workspace_database_cell_values
          (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
        VALUES ($1, $2, NULL, (SELECT database_id FROM workspace_database_rows WHERE id = $1), $3, 1, now())
        ON CONFLICT (row_id, field_id) DO UPDATE
          SET value_json = NULL,
              database_id = EXCLUDED.database_id,
              updated_by = EXCLUDED.updated_by,
              edit_revision = workspace_database_cell_values.edit_revision + 1,
              updated_at = now()
        RETURNING edit_revision
      "#,
    )
    .bind(row_id)
    .bind(field_id)
    .bind(updated_by)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if let Some(policy) = project_policy.as_ref() {
      Self::apply_project_side_effects(&mut tx, database_id, row_id, &[field_id], updated_by, policy).await?;
      Self::validate_project_hierarchy(&mut tx, database_id, policy).await?;
    }
    Self::cancel_cell_reminders(&mut tx, &[row_id], field_id).await?;
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    Self::insert_row_change_intents(
      &mut tx,
      database_id,
      updated_by,
      &[DatabaseCommittedCellChange {
        row_id,
        field_id,
        previous_value: previous_value.clone(),
        value: None,
        edit_revision: revision,
      }],
      precondition,
    )
    .await?;
    if let Some(fence) = precondition.automation_effect {
      crate::workflow_runtime::acknowledge_runtime_effect(
        &mut tx,
        &fence,
        serde_json::json!({"row_id":row_id,"field_id":field_id}),
      )
      .await?;
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(DatabaseCellClearOutcome {
      revision: DatabaseCellRevision {
        row_id,
        field_id,
        edit_revision: revision,
        has_value: false,
      },
      change: DatabaseCommittedCellChange {
        row_id,
        field_id,
        edit_revision: revision,
        previous_value,
        value: None,
      },
    })
  }

  pub(in crate::workspace_database) async fn persist_update_row_title(
    &self,
    row_id: DatabaseRowId,
    title: String,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowRecord> {
    let mut tx = self.begin_write().await?;
    if let Some(fence) = precondition.automation_effect {
      if crate::workflow_runtime::lock_runtime_effect(&mut tx, &fence)
        .await?
        .is_some()
      {
        let existing = self
          .get_row(row_id)
          .await?
          .filter(|row| row.row.deleted_at.is_none())
          .ok_or(RepositoryError::NotFound("automation result"))?;
        Self::assert_database_workspace(&mut tx, existing.row.database_id, precondition).await?;
        tx.commit().await.map_err(Self::map_sqlx_error)?;
        return Ok(existing);
      }
    }

    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_database_rows", row_id, "database row").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database row edit revision")?;
    let previous_title: String = sqlx::query_scalar("SELECT title FROM workspace_database_rows WHERE id=$1")
      .bind(row_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let row = sqlx::query(
      r#"
        UPDATE workspace_database_rows r
        SET title = $2,
            updated_by = $3,
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE r.id = $1
        RETURNING r.id, r.database_id, r.doc_id, r.title, r.position,
          r.row_kind, r.created_by, r.updated_by, r.edit_revision, r.created_at, r.updated_at,
          (SELECT d.deleted_at FROM docs d WHERE d.id = r.doc_id) AS deleted_at
      "#,
    )
    .bind(row_id)
    .bind(title)
    .bind(updated_by)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("database row"))?;
    let mapped_row = Self::map_row(row)?;
    if let Some(title_field_id) = sqlx::query_scalar::<_, DatabaseFieldId>(
      r#"
        SELECT id
        FROM workspace_database_fields
        WHERE database_id = $1 AND field_type = 'title'
        ORDER BY position ASC
        LIMIT 1
      "#,
    )
    .bind(mapped_row.database_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    {
      if precondition.automation_effect.is_none() {
        Self::insert_automation_event(
          &mut tx,
          mapped_row.database_id,
          row_id,
          updated_by,
          myoxus_domain::workspace_automation::WorkspaceAutomationTriggerType::RowUpdated,
          Some(title_field_id),
          Some(DatabaseCellValueData::Text(previous_title)),
          Some(DatabaseCellValueData::Text(mapped_row.title.clone())),
        )
        .await?;
      }
      Self::mark_formulas_stale_for_cell_change(&mut tx, row_id, title_field_id).await?;
    }
    Self::assert_database_workspace(&mut tx, mapped_row.database_id, precondition).await?;
    if let Some(fence) = precondition.automation_effect {
      crate::workflow_runtime::acknowledge_runtime_effect(&mut tx, &fence, serde_json::json!({"row_id":row_id}))
        .await?;
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(DatabaseRowRecord {
      row: mapped_row,
      cells: Vec::new(),
      cell_revisions: Vec::new(),
    })
  }

  pub(in crate::workspace_database) async fn persist_delete_row(
    &self,
    row_id: DatabaseRowId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    PgWorkspaceAutomationRepository::lock_document_review_tasks(&mut tx, &[row_id]).await?;
    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_rows WHERE id = $1")
        .bind(row_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    let _parent_policy = Self::prepare_task_graph_mutation(&mut tx, database_id).await?;
    let actual_revision =
      Self::lock_entity_edit_revision(&mut tx, "workspace_database_rows", row_id, "database row").await?;
    Self::assert_edit_precondition(actual_revision, precondition, "database row edit revision")?;
    let incoming_relation_cells = sqlx::query(
      r#"
        SELECT DISTINCT source_row_id, source_field_id
        FROM workspace_database_relation_edges
        WHERE target_row_id = $1
        ORDER BY source_row_id ASC, source_field_id ASC
      "#,
    )
    .bind(row_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    for relation_cell in incoming_relation_cells {
      let source_row_id: DatabaseRowId = relation_cell.try_get("source_row_id").map_err(Self::map_sqlx_error)?;
      let source_field_id: DatabaseFieldId = relation_cell.try_get("source_field_id").map_err(Self::map_sqlx_error)?;
      // Trash retains canonical Task Parent/BlockedBy associations. Other source-kind/role
      // owners of a shared physical field keep ordinary Relation cleanup.
      let source_is_task =
        sqlx::query_scalar::<_, bool>("SELECT row_kind='task' FROM workspace_database_rows WHERE id=$1")
          .bind(source_row_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(Self::map_sqlx_error)?;
      if source_is_task
        && Self::authoritative_task_relation_cell(&mut tx, source_row_id, source_field_id)
          .await?
          .is_some()
      {
        continue;
      }
      let remaining_target_row_ids = sqlx::query_scalar::<_, DatabaseRowId>(
        r#"
          SELECT target_row_id
          FROM workspace_database_relation_edges
          WHERE source_row_id = $1 AND source_field_id = $2 AND target_row_id <> $3
          ORDER BY position ASC, target_row_id ASC
        "#,
      )
      .bind(source_row_id)
      .bind(source_field_id)
      .bind(row_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      if remaining_target_row_ids.is_empty() {
        sqlx::query(
          r#"
            UPDATE workspace_database_cell_values
            SET value_json = NULL,
                edit_revision = edit_revision + 1,
                updated_at = now()
            WHERE row_id = $1 AND field_id = $2
          "#,
        )
        .bind(source_row_id)
        .bind(source_field_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      } else {
        let value_json = serde_json::to_value(&remaining_target_row_ids)
          .map_err(|error| RepositoryError::Validation(error.to_string()))?;
        sqlx::query(
          r#"
            UPDATE workspace_database_cell_values
            SET value_json = $3,
                edit_revision = edit_revision + 1,
                updated_at = now()
            WHERE row_id = $1 AND field_id = $2
          "#,
        )
        .bind(source_row_id)
        .bind(source_field_id)
        .bind(value_json)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      }
      Self::sync_relation_edges(&mut tx, source_row_id, source_field_id, &remaining_target_row_ids).await?;
      Self::mark_rollups_stale_for_relation_change(&mut tx, source_row_id, source_field_id).await?;
    }

    // Rows are soft-deleted, so foreign-key cascades do not remove edges whose
    // source is the deleted row. Reciprocal source cells were rewritten by the
    // incoming-edge loop above; remove the hidden row's own edge projection in
    // the same transaction so no query can observe a live relation to it.
    sqlx::query("DELETE FROM workspace_database_relation_edges WHERE source_row_id = $1")
      .bind(row_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;

    // P-DB-26: real soft-delete. The single-row `delete_row` now stamps
    // `deleted_at` rather than issuing a hard `DELETE`, so it composes
    // with `bulk_restore_rows` for full undo. The relation-edge sweep
    // above still runs so referential cells update correctly.
    let result = sqlx::query(
      r#"
        UPDATE workspace_database_rows
        SET deleted_at = COALESCE(deleted_at, now()),
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE id = $1
      "#,
    )
    .bind(row_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("database row"));
    }
    sqlx::query("DELETE FROM workspace_database_row_search WHERE row_id = $1")
      .bind(row_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query("DELETE FROM database_document_references WHERE row_id = $1")
      .bind(row_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    Self::cancel_rows_reminders(&mut tx, &[row_id]).await?;
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    PgWorkspaceAutomationRepository::invalidate_document_review_tasks(&mut tx, &[row_id]).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }
}
