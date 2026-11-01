// SPDX-License-Identifier: AGPL-3.0-or-later
//! SQLx repository for server-backed Databases.

mod definition;
mod editing;
mod import_export;
mod projections;
mod projects;
mod reminders;
mod views;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::str::FromStr;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use myoxus_domain::repositories::{PageRequest, RepoResult, RepositoryError};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use tracing::{debug, instrument};
use uuid::Uuid;

use self::projects::LockedProjectMutation;
use self::views::query::{DatabaseQueryTables, DatabaseRowQueryBind, DatabaseRowQueryPlan};

// Physical table names are inherited from the current SQL schema. Keep them
// isolated here so product and API naming can continue converging on Database.
pub(super) const DATABASE_ROWS_TABLE: &str = "workspace_database_rows";
pub(super) const DATABASE_FIELDS_TABLE: &str = "workspace_database_fields";
pub(super) const DATABASE_CELL_VALUES_TABLE: &str = "workspace_database_cell_values";
const DATABASE_QUERY_TABLES: DatabaseQueryTables = DatabaseQueryTables {
  rows: DATABASE_ROWS_TABLE,
  fields: DATABASE_FIELDS_TABLE,
  cell_values: DATABASE_CELL_VALUES_TABLE,
};
/// P-DB-25: hard cap for `list_rows_filtered_paged` and search pagination.
const DATABASE_MAX_ROWS_PER_PAGE: i64 = 500;
const DATABASE_ROW_TEMPLATES_TABLE: &str = "workspace_database_row_templates";
const DATABASE_PROFILES_TABLE: &str = "database_profiles";
const DATABASE_FIELD_ROLES_TABLE: &str = "database_field_roles";
const DATABASE_VIEW_ROLES_TABLE: &str = "database_view_roles";
const PROJECT_HIERARCHY_ERROR: &str = "database project hierarchy invalid";
pub struct PgDatabaseRepository {
  pool: PgPool,
  database_templates: std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
}

impl PgDatabaseRepository {
  pub fn new(
    pool: PgPool,
    database_templates: std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  ) -> Self {
    Self {
      pool,
      database_templates,
    }
  }

  fn map_snapshot_sqlx_error(error: sqlx::Error) -> RepositoryError {
    use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
    let database_code = error
      .as_database_error()
      .and_then(|error| error.code())
      .map(|code| code.into_owned());
    let constraint = error.as_database_error().and_then(|error| error.constraint());
    let code = match database_code.as_deref() {
      Some("23505") => WorkspaceContentErrorCode::DatabaseUniqueConstraint,
      Some("23503") => WorkspaceContentErrorCode::DatabaseForeignKeyConstraint,
      Some("23514") => WorkspaceContentErrorCode::DatabaseCheckConstraint,
      Some("23502") => WorkspaceContentErrorCode::DatabaseNotNullConstraint,
      _ => WorkspaceContentErrorCode::DatabaseUnavailable,
    };
    tracing::error!(
      database_code,
      constraint,
      cause = code.as_str(),
      "database.snapshot_write_failed"
    );
    if code.retryable() {
      RepositoryError::Storage(code.as_str().into())
    } else {
      RepositoryError::Conflict(code.as_str())
    }
  }

  pub(crate) fn map_sqlx_error(err: sqlx::Error) -> RepositoryError {
    if let sqlx::Error::Database(db) = &err
      && let Some(code) = db.code()
      && matches!(code.as_ref(), "23505" | "23503" | "23514")
    {
      debug!(database_code = %code, constraint = ?db.constraint(), "database constraint violation");
      return RepositoryError::Conflict("database constraint violation");
    }
    RepositoryError::Storage(err.to_string())
  }

  /// Sources belong to the same SQL publication/import transaction as their Rows.
  /// Receipts are deliberately absent: importing content never replays admission.
  /// Existing origins are immutable: equal identities preserve all private
  /// metadata; a competing identity aborts the entire import under the unique lock.
  pub(crate) async fn insert_snapshot_sources(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    sources: &[(DatabaseRowId, DatabaseTaskSource)],
  ) -> RepoResult<()> {
    if sources.is_empty() {
      return Ok(());
    }
    // The containing Database scope, never the retained source scope, owns
    // backlinks. Callers materialize Cells before this shared row refresh.
    let workspace_id = sqlx::query_scalar::<_, WorkspaceId>("SELECT workspace_id FROM workspace_databases WHERE id=$1")
      .bind(database_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    for (row_id, source) in sources {
      let inserted = sqlx::query(
        "INSERT INTO database_row_source_links (row_id, source_workspace_id, source_document_id, source_external_id, block_id, selection_anchor) \
         SELECT row.id, $2, $3, $4, $5, $6 FROM workspace_database_rows row JOIN database_profiles profile ON profile.database_id=row.database_id WHERE row.id = $1 AND row.database_id = $7 AND row.row_kind = 'task' AND profile.profile_kind = 'project' \
         ON CONFLICT (row_id) DO UPDATE SET row_id=EXCLUDED.row_id WHERE database_row_source_links.source_workspace_id=EXCLUDED.source_workspace_id AND database_row_source_links.source_document_id=EXCLUDED.source_document_id"
      ).bind(row_id).bind(source.source_workspace_id).bind(source.document_id).bind(&source.external_id)
        .bind(&source.block_id).bind(&source.selection_anchor).bind(database_id)
        .execute(&mut **tx).await.map_err(Self::map_sqlx_error)?;
      if inserted.rows_affected() != 1 {
        return Err(RepositoryError::Conflict("snapshot Task source identity conflict"));
      }
      Self::replace_document_references(tx, workspace_id, database_id, *row_id).await?;
    }
    Ok(())
  }

  /// Transfer publication creates every selected Row before relations between
  /// selected Databases are projected. Ordinary imports keep the same wrapper.
  pub(crate) async fn insert_snapshot_rows(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    rows: &[DatabaseRowRecord],
    import_job_id: Option<DatabaseImportJobId>,
  ) -> RepoResult<()> {
    for row_record in rows {
      let insert_row_sql = format!(
        r#"
          INSERT INTO {DATABASE_ROWS_TABLE}
            (id, database_id, doc_id, row_kind, title, position, created_by,
             updated_by, edit_revision, created_at, updated_at, created_by_job_id)
          VALUES ($1, $2, $12, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#,
      );
      sqlx::query(&insert_row_sql)
        .bind(row_record.row.id)
        .bind(database_id)
        .bind(row_record.row.row_kind.as_str())
        .bind(&row_record.row.title)
        .bind(row_record.row.position)
        .bind(row_record.row.created_by)
        .bind(row_record.row.updated_by)
        .bind(row_record.row.edit_revision)
        .bind(row_record.row.created_at)
        .bind(row_record.row.updated_at)
        .bind(import_job_id)
        .bind(row_record.row.content_document_id)
        .execute(&mut **tx)
        .await
        .map_err(Self::map_snapshot_sqlx_error)?;
    }

    Ok(())
  }

  pub(crate) async fn insert_snapshot_cells_and_templates(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    fallback_actor: UserId,
    rows: &[DatabaseRowRecord],
    row_templates: &[DatabaseRowTemplate],
  ) -> RepoResult<()> {
    // Internal snapshot materialization preserves managed projections. Only
    // Relation writes enter the existing Task graph/Project hierarchy admission.
    let edited_fields = rows
      .iter()
      .flat_map(|row| {
        row
          .cells
          .iter()
          .filter(|cell| cell.field_type == DatabaseFieldType::Relation)
          .map(|cell| cell.field_id)
      })
      .collect::<Vec<_>>();
    let policy = Self::prepare_project_mutation(tx, database_id, &edited_fields, !rows.is_empty()).await?;
    if let Some(policy) = policy.as_ref() {
      let patches = rows
        .iter()
        .flat_map(|row| {
          row
            .cells
            .iter()
            .map(|cell| (row.row.id, cell.field_id, Some(cell.value.clone())))
        })
        .collect::<Vec<_>>();
      Self::validate_task_relations_proposal(tx, database_id, policy, &patches).await?;
    }
    for row_record in rows {
      for cell in &row_record.cells {
        let value_json = Self::map_cell_value_to_json(&cell.value)?;
        let insert_cell_sql = format!(
          r#"
            INSERT INTO {DATABASE_CELL_VALUES_TABLE}
              (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
            VALUES ($1, $2, $3, $7, $4, $5, $6)
          "#,
        );
        sqlx::query(&insert_cell_sql)
          .bind(cell.row_id)
          .bind(cell.field_id)
          .bind(value_json)
          .bind(cell.updated_by)
          .bind(cell.edit_revision)
          .bind(cell.updated_at)
          .bind(database_id)
          .execute(&mut **tx)
          .await
          .map_err(Self::map_snapshot_sqlx_error)?;
        if let DatabaseCellValueData::Relation(target_row_ids) = &cell.value {
          Self::sync_relation_edges_and_reciprocals(
            tx,
            cell.row_id,
            cell.field_id,
            target_row_ids,
            cell.updated_by.unwrap_or(fallback_actor),
          )
          .await?;
          Self::mark_rollups_stale_for_relation_change(tx, cell.row_id, cell.field_id).await?;
        }
        Self::mark_rollups_stale_for_target_cell_change(tx, cell.row_id, cell.field_id).await?;
        Self::mark_formulas_stale_for_cell_change(tx, cell.row_id, cell.field_id).await?;
      }
    }

    let template_values = row_templates
      .iter()
      .map(|template| (template.row_kind, &template.initial_cell_values))
      .collect::<Vec<_>>();
    Self::validate_task_relation_templates(tx, database_id, &template_values).await?;
    for template in row_templates {
      Self::ensure_builtin_row_template_catalog_entry(tx, template).await?;
      if template.enabled && template.is_default {
        let clear_default_template_sql = format!(
          r#"
            UPDATE {DATABASE_ROW_TEMPLATES_TABLE}
               SET is_default = false, edit_revision = edit_revision + 1, updated_at = now()
             WHERE database_id = $1 AND is_default = true
          "#,
        );
        sqlx::query(&clear_default_template_sql)
          .bind(database_id)
          .execute(&mut **tx)
          .await
          .map_err(Self::map_snapshot_sqlx_error)?;
      }
      let value_json = Self::map_initial_cell_values_to_json(&template.initial_cell_values)?;
      let insert_template_sql = format!(
        r#"
          INSERT INTO {DATABASE_ROW_TEMPLATES_TABLE}
            (id, workspace_id, database_id, template_id, row_kind, name, description, position,
             enabled, is_default, initial_cell_values_json, created_by, updated_by,
             created_at, updated_at, content_document_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        "#,
      );
      sqlx::query(&insert_template_sql)
        .bind(template.id)
        .bind(template.workspace_id)
        .bind(template.database_id)
        .bind(template.template_id)
        .bind(template.row_kind.as_str())
        .bind(&template.name)
        .bind(&template.description)
        .bind(template.position)
        .bind(template.enabled)
        .bind(template.enabled && template.is_default)
        .bind(value_json)
        .bind(template.created_by)
        .bind(template.updated_by)
        .bind(template.created_at)
        .bind(template.updated_at)
        .bind(template.content_document_id)
        .execute(&mut **tx)
        .await
        .map_err(Self::map_snapshot_sqlx_error)?;
    }
    if let Some(policy) = policy.as_ref() {
      Self::validate_project_hierarchy(tx, database_id, policy).await?;
    }
    Ok(())
  }

  async fn insert_snapshot_fields_and_views(
    tx: &mut Transaction<'_, Postgres>,
    fields: &[DatabaseField],
    views: &[DatabaseView],
  ) -> RepoResult<()> {
    for field in fields {
      let config_json = Self::map_field_config_to_json(&field.config)?;
      sqlx::query(
        r#"
          INSERT INTO workspace_database_fields
            (id, database_id, name, field_type, config_json, position, required,
             edit_revision, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
      )
      .bind(field.id)
      .bind(field.database_id)
      .bind(&field.name)
      .bind(field.field_type.as_str())
      .bind(config_json)
      .bind(field.position)
      .bind(field.required)
      .bind(field.edit_revision)
      .bind(field.created_at)
      .bind(field.updated_at)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    for view in views {
      let config_json = Self::map_view_config_to_json(&view.config)?;
      let icon_json = view.icon.as_ref().map(Self::map_view_icon_to_json).transpose()?;
      sqlx::query(
        r#"
          INSERT INTO workspace_database_views
            (id, database_id, name, view_kind, icon_json, config_json, position,
             edit_revision, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        "#,
      )
      .bind(view.id)
      .bind(view.database_id)
      .bind(&view.name)
      .bind(view.view_kind.as_str())
      .bind(icon_json)
      .bind(config_json)
      .bind(view.position)
      .bind(view.edit_revision)
      .bind(view.created_at)
      .bind(view.updated_at)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    Ok(())
  }

  async fn update_snapshot_rows(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[DatabaseRowRecord],
    fallback_actor: UserId,
  ) -> RepoResult<()> {
    for row_record in rows {
      let update_row_sql = format!(
        "UPDATE {DATABASE_ROWS_TABLE}\n            SET title = $2,\n                doc_id = COALESCE($3, doc_id),\n                updated_by = $4,\n                edit_revision = edit_revision + 1,\n                updated_at = $5\n          WHERE id = $1 AND database_id = $6 AND deleted_at IS NULL",
      );
      let result = sqlx::query(&update_row_sql)
        .bind(row_record.row.id)
        .bind(&row_record.row.title)
        // A portable body explicitly replaces the Row association with its
        // freshly materialized document. An omitted body is not an explicit
        // detach command and therefore preserves existing optional content.
        .bind(row_record.row.content_document_id)
        .bind(row_record.row.updated_by.or(Some(fallback_actor)))
        .bind(row_record.row.updated_at)
        .bind(row_record.row.database_id)
        .execute(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      if result.rows_affected() != 1 {
        return Err(RepositoryError::NotFound("database row"));
      }
      for cell in &row_record.cells {
        let value_json = Self::map_cell_value_to_json(&cell.value)?;
        let upsert_cell_sql = format!(
          r#"
            INSERT INTO {DATABASE_CELL_VALUES_TABLE}
              (row_id, field_id, value_json, database_id, updated_by, edit_revision, updated_at)
            VALUES ($1, $2, $3, (SELECT database_id FROM {DATABASE_ROWS_TABLE} WHERE id = $1), $4, 1, $5)
            ON CONFLICT (row_id, field_id) DO UPDATE
              SET value_json = EXCLUDED.value_json,
                  database_id = EXCLUDED.database_id,
                  updated_by = EXCLUDED.updated_by,
                  edit_revision = {DATABASE_CELL_VALUES_TABLE}.edit_revision + 1,
                  updated_at = EXCLUDED.updated_at
          "#,
        );
        sqlx::query(&upsert_cell_sql)
          .bind(row_record.row.id)
          .bind(cell.field_id)
          .bind(value_json)
          .bind(cell.updated_by.or(Some(fallback_actor)))
          .bind(cell.updated_at)
          .execute(&mut **tx)
          .await
          .map_err(Self::map_sqlx_error)?;
        if let DatabaseCellValueData::Relation(target_row_ids) = &cell.value {
          Self::sync_relation_edges_and_reciprocals(
            tx,
            row_record.row.id,
            cell.field_id,
            target_row_ids,
            cell.updated_by.unwrap_or(fallback_actor),
          )
          .await?;
        }
        Self::mark_rollups_stale_for_target_cell_change(tx, row_record.row.id, cell.field_id).await?;
        Self::mark_formulas_stale_for_cell_change(tx, row_record.row.id, cell.field_id).await?;
      }
    }
    Ok(())
  }

  async fn begin_write(&self) -> RepoResult<Transaction<'_, Postgres>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    self.capture_managed_admission(&mut tx).await?;
    Ok(tx)
  }
}
