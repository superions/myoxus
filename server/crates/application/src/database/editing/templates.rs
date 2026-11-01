//! Row/Page template bindings for server-backed Databases.
//!
//! Database-local bindings reference Template Registry catalog entries. Cell-
//! only templates create documentless Rows; templates with a materialized body
//! explicitly create optional Row content through the normal lifecycle.

use super::access;

use std::collections::{BTreeMap, HashMap};

use chrono::Utc;
use myoxus_domain::database::{
  DatabaseCellValueData, DatabaseEditPrecondition, DatabaseRecord, DatabaseRowKind, DatabaseRowRecord,
  DatabaseRowTemplate, DatabaseRowTemplateApplyRequest, DatabaseRowTemplateBinding, DatabaseTaskRelationReason,
};
use myoxus_domain::ids::{DatabaseFieldId, DatabaseId, UserId};
use myoxus_domain::permission::DocAction;
use myoxus_domain::template_registry::{
  InstanceState, TemplateCatalogEntry, TemplateCatalogEntryId, TemplateSource, TemplateStatus,
};
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use crate::doc::canonical_yjs_revision;
use crate::document_template::{DocumentTemplateError, DocumentTemplateService};
use crate::permission::{AccessController, DocResource};
use crate::template_registry::TemplateRegistryService;

use super::{
  DatabaseEditingService, DatabaseResult, DatabaseServiceError, ERR_CELL_INVALID, ERR_FORBIDDEN,
  ERR_ROW_TEMPLATE_APPLY_FAILED, ERR_ROW_TEMPLATE_CELL_VALUE_INVALID, ERR_ROW_TEMPLATE_FORBIDDEN,
  ERR_ROW_TEMPLATE_NOT_FOUND, ERR_ROW_TEMPLATE_RECONCILE_REQUIRED, ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
};

#[derive(Debug, Clone)]
pub struct CreateDatabaseRowTemplate {
  pub database_id: DatabaseId,
  pub template_id: TemplateCatalogEntryId,
  pub row_kind: DatabaseRowKind,
  pub name: String,
  pub description: Option<String>,
  pub position: Option<i32>,
  pub enabled: bool,
  pub is_default: bool,
  pub initial_cell_values: BTreeMap<DatabaseFieldId, DatabaseCellValueData>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateDatabaseRowTemplate {
  pub expected_edit_revision: i64,
  pub name: Option<String>,
  pub description: Option<Option<String>>,
  pub position: Option<i32>,
  pub enabled: Option<bool>,
  pub is_default: Option<bool>,
  pub initial_cell_values: Option<BTreeMap<DatabaseFieldId, DatabaseCellValueData>>,
}

impl DatabaseEditingService {
  async fn row_template_write_error(
    &self,
    actor: UserId,
    id: Uuid,
    error: myoxus_domain::repositories::RepositoryError,
  ) -> DatabaseServiceError {
    let error = row_template_repository_error(error);
    if error.code == crate::database::ERR_DATABASE_CONFLICT {
      self.row_template_latest_conflict(actor, id, error).await
    } else {
      error
    }
  }

  async fn row_template_latest_conflict(
    &self,
    actor: UserId,
    id: Uuid,
    error: DatabaseServiceError,
  ) -> DatabaseServiceError {
    let latest = match self.row_repo.get_row_template(id).await {
      Ok(Some(latest)) => latest,
      Ok(None) => {
        return error.with_latest_state(serde_json::json!({"kind":"rowTemplate","rowTemplateId":id,"deleted":true}));
      }
      Err(storage) => return row_template_repository_error(storage),
    };
    if let Err(access_error) =
      access::get_database(&self.permission, &self.schema_repo, actor, latest.database_id).await
    {
      return row_template_access_error(access_error);
    }
    error.with_latest_state(serde_json::json!({"kind":"rowTemplate","databaseId":latest.database_id,
      "rowTemplateId":latest.id,"editRevision":latest.edit_revision,"name":latest.name,
      "description":latest.description,"position":latest.position,"enabled":latest.enabled,
      "isDefault":latest.is_default,"initialCellValues":latest.initial_cell_values}))
  }
  #[instrument(skip(self, template_registry), fields(database_id = %database_id, actor = %actor))]
  pub async fn list_row_template_bindings(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    template_registry: &TemplateRegistryService,
  ) -> DatabaseResult<Vec<DatabaseRowTemplateBinding>> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id)
      .await
      .map_err(row_template_access_error)?;
    let templates = self
      .row_repo
      .list_row_templates(database_id)
      .await
      .map_err(row_template_repository_error)?;
    let mut bindings = Vec::with_capacity(templates.len());
    for row_template in templates {
      if row_template.workspace_id != record.database.workspace_id {
        warn!(
          database_id = %database_id,
          row_template_id = %row_template.id,
          "workspace database row template workspace mismatch"
        );
        continue;
      }
      bindings.push(self.row_template_binding(&row_template, template_registry).await?);
    }
    Ok(bindings)
  }

  #[instrument(skip(self, template_registry, input), fields(database_id = %input.database_id, actor = %actor))]
  pub async fn create_row_template(
    &self,
    actor: UserId,
    input: CreateDatabaseRowTemplate,
    template_registry: &TemplateRegistryService,
  ) -> DatabaseResult<DatabaseRowTemplateBinding> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, input.database_id)
      .await
      .map_err(row_template_access_error)?;
    access::assert_database_manager(&self.permission, actor, &record.database)
      .await
      .map_err(row_template_access_error)?;
    self
      .assert_template_can_be_bound(record.database.workspace_id, input.template_id, template_registry)
      .await?;
    let initial_cell_values = self
      .validate_template_cell_values(&record, input.row_kind, input.initial_cell_values)
      .await?;
    let now = Utc::now();
    let row_template = DatabaseRowTemplate {
      edit_revision: 1,
      content_document_id: None,
      id: Uuid::new_v4(),
      workspace_id: record.database.workspace_id,
      database_id: record.database.id,
      template_id: input.template_id,
      row_kind: input.row_kind,
      name: validate_row_template_name(&input.name)?,
      description: validate_row_template_description(input.description)?,
      position: input
        .position
        .unwrap_or_else(|| record.row_count.try_into().unwrap_or(i32::MAX))
        .max(0),
      enabled: input.enabled,
      is_default: input.is_default,
      initial_cell_values,
      created_by: Some(actor),
      updated_by: Some(actor),
      created_at: now,
      updated_at: now,
    };
    let created = self
      .row_repo
      .create_row_template(
        row_template,
        DatabaseEditPrecondition::default()
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await
      .map_err(row_template_repository_error)?;
    self.row_template_binding(&created, template_registry).await
  }

  #[instrument(skip(self, template_registry, input), fields(row_template_id = %row_template_id, actor = %actor))]
  pub async fn update_row_template(
    &self,
    actor: UserId,
    row_template_id: Uuid,
    input: UpdateDatabaseRowTemplate,
    template_registry: &TemplateRegistryService,
  ) -> DatabaseResult<DatabaseRowTemplateBinding> {
    let current = self
      .row_repo
      .get_row_template(row_template_id)
      .await
      .map_err(row_template_repository_error)?
      .ok_or_else(|| DatabaseServiceError::new(ERR_ROW_TEMPLATE_NOT_FOUND, "row template not found"))?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, current.database_id)
      .await
      .map_err(row_template_access_error)?;
    access::assert_database_manager(&self.permission, actor, &record.database)
      .await
      .map_err(row_template_access_error)?;
    if current.workspace_id != record.database.workspace_id {
      return Err(DatabaseServiceError::new(
        ERR_ROW_TEMPLATE_FORBIDDEN,
        "row template workspace does not match database",
      ));
    }
    // Detect stale drafts before validating values against an upgraded schema.
    // The repository repeats this fence atomically with the eventual write.
    if current.edit_revision != input.expected_edit_revision {
      return Err(
        self
          .row_template_write_error(
            actor,
            row_template_id,
            myoxus_domain::repositories::RepositoryError::Conflict("database row template edit revision"),
          )
          .await,
      );
    }
    let name = input.name.map(|name| validate_row_template_name(&name)).transpose()?;
    let description = input.description.map(validate_row_template_description).transpose()?;
    let initial_cell_values = match input.initial_cell_values {
      Some(values) => Some(
        self
          .validate_template_cell_values(&record, current.row_kind, values)
          .await?,
      ),
      None => None,
    };
    let updated = self
      .row_repo
      .update_row_template(
        row_template_id,
        name,
        description,
        input.position.map(|position| position.max(0)),
        input.enabled,
        input.is_default,
        initial_cell_values,
        actor,
        DatabaseEditPrecondition::new(Some(input.expected_edit_revision), false)
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await;
    let updated = match updated {
      Ok(updated) => updated,
      Err(error) => return Err(self.row_template_write_error(actor, row_template_id, error).await),
    };
    self.row_template_binding(&updated, template_registry).await
  }

  #[instrument(skip(self), fields(row_template_id = %row_template_id, actor = %actor))]
  pub async fn delete_row_template(
    &self,
    actor: UserId,
    row_template_id: Uuid,
    expected_edit_revision: i64,
  ) -> DatabaseResult<()> {
    let current = self
      .row_repo
      .get_row_template(row_template_id)
      .await
      .map_err(row_template_repository_error)?
      .ok_or_else(|| DatabaseServiceError::new(ERR_ROW_TEMPLATE_NOT_FOUND, "row template not found"))?;
    let record = access::get_database(&self.permission, &self.schema_repo, actor, current.database_id)
      .await
      .map_err(row_template_access_error)?;
    access::assert_database_manager(&self.permission, actor, &record.database)
      .await
      .map_err(row_template_access_error)?;
    let result = self
      .row_repo
      .delete_row_template(
        row_template_id,
        DatabaseEditPrecondition::new(Some(expected_edit_revision), false)
          .in_workspace(record.database.workspace_id)
          .in_database(record.database.id),
      )
      .await;
    match result {
      Ok(()) => Ok(()),
      Err(error) => Err(self.row_template_write_error(actor, row_template_id, error).await),
    }
  }
}

impl DatabaseEditingService {
  /// One read edge for both interactive inspection and application. A stored
  /// binding never bypasses the current source-read and Registry checks.
  pub(in crate::database) async fn capture_row_template(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_template_id: Uuid,
    template_registry: &TemplateRegistryService,
  ) -> DatabaseResult<(DatabaseRowTemplate, Option<Uuid>, Option<Vec<u8>>)> {
    let row_template = self
      .row_repo
      .get_row_template(row_template_id)
      .await
      .map_err(row_template_repository_error)?
      .ok_or_else(|| DatabaseServiceError::new(ERR_ROW_TEMPLATE_NOT_FOUND, "row template not found"))?;
    if row_template.database_id != database_id {
      return Err(DatabaseServiceError::new(
        ERR_ROW_TEMPLATE_NOT_FOUND,
        "row template does not belong to database",
      ));
    }
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id)
      .await
      .map_err(row_template_access_error)?;
    if row_template.workspace_id != record.database.workspace_id {
      return Err(DatabaseServiceError::new(
        ERR_ROW_TEMPLATE_FORBIDDEN,
        "row template workspace does not match database",
      ));
    }
    if !row_template.enabled {
      return Err(DatabaseServiceError::new(
        ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
        "row template is disabled",
      ));
    }
    let (template_doc_id, template_snapshot) = self
      .resolve_template_snapshot(actor, &row_template, template_registry)
      .await?;
    Ok((row_template, template_doc_id, template_snapshot))
  }

  #[instrument(skip_all)]
  pub async fn row_template_body_inputs(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_template_id: Uuid,
    template_registry: &TemplateRegistryService,
  ) -> DatabaseResult<(Vec<String>, Option<String>)> {
    let (_, _, snapshot) = self
      .capture_row_template(actor, database_id, row_template_id, template_registry)
      .await?;
    let Some(snapshot) = snapshot else {
      return Ok((vec![], None));
    };
    let names = DocumentTemplateService::row_body_inputs(&snapshot).map_err(row_template_content_error)?;
    let revision = canonical_yjs_revision(&snapshot)
      .map_err(|_| DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, "invalid template body"))?;
    Ok((names, Some(revision)))
  }

  #[instrument(skip(self, template_registry, request, document_templates), fields(database_id = %request.database_id, row_template_id = %request.row_template_id, actor = %actor))]
  pub async fn create_row_from_template(
    &self,
    actor: UserId,
    request: DatabaseRowTemplateApplyRequest,
    template_registry: &TemplateRegistryService,
    document_templates: Option<&DocumentTemplateService>,
  ) -> DatabaseResult<DatabaseRowRecord> {
    let (row_template, template_doc_id, template_snapshot) = self
      .capture_row_template(actor, request.database_id, request.row_template_id, template_registry)
      .await?;
    let content = if let Some(snapshot) = template_snapshot {
      let revision = canonical_yjs_revision(&snapshot)
        .map_err(|_| DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, "invalid template body"))?;
      if request
        .source_revision
        .as_ref()
        .is_some_and(|expected| expected != &revision)
      {
        return Err(DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
          "template source changed; select the template again",
        ));
      }
      let templates = document_templates.ok_or_else(|| {
        DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
          "document template capability is unavailable",
        )
      })?;
      let source_id = template_doc_id.ok_or_else(|| {
        DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, "template source is unavailable")
      })?;
      Some((
        templates,
        templates
          .prepare_row_body(
            actor,
            row_template.workspace_id,
            source_id,
            snapshot,
            &request.body_inputs,
          )
          .await
          .map_err(row_template_content_error)?,
      ))
    } else {
      if !request.body_inputs.is_empty() || request.source_revision.is_some() {
        return Err(DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
          "cell-only template has no body inputs",
        ));
      }
      None
    };
    let mut initial_cells = row_template.initial_cell_values.clone();
    for (field_id, value) in request.override_cell_values {
      initial_cells.insert(field_id, value);
    }
    let row = self
      .create_row_with_kind(
        actor,
        request.database_id,
        row_template.row_kind,
        request.title.or_else(|| Some(row_template.name.clone())),
        initial_cells.into_iter().collect(),
        (row_template.id, row_template.edit_revision),
        content,
      )
      .await;
    let row = match row {
      Ok(row) => row,
      Err(error) if error.code == crate::database::ERR_DATABASE_CONFLICT => {
        return Err(self.row_template_latest_conflict(actor, row_template.id, error).await);
      }
      Err(error) => return Err(error),
    };
    // P-DB-24: emit a row-template-applied activity event
    use myoxus_domain::database_activity::DatabaseActivityEventType;
    self
      .effects
      .record_activity(
        row_template.workspace_id,
        row.row.database_id,
        Some(row.row.id),
        DatabaseActivityEventType::RowTemplateApplied,
        actor,
        serde_json::json!({
          "rowTemplateId": row_template.id,
          "rowTemplateName": row_template.name.clone(),
          "rowKind": row.row.row_kind.as_str(),
        }),
      )
      .await;
    debug!(
      database_id = %request.database_id,
      row_id = %row.row.id,
      content_document_id = ?row.row.content_document_id,
      row_template_id = %row_template.id,
      template_doc_id = ?template_doc_id,
      "workspace database row template applied"
    );
    Ok(row)
  }
}

impl DatabaseEditingService {
  pub(in crate::database) async fn validate_template_cell_values(
    &self,
    record: &DatabaseRecord,
    row_kind: DatabaseRowKind,
    values: BTreeMap<DatabaseFieldId, DatabaseCellValueData>,
  ) -> DatabaseResult<BTreeMap<DatabaseFieldId, DatabaseCellValueData>> {
    let field_map = record
      .fields
      .iter()
      .map(|field| (field.id, field))
      .collect::<HashMap<_, _>>();
    let mut normalized = BTreeMap::new();
    for (field_id, value) in values {
      let field = field_map
        .get(&field_id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_ROW_TEMPLATE_CELL_VALUE_INVALID, "unknown field id"))?;
      let Some(value) =
        crate::database::editing::rules::normalize_editable_cell_value(field.field_type, value, &self.limits)?
      else {
        continue;
      };
      if access::validate_parent_cell_input(&self.limits, &self.row_repo, record, &[], field, &value, Some(row_kind))
        .await?
      {
        normalized.insert(field_id, value);
        continue;
      }
      crate::database::editing::rules::validate_cell_value(field, &value, &self.limits).map_err(|error| {
        if error.code == ERR_CELL_INVALID {
          DatabaseServiceError::new(ERR_ROW_TEMPLATE_CELL_VALUE_INVALID, error.message)
        } else {
          error
        }
      })?;
      access::validate_user_cell_membership(&self.workspace_store, record.database.workspace_id, &value).await?;
      if let DatabaseCellValueData::DocumentLink(link) = &value {
        access::validate_document_link_value(&self.doc_service, record.database.workspace_id, link).await?;
      }
      normalized.insert(field_id, value);
    }
    Ok(normalized)
  }

  pub(in crate::database) async fn assert_template_can_be_bound(
    &self,
    workspace_id: Uuid,
    template_id: TemplateCatalogEntryId,
    template_registry: &TemplateRegistryService,
  ) -> DatabaseResult<()> {
    let entry = template_registry
      .get_catalog_entry_for_binding(template_id)
      .await
      .map_err(|error| DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, error.to_string()))?
      .ok_or_else(|| {
        DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, "template catalog entry not found")
      })?;
    match entry.status {
      TemplateStatus::Active => {}
      TemplateStatus::Disabled => {
        return Err(DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
          "template catalog entry is disabled",
        ));
      }
      TemplateStatus::Archived => {
        return Err(DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
          "template catalog entry is archived",
        ));
      }
    }
    assert_row_template_category(&entry)?;
    if is_cell_only_database_row_template(&entry) {
      return Ok(());
    }
    let revision = template_registry
      .latest_published_revision_for_binding(template_id)
      .await
      .map_err(|error| DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, error.to_string()))?;
    if revision
      .as_ref()
      .is_some_and(crate::template_registry::revision_is_guide)
    {
      return Err(DatabaseServiceError::new(
        ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
        "ordinary guides cannot be row templates",
      ));
    }
    if revision.is_none() {
      return Err(DatabaseServiceError::new(
        ERR_ROW_TEMPLATE_RECONCILE_REQUIRED,
        "template has no published revision",
      ));
    }
    if template_registry
      .find_workspace_instance_for_binding(workspace_id, template_id)
      .await
      .map_err(|error| DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, error.to_string()))?
      .is_none()
    {
      return Err(DatabaseServiceError::new(
        ERR_ROW_TEMPLATE_RECONCILE_REQUIRED,
        "template must be reconciled for this workspace before it can be used",
      ));
    }
    Ok(())
  }

  pub(in crate::database) async fn row_template_binding(
    &self,
    row_template: &DatabaseRowTemplate,
    template_registry: &TemplateRegistryService,
  ) -> DatabaseResult<DatabaseRowTemplateBinding> {
    let entry = template_registry
      .get_catalog_entry_for_binding(row_template.template_id)
      .await
      .map_err(|error| DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, error.to_string()))?;
    if entry.as_ref().is_some_and(is_cell_only_database_row_template) {
      return Ok(DatabaseRowTemplateBinding {
        row_template: row_template.clone(),
        template_available: true,
        reconcile_required: false,
        detached: false,
        disabled: false,
        archived: false,
      });
    }
    let instance = template_registry
      .find_workspace_instance_for_binding(row_template.workspace_id, row_template.template_id)
      .await
      .map_err(|error| DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, error.to_string()))?;
    let disabled = matches!(entry.as_ref().map(|entry| entry.status), Some(TemplateStatus::Disabled));
    let archived = matches!(entry.as_ref().map(|entry| entry.status), Some(TemplateStatus::Archived));
    let detached = row_template.content_document_id.is_none()
      && matches!(
        instance.as_ref().map(|instance| instance.state),
        Some(InstanceState::Detached)
      );
    let owned_body_missing = if let Some(document_id) = row_template.content_document_id {
      self
        .doc_service
        .get_metadata_including_deleted(document_id)
        .await
        .map_err(|_| DatabaseServiceError::new(ERR_ROW_TEMPLATE_APPLY_FAILED, "template body metadata lookup failed"))?
        .is_none_or(|document| {
          document.workspace_id != Some(row_template.workspace_id) || document.deleted_at.is_some() || document.blocked
        })
    } else {
      false
    };
    let reconcile_required = owned_body_missing
      || entry.is_none()
      || (row_template.content_document_id.is_none()
        && (instance.is_none()
          || matches!(
            instance.as_ref().map(|instance| instance.state),
            Some(InstanceState::UpdateAvailable | InstanceState::Error | InstanceState::Retired)
          )
          || instance
            .as_ref()
            .and_then(|instance| instance.workspace_doc_id)
            .is_none()));
    Ok(DatabaseRowTemplateBinding {
      row_template: row_template.clone(),
      template_available: !disabled
        && !archived
        && !detached
        && !reconcile_required
        && entry
          .as_ref()
          .is_none_or(|entry| !crate::template_registry::is_building_block_category(entry.category.as_deref())),
      reconcile_required,
      detached,
      disabled,
      archived,
    })
  }
}

impl DatabaseEditingService {
  /// Resolve and authorize the source immediately before reading its content.
  /// A durable binding identifies a candidate source; it never grants the
  /// applying actor document access after permissions change.
  pub(in crate::database) async fn resolve_template_snapshot(
    &self,
    actor: UserId,
    row_template: &DatabaseRowTemplate,
    template_registry: &TemplateRegistryService,
  ) -> DatabaseResult<(Option<Uuid>, Option<Vec<u8>>)> {
    let template_doc_id = self
      .resolve_template_document_for_apply(row_template, template_registry)
      .await?;
    let Some(template_doc_id) = template_doc_id else {
      return Ok((None, None));
    };
    let metadata = self
      .doc_service
      .get_metadata_including_deleted(template_doc_id)
      .await
      .map_err(|error| {
        DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_APPLY_FAILED,
          format!("failed to load template document metadata: {error}"),
        )
      })?;
    let readable = metadata.is_some_and(|document| {
      document.workspace_id == Some(row_template.workspace_id) && document.deleted_at.is_none() && !document.blocked
    }) && self
      .permission
      .can(
        &DocResource {
          user_id: actor,
          workspace_id: row_template.workspace_id,
          doc_id: template_doc_id,
        },
        DocAction::Read,
      )
      .await;
    if !readable {
      return Err(DatabaseServiceError::new(
        ERR_ROW_TEMPLATE_FORBIDDEN,
        "row template source document is unavailable",
      ));
    }
    let snapshot = self
      .doc_service
      .get_snapshot(row_template.workspace_id, template_doc_id)
      .await
      .map_err(|error| {
        DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_APPLY_FAILED,
          format!("failed to load template document snapshot: {error}"),
        )
      })?
      .ok_or_else(|| {
        DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_APPLY_FAILED,
          "template document has no snapshot to apply",
        )
      })?;
    Ok((Some(template_doc_id), Some(snapshot)))
  }

  pub(in crate::database) async fn resolve_template_document_for_apply(
    &self,
    row_template: &DatabaseRowTemplate,
    template_registry: &TemplateRegistryService,
  ) -> DatabaseResult<Option<Uuid>> {
    let entry = template_registry
      .get_catalog_entry_for_binding(row_template.template_id)
      .await
      .map_err(|error| DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, error.to_string()))?
      .ok_or_else(|| {
        DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, "template catalog entry not found")
      })?;
    match entry.status {
      TemplateStatus::Active => {}
      TemplateStatus::Disabled => {
        return Err(DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
          "template catalog entry is disabled",
        ));
      }
      TemplateStatus::Archived => {
        return Err(DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
          "template catalog entry is archived",
        ));
      }
    }
    assert_row_template_category(&entry)?;
    if let Some(document_id) = row_template.content_document_id {
      return Ok(Some(document_id));
    }
    if is_cell_only_database_row_template(&entry) {
      return Ok(None);
    }
    let instance = template_registry
      .find_workspace_instance_for_binding(row_template.workspace_id, row_template.template_id)
      .await
      .map_err(|error| DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, error.to_string()))?
      .ok_or_else(|| {
        DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_RECONCILE_REQUIRED,
          "template must be reconciled for this workspace before it can be used",
        )
      })?;
    match instance.state {
      InstanceState::Ok => {}
      InstanceState::UpdateAvailable | InstanceState::Error | InstanceState::Retired => {
        return Err(DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_RECONCILE_REQUIRED,
          "template instance requires reconcile before use",
        ));
      }
      InstanceState::Detached => {
        return Err(DatabaseServiceError::new(
          ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
          "template instance is detached",
        ));
      }
    }
    instance.workspace_doc_id.map(Some).ok_or_else(|| {
      DatabaseServiceError::new(
        ERR_ROW_TEMPLATE_RECONCILE_REQUIRED,
        "template instance has no materialized document",
      )
    })
  }
}

fn is_cell_only_database_row_template(entry: &TemplateCatalogEntry) -> bool {
  entry.source == TemplateSource::Builtin && entry.category.as_deref() == Some("database-row-template")
}

fn assert_row_template_category(entry: &TemplateCatalogEntry) -> DatabaseResult<()> {
  if crate::template_registry::is_building_block_category(entry.category.as_deref()) {
    return Err(DatabaseServiceError::new(
      ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
      "building blocks cannot be row templates",
    ));
  }
  Ok(())
}

fn validate_row_template_name(value: &str) -> DatabaseResult<String> {
  let trimmed = value.trim();
  if trimmed.is_empty() || trimmed.len() > 120 {
    return Err(DatabaseServiceError::new(
      ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
      "row template name must be between 1 and 120 characters",
    ));
  }
  Ok(trimmed.to_string())
}

fn validate_row_template_description(value: Option<String>) -> DatabaseResult<Option<String>> {
  let Some(value) = value else {
    return Ok(None);
  };
  let trimmed = value.trim();
  if trimmed.len() > 1024 {
    return Err(DatabaseServiceError::new(
      ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
      "row template description must not exceed 1024 characters",
    ));
  }
  Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

fn row_template_repository_error(error: myoxus_domain::repositories::RepositoryError) -> DatabaseServiceError {
  match error {
    myoxus_domain::repositories::RepositoryError::NotFound(_) => {
      DatabaseServiceError::new(ERR_ROW_TEMPLATE_NOT_FOUND, "row template not found")
    }
    error @ myoxus_domain::repositories::RepositoryError::Conflict("database row template edit revision") => {
      DatabaseServiceError::from(error)
    }
    myoxus_domain::repositories::RepositoryError::Conflict(message) => {
      DatabaseServiceError::new(ERR_ROW_TEMPLATE_TEMPLATE_INVALID, message)
    }
    myoxus_domain::repositories::RepositoryError::Validation(ref message)
      if DatabaseTaskRelationReason::from_validation_message(message).is_some() =>
    {
      DatabaseServiceError::from(error)
    }
    myoxus_domain::repositories::RepositoryError::Validation(message) => {
      DatabaseServiceError::new(ERR_ROW_TEMPLATE_CELL_VALUE_INVALID, message)
    }
    myoxus_domain::repositories::RepositoryError::Storage(message) => {
      DatabaseServiceError::new(ERR_ROW_TEMPLATE_APPLY_FAILED, message)
    }
  }
}

fn row_template_access_error(error: DatabaseServiceError) -> DatabaseServiceError {
  if error.code == ERR_FORBIDDEN {
    DatabaseServiceError::new(ERR_ROW_TEMPLATE_FORBIDDEN, error.message)
  } else {
    error
  }
}

fn row_template_content_error(_error: DocumentTemplateError) -> DatabaseServiceError {
  // Input values and source content never enter an error or tracing field.
  DatabaseServiceError::new(
    ERR_ROW_TEMPLATE_TEMPLATE_INVALID,
    "template body requires valid inputs and available context",
  )
}
