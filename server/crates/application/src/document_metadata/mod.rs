// SPDX-License-Identifier: AGPL-3.0-or-later
//! Application service for canonical document metadata.
//!
//! The service owns projection-mode policy and keeps GraphQL/REST callers away
//! from SQL table details. Persistence remains a repository concern.

pub mod okf;

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::doc::DocCachePort;
use crate::document_metadata_policy::DocumentMetadataAction;
use chrono::{DateTime, Utc};
use moka::future::Cache;
use myoxus_domain::entities::{
  DocumentMetadataFieldDefinition, DocumentMetadataFieldValue, DocumentMetadataMaterializationSummary,
  DocumentMetadataPatch, DocumentMetadataProjection, DocumentMetadataValidation, DocumentMetadataValidationCode,
  DocumentMetadataValidationIssue, DocumentMetadataValidationSeverity,
};
use myoxus_domain::repositories::{DocumentMetadataRepository, RepositoryError};
use thiserror::Error;
use tracing::{info, instrument};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentMetadataProjectionMode {
  MyoxusNative,
  AffineLegacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentMetadataClientFormat {
  MyoxusNative,
  AffineLegacy,
}

impl DocumentMetadataProjectionMode {
  pub fn as_cache_segment(self) -> &'static str {
    match self {
      Self::MyoxusNative => "myoxus-native",
      Self::AffineLegacy => "affine-legacy",
    }
  }
}

#[derive(Debug, Error)]
pub enum DocumentMetadataServiceError {
  #[error("document not found")]
  NotFound,
  #[error("requested document metadata projection is not allowed for this client")]
  ProjectionNotAllowed,
  #[error("repository error: {0}")]
  Repository(#[from] RepositoryError),
}

#[derive(Clone)]
pub struct DocumentMetadataService {
  repo: Arc<dyn DocumentMetadataRepository>,
  projection_cache: Option<Arc<dyn DocCachePort>>,
  projection_loads: Cache<(Uuid, Uuid, &'static str, String), DocumentMetadataProjection>,
}

#[derive(Debug, Error)]
enum ProjectionLoadError {
  #[error("document not found")]
  NotFound,
  #[error("projection changed while loading")]
  Stale,
  #[error("repository error: {0}")]
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

impl DocumentMetadataService {
  pub fn new(repo: Arc<dyn DocumentMetadataRepository>) -> Self {
    Self {
      repo,
      projection_cache: None,
      projection_loads: Cache::builder().max_capacity(10_000).build(),
    }
  }

  pub fn with_projection_cache(mut self, cache: Arc<dyn DocCachePort>) -> Self {
    self.projection_cache = Some(cache);
    self
  }

  pub async fn workspace_id_for_document(&self, doc_id: Uuid) -> Result<Uuid, DocumentMetadataServiceError> {
    self
      .repo
      .workspace_id_for_document(doc_id)
      .await?
      .ok_or(DocumentMetadataServiceError::NotFound)
  }

  #[instrument(skip(self), fields(%doc_id, %workspace_id), err)]
  pub async fn get_projection(
    &self,
    doc_id: Uuid,
    workspace_id: Uuid,
    projection_mode: DocumentMetadataProjectionMode,
  ) -> Result<DocumentMetadataProjection, DocumentMetadataServiceError> {
    // A version is checked again after every cache read/fill. This keeps a
    // concurrent writer from making an older response appear current, while
    // the repository's versioned read guarantees fills use one SQL snapshot.
    for _ in 0..3 {
      let requested_version = self
        .repo
        .projection_version(doc_id, workspace_id)
        .await?
        .ok_or(DocumentMetadataServiceError::NotFound)?;
      let load_key = (
        workspace_id,
        doc_id,
        projection_mode.as_cache_segment(),
        requested_version.clone(),
      );
      let repo = self.repo.clone();
      let projection_cache = self.projection_cache.clone();
      let load_version = requested_version.clone();
      let result: Result<DocumentMetadataProjection, Arc<ProjectionLoadError>> = self
        .projection_loads
        .try_get_with(load_key, async move {
          if let Some(cache) = &projection_cache
            && let Some(mut projection) = cache
              .get_metadata_projection(
                workspace_id,
                doc_id,
                projection_mode.as_cache_segment(),
                load_version.as_str(),
              )
              .await
          {
            projection.projection_version = load_version;
            return Ok(projection);
          }

          let (projection_version, mut projection) = repo
            .get_projection_versioned(doc_id, workspace_id)
            .await
            .map_err(ProjectionLoadError::Repository)?
            .ok_or(ProjectionLoadError::NotFound)?;
          if projection_version != load_version {
            if let Some(cache) = &projection_cache {
              cache.record_metadata_projection_version_change().await;
            }
            return Err(ProjectionLoadError::Stale);
          }
          projection.projection_version = projection_version.clone();
          if let Some(cache) = &projection_cache {
            cache
              .set_metadata_projection(
                workspace_id,
                doc_id,
                projection_mode.as_cache_segment(),
                projection_version.as_str(),
                &projection,
              )
              .await;
          }
          Ok(projection)
        })
        .await;
      let projection = match result {
        Ok(projection) => projection,
        Err(error) => match error.as_ref() {
          ProjectionLoadError::NotFound => return Err(DocumentMetadataServiceError::NotFound),
          ProjectionLoadError::Stale => continue,
          ProjectionLoadError::Repository(error) => {
            return Err(DocumentMetadataServiceError::Repository(clone_repository_error(error)));
          }
        },
      };
      let current_version = self
        .repo
        .projection_version(doc_id, workspace_id)
        .await?
        .ok_or(DocumentMetadataServiceError::NotFound)?;
      if current_version == requested_version {
        return Ok(projection);
      }
      if let Some(cache) = &self.projection_cache {
        cache.record_metadata_projection_version_change().await;
      }
    }

    let (projection_version, mut projection) = self
      .repo
      .get_projection_versioned(doc_id, workspace_id)
      .await?
      .ok_or(DocumentMetadataServiceError::NotFound)?;
    projection.projection_version = projection_version;
    Ok(projection)
  }

  #[instrument(skip(self), fields(%doc_id, %workspace_id), err)]
  pub async fn get_projection_uncached(
    &self,
    doc_id: Uuid,
    workspace_id: Uuid,
  ) -> Result<DocumentMetadataProjection, DocumentMetadataServiceError> {
    self
      .repo
      .get_projection(doc_id, workspace_id)
      .await?
      .ok_or(DocumentMetadataServiceError::NotFound)
  }

  #[instrument(skip(self, patch), fields(%doc_id, %actor_id), err)]
  pub async fn set_metadata(
    &self,
    doc_id: Uuid,
    actor_id: Uuid,
    patch: DocumentMetadataPatch,
  ) -> Result<(), DocumentMetadataServiceError> {
    if patch
      .template_category
      .as_ref()
      .and_then(Option::as_ref)
      .is_some_and(|category| category.trim().is_empty())
    {
      return Err(RepositoryError::Validation("template category must not be empty".to_string()).into());
    }
    if patch
      .template_tags
      .as_ref()
      .and_then(Option::as_ref)
      .is_some_and(|tags| tags.iter().any(|tag| tag.trim().is_empty()))
    {
      return Err(RepositoryError::Validation("template tags must not be empty".to_string()).into());
    }
    self.repo.apply_patch(doc_id, actor_id, &patch).await?;
    Ok(())
  }

  #[instrument(skip(self), fields(%workspace_id, actor_id = ?actor_id), err)]
  pub async fn rematerialize_workspace_defaults(
    &self,
    workspace_id: Uuid,
    actor_id: Option<Uuid>,
  ) -> Result<DocumentMetadataMaterializationSummary, DocumentMetadataServiceError> {
    let summary = self
      .repo
      .rematerialize_workspace_defaults(workspace_id, actor_id)
      .await?;
    info!(
      %workspace_id,
      actor_id = ?actor_id,
      scanned_count = summary.scanned_count,
      changed_count = summary.changed_count,
      materialized_count = summary.materialized_count,
      "document metadata defaults rematerialized"
    );
    Ok(summary)
  }

  #[instrument(skip(self), fields(%doc_id, %version_id, %actor_id), err)]
  pub async fn mark_current_version(
    &self,
    doc_id: Uuid,
    version_id: Uuid,
    versioned_at: DateTime<Utc>,
    actor_id: Uuid,
  ) -> Result<(), DocumentMetadataServiceError> {
    self
      .repo
      .mark_current_version(doc_id, version_id, versioned_at, actor_id)
      .await?;
    Ok(())
  }

  #[instrument(skip(self), fields(%doc_id, %status_id, %actor_id), err)]
  pub async fn transition_status(
    &self,
    doc_id: Uuid,
    status_id: Uuid,
    actor_id: Uuid,
  ) -> Result<(), DocumentMetadataServiceError> {
    self.repo.transition_status(doc_id, status_id, actor_id).await?;
    Ok(())
  }

  pub fn resolve_projection_mode(
    client_format: DocumentMetadataClientFormat,
    requested: Option<DocumentMetadataProjectionMode>,
  ) -> Result<DocumentMetadataProjectionMode, DocumentMetadataServiceError> {
    let is_native = client_format == DocumentMetadataClientFormat::MyoxusNative;
    let mode = requested.unwrap_or(if is_native {
      DocumentMetadataProjectionMode::MyoxusNative
    } else {
      DocumentMetadataProjectionMode::AffineLegacy
    });

    if mode == DocumentMetadataProjectionMode::MyoxusNative && !is_native {
      return Err(DocumentMetadataServiceError::ProjectionNotAllowed);
    }

    Ok(mode)
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
    projection: &DocumentMetadataProjection,
    action: DocumentMetadataAction,
  ) -> DocumentMetadataValidation {
    let mut validation = DocumentMetadataValidation::default();
    let now = Utc::now();

    for definition in definitions.iter().filter(|definition| definition.enabled) {
      if self.is_required(definition, projection) && self.is_missing(definition.key.as_str(), projection) {
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
        && self.is_missing(definition.key.as_str(), projection)
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

    if timestamp_attribute(projection, "validUntil").is_some_and(|valid_until| valid_until < now) {
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

    if action == DocumentMetadataAction::SharePublic && classification_is_restricted(projection) {
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

    validation.blocked_actions = dedupe(validation.blocked_actions);
    validation
  }

  fn is_required(&self, definition: &DocumentMetadataFieldDefinition, projection: &DocumentMetadataProjection) -> bool {
    match definition.required_mode.as_str() {
      "always" => true,
      "by_status" => {
        !self.is_missing("status", projection)
          && definition
            .validation_config
            .get("requiredWhenStatusSet")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
      }
      "by_type" => {
        !self.is_missing("documentType", projection)
          && definition
            .validation_config
            .get("requiredWhenTypeSet")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
      }
      "by_status_and_type" => {
        !self.is_missing("status", projection)
          && !self.is_missing("documentType", projection)
          && definition
            .validation_config
            .get("requiredWhenStatusAndTypeSet")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
      }
      _ => false,
    }
  }

  fn is_missing(&self, key: &str, projection: &DocumentMetadataProjection) -> bool {
    match key {
      "audience" => projection.audience.is_empty(),
      "responsible" => field_value(projection, key).is_none_or(|field| field.user_id.is_none()),
      "status" | "documentType" | "classification" | "retentionPolicy" | "language" | "version" => {
        field_value(projection, key).is_none_or(|field| field.reference.is_none())
      }
      "reviewDueAt" | "validFrom" | "validUntil" => {
        field_value(projection, key).is_none_or(|field| field.timestamp_value.is_none())
      }
      "documentNumber" => field_value(projection, key)
        .and_then(|field| field.text_value.as_deref())
        .is_none_or(str::is_empty),
      _ => true,
    }
  }
}

fn field_value<'a>(projection: &'a DocumentMetadataProjection, key: &str) -> Option<&'a DocumentMetadataFieldValue> {
  projection.fields.iter().find(|field| field.key == key)
}

fn timestamp_attribute(projection: &DocumentMetadataProjection, key: &str) -> Option<DateTime<Utc>> {
  field_value(projection, key).and_then(|field| field.timestamp_value)
}

fn classification_is_restricted(projection: &DocumentMetadataProjection) -> bool {
  field_value(projection, "classification")
    .and_then(|field| field.reference.as_ref())
    .is_some_and(|reference| reference.key == "restricted")
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
