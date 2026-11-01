// SPDX-License-Identifier: AGPL-3.0-or-later
//! Derived invalidation and owner locks participate in the caller's transaction.

use super::*;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn mark_rollups_stale_for_relation_change(
    tx: &mut Transaction<'_, Postgres>,
    source_row_id: DatabaseRowId,
    source_relation_field_id: DatabaseFieldId,
  ) -> RepoResult<()> {
    sqlx::query(
      r#"
        INSERT INTO workspace_database_rollup_values
          (database_id, row_id, field_id, value_json, source_hash, stale_state, computed_at,
           failed_at, error_code, error_message, updated_at)
        SELECT f.database_id, $1, f.id, NULL, NULL, 'stale', NULL, NULL, NULL, NULL, now()
        FROM workspace_database_fields f
        JOIN workspace_database_rows r ON r.database_id = f.database_id
        WHERE r.id = $1
          AND f.field_type = 'rollup'
          AND f.config_json->>'sourceRelationFieldId' = $2::text
        ON CONFLICT (row_id, field_id) DO UPDATE
          SET stale_state = 'stale',
              updated_at = now()
      "#,
    )
    .bind(source_row_id)
    .bind(source_relation_field_id.to_string())
    .execute(&mut **tx)
    .await
    .map_err(Self::map_snapshot_sqlx_error)?;
    Ok(())
  }

  pub(in crate::workspace_database) async fn mark_rollups_stale_for_target_cell_change(
    tx: &mut Transaction<'_, Postgres>,
    target_row_id: DatabaseRowId,
    target_field_id: DatabaseFieldId,
  ) -> RepoResult<()> {
    sqlx::query(
      r#"
        INSERT INTO workspace_database_rollup_values
          (database_id, row_id, field_id, value_json, source_hash, stale_state, computed_at,
           failed_at, error_code, error_message, updated_at)
        SELECT rollup.database_id, edge.source_row_id, rollup.id,
               NULL, NULL, 'stale', NULL, NULL, NULL, NULL, now()
        FROM workspace_database_relation_edges edge
        JOIN workspace_database_fields rollup
          ON rollup.database_id = edge.source_database_id
         AND rollup.field_type = 'rollup'
         AND rollup.config_json->>'sourceRelationFieldId' = edge.source_field_id::text
         AND rollup.config_json->>'targetFieldId' = $2::text
        WHERE edge.target_row_id = $1
        ON CONFLICT (row_id, field_id) DO UPDATE
          SET stale_state = 'stale',
              updated_at = now()
      "#,
    )
    .bind(target_row_id)
    .bind(target_field_id.to_string())
    .execute(&mut **tx)
    .await
    .map_err(Self::map_snapshot_sqlx_error)?;
    Ok(())
  }

  pub(in crate::workspace_database) async fn mark_formulas_stale_for_cell_change(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
    dependency_field_id: DatabaseFieldId,
  ) -> RepoResult<()> {
    sqlx::query(
      r#"
        INSERT INTO workspace_database_formula_values
          (database_id, row_id, field_id, value_json, source_hash, stale_state, computed_at,
           failed_at, error_code, error_message, updated_at)
        SELECT formula.database_id, $1, formula.id,
               NULL, NULL, 'stale', NULL, NULL, NULL, NULL, now()
        FROM workspace_database_fields formula
        JOIN workspace_database_rows r ON r.database_id = formula.database_id
        JOIN workspace_database_formula_dependencies dep ON dep.formula_field_id = formula.id
        WHERE r.id = $1
          AND formula.field_type = 'formula'
          AND dep.dependency_field_id = $2
        ON CONFLICT (row_id, field_id) DO UPDATE
          SET stale_state = 'stale',
              updated_at = now()
      "#,
    )
    .bind(row_id)
    .bind(dependency_field_id)
    .execute(&mut **tx)
    .await
    .map_err(Self::map_snapshot_sqlx_error)?;
    Ok(())
  }

  /// A background projection is admitted against its captured native owner;
  /// preserved Row UUIDs never authorize an old container's cached result.
  pub(super) async fn lock_projection_owner(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    kind: &str,
  ) -> RepoResult<()> {
    Self::lock_managed_admission(tx, database_id).await?;
    sqlx::query("SELECT id FROM workspace_database_fields WHERE id=$1 AND database_id=$2 AND field_type=$3 FOR SHARE")
      .bind(field_id)
      .bind(database_id)
      .bind(kind)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .ok_or(RepositoryError::NotFound("current projection field"))?;
    sqlx::query(
      "SELECT id FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(row_id)
    .bind(database_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("current projection row"))?;
    Ok(())
  }
}
