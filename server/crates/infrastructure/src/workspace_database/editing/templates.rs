// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_database::*;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn lock_row_template_database(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<()> {
    sqlx::query("SELECT id FROM workspace_databases WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE")
      .bind(database_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .ok_or(RepositoryError::NotFound("active database"))?;
    Self::lock_managed_admission(tx, database_id).await?;
    Self::assert_database_workspace(tx, database_id, precondition).await
  }

  fn assert_row_template_revision(actual: i64, precondition: DatabaseEditPrecondition) -> RepoResult<()> {
    // Mutation callers must supply the observed revision; Force is intentionally
    // irrelevant for mutable creation sources and implicit sibling changes.
    if precondition.expected_edit_revision != Some(actual) || actual < 1 {
      return Err(RepositoryError::Conflict("database row template edit revision"));
    }
    Ok(())
  }
  pub(in crate::workspace_database) fn map_initial_cell_values_to_json(
    values: &BTreeMap<DatabaseFieldId, DatabaseCellValueData>,
  ) -> RepoResult<Value> {
    let mut object = serde_json::Map::new();
    for (field_id, value) in values {
      object.insert(field_id.to_string(), Self::map_cell_value_to_json(value)?);
    }
    Ok(Value::Object(object))
  }

  pub(in crate::workspace_database) async fn map_initial_cell_values_from_json(
    &self,
    database_id: DatabaseId,
    value: Value,
  ) -> RepoResult<BTreeMap<DatabaseFieldId, DatabaseCellValueData>> {
    let Some(object) = value.as_object() else {
      return Err(RepositoryError::Validation(
        "row template initial cell values must be a JSON object".to_string(),
      ));
    };
    let fields_sql = format!(
      r#"
        SELECT id, database_id, name, field_type, config_json, position, required, edit_revision, created_at, updated_at
        FROM {DATABASE_FIELDS_TABLE}
        WHERE database_id = $1
      "#,
    );
    let fields = sqlx::query(&fields_sql)
      .bind(database_id)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)?
      .into_iter()
      .map(Self::map_field)
      .collect::<RepoResult<Vec<_>>>()?
      .into_iter()
      .map(|field| (field.id, field.field_type))
      .collect::<HashMap<_, _>>();
    let mut values = BTreeMap::new();
    for (field_id, raw) in object {
      let field_id = Uuid::parse_str(field_id)
        .map_err(|_| RepositoryError::Validation("row template field id key must be a UUID".to_string()))?;
      let field_type = fields
        .get(&field_id)
        .copied()
        .ok_or_else(|| RepositoryError::Validation("row template references unknown field".to_string()))?;
      values.insert(field_id, Self::map_cell_value_from_json(field_type, raw.clone())?);
    }
    Ok(values)
  }

  pub(in crate::workspace_database) async fn map_row_template(
    &self,
    row: sqlx::postgres::PgRow,
  ) -> RepoResult<DatabaseRowTemplate> {
    let database_id = row.try_get("database_id").map_err(Self::map_sqlx_error)?;
    let row_kind = DatabaseRowKind::from_str(
      row
        .try_get::<String, _>("row_kind")
        .map_err(Self::map_sqlx_error)?
        .as_str(),
    )
    .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    let initial_cell_values_json: Value = row.try_get("initial_cell_values_json").map_err(Self::map_sqlx_error)?;
    Ok(DatabaseRowTemplate {
      edit_revision: row.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      content_document_id: row.try_get("content_document_id").map_err(Self::map_sqlx_error)?,
      id: row.try_get("id").map_err(Self::map_sqlx_error)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::map_sqlx_error)?,
      database_id,
      template_id: row.try_get("template_id").map_err(Self::map_sqlx_error)?,
      row_kind,
      name: row.try_get("name").map_err(Self::map_sqlx_error)?,
      description: row.try_get("description").map_err(Self::map_sqlx_error)?,
      position: row.try_get("position").map_err(Self::map_sqlx_error)?,
      enabled: row.try_get("enabled").map_err(Self::map_sqlx_error)?,
      is_default: row.try_get("is_default").map_err(Self::map_sqlx_error)?,
      initial_cell_values: self
        .map_initial_cell_values_from_json(database_id, initial_cell_values_json)
        .await?,
      created_by: row.try_get("created_by").map_err(Self::map_sqlx_error)?,
      updated_by: row.try_get("updated_by").map_err(Self::map_sqlx_error)?,
      created_at: row.try_get("created_at").map_err(Self::map_sqlx_error)?,
      updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
    })
  }

  pub(in crate::workspace_database) async fn ensure_builtin_row_template_catalog_entry(
    tx: &mut Transaction<'_, Postgres>,
    template: &DatabaseRowTemplate,
  ) -> RepoResult<()> {
    // Portable content imports materialize an authoritative Bundle entry
    // before this transaction. Only synthesize the legacy cell-only Builtin
    // when no Registry entry exists; never downgrade existing provenance.
    sqlx::query(
      r#"
        INSERT INTO template_catalog_entries
          (id, slug, title, description, category, tags, status,
           source, builder_version, min_client_version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'database-row-template', $5, 'active',
                'builtin', 1, 0, $6, $7)
        ON CONFLICT (id) DO NOTHING
      "#,
    )
    .bind(template.template_id)
    .bind(format!("database-row-template-{}", template.template_id))
    .bind(&template.name)
    .bind(template.description.as_deref().unwrap_or(""))
    .bind(Vec::<String>::from([
      "database".to_string(),
      "row-template".to_string(),
    ]))
    .bind(template.created_at)
    .bind(template.updated_at)
    .execute(&mut **tx)
    .await
    .map_err(Self::map_snapshot_sqlx_error)?;
    Ok(())
  }
}

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn persist_list_row_templates(
    &self,
    database_id: DatabaseId,
  ) -> RepoResult<Vec<DatabaseRowTemplate>> {
    let rows = sqlx::query(
      r#"
        SELECT id, workspace_id, database_id, template_id, row_kind, name, description, position, content_document_id,
               enabled, is_default, initial_cell_values_json, created_by, updated_by,
               edit_revision, created_at, updated_at
        FROM workspace_database_row_templates
        WHERE database_id = $1
        ORDER BY enabled DESC, is_default DESC, position ASC, lower(name) ASC, id ASC
      "#,
    )
    .bind(database_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut templates = Vec::with_capacity(rows.len());
    for row in rows {
      templates.push(self.map_row_template(row).await?);
    }
    Ok(templates)
  }

  pub(in crate::workspace_database) async fn persist_get_row_template(
    &self,
    row_template_id: Uuid,
  ) -> RepoResult<Option<DatabaseRowTemplate>> {
    let Some(row) = sqlx::query(
      r#"
        SELECT id, workspace_id, database_id, template_id, row_kind, name, description, position, content_document_id,
               enabled, is_default, initial_cell_values_json, created_by, updated_by,
               edit_revision, created_at, updated_at
        FROM workspace_database_row_templates
        WHERE id = $1
      "#,
    )
    .bind(row_template_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    else {
      return Ok(None);
    };
    self.map_row_template(row).await.map(Some)
  }

  pub(in crate::workspace_database) async fn persist_create_row_template(
    &self,
    template: DatabaseRowTemplate,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowTemplate> {
    let value_json = Self::map_initial_cell_values_to_json(&template.initial_cell_values)?;
    let mut tx = self.begin_write().await?;
    Self::lock_row_template_database(&mut tx, template.database_id, precondition).await?;
    Self::validate_task_relation_templates(
      &mut tx,
      template.database_id,
      &[(template.row_kind, &template.initial_cell_values)],
    )
    .await?;
    if template.enabled && template.is_default {
      sqlx::query(
        r#"
          UPDATE workspace_database_row_templates
          SET is_default = false, edit_revision = edit_revision + 1, updated_at = now()
          WHERE database_id = $1 AND is_default = true
        "#,
      )
      .bind(template.database_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    let row = sqlx::query(
      r#"
        INSERT INTO workspace_database_row_templates
          (id, workspace_id, database_id, template_id, row_kind, name, description, position,
           enabled, is_default, initial_cell_values_json, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
        RETURNING id, workspace_id, database_id, template_id, row_kind, name, description, position, content_document_id,
                  enabled, is_default, initial_cell_values_json, created_by, updated_by,
                  edit_revision, created_at, updated_at
      "#,
    )
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
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    Self::assert_database_workspace(&mut tx, template.database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    self.map_row_template(row).await
  }

  pub(in crate::workspace_database) async fn persist_update_row_template(
    &self,
    row_template_id: Uuid,
    name: Option<String>,
    description: Option<Option<String>>,
    position: Option<i32>,
    enabled: Option<bool>,
    is_default: Option<bool>,
    initial_cell_values: Option<BTreeMap<DatabaseFieldId, DatabaseCellValueData>>,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRowTemplate> {
    let mut tx = self.begin_write().await?;
    let owner =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_row_templates WHERE id=$1")
        .bind(row_template_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::Conflict("database row template edit revision"))?;
    Self::lock_row_template_database(&mut tx, owner, precondition).await?;
    if let Some(values) = initial_cell_values.as_ref() {
      let current = sqlx::query("SELECT database_id,row_kind FROM workspace_database_row_templates WHERE id=$1")
        .bind(row_template_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::Conflict("database row template edit revision"))?;
      let database_id = current.try_get("database_id").map_err(Self::map_sqlx_error)?;
      let kind: String = current.try_get("row_kind").map_err(Self::map_sqlx_error)?;
      let kind = DatabaseRowKind::from_str(&kind).map_err(|error| RepositoryError::Validation(error.to_string()))?;
      Self::validate_task_relation_templates(&mut tx, database_id, &[(kind, values)]).await?;
    }
    let Some(current) = sqlx::query(
      r#"
        SELECT id, workspace_id, database_id, template_id, row_kind, name, description, position, content_document_id,
               enabled, is_default, initial_cell_values_json, created_by, updated_by,
               edit_revision, created_at, updated_at
        FROM workspace_database_row_templates
        WHERE id = $1
        FOR UPDATE
      "#,
    )
    .bind(row_template_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    else {
      return Err(RepositoryError::Conflict("database row template edit revision"));
    };
    let current_database_id: DatabaseId = current.try_get("database_id").map_err(Self::map_sqlx_error)?;
    if current_database_id != owner {
      return Err(RepositoryError::Conflict("database row template edit revision"));
    }
    Self::assert_row_template_revision(
      current.try_get("edit_revision").map_err(Self::map_sqlx_error)?,
      precondition,
    )?;
    let next_enabled = enabled.unwrap_or(current.try_get("enabled").map_err(Self::map_sqlx_error)?);
    let next_is_default = is_default.unwrap_or(current.try_get("is_default").map_err(Self::map_sqlx_error)?);
    if next_enabled && next_is_default {
      sqlx::query(
        r#"
          UPDATE workspace_database_row_templates
          SET is_default = false, edit_revision = edit_revision + 1, updated_at = now()
          WHERE database_id = $1 AND id <> $2 AND is_default = true
        "#,
      )
      .bind(current_database_id)
      .bind(row_template_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    let value_json = initial_cell_values
      .as_ref()
      .map(Self::map_initial_cell_values_to_json)
      .transpose()?;
    let row = sqlx::query(
      r#"
        UPDATE workspace_database_row_templates
        SET name = COALESCE($2, name),
            description = CASE WHEN $3 THEN $4 ELSE description END,
            position = COALESCE($5, position),
            enabled = COALESCE($6, enabled),
            is_default = CASE
              WHEN COALESCE($6, enabled) = false THEN false
              ELSE COALESCE($7, is_default)
            END,
            initial_cell_values_json = COALESCE($8, initial_cell_values_json),
            updated_by = $9,
            edit_revision = edit_revision + 1,
            updated_at = now()
        WHERE id = $1 AND ROW(name,description,position,enabled,is_default,initial_cell_values_json)
          IS DISTINCT FROM ROW(COALESCE($2,name),CASE WHEN $3 THEN $4 ELSE description END,
            COALESCE($5,position),COALESCE($6,enabled),CASE WHEN COALESCE($6,enabled)=false THEN false ELSE COALESCE($7,is_default) END,
            COALESCE($8,initial_cell_values_json))
        RETURNING id, workspace_id, database_id, template_id, row_kind, name, description, position, content_document_id,
                  enabled, is_default, initial_cell_values_json, created_by, updated_by,
                  edit_revision, created_at, updated_at
      "#,
    )
    .bind(row_template_id)
    .bind(name)
    .bind(description.is_some())
    .bind(description.flatten())
    .bind(position)
    .bind(enabled)
    .bind(is_default)
    .bind(value_json)
    .bind(updated_by)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .unwrap_or(current);
    Self::assert_database_workspace(&mut tx, current_database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    self.map_row_template(row).await
  }

  pub(in crate::workspace_database) async fn persist_delete_row_template(
    &self,
    row_template_id: Uuid,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<()> {
    let mut tx = self.begin_write().await?;
    let database_id =
      sqlx::query_scalar::<_, DatabaseId>("SELECT database_id FROM workspace_database_row_templates WHERE id = $1")
        .bind(row_template_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::Conflict("database row template edit revision"))?;
    Self::lock_row_template_database(&mut tx, database_id, precondition).await?;
    let actual = sqlx::query_scalar::<_, i64>(
      "SELECT edit_revision FROM workspace_database_row_templates WHERE id=$1 AND database_id=$2 FOR UPDATE",
    )
    .bind(row_template_id)
    .bind(database_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::Conflict("database row template edit revision"))?;
    Self::assert_row_template_revision(actual, precondition)?;
    let affected = sqlx::query("DELETE FROM workspace_database_row_templates WHERE id = $1")
      .bind(row_template_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .rows_affected();
    if affected == 0 {
      return Err(RepositoryError::Conflict("database row template edit revision"));
    }
    Self::assert_database_workspace(&mut tx, database_id, precondition).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(())
  }
}
