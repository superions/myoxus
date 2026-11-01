// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

impl PgDatabaseRepository {
  fn map_rollup_cell(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseCellValue> {
    let stale_state = DatabaseRollupStaleState::from_str(
      row
        .try_get::<String, _>("stale_state")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let value_json: Option<Value> = row.try_get("value_json").map_err(Self::map_sqlx_error)?;
    let value = value_json
      .map(serde_json::from_value::<DatabaseRollupScalarValue>)
      .transpose()
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseCellValue {
      row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
      field_id: row.try_get("field_id").map_err(Self::map_sqlx_error)?,
      field_type: DatabaseFieldType::Rollup,
      value: DatabaseCellValueData::Rollup(DatabaseRollupValue {
        value,
        stale_state,
        computed_at: row.try_get("computed_at").map_err(Self::map_sqlx_error)?,
        failed_at: row.try_get("failed_at").map_err(Self::map_sqlx_error)?,
        error_code: row.try_get("error_code").map_err(Self::map_sqlx_error)?,
        error_message: row.try_get("error_message").map_err(Self::map_sqlx_error)?,
      }),
      updated_by: None,
      edit_revision: 0,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  fn map_formula_cell(row: sqlx::postgres::PgRow) -> RepoResult<DatabaseCellValue> {
    let stale_state = DatabaseFormulaStaleState::from_str(
      row
        .try_get::<String, _>("stale_state")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let value_json: Option<Value> = row.try_get("value_json").map_err(Self::map_sqlx_error)?;
    let value = value_json
      .map(serde_json::from_value::<DatabaseFormulaScalarValue>)
      .transpose()
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(DatabaseCellValue {
      row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
      field_id: row.try_get("field_id").map_err(Self::map_sqlx_error)?,
      field_type: DatabaseFieldType::Formula,
      value: DatabaseCellValueData::Formula(DatabaseFormulaValue {
        value,
        stale_state,
        computed_at: row.try_get("computed_at").map_err(Self::map_sqlx_error)?,
        failed_at: row.try_get("failed_at").map_err(Self::map_sqlx_error)?,
        error_code: row.try_get("error_code").map_err(Self::map_sqlx_error)?,
        error_message: row.try_get("error_message").map_err(Self::map_sqlx_error)?,
      }),
      updated_by: None,
      edit_revision: 0,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) async fn list_rollup_cells_for_rows(
    &self,
    row_ids: &[DatabaseRowId],
  ) -> RepoResult<Vec<DatabaseCellValue>> {
    Self::list_rollup_cells_for_rows_in(&self.pool, row_ids).await
  }

  pub(in crate::workspace_database) async fn list_rollup_cells_for_rows_in(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
    row_ids: &[DatabaseRowId],
  ) -> RepoResult<Vec<DatabaseCellValue>> {
    if row_ids.is_empty() {
      return Ok(Vec::new());
    }
    let rows = sqlx::query(
      r#"
        SELECT rv.row_id, rv.field_id, rv.value_json, rv.stale_state,
               rv.computed_at, rv.failed_at, rv.error_code, rv.error_message,
               rv.updated_at
        FROM workspace_database_rollup_values rv
        JOIN workspace_database_fields f ON f.id = rv.field_id
        WHERE rv.row_id = ANY($1)
        ORDER BY f.position ASC, f.id ASC
      "#,
    )
    .bind(row_ids)
    .fetch_all(executor)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows.into_iter().map(Self::map_rollup_cell).collect()
  }

  pub(in crate::workspace_database) async fn list_formula_cells_for_rows(
    &self,
    row_ids: &[DatabaseRowId],
  ) -> RepoResult<Vec<DatabaseCellValue>> {
    Self::list_formula_cells_for_rows_in(&self.pool, row_ids).await
  }

  pub(in crate::workspace_database) async fn list_formula_cells_for_rows_in(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
    row_ids: &[DatabaseRowId],
  ) -> RepoResult<Vec<DatabaseCellValue>> {
    if row_ids.is_empty() {
      return Ok(Vec::new());
    }
    let rows = sqlx::query(
      r#"
        SELECT fv.row_id, fv.field_id, fv.value_json, fv.stale_state,
               fv.computed_at, fv.failed_at, fv.error_code, fv.error_message,
               fv.updated_at
        FROM workspace_database_formula_values fv
        JOIN workspace_database_fields f ON f.id = fv.field_id
        WHERE fv.row_id = ANY($1)
        ORDER BY f.position ASC, f.id ASC
      "#,
    )
    .bind(row_ids)
    .fetch_all(executor)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows.into_iter().map(Self::map_formula_cell).collect()
  }
}
