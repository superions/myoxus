// SPDX-License-Identifier: AGPL-3.0-or-later
//! SQLx-backed repository for canonical document metadata.
//!
//! This repository intentionally keeps persistence mechanical. Required fields,
//! status transition semantics and export blocking live in application services
//! so GraphQL, CLI, MCP and workers share one business layer.

use async_trait::async_trait;
use sqlx::{PgPool, Row};
use tracing::instrument;

use myoxus_domain::entities::*;
use myoxus_domain::repositories::{DocumentMetadataPolicyRepository, RepoResult, RepositoryError};

#[derive(Clone)]
pub struct PgDocumentMetadataPolicyRepository {
  pool: PgPool,
}

impl PgDocumentMetadataPolicyRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }
}

fn db_error(error: sqlx::Error) -> RepositoryError {
  if let sqlx::Error::Database(ref dbe) = error {
    match dbe.code().as_deref() {
      Some("23505") => return RepositoryError::Conflict("document metadata uniqueness violation"),
      Some("23503") => return RepositoryError::Conflict("document metadata foreign key violation"),
      Some("23514") => return RepositoryError::Validation(dbe.message().to_string()),
      _ => {}
    }
  }
  RepositoryError::Storage(error.to_string())
}

fn row_to_metadata_field_definition(row: &sqlx::postgres::PgRow) -> DocumentMetadataFieldDefinition {
  DocumentMetadataFieldDefinition {
    key: row.get("key"),
    label: row.get("label"),
    enabled: row.get("enabled"),
    required_mode: row.get("required_mode"),
    editable_by: row.get("editable_by"),
    visible_in_header: row.get("visible_in_header"),
    visible_in_properties: row.get("visible_in_properties"),
    visible_in_lists: row.get("visible_in_lists"),
    export_mode: row.get("export_mode"),
    validation_config: row.get("validation_config"),
    metadata: row.get("metadata"),
    updated_by: row.get("updated_by"),
    updated_at: row.get("updated_at"),
  }
}

fn metadata_edit_role(editable_by: &str) -> RepoResult<&'static str> {
  match editable_by {
    "editor" => Ok("document_editor"),
    "responsible" => Ok("responsible_user"),
    "workspace_admin" => Ok("workspace_admin"),
    "admin_only" => Ok("organization_admin"),
    _ => Err(RepositoryError::Validation(format!(
      "unsupported document metadata edit role adapter value: {editable_by}"
    ))),
  }
}

fn row_to_value_definition(row: &sqlx::postgres::PgRow) -> DocumentMetadataValueDefinition {
  DocumentMetadataValueDefinition {
    id: row.get("id"),
    field_key: row.get("field_key"),
    key: row.get("key"),
    label: row.get("label"),
    description: row.get("description"),
    color: row.get("color"),
    icon: row.get("icon"),
    sort_order: row.get("sort_order"),
    is_active: row.get("is_active"),
    metadata: row.get("metadata"),
  }
}

fn row_to_status_schema(row: &sqlx::postgres::PgRow) -> DocumentStatusSchema {
  DocumentStatusSchema {
    id: row.get("id"),
    key: row.get("key"),
    label: row.get("label"),
    description: row.get("description"),
    complexity: row.get("complexity"),
    is_preset: row.get("is_preset"),
    is_active: row.get("is_active"),
    metadata: row.get("metadata"),
  }
}

fn row_to_status_value(row: &sqlx::postgres::PgRow) -> DocumentStatusValue {
  DocumentStatusValue {
    id: row.get("id"),
    schema_id: row.get("schema_id"),
    key: row.get("key"),
    label: row.get("label"),
    description: row.get("description"),
    color: row.get("color"),
    icon: row.get("icon"),
    sort_order: row.get("sort_order"),
    terminal: row.get("terminal"),
    is_active: row.get("is_active"),
    metadata: row.get("metadata"),
    okf_status: serde_json::from_value(serde_json::Value::String(row.get("okf_status")))
      .expect("database constrains OKF status values"),
  }
}

fn row_to_transition(row: &sqlx::postgres::PgRow) -> DocumentStatusTransition {
  let sets_version_kind: Option<String> = row.get("sets_version_kind");
  DocumentStatusTransition {
    from_status_id: row.get("from_status_id"),
    to_status_id: row.get("to_status_id"),
    required_roles: row.get("required_roles"),
    required_metadata_fields: row.get("required_metadata_fields"),
    creates_version: row.get("creates_version"),
    sets_version_kind: sets_version_kind.as_deref().map(DocumentVersionKind::from),
    date_enforcement: row.get("date_enforcement"),
    metadata: row.get("metadata"),
  }
}

fn row_to_document_type(row: &sqlx::postgres::PgRow) -> DocumentTypeDefinition {
  DocumentTypeDefinition {
    id: row.get("id"),
    key: row.get("key"),
    label: row.get("label"),
    description: row.get("description"),
    icon: row.get("icon"),
    color: row.get("color"),
    is_active: row.get("is_active"),
    is_suggested: row.get("is_suggested"),
  }
}

fn row_to_workspace_settings(row: &sqlx::postgres::PgRow) -> DocumentWorkspaceSettings {
  DocumentWorkspaceSettings {
    workspace_id: row.get("workspace_id"),
    status_schema_id: row.get("status_schema_id"),
    default_status_id: row.get("default_status_id"),
    version_policy_id: row.get("version_policy_id"),
    default_document_type_id: row.get("default_document_type_id"),
    default_classification_id: row.get("default_classification_id"),
    default_retention_policy_id: row.get("default_retention_policy_id"),
    updated_by: row.get("updated_by"),
    updated_at: row.get("updated_at"),
  }
}

fn row_to_metadata_state(row: &sqlx::postgres::PgRow) -> DocumentMetadataState {
  DocumentMetadataState {
    doc_id: row.get("doc_id"),
    status_id: row.get("status_id"),
    type_id: row.get("type_id"),
    current_version_id: row.get("current_version_id"),
    dirty_since_current_version: row.get("dirty_since_current_version"),
    version_display_mode: row.get("version_display_mode"),
    last_versioned_at: row.get("last_versioned_at"),
    responsible_principals: row.get("responsible_principals"),
    review_due_at: row.get("review_due_at"),
    valid_from: row.get("valid_from"),
    valid_until: row.get("valid_until"),
    classification_id: row.get("classification_id"),
    document_number: row.get("document_number"),
    language: row.get("language"),
    audience_ids: row.get("audience_ids"),
    retention_policy_id: row.get("retention_policy_id"),
    updated_by: row.get("updated_by"),
    updated_at: row.get("updated_at"),
    metadata: row.get("metadata"),
  }
}

fn row_to_runtime_bucket(row: &sqlx::postgres::PgRow) -> DocumentRuntimeAggregateBucket {
  DocumentRuntimeAggregateBucket {
    key: row.get("key"),
    label: row.get("label"),
    count: row.get::<i64, _>("count"),
  }
}

fn row_to_metadata_index(row: &sqlx::postgres::PgRow) -> DocumentMetadataIndexRow {
  DocumentMetadataIndexRow {
    doc_id: row.get("doc_id"),
    external_id: row.get("external_id"),
    created_by: row.get("created_by"),
    updated_by: row.get("updated_by"),
    journal_date: row.get("journal_date"),
    is_template: row.get("is_template"),
    template_state: row.get("template_state"),
    template_origin: row.get("template_origin"),
    template_category: row.get("template_category"),
    template_tags: row
      .get::<Option<serde_json::Value>, _>("template_tags")
      .and_then(|tags| serde_json::from_value(tags).ok()),
    primary_mode: row.get("primary_mode"),
    page_width: row.get("page_width"),
    edgeless_color_theme: row.get("edgeless_color_theme"),
    integration_type: row.get("integration_type"),
    status_id: row.get("status_id"),
    document_type_id: row.get("document_type_id"),
    current_version_id: row.get("current_version_id"),
    dirty_since_current_version: row.get("dirty_since_current_version"),
    review_due_at: row.get("review_due_at"),
    valid_until: row.get("valid_until"),
    classification_id: row.get("classification_id"),
  }
}

const METADATA_INDEX_VERSION_SQL: &str = r#"
  SELECT format(
    'contract-v2:workspace=%s:rows=%s:global:list_index=%s',
    $1::uuid,
    COALESCE(index_revision.revision, 0),
    COALESCE(global_list_index.revision, 0)
  ) AS version
  FROM (SELECT 1) seed
  LEFT JOIN workspace_document_metadata_index_revision index_revision
    ON index_revision.workspace_id = $1
  LEFT JOIN document_metadata_global_epoch global_list_index
    ON global_list_index.epoch_name = 'list_index'
"#;

const METADATA_INDEX_SQL: &str = r#"
  WITH runtime_docs AS (
    SELECT
      d.id AS doc_id, d.external_id, d.created_by, d.updated_by, d.journal_date,
      COALESCE(template.state <> 'none', false) AS is_template,
      template.state AS template_state,
      CASE WHEN template.state <> 'none' THEN template.metadata ->> 'origin' END AS template_origin,
      CASE WHEN template.state <> 'none' THEN template.metadata ->> 'category' END AS template_category,
      CASE WHEN template.state <> 'none' THEN template.metadata -> 'tags' END AS template_tags,
      COALESCE(ws.status_schema_id, simple_schema.id, first_schema.id) AS effective_schema_id,
      d.status_id AS state_status_id,
      COALESCE(d.document_type_id, ws.default_document_type_id) AS effective_type_id,
      d.current_version_id, d.dirty_since_current_version, d.review_due_at, d.valid_until,
      COALESCE(d.classification_id, ws.default_classification_id) AS effective_classification_id,
      presentation.primary_mode, presentation.page_width, presentation.edgeless_color_theme,
      integration.integration_type
    FROM docs d
    LEFT JOIN document_workspace_settings ws ON ws.workspace_id = d.workspace_id
    LEFT JOIN document_template_state template ON template.doc_id = d.id
    LEFT JOIN document_presentation_state presentation ON presentation.doc_id = d.id
    LEFT JOIN document_integration_state integration ON integration.doc_id = d.id
    LEFT JOIN LATERAL (
      SELECT id FROM document_status_schema
      WHERE key = 'simple' AND is_active ORDER BY key LIMIT 1
    ) simple_schema ON true
    LEFT JOIN LATERAL (
      SELECT id FROM document_status_schema
      WHERE is_active ORDER BY key LIMIT 1
    ) first_schema ON true
    WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
  )
  SELECT
    rd.doc_id, rd.external_id, rd.created_by, rd.updated_by, rd.journal_date,
    rd.is_template, rd.template_state, rd.template_origin, rd.template_category, rd.template_tags, rd.primary_mode,
    rd.page_width, rd.edgeless_color_theme, rd.integration_type,
    COALESCE(rd.state_status_id, type_status.status_id, first_status.id) AS status_id,
    rd.effective_type_id AS document_type_id, rd.current_version_id,
    rd.dirty_since_current_version, rd.review_due_at, rd.valid_until,
    rd.effective_classification_id AS classification_id
  FROM runtime_docs rd
  LEFT JOIN document_type_status_default type_status
    ON type_status.document_type_id = rd.effective_type_id
   AND type_status.status_schema_id = rd.effective_schema_id
  LEFT JOIN LATERAL (
    SELECT id FROM document_status_value
    WHERE schema_id = rd.effective_schema_id AND is_active
    ORDER BY sort_order, key LIMIT 1
  ) first_status ON true
  ORDER BY rd.doc_id
"#;

async fn fetch_runtime_buckets(pool: &PgPool, query: &str) -> RepoResult<Vec<DocumentRuntimeAggregateBucket>> {
  Ok(
    sqlx::query(query)
      .fetch_all(pool)
      .await
      .map_err(db_error)?
      .iter()
      .map(row_to_runtime_bucket)
      .collect(),
  )
}

async fn assert_workspace_default_fields_editable(
  pool: &PgPool,
  settings: &DocumentWorkspaceSettings,
) -> RepoResult<()> {
  let Some(actor_id) = settings.updated_by else {
    return Ok(());
  };
  let current: Option<(Option<uuid::Uuid>, Option<uuid::Uuid>, Option<uuid::Uuid>)> = sqlx::query_as(
    "SELECT default_document_type_id, default_classification_id, default_retention_policy_id \
     FROM document_workspace_settings WHERE workspace_id = $1",
  )
  .bind(settings.workspace_id)
  .fetch_optional(pool)
  .await
  .map_err(db_error)?;
  let mut keys = Vec::new();
  if current.as_ref().map(|value| value.0).unwrap_or(None) != settings.default_document_type_id {
    keys.push("documentType");
  }
  if current.as_ref().map(|value| value.1).unwrap_or(None) != settings.default_classification_id {
    keys.push("classification");
  }
  if current.as_ref().map(|value| value.2).unwrap_or(None) != settings.default_retention_policy_id {
    keys.push("retentionPolicy");
  }

  for key in keys {
    let gate: Option<(bool, Option<String>, String, bool)> = sqlx::query_as(
      r#"
      WITH actor_context AS (
        SELECT
          COALESCE(u.is_admin, false) AS is_global_admin,
          CASE
            WHEN w.owner_user_id = $2 THEN 'Owner'
            ELSE wm.role
          END AS workspace_role
        FROM workspaces w
        JOIN users u ON u.id = $2
        LEFT JOIN workspace_memberships wm
          ON wm.workspace_id = w.id
         AND wm.user_id = $2
         AND wm.status = 'Accepted'
        WHERE w.id = $1
          AND w.deleted_at IS NULL
          AND w.lifecycle_state = 'active'
      )
      SELECT COALESCE(p.enabled, true) AS enabled,
             f.workspace_edit_role,
             f.mutation_route,
             COALESCE(CASE
               WHEN COALESCE(p.enabled, true) = false THEN false
               WHEN f.inheritance_mode NOT IN ('inherited', 'relation_inherited') THEN false
               WHEN f.workspace_edit_role IS NULL OR f.workspace_edit_role = 'system_only' THEN false
               WHEN f.workspace_edit_role = 'organization_admin' THEN ac.is_global_admin
               WHEN f.workspace_edit_role = 'workspace_admin'
                 THEN ac.is_global_admin OR ac.workspace_role IN ('Owner', 'Admin')
               ELSE false
             END, false) AS allowed
      FROM document_metadata_field_definition f
      CROSS JOIN actor_context ac
      LEFT JOIN organization_document_metadata_policy p
        ON p.organization_id = document_metadata_effective_organization_id($1)
       AND p.field_key = f.key
      WHERE f.key = $3
      "#,
    )
    .bind(settings.workspace_id)
    .bind(actor_id)
    .bind(key)
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;
    match gate {
      Some((true, _, _, true)) => {}
      Some((false, _, _, _)) => {
        return Err(RepositoryError::Validation(format!(
          "workspace document default field disabled by organization policy: {key}"
        )));
      }
      Some((true, role, route, false)) => {
        let role = role.unwrap_or_else(|| "none".to_string());
        return Err(RepositoryError::Validation(format!(
          "workspace document default field locked for actor: {key} ({role}/{route})"
        )));
      }
      None => {
        return Err(RepositoryError::Validation(format!(
          "workspace document default field unknown: {key}"
        )));
      }
    }
  }

  Ok(())
}

async fn normalize_workspace_status_default(
  pool: &PgPool,
  settings: &DocumentWorkspaceSettings,
) -> RepoResult<DocumentWorkspaceSettings> {
  let mut normalized = settings.clone();
  if let Some(default_status_id) = normalized.default_status_id {
    let schema_id: Option<uuid::Uuid> =
      sqlx::query_scalar("SELECT schema_id FROM document_status_value WHERE id = $1 AND is_active")
        .bind(default_status_id)
        .fetch_optional(pool)
        .await
        .map_err(db_error)?;
    let Some(schema_id) = schema_id else {
      return Err(RepositoryError::Validation(
        "workspace default status is not an active status value".to_string(),
      ));
    };
    match normalized.status_schema_id {
      Some(current_schema_id) if current_schema_id != schema_id => {
        return Err(RepositoryError::Validation(
          "workspace default status must belong to the selected status schema".to_string(),
        ));
      }
      Some(_) => {}
      None => normalized.status_schema_id = Some(schema_id),
    }
    return Ok(normalized);
  }

  if let Some(schema_id) = normalized.status_schema_id {
    normalized.default_status_id = sqlx::query_scalar(
      "SELECT id FROM document_status_value \
       WHERE schema_id = $1 AND is_active \
       ORDER BY sort_order, key \
       LIMIT 1",
    )
    .bind(schema_id)
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;
  }

  Ok(normalized)
}

const RUNTIME_EFFECTIVE_DOCS_CTE: &str = r#"
WITH runtime_docs AS (
  SELECT
    d.id AS doc_id,
    COALESCE(ws.status_schema_id, simple_schema.id, first_schema.id) AS effective_schema_id,
    d.status_id AS state_status_id,
    COALESCE(d.document_type_id, ws.default_document_type_id) AS effective_type_id,
    COALESCE(d.classification_id, ws.default_classification_id) AS effective_classification_id,
    d.review_due_at,
    d.current_version_id,
    d.dirty_since_current_version
  FROM docs d
  LEFT JOIN document_workspace_settings ws ON ws.workspace_id = d.workspace_id
  LEFT JOIN LATERAL (
    SELECT id
    FROM document_status_schema
    WHERE key = 'simple' AND is_active
    ORDER BY key
    LIMIT 1
  ) simple_schema ON true
  LEFT JOIN LATERAL (
    SELECT id
    FROM document_status_schema
    WHERE is_active
    ORDER BY key
    LIMIT 1
  ) first_schema ON true
  WHERE d.deleted_at IS NULL
),
runtime_effective_docs AS (
  SELECT
    rd.*,
    COALESCE(
      rd.state_status_id,
      type_status.status_id,
      first_status.id
    ) AS effective_status_id
  FROM runtime_docs rd
  LEFT JOIN document_type_status_default type_status
    ON type_status.document_type_id = rd.effective_type_id
   AND type_status.status_schema_id = rd.effective_schema_id
  LEFT JOIN LATERAL (
    SELECT id
    FROM document_status_value
    WHERE schema_id = rd.effective_schema_id AND is_active
    ORDER BY sort_order, key
    LIMIT 1
  ) first_status ON true
)
"#;

#[async_trait]
impl DocumentMetadataPolicyRepository for PgDocumentMetadataPolicyRepository {
  #[instrument(skip(self), fields(%workspace_id,%doc_id),err)]
  async fn initial_metadata_index(
    &self,
    workspace_id: uuid::Uuid,
    doc_id: uuid::Uuid,
    actor_id: uuid::Uuid,
  ) -> RepoResult<DocumentMetadataIndexRow> {
    let row = sqlx::query("SELECT initial.status_id, initial.document_type_id, initial.classification_id FROM document_metadata_initial_defaults(jsonb_populate_record(NULL::docs, jsonb_build_object('id',$1::uuid,'workspace_id',$2::uuid,'created_by',$3::uuid,'updated_by',$3::uuid))) AS initial")
      .bind(doc_id).bind(workspace_id).bind(actor_id).fetch_one(&self.pool).await.map_err(db_error)?;
    Ok(DocumentMetadataIndexRow {
      doc_id,
      external_id: doc_id.to_string(),
      created_by: Some(actor_id),
      updated_by: Some(actor_id),
      journal_date: None,
      is_template: false,
      template_state: None,
      template_origin: None,
      template_category: None,
      template_tags: None,
      primary_mode: None,
      page_width: None,
      edgeless_color_theme: None,
      integration_type: None,
      status_id: row.try_get("status_id").map_err(db_error)?,
      document_type_id: row.try_get("document_type_id").map_err(db_error)?,
      current_version_id: None,
      dirty_since_current_version: false,
      review_due_at: None,
      valid_until: None,
      classification_id: row.try_get("classification_id").map_err(db_error)?,
    })
  }

  #[instrument(skip(self), err)]
  async fn list_metadata_field_definitions(&self) -> RepoResult<Vec<DocumentMetadataFieldDefinition>> {
    let rows = sqlx::query(
      r#"
      SELECT key,
             label,
             true AS enabled,
             required_mode,
             CASE document_edit_role
               WHEN 'responsible_user' THEN 'responsible'
               WHEN 'workspace_admin' THEN 'workspace_admin'
               WHEN 'system_only' THEN 'admin_only'
               WHEN 'organization_admin' THEN 'admin_only'
               ELSE 'editor'
             END AS editable_by,
             visible_in_header,
             visible_in_properties,
             visible_in_lists,
             export_mode,
             jsonb_build_object(
               'storageArea', storage_area,
               'storageField', storage_field,
               'inheritanceMode', inheritance_mode,
               'sourceColumn', source_column,
               'mutationRoute', mutation_route,
               'projectionVisibility', projection_visibility
             ) AS validation_config,
             metadata,
             updated_by,
             updated_at
      FROM document_metadata_field_definition
      ORDER BY key
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(rows.iter().map(row_to_metadata_field_definition).collect())
  }

  #[instrument(skip(self), err)]
  async fn get_metadata_field_definition(&self, key: &str) -> RepoResult<Option<DocumentMetadataFieldDefinition>> {
    let row = sqlx::query(
      r#"
      SELECT key,
             label,
             true AS enabled,
             required_mode,
             CASE document_edit_role
               WHEN 'responsible_user' THEN 'responsible'
               WHEN 'workspace_admin' THEN 'workspace_admin'
               WHEN 'system_only' THEN 'admin_only'
               WHEN 'organization_admin' THEN 'admin_only'
               ELSE 'editor'
             END AS editable_by,
             visible_in_header,
             visible_in_properties,
             visible_in_lists,
             export_mode,
             jsonb_build_object(
               'storageArea', storage_area,
               'storageField', storage_field,
               'inheritanceMode', inheritance_mode,
               'sourceColumn', source_column,
               'mutationRoute', mutation_route,
               'projectionVisibility', projection_visibility
             ) AS validation_config,
             metadata,
             updated_by,
             updated_at
      FROM document_metadata_field_definition
      WHERE key = $1
      "#,
    )
    .bind(key)
    .fetch_optional(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row.as_ref().map(row_to_metadata_field_definition))
  }

  #[instrument(skip(self), err)]
  async fn create_metadata_field_definition(&self, _definition: &DocumentMetadataFieldDefinition) -> RepoResult<()> {
    Err(RepositoryError::Validation(
      "document metadata field catalog is static; update existing field definitions instead".to_string(),
    ))
  }

  #[instrument(skip(self, patch), err)]
  async fn update_metadata_field_definition(
    &self,
    key: &str,
    patch: &DocumentMetadataFieldDefinitionPatch,
  ) -> RepoResult<DocumentMetadataFieldDefinition> {
    let current = self
      .get_metadata_field_definition(key)
      .await?
      .ok_or(RepositoryError::NotFound("document metadata field definition"))?;
    let document_edit_role = metadata_edit_role(patch.editable_by.as_deref().unwrap_or(&current.editable_by))?;
    let row = sqlx::query(
      r#"
      UPDATE document_metadata_field_definition
      SET label = $2,
          required_mode = $3,
          document_edit_role = CASE
            WHEN mutation_route = 'status_transition' OR mutation_route = 'readonly' THEN document_edit_role
            ELSE $4
          END,
          visible_in_header = $5,
          visible_in_properties = $6,
          visible_in_lists = $7,
          export_mode = $8,
          metadata = $9,
          updated_by = $10,
          updated_at = now()
      WHERE key = $1
      RETURNING key,
                label,
                true AS enabled,
                required_mode,
                CASE document_edit_role
                  WHEN 'responsible_user' THEN 'responsible'
                  WHEN 'workspace_admin' THEN 'workspace_admin'
                  WHEN 'system_only' THEN 'admin_only'
                  WHEN 'organization_admin' THEN 'admin_only'
                  ELSE 'editor'
                END AS editable_by,
                visible_in_header,
                visible_in_properties,
                visible_in_lists,
                export_mode,
                jsonb_build_object(
                  'storageArea', storage_area,
                  'storageField', storage_field,
                  'inheritanceMode', inheritance_mode,
                  'sourceColumn', source_column,
                  'mutationRoute', mutation_route,
                  'projectionVisibility', projection_visibility
                ) AS validation_config,
                metadata,
                updated_by,
                updated_at
      "#,
    )
    .bind(key)
    .bind(patch.label.as_ref().unwrap_or(&current.label))
    .bind(patch.required_mode.as_ref().unwrap_or(&current.required_mode))
    .bind(document_edit_role)
    .bind(patch.visible_in_header.unwrap_or(current.visible_in_header))
    .bind(patch.visible_in_properties.unwrap_or(current.visible_in_properties))
    .bind(patch.visible_in_lists.unwrap_or(current.visible_in_lists))
    .bind(patch.export_mode.as_ref().unwrap_or(&current.export_mode))
    .bind(patch.metadata.as_ref().unwrap_or(&current.metadata))
    .bind(patch.updated_by)
    .fetch_one(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row_to_metadata_field_definition(&row))
  }

  #[instrument(skip(self), err)]
  async fn list_metadata_value_definitions(&self, field_key: &str) -> RepoResult<Vec<DocumentMetadataValueDefinition>> {
    let rows = match field_key {
      "classification" => {
        sqlx::query(
          r#"
          SELECT id, 'classification'::TEXT AS field_key, key, label, description,
                 color, icon, sort_order, is_active, metadata
          FROM document_classification_definition
          ORDER BY sort_order, key
          "#,
        )
        .fetch_all(&self.pool)
        .await
      }
      "retentionPolicy" => {
        sqlx::query(
          r#"
          SELECT id, 'retentionPolicy'::TEXT AS field_key, key, label, description,
                 color, icon, sort_order, is_active, metadata
          FROM document_retention_policy_definition
          ORDER BY sort_order, key
          "#,
        )
        .fetch_all(&self.pool)
        .await
      }
      "audience" => {
        sqlx::query(
          r#"
          SELECT id, 'audience'::TEXT AS field_key, key, label, description,
                 color, icon, sort_order, is_active, metadata
          FROM document_audience_definition
          ORDER BY sort_order, key
          "#,
        )
        .fetch_all(&self.pool)
        .await
      }
      "language" => {
        sqlx::query(
          r#"
          SELECT id, 'language'::TEXT AS field_key, key, label, native_label AS description,
                 NULL::TEXT AS color, NULL::TEXT AS icon, sort_order, is_active, metadata
          FROM language_definition
          ORDER BY sort_order, key
          "#,
        )
        .fetch_all(&self.pool)
        .await
      }
      _ => {
        return Err(RepositoryError::Validation(format!(
          "unsupported document value list: {field_key}"
        )));
      }
    }
    .map_err(db_error)?;
    Ok(rows.iter().map(row_to_value_definition).collect())
  }

  #[instrument(skip(self, value), fields(field_key = %value.field_key, key = %value.key), err)]
  async fn create_metadata_value_definition(
    &self,
    value: &DocumentMetadataValueDefinition,
  ) -> RepoResult<DocumentMetadataValueDefinition> {
    let row = match value.field_key.as_str() {
      "classification" => {
        sqlx::query(
          r#"
          INSERT INTO document_classification_definition
            (id, key, label, description, color, icon, sort_order, is_active, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id, 'classification'::TEXT AS field_key, key, label, description, color, icon,
                    sort_order, is_active, metadata
          "#,
        )
        .bind(value.id)
        .bind(&value.key)
        .bind(&value.label)
        .bind(&value.description)
        .bind(&value.color)
        .bind(&value.icon)
        .bind(value.sort_order)
        .bind(value.is_active)
        .bind(&value.metadata)
        .fetch_one(&self.pool)
        .await
      }
      "retentionPolicy" => {
        sqlx::query(
          r#"
          INSERT INTO document_retention_policy_definition
            (id, key, label, description, color, icon, sort_order, is_active, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id, 'retentionPolicy'::TEXT AS field_key, key, label, description, color, icon,
                    sort_order, is_active, metadata
          "#,
        )
        .bind(value.id)
        .bind(&value.key)
        .bind(&value.label)
        .bind(&value.description)
        .bind(&value.color)
        .bind(&value.icon)
        .bind(value.sort_order)
        .bind(value.is_active)
        .bind(&value.metadata)
        .fetch_one(&self.pool)
        .await
      }
      "audience" => {
        sqlx::query(
          r#"
          INSERT INTO document_audience_definition
            (id, key, label, description, color, icon, sort_order, is_active, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id, 'audience'::TEXT AS field_key, key, label, description, color, icon,
                    sort_order, is_active, metadata
          "#,
        )
        .bind(value.id)
        .bind(&value.key)
        .bind(&value.label)
        .bind(&value.description)
        .bind(&value.color)
        .bind(&value.icon)
        .bind(value.sort_order)
        .bind(value.is_active)
        .bind(&value.metadata)
        .fetch_one(&self.pool)
        .await
      }
      "language" => {
        sqlx::query(
          r#"
          INSERT INTO language_definition
            (id, key, label, native_label, sort_order, is_active, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          RETURNING id, 'language'::TEXT AS field_key, key, label, native_label AS description,
                    NULL::TEXT AS color, NULL::TEXT AS icon, sort_order, is_active, metadata
          "#,
        )
        .bind(value.id)
        .bind(&value.key)
        .bind(&value.label)
        .bind(&value.description)
        .bind(value.sort_order)
        .bind(value.is_active)
        .bind(&value.metadata)
        .fetch_one(&self.pool)
        .await
      }
      _ => {
        return Err(RepositoryError::Validation(format!(
          "unsupported document value list: {}",
          value.field_key
        )));
      }
    }
    .map_err(db_error)?;
    Ok(row_to_value_definition(&row))
  }

  #[instrument(skip(self, value), fields(field_key = %value.field_key, key = %value.key), err)]
  async fn upsert_metadata_value_definition(
    &self,
    value: &DocumentMetadataValueDefinition,
  ) -> RepoResult<DocumentMetadataValueDefinition> {
    let row = match value.field_key.as_str() {
      "classification" => {
        sqlx::query(
          r#"
          INSERT INTO document_classification_definition
            (id, key, label, description, color, icon, sort_order, is_active, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (key) DO UPDATE SET
            label = EXCLUDED.label, description = EXCLUDED.description,
            color = EXCLUDED.color, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order,
            is_active = EXCLUDED.is_active, metadata = EXCLUDED.metadata, updated_at = now()
          RETURNING id, 'classification'::TEXT AS field_key, key, label, description, color, icon,
                    sort_order, is_active, metadata
          "#,
        )
        .bind(value.id)
        .bind(&value.key)
        .bind(&value.label)
        .bind(&value.description)
        .bind(&value.color)
        .bind(&value.icon)
        .bind(value.sort_order)
        .bind(value.is_active)
        .bind(&value.metadata)
        .fetch_one(&self.pool)
        .await
      }
      "retentionPolicy" => {
        sqlx::query(
          r#"
          INSERT INTO document_retention_policy_definition
            (id, key, label, description, color, icon, sort_order, is_active, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (key) DO UPDATE SET
            label = EXCLUDED.label, description = EXCLUDED.description,
            color = EXCLUDED.color, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order,
            is_active = EXCLUDED.is_active, metadata = EXCLUDED.metadata, updated_at = now()
          RETURNING id, 'retentionPolicy'::TEXT AS field_key, key, label, description, color, icon,
                    sort_order, is_active, metadata
          "#,
        )
        .bind(value.id)
        .bind(&value.key)
        .bind(&value.label)
        .bind(&value.description)
        .bind(&value.color)
        .bind(&value.icon)
        .bind(value.sort_order)
        .bind(value.is_active)
        .bind(&value.metadata)
        .fetch_one(&self.pool)
        .await
      }
      "audience" => {
        sqlx::query(
          r#"
          INSERT INTO document_audience_definition
            (id, key, label, description, color, icon, sort_order, is_active, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (key) DO UPDATE SET
            label = EXCLUDED.label, description = EXCLUDED.description,
            color = EXCLUDED.color, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order,
            is_active = EXCLUDED.is_active, metadata = EXCLUDED.metadata, updated_at = now()
          RETURNING id, 'audience'::TEXT AS field_key, key, label, description, color, icon,
                    sort_order, is_active, metadata
          "#,
        )
        .bind(value.id)
        .bind(&value.key)
        .bind(&value.label)
        .bind(&value.description)
        .bind(&value.color)
        .bind(&value.icon)
        .bind(value.sort_order)
        .bind(value.is_active)
        .bind(&value.metadata)
        .fetch_one(&self.pool)
        .await
      }
      "language" => {
        sqlx::query(
          r#"
          INSERT INTO language_definition
            (id, key, label, native_label, sort_order, is_active, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (key) DO UPDATE SET
            label = EXCLUDED.label, native_label = EXCLUDED.native_label,
            sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active,
            metadata = EXCLUDED.metadata, updated_at = now()
          RETURNING id, 'language'::TEXT AS field_key, key, label, native_label AS description,
                    NULL::TEXT AS color, NULL::TEXT AS icon, sort_order, is_active, metadata
          "#,
        )
        .bind(value.id)
        .bind(&value.key)
        .bind(&value.label)
        .bind(&value.description)
        .bind(value.sort_order)
        .bind(value.is_active)
        .bind(&value.metadata)
        .fetch_one(&self.pool)
        .await
      }
      _ => {
        return Err(RepositoryError::Validation(format!(
          "unsupported document value list: {}",
          value.field_key
        )));
      }
    }
    .map_err(db_error)?;
    Ok(row_to_value_definition(&row))
  }

  #[instrument(skip(self), err)]
  async fn list_status_schemas(&self) -> RepoResult<Vec<DocumentStatusSchema>> {
    let rows = sqlx::query(
      "SELECT id, key, label, description, complexity, is_preset, is_active, metadata FROM document_status_schema ORDER BY key",
    )
    .fetch_all(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(rows.iter().map(row_to_status_schema).collect())
  }

  #[instrument(skip(self, schema), fields(key = %schema.key), err)]
  async fn upsert_status_schema(&self, schema: &DocumentStatusSchema) -> RepoResult<DocumentStatusSchema> {
    let row = sqlx::query(
      r#"
      INSERT INTO document_status_schema
        (id, key, label, description, complexity, is_preset, is_active, metadata, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        complexity = EXCLUDED.complexity,
        is_preset = EXCLUDED.is_preset,
        is_active = EXCLUDED.is_active,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id, key, label, description, complexity, is_preset, is_active, metadata
      "#,
    )
    .bind(schema.id)
    .bind(&schema.key)
    .bind(&schema.label)
    .bind(&schema.description)
    .bind(&schema.complexity)
    .bind(schema.is_preset)
    .bind(schema.is_active)
    .bind(&schema.metadata)
    .fetch_one(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row_to_status_schema(&row))
  }

  #[instrument(skip(self), err)]
  async fn list_status_values(&self, schema_key: &str) -> RepoResult<Vec<DocumentStatusValue>> {
    let rows = sqlx::query(
      r#"
      SELECT v.id, v.schema_id, v.key, v.label, v.description, v.color, v.icon,
             v.sort_order, v.terminal, v.is_active, v.metadata, v.okf_status
      FROM document_status_value v
      JOIN document_status_schema s ON s.id = v.schema_id
      WHERE s.key = $1
      ORDER BY v.sort_order, v.key
      "#,
    )
    .bind(schema_key)
    .fetch_all(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(rows.iter().map(row_to_status_value).collect())
  }

  #[instrument(skip(self, value), fields(schema_id = %value.schema_id, key = %value.key), err)]
  async fn upsert_status_value(
    &self,
    value: &DocumentStatusValue,
    okf_status: Option<DocumentOkfStatus>,
  ) -> RepoResult<DocumentStatusValue> {
    let row = sqlx::query(
      r#"
      INSERT INTO document_status_value
        (id, schema_id, key, label, description, color, icon, sort_order, terminal, is_active, metadata, okf_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, 'draft'))
      ON CONFLICT (schema_id, key) DO UPDATE SET
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        color = EXCLUDED.color,
        icon = EXCLUDED.icon,
        sort_order = EXCLUDED.sort_order,
        terminal = EXCLUDED.terminal,
        is_active = EXCLUDED.is_active,
        metadata = EXCLUDED.metadata,
        okf_status = COALESCE($12, document_status_value.okf_status)
      RETURNING id, schema_id, key, label, description, color, icon,
                sort_order, terminal, is_active, metadata, okf_status
      "#,
    )
    .bind(value.id)
    .bind(value.schema_id)
    .bind(&value.key)
    .bind(&value.label)
    .bind(&value.description)
    .bind(&value.color)
    .bind(&value.icon)
    .bind(value.sort_order)
    .bind(value.terminal)
    .bind(value.is_active)
    .bind(&value.metadata)
    .bind(okf_status.map(DocumentOkfStatus::as_str))
    .fetch_one(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row_to_status_value(&row))
  }

  #[instrument(skip(self), err)]
  async fn transition_exists(&self, from_status_id: uuid::Uuid, to_status_id: uuid::Uuid) -> RepoResult<bool> {
    sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM document_status_transition WHERE from_status_id = $1 AND to_status_id = $2)",
    )
    .bind(from_status_id)
    .bind(to_status_id)
    .fetch_one(&self.pool)
    .await
    .map_err(db_error)
  }

  #[instrument(skip(self), err)]
  async fn get_transition(
    &self,
    from_status_id: uuid::Uuid,
    to_status_id: uuid::Uuid,
  ) -> RepoResult<Option<DocumentStatusTransition>> {
    let row = sqlx::query(
      r#"
      SELECT from_status_id, to_status_id, required_roles, required_metadata_fields,
             creates_version, sets_version_kind, date_enforcement, metadata
      FROM document_status_transition
      WHERE from_status_id = $1 AND to_status_id = $2
      "#,
    )
    .bind(from_status_id)
    .bind(to_status_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row.as_ref().map(row_to_transition))
  }

  #[instrument(skip(self, transition), fields(from_status_id = %transition.from_status_id, to_status_id = %transition.to_status_id), err)]
  async fn upsert_status_transition(
    &self,
    transition: &DocumentStatusTransition,
  ) -> RepoResult<DocumentStatusTransition> {
    let sets_version_kind = transition.sets_version_kind.as_ref().map(DocumentVersionKind::as_str);
    let row = sqlx::query(
      r#"
      INSERT INTO document_status_transition
        (from_status_id, to_status_id, required_roles, required_metadata_fields,
         creates_version, sets_version_kind, date_enforcement, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (from_status_id, to_status_id) DO UPDATE SET
        required_roles = EXCLUDED.required_roles,
        required_metadata_fields = EXCLUDED.required_metadata_fields,
        creates_version = EXCLUDED.creates_version,
        sets_version_kind = EXCLUDED.sets_version_kind,
        date_enforcement = EXCLUDED.date_enforcement,
        metadata = EXCLUDED.metadata
      RETURNING from_status_id, to_status_id, required_roles, required_metadata_fields,
                creates_version, sets_version_kind, date_enforcement, metadata
      "#,
    )
    .bind(transition.from_status_id)
    .bind(transition.to_status_id)
    .bind(&transition.required_roles)
    .bind(&transition.required_metadata_fields)
    .bind(&transition.creates_version)
    .bind(sets_version_kind)
    .bind(&transition.date_enforcement)
    .bind(&transition.metadata)
    .fetch_one(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row_to_transition(&row))
  }

  #[instrument(skip(self), err)]
  async fn list_document_types(&self) -> RepoResult<Vec<DocumentTypeDefinition>> {
    let rows = sqlx::query(
      r#"
      SELECT id, key, label, description, icon, color, is_active, is_suggested
      FROM document_type_definition
      ORDER BY is_suggested, key
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(rows.iter().map(row_to_document_type).collect())
  }

  #[instrument(skip(self, doc_type), fields(key = %doc_type.key), err)]
  async fn upsert_document_type(&self, doc_type: &DocumentTypeDefinition) -> RepoResult<DocumentTypeDefinition> {
    let row = sqlx::query(
      r#"
      INSERT INTO document_type_definition
        (id, key, label, description, icon, color, is_active, is_suggested, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        icon = EXCLUDED.icon,
        color = EXCLUDED.color,
        is_active = EXCLUDED.is_active,
        is_suggested = EXCLUDED.is_suggested,
        updated_at = now()
      RETURNING id, key, label, description, icon, color, is_active, is_suggested
      "#,
    )
    .bind(doc_type.id)
    .bind(&doc_type.key)
    .bind(&doc_type.label)
    .bind(&doc_type.description)
    .bind(&doc_type.icon)
    .bind(&doc_type.color)
    .bind(doc_type.is_active)
    .bind(doc_type.is_suggested)
    .fetch_one(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row_to_document_type(&row))
  }

  #[instrument(skip(self), err)]
  async fn get_workspace_settings(&self, workspace_id: uuid::Uuid) -> RepoResult<Option<DocumentWorkspaceSettings>> {
    let row = sqlx::query(
      r#"
      SELECT
        w.id AS workspace_id,
        COALESCE(ws.status_schema_id, org.status_schema_id) AS status_schema_id,
        COALESCE(ws.default_status_id, org.default_status_id) AS default_status_id,
        ws.version_policy_id AS version_policy_id,
        COALESCE(ws.default_document_type_id, org.default_document_type_id) AS default_document_type_id,
        COALESCE(ws.default_classification_id, org.default_classification_id) AS default_classification_id,
        COALESCE(ws.default_retention_policy_id, org.default_retention_policy_id) AS default_retention_policy_id,
        COALESCE(ws.updated_by, org.updated_by) AS updated_by,
        COALESCE(ws.updated_at, org.updated_at, now()) AS updated_at
      FROM workspaces w
      LEFT JOIN document_workspace_settings ws ON ws.workspace_id = w.id
      LEFT JOIN organization_document_settings org
        ON org.organization_id = document_metadata_effective_organization_id(w.id)
      WHERE w.id = $1
        AND w.lifecycle_state = 'active'
        AND w.deleted_at IS NULL
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row.as_ref().map(row_to_workspace_settings))
  }

  #[instrument(skip(self), err)]
  async fn get_persisted_workspace_settings(
    &self,
    workspace_id: uuid::Uuid,
  ) -> RepoResult<Option<DocumentWorkspaceSettings>> {
    let row = sqlx::query(
      r#"
      SELECT workspace_id, status_schema_id, default_status_id, version_policy_id,
             default_document_type_id, default_classification_id,
             default_retention_policy_id, updated_by, updated_at
      FROM document_workspace_settings
      WHERE workspace_id = $1
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row.as_ref().map(row_to_workspace_settings))
  }

  #[instrument(skip(self, settings), fields(workspace_id = %settings.workspace_id), err)]
  async fn upsert_workspace_settings(&self, settings: &DocumentWorkspaceSettings) -> RepoResult<()> {
    let settings = normalize_workspace_status_default(&self.pool, settings).await?;
    assert_workspace_default_fields_editable(&self.pool, &settings).await?;
    sqlx::query(
      r#"
      INSERT INTO document_workspace_settings
        (workspace_id, status_schema_id, default_status_id, version_policy_id, default_document_type_id,
         default_classification_id, default_retention_policy_id, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
      ON CONFLICT (workspace_id) DO UPDATE SET
        status_schema_id = EXCLUDED.status_schema_id,
        default_status_id = EXCLUDED.default_status_id,
        version_policy_id = EXCLUDED.version_policy_id,
        default_document_type_id = EXCLUDED.default_document_type_id,
        default_classification_id = EXCLUDED.default_classification_id,
        default_retention_policy_id = EXCLUDED.default_retention_policy_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      "#,
    )
    .bind(settings.workspace_id)
    .bind(settings.status_schema_id)
    .bind(settings.default_status_id)
    .bind(settings.version_policy_id)
    .bind(settings.default_document_type_id)
    .bind(settings.default_classification_id)
    .bind(settings.default_retention_policy_id)
    .bind(settings.updated_by)
    .execute(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn get_metadata_state(&self, doc_id: uuid::Uuid) -> RepoResult<Option<DocumentMetadataState>> {
    let row = sqlx::query(
      r#"
      SELECT d.id AS doc_id, d.status_id, d.document_type_id AS type_id, d.current_version_id,
             d.dirty_since_current_version, d.version_display_mode, d.last_versioned_at,
             CASE
               WHEN d.responsible_user_id IS NULL THEN '[]'::jsonb
               ELSE jsonb_build_array(jsonb_build_object('kind', 'user', 'id', d.responsible_user_id::text))
             END AS responsible_principals,
             d.review_due_at, d.valid_from, d.valid_until,
             d.classification_id, d.document_number, lang.key AS language,
             COALESCE(aud.audience_ids, ARRAY[]::uuid[]) AS audience_ids,
             d.retention_policy_id,
             d.metadata_updated_by AS updated_by,
             COALESCE(d.metadata_updated_at, d.updated_at) AS updated_at,
             '{}'::jsonb AS metadata
      FROM docs d
      LEFT JOIN language_definition lang ON lang.id = d.language_id
      LEFT JOIN LATERAL (
        SELECT array_agg(a.audience_id ORDER BY ad.sort_order, ad.key) AS audience_ids
        FROM doc_audience_assignment a
        JOIN document_audience_definition ad ON ad.id = a.audience_id
        WHERE a.doc_id = d.id
      ) aud ON true
      WHERE d.id = $1 AND d.deleted_at IS NULL
      "#,
    )
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(row.as_ref().map(row_to_metadata_state))
  }

  #[instrument(skip(self), fields(workspace_id = %workspace_id), err)]
  async fn list_metadata_index(&self, workspace_id: uuid::Uuid) -> RepoResult<Vec<DocumentMetadataIndexRow>> {
    let rows = sqlx::query(METADATA_INDEX_SQL)
      .bind(workspace_id)
      .fetch_all(&self.pool)
      .await
      .map_err(db_error)?;
    Ok(rows.iter().map(row_to_metadata_index).collect())
  }

  #[instrument(skip(self), fields(workspace_id = %workspace_id), err)]
  async fn metadata_index_version(&self, workspace_id: uuid::Uuid) -> RepoResult<String> {
    sqlx::query_scalar(METADATA_INDEX_VERSION_SQL)
      .bind(workspace_id)
      .fetch_one(&self.pool)
      .await
      .map_err(db_error)
  }

  #[instrument(skip(self), fields(workspace_id = %workspace_id), err)]
  async fn list_metadata_index_versioned(&self, workspace_id: uuid::Uuid) -> RepoResult<DocumentMetadataIndexSnapshot> {
    let mut tx = self.pool.begin().await.map_err(db_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(db_error)?;
    let version = sqlx::query_scalar(METADATA_INDEX_VERSION_SQL)
      .bind(workspace_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(db_error)?;
    let rows = sqlx::query(METADATA_INDEX_SQL)
      .bind(workspace_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(DocumentMetadataIndexSnapshot {
      version,
      rows: rows.iter().map(row_to_metadata_index).collect(),
    })
  }

  #[instrument(skip_all, err)]
  async fn metadata_index_labels(
    &self,
    rows: &[DocumentMetadataIndexRow],
  ) -> RepoResult<std::collections::BTreeMap<uuid::Uuid, DocumentMetadataIndexLabels>> {
    if rows.is_empty() {
      return Ok(Default::default());
    }
    // Join the exact cached/admitted references, rather than silently reading
    // different current IDs. Inactive definitions still name historical values.
    let labels = sqlx::query(
      r#"
      SELECT requested.doc_id, status.label AS status_label,
             kind.label AS document_type_label, version.label AS version_label,
             classification.label AS classification_label
      FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[])
        AS requested(doc_id, status_id, type_id, version_id, classification_id)
      LEFT JOIN document_status_value status ON status.id = requested.status_id
      LEFT JOIN document_type_definition kind ON kind.id = requested.type_id
      LEFT JOIN document_version version ON version.id = requested.version_id AND version.doc_id = requested.doc_id
      LEFT JOIN document_classification_definition classification ON classification.id = requested.classification_id
    "#,
    )
    .bind(rows.iter().map(|row| row.doc_id).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.status_id).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.document_type_id).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.current_version_id).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.classification_id).collect::<Vec<_>>())
    .fetch_all(&self.pool)
    .await
    .map_err(db_error)?;
    Ok(
      labels
        .into_iter()
        .map(|row| {
          (
            row.get("doc_id"),
            DocumentMetadataIndexLabels {
              status_label: row.get("status_label"),
              document_type_label: row.get("document_type_label"),
              version_label: row.get("version_label"),
              classification_label: row.get("classification_label"),
            },
          )
        })
        .collect(),
    )
  }

  #[instrument(skip(self), err)]
  async fn document_runtime_overview(&self) -> RepoResult<DocumentRuntimeOverview> {
    let total_documents = sqlx::query_scalar::<_, i64>("SELECT COUNT(*)::BIGINT FROM docs WHERE deleted_at IS NULL")
      .fetch_one(&self.pool)
      .await
      .map_err(db_error)?;

    let by_status = fetch_runtime_buckets(
      &self.pool,
      &format!(
        r#"{RUNTIME_EFFECTIVE_DOCS_CTE}
      SELECT sv.key, sv.label, COUNT(*)::BIGINT AS count
      FROM runtime_effective_docs red
      LEFT JOIN document_status_value sv ON sv.id = red.effective_status_id
      GROUP BY sv.key, sv.label
      ORDER BY count DESC, sv.label NULLS LAST, sv.key NULLS LAST
      "#
      ),
    )
    .await?;

    let by_document_type = fetch_runtime_buckets(
      &self.pool,
      &format!(
        r#"{RUNTIME_EFFECTIVE_DOCS_CTE}
      SELECT dt.key, dt.label, COUNT(*)::BIGINT AS count
      FROM runtime_effective_docs red
      LEFT JOIN document_type_definition dt ON dt.id = red.effective_type_id
      GROUP BY dt.key, dt.label
      ORDER BY count DESC, dt.label NULLS LAST, dt.key NULLS LAST
      "#
      ),
    )
    .await?;

    let by_classification = fetch_runtime_buckets(
      &self.pool,
      &format!(
        r#"{RUNTIME_EFFECTIVE_DOCS_CTE}
      SELECT av.key, av.label, COUNT(*)::BIGINT AS count
      FROM runtime_effective_docs red
      LEFT JOIN document_classification_definition av ON av.id = red.effective_classification_id
      GROUP BY av.key, av.label
      ORDER BY count DESC, av.label NULLS LAST, av.key NULLS LAST
      "#
      ),
    )
    .await?;

    let by_review_due = fetch_runtime_buckets(
      &self.pool,
      &format!(
        r#"{RUNTIME_EFFECTIVE_DOCS_CTE}
      SELECT bucket.key, bucket.label, COUNT(*)::BIGINT AS count
      FROM runtime_effective_docs red
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN red.review_due_at IS NULL THEN 'no_review'
          WHEN red.review_due_at < now() THEN 'overdue'
          WHEN red.review_due_at < now() + interval '7 days' THEN 'due_7d'
          WHEN red.review_due_at < now() + interval '30 days' THEN 'due_30d'
          ELSE 'later'
        END AS key,
        NULL::TEXT AS label
      ) bucket
      GROUP BY bucket.key, bucket.label
      ORDER BY count DESC, bucket.key
      "#
      ),
    )
    .await?;

    let by_version_state = fetch_runtime_buckets(
      &self.pool,
      &format!(
        r#"{RUNTIME_EFFECTIVE_DOCS_CTE}
      SELECT bucket.key, bucket.label, COUNT(*)::BIGINT AS count
      FROM runtime_effective_docs red
      LEFT JOIN document_version v ON v.id = red.current_version_id
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN red.current_version_id IS NULL THEN 'no_current_version'
          WHEN COALESCE(v.is_protected, false) OR COALESCE(v.is_pinned, false) OR v.kind = 'published' THEN 'protected_current'
          WHEN red.dirty_since_current_version THEN 'dirty_since_current_version'
          ELSE 'current_clean'
        END AS key,
        NULL::TEXT AS label
      ) bucket
      GROUP BY bucket.key, bucket.label
      ORDER BY count DESC, bucket.key
      "#
      )
    )
    .await?;

    Ok(DocumentRuntimeOverview {
      total_documents,
      by_status,
      by_document_type,
      by_classification,
      by_review_due,
      by_version_state,
    })
  }
}
