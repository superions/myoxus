// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace-scoped GraphQL contract for canonical document metadata.
//!
//! Resolvers in this module are intentionally thin. Required-field logic,
//! workspace policy merging, status-transition validation and version creation
//! live in `myoxus-application` services so API, CLI, PDF export and MCP do not
//! drift.

use std::sync::Arc;

use async_graphql::{Context, ID, InputObject, MaybeUndefined, Object, Result, SimpleObject};
use chrono::{DateTime, NaiveDate, Utc};
use uuid::Uuid;

use myoxus_application::doc::DocSpaceKind;
use myoxus_application::document_metadata::DocumentMetadataProjectionMode;
use myoxus_application::document_metadata_policy::{
  DocumentMetadataPolicyServiceError, DocumentStatusTransitionRequest, DocumentStatusTransitionService,
};
use myoxus_application::permission::AccessController;
use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{
  DocumentMetadataFieldDefinition, DocumentMetadataIndexRow, DocumentMetadataValidationCode,
  DocumentMetadataValueDefinition, DocumentStatusSchema, DocumentStatusTransition, DocumentStatusValue,
  DocumentTypeDefinition, DocumentWorkspaceSettings,
};
use myoxus_domain::repositories::{DocumentMetadataPolicyRepository, RepositoryError};

use crate::state::ApiState;

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataFieldDefinitionType {
  pub key: String,
  pub label: String,
  pub enabled: bool,
  pub required_mode: String,
  pub editable_by: String,
  pub visible_in_header: bool,
  pub visible_in_properties: bool,
  pub visible_in_lists: bool,
  pub export_mode: String,
  pub validation_config: serde_json::Value,
  pub metadata: serde_json::Value,
  pub updated_by: Option<ID>,
  pub updated_at: DateTime<Utc>,
}

impl From<DocumentMetadataFieldDefinition> for DocumentMetadataFieldDefinitionType {
  fn from(value: DocumentMetadataFieldDefinition) -> Self {
    Self {
      key: value.key,
      label: value.label,
      enabled: value.enabled,
      required_mode: value.required_mode,
      editable_by: value.editable_by,
      visible_in_header: value.visible_in_header,
      visible_in_properties: value.visible_in_properties,
      visible_in_lists: value.visible_in_lists,
      export_mode: value.export_mode,
      validation_config: value.validation_config,
      metadata: value.metadata,
      updated_by: value.updated_by.map(|id| ID(id.to_string())),
      updated_at: value.updated_at,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataValueDefinitionType {
  pub id: ID,
  pub field_key: String,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub color: Option<String>,
  pub icon: Option<String>,
  pub sort_order: i32,
  pub is_active: bool,
  pub metadata: serde_json::Value,
}

impl From<DocumentMetadataValueDefinition> for DocumentMetadataValueDefinitionType {
  fn from(value: DocumentMetadataValueDefinition) -> Self {
    Self {
      id: ID(value.id.to_string()),
      field_key: value.field_key,
      key: value.key,
      label: value.label,
      description: value.description,
      color: value.color,
      icon: value.icon,
      sort_order: value.sort_order,
      is_active: value.is_active,
      metadata: value.metadata,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentStatusSchemaType {
  pub id: ID,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub complexity: String,
  pub is_preset: bool,
  pub is_active: bool,
  pub metadata: serde_json::Value,
}

impl From<DocumentStatusSchema> for DocumentStatusSchemaType {
  fn from(value: DocumentStatusSchema) -> Self {
    Self {
      id: ID(value.id.to_string()),
      key: value.key,
      label: value.label,
      description: value.description,
      complexity: value.complexity,
      is_preset: value.is_preset,
      is_active: value.is_active,
      metadata: value.metadata,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentStatusValueType {
  pub id: ID,
  pub schema_id: ID,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub color: Option<String>,
  pub icon: Option<String>,
  pub sort_order: i32,
  pub terminal: bool,
  pub okf_status: String,
  pub is_active: bool,
  pub metadata: serde_json::Value,
}

impl From<DocumentStatusValue> for DocumentStatusValueType {
  fn from(value: DocumentStatusValue) -> Self {
    Self {
      id: ID(value.id.to_string()),
      schema_id: ID(value.schema_id.to_string()),
      key: value.key,
      label: value.label,
      description: value.description,
      color: value.color,
      icon: value.icon,
      sort_order: value.sort_order,
      terminal: value.terminal,
      okf_status: value.okf_status.as_str().to_owned(),
      is_active: value.is_active,
      metadata: value.metadata,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentStatusTransitionType {
  pub from_status_id: ID,
  pub to_status_id: ID,
  pub required_roles: Vec<String>,
  pub required_metadata_fields: Vec<String>,
  pub creates_version: String,
  pub sets_version_kind: Option<String>,
  pub date_enforcement: String,
  pub metadata: serde_json::Value,
}

impl From<DocumentStatusTransition> for DocumentStatusTransitionType {
  fn from(value: DocumentStatusTransition) -> Self {
    Self {
      from_status_id: ID(value.from_status_id.to_string()),
      to_status_id: ID(value.to_status_id.to_string()),
      required_roles: value.required_roles,
      required_metadata_fields: value.required_metadata_fields,
      creates_version: value.creates_version,
      sets_version_kind: value.sets_version_kind.map(|kind| kind.as_str().to_string()),
      date_enforcement: value.date_enforcement,
      metadata: value.metadata,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentTypeDefinitionType {
  pub id: ID,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub icon: Option<String>,
  pub color: Option<String>,
  pub is_active: bool,
  pub is_suggested: bool,
}

impl From<DocumentTypeDefinition> for DocumentTypeDefinitionType {
  fn from(value: DocumentTypeDefinition) -> Self {
    Self {
      id: ID(value.id.to_string()),
      key: value.key,
      label: value.label,
      description: value.description,
      icon: value.icon,
      color: value.color,
      is_active: value.is_active,
      is_suggested: value.is_suggested,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct WorkspaceDocumentSettingsType {
  pub workspace_id: ID,
  pub status_schema_id: Option<ID>,
  pub default_status_id: Option<ID>,
  pub version_policy_id: Option<ID>,
  pub default_document_type_id: Option<ID>,
  pub default_classification_id: Option<ID>,
  pub default_retention_policy_id: Option<ID>,
  pub updated_by: Option<ID>,
  pub updated_at: DateTime<Utc>,
}

impl From<DocumentWorkspaceSettings> for WorkspaceDocumentSettingsType {
  fn from(value: DocumentWorkspaceSettings) -> Self {
    Self {
      workspace_id: ID(value.workspace_id.to_string()),
      status_schema_id: value.status_schema_id.map(|id| ID(id.to_string())),
      default_status_id: value.default_status_id.map(|id| ID(id.to_string())),
      version_policy_id: value.version_policy_id.map(|id| ID(id.to_string())),
      default_document_type_id: value.default_document_type_id.map(|id| ID(id.to_string())),
      default_classification_id: value.default_classification_id.map(|id| ID(id.to_string())),
      default_retention_policy_id: value.default_retention_policy_id.map(|id| ID(id.to_string())),
      updated_by: value.updated_by.map(|id| ID(id.to_string())),
      updated_at: value.updated_at,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataIndexRowType {
  pub doc_id: ID,
  pub external_id: Option<ID>,
  pub created_by: Option<ID>,
  pub updated_by: Option<ID>,
  pub journal_date: Option<NaiveDate>,
  pub is_template: bool,
  pub template_state: Option<String>,
  pub template_origin: Option<String>,
  pub template_category: Option<String>,
  pub template_tags: Option<Vec<String>>,
  pub primary_mode: Option<String>,
  pub page_width: Option<String>,
  pub edgeless_color_theme: Option<String>,
  pub integration_type: Option<String>,
  pub can_publish: bool,
  pub status_id: Option<ID>,
  pub document_type_id: Option<ID>,
  pub current_version_id: Option<ID>,
  pub dirty_since_current_version: bool,
  pub review_due_at: Option<DateTime<Utc>>,
  pub valid_until: Option<DateTime<Utc>>,
  pub classification_id: Option<ID>,
  /// Current ordered labels, joined after the shared index's visibility filter.
  pub tag_ids: Vec<ID>,
}

impl DocumentMetadataIndexRowType {
  pub(crate) fn from_row(value: DocumentMetadataIndexRow, can_publish: bool) -> Self {
    Self {
      doc_id: ID(value.doc_id.to_string()),
      external_id: Some(ID(value.external_id.clone())),
      created_by: value.created_by.map(|id| ID(id.to_string())),
      updated_by: value.updated_by.map(|id| ID(id.to_string())),
      journal_date: value.journal_date,
      is_template: value.is_template,
      template_state: value.template_state,
      template_origin: value.template_origin,
      template_category: value.template_category,
      template_tags: value.template_tags,
      primary_mode: value.primary_mode,
      page_width: value.page_width,
      edgeless_color_theme: value.edgeless_color_theme,
      integration_type: value.integration_type,
      can_publish,
      status_id: value.status_id.map(|id| ID(id.to_string())),
      document_type_id: value.document_type_id.map(|id| ID(id.to_string())),
      current_version_id: value.current_version_id.map(|id| ID(id.to_string())),
      dirty_since_current_version: value.dirty_since_current_version,
      review_due_at: value.review_due_at,
      valid_until: value.valid_until,
      classification_id: value.classification_id.map(|id| ID(id.to_string())),
      tag_ids: Vec::new(),
    }
  }
}

#[derive(InputObject, Clone)]
pub struct TransitionDocumentStatusInput {
  pub to_status_id: ID,
  pub create_version: Option<bool>,
}

#[derive(InputObject, Clone)]
pub struct UpdateWorkspaceDocumentSettingsInput {
  pub status_schema_id: MaybeUndefined<ID>,
  pub default_status_id: MaybeUndefined<ID>,
  pub version_policy_id: MaybeUndefined<ID>,
  pub default_document_type_id: MaybeUndefined<ID>,
  pub default_classification_id: MaybeUndefined<ID>,
  pub default_retention_policy_id: MaybeUndefined<ID>,
}

#[derive(SimpleObject, Clone)]
pub struct TransitionDocumentStatusPayload {
  pub metadata: super::document_metadata::DocumentMetadataType,
  pub validation: super::document_metadata::DocumentMetadataValidationType,
}

pub struct DocumentMetadataPolicyQueryRoot;

#[Object]
impl DocumentMetadataPolicyQueryRoot {
  pub async fn document_metadata_field_definitions(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<DocumentMetadataFieldDefinitionType>> {
    let state = require_authenticated_state(ctx).await?;
    let repo = require_document_metadata_policy_repo(&state)?;
    Ok(
      repo
        .list_metadata_field_definitions()
        .await
        .map_err(repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  pub async fn document_metadata_value_definitions(
    &self,
    ctx: &Context<'_>,
    field_key: String,
  ) -> Result<Vec<DocumentMetadataValueDefinitionType>> {
    let state = require_authenticated_state(ctx).await?;
    let repo = require_document_metadata_policy_repo(&state)?;
    Ok(
      repo
        .list_metadata_value_definitions(&field_key)
        .await
        .map_err(repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  pub async fn document_status_schemas(&self, ctx: &Context<'_>) -> Result<Vec<DocumentStatusSchemaType>> {
    let state = require_authenticated_state(ctx).await?;
    let repo = require_document_metadata_policy_repo(&state)?;
    Ok(
      repo
        .list_status_schemas()
        .await
        .map_err(repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  pub async fn document_status_values(
    &self,
    ctx: &Context<'_>,
    schema_key: String,
  ) -> Result<Vec<DocumentStatusValueType>> {
    let state = require_authenticated_state(ctx).await?;
    let repo = require_document_metadata_policy_repo(&state)?;
    Ok(
      repo
        .list_status_values(&schema_key)
        .await
        .map_err(repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  pub async fn document_types(&self, ctx: &Context<'_>) -> Result<Vec<DocumentTypeDefinitionType>> {
    let state = require_authenticated_state(ctx).await?;
    let repo = require_document_metadata_policy_repo(&state)?;
    Ok(
      repo
        .list_document_types()
        .await
        .map_err(repo_error)?
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  pub async fn workspace_document_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Option<WorkspaceDocumentSettingsType>> {
    let workspace_id = parse_uuid_id(&workspace_id, "workspaceId")?;
    let state = require_workspace_action(ctx, workspace_id, myoxus_domain::permission::WorkspaceAction::Read).await?;
    let repo = require_document_metadata_policy_repo(&state)?;
    Ok(
      repo
        .get_workspace_settings(workspace_id)
        .await
        .map_err(repo_error)?
        .map(Into::into),
    )
  }

  pub async fn document_metadata_index(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<DocumentMetadataIndexRowType>> {
    let workspace_id = parse_uuid_id(&workspace_id, "workspaceId")?;
    let state = ctx
      .data::<Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::Read,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let policy_service = state
      .document_metadata_policy_service()
      .ok_or_else(|| async_graphql::Error::new("Document metadata policy service unavailable"))?;
    let mut rows = policy_service
      .list_metadata_index(workspace_id)
      .await
      .map_err(service_error)?;
    let documents = state
      .doc()
      .list_workspace_docs(workspace_id, i64::MAX, 0)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    let readable =
      crate::document_access::readable_workspace_documents_with_roles(state, snapshot.user.id, workspace_id, documents)
        .await
        .map_err(crate::graphql::utils::map_gql_error)?;
    let readable_roles = readable
      .into_iter()
      .map(|(doc, role)| (doc.id, role))
      .collect::<std::collections::HashMap<_, _>>();
    rows.retain(|row| readable_roles.contains_key(&row.doc_id));
    // Assignments are read outside the versioned metadata cache: Tag writes
    // have their own lifecycle, and must not inherit stale metadata-index facts.
    let with_tags = ctx.look_ahead().field("tagIds").exists();
    let mut tag_assignments = if with_tags {
      let keys = rows
        .iter()
        .map(|row| myoxus_domain::document_key::DocumentKey::parse(row.external_id.clone()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(async_graphql::Error::new)?;
      state
        .workspace_tag_service()
        .ok_or_else(|| async_graphql::Error::new("Workspace tag service unavailable"))?
        .assignments_for_readable_index(workspace_id, &keys)
        .await
        .map_err(|_| async_graphql::Error::new("Document label index unavailable"))?
        .into_iter()
        .map(|entry| (entry.external_id, entry.tag_ids))
        .collect::<std::collections::HashMap<_, _>>()
    } else {
      std::collections::HashMap::new()
    };
    if with_tags {
      // A document removed during the read is unavailable, not confirmed untagged.
      rows.retain(|row| tag_assignments.contains_key(&row.external_id));
    }
    tracing::info!(
      target: "document_metadata",
      workspace_id = %workspace_id,
      rows = rows.len(),
      "document metadata index loaded"
    );
    Ok(
      rows
        .into_iter()
        .map(|row| {
          let can_publish = readable_roles
            .get(&row.doc_id)
            .is_some_and(|role| role.can(myoxus_domain::permission::DocAction::Publish));
          let tag_ids = tag_assignments.remove(&row.external_id).unwrap_or_default();
          let mut projected = DocumentMetadataIndexRowType::from_row(row, can_publish);
          projected.tag_ids = tag_ids.into_iter().map(|id| ID(id.to_string())).collect();
          projected
        })
        .collect(),
    )
  }
}

pub struct DocumentMetadataPolicyMutationRoot;

#[Object]
impl DocumentMetadataPolicyMutationRoot {
  pub async fn transition_document_status(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    input: TransitionDocumentStatusInput,
  ) -> Result<TransitionDocumentStatusPayload> {
    let workspace_id = parse_uuid_id(&workspace_id, "workspaceId")?;
    let state = ctx
      .data::<std::sync::Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let doc_id = crate::graphql::utils::resolve_doc_id(state, workspace_id, doc_id.as_str()).await?;
    let to_status_id = parse_uuid_id(&input.to_status_id, "toStatusId")?;
    let (state, actor_id, workspace_id) =
      require_doc_action(ctx, doc_id, myoxus_domain::permission::DocAction::Update).await?;
    let repo = require_document_metadata_policy_repo(&state)?;
    let persisted_state = repo
      .get_metadata_state(doc_id)
      .await
      .map_err(repo_error)?
      .and_then(|state| state.status_id);
    let from_status_id = match persisted_state {
      Some(status_id) => status_id,
      None => {
        return Err(validation_code_error(
          DocumentMetadataValidationCode::DocumentStatusTransitionBlocked,
          "status",
          "document has no current status",
        ));
      }
    };
    if from_status_id == to_status_id {
      return Err(validation_code_error(
        DocumentMetadataValidationCode::DocumentStatusTransitionBlocked,
        "status",
        "document is already in the requested status",
      ));
    }
    let metadata_service = state
      .document_metadata_service()
      .ok_or_else(|| async_graphql::Error::new("document metadata service is not configured on this server"))?;
    let version_repo = state.document_version_repo();
    let service = if let Some(version_repo) = version_repo {
      DocumentStatusTransitionService::with_versioning(
        repo.clone(),
        Arc::new(state.doc().clone()),
        version_repo,
        metadata_service.clone(),
      )
    } else {
      DocumentStatusTransitionService::new(repo.clone(), metadata_service.clone())
    };
    let validation = service
      .transition_with_request(DocumentStatusTransitionRequest {
        doc_id,
        workspace_id,
        from_status_id,
        to_status_id,
        actor_id: Some(actor_id),
        actor_roles: Vec::new(),
        create_version: input.create_version.unwrap_or(false),
      })
      .await
      .map_err(service_error)?;
    let metadata_projection = metadata_service
      .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    if validation.valid() {
      record_document_metadata_audit(
        ctx,
        &state,
        "document_metadata.transition_status",
        doc_id,
        Some(serde_json::json!({
          "fromStatusId": from_status_id.to_string(),
          "toStatusId": to_status_id.to_string(),
          "createVersion": input.create_version.unwrap_or(false)
        })),
      )
      .await;
    }
    Ok(TransitionDocumentStatusPayload {
      metadata: super::document_metadata::map_metadata_projection(
        metadata_projection,
        DocumentMetadataProjectionMode::MyoxusNative,
      ),
      validation: validation.into(),
    })
  }

  pub async fn update_workspace_document_settings(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    input: UpdateWorkspaceDocumentSettingsInput,
  ) -> Result<WorkspaceDocumentSettingsType> {
    let workspace_id = parse_uuid_id(&workspace_id, "workspaceId")?;
    let state = require_workspace_action(
      ctx,
      workspace_id,
      myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
    )
    .await?;
    let repo = require_document_metadata_policy_repo(&state)?;
    let actor_id = super::ensure_authenticated_snapshot(ctx, &state).await?.user.id;
    let current = repo
      .get_persisted_workspace_settings(workspace_id)
      .await
      .map_err(repo_error)?;
    let settings = input.into_settings(workspace_id, Some(actor_id), current)?;
    repo.upsert_workspace_settings(&settings).await.map_err(repo_error)?;
    record_workspace_settings_audit(ctx, &state, workspace_id, &settings).await;
    let effective_settings = repo
      .get_workspace_settings(workspace_id)
      .await
      .map_err(repo_error)?
      .unwrap_or(settings);
    Ok(effective_settings.into())
  }
}

impl UpdateWorkspaceDocumentSettingsInput {
  fn into_settings(
    self,
    workspace_id: Uuid,
    actor_id: Option<Uuid>,
    current: Option<DocumentWorkspaceSettings>,
  ) -> Result<DocumentWorkspaceSettings> {
    Ok(DocumentWorkspaceSettings {
      workspace_id,
      status_schema_id: merge_maybe_uuid_id(
        self.status_schema_id,
        current.as_ref().and_then(|settings| settings.status_schema_id),
        "statusSchemaId",
      )?,
      default_status_id: merge_maybe_uuid_id(
        self.default_status_id,
        current.as_ref().and_then(|settings| settings.default_status_id),
        "defaultStatusId",
      )?,
      version_policy_id: merge_maybe_uuid_id(
        self.version_policy_id,
        current.as_ref().and_then(|settings| settings.version_policy_id),
        "versionPolicyId",
      )?,
      default_document_type_id: merge_maybe_uuid_id(
        self.default_document_type_id,
        current.as_ref().and_then(|settings| settings.default_document_type_id),
        "defaultDocumentTypeId",
      )?,
      default_classification_id: merge_maybe_uuid_id(
        self.default_classification_id,
        current.as_ref().and_then(|settings| settings.default_classification_id),
        "defaultClassificationId",
      )?,
      default_retention_policy_id: merge_maybe_uuid_id(
        self.default_retention_policy_id,
        current
          .as_ref()
          .and_then(|settings| settings.default_retention_policy_id),
        "defaultRetentionPolicyId",
      )?,
      updated_by: actor_id,
      updated_at: Utc::now(),
    })
  }
}

fn parse_uuid_id(id: &ID, field: &'static str) -> Result<Uuid> {
  Uuid::parse_str(id.as_str()).map_err(|_| validation_error(format!("invalid {field}"), field))
}

fn merge_maybe_uuid_id(value: MaybeUndefined<ID>, current: Option<Uuid>, field: &'static str) -> Result<Option<Uuid>> {
  match value {
    MaybeUndefined::Undefined => Ok(current),
    MaybeUndefined::Null => Ok(None),
    MaybeUndefined::Value(id) => Ok(Some(parse_uuid_id(&id, field)?)),
  }
}

fn require_document_metadata_policy_repo(state: &ApiState) -> Result<Arc<dyn DocumentMetadataPolicyRepository>> {
  state
    .document_metadata_policy_repo()
    .ok_or_else(|| async_graphql::Error::new("document metadata repository is not configured on this server"))
}

async fn require_authenticated_state(ctx: &Context<'_>) -> Result<Arc<ApiState>> {
  let state = ctx
    .data::<Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  super::ensure_authenticated_snapshot(ctx, state).await?;
  Ok(state.clone())
}

async fn require_workspace_action(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  action: myoxus_domain::permission::WorkspaceAction,
) -> Result<Arc<ApiState>> {
  let state = ctx
    .data::<Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  state
    .permission_service()
    .assert(
      &myoxus_application::permission::WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id,
      },
      action,
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  Ok(state.clone())
}

async fn require_doc_action(
  ctx: &Context<'_>,
  doc_id: Uuid,
  action: myoxus_domain::permission::DocAction,
) -> Result<(Arc<ApiState>, Uuid, Uuid)> {
  let state = ctx
    .data::<Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  let metadata = state
    .doc()
    .get_metadata(doc_id)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?
    .ok_or_else(|| async_graphql::Error::new("document not found"))?;
  let workspace_id = metadata
    .workspace_id
    .ok_or_else(|| async_graphql::Error::new("document not found"))?;
  let external_key = DocumentKey::parse(metadata.external_id)
    .map_err(|error| async_graphql::Error::new(format!("invalid document key: {error}")))?;
  crate::document_access::authorize_workspace_document(
    state,
    snapshot.user.id,
    workspace_id,
    DocSpaceKind::Workspace,
    &external_key,
    action,
  )
  .await
  .map_err(crate::graphql::utils::map_gql_error)?;
  Ok((state.clone(), snapshot.user.id, workspace_id))
}

fn validation_error(message: impl Into<String>, field: &'static str) -> async_graphql::Error {
  let mut err = async_graphql::Error::new(message.into());
  err.extensions = Some({
    let mut ext = async_graphql::ErrorExtensionValues::default();
    ext.set("class", "ValidationError");
    ext.set("field", field);
    ext
  });
  err
}

fn validation_code_error(
  code: DocumentMetadataValidationCode,
  field: &'static str,
  message: &'static str,
) -> async_graphql::Error {
  let mut err = validation_error(message, field);
  if let Some(ext) = err.extensions.as_mut() {
    ext.set("code", code.as_str());
  }
  err
}

fn repo_error(error: RepositoryError) -> async_graphql::Error {
  let class = match error {
    RepositoryError::Conflict(_) => "Conflict",
    RepositoryError::NotFound(_) => "NotFound",
    RepositoryError::Validation(_) => "ValidationError",
    RepositoryError::Storage(_) => "StorageError",
  };
  let mut err = async_graphql::Error::new(error.to_string());
  err.extensions = Some({
    let mut ext = async_graphql::ErrorExtensionValues::default();
    ext.set("class", class);
    ext
  });
  err
}

fn service_error(error: DocumentMetadataPolicyServiceError) -> async_graphql::Error {
  match error {
    DocumentMetadataPolicyServiceError::Repository(error) => repo_error(error),
    DocumentMetadataPolicyServiceError::StatusRequiresTransition => validation_code_error(
      DocumentMetadataValidationCode::DocumentStatusRequiresTransition,
      "statusId",
      "document status must be changed through transitionDocumentStatus",
    ),
    DocumentMetadataPolicyServiceError::TransitionBlocked => validation_code_error(
      DocumentMetadataValidationCode::DocumentStatusTransitionBlocked,
      "statusId",
      "document status transition is blocked",
    ),
    DocumentMetadataPolicyServiceError::VersionCreate(message)
    | DocumentMetadataPolicyServiceError::Metadata(message) => async_graphql::Error::new(message),
  }
}

async fn record_document_metadata_audit(
  ctx: &Context<'_>,
  state: &Arc<ApiState>,
  event_key: &'static str,
  doc_id: Uuid,
  new_value: Option<serde_json::Value>,
) {
  let actor = crate::graphql::admin::resolve_audit_actor(ctx).await;
  state
    .audit_recorder()
    .record(AuditEvent::mutation(
      event_key,
      AuditCategory::DocumentVersion,
      Some(AuditTarget::entity("document", doc_id, None)),
      actor,
      None,
      new_value,
    ))
    .await;
}

async fn record_workspace_settings_audit(
  ctx: &Context<'_>,
  state: &Arc<ApiState>,
  workspace_id: Uuid,
  settings: &DocumentWorkspaceSettings,
) {
  let actor = crate::graphql::admin::resolve_audit_actor(ctx).await;
  state
    .audit_recorder()
    .record(AuditEvent::mutation(
      "document_metadata.workspace_settings.update",
      AuditCategory::DocumentVersion,
      Some(AuditTarget::entity("workspace", workspace_id, None)),
      actor,
      None,
      Some(serde_json::json!({
        "workspaceId": workspace_id.to_string(),
        "statusSchemaId": settings.status_schema_id.map(|id| id.to_string()),
        "defaultStatusId": settings.default_status_id.map(|id| id.to_string()),
        "versionPolicyId": settings.version_policy_id.map(|id| id.to_string()),
      })),
    ))
    .await;
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn metadata_index_projection_keeps_internal_and_external_identity() {
    let doc_id = Uuid::new_v4();
    let projected = DocumentMetadataIndexRowType::from_row(
      DocumentMetadataIndexRow {
        doc_id,
        external_id: "public-document-key".to_string(),
        created_by: None,
        updated_by: None,
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
        status_id: None,
        document_type_id: None,
        current_version_id: None,
        dirty_since_current_version: false,
        review_due_at: None,
        valid_until: None,
        classification_id: None,
      },
      false,
    );

    assert_eq!(projected.doc_id.as_str(), doc_id.to_string());
    assert_eq!(
      projected.external_id.as_ref().map(|id| id.as_str()),
      Some("public-document-key")
    );
  }
}
