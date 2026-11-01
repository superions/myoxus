//! Public publishing application contracts.
//!
//! Public reads are deliberately separate from workspace membership. A positive
//! [`PublicAclDecision`] authorizes anonymous HTML delivery only; it must never
//! create users, memberships or `WorkspaceRole::External` rows.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::entities::{
  AutoVersionTrigger, Doc, DocumentMetadataFieldDefinition, DocumentMetadataFieldValue, DocumentMetadataProjection,
  DocumentVersion,
};
use myoxus_public_render::DocumentBadge;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use thiserror::Error;
use tracing::instrument;
use uuid::Uuid;

use crate::auth::AuthError;
use crate::doc::DocService;
use crate::document_version::{
  AutoVersionOutcome, DocumentVersionAutoTriggerRequest, DocumentVersionAutoTriggerService,
};
use crate::permission::{AccessController, DocResource, PermissionService};
use myoxus_domain::permission::DocAction;
use myoxus_domain::repositories::DocumentVersionRepository;

pub const PUBLIC_RENDERER_VERSION: &str = "public-html-v7";
pub const DEFAULT_PUBLIC_THEME_VERSION: &str = "runtime-theme";
/// Cache policy for every response whose availability can be revoked.
///
/// Content hashes still validate asset identity, but never grant permission to
/// reuse an anonymously cached response after workspace publication changes.
pub const PUBLIC_REVOCABLE_CACHE_CONTROL: &str = "no-cache, max-age=0, must-revalidate";
pub const PUBLIC_ASSET_CACHE_CONTROL: &str = PUBLIC_REVOCABLE_CACHE_CONTROL;

/// Project metadata fields shared by public and authenticated document renders.
///
/// Keeping this policy in the application layer prevents MCP and HTTP handlers
/// from drifting into different badge labels or visibility rules.
pub fn document_metadata_badges(
  projection: &DocumentMetadataProjection,
  definitions: &[DocumentMetadataFieldDefinition],
) -> Vec<DocumentBadge> {
  const HEADER_KEYS: [&str; 4] = ["status", "documentType", "classification", "version"];

  HEADER_KEYS
    .into_iter()
    .filter_map(|key| {
      let definition = definitions.iter().find(|definition| {
        definition.key == key && document_metadata_export_visible(definition) && definition.visible_in_header
      })?;
      let field = projection.fields.iter().find(|field| field.key == key)?;
      Some(DocumentBadge {
        key: key.to_string(),
        label: definition.label.clone(),
        value: document_badge_value(field)?,
      })
    })
    .collect()
}

/// Existing export admission shared by public badges and register columns.
pub fn document_metadata_export_visible(definition: &DocumentMetadataFieldDefinition) -> bool {
  definition.enabled && definition.export_mode != "hidden"
}

fn document_badge_value(field: &DocumentMetadataFieldValue) -> Option<String> {
  let reference_label = field
    .reference
    .as_ref()
    .map(|reference| reference.label.trim())
    .filter(|label| !label.is_empty());
  if field.key == "version" && field.text_value.as_deref() == Some("dirty") {
    return Some(match reference_label {
      Some(label) => format!("{label} (changed)"),
      None => "Unversioned changes".to_string(),
    });
  }
  reference_label.map(str::to_string)
}

#[derive(Debug, Error)]
pub enum PublicError {
  #[error("public repository error: {0}")]
  Repository(String),
  #[error("public render error: {0}")]
  Render(String),
}

pub type PublicResult<T> = Result<T, PublicError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicDocumentMode {
  Page,
  Edgeless,
}

impl PublicDocumentMode {
  pub const fn persistence_value(self) -> &'static str {
    match self {
      Self::Page => "Page",
      Self::Edgeless => "Edgeless",
    }
  }
}

#[derive(Debug, Error)]
pub enum DocumentPublicationError {
  #[error(transparent)]
  Authorization(#[from] AuthError),
  #[error(transparent)]
  Public(#[from] PublicError),
  #[error("public publishing is unavailable for this server")]
  DeliveryUnavailable,
  #[error("workspace must be public with sharing enabled before publishing documents")]
  WorkspaceUnavailable,
  #[error("document not found")]
  NotFound,
  #[error("document version capture failed: {0}")]
  Version(String),
}

/// Shared publication mutation used by GraphQL and MCP adapters.
#[derive(Clone)]
pub struct DocumentPublicationService {
  permission: Arc<PermissionService>,
  docs: Arc<DocService>,
  public_repository: Arc<dyn PublicRepository>,
  delivery_enabled: bool,
  auto_version: Option<DocumentVersionAutoTriggerService>,
  version_repository: Option<Arc<dyn DocumentVersionRepository>>,
}

impl DocumentPublicationService {
  pub fn new(
    permission: Arc<PermissionService>,
    docs: Arc<DocService>,
    public_repository: Arc<dyn PublicRepository>,
    delivery_enabled: bool,
  ) -> Self {
    Self {
      permission,
      docs,
      public_repository,
      delivery_enabled,
      auto_version: None,
      version_repository: None,
    }
  }

  /// Attach the optional versioning capabilities used for pre-publish capture
  /// and best-effort cleanup when the guarded publication write fails.
  pub fn with_versioning(
    mut self,
    service: DocumentVersionAutoTriggerService,
    repository: Arc<dyn DocumentVersionRepository>,
  ) -> Self {
    self.auto_version = Some(service);
    self.version_repository = Some(repository);
    self
  }

  #[instrument(skip_all, fields(actor_id = %actor_id, workspace_id = %workspace_id, doc_id = %doc_id))]
  pub async fn set_mode(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    mode: Option<PublicDocumentMode>,
  ) -> Result<Doc, DocumentPublicationError> {
    self
      .permission
      .assert(
        &DocResource {
          user_id: actor_id,
          workspace_id,
          doc_id,
        },
        DocAction::Publish,
      )
      .await?;

    if mode.is_some() {
      if !self.delivery_enabled {
        return Err(DocumentPublicationError::DeliveryUnavailable);
      }
      if self
        .public_repository
        .decide_workspace(workspace_id)
        .await?
        .allowed()
        .is_none()
      {
        return Err(DocumentPublicationError::WorkspaceUnavailable);
      }
    }

    let auto_version = if mode.is_some() {
      self.create_publish_auto_version(doc_id, workspace_id, actor_id).await?
    } else {
      None
    };
    let row = match self
      .docs
      .update_public_mode(
        workspace_id,
        doc_id,
        mode.map(|mode| mode.persistence_value().to_string()),
        actor_id,
      )
      .await
    {
      Ok(Some(row)) => row,
      Ok(None) => {
        self.cleanup_auto_version(auto_version.as_ref()).await;
        return Err(DocumentPublicationError::NotFound);
      }
      Err(error) => {
        self.cleanup_auto_version(auto_version.as_ref()).await;
        return Err(DocumentPublicationError::Authorization(error));
      }
    };

    if let Err(error) = self.public_repository.invalidate_document(workspace_id, doc_id).await {
      tracing::warn!(%doc_id, %workspace_id, %error, "public document artifact invalidation failed");
    }
    tracing::info!(
      %doc_id,
      %workspace_id,
      public_mode = ?row.public_mode,
      outcome = if mode.is_some() { "publish" } else { "revoke" },
      "public document metadata updated"
    );
    Ok(row)
  }

  async fn create_publish_auto_version(
    &self,
    doc_id: Uuid,
    workspace_id: Uuid,
    actor_id: Uuid,
  ) -> Result<Option<DocumentVersion>, DocumentPublicationError> {
    let Some(service) = &self.auto_version else {
      tracing::debug!(%doc_id, %workspace_id, "publish auto-version skipped: versioning capabilities missing");
      return Ok(None);
    };
    match service
      .create_for_trigger(DocumentVersionAutoTriggerRequest {
        doc_id,
        workspace_id,
        actor_id,
        trigger: AutoVersionTrigger::OnPublish,
        description: Some("Automatically created before document publish".to_string()),
        skip_unchanged: false,
      })
      .await
      .map_err(|error| DocumentPublicationError::Version(error.to_string()))?
    {
      AutoVersionOutcome::Created(version) => Ok(Some(*version)),
      AutoVersionOutcome::Skipped(reason) => {
        tracing::debug!(%doc_id, %workspace_id, ?reason, "publish auto-version skipped");
        Ok(None)
      }
    }
  }

  async fn cleanup_auto_version(&self, version: Option<&DocumentVersion>) {
    let Some(version) = version else {
      return;
    };
    if let Some(repository) = &self.version_repository
      && let Err(error) = repository.delete(version.id).await
    {
      tracing::warn!(version_id = %version.id, doc_id = %version.doc_id, workspace_id = %version.workspace_id, %error, "publish auto-version cleanup failed");
    }
    if let Err(error) = self.docs.delete_history_entry(version.doc_history_id).await {
      tracing::warn!(version_id = %version.id, history_id = version.doc_history_id, %error, "publish history cleanup failed");
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicRouteKind {
  Workspace,
  Document,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicDenyReason {
  Missing,
  Private,
  Deleted,
  Blocked,
  SharingDisabled,
}

#[derive(Debug, Clone)]
pub enum PublicAclDecision {
  Allow(PublicAllow),
  DenyNotFound(PublicDenyReason),
}

impl PublicAclDecision {
  pub fn allowed(self) -> Option<PublicAllow> {
    match self {
      Self::Allow(allow) => Some(allow),
      Self::DenyNotFound(_) => None,
    }
  }
}

#[derive(Debug, Clone)]
pub struct PublicAllow {
  pub workspace_id: Uuid,
  pub doc_id: Option<Uuid>,
  pub public_mode: Option<String>,
  pub workspace_public: bool,
  pub source_hash: String,
  pub theme_version: String,
  pub noindex: bool,
  pub title: Option<String>,
  pub workspace_title: Option<String>,
  pub workspace_description: String,
}

#[derive(Debug, Clone)]
pub struct PublicArtifact {
  pub workspace_id: Uuid,
  pub doc_id: Option<Uuid>,
  pub source_hash: String,
  pub renderer_version: String,
  pub theme_version: String,
  pub noindex: bool,
  pub asset_manifest: Value,
  pub rendered_html: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicAssetManifestEntry {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub asset_hash: String,
  pub filename: String,
  pub blob_key: String,
  pub content_type: String,
  pub size_bytes: i64,
  pub last_modified: Option<DateTime<Utc>>,
  pub cache_control: String,
}

#[derive(Debug, Clone)]
pub struct PublicWorkspaceDoc {
  pub doc_id: Uuid,
  /// Stable external key used in anonymous URLs; the UUID stays internal.
  pub route_key: String,
  pub title: String,
  pub public_mode: String,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Current anonymous workspace metadata shared by dynamic and snapshot delivery.
#[derive(Debug, Clone)]
pub struct PublicWorkspaceProjection {
  pub workspace_id: Uuid,
  pub title: String,
  pub description: String,
}

#[async_trait]
pub trait PublicRepository: Send + Sync {
  async fn list_public_workspaces(&self) -> PublicResult<Vec<PublicWorkspaceProjection>>;
  async fn decide_workspace(&self, workspace_id: Uuid) -> PublicResult<PublicAclDecision>;
  async fn decide_document(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    source_hash: String,
  ) -> PublicResult<PublicAclDecision>;
  async fn list_public_workspace_docs(&self, workspace_id: Uuid) -> PublicResult<Vec<PublicWorkspaceDoc>>;
  async fn upsert_artifact(&self, artifact: &PublicArtifact) -> PublicResult<()>;
  async fn invalidate_document(&self, workspace_id: Uuid, doc_id: Uuid) -> PublicResult<()>;
  async fn invalidate_workspace(&self, workspace_id: Uuid) -> PublicResult<()>;
  async fn replace_asset_manifest(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    assets: &[PublicAssetManifestEntry],
  ) -> PublicResult<()>;
  async fn get_asset(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    asset_hash: &str,
    filename: &str,
  ) -> PublicResult<Option<PublicAssetManifestEntry>>;
}

#[derive(Clone)]
pub struct PublicService<R> {
  repo: R,
}

impl<R> PublicService<R>
where
  R: PublicRepository,
{
  pub fn new(repo: R) -> Self {
    Self { repo }
  }

  pub async fn list_public_workspaces(&self) -> PublicResult<Vec<PublicWorkspaceProjection>> {
    self.repo.list_public_workspaces().await
  }

  #[instrument(skip(self), fields(workspace_id = %workspace_id, route = "workspace"))]
  pub async fn decide_workspace(&self, workspace_id: Uuid) -> PublicResult<PublicAclDecision> {
    self.repo.decide_workspace(workspace_id).await
  }

  #[instrument(skip(self, source), fields(workspace_id = %workspace_id, doc_id = %doc_id, route = "document"))]
  pub async fn decide_document(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    source: &[u8],
  ) -> PublicResult<PublicAclDecision> {
    self
      .repo
      .decide_document(workspace_id, doc_id, source_hash(source))
      .await
  }

  pub async fn list_public_workspace_docs(&self, workspace_id: Uuid) -> PublicResult<Vec<PublicWorkspaceDoc>> {
    self.repo.list_public_workspace_docs(workspace_id).await
  }

  pub async fn upsert_artifact(&self, artifact: &PublicArtifact) -> PublicResult<()> {
    self.repo.upsert_artifact(artifact).await
  }

  pub async fn invalidate_document(&self, workspace_id: Uuid, doc_id: Uuid) -> PublicResult<()> {
    self.repo.invalidate_document(workspace_id, doc_id).await
  }

  pub async fn invalidate_workspace(&self, workspace_id: Uuid) -> PublicResult<()> {
    self.repo.invalidate_workspace(workspace_id).await
  }

  pub async fn replace_asset_manifest(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    assets: &[PublicAssetManifestEntry],
  ) -> PublicResult<()> {
    self.repo.replace_asset_manifest(workspace_id, doc_id, assets).await
  }

  pub async fn get_asset(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    asset_hash: &str,
    filename: &str,
  ) -> PublicResult<Option<PublicAssetManifestEntry>> {
    self.repo.get_asset(workspace_id, doc_id, asset_hash, filename).await
  }
}

pub fn source_hash(source: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(source);
  hex::encode(hasher.finalize())
}
