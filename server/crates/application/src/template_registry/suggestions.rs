//! Server-owned template suggestions for document creation surfaces.
//!
//! The service is intentionally read-only: it ranks existing Template Registry
//! policies and instances, but never materializes templates or triggers a
//! reconcile run. Web/Core can therefore use it for picker state without
//! gaining a second template governance model.

use std::collections::HashMap;
use std::sync::Arc;
#[cfg(test)]
use std::time::Instant;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use myoxus_domain::entities::{DocumentMetadataValueDefinition, DocumentStatusValue, DocumentTypeDefinition};
use myoxus_domain::ids::{UserId, WorkspaceId};
#[cfg(test)]
use myoxus_domain::permission::DocAction;
use myoxus_domain::repositories::{DocumentMetadataPolicyRepository, RepositoryError};
#[cfg(test)]
use myoxus_domain::template_registry::{BuiltinReconcileEntry, SelectionMode};
use myoxus_domain::template_registry::{
  InstanceState, ProvisioningMode, RevisionState, TemplateCatalogEntry, TemplateCatalogEntryId, TemplateSource,
  TemplateStatus, WorkspaceTemplateInstance, WorkspaceTemplatePolicy,
};
use thiserror::Error;
#[cfg(test)]
use tracing::info;
use tracing::instrument;
use uuid::Uuid;

use crate::auth::AuthError;
use crate::permission::PermissionService;
#[cfg(test)]
use crate::permission::{AccessController, DocResource};

#[cfg(test)]
use super::is_building_block_category;
use super::{TemplatePageDefaultReplacement, TemplateRegistryService};

mod contextual;
mod library;
pub use contextual::{
  ContextualGuideDelivery, ContextualTemplatePage, ContextualTemplateQuery, ContextualTemplateSource,
};
pub use library::{
  TemplateLibraryCursor, TemplateLibraryFilter, TemplateLibraryKind, TemplateLibraryOrigin, TemplateLibraryQuery,
  TemplateLibrarySort, TemplateLibrarySource,
};

pub const ERR_TEMPLATE_SUGGESTIONS_UNAVAILABLE: &str = "MIX_TEMPLATE_SUGGESTIONS_UNAVAILABLE";
pub const ERR_TEMPLATE_SUGGESTIONS_WORKSPACE_FORBIDDEN: &str = "MIX_TEMPLATE_SUGGESTIONS_WORKSPACE_FORBIDDEN";
pub const ERR_TEMPLATE_SUGGESTIONS_INPUT_INVALID: &str = "MIX_TEMPLATE_SUGGESTIONS_INPUT_INVALID";
pub const ERR_TEMPLATE_SUGGESTIONS_METADATA_INVALID: &str = "MIX_TEMPLATE_SUGGESTIONS_METADATA_INVALID";
pub const ERR_TEMPLATE_SUGGESTIONS_TEMPLATE_FORBIDDEN: &str = "MIX_TEMPLATE_SUGGESTIONS_TEMPLATE_FORBIDDEN";

const DEFAULT_FIRST: usize = 8;
const MAX_FIRST: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TemplateSuggestionSurface {
  Library,
  BuildingBlock,
  SidebarNewPage,
  AllPagesNewPage,
  CollectionNewPage,
  DatabaseRowTemplate,
  StarterBar,
  JournalOnboarding,
  JournalSidebarFooter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateSuggestionReason {
  WorkspacePolicy,
  DefaultPolicy,
  SurfaceCategory,
  MetadataDocumentType,
  MetadataStatus,
  MetadataClassification,
  InstanceOk,
  UpdateAvailable,
  Detached,
  ReconcileRequired,
  InstanceError,
  Redacted,
  Preparing,
  AccessDenied,
  SourceMissing,
  IncompatibleClient,
  RetryableFailure,
}

#[derive(Debug, Clone)]
pub struct TemplateSuggestionRequest {
  pub workspace_id: WorkspaceId,
  pub user_id: Option<UserId>,
  pub surface: TemplateSuggestionSurface,
  pub locale: String,
  pub client_version: u32,
  pub document_type_id: Option<Uuid>,
  pub status_id: Option<Uuid>,
  pub classification_id: Option<Uuid>,
  pub mode: Option<String>,
  pub collection_id: Option<Uuid>,
  pub current_doc_id: Option<Uuid>,
  pub first: Option<usize>,
  pub after: Option<String>,
  pub library: Option<TemplateLibraryFilter>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateSuggestionItem {
  /// Registry identity, or the existing external document key for a native custom source.
  pub template_id: String,
  pub template_doc_id: Option<String>,
  pub slug: String,
  pub title: String,
  pub description: Option<String>,
  /// Registry provenance or native custom origin, never inferred from a title/slug.
  pub source: String,
  /// Library uses the live source timestamp; contextual suggestions use catalog change time.
  pub updated_at: DateTime<Utc>,
  pub category: Option<String>,
  /// Application semantics of the materialized revision, not a newer policy target.
  pub title_policy: Option<super::bundle::TitlePolicy>,
  pub source_revision_id: Option<myoxus_domain::template_registry::TemplateRevisionId>,
  pub tags: Vec<String>,
  pub score: i32,
  pub reasons: Vec<TemplateSuggestionReason>,
  pub instance_state: Option<String>,
  pub available: bool,
  /// True only when the active policy protects the source lifecycle.
  pub protected_source: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateSuggestionResult {
  pub items: Vec<TemplateSuggestionItem>,
  /// Ordinary reader delivery bindings; never reusable picker candidates.
  pub guide_deliveries: Vec<TemplateGuideDelivery>,
  pub page_default_replacements: Vec<TemplatePageDefaultReplacement>,
  pub empty_document_allowed: bool,
  pub reconcile_required: bool,
  pub stale: bool,
  pub has_next_page: bool,
  pub end_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateGuideDelivery {
  pub slug: String,
  pub document_id: Option<String>,
  pub pending: bool,
}

#[derive(Debug, Error)]
pub enum TemplateSuggestionError {
  #[error("template suggestion service is unavailable")]
  Unavailable,
  #[error("workspace access forbidden")]
  WorkspaceForbidden,
  #[error("invalid template suggestion input: {0}")]
  InputInvalid(String),
  #[error("invalid template suggestion metadata: {0}")]
  MetadataInvalid(String),
  #[error("template access forbidden")]
  TemplateForbidden,
  #[error(transparent)]
  Auth(#[from] AuthError),
  #[error(transparent)]
  Repository(#[from] RepositoryError),
}

impl TemplateSuggestionError {
  pub fn code(&self) -> &'static str {
    match self {
      Self::Unavailable => ERR_TEMPLATE_SUGGESTIONS_UNAVAILABLE,
      Self::WorkspaceForbidden => ERR_TEMPLATE_SUGGESTIONS_WORKSPACE_FORBIDDEN,
      Self::InputInvalid(_) => ERR_TEMPLATE_SUGGESTIONS_INPUT_INVALID,
      Self::MetadataInvalid(_) => ERR_TEMPLATE_SUGGESTIONS_METADATA_INVALID,
      Self::TemplateForbidden => ERR_TEMPLATE_SUGGESTIONS_TEMPLATE_FORBIDDEN,
      Self::Auth(AuthError::ActionForbidden) => ERR_TEMPLATE_SUGGESTIONS_WORKSPACE_FORBIDDEN,
      Self::Auth(_) | Self::Repository(_) => ERR_TEMPLATE_SUGGESTIONS_UNAVAILABLE,
    }
  }
}

#[derive(Clone)]
pub struct TemplateSuggestionService {
  registry: Arc<TemplateRegistryService>,
  metadata_policy_repo: Option<Arc<dyn DocumentMetadataPolicyRepository>>,
  permission_service: Option<Arc<PermissionService>>,
  document_metadata: Option<crate::document_metadata::DocumentMetadataService>,
}

impl TemplateSuggestionService {
  pub fn new(
    registry: Arc<TemplateRegistryService>,
    metadata_policy_repo: Option<Arc<dyn DocumentMetadataPolicyRepository>>,
    permission_service: Option<Arc<PermissionService>>,
  ) -> Self {
    Self {
      registry,
      metadata_policy_repo,
      permission_service,
      document_metadata: None,
    }
  }

  /// Pinned associations require the uncached native template marker as well
  /// as the Registry instance; ordinary suggestions retain their existing inputs.
  pub fn with_document_metadata_service(mut self, service: crate::document_metadata::DocumentMetadataService) -> Self {
    self.document_metadata = Some(service);
    self
  }

  /// Resolve only an already materialized, unchanged exact native source.
  /// This projection creates no assignment/content and is not future write authority.
  #[instrument(skip_all)]
  pub async fn resolve_pinned_library_source(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    native_slug: &str,
    native_version: &str,
    locale: &str,
    client_version: u32,
  ) -> Result<Option<TemplateSuggestionItem>, TemplateSuggestionError> {
    let permission = self
      .permission_service
      .as_ref()
      .ok_or(TemplateSuggestionError::Unavailable)?;
    permission
      .assert_template_catalog_read(actor, workspace)
      .await
      .map_err(|_| TemplateSuggestionError::WorkspaceForbidden)?;
    let request = TemplateSuggestionRequest {
      workspace_id: workspace,
      user_id: Some(actor),
      surface: TemplateSuggestionSurface::AllPagesNewPage,
      locale: locale.into(),
      client_version,
      document_type_id: None,
      status_id: None,
      classification_id: None,
      mode: None,
      collection_id: None,
      current_doc_id: None,
      first: Some(1),
      after: None,
      library: None,
    };
    validate_request(&request)?;
    let Some(mut entry) = self.registry.store.get_catalog_entry_by_slug(native_slug).await? else {
      return Ok(None);
    };
    if entry.source != TemplateSource::Bundle
      || entry.status != TemplateStatus::Active
      || entry.min_client_version > client_version
    {
      return Ok(None);
    }
    let Some(policy) = self
      .collect_candidates(workspace)
      .await?
      .into_iter()
      .find(|candidate| candidate.template_id == entry.id)
      .map(|candidate| candidate.policy)
    else {
      return Ok(None);
    };
    let Some(instance) = self.instances_by_template(workspace).await?.remove(&entry.id) else {
      return Ok(None);
    };
    if instance.detached_at.is_some()
      || instance.retired_at.is_some()
      || !matches!(instance.state, InstanceState::Ok | InstanceState::UpdateAvailable)
    {
      return Ok(None);
    }
    let Some(revision) = self.registry.store.get_revision(instance.revision_id).await? else {
      return Ok(None);
    };
    if revision.template_id != entry.id
      || revision.bundle_blob_id.is_none()
      || revision.checksum.is_none()
      || revision.version != native_version
      || !matches!(revision.state, RevisionState::Published | RevisionState::Deprecated)
      || super::revision_is_guide(&revision)
    {
      return Ok(None);
    }
    let Some(doc_id) = instance.workspace_doc_id else {
      return Ok(None);
    };
    let documents = self
      .registry
      .doc_service
      .as_ref()
      .ok_or(TemplateSuggestionError::Unavailable)?;
    let Some(document) = documents.get_metadata(doc_id).await? else {
      return Ok(None);
    };
    if document.workspace_id != Some(workspace)
      || document.deleted_at.is_some()
      || document.blocked
      || document.is_workspace_root
      || instance.workspace_doc_key.as_deref() != Some(document.external_id.as_str())
    {
      return Ok(None);
    }
    let metadata = self
      .document_metadata
      .as_ref()
      .ok_or(TemplateSuggestionError::Unavailable)?;
    let source_before = documents.store().preview_source_identity(workspace, doc_id).await?;
    let projection = match metadata.get_projection_uncached(doc_id, workspace).await {
      Ok(projection) => projection,
      Err(crate::document_metadata::DocumentMetadataServiceError::NotFound) => return Ok(None),
      Err(crate::document_metadata::DocumentMetadataServiceError::Repository(error)) => return Err(error.into()),
      Err(crate::document_metadata::DocumentMetadataServiceError::ProjectionNotAllowed) => return Ok(None),
    };
    // Registry materialization intentionally leaves optional metadata IDs empty:
    // the exact revision identity lives in its native instance binding.
    if projection.template.as_ref().is_none_or(|marker| {
      !matches!(marker.state.as_str(), "seeded" | "managed")
        || marker.template_id.is_some_and(|id| id != entry.id)
        || marker.revision_id.is_some_and(|id| id != revision.id)
        || marker.instance_id.is_some_and(|id| id != instance.id)
    }) {
      return Ok(None);
    }
    if !self.registry.pinned_library_content_unchanged(&instance).await? {
      return Ok(None);
    }
    let projection_after = match metadata.get_projection_uncached(doc_id, workspace).await {
      Ok(projection) => projection,
      Err(crate::document_metadata::DocumentMetadataServiceError::NotFound) => return Ok(None),
      Err(crate::document_metadata::DocumentMetadataServiceError::Repository(error)) => return Err(error.into()),
      Err(crate::document_metadata::DocumentMetadataServiceError::ProjectionNotAllowed) => return Ok(None),
    };
    if projection != projection_after
      || source_before.as_ref().is_none_or(|source| source.deleted)
      || source_before != documents.store().preview_source_identity(workspace, doc_id).await?
    {
      return Ok(None);
    }
    // Reject binding/policy changes observed during the coherent content read.
    let live_instance = self.registry.store.get_instance(instance.id).await?;
    let live_policy = self.registry.store.get_policy(policy.id).await?;
    if live_instance.as_ref().is_none_or(|current| {
      current.workspace_id != workspace
        || current.detached_at.is_some()
        || current.retired_at.is_some()
        || current.template_id != entry.id
        || current.revision_id != instance.revision_id
        || current.workspace_doc_id != Some(doc_id)
        || current.workspace_doc_key != instance.workspace_doc_key
        || current.last_applied_hash != instance.last_applied_hash
        || !matches!(current.state, InstanceState::Ok | InstanceState::UpdateAvailable)
    }) || live_policy
      .as_ref()
      .is_none_or(|current| !current.is_enabled || current.workspace_id != workspace || current.template_id != entry.id)
    {
      return Ok(None);
    }
    let Some(title_policy) = revision_title_policy(&revision) else {
      return Ok(None);
    };
    project_revision_labels(&mut entry, &revision, instance.locale_hash.as_deref());
    let availability = availability_from_instance(Some(&instance));
    let score = 1000 + availability.bonus;
    let mut reasons = vec![TemplateSuggestionReason::WorkspacePolicy];
    reasons.extend(availability.reasons.clone());
    Ok(Some(suggestion_item(
      entry,
      &policy,
      availability,
      Some(title_policy),
      Some(revision.id),
      score,
      reasons,
    )))
  }

  #[instrument(
    skip(self, request),
    fields(
      workspace_id = %request.workspace_id,
      user_id = ?request.user_id,
      surface = ?request.surface,
      document_type_id = ?request.document_type_id,
      status_id = ?request.status_id,
      classification_id = ?request.classification_id,
    ),
    err
  )]
  pub async fn suggest(
    &self,
    request: TemplateSuggestionRequest,
  ) -> Result<TemplateSuggestionResult, TemplateSuggestionError> {
    validate_request(&request)?;
    if let (Some(permission), Some(user_id)) = (&self.permission_service, request.user_id) {
      permission
        .assert_template_catalog_read(user_id, request.workspace_id)
        .await
        .map_err(|_| TemplateSuggestionError::WorkspaceForbidden)?;
    }
    if request.surface == TemplateSuggestionSurface::Library {
      return self.suggest_library(&request).await;
    }
    if request.library.is_some() {
      return Err(TemplateSuggestionError::InputInvalid(
        "library filter requires Library surface".into(),
      ));
    }
    self.suggest_contextual(&request).await
  }

  // In-memory fixture oracle for the existing ranking assertions. Production
  // contextual reads use the Store page projection, never this per-entry path.
  #[cfg(test)]
  async fn fixture_suggest(
    &self,
    request: TemplateSuggestionRequest,
  ) -> Result<TemplateSuggestionResult, TemplateSuggestionError> {
    let started = Instant::now();
    validate_request(&request)?;
    if let (Some(permission), Some(user_id)) = (&self.permission_service, request.user_id) {
      permission
        .assert_template_catalog_read(user_id, request.workspace_id)
        .await
        .map_err(|_| TemplateSuggestionError::WorkspaceForbidden)?;
    }

    if request.surface == TemplateSuggestionSurface::Library {
      return self.suggest_library(&request).await;
    }
    if request.library.is_some() {
      return Err(TemplateSuggestionError::InputInvalid(
        "library filter requires Library surface".into(),
      ));
    }

    let metadata_matches = self.validate_metadata(&request).await?;
    let guide_deliveries = self.guide_deliveries(&request).await?;
    let mut page_default_replacements = Vec::new();
    for mut replacement in self.registry.page_default_replacements(request.workspace_id).await? {
      if let Some(target) = replacement.replacement_source_doc_id.as_deref()
        && !self.source_document_is_live(&request, Some(target)).await?
      {
        replacement.replacement_source_doc_id = None;
      }
      page_default_replacements.push(replacement);
    }
    let mut candidates = self.collect_candidates(request.workspace_id).await?;
    if candidates.is_empty() {
      let reconcile_required = guide_deliveries.iter().any(|delivery| delivery.pending);
      info!(
        workspace_id = %request.workspace_id,
        surface = ?request.surface,
        candidate_count = 0,
        returned_count = 0,
        reconcile_required,
        duration_ms = started.elapsed().as_millis(),
        "template suggestions returned no candidates"
      );
      return Ok(TemplateSuggestionResult {
        items: Vec::new(),
        reconcile_required,
        guide_deliveries,
        page_default_replacements,
        empty_document_allowed: true,
        stale: false,
        has_next_page: false,
        end_cursor: None,
      });
    }

    let instances = self.instances_by_template(request.workspace_id).await?;
    let reconcile_entries = self
      .registry
      .store
      .list_builtin_reconcile_entries(request.workspace_id, request.locale.as_str())
      .await?;
    let reconcile_by_slug: HashMap<_, _> = reconcile_entries
      .into_iter()
      .map(|entry| (entry.slug.clone(), entry))
      .collect();

    let candidate_count = candidates.len();
    let mut items = Vec::new();
    for candidate in candidates.drain(..) {
      let Some(entry) = self.registry.store.get_catalog_entry(candidate.template_id).await? else {
        continue;
      };
      if entry.status != TemplateStatus::Active {
        continue;
      }
      // The unconverted builtin bridge still carries its guide role in this
      // category. File-backed revisions use purpose independently of category.
      if entry.source == TemplateSource::Builtin && entry.category.as_deref() == Some("onboarding") {
        continue;
      }
      if !surface_allows_category(request.surface, entry.category.as_deref()) {
        continue;
      }
      if !self.revision_is_usable(&entry, &candidate.policy).await? {
        continue;
      }
      let instance = instances.get(&entry_id_for_lookup(&entry));
      let reconcile_entry = reconcile_by_slug.get(entry.slug.as_str());
      if instance.is_some_and(|instance| instance.state == InstanceState::Retired)
        || reconcile_entry
          .and_then(|entry| entry.current_instance.as_ref())
          .is_some_and(|instance| instance.state == InstanceState::Retired)
      {
        continue;
      }
      let Some(item) = self
        .materialize_item(
          &request,
          &metadata_matches,
          entry,
          &candidate.policy,
          instance,
          reconcile_entry,
        )
        .await?
      else {
        continue;
      };
      items.push(item);
    }

    items.sort_by(|a, b| {
      b.available
        .cmp(&a.available)
        .then_with(|| b.score.cmp(&a.score))
        .then_with(|| a.title.cmp(&b.title))
        .then_with(|| a.slug.cmp(&b.slug))
        .then_with(|| a.template_id.cmp(&b.template_id))
    });
    let mut visible_doc_keys = std::collections::HashSet::new();
    items.retain(|item| {
      item
        .template_doc_id
        .as_ref()
        .is_none_or(|doc_key| visible_doc_keys.insert(doc_key.clone()))
    });
    let start = match request.after.as_deref() {
      Some(cursor) => {
        let template_id = decode_suggestion_cursor(cursor)?.to_string();
        items
          .iter()
          .position(|item| item.template_id == template_id)
          .ok_or_else(|| TemplateSuggestionError::InputInvalid("after".to_string()))?
          + 1
      }
      None => 0,
    };
    let first = request.first.unwrap_or(DEFAULT_FIRST);
    let has_next_page = items.len() > start.saturating_add(first);
    items = items.into_iter().skip(start).take(first).collect();
    let end_cursor = items
      .last()
      .map(|item| {
        Uuid::parse_str(&item.template_id)
          .map(encode_suggestion_cursor)
          .map_err(|_| TemplateSuggestionError::Unavailable)
      })
      .transpose()?;
    let reconcile_required = guide_deliveries.iter().any(|delivery| delivery.pending)
      || items
        .iter()
        .any(|item| item.reasons.contains(&TemplateSuggestionReason::ReconcileRequired));

    info!(
      workspace_id = %request.workspace_id,
      surface = ?request.surface,
      candidate_count,
      returned_count = items.len(),
      reconcile_required,
      duration_ms = started.elapsed().as_millis(),
      "template suggestions computed"
    );
    Ok(TemplateSuggestionResult {
      items,
      guide_deliveries,
      page_default_replacements,
      empty_document_allowed: true,
      reconcile_required,
      stale: false,
      has_next_page,
      end_cursor,
    })
  }

  /// Reuse the Registry's actual revision/binding and existing document ACL.
  /// Reading this projection does not seed, copy or refresh reader content.
  #[cfg(test)]
  async fn guide_deliveries(
    &self,
    request: &TemplateSuggestionRequest,
  ) -> Result<Vec<TemplateGuideDelivery>, TemplateSuggestionError> {
    let policies = self
      .registry
      .store
      .list_policies_for_workspace(request.workspace_id)
      .await?;
    let instances = self.instances_by_template(request.workspace_id).await?;
    let mut identities: std::collections::BTreeSet<_> = instances.keys().copied().collect();
    identities.extend(policies.iter().map(|policy| policy.template_id));
    let mut deliveries = Vec::new();
    for id in identities {
      let Some(entry) = self.registry.store.get_catalog_entry(id).await? else {
        continue;
      };
      if entry.source != TemplateSource::Bundle {
        continue;
      }
      let instance = instances.get(&id);
      let policy = policies.iter().find(|policy| policy.template_id == id);
      let revision = if let Some(instance) = instance {
        self.registry.store.get_revision(instance.revision_id).await?
      } else if let Some(revision) = policy.and_then(|policy| policy.selected_revision_id) {
        self.registry.store.get_revision(revision).await?
      } else {
        self.registry.store.get_latest_published_revision(id).await?
      };
      if !revision.as_ref().is_some_and(super::revision_is_guide) {
        continue;
      }
      let key = instance.and_then(|instance| {
        instance
          .workspace_doc_key
          .clone()
          .or_else(|| instance.workspace_doc_id.map(|id| id.to_string()))
      });
      let mut document_id = None;
      if let Some(key) = key.as_deref()
        && let Some(doc_id) = self.registry.resolve_workspace_doc_key(request.workspace_id, key).await
        && let Some(doc_service) = &self.registry.doc_service
        && let Some(doc) = doc_service.get_metadata(doc_id).await?
        && doc.deleted_at.is_none()
        && !doc.is_workspace_root
        && doc.workspace_id == Some(request.workspace_id)
        && self.can_read_template_doc(request, Some(key)).await
      {
        document_id = Some(key.to_string());
      }
      // A retained missing/deleted binding suppresses another automatic copy.
      // Only unmaterialized or failed-before-creation delivery is pending.
      let pending = policy.is_some_and(|policy| policy.is_enabled)
        && entry.status == TemplateStatus::Active
        && instance.is_none_or(|instance| instance.state == InstanceState::Error && key.is_none());
      deliveries.push(TemplateGuideDelivery {
        slug: entry.slug,
        document_id,
        pending,
      });
    }
    deliveries.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(deliveries)
  }

  async fn collect_candidates(&self, workspace_id: WorkspaceId) -> Result<Vec<Candidate>, TemplateSuggestionError> {
    let mut by_template = HashMap::<TemplateCatalogEntryId, Candidate>::new();
    for policy in self.registry.store.list_policies_for_workspace(workspace_id).await? {
      if !policy.is_enabled {
        continue;
      }
      by_template.insert(
        policy.template_id,
        Candidate {
          template_id: policy.template_id,
          policy,
        },
      );
    }
    Ok(by_template.into_values().collect())
  }

  async fn instances_by_template(
    &self,
    workspace_id: WorkspaceId,
  ) -> Result<HashMap<TemplateCatalogEntryId, WorkspaceTemplateInstance>, TemplateSuggestionError> {
    Ok(
      self
        .registry
        .store
        .list_instances_for_workspace(workspace_id)
        .await?
        .into_iter()
        .map(|instance| (instance.template_id, instance))
        .collect(),
    )
  }

  #[cfg(test)]
  async fn revision_is_usable(
    &self,
    entry: &TemplateCatalogEntry,
    policy: &WorkspaceTemplatePolicy,
  ) -> Result<bool, TemplateSuggestionError> {
    if entry.source == TemplateSource::Builtin {
      return Ok(entry.builder_version.is_some());
    }
    let revision = match (policy.selection_mode == SelectionMode::PinnedRevision)
      .then_some(policy.selected_revision_id)
      .flatten()
    {
      Some(revision_id) => self.registry.store.get_revision(revision_id).await?,
      None => self.registry.store.get_latest_published_revision(entry.id).await?,
    };
    Ok(revision.is_some_and(|revision| {
      revision.template_id == entry.id
        && !super::revision_is_guide(&revision)
        && (revision.state == RevisionState::Published
          || (policy.selection_mode == SelectionMode::PinnedRevision && revision.state == RevisionState::Deprecated))
    }))
  }

  #[cfg(test)]
  async fn materialize_item(
    &self,
    request: &TemplateSuggestionRequest,
    metadata_matches: &MetadataMatches,
    mut entry: TemplateCatalogEntry,
    policy: &WorkspaceTemplatePolicy,
    instance: Option<&WorkspaceTemplateInstance>,
    reconcile_entry: Option<&BuiltinReconcileEntry>,
  ) -> Result<Option<TemplateSuggestionItem>, TemplateSuggestionError> {
    if entry.source == TemplateSource::Builtin {
      if entry.builder_version.is_none() {
        return Ok(None);
      }
    }

    let mut score = 1000;
    let mut reasons = vec![TemplateSuggestionReason::WorkspacePolicy];
    if surface_category_matches(request.surface, entry.category.as_deref()) {
      score += 200;
      reasons.push(TemplateSuggestionReason::SurfaceCategory);
    }
    apply_metadata_score(
      &mut score,
      &mut reasons,
      &entry.tags,
      metadata_matches.document_type_id,
      "document-type",
      80,
      TemplateSuggestionReason::MetadataDocumentType,
    );
    apply_metadata_score(
      &mut score,
      &mut reasons,
      &entry.tags,
      metadata_matches.status_id,
      "status",
      40,
      TemplateSuggestionReason::MetadataStatus,
    );
    apply_metadata_score(
      &mut score,
      &mut reasons,
      &entry.tags,
      metadata_matches.classification_id,
      "classification",
      40,
      TemplateSuggestionReason::MetadataClassification,
    );

    let availability = if entry.min_client_version > request.client_version {
      Availability {
        template_doc_id: None,
        instance_state: instance.map(|value| value.state.to_string()),
        available: false,
        bonus: 0,
        reasons: vec![TemplateSuggestionReason::IncompatibleClient],
      }
    } else if entry.source == TemplateSource::Builtin {
      availability_from_builtin(reconcile_entry)
    } else {
      availability_from_instance(instance)
    };
    let source_unavailable = availability.template_doc_id.is_some()
      && !self
        .source_document_is_live(request, availability.template_doc_id.as_deref())
        .await?;
    if source_unavailable {
      return Ok(None);
    }
    score += availability.bonus;
    reasons.extend(availability.reasons.iter().cloned());

    let (title_policy, source_revision_id) = if entry.source == TemplateSource::Bundle {
      let revision = match instance.map(|value| value.revision_id).or_else(|| {
        (policy.selection_mode == SelectionMode::PinnedRevision)
          .then_some(policy.selected_revision_id)
          .flatten()
      }) {
        Some(id) => self.registry.store.get_revision(id).await?,
        None => self.registry.store.get_latest_published_revision(entry.id).await?,
      };
      let Some(revision) = revision.filter(|value| value.template_id == entry.id) else {
        return Ok(None);
      };
      // Database row revisions and older normalized sources need not contain a
      // full native bundle manifest. Only the optional application policy is
      // projected here; malformed declared policies fail closed.
      if super::revision_is_guide(&revision) {
        return Ok(None);
      }
      let Some(title_policy) = revision_title_policy(&revision) else {
        return Ok(None);
      };
      project_revision_labels(
        &mut entry,
        &revision,
        instance.and_then(|value| value.locale_hash.as_deref()),
      );
      (Some(title_policy), Some(revision.id))
    } else {
      (None, None)
    };

    Ok(Some(suggestion_item(
      entry,
      policy,
      availability,
      title_policy,
      source_revision_id,
      score,
      reasons,
    )))
  }

  /// Catalog admission is already resolved. Validate only the assigned source's
  /// workspace identity and live lifecycle, never a per-source user grant.
  #[cfg(test)]
  async fn source_document_is_live(
    &self,
    request: &TemplateSuggestionRequest,
    key: Option<&str>,
  ) -> crate::auth::AuthResult<bool> {
    let Some(key) = key else {
      return Ok(true);
    };
    let Some(documents) = &self.registry.doc_service else {
      return Ok(self.permission_service.is_none());
    };
    // A storage failure must not be interpreted as a withdrawn replacement and
    // clear a durable preference. External keys take precedence over UUID aliases.
    let doc_id = documents
      .store()
      .resolve_external_doc_id(request.workspace_id, crate::doc::DocSpaceKind::Workspace, key)
      .await?
      .or_else(|| key.parse().ok());
    let Some(doc_id) = doc_id else {
      return Ok(false);
    };
    Ok(documents.get_metadata(doc_id).await?.is_some_and(|doc| {
      doc.workspace_id == Some(request.workspace_id)
        && !doc.blocked
        && doc.deleted_at.is_none()
        && !doc.is_workspace_root
    }))
  }

  #[cfg(test)]
  async fn can_read_template_doc(&self, request: &TemplateSuggestionRequest, doc_id: Option<&str>) -> bool {
    let Some(doc_id) = doc_id else {
      return true;
    };
    let (Some(permission), Some(user_id)) = (&self.permission_service, request.user_id) else {
      return true;
    };

    // `workspace_doc_key` is the client-visible external id for modern docs,
    // while older/materialized rows may still expose the internal UUID. The
    // permission service only accepts the latter, so resolve external keys at
    // the identity boundary instead of treating every non-UUID key as a
    // redaction. This keeps the picker usable without weakening authorization.
    let Some(doc_id) = self
      .registry
      .resolve_workspace_doc_key(request.workspace_id, doc_id)
      .await
    else {
      return false;
    };
    permission
      .can(
        &DocResource {
          user_id,
          workspace_id: request.workspace_id,
          doc_id,
        },
        DocAction::Read,
      )
      .await
  }

  async fn validate_metadata(
    &self,
    request: &TemplateSuggestionRequest,
  ) -> Result<MetadataMatches, TemplateSuggestionError> {
    let mut matches = MetadataMatches::default();
    let Some(repo) = &self.metadata_policy_repo else {
      matches.document_type_id = request.document_type_id;
      matches.status_id = request.status_id;
      matches.classification_id = request.classification_id;
      return Ok(matches);
    };
    if let Some(id) = request.document_type_id {
      let document_types = repo.list_document_types().await?;
      if !active_document_type_contains(&document_types, id) {
        return Err(TemplateSuggestionError::MetadataInvalid("documentTypeId".to_string()));
      }
      matches.document_type_id = Some(id);
    }
    if let Some(id) = request.classification_id {
      let values = repo.list_metadata_value_definitions("classification").await?;
      if !active_value_definition_contains(&values, id) {
        return Err(TemplateSuggestionError::MetadataInvalid("classificationId".to_string()));
      }
      matches.classification_id = Some(id);
    }
    if let Some(id) = request.status_id {
      let schema_keys = repo
        .list_status_schemas()
        .await?
        .into_iter()
        .filter(|schema| schema.is_active)
        .map(|schema| schema.key)
        .collect::<Vec<_>>();
      let mut found = false;
      for schema_key in schema_keys {
        let values = repo.list_status_values(schema_key.as_str()).await?;
        if active_status_contains(&values, id) {
          found = true;
          break;
        }
      }
      if !found {
        return Err(TemplateSuggestionError::MetadataInvalid("statusId".to_string()));
      }
      matches.status_id = Some(id);
    }
    Ok(matches)
  }
}

#[derive(Debug, Clone)]
struct Candidate {
  template_id: TemplateCatalogEntryId,
  policy: WorkspaceTemplatePolicy,
}

#[derive(Debug, Clone, Default)]
struct MetadataMatches {
  document_type_id: Option<Uuid>,
  status_id: Option<Uuid>,
  classification_id: Option<Uuid>,
}

struct Availability {
  template_doc_id: Option<String>,
  instance_state: Option<String>,
  available: bool,
  bonus: i32,
  reasons: Vec<TemplateSuggestionReason>,
}

fn validate_request(request: &TemplateSuggestionRequest) -> Result<(), TemplateSuggestionError> {
  if request.locale.trim().is_empty() || request.locale.len() > 64 {
    return Err(TemplateSuggestionError::InputInvalid("locale".to_string()));
  }
  Ok(())
}

fn encode_suggestion_cursor(template_id: TemplateCatalogEntryId) -> String {
  URL_SAFE_NO_PAD.encode(template_id.as_bytes())
}

fn decode_suggestion_cursor(cursor: &str) -> Result<TemplateCatalogEntryId, TemplateSuggestionError> {
  let bytes = URL_SAFE_NO_PAD
    .decode(cursor)
    .map_err(|_| TemplateSuggestionError::InputInvalid("after".to_string()))?;
  Uuid::from_slice(&bytes).map_err(|_| TemplateSuggestionError::InputInvalid("after".to_string()))
}

#[cfg(test)]
fn entry_id_for_lookup(entry: &TemplateCatalogEntry) -> TemplateCatalogEntryId {
  entry.id
}

#[cfg(test)]
fn surface_allows_category(surface: TemplateSuggestionSurface, category: Option<&str>) -> bool {
  if is_building_block_category(category) {
    return surface == TemplateSuggestionSurface::BuildingBlock;
  }
  match surface {
    TemplateSuggestionSurface::Library => true,
    TemplateSuggestionSurface::BuildingBlock => false,
    TemplateSuggestionSurface::JournalOnboarding | TemplateSuggestionSurface::JournalSidebarFooter => {
      category == Some("journal-daily")
    }
    TemplateSuggestionSurface::SidebarNewPage
    | TemplateSuggestionSurface::AllPagesNewPage
    | TemplateSuggestionSurface::CollectionNewPage
    | TemplateSuggestionSurface::DatabaseRowTemplate
    | TemplateSuggestionSurface::StarterBar => true,
  }
}

#[cfg(test)]
fn surface_category_matches(surface: TemplateSuggestionSurface, category: Option<&str>) -> bool {
  surface_allows_category(surface, category)
}

fn apply_metadata_score(
  score: &mut i32,
  reasons: &mut Vec<TemplateSuggestionReason>,
  tags: &[String],
  id: Option<Uuid>,
  prefix: &str,
  bonus: i32,
  reason: TemplateSuggestionReason,
) {
  let Some(id) = id else {
    return;
  };
  let wanted = format!("{prefix}:{id}");
  if tags.iter().any(|tag| tag == &wanted) {
    *score += bonus;
    reasons.push(reason);
  }
}

fn revision_title_policy(
  revision: &myoxus_domain::template_registry::TemplateRevision,
) -> Option<super::bundle::TitlePolicy> {
  match revision.manifest.as_ref().and_then(|value| value.get("title_policy")) {
    Some(value) => serde_json::from_value::<Option<super::bundle::TitlePolicy>>(value.clone())
      .ok()
      .map(|policy| policy.unwrap_or(super::bundle::TitlePolicy::Template)),
    None => Some(super::bundle::TitlePolicy::Template),
  }
}

fn project_revision_labels(
  entry: &mut TemplateCatalogEntry,
  revision: &myoxus_domain::template_registry::TemplateRevision,
  content_locale: Option<&str>,
) {
  let Some(manifest) = revision
    .manifest
    .as_ref()
    .and_then(|value| serde_json::from_value::<super::bundle::Manifest>(value.clone()).ok())
  else {
    return;
  };
  // Labels describe the materialized revision in its persisted content language;
  // switching the interface language must not relabel a different native body.
  let locale = manifest.select_locale(content_locale.unwrap_or_default());
  let localized = manifest.localized_contents.get(&locale);
  entry.title = localized.map_or(manifest.title.clone(), |value| value.title.clone());
  entry.description = localized.map_or(manifest.description, |value| value.description.clone());
}

fn suggestion_item(
  entry: TemplateCatalogEntry,
  policy: &WorkspaceTemplatePolicy,
  availability: Availability,
  title_policy: Option<super::bundle::TitlePolicy>,
  source_revision_id: Option<myoxus_domain::template_registry::TemplateRevisionId>,
  score: i32,
  reasons: Vec<TemplateSuggestionReason>,
) -> TemplateSuggestionItem {
  TemplateSuggestionItem {
    template_id: entry.id.to_string(),
    template_doc_id: availability.template_doc_id,
    slug: entry.slug,
    title: entry.title,
    description: entry.description,
    source: entry.source.to_string(),
    updated_at: entry.updated_at,
    category: entry.category,
    title_policy,
    source_revision_id,
    tags: entry.tags,
    score,
    reasons,
    instance_state: availability.instance_state,
    available: availability.available,
    protected_source: matches!(
      policy.provisioning_mode,
      ProvisioningMode::ManagedUntilLocalEdit | ProvisioningMode::ManualUpdate
    ),
  }
}

fn availability_from_instance(instance: Option<&WorkspaceTemplateInstance>) -> Availability {
  let Some(instance) = instance else {
    return Availability {
      template_doc_id: None,
      instance_state: None,
      available: false,
      bonus: 0,
      reasons: vec![
        TemplateSuggestionReason::ReconcileRequired,
        TemplateSuggestionReason::Preparing,
      ],
    };
  };
  availability_from_state(
    Some(instance.state),
    instance.workspace_doc_key.clone(),
    Some(instance.state.to_string()),
  )
}

#[cfg(test)]
fn availability_from_builtin(entry: Option<&BuiltinReconcileEntry>) -> Availability {
  let Some(entry) = entry else {
    return Availability {
      template_doc_id: None,
      instance_state: None,
      available: false,
      bonus: 0,
      reasons: vec![
        TemplateSuggestionReason::ReconcileRequired,
        TemplateSuggestionReason::Preparing,
      ],
    };
  };
  let instance = entry.current_instance.as_ref();
  availability_from_state(
    instance.map(|instance| instance.state),
    instance
      .filter(|instance| instance.source_available)
      .and_then(|instance| instance.workspace_doc_key.clone()),
    entry
      .current_instance
      .as_ref()
      .map(|instance| instance.state.to_string()),
  )
}

fn availability_from_state(
  state: Option<InstanceState>,
  doc_key: Option<String>,
  instance_state: Option<String>,
) -> Availability {
  match state {
    Some(InstanceState::Ok) if doc_key.is_some() => Availability {
      template_doc_id: doc_key,
      instance_state,
      available: true,
      bonus: 30,
      reasons: vec![TemplateSuggestionReason::InstanceOk],
    },
    Some(InstanceState::UpdateAvailable) if doc_key.is_some() => Availability {
      template_doc_id: doc_key,
      instance_state,
      available: true,
      bonus: 20,
      reasons: vec![TemplateSuggestionReason::UpdateAvailable],
    },
    Some(InstanceState::Detached) if doc_key.is_some() => Availability {
      template_doc_id: doc_key,
      instance_state,
      available: true,
      bonus: 10,
      reasons: vec![TemplateSuggestionReason::Detached],
    },
    Some(InstanceState::Error) => Availability {
      template_doc_id: None,
      instance_state,
      available: false,
      bonus: 0,
      reasons: vec![
        TemplateSuggestionReason::InstanceError,
        TemplateSuggestionReason::RetryableFailure,
      ],
    },
    Some(InstanceState::Retired) => Availability {
      template_doc_id: None,
      instance_state,
      available: false,
      bonus: 0,
      reasons: vec![
        TemplateSuggestionReason::ReconcileRequired,
        TemplateSuggestionReason::SourceMissing,
      ],
    },
    _ => Availability {
      template_doc_id: None,
      instance_state,
      available: false,
      bonus: 0,
      reasons: vec![
        TemplateSuggestionReason::ReconcileRequired,
        TemplateSuggestionReason::SourceMissing,
      ],
    },
  }
}

fn active_document_type_contains(values: &[DocumentTypeDefinition], id: Uuid) -> bool {
  values.iter().any(|value| value.id == id && value.is_active)
}

fn active_value_definition_contains(values: &[DocumentMetadataValueDefinition], id: Uuid) -> bool {
  values.iter().any(|value| value.id == id && value.is_active)
}

fn active_status_contains(values: &[DocumentStatusValue], id: Uuid) -> bool {
  values.iter().any(|value| value.id == id && value.is_active)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::auth::AuthResult;
  use async_trait::async_trait;
  use chrono::Utc;
  use myoxus_domain::ids::DocId;
  use myoxus_domain::template_registry::{
    BuiltinInstanceState, ProvisioningMode, TemplateDefaultPolicy, TemplateRevision, TemplateRevisionId,
    WorkspaceTemplateInstanceId,
  };
  use tokio::sync::Mutex;

  #[derive(Default)]
  struct SuggestionStore {
    entries: Mutex<HashMap<TemplateCatalogEntryId, TemplateCatalogEntry>>,
    revisions: Mutex<HashMap<TemplateRevisionId, TemplateRevision>>,
    policies: Mutex<Vec<WorkspaceTemplatePolicy>>,
    defaults: Mutex<Vec<TemplateDefaultPolicy>>,
    instances: Mutex<Vec<WorkspaceTemplateInstance>>,
    reconcile_entries: Mutex<Vec<BuiltinReconcileEntry>>,
    created_instances: Mutex<usize>,
  }

  #[async_trait]
  impl super::super::TemplateRegistryStore for SuggestionStore {
    async fn contextual_template_page(
      &self,
      query: &ContextualTemplateQuery,
    ) -> crate::auth::AuthResult<ContextualTemplatePage> {
      // Reuse the former in-memory ranking oracle while exercising the public
      // service's bounded Store boundary. No production fallback uses this path.
      let store = Arc::new(Self {
        entries: Mutex::new(self.entries.lock().await.clone()),
        revisions: Mutex::new(self.revisions.lock().await.clone()),
        policies: Mutex::new(self.policies.lock().await.clone()),
        defaults: Mutex::new(self.defaults.lock().await.clone()),
        instances: Mutex::new(self.instances.lock().await.clone()),
        reconcile_entries: Mutex::new(self.reconcile_entries.lock().await.clone()),
        created_instances: Mutex::new(0),
      });
      let service = service(store).await;
      let surface = match query.category {
        Some("building-blocks") => TemplateSuggestionSurface::BuildingBlock,
        Some("journal-daily") => TemplateSuggestionSurface::JournalOnboarding,
        _ => TemplateSuggestionSurface::AllPagesNewPage,
      };
      let mut request = request(query.workspace_id, surface);
      request.client_version = query.client_version;
      request.first = Some(query.limit);
      request.after = query.after.map(encode_suggestion_cursor);
      for (tag, _) in &query.tag_bonuses {
        if let Some((prefix, id)) = tag.split_once(':') {
          let id = Uuid::parse_str(id).ok();
          match prefix {
            "document-type" => request.document_type_id = id,
            "status" => request.status_id = id,
            "classification" => request.classification_id = id,
            _ => {}
          }
        }
      }
      let result = match service.fixture_suggest(request).await {
        Ok(result) => result,
        Err(TemplateSuggestionError::InputInvalid(_)) => {
          return Ok(ContextualTemplatePage {
            sources: Vec::new(),
            cursor_valid: false,
          });
        }
        Err(error) => return Err(AuthError::Storage(error.to_string())),
      };
      let sources = result
        .items
        .into_iter()
        .map(|item| ContextualTemplateSource {
          template_id: Uuid::parse_str(&item.template_id).unwrap(),
          document_key: item.template_doc_id,
          slug: item.slug,
          title: item.title,
          description: item.description,
          source: item.source,
          updated_at: item.updated_at,
          category: item.category,
          tags: item.tags,
          title_policy: item.title_policy,
          revision_id: item.source_revision_id,
          state: item.instance_state.as_deref().map(|state| match state {
            "Ok" => InstanceState::Ok,
            "UpdateAvailable" => InstanceState::UpdateAvailable,
            "Detached" => InstanceState::Detached,
            "Error" => InstanceState::Error,
            _ => InstanceState::Retired,
          }),
          incompatible: item.reasons.contains(&TemplateSuggestionReason::IncompatibleClient),
          protected_source: item.protected_source,
          score: item.score,
        })
        .collect();
      Ok(ContextualTemplatePage {
        sources,
        cursor_valid: true,
      })
    }
    async fn contextual_guide_deliveries(
      &self,
      _workspace: WorkspaceId,
    ) -> crate::auth::AuthResult<Vec<ContextualGuideDelivery>> {
      Ok(Vec::new())
    }
    async fn contextual_page_default_replacements(
      &self,
      _workspace: WorkspaceId,
    ) -> crate::auth::AuthResult<Vec<TemplatePageDefaultReplacement>> {
      Ok(Vec::new())
    }
    async fn create_catalog_entry(&self, _entry: &TemplateCatalogEntry) -> Result<(), AuthError> {
      *self.created_instances.lock().await += 1;
      Ok(())
    }

    async fn get_catalog_entry(&self, id: TemplateCatalogEntryId) -> Result<Option<TemplateCatalogEntry>, AuthError> {
      Ok(self.entries.lock().await.get(&id).cloned())
    }

    async fn get_catalog_entry_by_slug(&self, _slug: &str) -> Result<Option<TemplateCatalogEntry>, AuthError> {
      Ok(None)
    }

    async fn list_catalog_entries(
      &self,
      _status_filter: Option<TemplateStatus>,
      _skip: i64,
      _take: i64,
    ) -> Result<Vec<TemplateCatalogEntry>, AuthError> {
      Ok(self.entries.lock().await.values().cloned().collect())
    }

    async fn count_catalog_entries(&self, _status_filter: Option<TemplateStatus>) -> Result<i64, AuthError> {
      Ok(self.entries.lock().await.len() as i64)
    }

    async fn commit_catalog_transition(
      &self,
      _id: TemplateCatalogEntryId,
      _status: TemplateStatus,
      _allow_already_active: bool,
    ) -> Result<TemplateCatalogEntry, AuthError> {
      Err(AuthError::Storage(
        "catalog transitions are unavailable in the read-only suggestion fixture".into(),
      ))
    }

    async fn update_catalog_entry(&self, _entry: &TemplateCatalogEntry) -> Result<(), AuthError> {
      Ok(())
    }

    async fn create_audit_event(
      &self,
      _event: &myoxus_domain::template_registry::TemplateRegistryAuditEvent,
    ) -> Result<(), AuthError> {
      Ok(())
    }

    async fn list_audit_events(
      &self,
      _filter: Option<super::super::TemplateRegistryAuditEventFilter>,
      _skip: i64,
      _take: i64,
    ) -> Result<Vec<myoxus_domain::template_registry::TemplateRegistryAuditEvent>, AuthError> {
      Ok(Vec::new())
    }

    async fn create_revision(&self, revision: &TemplateRevision) -> Result<(), AuthError> {
      self.revisions.lock().await.insert(revision.id, revision.clone());
      Ok(())
    }

    async fn get_revision(&self, id: TemplateRevisionId) -> Result<Option<TemplateRevision>, AuthError> {
      Ok(self.revisions.lock().await.get(&id).cloned())
    }

    async fn list_revisions(
      &self,
      template_id: TemplateCatalogEntryId,
      _skip: i64,
      _take: i64,
    ) -> Result<Vec<TemplateRevision>, AuthError> {
      Ok(
        self
          .revisions
          .lock()
          .await
          .values()
          .filter(|revision| revision.template_id == template_id)
          .cloned()
          .collect(),
      )
    }

    async fn get_latest_published_revision(
      &self,
      template_id: TemplateCatalogEntryId,
    ) -> Result<Option<TemplateRevision>, AuthError> {
      Ok(
        self
          .revisions
          .lock()
          .await
          .values()
          .filter(|revision| revision.template_id == template_id && revision.state == RevisionState::Published)
          .max_by_key(|revision| revision.created_at)
          .cloned(),
      )
    }

    async fn update_revision(&self, _revision: &TemplateRevision) -> Result<(), AuthError> {
      Ok(())
    }

    async fn create_policy(&self, policy: &WorkspaceTemplatePolicy) -> Result<(), AuthError> {
      self.policies.lock().await.push(policy.clone());
      Ok(())
    }

    async fn get_policy(
      &self,
      _id: myoxus_domain::template_registry::WorkspaceTemplatePolicyId,
    ) -> Result<Option<WorkspaceTemplatePolicy>, AuthError> {
      Ok(None)
    }

    async fn list_policies_for_workspace(
      &self,
      workspace_id: WorkspaceId,
    ) -> Result<Vec<WorkspaceTemplatePolicy>, AuthError> {
      Ok(
        self
          .policies
          .lock()
          .await
          .iter()
          .filter(|policy| policy.workspace_id == workspace_id)
          .cloned()
          .collect(),
      )
    }

    async fn list_policies_for_template(
      &self,
      _template_id: TemplateCatalogEntryId,
    ) -> Result<Vec<WorkspaceTemplatePolicy>, AuthError> {
      Ok(Vec::new())
    }

    async fn update_policy(&self, _policy: &WorkspaceTemplatePolicy) -> Result<(), AuthError> {
      Ok(())
    }

    async fn delete_policy(
      &self,
      _id: myoxus_domain::template_registry::WorkspaceTemplatePolicyId,
    ) -> Result<(), AuthError> {
      Ok(())
    }

    async fn create_instance(&self, instance: &WorkspaceTemplateInstance) -> Result<(), AuthError> {
      self.instances.lock().await.push(instance.clone());
      Ok(())
    }

    async fn get_instance(
      &self,
      _id: WorkspaceTemplateInstanceId,
    ) -> Result<Option<WorkspaceTemplateInstance>, AuthError> {
      Ok(None)
    }

    async fn list_instances_for_workspace(
      &self,
      workspace_id: WorkspaceId,
    ) -> Result<Vec<WorkspaceTemplateInstance>, AuthError> {
      Ok(
        self
          .instances
          .lock()
          .await
          .iter()
          .filter(|instance| instance.workspace_id == workspace_id)
          .cloned()
          .collect(),
      )
    }

    async fn list_instances_for_template(
      &self,
      _template_id: TemplateCatalogEntryId,
    ) -> Result<Vec<WorkspaceTemplateInstance>, AuthError> {
      Ok(Vec::new())
    }

    async fn find_instance(
      &self,
      _workspace_id: WorkspaceId,
      _template_id: TemplateCatalogEntryId,
    ) -> Result<Option<WorkspaceTemplateInstance>, AuthError> {
      Ok(None)
    }

    async fn update_instance(&self, _instance: &WorkspaceTemplateInstance) -> Result<(), AuthError> {
      Ok(())
    }

    async fn create_import_job(
      &self,
      _job: &myoxus_domain::template_registry::TemplateImportJob,
    ) -> Result<(), AuthError> {
      Ok(())
    }

    async fn get_import_job(
      &self,
      _id: myoxus_domain::template_registry::TemplateImportJobId,
    ) -> Result<Option<myoxus_domain::template_registry::TemplateImportJob>, AuthError> {
      Ok(None)
    }

    async fn update_import_job(
      &self,
      _job: &myoxus_domain::template_registry::TemplateImportJob,
    ) -> Result<(), AuthError> {
      Ok(())
    }

    async fn list_import_jobs(
      &self,
      _skip: i64,
      _take: i64,
    ) -> Result<Vec<myoxus_domain::template_registry::TemplateImportJob>, AuthError> {
      Ok(Vec::new())
    }

    async fn create_reconcile_job(
      &self,
      _job: &myoxus_domain::template_registry::TemplateReconcileJob,
    ) -> Result<(), AuthError> {
      Ok(())
    }

    async fn get_reconcile_job(
      &self,
      _id: myoxus_domain::template_registry::TemplateReconcileJobId,
    ) -> Result<Option<myoxus_domain::template_registry::TemplateReconcileJob>, AuthError> {
      Ok(None)
    }

    async fn update_reconcile_job(
      &self,
      _job: &myoxus_domain::template_registry::TemplateReconcileJob,
    ) -> Result<(), AuthError> {
      Ok(())
    }

    async fn list_reconcile_jobs(
      &self,
      _skip: i64,
      _take: i64,
    ) -> Result<Vec<myoxus_domain::template_registry::TemplateReconcileJob>, AuthError> {
      Ok(Vec::new())
    }

    async fn list_distinct_policy_workspace_ids(&self) -> Result<Vec<WorkspaceId>, AuthError> {
      Ok(Vec::new())
    }

    async fn list_distinct_instance_workspace_ids(&self) -> Result<Vec<WorkspaceId>, AuthError> {
      Ok(Vec::new())
    }

    async fn list_default_policies(&self) -> Result<Vec<TemplateDefaultPolicy>, AuthError> {
      Ok(self.defaults.lock().await.clone())
    }

    async fn upsert_default_policy(&self, policy: &TemplateDefaultPolicy) -> Result<(), AuthError> {
      self.defaults.lock().await.push(policy.clone());
      Ok(())
    }

    async fn set_default_policy_apply_flag(
      &self,
      _template_id: TemplateCatalogEntryId,
      _apply: bool,
    ) -> Result<(), AuthError> {
      Ok(())
    }

    async fn workspace_initial_content_policy(
      &self,
      _workspace_id: WorkspaceId,
    ) -> AuthResult<myoxus_domain::entities::WorkspaceInitialContentPolicy> {
      Ok(myoxus_domain::entities::WorkspaceInitialContentPolicy::LegacyDefaults)
    }

    async fn apply_default_policies_to_new_workspace(&self, _workspace_id: WorkspaceId) -> Result<usize, AuthError> {
      Ok(0)
    }

    async fn bump_builder_version(&self, _slug: &str) -> Result<u32, AuthError> {
      Ok(0)
    }

    async fn list_workspaces_with_builtin_slug(&self, _slug: &str) -> Result<Vec<WorkspaceId>, AuthError> {
      Ok(Vec::new())
    }

    async fn list_builtin_reconcile_entries(
      &self,
      _workspace_id: WorkspaceId,
      _locale: &str,
    ) -> Result<Vec<BuiltinReconcileEntry>, AuthError> {
      Ok(self.reconcile_entries.lock().await.clone())
    }

    async fn upsert_builtin_instance_applied(
      &self,
      _workspace_id: WorkspaceId,
      _slug: &str,
      _applied_hash: &str,
      _locale: &str,
      _doc_id: Option<&str>,
    ) -> Result<(), AuthError> {
      Ok(())
    }

    async fn attribute_materialized_document(
      &self,
      _doc_id: DocId,
      _actor_id: UserId,
      _locale: &str,
      _purpose: crate::template_registry::bundle::TemplatePurpose,
    ) -> Result<(), AuthError> {
      Ok(())
    }

    async fn retire_builtin_instance(&self, _workspace_id: WorkspaceId, _slug: &str) -> Result<(), AuthError> {
      Ok(())
    }
  }

  fn entry(id: TemplateCatalogEntryId, slug: &str, title: &str, category: Option<&str>) -> TemplateCatalogEntry {
    TemplateCatalogEntry {
      id,
      slug: slug.to_string(),
      title: title.to_string(),
      description: Some(format!("{title} description")),
      category: category.map(ToOwned::to_owned),
      tags: Vec::new(),
      status: TemplateStatus::Active,
      source: TemplateSource::Bundle,
      builder_version: None,
      min_client_version: 0,
      created_at: Utc::now(),
      updated_at: Utc::now(),
      archived_at: None,
    }
  }

  fn revision(template_id: TemplateCatalogEntryId) -> TemplateRevision {
    // Common fixtures have one revision per template. Instances reference that
    // real identity, matching the PostgreSQL foreign key used by metadata reads.
    TemplateRevision {
      id: template_id,
      template_id,
      version: "1.0.0".to_string(),
      state: RevisionState::Published,
      bundle_blob_id: None,
      preview_blob_id: None,
      checksum: None,
      manifest: None,
      release_notes: None,
      created_by: None,
      created_at: Utc::now(),
      published_at: Some(Utc::now()),
      source_format: "snapshot".to_string(),
      normalizer_version: "test".to_string(),
      detected_format: "snapshot".to_string(),
      ignored_entries_count: 0,
      error_catalog_version: "test".to_string(),
      normalization_warnings: Vec::new(),
    }
  }

  fn policy(workspace_id: WorkspaceId, template_id: TemplateCatalogEntryId) -> WorkspaceTemplatePolicy {
    WorkspaceTemplatePolicy {
      id: Uuid::new_v4(),
      workspace_id,
      template_id,
      selection_mode: SelectionMode::Published,
      selected_revision_id: None,
      provisioning_mode: ProvisioningMode::SeedOnce,
      is_enabled: true,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    }
  }

  fn instance(
    workspace_id: WorkspaceId,
    template_id: TemplateCatalogEntryId,
    state: InstanceState,
    doc_key: Option<&str>,
  ) -> WorkspaceTemplateInstance {
    WorkspaceTemplateInstance {
      id: Uuid::new_v4(),
      workspace_id,
      template_id,
      revision_id: template_id,
      workspace_doc_id: None,
      workspace_doc_key: doc_key.map(ToOwned::to_owned),
      state,
      last_applied_hash: None,
      current_hash: None,
      last_synced_at: None,
      detached_at: None,
      retired_at: None,
      last_error_code: None,
      last_error_message: None,
      expected_hash: None,
      locale_hash: None,
    }
  }

  fn request(workspace_id: WorkspaceId, surface: TemplateSuggestionSurface) -> TemplateSuggestionRequest {
    TemplateSuggestionRequest {
      workspace_id,
      user_id: None,
      surface,
      locale: "en".to_string(),
      client_version: 1,
      document_type_id: None,
      status_id: None,
      classification_id: None,
      mode: None,
      collection_id: None,
      current_doc_id: None,
      first: None,
      after: None,
      library: None,
    }
  }

  async fn service(store: Arc<SuggestionStore>) -> TemplateSuggestionService {
    TemplateSuggestionService::new(Arc::new(TemplateRegistryService::new(store)), None, None)
  }

  #[tokio::test]
  async fn uses_workspace_assignments_without_reapplying_new_workspace_defaults() {
    let workspace_id = Uuid::new_v4();
    let workspace_template = Uuid::new_v4();
    let default_template = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    store.entries.lock().await.insert(
      workspace_template,
      entry(workspace_template, "workspace", "Workspace", Some("project")),
    );
    store.entries.lock().await.insert(
      default_template,
      entry(default_template, "default", "Default", Some("project")),
    );
    store
      .revisions
      .lock()
      .await
      .insert(workspace_template, revision(workspace_template));
    store
      .revisions
      .lock()
      .await
      .insert(default_template, revision(default_template));
    store
      .policies
      .lock()
      .await
      .push(policy(workspace_id, workspace_template));
    store.defaults.lock().await.push(TemplateDefaultPolicy {
      template_id: default_template,
      apply_to_new_workspaces: true,
      selection_mode: SelectionMode::Published,
      provisioning_mode: ProvisioningMode::SeedOnce,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    });
    store.instances.lock().await.push(instance(
      workspace_id,
      workspace_template,
      InstanceState::Ok,
      Some("doc-workspace"),
    ));
    store.instances.lock().await.push(instance(
      workspace_id,
      default_template,
      InstanceState::Ok,
      Some("doc-default"),
    ));

    let result = service(store.clone())
      .await
      .suggest(request(workspace_id, TemplateSuggestionSurface::SidebarNewPage))
      .await
      .expect("suggestions");

    assert_eq!(result.items[0].slug, "workspace");
    assert!(
      result.items[0]
        .reasons
        .contains(&TemplateSuggestionReason::WorkspacePolicy)
    );
    assert_eq!(result.items.len(), 1);
    assert_eq!(*store.created_instances.lock().await, 0);
  }

  #[tokio::test]
  async fn enforces_surface_categories() {
    let workspace_id = Uuid::new_v4();
    let journal = Uuid::new_v4();
    let onboarding = Uuid::new_v4();
    let block = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    for (id, slug, category) in [
      (journal, "journal", Some("journal-daily")),
      (onboarding, "onboarding", Some("onboarding")),
      (block, "block", Some("building-blocks")),
    ] {
      store.entries.lock().await.insert(id, entry(id, slug, slug, category));
      store.revisions.lock().await.insert(id, revision(id));
      store.policies.lock().await.push(policy(workspace_id, id));
      store
        .instances
        .lock()
        .await
        .push(instance(workspace_id, id, InstanceState::Ok, Some(slug)));
    }

    let svc = service(store).await;
    let journal_result = svc
      .suggest(request(workspace_id, TemplateSuggestionSurface::JournalOnboarding))
      .await
      .expect("journal suggestions");
    assert_eq!(
      journal_result
        .items
        .iter()
        .map(|item| item.slug.as_str())
        .collect::<Vec<_>>(),
      vec!["journal"]
    );

    let generic_result = svc
      .suggest(request(workspace_id, TemplateSuggestionSurface::StarterBar))
      .await
      .expect("generic suggestions");
    assert!(
      generic_result.items.iter().any(|item| item.slug == "onboarding"),
      "a reusable bundle's category does not turn it into a guide"
    );
    assert!(generic_result.items.iter().all(|item| item.slug != "block"));
    let blocks = svc
      .suggest(request(workspace_id, TemplateSuggestionSurface::BuildingBlock))
      .await
      .expect("building block suggestions");
    assert_eq!(
      blocks.items.iter().map(|item| item.slug.as_str()).collect::<Vec<_>>(),
      vec!["block"]
    );
  }

  #[tokio::test]
  async fn scores_metadata_tags_only_when_requested() {
    let workspace_id = Uuid::new_v4();
    let doc_type_id = Uuid::new_v4();
    let tagged = Uuid::new_v4();
    let plain = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    let mut tagged_entry = entry(tagged, "tagged", "Tagged", Some("project"));
    tagged_entry.tags = vec![format!("document-type:{doc_type_id}")];
    store.entries.lock().await.insert(tagged, tagged_entry);
    store
      .entries
      .lock()
      .await
      .insert(plain, entry(plain, "plain", "Plain", Some("project")));
    for id in [tagged, plain] {
      store.revisions.lock().await.insert(id, revision(id));
      store.policies.lock().await.push(policy(workspace_id, id));
      store.instances.lock().await.push(instance(
        workspace_id,
        id,
        InstanceState::Ok,
        Some(id.to_string().as_str()),
      ));
    }

    let mut req = request(workspace_id, TemplateSuggestionSurface::AllPagesNewPage);
    req.document_type_id = Some(doc_type_id);
    let result = service(store).await.suggest(req).await.expect("suggestions");
    assert_eq!(result.items[0].slug, "tagged");
    assert!(
      result.items[0]
        .reasons
        .contains(&TemplateSuggestionReason::MetadataDocumentType)
    );
  }

  #[tokio::test]
  async fn exposes_reconcile_required_for_missing_instance() {
    let workspace_id = Uuid::new_v4();
    let template_id = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    store
      .entries
      .lock()
      .await
      .insert(template_id, entry(template_id, "missing", "Missing", Some("project")));
    store.revisions.lock().await.insert(template_id, revision(template_id));
    store.policies.lock().await.push(policy(workspace_id, template_id));

    let result = service(store)
      .await
      .suggest(request(workspace_id, TemplateSuggestionSurface::SidebarNewPage))
      .await
      .expect("suggestions");
    assert!(!result.items[0].available);
    assert!(result.reconcile_required);
    assert!(
      result.items[0]
        .reasons
        .contains(&TemplateSuggestionReason::ReconcileRequired)
    );
  }

  #[tokio::test]
  async fn projects_client_compatibility_and_policy_owned_source_protection() {
    let workspace_id = Uuid::new_v4();
    let template_id = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    let mut catalog_entry = entry(template_id, "future", "Future", Some("project"));
    catalog_entry.min_client_version = 2;
    store.entries.lock().await.insert(template_id, catalog_entry);
    store.revisions.lock().await.insert(template_id, revision(template_id));
    let mut assigned = policy(workspace_id, template_id);
    assigned.provisioning_mode = ProvisioningMode::ManagedUntilLocalEdit;
    store.policies.lock().await.push(assigned);
    store.instances.lock().await.push(instance(
      workspace_id,
      template_id,
      InstanceState::Ok,
      Some("future-doc"),
    ));

    let result = service(store)
      .await
      .suggest(request(workspace_id, TemplateSuggestionSurface::AllPagesNewPage))
      .await
      .expect("suggestions");

    assert_eq!(result.items.len(), 1);
    assert!(!result.items[0].available);
    assert_eq!(result.items[0].template_doc_id, None);
    assert!(result.items[0].protected_source);
    assert!(
      result.items[0]
        .reasons
        .contains(&TemplateSuggestionReason::IncompatibleClient)
    );
  }

  #[tokio::test]
  async fn omits_intentionally_retired_builtin_instances() {
    let workspace_id = Uuid::new_v4();
    let template_id = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    let mut builtin = entry(template_id, "retired", "Retired", Some("meeting"));
    builtin.source = TemplateSource::Builtin;
    builtin.builder_version = Some(2);
    store.entries.lock().await.insert(template_id, builtin);
    store.policies.lock().await.push(policy(workspace_id, template_id));
    store.reconcile_entries.lock().await.push(BuiltinReconcileEntry {
      slug: "retired".to_string(),
      builder_version: 2,
      expected_hash: "hash".to_string(),
      provisioning_mode: ProvisioningMode::SeedOnce,
      current_instance: Some(BuiltinInstanceState {
        state: InstanceState::Retired,
        applied_hash: Some("hash".to_string()),
        locale_hash: Some("en".to_string()),
        source_available: true,
        workspace_doc_key: Some("retired-doc".to_string()),
        workspace_doc_id: None,
      }),
    });

    let result = service(store)
      .await
      .suggest(request(workspace_id, TemplateSuggestionSurface::SidebarNewPage))
      .await
      .expect("suggestions");

    assert!(result.items.is_empty());
    assert!(!result.reconcile_required);
  }

  #[tokio::test]
  async fn supports_builtin_reconcile_state_without_reconcile_side_effect() {
    let workspace_id = Uuid::new_v4();
    let template_id = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    let mut builtin = entry(template_id, "daily", "Daily", Some("journal-daily"));
    builtin.source = TemplateSource::Builtin;
    builtin.builder_version = Some(2);
    store.entries.lock().await.insert(template_id, builtin);
    store.policies.lock().await.push(policy(workspace_id, template_id));
    store.reconcile_entries.lock().await.push(BuiltinReconcileEntry {
      slug: "daily".to_string(),
      builder_version: 2,
      expected_hash: "hash".to_string(),
      provisioning_mode: ProvisioningMode::SeedOnce,
      current_instance: Some(BuiltinInstanceState {
        state: InstanceState::Detached,
        applied_hash: Some("old".to_string()),
        locale_hash: Some("en".to_string()),
        source_available: true,
        workspace_doc_key: Some("doc-daily".to_string()),
        workspace_doc_id: None,
      }),
    });

    let result = service(store.clone())
      .await
      .suggest(request(workspace_id, TemplateSuggestionSurface::JournalSidebarFooter))
      .await
      .expect("suggestions");
    assert_eq!(result.items[0].template_doc_id.as_deref(), Some("doc-daily"));
    assert!(result.items[0].available);
    assert!(result.items[0].reasons.contains(&TemplateSuggestionReason::Detached));
    assert_eq!(*store.created_instances.lock().await, 0);
  }

  #[tokio::test]
  async fn ignores_default_policy_that_does_not_apply_to_new_workspaces() {
    let workspace_id = Uuid::new_v4();
    let template_id = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    store.entries.lock().await.insert(
      template_id,
      entry(template_id, "disabled-default", "Disabled Default", Some("project")),
    );
    store.revisions.lock().await.insert(template_id, revision(template_id));
    store.defaults.lock().await.push(TemplateDefaultPolicy {
      template_id,
      apply_to_new_workspaces: false,
      selection_mode: SelectionMode::Published,
      provisioning_mode: ProvisioningMode::SeedOnce,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    });

    let result = service(store)
      .await
      .suggest(request(workspace_id, TemplateSuggestionSurface::AllPagesNewPage))
      .await
      .expect("suggestions");

    assert!(
      result.items.is_empty(),
      "inactive default policies must not become contextual suggestions"
    );
  }

  #[tokio::test]
  async fn explicit_workspace_disable_wins_over_a_default_policy() {
    let workspace_id = Uuid::new_v4();
    let template_id = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    store
      .entries
      .lock()
      .await
      .insert(template_id, entry(template_id, "disabled", "Disabled", Some("project")));
    store.revisions.lock().await.insert(template_id, revision(template_id));
    let mut disabled = policy(workspace_id, template_id);
    disabled.is_enabled = false;
    store.policies.lock().await.push(disabled);
    store.defaults.lock().await.push(TemplateDefaultPolicy {
      template_id,
      apply_to_new_workspaces: true,
      selection_mode: SelectionMode::Published,
      provisioning_mode: ProvisioningMode::SeedOnce,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    });

    let result = service(store)
      .await
      .suggest(request(workspace_id, TemplateSuggestionSurface::SidebarNewPage))
      .await
      .expect("suggestions");

    assert!(result.items.is_empty());
  }

  #[tokio::test]
  async fn continuation_reaches_entries_beyond_the_first_twenty_without_duplicates() {
    let workspace_id = Uuid::new_v4();
    let store = Arc::new(SuggestionStore::default());
    for index in 0..25 {
      let template_id = Uuid::new_v4();
      let slug = format!("page-{index:02}");
      store.entries.lock().await.insert(
        template_id,
        entry(template_id, &slug, &format!("Page {index:02}"), Some("project")),
      );
      store.revisions.lock().await.insert(template_id, revision(template_id));
      store.policies.lock().await.push(policy(workspace_id, template_id));
      store.instances.lock().await.push(instance(
        workspace_id,
        template_id,
        InstanceState::Ok,
        Some(&format!("doc-{index:02}")),
      ));
    }

    let svc = service(store).await;
    let mut first_request = request(workspace_id, TemplateSuggestionSurface::AllPagesNewPage);
    first_request.first = Some(20);
    let first = svc.suggest(first_request.clone()).await.expect("first page");
    assert_eq!(first.items.len(), 20);
    assert!(first.has_next_page);
    assert!(!first.stale);

    first_request.after = first.end_cursor.clone();
    let second = svc.suggest(first_request).await.expect("second page");
    assert_eq!(second.items.len(), 5);
    assert!(!second.has_next_page);
    let ids = first
      .items
      .iter()
      .chain(second.items.iter())
      .map(|item| &item.template_id)
      .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 25);
  }
}
