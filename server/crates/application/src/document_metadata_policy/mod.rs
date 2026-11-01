// SPDX-License-Identifier: AGPL-3.0-or-later
//! Application services for canonical document metadata.
//!
//! GraphQL, CLI, MCP and PDF export must call these services instead of
//! reimplementing required-field, status-transition or export-blocking logic.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use chrono::Utc;
use moka::future::Cache;
use thiserror::Error;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use myoxus_domain::entities::{
  DocumentMetadataFieldDefinition, DocumentMetadataIndexRow, DocumentMetadataState, DocumentMetadataValidation,
  DocumentMetadataValidationCode, DocumentMetadataValidationIssue, DocumentMetadataValidationSeverity,
  DocumentMetadataValueDefinition, DocumentStatusSchema, DocumentStatusTransition, DocumentStatusValue,
  DocumentTypeDefinition, DocumentVersion, DocumentVersionEvent, DocumentVersionKind,
};
use myoxus_domain::repositories::{DocumentMetadataPolicyRepository, DocumentVersionRepository, RepositoryError};

use crate::doc::DocCachePort;
use crate::document_metadata::DocumentMetadataService;
use crate::document_version::{DocumentVersionCreateRequest, DocumentVersionCreateService, DocumentVersionHistoryPort};

#[derive(Debug, Error)]
pub enum DocumentMetadataPolicyServiceError {
  #[error(transparent)]
  Repository(#[from] RepositoryError),
  #[error("document status must be changed through transitionDocumentStatus")]
  StatusRequiresTransition,
  #[error("status transition is not allowed")]
  TransitionBlocked,
  #[error("document version create failure: {0}")]
  VersionCreate(String),
  #[error("document metadata update failure: {0}")]
  Metadata(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentMetadataAction {
  Read,
  SetMetadata,
  ExportPdf,
  SharePublic,
  TransitionStatus,
}

impl DocumentMetadataAction {
  pub fn as_blocked_action(&self) -> &'static str {
    match self {
      Self::Read => "read",
      Self::SetMetadata => "set_metadata",
      Self::ExportPdf => "export_pdf",
      Self::SharePublic => "share_public",
      Self::TransitionStatus => "transition_status",
    }
  }
}

#[derive(Debug, Clone)]
pub struct DocumentMetadataEffectivePolicy {
  pub definitions: Vec<DocumentMetadataFieldDefinition>,
  pub value_definitions: BTreeMap<String, Vec<DocumentMetadataValueDefinition>>,
  pub status_schemas: Vec<DocumentStatusSchema>,
  pub active_status_schema: Option<DocumentStatusSchema>,
  pub status_values: Vec<DocumentStatusValue>,
  pub document_types: Vec<DocumentTypeDefinition>,
  pub workspace_settings: Option<myoxus_domain::entities::DocumentWorkspaceSettings>,
  pub state: Option<DocumentMetadataState>,
}

#[derive(Clone)]
pub struct DocumentMetadataPolicyService {
  repo: Arc<dyn DocumentMetadataPolicyRepository>,
  index_cache: Option<Arc<dyn DocCachePort>>,
  index_loads: Cache<(Uuid, String), Vec<DocumentMetadataIndexRow>>,
}

#[derive(Debug, Error)]
enum MetadataIndexLoadError {
  #[error("document metadata index changed while loading")]
  Stale,
  #[error(transparent)]
  Repository(RepositoryError),
}

fn clone_repository_error(error: &RepositoryError) -> RepositoryError {
  match error {
    RepositoryError::NotFound(entity) => RepositoryError::NotFound(entity),
    RepositoryError::Conflict(message) => RepositoryError::Conflict(message),
    RepositoryError::Validation(message) => RepositoryError::Validation(message.clone()),
    RepositoryError::Storage(message) => RepositoryError::Storage(message.clone()),
  }
}

impl DocumentMetadataPolicyService {
  pub fn new(repo: Arc<dyn DocumentMetadataPolicyRepository>) -> Self {
    Self {
      repo,
      index_cache: None,
      index_loads: Cache::builder().max_capacity(1_000).build(),
    }
  }

  /// Use the same native defaults as the eventual insert; a prepared projection
  /// must not invent empty metadata and require a corrective Git-only commit.
  pub async fn initial_metadata_index(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_id: Uuid,
  ) -> Result<DocumentMetadataIndexRow, DocumentMetadataPolicyServiceError> {
    Ok(self.repo.initial_metadata_index(workspace_id, doc_id, actor_id).await?)
  }

  pub fn with_index_cache(mut self, cache: Arc<dyn DocCachePort>) -> Self {
    self.index_cache = Some(cache);
    self
  }

  pub async fn field_definitions(
    &self,
  ) -> Result<Vec<DocumentMetadataFieldDefinition>, DocumentMetadataPolicyServiceError> {
    Ok(self.repo.list_metadata_field_definitions().await?)
  }

  /// Join labels for already admitted rows without loading document bodies or
  /// hydrating an editor model for each register cell.
  #[instrument(skip_all)]
  pub async fn metadata_index_labels(
    &self,
    rows: &[DocumentMetadataIndexRow],
  ) -> Result<BTreeMap<Uuid, myoxus_domain::entities::DocumentMetadataIndexLabels>, DocumentMetadataPolicyServiceError>
  {
    Ok(self.repo.metadata_index_labels(rows).await?)
  }

  /// Load actor-independent list facts; callers must apply current authorization.
  #[instrument(skip(self), fields(%workspace_id), err)]
  pub async fn list_metadata_index(
    &self,
    workspace_id: Uuid,
  ) -> Result<Vec<DocumentMetadataIndexRow>, DocumentMetadataPolicyServiceError> {
    for _ in 0..3 {
      let requested_version = self.repo.metadata_index_version(workspace_id).await?;
      let repo = self.repo.clone();
      let cache = self.index_cache.clone();
      let load_version = requested_version.clone();
      let result: Result<Vec<DocumentMetadataIndexRow>, Arc<MetadataIndexLoadError>> = self
        .index_loads
        .try_get_with((workspace_id, requested_version.clone()), async move {
          if let Some(cache) = &cache
            && let Some(rows) = cache.get_document_metadata_index(workspace_id, &load_version).await
          {
            return Ok(rows);
          }
          let snapshot = repo
            .list_metadata_index_versioned(workspace_id)
            .await
            .map_err(MetadataIndexLoadError::Repository)?;
          if snapshot.version != load_version {
            return Err(MetadataIndexLoadError::Stale);
          }
          if let Some(cache) = &cache {
            cache
              .set_document_metadata_index(workspace_id, &snapshot.version, &snapshot.rows)
              .await;
          }
          Ok(snapshot.rows)
        })
        .await;
      let rows = match result {
        Ok(rows) => rows,
        Err(error) => match error.as_ref() {
          MetadataIndexLoadError::Stale => continue,
          MetadataIndexLoadError::Repository(error) => {
            return Err(DocumentMetadataPolicyServiceError::Repository(clone_repository_error(
              error,
            )));
          }
        },
      };
      if self.repo.metadata_index_version(workspace_id).await? == requested_version {
        return Ok(rows);
      }
    }
    Ok(self.repo.list_metadata_index_versioned(workspace_id).await?.rows)
  }

  /// Resolve an active target status within the source status's schema.
  ///
  /// Transports may accept either the stable UUID or key, but schema ownership
  /// remains a policy concern and must not be reconstructed with transport SQL.
  pub async fn resolve_status_in_schema(
    &self,
    from_status_id: Uuid,
    target: &str,
  ) -> Result<Option<Uuid>, DocumentMetadataPolicyServiceError> {
    let requested_id = Uuid::parse_str(target).ok();
    for schema in self.repo.list_status_schemas().await? {
      let values = self.repo.list_status_values(&schema.key).await?;
      if values.iter().any(|value| value.id == from_status_id) {
        return Ok(
          values
            .iter()
            .find(|value| value.is_active && (Some(value.id) == requested_id || value.key == target))
            .map(|value| value.id),
        );
      }
    }
    Ok(None)
  }

  #[instrument(skip(self), err)]
  pub async fn load_policy(
    &self,
    doc_id: Uuid,
    workspace_id: Uuid,
  ) -> Result<DocumentMetadataEffectivePolicy, DocumentMetadataPolicyServiceError> {
    let workspace_settings = self.repo.get_workspace_settings(workspace_id).await?;
    let definitions = self.repo.list_metadata_field_definitions().await?;

    let mut value_definitions = BTreeMap::new();
    for key in ["classification", "audience", "retentionPolicy", "language"] {
      value_definitions.insert(
        key.to_string(),
        self
          .repo
          .list_metadata_value_definitions(key)
          .await?
          .into_iter()
          .filter(|value| value.is_active)
          .collect(),
      );
    }

    let status_schemas: Vec<_> = self
      .repo
      .list_status_schemas()
      .await?
      .into_iter()
      .filter(|schema| schema.is_active)
      .collect();
    let active_status_schema = select_status_schema(&status_schemas, workspace_settings.as_ref());
    let status_values = if let Some(schema) = &active_status_schema {
      self
        .repo
        .list_status_values(&schema.key)
        .await?
        .into_iter()
        .filter(|value| value.is_active)
        .collect()
    } else {
      Vec::new()
    };
    let document_types: Vec<_> = self
      .repo
      .list_document_types()
      .await?
      .into_iter()
      .filter(|doc_type| doc_type.is_active)
      .collect();
    let state = self.repo.get_metadata_state(doc_id).await?.map_or_else(
      || {
        Some(default_state_from_workspace(
          doc_id,
          workspace_settings.as_ref(),
          &status_values,
        ))
      },
      |mut state| {
        // Status is transition-only. Normal attribute patches may create the
        // row before a status was persisted, so the effective default status
        // must still apply without letting clients write `statusId` directly.
        if state.status_id.is_none() {
          state.status_id = default_status_from_workspace(&status_values);
        }
        Some(state)
      },
    );

    info!(
      %doc_id,
      %workspace_id,
      definitions = definitions.len(),
      status_values = status_values.len(),
      document_types = document_types.len(),
      "document metadata effective policy loaded"
    );
    Ok(DocumentMetadataEffectivePolicy {
      definitions,
      value_definitions,
      status_schemas,
      active_status_schema,
      status_values,
      document_types,
      workspace_settings,
      state,
    })
  }
}

#[derive(Clone, Default)]
pub struct DocumentMetadataValidationService;

impl DocumentMetadataValidationService {
  pub fn new() -> Self {
    Self
  }

  pub fn validate(
    &self,
    definitions: &[DocumentMetadataFieldDefinition],
    state: Option<&DocumentMetadataState>,
    action: DocumentMetadataAction,
  ) -> DocumentMetadataValidation {
    let mut validation = DocumentMetadataValidation::default();
    let now = Utc::now();

    for definition in definitions.iter().filter(|definition| definition.enabled) {
      if self.is_required(definition, state) && self.is_missing(definition.key.as_str(), state) {
        let issue = issue(
          DocumentMetadataValidationCode::DocumentMetadataRequired,
          Some(definition.key.clone()),
          format!("Document metadata '{}' is required", definition.key),
          DocumentMetadataValidationSeverity::Error,
          vec![
            DocumentMetadataAction::ExportPdf.as_blocked_action().to_string(),
            DocumentMetadataAction::TransitionStatus.as_blocked_action().to_string(),
          ],
        );
        validation.missing_required_metadata_fields.push(definition.key.clone());
        validation.blocked_actions.extend(issue.blocked_actions.clone());
        validation.errors.push(issue);
      }

      if definition.export_mode == "required"
        && action == DocumentMetadataAction::ExportPdf
        && self.is_missing(definition.key.as_str(), state)
      {
        let issue = issue(
          DocumentMetadataValidationCode::DocumentExportBlocked,
          Some(definition.key.clone()),
          format!("{} is required for export", definition.label),
          DocumentMetadataValidationSeverity::Error,
          vec![DocumentMetadataAction::ExportPdf.as_blocked_action().to_string()],
        );
        validation.blocked_actions.extend(issue.blocked_actions.clone());
        validation.errors.push(issue);
      }
    }

    if let Some(state) = state {
      if state.valid_until.is_some_and(|valid_until| valid_until < now) {
        let severity = if action == DocumentMetadataAction::ExportPdf {
          DocumentMetadataValidationSeverity::Error
        } else {
          DocumentMetadataValidationSeverity::Warning
        };
        let blocked = if severity == DocumentMetadataValidationSeverity::Error {
          vec![DocumentMetadataAction::ExportPdf.as_blocked_action().to_string()]
        } else {
          Vec::new()
        };
        let issue = issue(
          DocumentMetadataValidationCode::DocumentValidityExpired,
          Some("validUntil".to_string()),
          "Document validity has expired".to_string(),
          severity,
          blocked,
        );
        validation.blocked_actions.extend(issue.blocked_actions.clone());
        match severity {
          DocumentMetadataValidationSeverity::Error => validation.errors.push(issue),
          _ => validation.warnings.push(issue),
        }
      }

      if action == DocumentMetadataAction::SharePublic && classification_is_restricted(state) {
        let issue = issue(
          DocumentMetadataValidationCode::DocumentClassificationBlocksShare,
          Some("classification".to_string()),
          "Restricted documents cannot be shared publicly".to_string(),
          DocumentMetadataValidationSeverity::Error,
          vec![DocumentMetadataAction::SharePublic.as_blocked_action().to_string()],
        );
        validation.blocked_actions.extend(issue.blocked_actions.clone());
        validation.errors.push(issue);
      }
    }

    validation.blocked_actions = dedupe(validation.blocked_actions);
    validation
  }

  fn is_required(&self, definition: &DocumentMetadataFieldDefinition, state: Option<&DocumentMetadataState>) -> bool {
    match definition.required_mode.as_str() {
      "always" => true,
      "by_status" => {
        state.and_then(|state| state.status_id).is_some()
          && definition
            .validation_config
            .get("requiredWhenStatusSet")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
      }
      "by_type" => {
        state.and_then(|state| state.type_id).is_some()
          && definition
            .validation_config
            .get("requiredWhenTypeSet")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
      }
      "by_status_and_type" => {
        state.and_then(|state| state.status_id).is_some()
          && state.and_then(|state| state.type_id).is_some()
          && definition
            .validation_config
            .get("requiredWhenStatusAndTypeSet")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
      }
      _ => false,
    }
  }

  fn is_missing(&self, key: &str, state: Option<&DocumentMetadataState>) -> bool {
    let Some(state) = state else {
      return true;
    };
    match key {
      "status" => state.status_id.is_none(),
      "documentType" => state.type_id.is_none(),
      "version" => state.current_version_id.is_none(),
      "responsible" => state.responsible_principals.as_array().is_none_or(Vec::is_empty),
      "reviewDueAt" => state.review_due_at.is_none(),
      "validFrom" => state.valid_from.is_none(),
      "validUntil" => state.valid_until.is_none(),
      "classification" => state.classification_id.is_none(),
      "documentNumber" => state.document_number.as_deref().is_none_or(str::is_empty),
      "language" => state.language.as_deref().is_none_or(str::is_empty),
      "audience" => state.audience_ids.is_empty(),
      "retentionPolicy" => state.retention_policy_id.is_none(),
      _ => true,
    }
  }
}

#[derive(Clone)]
struct TransitionVersioning {
  create_service: DocumentVersionCreateService,
}

#[derive(Clone)]
pub struct DocumentStatusTransitionService {
  repo: Arc<dyn DocumentMetadataPolicyRepository>,
  validation_service: DocumentMetadataValidationService,
  metadata_service: DocumentMetadataService,
  versioning: Option<TransitionVersioning>,
}

#[derive(Debug, Clone)]
pub struct DocumentStatusTransitionRequest {
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub from_status_id: Uuid,
  pub to_status_id: Uuid,
  pub actor_id: Option<Uuid>,
  pub actor_roles: Vec<String>,
  pub create_version: bool,
}

impl DocumentStatusTransitionService {
  pub fn new(repo: Arc<dyn DocumentMetadataPolicyRepository>, metadata_service: DocumentMetadataService) -> Self {
    Self {
      repo,
      validation_service: DocumentMetadataValidationService::new(),
      metadata_service,
      versioning: None,
    }
  }

  pub fn with_versioning(
    repo: Arc<dyn DocumentMetadataPolicyRepository>,
    history: Arc<dyn DocumentVersionHistoryPort>,
    version_repo: Arc<dyn DocumentVersionRepository>,
    metadata_service: DocumentMetadataService,
  ) -> Self {
    Self {
      repo,
      validation_service: DocumentMetadataValidationService::new(),
      metadata_service,
      versioning: Some(TransitionVersioning {
        create_service: DocumentVersionCreateService::new(history, version_repo),
      }),
    }
  }

  #[instrument(skip(self), err)]
  pub async fn transition(
    &self,
    doc_id: Uuid,
    from_status_id: Uuid,
    to_status_id: Uuid,
    actor_id: Option<Uuid>,
  ) -> Result<DocumentMetadataValidation, DocumentMetadataPolicyServiceError> {
    self
      .transition_with_roles(doc_id, from_status_id, to_status_id, actor_id, &[])
      .await
  }

  #[instrument(skip(self, actor_roles), err)]
  pub async fn transition_with_roles(
    &self,
    doc_id: Uuid,
    from_status_id: Uuid,
    to_status_id: Uuid,
    actor_id: Option<Uuid>,
    actor_roles: &[String],
  ) -> Result<DocumentMetadataValidation, DocumentMetadataPolicyServiceError> {
    self
      .transition_with_request(DocumentStatusTransitionRequest {
        doc_id,
        workspace_id: Uuid::nil(),
        from_status_id,
        to_status_id,
        actor_id,
        actor_roles: actor_roles.to_vec(),
        create_version: false,
      })
      .await
  }

  #[instrument(skip(self, request), fields(doc_id = %request.doc_id, workspace_id = %request.workspace_id), err)]
  pub async fn transition_with_request(
    &self,
    request: DocumentStatusTransitionRequest,
  ) -> Result<DocumentMetadataValidation, DocumentMetadataPolicyServiceError> {
    let Some(transition) = self
      .repo
      .get_transition(request.from_status_id, request.to_status_id)
      .await?
    else {
      return Err(DocumentMetadataPolicyServiceError::TransitionBlocked);
    };

    let mut state = self
      .repo
      .get_metadata_state(request.doc_id)
      .await?
      .unwrap_or_else(|| empty_state(request.doc_id));
    if state.status_id != Some(request.from_status_id) {
      return Err(DocumentMetadataPolicyServiceError::TransitionBlocked);
    }
    state.status_id = Some(request.to_status_id);
    state.updated_by = request.actor_id;

    let definitions = self.repo.list_metadata_field_definitions().await?;
    let mut validation =
      self
        .validation_service
        .validate(&definitions, Some(&state), DocumentMetadataAction::TransitionStatus);
    validate_transition_roles(&mut validation, &transition, &request.actor_roles);
    validate_transition_required_metadata_fields(
      &mut validation,
      &transition,
      &definitions,
      &state,
      &self.validation_service,
    );
    validate_transition_versioning_available(
      &mut validation,
      &transition,
      request.create_version,
      self.versioning.is_some(),
    );
    validation.blocked_actions = dedupe(validation.blocked_actions);

    if validation.valid() {
      let created_version = if should_create_transition_version(&transition, request.create_version) {
        self.create_transition_version(&request, &transition).await?
      } else {
        None
      };
      let actor_id = request
        .actor_id
        .ok_or(DocumentMetadataPolicyServiceError::TransitionBlocked)?;
      self
        .metadata_service
        .transition_status(request.doc_id, request.to_status_id, actor_id)
        .await
        .map_err(|err| DocumentMetadataPolicyServiceError::Metadata(err.to_string()))?;
      info!(doc_id = %request.doc_id, from_status_id = %request.from_status_id, to_status_id = %request.to_status_id, version_id = ?created_version.as_ref().map(|version| version.id), "document status transitioned");
    } else {
      warn!(
        doc_id = %request.doc_id,
        from_status_id = %request.from_status_id,
        to_status_id = %request.to_status_id,
        errors = validation.errors.len(),
        "document status transition blocked by validation"
      );
    }
    Ok(validation)
  }

  async fn create_transition_version(
    &self,
    request: &DocumentStatusTransitionRequest,
    transition: &DocumentStatusTransition,
  ) -> Result<Option<DocumentVersion>, DocumentMetadataPolicyServiceError> {
    let Some(versioning) = &self.versioning else {
      return Err(DocumentMetadataPolicyServiceError::TransitionBlocked);
    };
    let actor_id = request
      .actor_id
      .ok_or(DocumentMetadataPolicyServiceError::TransitionBlocked)?;
    let version = versioning
      .create_service
      .create(DocumentVersionCreateRequest {
        doc_id: request.doc_id,
        workspace_id: request.workspace_id,
        actor_id,
        requested_label: None,
        description: Some("Created by document status transition".to_string()),
        event: DocumentVersionEvent::Manual,
        kind: transition.sets_version_kind.unwrap_or(DocumentVersionKind::Milestone),
      })
      .await
      .map_err(|err| DocumentMetadataPolicyServiceError::VersionCreate(err.to_string()))?;
    Ok(Some(version))
  }
}

fn select_status_schema(
  schemas: &[DocumentStatusSchema],
  settings: Option<&myoxus_domain::entities::DocumentWorkspaceSettings>,
) -> Option<DocumentStatusSchema> {
  settings
    .and_then(|settings| settings.status_schema_id)
    .and_then(|schema_id| schemas.iter().find(|schema| schema.id == schema_id).cloned())
    .or_else(|| schemas.iter().find(|schema| schema.key == "simple").cloned())
    .or_else(|| schemas.first().cloned())
}

fn default_state_from_workspace(
  doc_id: Uuid,
  settings: Option<&myoxus_domain::entities::DocumentWorkspaceSettings>,
  status_values: &[DocumentStatusValue],
) -> DocumentMetadataState {
  let mut state = empty_state(doc_id);
  if let Some(settings) = settings {
    state.type_id = settings.default_document_type_id;
    state.classification_id = settings.default_classification_id;
    state.retention_policy_id = settings.default_retention_policy_id;
  }
  state.status_id = default_status_from_workspace(status_values);
  state
}

fn default_status_from_workspace(status_values: &[DocumentStatusValue]) -> Option<Uuid> {
  status_values.first().map(|status| status.id)
}

fn validate_transition_roles(
  validation: &mut DocumentMetadataValidation,
  transition: &DocumentStatusTransition,
  actor_roles: &[String],
) {
  for role in &transition.required_roles {
    if !actor_roles.iter().any(|actor_role| actor_role == role) {
      let issue = issue(
        DocumentMetadataValidationCode::DocumentMetadataForbidden,
        Some("status".to_string()),
        format!("Status transition requires role '{role}'"),
        DocumentMetadataValidationSeverity::Error,
        vec![DocumentMetadataAction::TransitionStatus.as_blocked_action().to_string()],
      );
      validation.blocked_actions.extend(issue.blocked_actions.clone());
      validation.errors.push(issue);
    }
  }
}

fn validate_transition_required_metadata_fields(
  validation: &mut DocumentMetadataValidation,
  transition: &DocumentStatusTransition,
  definitions: &[DocumentMetadataFieldDefinition],
  state: &DocumentMetadataState,
  validation_service: &DocumentMetadataValidationService,
) {
  for key in &transition.required_metadata_fields {
    if validation
      .missing_required_metadata_fields
      .iter()
      .any(|missing| missing == key)
    {
      continue;
    }
    let Some(definition) = definitions.iter().find(|definition| definition.key == *key) else {
      continue;
    };
    if validation_service.is_missing(definition.key.as_str(), Some(state)) {
      validation.missing_required_metadata_fields.push(key.clone());
      validation.errors.push(issue(
        DocumentMetadataValidationCode::DocumentMetadataRequired,
        Some(key.clone()),
        "Status transition requires a missing attribute".to_string(),
        DocumentMetadataValidationSeverity::Error,
        vec![DocumentMetadataAction::TransitionStatus.as_blocked_action().to_string()],
      ));
    }
  }
}

fn validate_transition_versioning_available(
  validation: &mut DocumentMetadataValidation,
  transition: &DocumentStatusTransition,
  create_version_requested: bool,
  versioning_available: bool,
) {
  if should_create_transition_version(transition, create_version_requested) && !versioning_available {
    let issue = issue(
      DocumentMetadataValidationCode::DocumentStatusTransitionBlocked,
      Some("version".to_string()),
      "Status transition requires document-version service".to_string(),
      DocumentMetadataValidationSeverity::Error,
      vec![DocumentMetadataAction::TransitionStatus.as_blocked_action().to_string()],
    );
    validation.blocked_actions.extend(issue.blocked_actions.clone());
    validation.errors.push(issue);
  }
}

fn should_create_transition_version(transition: &DocumentStatusTransition, create_version_requested: bool) -> bool {
  transition.creates_version == "required" || (transition.creates_version == "optional" && create_version_requested)
}

fn empty_state(doc_id: Uuid) -> DocumentMetadataState {
  DocumentMetadataState {
    doc_id,
    status_id: None,
    type_id: None,
    current_version_id: None,
    dirty_since_current_version: false,
    version_display_mode: "show".to_string(),
    last_versioned_at: None,
    responsible_principals: serde_json::json!([]),
    review_due_at: None,
    valid_from: None,
    valid_until: None,
    classification_id: None,
    document_number: None,
    language: None,
    audience_ids: Vec::new(),
    retention_policy_id: None,
    updated_by: None,
    updated_at: Utc::now(),
    metadata: serde_json::json!({}),
  }
}

fn issue(
  code: DocumentMetadataValidationCode,
  key: Option<String>,
  message: String,
  severity: DocumentMetadataValidationSeverity,
  blocked_actions: Vec<String>,
) -> DocumentMetadataValidationIssue {
  DocumentMetadataValidationIssue {
    code,
    key,
    message,
    severity,
    blocked_actions,
    details: serde_json::json!({}),
  }
}

fn dedupe(values: Vec<String>) -> Vec<String> {
  values.into_iter().collect::<BTreeSet<_>>().into_iter().collect()
}

fn classification_is_restricted(state: &DocumentMetadataState) -> bool {
  state
    .metadata
    .get("classificationKey")
    .and_then(serde_json::Value::as_str)
    .is_some_and(|value| value == "restricted")
}
