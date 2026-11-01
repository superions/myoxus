//! Server-authoritative workspace tag catalog and document assignment service.
//!
//! Catalog lifecycle and document/Database assignment validation share this
//! service. Until the coordinated client cutover, the legacy bootstrap entry
//! still accepts Yjs-derived assignments and can replace existing SQL state.

pub mod migration;
pub mod transfer;

use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Arc;

use chrono::Utc;
use myoxus_domain::database_change::{DatabaseChangeEvent, DatabaseChangeKind};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::ids::{UserId, WorkspaceId};
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::repositories::{PageRequest, RepositoryError};
use myoxus_domain::workspace_tags::{
  WORKSPACE_TAG_DOCUMENT_BATCH_LIMIT, WorkspaceTag, WorkspaceTagAssignmentError, WorkspaceTagCatalogEntry,
  WorkspaceTagColorRole, WorkspaceTagDeletionResult, WorkspaceTagDocumentAssignment, WorkspaceTagDocumentUsage,
  WorkspaceTagRepository, WorkspaceTagSearchRefreshScope, WorkspaceTagValidationError, validate_tag_reference_update,
};
use thiserror::Error;
use tracing::{instrument, warn};
use uuid::Uuid;

use crate::doc::DocCachePort;
use crate::permission::{AccessController, DocResource, PermissionService, WorkspaceResource};
use crate::ports::database_change::{
  DatabaseChangeNotificationPort, NullDatabaseChangeNotification, classify_publish_error,
};

pub const ERR_TAG_INVALID_REQUEST: &str = "MIX_WORKSPACE_TAG_INVALID_REQUEST";
pub const ERR_TAG_INVALID_NAME: &str = "MIX_WORKSPACE_TAG_INVALID_NAME";
pub const ERR_TAG_DUPLICATE_SLUG: &str = "MIX_WORKSPACE_TAG_DUPLICATE_SLUG";
pub const ERR_TAG_INVALID_COLOR: &str = "MIX_WORKSPACE_TAG_INVALID_COLOR";
pub const ERR_TAG_CROSS_WORKSPACE: &str = "MIX_WORKSPACE_TAG_CROSS_WORKSPACE";
pub const ERR_TAG_ARCHIVED_WRITE: &str = "MIX_WORKSPACE_TAG_ARCHIVED_WRITE";
pub const ERR_TAG_FORBIDDEN: &str = "MIX_WORKSPACE_TAG_FORBIDDEN";
pub const ERR_TAG_NOT_FOUND: &str = "MIX_WORKSPACE_TAG_NOT_FOUND";
pub const ERR_TAG_NOT_ARCHIVED: &str = "MIX_WORKSPACE_TAG_NOT_ARCHIVED";
pub const ERR_TAG_STORAGE: &str = "MIX_WORKSPACE_TAG_STORAGE";

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("{code}: {message}")]
pub struct WorkspaceTagServiceError {
  pub code: &'static str,
  pub message: String,
}

impl WorkspaceTagServiceError {
  fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }

  fn from_validation(error: WorkspaceTagValidationError) -> Self {
    match error {
      WorkspaceTagValidationError::InvalidName | WorkspaceTagValidationError::InvalidSlug => {
        Self::new(ERR_TAG_INVALID_NAME, error.to_string())
      }
      WorkspaceTagValidationError::InvalidColorRole => Self::new(ERR_TAG_INVALID_COLOR, error.to_string()),
    }
  }

  fn from_assignment(error: WorkspaceTagAssignmentError) -> Self {
    match error {
      WorkspaceTagAssignmentError::InvalidReferences => Self::new(ERR_TAG_CROSS_WORKSPACE, error.to_string()),
      WorkspaceTagAssignmentError::ArchivedReference => Self::new(ERR_TAG_ARCHIVED_WRITE, error.to_string()),
      WorkspaceTagAssignmentError::Repository(error) => Self::from_repository(error),
    }
  }

  fn from_repository(error: RepositoryError) -> Self {
    match error {
      RepositoryError::NotFound(_) => Self::new(ERR_TAG_NOT_FOUND, "workspace tag not found"),
      RepositoryError::Conflict(_) => Self::new(ERR_TAG_DUPLICATE_SLUG, "workspace tag slug already exists"),
      RepositoryError::Validation(message) => Self::new(ERR_TAG_INVALID_NAME, message),
      RepositoryError::Storage(message) => Self::new(ERR_TAG_STORAGE, message),
    }
  }
}

pub type WorkspaceTagResult<T> = Result<T, WorkspaceTagServiceError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceTagColorNormalization {
  pub source: String,
  pub role: WorkspaceTagColorRole,
  pub normalized: bool,
}

#[derive(Clone)]
pub struct WorkspaceTagService {
  repo: Arc<dyn WorkspaceTagRepository>,
  permission: Arc<PermissionService>,
  doc_cache: Option<Arc<dyn DocCachePort>>,
  database_changes: Arc<dyn DatabaseChangeNotificationPort>,
}

impl WorkspaceTagService {
  pub fn new(repo: Arc<dyn WorkspaceTagRepository>, permission: Arc<PermissionService>) -> Self {
    Self {
      repo,
      permission,
      doc_cache: None,
      database_changes: Arc::new(NullDatabaseChangeNotification),
    }
  }

  /// Attach the same post-commit cache and Database notification owners used
  /// by ordinary document and cell mutations in the current runtime.
  pub fn with_post_commit_effects(
    mut self,
    doc_cache: Option<Arc<dyn DocCachePort>>,
    database_changes: Arc<dyn DatabaseChangeNotificationPort>,
  ) -> Self {
    self.doc_cache = doc_cache;
    self.database_changes = database_changes;
    self
  }

  async fn assert_workspace(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    action: WorkspaceAction,
  ) -> WorkspaceTagResult<()> {
    self
      .permission
      .assert(
        &WorkspaceResource {
          user_id: actor,
          workspace_id,
        },
        action,
      )
      .await
      .map_err(|_| WorkspaceTagServiceError::new(ERR_TAG_FORBIDDEN, "workspace tag action forbidden"))
  }

  async fn refresh_search_projections(&self, workspace_id: WorkspaceId, scope: WorkspaceTagSearchRefreshScope) {
    if let Err(error) = self.repo.refresh_search_projections(workspace_id, scope).await {
      warn!(
        %workspace_id,
        ?scope,
        error = %error,
        "workspace tag search projection refresh failed; authoritative tag mutation remains committed"
      );
    }
  }

  async fn available_slug(
    &self,
    workspace_id: WorkspaceId,
    name: &str,
    current_tag_id: Option<Uuid>,
  ) -> WorkspaceTagResult<String> {
    let base = WorkspaceTag::slug_base(name).map_err(WorkspaceTagServiceError::from_validation)?;
    for suffix in 1..=10_000_u32 {
      let candidate = if suffix == 1 {
        base.clone()
      } else {
        format!("{base}-{suffix}")
      };
      match self
        .repo
        .get_tag_by_slug(workspace_id, &candidate)
        .await
        .map_err(WorkspaceTagServiceError::from_repository)?
      {
        None => return Ok(candidate),
        Some(tag) if Some(tag.id) == current_tag_id => return Ok(candidate),
        Some(_) => {}
      }
    }
    Err(WorkspaceTagServiceError::new(
      ERR_TAG_DUPLICATE_SLUG,
      "workspace tag slug space exhausted",
    ))
  }

  #[instrument(skip(self), fields(%workspace_id, actor_id = %actor, include_archived))]
  pub async fn list_tags(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    include_archived: bool,
  ) -> WorkspaceTagResult<Vec<WorkspaceTag>> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::Read)
      .await?;
    self
      .repo
      .list_tags(workspace_id, include_archived)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)
  }

  /// Read the complete Tag catalog with server-owned aggregate usage totals.
  #[instrument(skip(self), fields(%workspace_id, actor_id = %actor, include_archived))]
  pub async fn list_catalog(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    include_archived: bool,
  ) -> WorkspaceTagResult<Vec<WorkspaceTagCatalogEntry>> {
    // Aggregate counts disclose only the amount of workspace content carrying
    // each Tag. They expose no referenced identities or mutation capability,
    // so ordinary Workspace Read is necessary and sufficient; CreateDoc or an
    // organizer permission would incorrectly exclude read-only members.
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::Read)
      .await?;
    self
      .repo
      .list_tag_catalog(workspace_id, include_archived)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)
  }

  /// Read one bounded catalog page through the same authorization owner used
  /// by full product projections.
  #[instrument(skip(self), fields(%workspace_id, actor_id = %actor, include_archived, limit = page.limit, offset = page.offset))]
  pub async fn list_tags_page(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    include_archived: bool,
    page: PageRequest,
  ) -> WorkspaceTagResult<Vec<WorkspaceTag>> {
    // Tag catalog visibility is ordinary workspace document-metadata
    // visibility. Read is therefore sufficient; CreateDoc/OrganizeUpdate would
    // incorrectly turn a non-mutating catalog read into an editor/admin action.
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::Read)
      .await?;
    self
      .repo
      .list_tags_page(workspace_id, include_archived, page)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)
  }

  #[instrument(skip(self), fields(%workspace_id, actor_id = %actor, %tag_id))]
  pub async fn get_tag(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
  ) -> WorkspaceTagResult<Option<WorkspaceTag>> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::Read)
      .await?;
    self
      .repo
      .get_tag(workspace_id, tag_id)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)
  }

  #[instrument(skip(self, name, description), fields(%workspace_id, actor_id = %actor))]
  pub async fn create_tag(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    name: &str,
    color_role: &str,
    description: Option<String>,
  ) -> WorkspaceTagResult<WorkspaceTag> {
    // Tag lifecycle writes edit workspace-visible document metadata. CreateDoc
    // is the established editor permission for that capability; requiring an
    // organizer/admin action would incorrectly make ordinary Tag authoring an
    // administrative operation. Transport scopes remain an independent MCP
    // concern and are deliberately not interpreted by this service.
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    let name = WorkspaceTag::normalize_name(name).map_err(WorkspaceTagServiceError::from_validation)?;
    let color_role = WorkspaceTagColorRole::from_str(color_role).map_err(WorkspaceTagServiceError::from_validation)?;
    let slug = self.available_slug(workspace_id, &name, None).await?;
    let now = Utc::now();
    let tag = WorkspaceTag {
      id: Uuid::new_v4(),
      workspace_id,
      name,
      slug,
      color_role,
      description: description
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()),
      archived_at: None,
      created_at: now,
      updated_at: now,
      created_by: Some(actor),
      updated_by: Some(actor),
    };
    self
      .repo
      .create_tag(&tag)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)
  }

  #[instrument(skip(self, name), fields(%workspace_id, actor_id = %actor, %tag_id))]
  pub async fn rename_tag(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    name: &str,
  ) -> WorkspaceTagResult<WorkspaceTag> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    let current = self
      .repo
      .get_tag(workspace_id, tag_id)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?
      .ok_or_else(|| WorkspaceTagServiceError::new(ERR_TAG_NOT_FOUND, "workspace tag not found"))?;
    let name = WorkspaceTag::normalize_name(name).map_err(WorkspaceTagServiceError::from_validation)?;
    let slug = if current.archived_at.is_some() {
      WorkspaceTag::slug_base(&name).map_err(WorkspaceTagServiceError::from_validation)?
    } else {
      self.available_slug(workspace_id, &name, Some(tag_id)).await?
    };
    let tag = self
      .repo
      .update_tag_name(workspace_id, tag_id, &name, &slug, actor, Utc::now())
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?;
    self
      .refresh_search_projections(workspace_id, WorkspaceTagSearchRefreshScope::CatalogTag(tag_id))
      .await;
    Ok(tag)
  }

  #[instrument(skip(self, color_role), fields(%workspace_id, actor_id = %actor, %tag_id))]
  pub async fn recolor_tag(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    color_role: &str,
  ) -> WorkspaceTagResult<WorkspaceTag> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    let color_role = WorkspaceTagColorRole::from_str(color_role).map_err(WorkspaceTagServiceError::from_validation)?;
    let tag = self
      .repo
      .update_tag_color(workspace_id, tag_id, color_role, actor, Utc::now())
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?;
    self
      .refresh_search_projections(workspace_id, WorkspaceTagSearchRefreshScope::CatalogTag(tag_id))
      .await;
    Ok(tag)
  }

  #[instrument(skip(self, description), fields(%workspace_id, actor_id = %actor, %tag_id))]
  pub async fn update_description(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    description: Option<String>,
  ) -> WorkspaceTagResult<WorkspaceTag> {
    // Description is part of the same Tag document-metadata lifecycle as
    // create/rename/recolor, so CreateDoc is both necessary and sufficient.
    // Keeping this check in the application owner also prevents MCP or another
    // adapter from bypassing workspace authorization by calling persistence.
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    let description = description
      .map(|value| value.trim().to_string())
      .filter(|value| !value.is_empty());
    let tag = self
      .repo
      .update_tag_description(workspace_id, tag_id, description.as_deref(), actor, Utc::now())
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?;
    Ok(tag)
  }

  #[instrument(skip(self), fields(%workspace_id, actor_id = %actor, %tag_id))]
  pub async fn archive_tag(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
  ) -> WorkspaceTagResult<WorkspaceTag> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    let tag = self
      .repo
      .archive_tag(workspace_id, tag_id, actor, Utc::now())
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?;
    self
      .refresh_search_projections(workspace_id, WorkspaceTagSearchRefreshScope::CatalogTag(tag_id))
      .await;
    Ok(tag)
  }

  #[instrument(skip(self), fields(%workspace_id, actor_id = %actor, %tag_id))]
  pub async fn restore_tag(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
  ) -> WorkspaceTagResult<WorkspaceTag> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    let tag = self
      .repo
      .get_tag(workspace_id, tag_id)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?
      .ok_or_else(|| WorkspaceTagServiceError::new(ERR_TAG_NOT_FOUND, "workspace tag not found"))?;
    let slug = WorkspaceTag::slug_base(&tag.name).map_err(WorkspaceTagServiceError::from_validation)?;
    if self
      .repo
      .get_tag_by_slug(workspace_id, &slug)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?
      .is_some_and(|active| active.id != tag.id)
    {
      return Err(WorkspaceTagServiceError::new(
        ERR_TAG_DUPLICATE_SLUG,
        "an active workspace tag already uses this slug",
      ));
    }
    let restored = self
      .repo
      .restore_tag(workspace_id, tag_id, &slug, actor, Utc::now())
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?;
    self
      .refresh_search_projections(workspace_id, WorkspaceTagSearchRefreshScope::CatalogTag(tag_id))
      .await;
    Ok(restored)
  }

  /// Permanently delete one archived Tag and all of its references.
  #[instrument(skip(self), fields(%workspace_id, actor_id = %actor, %tag_id))]
  pub async fn delete_tag_permanently(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
  ) -> WorkspaceTagResult<WorkspaceTagDeletionResult> {
    // Permanent deletion destroys workspace properties and every remaining
    // reference, so the existing PropertiesDelete capability is necessary.
    // CreateDoc is intentionally insufficient: it owns reversible Tag edits
    // and assignment changes, not irreversible property removal. Keeping this
    // decision here makes GraphQL, MCP and future callers share one authority.
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::PropertiesDelete)
      .await?;
    let tag = self
      .repo
      .get_tag(workspace_id, tag_id)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?
      .ok_or_else(|| WorkspaceTagServiceError::new(ERR_TAG_NOT_FOUND, "workspace tag not found"))?;
    if tag.archived_at.is_none() {
      return Err(WorkspaceTagServiceError::new(
        ERR_TAG_NOT_ARCHIVED,
        "workspace tag must be archived before permanent deletion",
      ));
    }
    let result = match self
      .repo
      .delete_archived_tag(workspace_id, tag_id, actor)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?
    {
      Some(result) => result,
      None => match self
        .repo
        .get_tag(workspace_id, tag_id)
        .await
        .map_err(WorkspaceTagServiceError::from_repository)?
      {
        Some(_) => {
          return Err(WorkspaceTagServiceError::new(
            ERR_TAG_NOT_ARCHIVED,
            "workspace tag must be archived before permanent deletion",
          ));
        }
        None => {
          return Err(WorkspaceTagServiceError::new(
            ERR_TAG_NOT_FOUND,
            "workspace tag not found",
          ));
        }
      },
    };

    self
      .refresh_search_projections(workspace_id, WorkspaceTagSearchRefreshScope::CatalogTag(tag_id))
      .await;
    if let Some(cache) = &self.doc_cache {
      cache.invalidate_snapshot(workspace_id, workspace_id).await;
    }
    for database_id in &result.affected_database_ids {
      let event = DatabaseChangeEvent::new(workspace_id, *database_id, DatabaseChangeKind::CellUpdated, actor);
      if let Err(error) = self.database_changes.publish_tasks_changed(&event).await {
        warn!(%workspace_id, %database_id, class = classify_publish_error(&error),
          "workspace tag deletion committed but Task invalidation publish failed");
      }
      if let Err(error) = self.database_changes.publish_change(&event).await {
        warn!(
          %workspace_id,
          %database_id,
          class = classify_publish_error(&error),
          "workspace tag deletion committed but Database invalidation publish failed"
        );
      }
    }
    Ok(result)
  }

  /// Resolve tag records in caller order, including archived references.
  #[instrument(skip(self, tag_ids), fields(%workspace_id, actor_id = %actor, count = tag_ids.len()))]
  pub async fn resolve_tags(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_ids: &[Uuid],
  ) -> WorkspaceTagResult<Vec<WorkspaceTag>> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::Read)
      .await?;
    self.resolve_tags_unchecked(workspace_id, tag_ids, true).await
  }

  /// Validate a Database/document write without repeating an ACL lookup.
  pub async fn validate_writable_references(
    &self,
    workspace_id: WorkspaceId,
    tag_ids: &[Uuid],
  ) -> WorkspaceTagResult<Vec<WorkspaceTag>> {
    self.validate_reference_update(workspace_id, &[], tag_ids).await
  }

  /// Validate a replacement while preserving readable archived references.
  ///
  /// Archived tags are historical values: callers may retain or remove an
  /// archived id that is already assigned, but may never add it to a value
  /// that did not previously contain it. Centralizing that delta rule keeps
  /// document metadata and Database cells behaviorally identical.
  pub async fn validate_reference_update(
    &self,
    workspace_id: WorkspaceId,
    previous_tag_ids: &[Uuid],
    next_tag_ids: &[Uuid],
  ) -> WorkspaceTagResult<Vec<WorkspaceTag>> {
    let tags = self.resolve_tags_unchecked(workspace_id, next_tag_ids, true).await?;
    validate_tag_reference_update(previous_tag_ids, next_tag_ids, &tags)
      .map_err(WorkspaceTagServiceError::from_assignment)?;
    Ok(tags)
  }

  /// Resolve readable tag records for trusted server-side projections.
  ///
  /// Search workers already operate on authorized workspace data and have no
  /// end-user actor. Keeping this narrow method here avoids bypassing catalog
  /// validation or teaching indexing code about repository internals.
  pub async fn resolve_tags_for_index(
    &self,
    workspace_id: WorkspaceId,
    tag_ids: &[Uuid],
  ) -> WorkspaceTagResult<Vec<WorkspaceTag>> {
    self.resolve_tags_unchecked(workspace_id, tag_ids, true).await
  }

  async fn resolve_tags_unchecked(
    &self,
    workspace_id: WorkspaceId,
    tag_ids: &[Uuid],
    allow_archived: bool,
  ) -> WorkspaceTagResult<Vec<WorkspaceTag>> {
    let mut seen = HashSet::with_capacity(tag_ids.len());
    if !tag_ids.iter().all(|tag_id| seen.insert(*tag_id)) {
      return Err(WorkspaceTagServiceError::new(
        ERR_TAG_CROSS_WORKSPACE,
        "workspace tag references must be unique",
      ));
    }
    let tags = self
      .repo
      .list_tags_by_ids(workspace_id, tag_ids)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?;
    if tags.len() != tag_ids.len() {
      return Err(WorkspaceTagServiceError::new(
        ERR_TAG_CROSS_WORKSPACE,
        "one or more workspace tag references do not belong to this workspace",
      ));
    }
    if !allow_archived && tags.iter().any(|tag| tag.archived_at.is_some()) {
      return Err(WorkspaceTagServiceError::new(
        ERR_TAG_ARCHIVED_WRITE,
        "archived workspace tags cannot be added to new values",
      ));
    }
    Ok(tags)
  }

  #[instrument(skip(self, tag_ids), fields(%workspace_id, actor_id = %actor, %doc_id, count = tag_ids.len()))]
  pub async fn set_document_tags(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    doc_id: Uuid,
    tag_ids: &[Uuid],
  ) -> WorkspaceTagResult<Vec<WorkspaceTag>> {
    // A document Tag assignment edits the same workspace-visible document
    // metadata as Tag lifecycle authoring, so the established editor
    // capability is CreateDoc. Requiring OrganizeUpdate would wrongly tie Tag
    // metadata to folder governance, while Read would permit viewers to write.
    // MCP's write:docs scope is an independent delegated-credential gate; it
    // does not replace this actor/workspace authorization.
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::CreateDoc)
      .await?;
    self
      .permission
      .assert(
        &DocResource {
          user_id: actor,
          workspace_id,
          doc_id,
        },
        DocAction::PropertiesUpdate,
      )
      .await
      .map_err(|_| WorkspaceTagServiceError::new(ERR_TAG_FORBIDDEN, "document tags are not writable"))?;
    let tags = self
      .repo
      .replace_document_tag_ids(workspace_id, doc_id, tag_ids, actor)
      .await
      .map_err(WorkspaceTagServiceError::from_assignment)?;
    self
      .refresh_search_projections(workspace_id, WorkspaceTagSearchRefreshScope::Document(doc_id))
      .await;
    // Return the transaction-validated records in caller order. Adapters can
    // project the committed assignment without a second catalog read, while
    // the repository remains the sole owner of the atomic replacement.
    Ok(tags)
  }

  #[instrument(skip(self), fields(%workspace_id, actor_id = %actor, %doc_id))]
  pub async fn document_tag_ids(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    doc_id: Uuid,
  ) -> WorkspaceTagResult<Vec<Uuid>> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::Read)
      .await?;
    self.assert_document_read(actor, workspace_id, doc_id).await?;
    self
      .repo
      .list_document_tag_ids(workspace_id, doc_id)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)
  }

  async fn assert_document_read(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    doc_id: Uuid,
  ) -> WorkspaceTagResult<()> {
    let readable = self
      .permission
      .readable_doc_ids(actor, workspace_id, &[doc_id])
      .await
      .map_err(|_| WorkspaceTagServiceError::new(ERR_TAG_FORBIDDEN, "document tags are unavailable"))?;
    if !readable.contains(&doc_id) {
      return Err(WorkspaceTagServiceError::new(
        ERR_TAG_FORBIDDEN,
        "document tags are unavailable",
      ));
    }
    Ok(())
  }

  /// Missing and forbidden documents are omitted; an included empty list is confirmed empty.
  #[instrument(skip_all, fields(%workspace_id, count = keys.len()))]
  pub async fn document_assignments(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    keys: &[DocumentKey],
  ) -> WorkspaceTagResult<Vec<WorkspaceTagDocumentAssignment>> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::Read)
      .await?;
    if keys.len() > WORKSPACE_TAG_DOCUMENT_BATCH_LIMIT {
      return Err(WorkspaceTagServiceError::new(
        ERR_TAG_INVALID_REQUEST,
        "document tag batch exceeds 200 keys",
      ));
    }
    let mut assignments = self
      .repo
      .list_document_assignments(workspace_id, keys)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?;
    let doc_ids = assignments.iter().map(|entry| entry.doc_id).collect::<Vec<_>>();
    let readable = self
      .permission
      .readable_doc_ids(actor, workspace_id, &doc_ids)
      .await
      .map_err(|_| WorkspaceTagServiceError::new(ERR_TAG_FORBIDDEN, "document tags are unavailable"))?;
    assignments.retain(|entry| readable.contains(&entry.doc_id));
    Ok(assignments)
  }

  /// Attach current assignments to an already authorized document-list projection.
  /// The caller must pass only readable external keys from this workspace. This
  /// trusted projection path reuses that list's bulk ACL result; it does not
  /// authorize arbitrary client-supplied keys or cache actor-sensitive visibility.
  #[instrument(skip_all, fields(%workspace_id, count = keys.len()))]
  pub async fn assignments_for_readable_index(
    &self,
    workspace_id: WorkspaceId,
    keys: &[DocumentKey],
  ) -> WorkspaceTagResult<Vec<WorkspaceTagDocumentAssignment>> {
    let mut assignments = Vec::with_capacity(keys.len());
    for batch in keys.chunks(WORKSPACE_TAG_DOCUMENT_BATCH_LIMIT) {
      assignments.extend(
        self
          .repo
          .list_document_assignments(workspace_id, batch)
          .await
          .map_err(WorkspaceTagServiceError::from_repository)?,
      );
    }
    Ok(assignments)
  }

  /// The continuation advances over candidates, including denied documents, so
  /// clients can traverse bounded pages even when a page has no visible usages.
  #[instrument(skip_all, fields(%workspace_id, %tag_id))]
  pub async fn document_tag_usages(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    page: PageRequest,
  ) -> WorkspaceTagResult<(Vec<WorkspaceTagDocumentUsage>, Option<i64>)> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::Read)
      .await?;
    if self
      .repo
      .get_tag(workspace_id, tag_id)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?
      .is_none()
    {
      return Err(WorkspaceTagServiceError::new(
        ERR_TAG_NOT_FOUND,
        "workspace tag not found",
      ));
    }
    let limit = page.limit.clamp(1, WORKSPACE_TAG_DOCUMENT_BATCH_LIMIT as i64);
    let offset = page.offset.max(0);
    let mut usages = self
      .repo
      .list_document_tag_usages(
        workspace_id,
        tag_id,
        PageRequest {
          limit: limit + 1,
          offset,
        },
      )
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?;
    let next_offset = (usages.len() > limit as usize).then_some(offset.saturating_add(limit));
    usages.truncate(limit as usize);
    let doc_ids = usages.iter().map(|entry| entry.doc_id).collect::<Vec<_>>();
    let readable = self
      .permission
      .readable_doc_ids(actor, workspace_id, &doc_ids)
      .await
      .map_err(|_| WorkspaceTagServiceError::new(ERR_TAG_FORBIDDEN, "document tags are unavailable"))?;
    usages.retain(|entry| readable.contains(&entry.doc_id));
    Ok((usages, next_offset))
  }

  #[instrument(skip(self), fields(%workspace_id, actor_id = %actor, %tag_id, limit = page.limit, offset = page.offset))]
  pub async fn database_row_tag_usages(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    page: PageRequest,
  ) -> WorkspaceTagResult<Vec<myoxus_domain::workspace_tags::WorkspaceTagDatabaseRowUsage>> {
    self
      .assert_workspace(actor, workspace_id, WorkspaceAction::Read)
      .await?;
    if self
      .repo
      .get_tag(workspace_id, tag_id)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)?
      .is_none()
    {
      return Err(WorkspaceTagServiceError::new(
        ERR_TAG_NOT_FOUND,
        "workspace tag not found",
      ));
    }
    self
      .repo
      .list_database_row_tag_usages(workspace_id, tag_id, page)
      .await
      .map_err(WorkspaceTagServiceError::from_repository)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn normalizes_names_slugs_and_import_colors_deterministically() {
    assert_eq!(
      WorkspaceTag::normalize_name("  Release   Ready ").unwrap(),
      "Release Ready"
    );
    assert_eq!(
      WorkspaceTag::slug_base("Überprüfung / Ready").unwrap(),
      "überprüfung-ready"
    );
    assert!(WorkspaceTag::normalize_name("   ").is_err());
    assert!(WorkspaceTag::normalize_name(&"x".repeat(81)).is_err());

    let exact = WorkspaceTagService::normalize_import_color("tag.blue");
    assert_eq!(exact.role, WorkspaceTagColorRole::Blue);
    assert!(!exact.normalized);

    let raw = WorkspaceTagService::normalize_import_color("#ed3f3f");
    assert_eq!(raw.role, WorkspaceTagColorRole::Red);
    assert!(raw.normalized);

    let unknown = WorkspaceTagService::normalize_import_color("not-a-color");
    assert_eq!(unknown.role, WorkspaceTagColorRole::Grey);
    assert!(unknown.normalized);
  }
}
