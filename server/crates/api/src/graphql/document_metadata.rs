// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native document metadata GraphQL projection backed by the canonical `docs`
//! metadata head.

use async_graphql::{Context, Enum, ID, InputObject, MaybeUndefined, Object, Result, SimpleObject};
use chrono::{DateTime, NaiveDate, Utc};
use uuid::Uuid;

use myoxus_application::auth::AuthError;
use myoxus_application::doc::DocSpaceKind;
use myoxus_application::document_metadata::{
  DocumentMetadataProjectionMode, DocumentMetadataService, DocumentMetadataServiceError,
  DocumentMetadataValidationService,
};
use myoxus_application::document_metadata_policy::DocumentMetadataAction;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{
  DocumentMetadataAudience, DocumentMetadataFieldValue, DocumentMetadataInheritanceMode, DocumentMetadataIntegration,
  DocumentMetadataJournal, DocumentMetadataPatch, DocumentMetadataPolicy, DocumentMetadataPresentation,
  DocumentMetadataProjection, DocumentMetadataReferenceValue, DocumentMetadataSource, DocumentMetadataSystemFacts,
  DocumentMetadataTemplateState, DocumentMetadataValidation, DocumentMetadataValidationIssue,
  DocumentMetadataValidationSeverity,
};

use crate::client_context::ClientContext;
use crate::state::ApiState;

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum DocumentMetadataProjectionModeType {
  #[graphql(name = "MYOXUS_NATIVE")]
  MyoxusNative,
  #[graphql(name = "AFFINE_LEGACY")]
  AffineLegacy,
}

impl From<DocumentMetadataProjectionModeType> for DocumentMetadataProjectionMode {
  fn from(value: DocumentMetadataProjectionModeType) -> Self {
    match value {
      DocumentMetadataProjectionModeType::MyoxusNative => Self::MyoxusNative,
      DocumentMetadataProjectionModeType::AffineLegacy => Self::AffineLegacy,
    }
  }
}

impl From<DocumentMetadataProjectionMode> for DocumentMetadataProjectionModeType {
  fn from(value: DocumentMetadataProjectionMode) -> Self {
    match value {
      DocumentMetadataProjectionMode::MyoxusNative => Self::MyoxusNative,
      DocumentMetadataProjectionMode::AffineLegacy => Self::AffineLegacy,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum DocumentMetadataValidationSeverityType {
  #[graphql(name = "info")]
  Info,
  #[graphql(name = "warning")]
  Warning,
  #[graphql(name = "error")]
  Error,
}

impl From<DocumentMetadataValidationSeverity> for DocumentMetadataValidationSeverityType {
  fn from(value: DocumentMetadataValidationSeverity) -> Self {
    match value {
      DocumentMetadataValidationSeverity::Info => Self::Info,
      DocumentMetadataValidationSeverity::Warning => Self::Warning,
      DocumentMetadataValidationSeverity::Error => Self::Error,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum DocumentMetadataValidationActionType {
  #[graphql(name = "read")]
  Read,
  #[graphql(name = "set_metadata")]
  SetMetadata,
  #[graphql(name = "export_pdf")]
  ExportPdf,
  #[graphql(name = "share_public")]
  SharePublic,
  #[graphql(name = "transition_status")]
  TransitionStatus,
}

impl From<DocumentMetadataValidationActionType> for DocumentMetadataAction {
  fn from(value: DocumentMetadataValidationActionType) -> Self {
    match value {
      DocumentMetadataValidationActionType::Read => Self::Read,
      DocumentMetadataValidationActionType::SetMetadata => Self::SetMetadata,
      DocumentMetadataValidationActionType::ExportPdf => Self::ExportPdf,
      DocumentMetadataValidationActionType::SharePublic => Self::SharePublic,
      DocumentMetadataValidationActionType::TransitionStatus => Self::TransitionStatus,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataValidationIssueType {
  pub code: String,
  pub key: Option<String>,
  pub message: String,
  pub severity: DocumentMetadataValidationSeverityType,
  pub blocked_actions: Vec<String>,
  pub details: serde_json::Value,
}

impl From<DocumentMetadataValidationIssue> for DocumentMetadataValidationIssueType {
  fn from(value: DocumentMetadataValidationIssue) -> Self {
    Self {
      code: value.code.as_str().to_string(),
      key: value.key,
      message: value.message,
      severity: value.severity.into(),
      blocked_actions: value.blocked_actions,
      details: value.details,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataValidationType {
  pub valid: bool,
  pub missing_required_metadata_fields: Vec<String>,
  pub blocked_actions: Vec<String>,
  pub errors: Vec<DocumentMetadataValidationIssueType>,
  pub warnings: Vec<DocumentMetadataValidationIssueType>,
}

impl From<DocumentMetadataValidation> for DocumentMetadataValidationType {
  fn from(value: DocumentMetadataValidation) -> Self {
    Self {
      valid: value.valid(),
      missing_required_metadata_fields: value.missing_required_metadata_fields,
      blocked_actions: value.blocked_actions,
      errors: value.errors.into_iter().map(Into::into).collect(),
      warnings: value.warnings.into_iter().map(Into::into).collect(),
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum DocumentMetadataSourceType {
  #[graphql(name = "DOCUMENT")]
  Document,
  #[graphql(name = "WORKSPACE")]
  Workspace,
  #[graphql(name = "ORGANIZATION")]
  Organization,
  #[graphql(name = "FALLBACK")]
  Fallback,
}

impl From<DocumentMetadataSource> for DocumentMetadataSourceType {
  fn from(value: DocumentMetadataSource) -> Self {
    match value {
      DocumentMetadataSource::Document => Self::Document,
      DocumentMetadataSource::Workspace => Self::Workspace,
      DocumentMetadataSource::Organization => Self::Organization,
      DocumentMetadataSource::Fallback => Self::Fallback,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum DocumentMetadataInheritanceModeType {
  #[graphql(name = "INHERITED")]
  Inherited,
  #[graphql(name = "DOCUMENT_ONLY")]
  DocumentOnly,
  #[graphql(name = "RELATION_INHERITED")]
  RelationInherited,
  #[graphql(name = "SYSTEM_READONLY")]
  SystemReadonly,
  #[graphql(name = "SPECIALIZED_SUBSYSTEM")]
  SpecializedSubsystem,
}

impl From<DocumentMetadataInheritanceMode> for DocumentMetadataInheritanceModeType {
  fn from(value: DocumentMetadataInheritanceMode) -> Self {
    match value {
      DocumentMetadataInheritanceMode::Inherited => Self::Inherited,
      DocumentMetadataInheritanceMode::DocumentOnly => Self::DocumentOnly,
      DocumentMetadataInheritanceMode::RelationInherited => Self::RelationInherited,
      DocumentMetadataInheritanceMode::SystemReadonly => Self::SystemReadonly,
      DocumentMetadataInheritanceMode::SpecializedSubsystem => Self::SpecializedSubsystem,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataReferenceValueType {
  pub id: ID,
  pub key: String,
  pub label: String,
  pub is_active: bool,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataAudienceType {
  pub value: DocumentMetadataReferenceValueType,
  pub source: DocumentMetadataSourceType,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataFieldValueType {
  pub key: String,
  pub source: DocumentMetadataSourceType,
  pub reference: Option<DocumentMetadataReferenceValueType>,
  pub text_value: Option<String>,
  pub timestamp_value: Option<DateTime<Utc>>,
  /// ISO-8601 calendar date (`YYYY-MM-DD`). The domain keeps calendar dates as
  /// `NaiveDate`; GraphQL exposes the portable wire format instead of a
  /// chrono-specific scalar that codegen cannot type safely.
  pub date_value: Option<String>,
  pub user_id: Option<ID>,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataSystemFactsType {
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub created_by: Option<ID>,
  pub updated_by: Option<ID>,
  pub metadata_updated_at: Option<DateTime<Utc>>,
  pub metadata_updated_by: Option<ID>,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataFieldLockType {
  pub key: String,
  pub inheritance_mode: DocumentMetadataInheritanceModeType,
  pub editable: bool,
  pub reason: Option<String>,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataPolicyType {
  pub locks: Vec<DocumentMetadataFieldLockType>,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataTemplateType {
  pub state: String,
  pub origin: Option<String>,
  pub category: Option<String>,
  pub tags: Option<Vec<String>>,
  pub template_id: Option<ID>,
  pub revision_id: Option<ID>,
  pub instance_id: Option<ID>,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataJournalType {
  /// ISO-8601 calendar date (`YYYY-MM-DD`).
  pub journal_date: Option<String>,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataPresentationType {
  pub primary_mode: Option<String>,
  pub page_width: Option<String>,
  pub edgeless_color_theme: Option<String>,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataIntegrationType {
  pub integration_type: Option<String>,
}

#[derive(SimpleObject, Clone)]
pub struct DocumentMetadataType {
  pub doc_id: ID,
  pub workspace_id: ID,
  pub projection_mode: DocumentMetadataProjectionModeType,
  pub projection_version: String,
  pub metadata_revision: i64,
  pub metadata_updated_at: Option<DateTime<Utc>>,
  pub metadata_updated_by: Option<ID>,
  pub system: DocumentMetadataSystemFactsType,
  pub fields: Vec<DocumentMetadataFieldValueType>,
  pub audience: Vec<DocumentMetadataAudienceType>,
  pub template: Option<DocumentMetadataTemplateType>,
  pub journal: DocumentMetadataJournalType,
  pub presentation: Option<DocumentMetadataPresentationType>,
  pub integration: Option<DocumentMetadataIntegrationType>,
  pub policy: DocumentMetadataPolicyType,
  pub legacy: serde_json::Value,
}

#[derive(InputObject, Default)]
pub struct SetDocumentMetadataInput {
  pub expected_metadata_revision: Option<i64>,
  pub document_type_id: MaybeUndefined<Option<ID>>,
  pub classification_id: MaybeUndefined<Option<ID>>,
  pub retention_policy_id: MaybeUndefined<Option<ID>>,
  pub language_id: MaybeUndefined<Option<ID>>,
  pub responsible_user_id: MaybeUndefined<Option<ID>>,
  pub document_number: MaybeUndefined<Option<String>>,
  pub review_due_at: MaybeUndefined<Option<DateTime<Utc>>>,
  pub valid_from: MaybeUndefined<Option<DateTime<Utc>>>,
  pub valid_until: MaybeUndefined<Option<DateTime<Utc>>>,
  pub journal_date: MaybeUndefined<Option<String>>,
  pub audience_ids: MaybeUndefined<Vec<ID>>,
  pub template_state: MaybeUndefined<Option<String>>,
  pub template_origin: MaybeUndefined<Option<String>>,
  pub template_category: MaybeUndefined<Option<String>>,
  pub template_tags: MaybeUndefined<Option<Vec<String>>>,
  pub template_id: MaybeUndefined<Option<ID>>,
  pub template_revision_id: MaybeUndefined<Option<ID>>,
  pub template_instance_id: MaybeUndefined<Option<ID>>,
  pub primary_mode: MaybeUndefined<Option<String>>,
  pub page_width: MaybeUndefined<Option<String>>,
  pub edgeless_color_theme: MaybeUndefined<Option<String>>,
  pub integration_type: MaybeUndefined<Option<String>>,
}

#[derive(SimpleObject, Clone)]
pub struct SetDocumentMetadataPayload {
  pub metadata: DocumentMetadataType,
}

pub struct DocumentMetadataQueryRoot;

#[Object]
impl DocumentMetadataQueryRoot {
  pub async fn document_metadata(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    requested_projection_mode: Option<DocumentMetadataProjectionModeType>,
  ) -> Result<DocumentMetadataType> {
    let doc_id = resolve_doc_id(ctx, &workspace_id, &doc_id).await?;
    let (service, _actor_id, workspace_id) = require_doc_read(ctx, doc_id).await?;
    let projection_mode = resolve_projection_mode(ctx, requested_projection_mode)?;
    let projection = service
      .get_projection(doc_id, workspace_id, projection_mode)
      .await
      .map_err(service_error)?;
    Ok(map_metadata_projection(projection, projection_mode))
  }

  pub async fn document_metadata_validation(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    action: Option<DocumentMetadataValidationActionType>,
  ) -> Result<DocumentMetadataValidationType> {
    let doc_id = resolve_doc_id(ctx, &workspace_id, &doc_id).await?;
    let _projection_mode = resolve_projection_mode(ctx, Some(DocumentMetadataProjectionModeType::MyoxusNative))?;
    let (service, _actor_id, workspace_id) = require_doc_read(ctx, doc_id).await?;
    let state = ctx
      .data::<std::sync::Arc<ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let repo = state
      .document_metadata_policy_repo()
      .ok_or_else(|| async_graphql::Error::new("document metadata validation repository is not configured"))?;
    let definitions = repo
      .list_metadata_field_definitions()
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    let projection = service
      .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
      .await
      .map_err(service_error)?;
    let validation = DocumentMetadataValidationService::new().validate(
      &definitions,
      &projection,
      action.unwrap_or(DocumentMetadataValidationActionType::Read).into(),
    );
    Ok(validation.into())
  }
}

pub struct DocumentMetadataMutationRoot;

#[Object]
impl DocumentMetadataMutationRoot {
  pub async fn set_document_metadata(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
    doc_id: ID,
    input: SetDocumentMetadataInput,
  ) -> Result<SetDocumentMetadataPayload> {
    let doc_id = resolve_doc_id(ctx, &workspace_id, &doc_id).await?;
    let (service, actor_id, workspace_id) = require_doc_update(ctx, doc_id).await?;
    let projection_mode = resolve_projection_mode(ctx, Some(DocumentMetadataProjectionModeType::MyoxusNative))?;
    service
      .set_metadata(doc_id, actor_id, parse_patch(input)?)
      .await
      .map_err(service_error)?;
    let projection = service
      .get_projection(doc_id, workspace_id, projection_mode)
      .await
      .map_err(service_error)?;
    Ok(SetDocumentMetadataPayload {
      metadata: map_metadata_projection(projection, projection_mode),
    })
  }
}

async fn resolve_doc_id(ctx: &Context<'_>, workspace_id: &ID, doc_id: &ID) -> Result<Uuid> {
  let workspace_id =
    Uuid::parse_str(workspace_id.as_str()).map_err(|_| validation_error("invalid workspaceId", "workspaceId"))?;
  let state = ctx
    .data::<std::sync::Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  crate::graphql::utils::resolve_doc_id(state, workspace_id, doc_id.as_str()).await
}

fn parse_optional_uuid(value: MaybeUndefined<Option<ID>>, field: &'static str) -> Result<Option<Option<Uuid>>> {
  match value {
    MaybeUndefined::Undefined => Ok(None),
    MaybeUndefined::Null => Ok(Some(None)),
    MaybeUndefined::Value(None) => Ok(Some(None)),
    MaybeUndefined::Value(Some(id)) => Uuid::parse_str(id.as_str())
      .map(Some)
      .map(Some)
      .map_err(|_| validation_error(format!("invalid {field}"), field)),
  }
}

fn parse_audience_ids(value: MaybeUndefined<Vec<ID>>) -> Result<Option<Vec<Uuid>>> {
  match value {
    MaybeUndefined::Undefined | MaybeUndefined::Null => Ok(None),
    MaybeUndefined::Value(ids) => ids
      .iter()
      .map(|id| Uuid::parse_str(id.as_str()).map_err(|_| validation_error("invalid audienceIds", "audienceIds")))
      .collect::<Result<Vec<_>>>()
      .map(Some),
  }
}

fn parse_patch(input: SetDocumentMetadataInput) -> Result<DocumentMetadataPatch> {
  Ok(DocumentMetadataPatch {
    expected_metadata_revision: input.expected_metadata_revision,
    document_type_id: parse_optional_uuid(input.document_type_id, "documentTypeId")?,
    classification_id: parse_optional_uuid(input.classification_id, "classificationId")?,
    retention_policy_id: parse_optional_uuid(input.retention_policy_id, "retentionPolicyId")?,
    language_id: parse_optional_uuid(input.language_id, "languageId")?,
    responsible_user_id: parse_optional_uuid(input.responsible_user_id, "responsibleUserId")?,
    document_number: maybe_string(input.document_number),
    review_due_at: maybe_datetime(input.review_due_at),
    valid_from: maybe_datetime(input.valid_from),
    valid_until: maybe_datetime(input.valid_until),
    journal_date: maybe_date(input.journal_date)?,
    audience_ids: parse_audience_ids(input.audience_ids)?,
    template_state: maybe_string(input.template_state),
    template_origin: parse_template_origin(input.template_origin)?,
    template_category: maybe_string(input.template_category),
    template_tags: match input.template_tags {
      MaybeUndefined::Value(value) => Some(value),
      MaybeUndefined::Null => Some(None),
      MaybeUndefined::Undefined => None,
    },
    template_id: parse_optional_uuid(input.template_id, "templateId")?,
    template_revision_id: parse_optional_uuid(input.template_revision_id, "templateRevisionId")?,
    template_instance_id: parse_optional_uuid(input.template_instance_id, "templateInstanceId")?,
    primary_mode: maybe_string(input.primary_mode),
    page_width: maybe_string(input.page_width),
    edgeless_color_theme: maybe_string(input.edgeless_color_theme),
    integration_type: maybe_string(input.integration_type),
  })
}

fn maybe_string(value: MaybeUndefined<Option<String>>) -> Option<Option<String>> {
  match value {
    MaybeUndefined::Value(value) => Some(value),
    MaybeUndefined::Null => Some(None),
    MaybeUndefined::Undefined => None,
  }
}

fn parse_template_origin(value: MaybeUndefined<Option<String>>) -> Result<Option<Option<String>>> {
  let value = maybe_string(value);
  if let Some(Some(origin)) = value.as_ref()
    && origin != "custom"
  {
    return Err(validation_error("invalid templateOrigin", "templateOrigin"));
  }
  Ok(value)
}

fn maybe_datetime(value: MaybeUndefined<Option<DateTime<Utc>>>) -> Option<Option<DateTime<Utc>>> {
  match value {
    MaybeUndefined::Value(value) => Some(value),
    MaybeUndefined::Null => Some(None),
    MaybeUndefined::Undefined => None,
  }
}

fn maybe_date(value: MaybeUndefined<Option<String>>) -> Result<Option<Option<NaiveDate>>> {
  match value {
    MaybeUndefined::Value(Some(value)) => NaiveDate::parse_from_str(&value, "%Y-%m-%d")
      .map(|date| Some(Some(date)))
      .map_err(|_| validation_error("journalDate must use YYYY-MM-DD", "journalDate")),
    MaybeUndefined::Value(None) | MaybeUndefined::Null => Ok(Some(None)),
    MaybeUndefined::Undefined => Ok(None),
  }
}

fn resolve_projection_mode(
  ctx: &Context<'_>,
  requested: Option<DocumentMetadataProjectionModeType>,
) -> Result<DocumentMetadataProjectionMode> {
  let client_context = ctx
    .data::<ClientContext>()
    .map_err(|_| async_graphql::Error::new("missing client context"))?;
  DocumentMetadataService::resolve_projection_mode(client_context.format, requested.map(Into::into))
    .map_err(service_error)
}

async fn require_doc_read(ctx: &Context<'_>, doc_id: Uuid) -> Result<(DocumentMetadataService, Uuid, Uuid)> {
  let state = ctx
    .data::<std::sync::Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let service = require_document_metadata_service(state)?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_id = authorize_document_for_metadata(
    state,
    snapshot.user.id,
    doc_id,
    myoxus_domain::permission::DocAction::Read,
  )
  .await?;
  Ok((service, snapshot.user.id, workspace_id))
}

async fn require_doc_update(ctx: &Context<'_>, doc_id: Uuid) -> Result<(DocumentMetadataService, Uuid, Uuid)> {
  let state = ctx
    .data::<std::sync::Arc<ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let service = require_document_metadata_service(state)?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_id = authorize_document_for_metadata(
    state,
    snapshot.user.id,
    doc_id,
    myoxus_domain::permission::DocAction::Update,
  )
  .await?;
  Ok((service, snapshot.user.id, workspace_id))
}

async fn authorize_document_for_metadata(
  state: &ApiState,
  user_id: Uuid,
  doc_id: Uuid,
  action: myoxus_domain::permission::DocAction,
) -> Result<Uuid> {
  let metadata = state
    .doc()
    .get_metadata(doc_id)
    .await
    .map_err(metadata_permission_error)?
    .ok_or_else(|| async_graphql::Error::new("document not found"))?;
  let workspace_id = metadata
    .workspace_id
    .ok_or_else(|| async_graphql::Error::new("document not found"))?;
  let document_key = DocumentKey::parse(metadata.external_id)
    .map_err(|error| async_graphql::Error::new(format!("invalid document key: {error}")))?;
  crate::document_access::authorize_workspace_document(
    state,
    user_id,
    workspace_id,
    DocSpaceKind::Workspace,
    &document_key,
    action,
  )
  .await
  .map_err(metadata_permission_error)?;
  Ok(workspace_id)
}

fn require_document_metadata_service(state: &ApiState) -> Result<DocumentMetadataService> {
  state
    .document_metadata_service()
    .ok_or_else(|| async_graphql::Error::new("document metadata service is not configured on this server"))
}

pub(super) fn map_metadata_projection(
  projection: DocumentMetadataProjection,
  projection_mode: DocumentMetadataProjectionMode,
) -> DocumentMetadataType {
  DocumentMetadataType {
    doc_id: ID::from(projection.doc_id.to_string()),
    workspace_id: ID::from(projection.workspace_id.to_string()),
    projection_mode: projection_mode.into(),
    projection_version: projection.projection_version,
    metadata_revision: projection.metadata_revision,
    metadata_updated_at: projection.metadata_updated_at,
    metadata_updated_by: projection.metadata_updated_by.map(uuid_id),
    system: map_system(projection.system),
    fields: projection.fields.into_iter().map(map_field_value).collect(),
    audience: projection.audience.into_iter().map(map_audience).collect(),
    template: projection.template.map(map_template),
    journal: map_journal(projection.journal),
    presentation: projection.presentation.map(map_presentation),
    integration: projection.integration.map(map_integration),
    policy: map_policy(projection.policy),
    legacy: legacy_projection(projection.doc_id, projection_mode),
  }
}

fn map_reference(value: DocumentMetadataReferenceValue) -> DocumentMetadataReferenceValueType {
  DocumentMetadataReferenceValueType {
    id: uuid_id(value.id),
    key: value.key,
    label: value.label,
    is_active: value.is_active,
  }
}

fn map_field_value(value: DocumentMetadataFieldValue) -> DocumentMetadataFieldValueType {
  DocumentMetadataFieldValueType {
    key: value.key,
    source: value.source.into(),
    reference: value.reference.map(map_reference),
    text_value: value.text_value,
    timestamp_value: value.timestamp_value,
    date_value: value.date_value.map(|date| date.to_string()),
    user_id: value.user_id.map(uuid_id),
  }
}

fn map_audience(value: DocumentMetadataAudience) -> DocumentMetadataAudienceType {
  DocumentMetadataAudienceType {
    value: map_reference(value.value),
    source: value.source.into(),
  }
}

fn map_system(value: DocumentMetadataSystemFacts) -> DocumentMetadataSystemFactsType {
  DocumentMetadataSystemFactsType {
    created_at: value.created_at,
    updated_at: value.updated_at,
    created_by: value.created_by.map(uuid_id),
    updated_by: value.updated_by.map(uuid_id),
    metadata_updated_at: value.metadata_updated_at,
    metadata_updated_by: value.metadata_updated_by.map(uuid_id),
  }
}

fn map_template(value: DocumentMetadataTemplateState) -> DocumentMetadataTemplateType {
  DocumentMetadataTemplateType {
    state: value.state,
    origin: value.origin,
    category: value.category,
    tags: value.tags,
    template_id: value.template_id.map(uuid_id),
    revision_id: value.revision_id.map(uuid_id),
    instance_id: value.instance_id.map(uuid_id),
  }
}

fn map_journal(value: DocumentMetadataJournal) -> DocumentMetadataJournalType {
  DocumentMetadataJournalType {
    journal_date: value.journal_date.map(|date| date.to_string()),
  }
}

fn map_presentation(value: DocumentMetadataPresentation) -> DocumentMetadataPresentationType {
  DocumentMetadataPresentationType {
    primary_mode: value.primary_mode,
    page_width: value.page_width,
    edgeless_color_theme: value.edgeless_color_theme,
  }
}

fn map_integration(value: DocumentMetadataIntegration) -> DocumentMetadataIntegrationType {
  DocumentMetadataIntegrationType {
    integration_type: value.integration_type,
  }
}

fn map_policy(value: DocumentMetadataPolicy) -> DocumentMetadataPolicyType {
  DocumentMetadataPolicyType {
    locks: value
      .locks
      .into_iter()
      .map(|lock| DocumentMetadataFieldLockType {
        key: lock.key,
        inheritance_mode: lock.inheritance_mode.into(),
        editable: lock.editable,
        reason: lock.reason,
      })
      .collect(),
  }
}

fn uuid_id(id: Uuid) -> ID {
  ID::from(id.to_string())
}

fn legacy_projection(doc_id: Uuid, mode: DocumentMetadataProjectionMode) -> serde_json::Value {
  match mode {
    DocumentMetadataProjectionMode::AffineLegacy => serde_json::json!({
      "docId": doc_id.to_string(),
      "projection": "legacy-safe",
    }),
    DocumentMetadataProjectionMode::MyoxusNative => serde_json::json!({}),
  }
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

fn coded_validation_error(message: impl Into<String>, field: &'static str, code: &'static str) -> async_graphql::Error {
  let mut err = validation_error(message, field);
  err.extensions.get_or_insert_default().set("code", code);
  err
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DocumentMetadataErrorCode {
  FieldUnknown,
  FieldLocked,
  FieldDisabled,
  SystemFieldReadOnly,
  StatusRequiresTransition,
  ReferenceNotFound,
  RevisionConflict,
  InvalidSourceReset,
  ProjectionNotAllowed,
  PermissionDenied,
  ResponsibleInvalid,
}

impl DocumentMetadataErrorCode {
  fn as_str(self) -> &'static str {
    match self {
      Self::FieldUnknown => "DOCUMENT_METADATA_FIELD_UNKNOWN",
      Self::FieldLocked => "DOCUMENT_METADATA_FIELD_LOCKED",
      Self::FieldDisabled => "DOCUMENT_METADATA_FIELD_DISABLED",
      Self::SystemFieldReadOnly => "DOCUMENT_METADATA_SYSTEM_FIELD_READ_ONLY",
      Self::StatusRequiresTransition => "DOCUMENT_METADATA_STATUS_REQUIRES_TRANSITION",
      Self::ReferenceNotFound => "DOCUMENT_METADATA_REFERENCE_NOT_FOUND",
      Self::RevisionConflict => "DOCUMENT_METADATA_REVISION_CONFLICT",
      Self::InvalidSourceReset => "DOCUMENT_METADATA_INVALID_SOURCE_RESET",
      Self::ProjectionNotAllowed => "DOCUMENT_METADATA_PROJECTION_NOT_ALLOWED",
      Self::PermissionDenied => "DOCUMENT_METADATA_PERMISSION_DENIED",
      Self::ResponsibleInvalid => "DOCUMENT_METADATA_RESPONSIBLE_INVALID",
    }
  }
}

fn metadata_validation_error(
  message: impl Into<String>,
  field: &'static str,
  code: DocumentMetadataErrorCode,
) -> async_graphql::Error {
  coded_validation_error(message, field, code.as_str())
}

fn service_error(error: DocumentMetadataServiceError) -> async_graphql::Error {
  match error {
    DocumentMetadataServiceError::ProjectionNotAllowed => projection_not_allowed_error(),
    DocumentMetadataServiceError::NotFound => async_graphql::Error::new("document not found"),
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Validation(message))
      if message == "document metadata reference not found" =>
    {
      metadata_validation_error(
        message,
        "documentMetadata",
        DocumentMetadataErrorCode::ReferenceNotFound,
      )
    }
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Validation(message))
      if message.starts_with("document metadata system field read only:") =>
    {
      metadata_validation_error(
        message,
        "documentMetadata",
        DocumentMetadataErrorCode::SystemFieldReadOnly,
      )
    }
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Validation(message))
      if message.starts_with("document metadata status requires transition:") =>
    {
      metadata_validation_error(
        message,
        "documentMetadata",
        DocumentMetadataErrorCode::StatusRequiresTransition,
      )
    }
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Validation(message))
      if message.starts_with("document metadata field locked:")
        || message.starts_with("document metadata field locked for actor:") =>
    {
      metadata_validation_error(message, "documentMetadata", DocumentMetadataErrorCode::FieldLocked)
    }
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Validation(message))
      if message.starts_with("document metadata field disabled by organization policy:") =>
    {
      metadata_validation_error(message, "documentMetadata", DocumentMetadataErrorCode::FieldDisabled)
    }
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Validation(message))
      if message.starts_with("document metadata field unknown:") =>
    {
      metadata_validation_error(message, "documentMetadata", DocumentMetadataErrorCode::FieldUnknown)
    }
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Validation(message))
      if message.starts_with("document metadata invalid source reset:") =>
    {
      metadata_validation_error(
        message,
        "documentMetadata",
        DocumentMetadataErrorCode::InvalidSourceReset,
      )
    }
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Validation(message))
      if message == "document metadata responsible user invalid" =>
    {
      metadata_validation_error(
        message,
        "documentMetadata",
        DocumentMetadataErrorCode::ResponsibleInvalid,
      )
    }
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Validation(message)) => {
      validation_error(message, "documentMetadata")
    }
    DocumentMetadataServiceError::Repository(myoxus_domain::repositories::RepositoryError::Conflict(message)) => {
      let mut err = async_graphql::Error::new(message);
      err.extensions = Some({
        let mut ext = async_graphql::ErrorExtensionValues::default();
        ext.set("code", DocumentMetadataErrorCode::RevisionConflict.as_str());
        ext.set("class", "ConflictError");
        ext
      });
      err
    }
    DocumentMetadataServiceError::Repository(error) => async_graphql::Error::new(error.to_string()),
  }
}

fn metadata_permission_error(error: AuthError) -> async_graphql::Error {
  match error {
    AuthError::ActionForbidden => {
      let mut err = async_graphql::Error::new("document metadata permission denied");
      err.extensions = Some({
        let mut ext = async_graphql::ErrorExtensionValues::default();
        ext.set("code", DocumentMetadataErrorCode::PermissionDenied.as_str());
        ext.set("class", "ForbiddenError");
        ext
      });
      err
    }
    other => crate::graphql::utils::map_gql_error(other),
  }
}

fn projection_not_allowed_error() -> async_graphql::Error {
  let mut err = async_graphql::Error::new("requested document metadata projection is not allowed for this client");
  err.extensions = Some({
    let mut ext = async_graphql::ErrorExtensionValues::default();
    ext.set("code", DocumentMetadataErrorCode::ProjectionNotAllowed.as_str());
    ext.set("class", "ValidationError");
    ext
  });
  err
}
