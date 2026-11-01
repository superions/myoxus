//! Authenticated GraphQL contract for server-authoritative workspace tags.

use async_graphql::{Context, Error, ErrorExtensions, ID, InputObject, Result, SimpleObject};
use chrono::{DateTime, Utc};
use myoxus_application::workspace_tags::{WorkspaceTagService, WorkspaceTagServiceError};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::workspace_tags::{WorkspaceTag, WorkspaceTagCatalogEntry, WorkspaceTagDatabaseRowUsage};
use std::sync::Arc;
use uuid::Uuid;

use crate::graphql::utils::{require_session, resolve_doc_id};
use crate::state::ApiState;

#[derive(Debug, Clone, SimpleObject)]
#[graphql(name = "WorkspaceTag")]
pub struct WorkspaceTagObjectType {
  pub id: ID,
  pub workspace_id: ID,
  pub name: String,
  pub slug: String,
  pub color_role: String,
  pub description: Option<String>,
  pub archived: bool,
  pub archived_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, SimpleObject)]
#[graphql(name = "WorkspaceTagCatalogEntry")]
pub struct WorkspaceTagCatalogEntryObjectType {
  pub tag: WorkspaceTagObjectType,
  pub document_count: i64,
  pub database_row_count: i64,
}

impl From<WorkspaceTagCatalogEntry> for WorkspaceTagCatalogEntryObjectType {
  fn from(entry: WorkspaceTagCatalogEntry) -> Self {
    Self {
      tag: entry.tag.into(),
      document_count: entry.document_count,
      database_row_count: entry.database_row_count,
    }
  }
}

#[derive(Debug, Clone, SimpleObject)]
#[graphql(name = "WorkspaceTagDatabaseRowUsage")]
pub struct WorkspaceTagDatabaseRowUsageObjectType {
  pub database_id: ID,
  pub database_title: String,
  pub row_id: ID,
  pub row_title: String,
  pub updated_at: DateTime<Utc>,
}

impl From<WorkspaceTagDatabaseRowUsage> for WorkspaceTagDatabaseRowUsageObjectType {
  fn from(usage: WorkspaceTagDatabaseRowUsage) -> Self {
    Self {
      database_id: ID(usage.database_id.to_string()),
      database_title: usage.database_title,
      row_id: ID(usage.row_id.to_string()),
      row_title: usage.row_title,
      updated_at: usage.updated_at,
    }
  }
}

impl From<WorkspaceTag> for WorkspaceTagObjectType {
  fn from(tag: WorkspaceTag) -> Self {
    Self {
      id: ID(tag.id.to_string()),
      workspace_id: ID(tag.workspace_id.to_string()),
      name: tag.name,
      slug: tag.slug,
      color_role: tag.color_role.to_string(),
      description: tag.description,
      archived: tag.archived_at.is_some(),
      archived_at: tag.archived_at,
      created_at: tag.created_at,
      updated_at: tag.updated_at,
    }
  }
}

/// A null assignment is unavailable; an empty list confirms no assigned labels.
#[derive(Debug, Clone, SimpleObject)]
#[graphql(name = "WorkspaceTagDocumentAssignment")]
pub struct WorkspaceTagDocumentAssignmentObjectType {
  pub external_id: ID,
  pub tag_ids: Option<Vec<ID>>,
}

#[derive(Debug, Clone, SimpleObject)]
#[graphql(name = "WorkspaceTagDocumentUsage")]
pub struct WorkspaceTagDocumentUsageObjectType {
  pub external_id: ID,
  pub title: String,
}

#[derive(Debug, Clone, SimpleObject)]
#[graphql(name = "WorkspaceTagDocumentUsagePage")]
pub struct WorkspaceTagDocumentUsagePageObjectType {
  pub items: Vec<WorkspaceTagDocumentUsageObjectType>,
  pub next_offset: Option<i32>,
}

#[derive(Debug, InputObject)]
pub struct CreateWorkspaceTagInput {
  pub workspace_id: ID,
  pub name: String,
  pub color_role: String,
  pub description: Option<String>,
}

#[derive(Debug, InputObject)]
pub struct RenameWorkspaceTagInput {
  pub workspace_id: ID,
  pub tag_id: ID,
  pub name: String,
}

#[derive(Debug, InputObject)]
pub struct RecolorWorkspaceTagInput {
  pub workspace_id: ID,
  pub tag_id: ID,
  pub color_role: String,
}

#[derive(Debug, InputObject)]
pub struct UpdateWorkspaceTagDescriptionInput {
  pub workspace_id: ID,
  pub tag_id: ID,
  pub description: Option<String>,
}

#[derive(Debug, InputObject)]
pub struct WorkspaceTagLifecycleInput {
  pub workspace_id: ID,
  pub tag_id: ID,
}

#[derive(Debug, InputObject)]
pub struct SetDocumentWorkspaceTagsInput {
  pub workspace_id: ID,
  pub doc_id: ID,
  pub tag_ids: Vec<ID>,
  /// Explicit same-workspace duplication: tagIds must equal this readable
  /// source's current ordered assignment; its archived references are retained.
  /// Omit for ordinary complete replacement and its unchanged archive rules.
  pub copy_from_doc_id: Option<ID>,
}

#[derive(Debug, InputObject)]
pub struct LegacyWorkspaceTagInput {
  pub legacy_id: String,
  pub name: String,
  pub color: String,
  pub description: Option<String>,
  pub created_at: Option<DateTime<Utc>>,
  pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, InputObject)]
pub struct LegacyWorkspaceTagDocumentAssignmentInput {
  pub doc_id: ID,
  pub legacy_tag_ids: Vec<String>,
}

#[derive(Debug, InputObject)]
pub struct BootstrapWorkspaceTagsInput {
  pub workspace_id: ID,
  pub tags: Vec<LegacyWorkspaceTagInput>,
  pub assignments: Vec<LegacyWorkspaceTagDocumentAssignmentInput>,
}

#[derive(Debug, SimpleObject)]
pub struct WorkspaceTagBootstrapResultObjectType {
  pub tags: Vec<WorkspaceTagObjectType>,
  pub legacy_id_mappings: Vec<WorkspaceTagLegacyIdMappingObjectType>,
  pub color_normalizations: Vec<WorkspaceTagColorNormalizationObjectType>,
  pub imported_tags: i32,
  pub reused_tags: i32,
  pub imported_assignments: i32,
}

#[derive(Debug, SimpleObject)]
pub struct WorkspaceTagLegacyIdMappingObjectType {
  pub legacy_id: String,
  pub tag_id: ID,
}

#[derive(Debug, SimpleObject)]
pub struct WorkspaceTagColorNormalizationObjectType {
  pub legacy_id: String,
  pub source_color: String,
  pub color_role: String,
  pub normalized: bool,
}

fn service(state: &Arc<ApiState>) -> Result<Arc<WorkspaceTagService>> {
  state
    .workspace_tag_service()
    .ok_or_else(|| Error::new("workspace tag service is not configured"))
}

fn parse_uuid(value: &ID, field: &'static str) -> Result<Uuid> {
  Uuid::parse_str(value.as_str()).map_err(|_| Error::new(format!("{field} must be a UUID")))
}

fn map_workspace_tag_error(error: WorkspaceTagServiceError) -> Error {
  Error::new(error.message).extend_with(|_, extensions| {
    extensions.set("code", error.code);
    extensions.set("type", error.code);
    extensions.set("name", error.code);
  })
}

pub(crate) async fn list_workspace_tags(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  include_archived: Option<bool>,
) -> Result<Vec<WorkspaceTagObjectType>> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .list_tags(session.user.id, workspace_id, include_archived.unwrap_or(false))
    .await
    .map(|tags| tags.into_iter().map(Into::into).collect())
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn list_workspace_tag_catalog(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  include_archived: Option<bool>,
) -> Result<Vec<WorkspaceTagCatalogEntryObjectType>> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .list_catalog(session.user.id, workspace_id, include_archived.unwrap_or(false))
    .await
    .map(|entries| entries.into_iter().map(Into::into).collect())
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn get_workspace_tag(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  tag_id: ID,
) -> Result<Option<WorkspaceTagObjectType>> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .get_tag(session.user.id, workspace_id, parse_uuid(&tag_id, "tagId")?)
    .await
    .map(|tag| tag.map(Into::into))
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn resolve_workspace_tags(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  tag_ids: Vec<ID>,
) -> Result<Vec<WorkspaceTagObjectType>> {
  let (state, session) = require_session(ctx).await?;
  let tag_ids = tag_ids
    .iter()
    .map(|id| parse_uuid(id, "tagIds"))
    .collect::<Result<Vec<_>>>()?;
  service(&state)?
    .resolve_tags(session.user.id, workspace_id, &tag_ids)
    .await
    .map(|tags| tags.into_iter().map(Into::into).collect())
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn document_workspace_tag_ids(ctx: &Context<'_>, workspace_id: Uuid, doc_id: ID) -> Result<Vec<ID>> {
  let (state, session) = require_session(ctx).await?;
  let doc_id = resolve_doc_id(&state, workspace_id, doc_id.as_str()).await?;
  service(&state)?
    .document_tag_ids(session.user.id, workspace_id, doc_id)
    .await
    .map(|ids| ids.into_iter().map(|id| ID(id.to_string())).collect())
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn document_workspace_tag_assignments(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  external_ids: Vec<ID>,
) -> Result<Vec<WorkspaceTagDocumentAssignmentObjectType>> {
  let (state, session) = require_session(ctx).await?;
  let keys = external_ids
    .iter()
    .map(|id| DocumentKey::parse(id.to_string()).map_err(Error::new))
    .collect::<Result<Vec<_>>>()?;
  let assignments = service(&state)?
    .document_assignments(session.user.id, workspace_id, &keys)
    .await
    .map_err(map_workspace_tag_error)?;
  let assignments = assignments
    .into_iter()
    .map(|entry| (entry.external_id, entry.tag_ids))
    .collect::<std::collections::HashMap<_, _>>();
  Ok(
    external_ids
      .into_iter()
      .map(|external_id| WorkspaceTagDocumentAssignmentObjectType {
        tag_ids: assignments
          .get(external_id.as_str())
          .map(|ids| ids.iter().map(|id| ID(id.to_string())).collect()),
        external_id,
      })
      .collect(),
  )
}

pub(crate) async fn workspace_tag_document_usages(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  tag_id: ID,
  first: Option<i32>,
  offset: Option<i32>,
) -> Result<WorkspaceTagDocumentUsagePageObjectType> {
  let (state, session) = require_session(ctx).await?;
  let (items, next_offset) = service(&state)?
    .document_tag_usages(
      session.user.id,
      workspace_id,
      parse_uuid(&tag_id, "tagId")?,
      myoxus_domain::repositories::PageRequest {
        limit: i64::from(first.unwrap_or(100)),
        offset: i64::from(offset.unwrap_or(0)),
      },
    )
    .await
    .map_err(map_workspace_tag_error)?;
  Ok(WorkspaceTagDocumentUsagePageObjectType {
    items: items
      .into_iter()
      .map(|item| WorkspaceTagDocumentUsageObjectType {
        external_id: ID(item.external_id),
        title: item.title,
      })
      .collect(),
    next_offset: next_offset
      .map(i32::try_from)
      .transpose()
      .map_err(|_| Error::new("document tag usage offset exceeds supported range"))?,
  })
}

pub(crate) async fn workspace_tag_database_row_usages(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  tag_id: ID,
  first: Option<i32>,
  offset: Option<i32>,
) -> Result<Vec<WorkspaceTagDatabaseRowUsageObjectType>> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .database_row_tag_usages(
      session.user.id,
      workspace_id,
      parse_uuid(&tag_id, "tagId")?,
      myoxus_domain::repositories::PageRequest {
        limit: i64::from(first.unwrap_or(100).clamp(1, 500)),
        offset: i64::from(offset.unwrap_or(0).max(0)),
      },
    )
    .await
    .map(|usages| usages.into_iter().map(Into::into).collect())
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn create_workspace_tag(
  ctx: &Context<'_>,
  input: CreateWorkspaceTagInput,
) -> Result<WorkspaceTagObjectType> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .create_tag(
      session.user.id,
      parse_uuid(&input.workspace_id, "workspaceId")?,
      &input.name,
      &input.color_role,
      input.description,
    )
    .await
    .map(Into::into)
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn rename_workspace_tag(
  ctx: &Context<'_>,
  input: RenameWorkspaceTagInput,
) -> Result<WorkspaceTagObjectType> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .rename_tag(
      session.user.id,
      parse_uuid(&input.workspace_id, "workspaceId")?,
      parse_uuid(&input.tag_id, "tagId")?,
      &input.name,
    )
    .await
    .map(Into::into)
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn recolor_workspace_tag(
  ctx: &Context<'_>,
  input: RecolorWorkspaceTagInput,
) -> Result<WorkspaceTagObjectType> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .recolor_tag(
      session.user.id,
      parse_uuid(&input.workspace_id, "workspaceId")?,
      parse_uuid(&input.tag_id, "tagId")?,
      &input.color_role,
    )
    .await
    .map(Into::into)
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn update_workspace_tag_description(
  ctx: &Context<'_>,
  input: UpdateWorkspaceTagDescriptionInput,
) -> Result<WorkspaceTagObjectType> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .update_description(
      session.user.id,
      parse_uuid(&input.workspace_id, "workspaceId")?,
      parse_uuid(&input.tag_id, "tagId")?,
      input.description,
    )
    .await
    .map(Into::into)
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn archive_workspace_tag(
  ctx: &Context<'_>,
  input: WorkspaceTagLifecycleInput,
) -> Result<WorkspaceTagObjectType> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .archive_tag(
      session.user.id,
      parse_uuid(&input.workspace_id, "workspaceId")?,
      parse_uuid(&input.tag_id, "tagId")?,
    )
    .await
    .map(Into::into)
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn restore_workspace_tag(
  ctx: &Context<'_>,
  input: WorkspaceTagLifecycleInput,
) -> Result<WorkspaceTagObjectType> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .restore_tag(
      session.user.id,
      parse_uuid(&input.workspace_id, "workspaceId")?,
      parse_uuid(&input.tag_id, "tagId")?,
    )
    .await
    .map(Into::into)
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn delete_workspace_tag_permanently(
  ctx: &Context<'_>,
  input: WorkspaceTagLifecycleInput,
) -> Result<bool> {
  let (state, session) = require_session(ctx).await?;
  service(&state)?
    .delete_tag_permanently(
      session.user.id,
      parse_uuid(&input.workspace_id, "workspaceId")?,
      parse_uuid(&input.tag_id, "tagId")?,
    )
    .await
    .map(|_| true)
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn set_document_workspace_tags(
  ctx: &Context<'_>,
  input: SetDocumentWorkspaceTagsInput,
) -> Result<Vec<ID>> {
  let (state, session) = require_session(ctx).await?;
  let workspace_id = parse_uuid(&input.workspace_id, "workspaceId")?;
  let doc_id = resolve_doc_id(&state, workspace_id, input.doc_id.as_str()).await?;
  let tag_ids = input
    .tag_ids
    .iter()
    .map(|id| parse_uuid(id, "tagIds"))
    .collect::<Result<Vec<_>>>()?;
  let service = service(&state)?;
  let result = if let Some(source) = input.copy_from_doc_id {
    let source_id = resolve_doc_id(&state, workspace_id, source.as_str()).await?;
    service
      .copy_document_tags(session.user.id, workspace_id, source_id, doc_id, &tag_ids)
      .await
  } else {
    service
      .set_document_tags(session.user.id, workspace_id, doc_id, &tag_ids)
      .await
  };
  result
    .map(|tags| tags.into_iter().map(|tag| ID(tag.id.to_string())).collect())
    .map_err(map_workspace_tag_error)
}

pub(crate) async fn bootstrap_workspace_tags(
  ctx: &Context<'_>,
  input: BootstrapWorkspaceTagsInput,
) -> Result<WorkspaceTagBootstrapResultObjectType> {
  require_session(ctx).await?;
  let _ = input;
  // Preserve the shipped GraphQL contract, but never parse legacy assignments
  // into a write. Updated clients use explicit import or inspected CLI repair.
  Err(
    Error::new(
      "Workspace label bootstrap is retired. Update this client; use explicit import or approved reconciliation.",
    )
    .extend_with(|_, extensions| {
      extensions.set("code", "WORKSPACE_TAG_BOOTSTRAP_RETIRED");
      extensions.set("type", "WORKSPACE_TAG_BOOTSTRAP_RETIRED");
      extensions.set("name", "WORKSPACE_TAG_BOOTSTRAP_RETIRED");
    }),
  )
}

/// Portable metadata is parsed by the same Rust transfer owner as full-workspace
/// imports. Preflight never creates catalog entries or document assignments.
#[derive(Debug, InputObject)]
pub struct ImportWorkspaceTagsInput {
  pub workspace_id: ID,
  /// SHA-256 of the immutable source archive, scoped to the destination workspace.
  pub import_id: ID,
  /// Portable catalog: id, name/value, colorRole/color, description and archival metadata.
  pub catalog: async_graphql::Json<Vec<myoxus_workspace_import::DecodedWorkspaceTag>>,
  pub documents: async_graphql::Json<Vec<myoxus_application::workspace_tags::transfer::PortableDocumentTags>>,
  /// Validate before document creation; false applies to the supplied external target keys.
  pub validate_only: bool,
}

#[derive(Debug, SimpleObject)]
#[graphql(name = "WorkspaceTagTransfer")]
pub struct WorkspaceTagTransferObjectType {
  pub tags: Vec<WorkspaceTagObjectType>,
  pub mappings: async_graphql::Json<std::collections::HashMap<String, Uuid>>,
  pub diagnostics: async_graphql::Json<Vec<myoxus_workspace_import::WorkspaceImportDiagnostic>>,
}

pub(crate) async fn import_workspace_tags(
  ctx: &Context<'_>,
  input: ImportWorkspaceTagsInput,
) -> Result<WorkspaceTagTransferObjectType> {
  let (state, session) = require_session(ctx).await?;
  let workspace_id = parse_uuid(&input.workspace_id, "workspaceId")?;
  if input.import_id.as_str().len() != 64 || !input.import_id.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return Err(Error::new("importId must be the source archive SHA-256"));
  }
  let import_id = Uuid::new_v5(&workspace_id, input.import_id.as_str().as_bytes());
  use myoxus_application::workspace_import::WorkspaceImportPolicyProvider;
  let limits = crate::workspace_import::ApiWorkspaceImportPolicyProvider::new(
    state.config.clone(),
    state.config_overrides.clone(),
  )
  .current_policy()
  .await
  .limits;
  let plan = service(&state)?
    .import_document_tags(
      session.user.id,
      workspace_id,
      import_id,
      &input.catalog.0,
      &input.documents.0,
      input.validate_only,
      limits,
    )
    .await
    .map_err(map_workspace_tag_error)?;
  Ok(WorkspaceTagTransferObjectType {
    tags: plan.tags.into_iter().map(Into::into).collect(),
    mappings: async_graphql::Json(plan.mappings),
    diagnostics: async_graphql::Json(plan.diagnostics),
  })
}

/// Canonical portable metadata for exactly the requested external document keys.
pub(crate) async fn export_workspace_tags(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  external_ids: Vec<ID>,
) -> Result<async_graphql::Json<myoxus_application::workspace_tags::transfer::WorkspaceTagExport>> {
  let (state, session) = require_session(ctx).await?;
  let keys = external_ids
    .iter()
    .map(|id| DocumentKey::parse(id.to_string()).map_err(Error::new))
    .collect::<Result<Vec<_>>>()?;
  use myoxus_application::workspace_import::WorkspaceImportPolicyProvider;
  let limits = crate::workspace_import::ApiWorkspaceImportPolicyProvider::new(
    state.config.clone(),
    state.config_overrides.clone(),
  )
  .current_policy()
  .await
  .limits;
  service(&state)?
    .export_document_tags(session.user.id, workspace_id, &keys, limits)
    .await
    .map(async_graphql::Json)
    .map_err(map_workspace_tag_error)
}
