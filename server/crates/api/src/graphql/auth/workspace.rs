//! GraphQL workspace resolvers: workspace CRUD, member management, invitations,
//! and workspace-level permission queries.
//!
//! Provides `WorkspaceQuery` and `WorkspaceMutation` sub-objects on the
//! authenticated GraphQL root. Delegates to
//! `myoxus_application::workspace::WorkspaceService` and
//! `myoxus_application::permission::PermissionService`.
//!
//! ## DataLoader Analysis (P84-G-01)
//!
//! async-graphql's built-in `DataLoader` was evaluated for field-level N+1
//! mitigation (e.g., `WorkspaceType.initialized` and `.role` resolved
//! per-item in a list).  Conclusion: **DataLoader is not needed** because:
//!
//! 1. **async-graphql already resolves list items concurrently** — field
//!    resolvers for different list elements are run as concurrent futures,
//!    so the per-workspace DB queries already overlap.
//! 2. **Batch queries cover the primary N+1 paths** — member lookups use
//!    `get_historical_profiles()` for batch author resolution. Workspace listing
//!    merges direct membership and scoped OU-manager results before field
//!    resolution; classification is not an access filter.
//! 3. **Remaining per-item fields** (`initialized`, `role`) are
//!    single-row lookups with low cardinality (typically 1-5 workspaces per
//!    user) — the concurrent resolution already achieves near-optimal latency.
//!
//! If the workspace list size grows significantly (>50 items), DataLoader
//! should be reconsidered for these per-item fields.

use myoxus_application::workspace::workspace_invite_url;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_graphql::{Context, ErrorExtensions, ID, Object, Result, SimpleObject};
use chrono::{DateTime, Utc};
use tracing::{instrument, trace, warn};
use uuid::Uuid;

use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;
use myoxus_application::auth::{AuthError, AuthUser};
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::WorkspaceRole as WorkspaceRoleModel;
use myoxus_domain::permission::{DocAction, WorkspaceAction};

use super::calendar::{WorkspaceCalendarItemObjectType, WorkspaceCalendarObjectType, map_workspace_calendar_object};
use super::database::{
  DatabaseCsvExportObjectType, DatabaseCsvExportOptionsInput, DatabaseCsvMappingTemplateSummaryObjectType,
  DatabaseEffectiveViewStateObjectType, DatabaseFilterGroupInput, DatabaseFilterRuleInput, DatabaseInventorySortType,
  DatabaseJsonExportObjectType, DatabasePageIdentityObjectType, DatabaseProfileKindType,
  DatabaseProgressSummaryObjectType, DatabaseRecordObjectType, DatabaseRowGroupSummaryObjectType,
  DatabaseRowRecordObjectType, DatabaseRowReminderObjectType, DatabaseRowTemplateBindingObjectType,
  DatabaseRowsPageObjectType, DatabaseScheduleWindowInput, DatabaseSortRuleInput, DatabaseStarterTemplateObjectType,
  DatabaseSummaryObjectType, DatabaseTaskCaptureResultObjectType, DatabaseTaskDestinationsObjectType,
  DatabaseTaskMoveInput, DatabaseTaskMovePreviewObjectType, DatabaseTaskReferenceInput,
  DatabaseTaskReferenceObjectType, DatabaseTasksInput, DatabaseTasksPageObjectType, DatabaseViewObjectType,
  database_activity, database_csv_mapping_templates_query, database_row_activity, database_search,
  export_database_csv_query, export_database_json_query, get_database, get_database_effective_view_state,
  get_database_row, get_database_summary, get_database_task_capture_receipt, get_database_view,
  list_database_page_identities, list_database_row_groups, list_database_row_reminders, list_database_row_templates,
  list_database_rows, list_database_starter_templates, list_database_task_destinations, list_databases,
  list_trashed_databases, list_workspace_database_task_references, list_workspace_database_tasks,
  prepare_database_task_move, read_database_progress,
};
use super::document_graph::{
  DocumentGraphIndexStatusObjectType, DocumentGraphInput, DocumentGraphResultObjectType, DocumentLinksInput,
  DocumentLinksResultObjectType, read_document_graph_index_status, read_document_links, read_workspace_document_graph,
};
use super::search_query as search_query_plan;
use super::template_suggestions::{
  TemplateSuggestionInput, TemplateSuggestionResultObjectType, read_template_suggestions,
};
use super::workspace_automation::{
  WorkspaceAutomationObjectType, WorkspaceAutomationRunObjectType, list_workspace_automation_runs,
  list_workspace_automations,
};
use super::workspace_content_operation::WorkspaceContentResourceType;
use super::workspace_tags::{
  WorkspaceTagCatalogEntryObjectType, WorkspaceTagDatabaseRowUsageObjectType, WorkspaceTagDocumentAssignmentObjectType,
  WorkspaceTagDocumentUsagePageObjectType, WorkspaceTagObjectType, document_workspace_tag_assignments,
  document_workspace_tag_ids, get_workspace_tag, list_workspace_tag_catalog, list_workspace_tags,
  resolve_workspace_tags, workspace_tag_database_row_usages, workspace_tag_document_usages,
};
use super::{
  AggregateBucketHitsObjectType, AggregateBucketObjectType, AggregateInputType, AggregateResultObjectType,
  BlobUploadPartType, CommentChangeActionType, CommentChangeObjectType, CommentChangeObjectTypeEdge, CommentObjectType,
  CommentObjectTypeEdge, DatabaseDocumentReferenceObjectType, InviteLinkType, ListedBlobType, PageInfoType,
  PaginatedCommentChangeObjectType, PaginatedCommentObjectType, PaginationInputType, PublicUserType, QueryRoot,
  ReplyObjectType, SearchDocObjectType, SearchDocsInputType, SearchInputType, SearchNodeObjectType,
  SearchResultObjectType, SearchResultPaginationType, SearchSortByType, SortDirectionType, UserQuotaType, UserType,
  WorkspaceDocType, WorkspaceDocumentSnippetType, WorkspaceMemberType, WorkspacePermissions, WorkspaceRole,
  WorkspaceType, compat_default_doc_role_from_domain, compat_public_doc_mode_from_db, neutral_user_quota,
  neutral_user_quota_with_member_usage,
};
use crate::config::{CompatibilityQuotaConfig, QuotaPlan};
use crate::graphql::{DocCompatType, PublicDocModeType};

async fn load_workspace_doc_summary(state: &ApiState, workspace_id: Uuid, doc_id: Uuid) -> Result<Option<String>> {
  let plain_text = if let Some(repository) = state.search_repository() {
    repository
      .get_search_doc(workspace_id, doc_id)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?
      .map(|document| document.plain_text)
  } else {
    None
  };

  Ok(plain_text.and_then(|value| myoxus_application::search::normalize_document_snippet(&value)))
}

/// Shared document-read authorization for metadata list/exact history reads.
/// Storage rechecks the tuple in its read snapshot after this authorization.
async fn authorize_history_document(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  guid: &str,
) -> Result<(Arc<ApiState>, Uuid)> {
  let (state, snapshot) = require_session(ctx).await?;
  state
    .permission_service()
    .assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id,
      },
      WorkspaceAction::Read,
    )
    .await
    .map_err(map_gql_error)?;
  let doc_id = crate::graphql::utils::resolve_doc_id(&state, workspace_id, guid).await?;
  let meta = state
    .doc()
    .get_metadata(doc_id)
    .await
    .map_err(map_gql_error)?
    .filter(|meta| meta.workspace_id == Some(workspace_id))
    .ok_or_else(|| map_gql_error(AuthError::NotFound("document".into())))?;
  let document_key = DocumentKey::parse(meta.external_id)
    .map_err(|error| async_graphql::Error::new(format!("invalid document key: {error}")))?;
  let authorized = crate::document_access::authorize_workspace_document(
    &state,
    snapshot.user.id,
    workspace_id,
    myoxus_application::doc::DocSpaceKind::Workspace,
    &document_key,
    DocAction::Read,
  )
  .await
  .map_err(map_gql_error)?;
  if authorized.doc_id != doc_id {
    return Err(map_gql_error(AuthError::NotFound("document".into())));
  }
  Ok((state, doc_id))
}

fn history_metadata_type(
  guid: &str,
  entry: myoxus_application::doc::DocHistoryMetadataEntry,
) -> super::DocHistoryGqlType {
  super::DocHistoryGqlType {
    workspace_id: entry.workspace_id.to_string(),
    id: guid.to_owned(),
    snapshot_id: ID(entry.id.to_string()),
    cursor: format!("{}|{}", entry.created_at.to_rfc3339(), entry.id),
    timestamp: entry.created_at,
    origin: entry.origin.map(Into::into),
    editor: entry.actor_name.map(|name| super::EditorType {
      name,
      avatar_url: entry.actor_avatar_key,
    }),
  }
}

#[derive(SimpleObject)]
pub struct WorkspaceOverviewFolderType {
  id: String,
  name: String,
}

impl From<myoxus_application::workspace_overview::OverviewFolder> for WorkspaceOverviewFolderType {
  fn from(folder: myoxus_application::workspace_overview::OverviewFolder) -> Self {
    Self {
      id: folder.id,
      name: folder.name,
    }
  }
}

#[derive(SimpleObject)]
pub struct WorkspaceOverviewDocumentType {
  resource: WorkspaceContentResourceType,
  title: String,
  updated_at: DateTime<Utc>,
  can_edit: bool,
  created_at: Option<DateTime<Utc>>,
  created_by_name: Option<String>,
  tags: Vec<super::workspace_tags::WorkspaceTagObjectType>,
  metadata: Option<crate::graphql::document_metadata_policy::DocumentMetadataIndexRowType>,
  metadata_labels: Option<WorkspaceOverviewMetadataLabelsType>,
}

#[derive(SimpleObject)]
pub struct WorkspaceOverviewMetadataLabelsType {
  status_label: Option<String>,
  document_type_label: Option<String>,
  version_label: Option<String>,
  classification_label: Option<String>,
}

impl From<myoxus_application::workspace_overview::OverviewDocument> for WorkspaceOverviewDocumentType {
  fn from(document: myoxus_application::workspace_overview::OverviewDocument) -> Self {
    let created_at = document.register.as_ref().map(|row| row.created_at);
    let created_by_name = document.register.as_ref().and_then(|row| row.created_by_name.clone());
    let tags = document
      .register
      .as_ref()
      .map_or_else(Vec::new, |row| row.tags.iter().cloned().map(Into::into).collect());
    let metadata_labels = document
      .register
      .as_ref()
      .map(|row| WorkspaceOverviewMetadataLabelsType {
        status_label: row.labels.status_label.clone(),
        document_type_label: row.labels.document_type_label.clone(),
        version_label: row.labels.version_label.clone(),
        classification_label: row.labels.classification_label.clone(),
      });
    let metadata = document.register.map(|row| {
      let mut metadata =
        crate::graphql::document_metadata_policy::DocumentMetadataIndexRowType::from_row(row.metadata, row.can_publish);
      metadata.tag_ids = row.tag_ids.into_iter().map(|id| ID(id.to_string())).collect();
      metadata
    });
    Self {
      resource: (&document.reference).into(),
      title: document.title,
      updated_at: document.updated_at,
      can_edit: document.can_edit,
      created_at,
      created_by_name,
      tags,
      metadata,
      metadata_labels,
    }
  }
}

/// Authorized page facts only. The workspace row and its private bindings stay
/// with the native settings owner rather than becoming a generic JSON payload.
#[derive(SimpleObject)]
pub struct WorkspaceOverviewPageType {
  folder: Option<WorkspaceOverviewFolderType>,
  breadcrumbs: Vec<WorkspaceOverviewFolderType>,
  children: Vec<WorkspaceOverviewFolderType>,
  introduction: Option<WorkspaceOverviewDocumentType>,
  introduction_unavailable: bool,
  documents: Vec<WorkspaceOverviewDocumentType>,
  document_count: i64,
  limit: i64,
  offset: i64,
  has_more: bool,
  register_presentation: Option<WorkspaceOverviewRegisterPresentationType>,
}

impl From<myoxus_application::workspace_overview::WorkspaceOverviewRead> for WorkspaceOverviewPageType {
  fn from(read: myoxus_application::workspace_overview::WorkspaceOverviewRead) -> Self {
    let page = read.page;
    let has_more = read.register_page.offset.saturating_add(page.documents.len() as i64) < read.document_count;
    Self {
      document_count: read.document_count,
      limit: read.register_page.limit,
      offset: read.register_page.offset,
      has_more,
      register_presentation: page.register_presentation.map(Into::into),
      folder: page.folder.map(Into::into),
      breadcrumbs: page.breadcrumbs.into_iter().map(Into::into).collect(),
      children: page.children.into_iter().map(Into::into).collect(),
      introduction: page.introduction.map(Into::into),
      introduction_unavailable: page.introduction_unavailable,
      documents: page.documents.into_iter().map(Into::into).collect(),
    }
  }
}

/// Private presentation bindings, readable only by workspace settings editors.
#[derive(SimpleObject)]
pub struct WorkspaceOverviewSettingsType {
  revision: i64,
  introduction: Option<WorkspaceContentResourceType>,
  folder_ids: Option<Vec<String>>,
  folders: Vec<WorkspaceOverviewFolderSettingsType>,
  register_presentation: Option<WorkspaceOverviewRegisterPresentationType>,
}

#[derive(SimpleObject)]
pub struct WorkspaceOverviewFolderSettingsType {
  folder_id: String,
  introduction: Option<WorkspaceContentResourceType>,
  register_presentation: Option<WorkspaceOverviewRegisterPresentationType>,
}

#[derive(SimpleObject)]
pub struct WorkspaceOverviewRegisterPresentationType {
  display_properties: Vec<String>,
  order_by: WorkspaceOverviewOrderByType,
}

#[derive(SimpleObject)]
pub struct WorkspaceOverviewOrderByType {
  #[graphql(name = "type")]
  property_type: String,
  key: String,
  desc: bool,
}

impl From<myoxus_domain::workspace_overview::OverviewRegisterPresentation>
  for WorkspaceOverviewRegisterPresentationType
{
  fn from(value: myoxus_domain::workspace_overview::OverviewRegisterPresentation) -> Self {
    Self {
      display_properties: value.display_properties,
      order_by: WorkspaceOverviewOrderByType {
        property_type: value.order_by.property_type,
        key: value.order_by.key,
        desc: value.order_by.desc,
      },
    }
  }
}

impl From<(myoxus_domain::workspace_overview::WorkspaceOverviewSettings, i64)> for WorkspaceOverviewSettingsType {
  fn from((settings, revision): (myoxus_domain::workspace_overview::WorkspaceOverviewSettings, i64)) -> Self {
    Self {
      revision,
      introduction: settings.introduction.as_ref().map(Into::into),
      folder_ids: settings.folder_ids,
      register_presentation: settings.register_presentation.map(Into::into),
      folders: settings
        .folders
        .into_iter()
        .map(|(folder_id, folder)| WorkspaceOverviewFolderSettingsType {
          folder_id,
          introduction: folder.introduction.as_ref().map(Into::into),
          register_presentation: folder.register_presentation.map(Into::into),
        })
        .collect(),
    }
  }
}

#[Object]
impl WorkspaceType {
  /// The captured row is also the mutation's exact saved basis; no second read
  /// can replace its returned revision with a concurrent writer's settings.
  #[instrument(skip_all, fields(workspace_id = %self.id))]
  async fn overview_settings(&self, ctx: &Context<'_>) -> Result<WorkspaceOverviewSettingsType> {
    let (state, session) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: session.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(map_gql_error)?;
    Ok((self.overview_settings.clone(), self.overview_revision).into())
  }

  /// Folder IDs are opaque Organizer identities. The native reader owns both
  /// current bulk document access and the root/direct-folder membership rules.
  #[graphql(complexity = 100)]
  #[instrument(skip_all, fields(workspace_id = %self.id))]
  async fn overview(
    &self,
    ctx: &Context<'_>,
    folder_id: Option<String>,
    #[graphql(default = 50)] first: i32,
    #[graphql(default = 0)] offset: i32,
  ) -> Result<WorkspaceOverviewPageType> {
    let (state, session) = require_session(ctx).await?;
    let reader = state
      .workspace_overview_service()
      .ok_or_else(|| async_graphql::Error::new("workspace overview is unavailable"))?;
    let read = reader
      .read_authenticated(
        session.user.id,
        state.permission_service().as_ref(),
        self.id,
        folder_id.as_deref(),
        myoxus_domain::repositories::PageRequest {
          limit: first.into(),
          offset: offset.into(),
        },
      )
      .await
      .map_err(map_gql_error)?;
    Ok(read.into())
  }

  /// Batch list snippets without loading document leaves or scheduling indexing.
  #[graphql(complexity = "100 * child_complexity")]
  #[instrument(skip(self, ctx, doc_ids))]
  async fn document_snippets(&self, ctx: &Context<'_>, doc_ids: Vec<ID>) -> Result<Vec<WorkspaceDocumentSnippetType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;

    let mut requested_set = HashSet::new();
    let requested = doc_ids
      .into_iter()
      .map(|id| id.to_string())
      .filter(|id| requested_set.insert(id.clone()))
      .collect::<Vec<_>>();
    if requested_set.len() > 100 {
      return Err(async_graphql::Error::new(
        "document snippet batch exceeds 100 unique ids",
      ));
    }
    let documents = state
      .doc()
      .list_workspace_docs(self.id, i64::MAX, 0)
      .await
      .map_err(map_gql_error)?
      .into_iter()
      .filter(|doc| requested_set.contains(&doc.external_id))
      .collect();
    let readable =
      crate::document_access::filter_readable_workspace_documents(&state, snapshot.user.id, self.id, documents)
        .await
        .map_err(map_gql_error)?;
    let internal_ids = readable.iter().map(|doc| doc.id).collect::<Vec<_>>();
    let snippets = state
      .search_indexer()
      .ok_or_else(|| async_graphql::Error::new("search index is unavailable"))?
      .read_document_snippets(self.id, &internal_ids)
      .await
      .map_err(map_gql_error)?;
    let snippet_by_id = snippets
      .into_iter()
      .map(|snippet| (snippet.doc_id, snippet))
      .collect::<HashMap<_, _>>();
    let readable_by_external = readable
      .into_iter()
      .map(|doc| (doc.external_id.clone(), doc))
      .collect::<HashMap<_, _>>();

    Ok(
      requested
        .into_iter()
        .filter_map(|external_id| {
          let document = readable_by_external.get(&external_id)?;
          let snippet = snippet_by_id.get(&document.id);
          Some(WorkspaceDocumentSnippetType {
            doc_id: external_id,
            snippet: snippet.and_then(|value| value.text.clone()),
            indexed_at: snippet.map(|value| value.indexed_at),
          })
        })
        .collect(),
    )
  }

  /// Workspace Read makes only these document-context names visible. It grants
  /// no organization administration or manager/member-scoped OU access.
  #[instrument(skip_all)]
  async fn template_context(&self, ctx: &Context<'_>) -> Result<Option<super::types::WorkspaceTemplateContextType>> {
    let (state, session) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: session.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    if state.document_template_service().is_none() {
      return Ok(None);
    }
    Ok(Some(super::types::WorkspaceTemplateContextType {
      workspace_id: self.id,
    }))
  }

  async fn initial_content_policy(&self) -> super::WorkspaceInitialContentPolicyType {
    self.initial_content_policy
  }
  async fn creation(&self) -> Option<&super::WorkspaceCreationResultType> {
    self.creation.as_ref()
  }
  async fn id(&self) -> Uuid {
    self.id
  }
  async fn name(&self) -> &str {
    &self.name
  }
  async fn description(&self) -> &str {
    &self.description
  }
  async fn public(&self) -> bool {
    self.public
  }
  /// Whether this server currently exposes the dynamic public delivery routes.
  async fn public_delivery_enabled(&self, ctx: &Context<'_>) -> Result<bool> {
    let (state, _) = require_session(ctx).await?;
    Ok(state.config.public_publishing.enabled && state.config.public_publishing.dynamic_routes_enabled)
  }
  /// Server-authoritative effective anonymous workspace availability.
  async fn publicly_accessible(&self, ctx: &Context<'_>) -> Result<bool> {
    let (state, _) = require_session(ctx).await?;
    Ok(
      self.public
        && self.enable_sharing
        && state.config.public_publishing.enabled
        && state.config.public_publishing.dynamic_routes_enabled,
    )
  }
  /// Retained, otherwise eligible document selections activated with the workspace.
  async fn public_document_selection_count(&self, ctx: &Context<'_>) -> Result<i32> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let count = state
      .doc()
      .list_public_docs(self.id)
      .await
      .map_err(map_gql_error)?
      .len();
    i32::try_from(count).map_err(|_| async_graphql::Error::new("public document selection count exceeds i32"))
  }
  async fn created_at(&self) -> DateTime<Utc> {
    self.created_at
  }
  async fn enable_ai(&self) -> bool {
    self.enable_ai
  }
  async fn enable_sharing(&self) -> bool {
    self.enable_sharing
  }
  async fn enable_url_preview(&self) -> bool {
    self.enable_url_preview
  }
  async fn enable_doc_embedding(&self) -> bool {
    self.enable_doc_embedding
  }

  /// Canonical workspace tag catalog. Archived records are opt-in so normal
  /// editors cannot accidentally offer them for new assignments.
  #[graphql(complexity = "5 * child_complexity")]
  async fn workspace_tags(
    &self,
    ctx: &Context<'_>,
    include_archived: Option<bool>,
  ) -> Result<Vec<WorkspaceTagObjectType>> {
    list_workspace_tags(ctx, self.id, include_archived).await
  }

  /// Complete catalog projection for the dedicated Tags surface. Assignment
  /// controls keep using `workspaceTags` so ordinary workspace reads do not
  /// pay for aggregate usage counts.
  #[graphql(complexity = "5 * child_complexity")]
  async fn workspace_tag_catalog(
    &self,
    ctx: &Context<'_>,
    include_archived: Option<bool>,
  ) -> Result<Vec<WorkspaceTagCatalogEntryObjectType>> {
    list_workspace_tag_catalog(ctx, self.id, include_archived).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  async fn workspace_tag(&self, ctx: &Context<'_>, tag_id: ID) -> Result<Option<WorkspaceTagObjectType>> {
    get_workspace_tag(ctx, self.id, tag_id).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  async fn resolve_workspace_tags(&self, ctx: &Context<'_>, tag_ids: Vec<ID>) -> Result<Vec<WorkspaceTagObjectType>> {
    resolve_workspace_tags(ctx, self.id, tag_ids).await
  }

  async fn document_workspace_tag_ids(&self, ctx: &Context<'_>, doc_id: ID) -> Result<Vec<ID>> {
    document_workspace_tag_ids(ctx, self.id, doc_id).await
  }

  /// Ordered SQL assignments for at most 200 external document keys. Null means
  /// missing or forbidden; an empty array is a confirmed empty assignment.
  #[graphql(complexity = "200 * child_complexity")]
  async fn document_workspace_tag_assignments(
    &self,
    ctx: &Context<'_>,
    external_ids: Vec<ID>,
  ) -> Result<Vec<WorkspaceTagDocumentAssignmentObjectType>> {
    document_workspace_tag_assignments(ctx, self.id, external_ids).await
  }

  /// Coherent SQL label catalog and ordered assignments for explicit exported
  /// external document keys. Fails on unavailable documents or export limits.
  #[graphql(complexity = "200 * child_complexity")]
  async fn export_workspace_tags(
    &self,
    ctx: &Context<'_>,
    external_ids: Vec<ID>,
  ) -> Result<async_graphql::Json<myoxus_application::workspace_tags::transfer::WorkspaceTagExport>> {
    super::workspace_tags::export_workspace_tags(ctx, self.id, external_ids).await
  }

  /// Bounded document usages with an explicit continuation after ACL filtering.
  #[graphql(complexity = "200 * child_complexity")]
  async fn workspace_tag_document_usages(
    &self,
    ctx: &Context<'_>,
    tag_id: ID,
    first: Option<i32>,
    offset: Option<i32>,
  ) -> Result<WorkspaceTagDocumentUsagePageObjectType> {
    workspace_tag_document_usages(ctx, self.id, tag_id, first, offset).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  async fn workspace_tag_database_row_usages(
    &self,
    ctx: &Context<'_>,
    tag_id: ID,
    first: Option<i32>,
    offset: Option<i32>,
  ) -> Result<Vec<WorkspaceTagDatabaseRowUsageObjectType>> {
    workspace_tag_database_row_usages(ctx, self.id, tag_id, first, offset).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  #[expect(
    clippy::too_many_arguments,
    reason = "the arguments are generated as independent GraphQL fields"
  )]
  async fn databases(
    &self,
    ctx: &Context<'_>,
    first: Option<i32>,
    offset: Option<i32>,
    search: Option<String>,
    profile_kind: Option<DatabaseProfileKindType>,
    database_ids: Option<Vec<ID>>,
    sort: Option<DatabaseInventorySortType>,
  ) -> Result<Vec<DatabaseSummaryObjectType>> {
    list_databases(ctx, self.id, first, offset, search, profile_kind, database_ids, sort).await
  }

  /// Recoverable Database roots in this workspace's trash. Child schema,
  /// views, rows and cells stay intact until permanent deletion.
  #[graphql(complexity = "10 * child_complexity")]
  async fn trashed_databases(
    &self,
    ctx: &Context<'_>,
    first: Option<i32>,
    offset: Option<i32>,
  ) -> Result<Vec<DatabaseSummaryObjectType>> {
    list_trashed_databases(ctx, self.id, first, offset).await
  }

  /// Count-free active Database identities for mixed Document/Database lists.
  #[graphql(complexity = "5 * child_complexity")]
  async fn database_page_identities(
    &self,
    ctx: &Context<'_>,
    first: Option<i32>,
    offset: Option<i32>,
  ) -> Result<Vec<DatabasePageIdentityObjectType>> {
    list_database_page_identities(
      ctx,
      self.id,
      first,
      offset,
      myoxus_domain::database::DatabaseLifecycleFilter::Active,
    )
    .await
  }

  /// Count-free trashed Database identities for the workspace trash list.
  #[graphql(complexity = "5 * child_complexity")]
  async fn trashed_database_page_identities(
    &self,
    ctx: &Context<'_>,
    first: Option<i32>,
    offset: Option<i32>,
  ) -> Result<Vec<DatabasePageIdentityObjectType>> {
    list_database_page_identities(
      ctx,
      self.id,
      first,
      offset,
      myoxus_domain::database::DatabaseLifecycleFilter::Trashed,
    )
    .await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn database(&self, ctx: &Context<'_>, database_id: ID) -> Result<Option<DatabaseRecordObjectType>> {
    get_database(ctx, self.id, database_id).await
  }

  async fn database_task_capture_receipt(
    &self,
    ctx: &Context<'_>,
    request_id: ID,
  ) -> Result<Option<DatabaseTaskCaptureResultObjectType>> {
    get_database_task_capture_receipt(ctx, self.id, request_id).await
  }

  async fn database_summary(&self, ctx: &Context<'_>, database_id: ID) -> Result<Option<DatabaseSummaryObjectType>> {
    get_database_summary(ctx, self.id, database_id).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  /// Read the canonical Row. Trash inclusion is explicit and grants no write
  /// authority; existing editable consumers retain the live-only default.
  async fn database_row(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    row_id: ID,
    #[graphql(default = false)] include_trashed: bool,
  ) -> Result<Option<DatabaseRowRecordObjectType>> {
    get_database_row(ctx, self.id, database_id, row_id, include_trashed).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  async fn database_row_reminders(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    row_id: ID,
    field_id: ID,
  ) -> Result<Vec<DatabaseRowReminderObjectType>> {
    list_database_row_reminders(ctx, self.id, database_id, row_id, field_id).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  async fn database_view(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    view_id: ID,
  ) -> Result<Option<DatabaseViewObjectType>> {
    get_database_view(ctx, self.id, database_id, view_id).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  async fn database_effective_view_state(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    view_id: ID,
  ) -> Result<DatabaseEffectiveViewStateObjectType> {
    get_database_effective_view_state(ctx, self.id, database_id, view_id).await
  }

  /// Guided help projects authored public source choices, never the creator's
  /// answers or personal preferences. Native admission reads current scope.
  #[instrument(skip_all)]
  #[graphql(complexity = 50)]
  async fn workspace_setup_assistance(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Option<super::database::WorkspaceSetupAssistanceObjectType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let packages = state
      .assistant_packages()
      .ok_or_else(|| async_graphql::Error::new("Workspace assistant packages unavailable"))?;
    state
      .workspace()
      .workspace_setup_assistance(snapshot.user.id, self.id, &packages, state.auth())
      .await
      .map(|descriptor| descriptor.map(Into::into))
      .map_err(map_workspace_starter_error)
  }

  // This bounded native projection resolves once; DTO leaves perform no I/O.
  #[graphql(complexity = 50)]
  async fn assistant_packages(
    &self,
    ctx: &Context<'_>,
    context: super::database::AssistantPackageContextType,
  ) -> Result<Vec<super::database::AssistantPackageObjectType>> {
    super::database::list_assistant_packages(ctx, self.id, context).await
  }
  // This bounded native projection resolves once; DTO leaves perform no I/O.
  #[graphql(complexity = 50)]
  async fn assistant_presentation(
    &self,
    ctx: &Context<'_>,
    context: super::database::AssistantPackageContextType,
    database_id: Option<ID>,
    row_id: Option<ID>,
  ) -> Result<super::database::AssistantResolvedPresentationObjectType> {
    super::database::resolve_assistant_presentation(ctx, self.id, context, database_id, row_id).await
  }

  #[graphql(complexity = 50)]
  async fn assistant_document_source(
    &self,
    ctx: &Context<'_>,
    input: super::database::AssistantDocumentSourceInput,
  ) -> Result<Option<super::template_suggestions::TemplateSuggestionItemObjectType>> {
    super::database::resolve_assistant_document_source(ctx, self.id, input).await
  }
  // This bounded native projection resolves once; DTO leaves perform no I/O.
  #[graphql(complexity = 50)]
  async fn prepare_project_assistant(
    &self,
    ctx: &Context<'_>,
    input: super::database::PrepareProjectAssistantInput,
  ) -> Result<super::database::PreparedProjectAssistantObjectType> {
    super::database::prepare_project_assistant(ctx, self.id, input).await
  }

  #[graphql(complexity = 50)]
  async fn project_setup(
    &self,
    ctx: &Context<'_>,
    request_id: ID,
  ) -> Result<Option<super::database::ProjectSetupObjectType>> {
    super::database::project_setup(ctx, self.id, request_id).await
  }

  #[graphql(complexity = 50)]
  async fn prepare_context_documents(
    &self,
    ctx: &Context<'_>,
    input: super::database::PrepareContextDocumentsInput,
  ) -> Result<super::database::ContextDocumentsPreparationObjectType> {
    super::database::prepare_context_documents(ctx, self.id, input).await
  }

  #[graphql(complexity = 50)]
  async fn context_documents(
    &self,
    ctx: &Context<'_>,
    request_id: ID,
  ) -> Result<Option<super::database::ContextDocumentsObjectType>> {
    super::database::context_documents(ctx, self.id, request_id).await
  }

  #[graphql(complexity = 50)]
  async fn prepare_task_handover(
    &self,
    ctx: &Context<'_>,
    input: super::database::PrepareTaskHandoverInput,
  ) -> Result<super::database::PreparedTaskHandoverObjectType> {
    super::database::prepare_task_handover(ctx, self.id, input).await
  }
  #[graphql(complexity = 50)]
  async fn task_handover(
    &self,
    ctx: &Context<'_>,
    run_id: ID,
  ) -> Result<Option<super::database::TaskHandoverObjectType>> {
    super::database::task_handover(ctx, self.id, run_id).await
  }
  #[graphql(complexity = 50)]
  async fn task_handover_request(
    &self,
    ctx: &Context<'_>,
    request_id: ID,
  ) -> Result<Option<super::database::TaskHandoverObjectType>> {
    super::database::task_handover_request(ctx, self.id, request_id).await
  }

  #[graphql(complexity = 50)]
  async fn prepare_task_preparation(
    &self,
    ctx: &Context<'_>,
    input: super::database::PrepareTaskPreparationInput,
  ) -> Result<super::database::PreparedTaskPreparationObjectType> {
    super::database::prepare_task_preparation(ctx, self.id, input).await
  }
  #[graphql(complexity = 50)]
  async fn prepare_task_maintenance_rule(
    &self,
    ctx: &Context<'_>,
    input: super::database::PrepareTaskMaintenanceInput,
  ) -> Result<super::database::PreparedTaskMaintenanceObjectType> {
    super::database::prepare_task_maintenance_rule(ctx, self.id, input).await
  }
  #[graphql(complexity = 50)]
  async fn task_preparation(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
  ) -> Result<Option<super::database::TaskPreparationConfigurationObjectType>> {
    super::database::task_preparation(ctx, self.id, database_id).await
  }
  #[graphql(complexity = 50)]
  async fn task_preparation_run(
    &self,
    ctx: &Context<'_>,
    run_id: ID,
  ) -> Result<Option<super::database::TaskPreparationRunObjectType>> {
    super::database::task_preparation_run(ctx, self.id, run_id).await
  }
  #[graphql(complexity = 50)]
  async fn task_maintenance_rule(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
  ) -> Result<Option<super::database::TaskPreparationConfigurationObjectType>> {
    super::database::task_maintenance_rule(ctx, self.id, database_id).await
  }
  #[graphql(complexity = 50)]
  async fn prepare_task_maintenance(
    &self,
    ctx: &Context<'_>,
    input: super::database::PrepareTaskMaintenanceInput,
  ) -> Result<super::database::PreparedTaskMaintenanceObjectType> {
    super::database::prepare_task_maintenance(ctx, self.id, input).await
  }
  #[graphql(complexity = 50)]
  async fn task_maintenance(
    &self,
    ctx: &Context<'_>,
    run_id: ID,
  ) -> Result<Option<super::database::TaskMaintenanceObjectType>> {
    super::database::task_maintenance(ctx, self.id, run_id).await
  }
  #[graphql(complexity = 50)]
  async fn task_maintenance_request(
    &self,
    ctx: &Context<'_>,
    request_id: ID,
  ) -> Result<Option<super::database::TaskMaintenanceObjectType>> {
    super::database::task_maintenance_request(ctx, self.id, request_id).await
  }

  #[graphql(complexity = 50)]
  async fn prepare_document_review(
    &self,
    ctx: &Context<'_>,
    input: super::database::PrepareDocumentReviewInput,
  ) -> Result<super::database::PreparedDocumentReviewObjectType> {
    super::database::prepare_document_review(ctx, self.id, input).await
  }

  #[graphql(complexity = 50)]
  async fn document_review(
    &self,
    ctx: &Context<'_>,
    run_id: ID,
  ) -> Result<Option<super::database::DocumentReviewObjectType>> {
    super::database::document_review(ctx, self.id, run_id).await
  }

  #[graphql(complexity = 50)]
  async fn document_review_request(
    &self,
    ctx: &Context<'_>,
    request_id: ID,
  ) -> Result<Option<super::database::DocumentReviewObjectType>> {
    super::database::document_review_request(ctx, self.id, request_id).await
  }

  #[graphql(complexity = 50)]
  async fn document_review_for_task(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    row_id: ID,
  ) -> Result<Option<super::database::DocumentReviewObjectType>> {
    super::database::document_review_for_task(ctx, self.id, database_id, row_id).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  async fn database_starter_templates(&self, ctx: &Context<'_>) -> Result<Vec<DatabaseStarterTemplateObjectType>> {
    list_database_starter_templates(ctx, self.id).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn database_task_references(
    &self,
    ctx: &Context<'_>,
    targets: Vec<DatabaseTaskReferenceInput>,
  ) -> Result<Vec<DatabaseTaskReferenceObjectType>> {
    list_workspace_database_task_references(ctx, self.id, targets).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn database_tasks(
    &self,
    ctx: &Context<'_>,
    input: DatabaseTasksInput,
    first: Option<i32>,
    after: Option<String>,
  ) -> Result<DatabaseTasksPageObjectType> {
    list_workspace_database_tasks(ctx, self.id, input, first, after).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn database_task_destinations(
    &self,
    ctx: &Context<'_>,
    first: Option<i32>,
    after: Option<ID>,
  ) -> Result<DatabaseTaskDestinationsObjectType> {
    list_database_task_destinations(ctx, self.id, first, after).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn prepare_database_task_move(
    &self,
    ctx: &Context<'_>,
    input: DatabaseTaskMoveInput,
  ) -> Result<DatabaseTaskMovePreviewObjectType> {
    prepare_database_task_move(ctx, self.id, input).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  #[expect(
    clippy::too_many_arguments,
    reason = "the arguments are generated as independent GraphQL fields"
  )]
  async fn database_rows(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    first: Option<i32>,
    offset: Option<i32>,
    view_id: Option<ID>,
    search: Option<String>,
    sort: Option<Vec<DatabaseSortRuleInput>>,
    filter: Option<Vec<DatabaseFilterRuleInput>>,
    filter_tree: Option<DatabaseFilterGroupInput>,
    after: Option<String>,
    schedule_window: Option<DatabaseScheduleWindowInput>,
  ) -> Result<DatabaseRowsPageObjectType> {
    list_database_rows(
      ctx,
      self.id,
      database_id,
      first,
      offset,
      view_id,
      search,
      sort,
      filter,
      filter_tree,
      after,
      schedule_window,
    )
    .await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn database_progress(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    view_id: ID,
  ) -> Result<DatabaseProgressSummaryObjectType> {
    read_database_progress(ctx, self.id, database_id, view_id).await
  }

  /// P-DB-24: workspace-visible database activity stream.
  #[graphql(complexity = "10 * child_complexity")]
  async fn database_activity(
    &self,
    ctx: &Context<'_>,
    #[graphql(name = "filter")] filter: Option<super::database::DatabaseActivityFilterInput>,
    #[graphql(name = "skip")] skip: Option<i32>,
    #[graphql(name = "take")] take: Option<i32>,
  ) -> Result<Vec<super::database::DatabaseActivityEventObjectType>> {
    database_activity(ctx, self.id, filter, skip, take).await
  }

  /// P-DB-24: per-row database activity stream.
  #[graphql(complexity = "5 * child_complexity")]
  async fn database_row_activity(
    &self,
    ctx: &Context<'_>,
    #[graphql(name = "rowId")] row_id: ID,
    #[graphql(name = "skip")] skip: Option<i32>,
    #[graphql(name = "take")] take: Option<i32>,
  ) -> Result<Vec<super::database::DatabaseActivityEventObjectType>> {
    database_row_activity(ctx, self.id, row_id, skip, take).await
  }

  /// P-DB-25: full-text search across database rows in this workspace.
  /// Workspace ACL is enforced by the membership lookup inside the
  /// SQL filter; the response is capped at 500 hits per call.
  #[graphql(complexity = "10 * child_complexity")]
  async fn database_search(
    &self,
    ctx: &Context<'_>,
    #[graphql(name = "filter")] filter: super::database::DatabaseSearchFilterInput,
  ) -> Result<Vec<super::database::DatabaseSearchHitObjectType>> {
    database_search(ctx, self.id, filter).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn database_row_groups(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    view_id: ID,
    search: Option<String>,
    schedule_window: Option<super::database::DatabaseScheduleWindowInput>,
    locale: Option<String>,
  ) -> Result<Vec<DatabaseRowGroupSummaryObjectType>> {
    list_database_row_groups(ctx, self.id, database_id, view_id, search, schedule_window, locale).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn database_row_template_body_inputs(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    row_template_id: ID,
  ) -> Result<super::database::DatabaseRowTemplateBodyInputsObjectType> {
    super::database::database_row_template_body_inputs(ctx, self.id, database_id, row_template_id).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn database_row_templates(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
  ) -> Result<Vec<DatabaseRowTemplateBindingObjectType>> {
    list_database_row_templates(ctx, self.id, database_id).await
  }

  #[graphql(complexity = "20 * child_complexity")]
  async fn database_csv_export(
    &self,
    ctx: &Context<'_>,
    database_id: ID,
    options: Option<DatabaseCsvExportOptionsInput>,
  ) -> Result<DatabaseCsvExportObjectType> {
    export_database_csv_query(ctx, self.id, database_id, options).await
  }

  /// P-DB-27: list every current CSV mapping template for the
  /// workspace, ordered most-recently-updated first. Used by the
  /// wizard's "reuse template" dropdown.
  async fn database_csv_mapping_templates(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<DatabaseCsvMappingTemplateSummaryObjectType>> {
    database_csv_mapping_templates_query(ctx, self.id).await
  }

  #[graphql(complexity = "20 * child_complexity")]
  async fn database_json_export(&self, ctx: &Context<'_>, database_id: ID) -> Result<DatabaseJsonExportObjectType> {
    export_database_json_query(ctx, self.id, database_id).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn automations(
    &self,
    ctx: &Context<'_>,
    first: Option<i32>,
    offset: Option<i32>,
  ) -> Result<Vec<WorkspaceAutomationObjectType>> {
    list_workspace_automations(ctx, self.id, first, offset).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn task_recurrence(
    &self,
    ctx: &Context<'_>,
    input: super::recurrence::TaskRecurrenceLookupInput,
  ) -> Result<Option<super::recurrence::TaskRecurrenceObject>> {
    super::recurrence::read(ctx, self.id, input).await
  }

  #[graphql(complexity = "20 * child_complexity")]
  async fn task_recurrences(
    &self,
    ctx: &Context<'_>,
    after: Option<ID>,
    first: Option<i32>,
  ) -> Result<Vec<super::recurrence::TaskRecurrenceObject>> {
    super::recurrence::list(ctx, self.id, after, first).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  async fn recurrence_preview(
    &self,
    ctx: &Context<'_>,
    input: super::recurrence::RecurrencePreviewInput,
  ) -> Result<Vec<super::recurrence::RecurrencePreviewObject>> {
    super::recurrence::preview(ctx, self.id, input).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn automation_runs(
    &self,
    ctx: &Context<'_>,
    automation_id: Option<ID>,
    include_dead_letter: Option<bool>,
    first: Option<i32>,
    offset: Option<i32>,
  ) -> Result<Vec<WorkspaceAutomationRunObjectType>> {
    list_workspace_automation_runs(ctx, self.id, automation_id, include_dead_letter, first, offset).await
  }

  #[graphql(complexity = "20 * child_complexity")]
  async fn document_graph(
    &self,
    ctx: &Context<'_>,
    input: DocumentGraphInput,
  ) -> Result<DocumentGraphResultObjectType> {
    read_workspace_document_graph(ctx, self.id, input).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn document_links(
    &self,
    ctx: &Context<'_>,
    input: DocumentLinksInput,
  ) -> Result<DocumentLinksResultObjectType> {
    read_document_links(ctx, self.id, input).await
  }

  #[graphql(complexity = "5 * child_complexity")]
  async fn document_graph_index_status(
    &self,
    ctx: &Context<'_>,
    doc_id: Option<ID>,
  ) -> Result<DocumentGraphIndexStatusObjectType> {
    read_document_graph_index_status(ctx, self.id, doc_id).await
  }

  #[graphql(complexity = "10 * child_complexity")]
  async fn template_suggestions(
    &self,
    ctx: &Context<'_>,
    input: TemplateSuggestionInput,
  ) -> Result<TemplateSuggestionResultObjectType> {
    read_template_suggestions(ctx, self.id, input).await
  }

  /// Workspace embedding resolver — exposes files, ignoredDocs, allIgnoredDocs.
  ///
  /// P25-A-36/39/40: `workspace { embedding { files(...), ignoredDocs(...), allIgnoredDocs } }`
  ///
  /// Complexity 10 * child: permission check + child fields trigger DB queries.
  #[graphql(complexity = "10 * child_complexity")]
  #[instrument(skip_all)]
  async fn embedding(&self, ctx: &Context<'_>) -> Result<crate::graphql::WorkspaceEmbeddingType> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    Ok(crate::graphql::WorkspaceEmbeddingType { workspace_id: self.id })
  }

  /// Complexity 5: triggers a DB query to check workspace initialization state.
  #[graphql(complexity = 5)]
  #[instrument(skip_all)]
  async fn initialized(&self, ctx: &Context<'_>) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
    state.workspace().is_initialized(self.id).await.map_err(map_gql_error)
  }

  /// Complexity 5: triggers a DB query to fetch the user's workspace role.
  #[graphql(complexity = 5)]
  #[instrument(skip_all)]
  pub(crate) async fn role(&self, ctx: &Context<'_>) -> Result<WorkspaceRole> {
    let (state, snapshot) = require_session(ctx).await?;

    let role = state
      .auth()
      .store
      .get_workspace_role(snapshot.user.id, self.id)
      .await
      .map_err(map_gql_error)?;
    let final_role = role.unwrap_or(WorkspaceRoleModel::External);
    trace!(workspace_id = %self.id, user_id = %snapshot.user.id, role = ?final_role, "fetched workspace role");
    Ok(final_role.into())
  }

  /// Complexity 5: resolves direct membership plus OU-manager scope once.
  #[graphql(complexity = 5)]
  #[instrument(skip_all)]
  pub(crate) async fn permissions(&self, ctx: &Context<'_>) -> Result<WorkspacePermissions> {
    let (state, snapshot) = require_session(ctx).await?;
    let role = state
      .permission_service()
      .get_effective_workspace_role(snapshot.user.id, self.id)
      .await
      .map_err(map_gql_error)?
      .unwrap_or(WorkspaceRoleModel::External);
    Ok(WorkspacePermissions::from_role(role))
  }

  /// Complexity 5: triggers a DB COUNT query.
  #[graphql(complexity = 5)]
  #[instrument(skip(self, ctx))]
  async fn member_count(&self, ctx: &Context<'_>) -> Result<i64> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
    state.workspace().member_count(self.id).await.map_err(map_gql_error)
  }

  /// Authoritative workspace classification derived from ownership.
  ///
  /// - the one canonical userspace → "Personal"
  /// - another user-owned workspace → "UserOwned"
  /// - an OU-owned workspace → "Shared"
  #[graphql(name = "workspaceType", complexity = 5)]
  #[instrument(skip_all)]
  async fn workspace_type(&self, ctx: &Context<'_>) -> Result<String> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
    let classification = state
      .workspace()
      .workspace_classification(self.id)
      .await
      .map_err(map_gql_error)?;
    Ok(
      match classification {
        Some(myoxus_application::workspace::WorkspaceClassification::Personal) => "Personal",
        Some(myoxus_application::workspace::WorkspaceClassification::Shared) => "Shared",
        _ => "UserOwned",
      }
      .to_string(),
    )
  }

  /// Complexity 10: permission check + doc metadata DB query.
  #[graphql(complexity = 10)]
  #[instrument(skip(self, ctx))]
  async fn doc(&self, ctx: &Context<'_>, doc_id: String) -> Result<Option<WorkspaceDocType>> {
    let (state, snapshot) = require_session(ctx).await?;

    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;

    let doc_uuid = match crate::graphql::utils::resolve_doc_id(&state, self.id, &doc_id).await {
      Ok(doc_id) => doc_id,
      Err(_) => return Ok(None),
    };
    let Some(meta) = state
      .doc()
      .get_metadata_including_deleted(doc_uuid)
      .await
      .map_err(map_gql_error)?
    else {
      return Ok(None);
    };
    if meta.workspace_id != Some(self.id) {
      return Ok(None);
    }
    let is_trashed = meta.deleted_at.is_some();
    let document_key = DocumentKey::parse(meta.external_id.clone())
      .map_err(|error| async_graphql::Error::new(format!("invalid document key: {error}")))?;
    crate::document_access::authorize_workspace_document(
      &state,
      snapshot.user.id,
      self.id,
      myoxus_application::doc::DocSpaceKind::Workspace,
      &document_key,
      if is_trashed {
        DocAction::Restore
      } else {
        DocAction::Read
      },
    )
    .await
    .map_err(map_gql_error)?;

    let summary = if is_trashed {
      None
    } else {
      load_workspace_doc_summary(&state, self.id, doc_uuid).await?
    };

    Ok(Some(WorkspaceDocType {
      id: meta.external_id,
      workspace_id: self.id.to_string(),
      public: meta.public_mode.is_some(),
      mode: compat_public_doc_mode_from_db(meta.public_mode.clone()),
      default_role: compat_default_doc_role_from_domain(meta.default_role),
      title: Some(meta.title),
      summary,
      created_at: Some(meta.created_at),
      updated_at: Some(meta.updated_at),
    }))
  }

  /// Complexity 20: permission check + paginated member list with user joins.
  #[graphql(complexity = "20 * child_complexity")]
  #[instrument(skip(self, ctx))]
  async fn members(
    &self,
    ctx: &Context<'_>,
    skip: Option<i64>,
    take: Option<i64>,
    query: Option<String>,
  ) -> Result<Vec<WorkspaceMemberType>> {
    let (state, snapshot) = require_session(ctx).await?;

    let pc = state.permission_service();
    if let Err(e) = pc
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::UsersRead,
      )
      .await
    {
      warn!(workspace_id = %self.id, user_id = %snapshot.user.id, "permission denied for listing members");
      return Err(map_gql_error(e));
    }

    let members = state
      .workspace()
      .list_members(self.id, skip.unwrap_or(0), take.unwrap_or(8), query)
      .await
      .map_err(map_gql_error)?;
    Ok(members.into_iter().map(WorkspaceMemberType::from_model).collect())
  }

  /// Complexity 10: DB query to fetch workspace owner with user data.
  #[graphql(complexity = "10 * child_complexity")]
  #[instrument(skip(self, ctx))]
  async fn owner(&self, ctx: &Context<'_>) -> Result<Option<UserType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
    let owner = state.workspace().get_owner(self.id).await.map_err(map_gql_error)?;

    Ok(owner.map(|owner| {
      AuthUser {
        id: owner.id,
        email: owner.email,
        name: Some(owner.name),
        avatar_url: owner.avatar_url,
        password_hash: owner.password_hash,
        is_admin: owner.is_admin,
        disabled: owner.disabled,
        email_verified_at: owner.email_verified_at,
        registered: owner.registered,
      }
      .into()
    }))
  }

  /// Complexity 10: permission check + invite link DB query.
  #[graphql(complexity = 10)]
  #[instrument(skip(self, ctx))]
  async fn invite_link(&self, ctx: &Context<'_>) -> Result<Option<InviteLinkType>> {
    let (state, snapshot) = require_session(ctx).await?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: self.id,
      },
      WorkspaceAction::UsersRead,
    )
    .await
    .map_err(map_gql_error)?;

    let link = state
      .workspace()
      .get_invite_link(self.id)
      .await
      .map_err(map_gql_error)?;
    let server_origin = state.effective_config().await.server_origin();
    Ok(link.and_then(|l| {
      l.expires_at.map(|expires_at| InviteLinkType {
        link: workspace_invite_url(&server_origin, &l.token_hash),
        expire_time: expires_at,
      })
    }))
  }

  /// Complexity 20: permission check + two DB queries (accounts + workspace calendars).
  #[graphql(complexity = "20 * child_complexity")]
  #[instrument(skip(self, ctx))]
  async fn calendars(&self, ctx: &Context<'_>) -> Result<Vec<WorkspaceCalendarObjectType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let account_owner = calendar
      .list_accounts(snapshot.user.id)
      .await
      .map_err(map_gql_error)?
      .into_iter()
      .map(|a| (a.id, a.user_id))
      .collect::<std::collections::HashMap<Uuid, Uuid>>();
    let rows = calendar
      .list_workspace_calendars(self.id)
      .await
      .map_err(map_gql_error)?;
    // Always prepend a virtual native-events calendar (nil UUID sentinel).
    // This ensures the frontend can always discover and fetch native workspace events
    // even when no CalDAV subscriptions are configured.
    let native_id = format!("{}:native", self.id);
    let native_item = WorkspaceCalendarItemObjectType {
      id: native_id.clone(),
      subscription_id: native_id.clone(),
      sort_order: Some(-1),
      color_override: None,
      enabled: true,
    };
    let native_calendar = WorkspaceCalendarObjectType {
      id: native_id.clone(),
      workspace_id: self.id.to_string(),
      created_by_user_id: snapshot.user.id.to_string(),
      display_name_override: None,
      color_override: None,
      enabled: true,
      items: vec![native_item],
      account_id: Uuid::nil().to_string(),
    };
    let mut result = vec![native_calendar];
    result.extend(rows.into_iter().map(|row| {
      map_workspace_calendar_object(
        row.clone(),
        account_owner.get(&row.account_id).copied().unwrap_or(snapshot.user.id),
      )
    }));
    Ok(result)
  }

  /// Complexity 50: permission check + thread list + per-thread reply fetches + batch author lookup.
  #[graphql(complexity = "50 * child_complexity")]
  #[instrument(skip(self, ctx, pagination))]
  async fn comments(
    &self,
    ctx: &Context<'_>,
    doc_id: String,
    pagination: Option<PaginationInputType>,
  ) -> Result<PaginatedCommentObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, self.id, &doc_id).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let page = pagination.unwrap_or_default();
    let skip = page.offset.unwrap_or(0).max(0) as i64;
    let take = page.first.unwrap_or(20).clamp(1, 100) as i64;
    let filter = myoxus_application::comment::CommentThreadFilter::All;
    let threads = state
      .comment()
      .list_comment_threads(snapshot.user.id, self.id, doc_uuid, skip, take, filter)
      .await
      .map_err(map_gql_error)?;
    // Phase 1: Load all replies for each thread (still per-thread, but needed
    // for the reply data).  Collect all unique author IDs from threads + replies.
    let mut author_ids = HashSet::new();
    let mut thread_replies = Vec::with_capacity(threads.len());
    for thread in &threads {
      author_ids.insert(thread.comment.author_id);
      let replies = state
        .comment()
        .list_comment_replies(snapshot.user.id, self.id, doc_uuid, thread.comment.id, 0, 100)
        .await
        .map_err(map_gql_error)?;
      for reply in &replies {
        author_ids.insert(reply.author_id);
      }
      thread_replies.push(replies);
    }

    // Phase 2: Batch-fetch all authors in ONE query.
    let author_ids_vec: Vec<Uuid> = author_ids.into_iter().collect();
    let authors = state
      .auth()
      .store
      .get_historical_profiles(&author_ids_vec)
      .await
      .map_err(map_gql_error)?;

    // Helper closure: resolve author → PublicUserType with fallback.
    let resolve_author = |author_id: Uuid| -> PublicUserType {
      match authors.get(&author_id) {
        Some(value) => PublicUserType {
          id: ID::from(value.id.to_string()),
          email: value.email.clone(),
          name: value.name.clone().unwrap_or_else(|| value.email.clone()),
          avatar_url: value.avatar_url.clone(),
        },
        None => PublicUserType {
          id: ID::from(author_id.to_string()),
          email: String::new(),
          name: "Unknown".to_string(),
          avatar_url: None,
        },
      }
    };

    // Phase 3: Assemble the response using the pre-fetched author map.
    let mut edges = Vec::with_capacity(threads.len());
    for (idx, (thread, replies)) in threads.into_iter().zip(thread_replies).enumerate() {
      let user = resolve_author(thread.comment.author_id);
      let mapped_replies: Vec<ReplyObjectType> = replies
        .into_iter()
        .map(|reply| {
          let reply_user = resolve_author(reply.author_id);
          ReplyObjectType {
            id: ID::from(reply.id.to_string()),
            comment_id: ID::from(thread.comment.id.to_string()),
            content: reply.body,
            created_at: reply.created_at,
            updated_at: reply.updated_at,
            user: reply_user,
          }
        })
        .collect();
      edges.push(CommentObjectTypeEdge {
        cursor: format!("comment:{skip}:{}", idx as i64 + skip),
        node: CommentObjectType {
          id: ID::from(thread.comment.id.to_string()),
          parent_comment_id: thread
            .comment
            .parent_comment_id
            .map(|value| ID::from(value.to_string())),
          content: thread.comment.body,
          resolved: thread.comment.resolved,
          created_at: thread.comment.created_at,
          updated_at: thread.comment.updated_at,
          user,
          replies: mapped_replies,
        },
      });
    }
    let start_cursor = edges.first().map(|edge| edge.cursor.clone());
    let end_cursor = edges.last().map(|edge| edge.cursor.clone());
    Ok(PaginatedCommentObjectType {
      total_count: edges.len() as i32,
      edges,
      page_info: PageInfoType {
        start_cursor,
        end_cursor,
        has_next_page: false,
        has_previous_page: skip > 0,
      },
    })
  }

  /// Complexity 50: permission check + thread list + change assembly.
  #[graphql(complexity = "50 * child_complexity")]
  #[instrument(skip(self, ctx, pagination))]
  async fn comment_changes(
    &self,
    ctx: &Context<'_>,
    doc_id: String,
    pagination: PaginationInputType,
  ) -> Result<PaginatedCommentChangeObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, self.id, &doc_id).await?;
    let skip = pagination.offset.unwrap_or(0).max(0) as usize;
    let take = pagination.first.unwrap_or(20).clamp(1, 100) as usize;
    let threads = state
      .comment()
      .list_comment_threads(
        snapshot.user.id,
        self.id,
        doc_uuid,
        0,
        200,
        myoxus_application::comment::CommentThreadFilter::All,
      )
      .await
      .map_err(map_gql_error)?;
    let mut changes = Vec::new();
    for thread in threads {
      let history = state
        .comment()
        .list_comment_edit_history(snapshot.user.id, self.id, doc_uuid, thread.comment.id, 0, 100)
        .await
        .map_err(map_gql_error)?;
      for value in history {
        changes.push(CommentChangeObjectType {
          id: ID::from(value.id.to_string()),
          comment_id: Some(ID::from(value.comment_id.to_string())),
          action: CommentChangeActionType::Update,
          item: value.body,
        });
      }
      let replies = state
        .comment()
        .list_comment_replies(snapshot.user.id, self.id, doc_uuid, thread.comment.id, 0, 100)
        .await
        .map_err(map_gql_error)?;
      for reply in replies {
        let reply_history = state
          .comment()
          .list_comment_edit_history(snapshot.user.id, self.id, doc_uuid, reply.id, 0, 100)
          .await
          .map_err(map_gql_error)?;
        for value in reply_history {
          changes.push(CommentChangeObjectType {
            id: ID::from(value.id.to_string()),
            comment_id: Some(ID::from(value.comment_id.to_string())),
            action: CommentChangeActionType::Update,
            item: value.body,
          });
        }
      }
    }
    changes.sort_by(|a, b| b.id.to_string().cmp(&a.id));
    let total_count = changes.len() as i32;
    let page = changes
      .into_iter()
      .skip(skip)
      .take(take)
      .enumerate()
      .map(|(idx, value)| CommentChangeObjectTypeEdge {
        cursor: format!("change:{}:{}", skip, skip + idx),
        node: value,
      })
      .collect::<Vec<_>>();
    let start_cursor = page.first().map(|edge| edge.cursor.clone());
    let end_cursor = page.last().map(|edge| edge.cursor.clone());
    Ok(PaginatedCommentChangeObjectType {
      total_count,
      edges: page,
      page_info: PageInfoType {
        start_cursor,
        end_cursor,
        has_next_page: (skip + take) < (total_count as usize),
        has_previous_page: skip > 0,
      },
    })
  }

  /// Resolve the effective workspace-owned storage quota and current usage.
  #[instrument(skip_all)]
  async fn quota(&self, ctx: &Context<'_>) -> UserQuotaType {
    let Ok(state) = ctx.data::<Arc<ApiState>>() else {
      return neutral_user_quota(QuotaPlan::Pro, &CompatibilityQuotaConfig::default());
    };

    // Member count is always needed — available via application service.
    let member_count = match state.workspace().member_count(self.id).await {
      Ok(count) => count.min(i32::MAX as i64) as i32,
      Err(error) => {
        warn!(workspace_id = %self.id, error = %error, "failed to count workspace members for quota");
        0
      }
    };

    // P112-QUOTA / A-04: Resolve quota snapshot via infrastructure layer (no inline SQL).
    // Falls back to static config when pool is unavailable (e.g. test-only builds).
    if let Some(pool) = state.metrics_pool() {
      let snap = myoxus_infrastructure::quota_resolver::resolve_workspace_quota_full(
        &pool,
        self.id,
        state.config.storage.default_workspace_quota_mb,
      )
      .await;

      if let Some(snap) = snap {
        let used_storage = snap.used_bytes();

        let member_limit = state.config.compat.quota.member_limit;

        let overcapacity_member_count = (member_count - member_limit).max(0);
        let plan_name = state.config.compat.quota_plan.display_name().to_string();
        let quota = &state.config.compat.quota;

        trace!(
          workspace_id = %self.id,
          workspace_override = ?snap.workspace_override_bytes,
          config_default_mb = snap.config_default_mb,
          effective_bytes = snap.effective_bytes,
          used_storage,
          member_limit,
          "workspace quota resolved from DB snapshot"
        );

        // 0 = unlimited in server convention; expose as 2^53-1 (JS Number.MAX_SAFE_INTEGER)
        // so the client receives a truthy, precisely-representable integer (BUG-QUOTA-01).
        // i64::MAX exceeds JS safe integer range and causes precision loss in the browser.
        const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
        let effective_for_client = if snap.effective_bytes == 0 {
          JS_MAX_SAFE_INTEGER
        } else {
          snap.effective_bytes
        };

        return UserQuotaType {
          name: plan_name.clone(),
          blob_limit: quota.blob_limit,
          storage_quota: effective_for_client,
          used_storage_quota: used_storage,
          history_period: quota.history_period,
          member_limit,
          member_count,
          overcapacity_member_count,
          human_readable: super::UserQuotaHumanReadableType {
            name: plan_name,
            blob_limit: super::format_bytes_human(quota.blob_limit as i64),
            storage_quota: super::format_bytes_human(effective_for_client),
            history_period: if quota.history_period <= 0 {
              "Unlimited".to_string()
            } else {
              format!("{} days", quota.history_period)
            },
            member_limit: if member_limit <= 0 {
              "Unlimited".to_string()
            } else {
              member_limit.to_string()
            },
            member_count: member_count.to_string(),
            overcapacity_member_count: overcapacity_member_count.to_string(),
          },
        };
      }
    }

    // Fallback path: no pool or workspace not found — use static config values.
    neutral_user_quota_with_member_usage(
      state.config.compat.quota_plan.clone(),
      &state.config.compat.quota,
      member_count,
    )
  }

  /// List all publicly shared documents in this workspace.
  ///
  /// Returns `[DocType!]!` — the same type used by publishDoc/revokePublicDoc.
  /// Frontend uses this in "Shared Pages" settings to show which docs are public.
  #[instrument(skip(self, ctx))]
  async fn public_docs(&self, ctx: &Context<'_>) -> Result<Vec<DocCompatType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;

    let docs = state.doc().list_public_docs(self.id).await.map_err(map_gql_error)?;
    let candidate_ids: Vec<Uuid> = docs.iter().map(|doc| doc.id).collect();
    let readable = state
      .permission_service()
      .readable_doc_ids(snapshot.user.id, self.id, &candidate_ids)
      .await
      .map_err(map_gql_error)?;

    Ok(
      docs
        .into_iter()
        .filter(|doc| readable.contains(&doc.id))
        .map(|doc| DocCompatType {
          id: doc.external_id,
          workspace_id: self.id.to_string(),
          public: true,
          mode: match doc.public_mode.as_deref() {
            Some(mode) if mode.eq_ignore_ascii_case("edgeless") => PublicDocModeType::Edgeless,
            _ => PublicDocModeType::Page,
          },
          default_role: compat_default_doc_role_from_domain(doc.default_role),
          created_at: Some(doc.created_at),
          updated_at: Some(doc.updated_at),
        })
        .collect(),
    )
  }

  #[instrument(skip(self, ctx))]
  async fn blobs(&self, ctx: &Context<'_>) -> Result<Vec<ListedBlobType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::BlobsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let blobs = state
      .blob()
      .list_workspace_blobs(self.id, 200, 0, false)
      .await
      .map_err(map_gql_error)?;
    Ok(
      blobs
        .into_iter()
        .map(|blob| ListedBlobType {
          key: blob.key,
          size: blob.size.min(i32::MAX as u64) as i32,
          mime: blob.mime,
          created_at: blob.created_at,
        })
        .collect(),
    )
  }

  #[instrument(skip(self, ctx))]
  async fn blobs_size(&self, ctx: &Context<'_>) -> Result<i32> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::BlobsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let total = state
      .blob()
      .workspace_blob_size(self.id, false)
      .await
      .map_err(map_gql_error)?;
    Ok(total.min(i32::MAX as u64) as i32)
  }

  #[instrument(skip(self, ctx, input))]
  async fn search(&self, ctx: &Context<'_>, input: SearchInputType) -> Result<SearchResultObjectType> {
    // P1 (SRV-01): compile and evaluate the SearchQueryInputType plan. The
    // resolver no longer reduces the query to a single keyword string — the
    // plan compiler/evaluator owns set algebra and the deterministic error
    // surface for unsupported operators.
    let plan = search_query_plan::compile_plan(&input.query).map_err(|err| plan_error_to_gql("search", &err))?;
    let (state, snapshot) = require_session(ctx).await?;
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: self.id,
      },
      WorkspaceAction::Read,
    )
    .await
    .map_err(map_gql_error)?;
    let repo = state.search_repository().ok_or_else(|| {
      map_gql_error(myoxus_application::auth::AuthError::Storage(
        "search repository is not configured".to_string(),
      ))
    })?;
    let hits = search_query_plan::evaluate_plan(&plan, self.id, None, repo.as_ref())
      .await
      .map_err(|err| plan_error_to_gql("search", &err))?;
    let docs = if !hits.documents.is_empty() {
      hits.documents
    } else {
      let ids: Vec<Uuid> = hits.doc_ids.iter().copied().collect();
      repo
        .list_search_docs_by_ids(self.id, &ids)
        .await
        .map_err(search_query_plan::SearchPlanError::execution_unavailable)
        .map_err(|err| plan_error_to_gql("search", &err))?
    };
    let docs = filter_readable_docs(&state, snapshot.user.id, self.id, docs)
      .await
      .map_err(map_gql_error)?;
    let docs = sort_by_updated_at_desc(docs);
    let skip = input
      .options
      .pagination
      .as_ref()
      .and_then(|value| value.skip)
      .unwrap_or(0)
      .max(0) as usize;
    let take = input
      .options
      .pagination
      .as_ref()
      .and_then(|value| value.limit)
      .unwrap_or(20)
      .clamp(1, 100) as usize;
    let page_docs: Vec<_> = docs.into_iter().skip(skip).take(take).collect();
    let nodes = page_docs
      .into_iter()
      .map(|doc| SearchNodeObjectType {
        fields: serde_json::json!({
            "docId": doc.doc_id.to_string(),
            "workspaceId": doc.workspace_id.to_string(),
            "title": doc.title.clone(),
            "plainText": doc.plain_text.clone(),
            "updatedAt": doc.updated_at.to_rfc3339(),
        }),
        highlights: Some(serde_json::json!({
            "title": doc.title,
            "plainText": doc.plain_text,
        })),
      })
      .collect::<Vec<_>>();
    let count = nodes.len() as i32;
    Ok(SearchResultObjectType {
      nodes,
      pagination: SearchResultPaginationType {
        count,
        has_more: false,
        next_cursor: None,
      },
    })
  }

  #[instrument(skip(self, ctx, input))]
  async fn search_docs(&self, ctx: &Context<'_>, input: SearchDocsInputType) -> Result<Vec<SearchDocObjectType>> {
    let docs = QueryRoot
      .search(
        ctx,
        self.id.to_string(),
        input.keyword,
        None,
        Some(input.offset.unwrap_or(0).max(0)),
        Some(input.limit.unwrap_or(20).clamp(1, 100)),
        Some(SearchSortByType::Relevance),
        Some(SortDirectionType::Desc),
        input.use_semantic_search,
      )
      .await?;
    let doc_ids = docs.iter().map(|doc| doc.doc_id).collect::<Vec<_>>();
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "ApiState missing")?;
    let metadata = state.doc().get_metadata_batch(&doc_ids).await.map_err(map_gql_error)?;
    let mut database_contexts = HashMap::<Uuid, Vec<DatabaseDocumentReferenceObjectType>>::new();
    if let Some(database_service) = state.database_services() {
      let references = database_service
        .projection
        .list_document_references_for_targets(
          self.id,
          &doc_ids,
          myoxus_domain::repositories::PageRequest { limit: 500, offset: 0 },
        )
        .await
        .map_err(|error| async_graphql::Error::new(format!("database reference lookup failed: {error}")))?;
      for reference in references {
        if let Some(target_doc_id) = reference.resolved_target_doc_id {
          database_contexts
            .entry(target_doc_id)
            .or_default()
            .push(reference.into());
        }
      }
    }
    docs
      .into_iter()
      .map(|doc| {
        let doc_id = doc.doc_id;
        // Index refreshes must not become content creation/modification dates.
        // Fail a stale page rather than dropping hits and truncating pagination.
        let metadata = metadata
          .get(&doc_id)
          .filter(|metadata| metadata.workspace_id == Some(self.id))
          .ok_or_else(|| async_graphql::Error::new("Document metadata is unavailable"))?;
        Ok(SearchDocObjectType {
          doc_id,
          external_id: metadata.external_id.clone(),
          title: doc.title.clone(),
          block_id: doc.doc_id.to_string(),
          highlight: doc.plain_text,
          created_at: metadata.created_at,
          updated_at: metadata.updated_at,
          created_by_user: None,
          updated_by_user: None,
          database_contexts: database_contexts.remove(&doc_id).unwrap_or_default(),
        })
      })
      .collect()
  }

  #[instrument(skip(self, ctx, input))]
  async fn aggregate(&self, ctx: &Context<'_>, input: AggregateInputType) -> Result<AggregateResultObjectType> {
    // P1 (SRV-02): the aggregate resolver must use the SAME compiled plan as
    // the search resolver. We deliberately compute the count from the
    // evaluated plan (which is already ACL-filtered) instead of dispatching
    // to the legacy keyword path. This is the central invariant that
    // prevents aggregate from drifting away from search under identical
    // input.
    let plan = search_query_plan::compile_plan(&input.query).map_err(|err| plan_error_to_gql("aggregate", &err))?;
    let (state, snapshot) = require_session(ctx).await?;
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: self.id,
      },
      WorkspaceAction::Read,
    )
    .await
    .map_err(map_gql_error)?;
    let repo = state.search_repository().ok_or_else(|| {
      map_gql_error(myoxus_application::auth::AuthError::Storage(
        "search repository is not configured".to_string(),
      ))
    })?;
    let hits = search_query_plan::evaluate_plan(&plan, self.id, None, repo.as_ref())
      .await
      .map_err(|err| plan_error_to_gql("aggregate", &err))?;
    let docs = if !hits.documents.is_empty() {
      hits.documents
    } else {
      let ids: Vec<Uuid> = hits.doc_ids.iter().copied().collect();
      repo
        .list_search_docs_by_ids(self.id, &ids)
        .await
        .map_err(search_query_plan::SearchPlanError::execution_unavailable)
        .map_err(|err| plan_error_to_gql("aggregate", &err))?
    };
    let docs = filter_readable_docs(&state, snapshot.user.id, self.id, docs)
      .await
      .map_err(map_gql_error)?;
    let docs = sort_by_updated_at_desc(docs);
    let hit_limit = input
      .options
      .hits
      .pagination
      .as_ref()
      .and_then(|value| value.limit)
      .unwrap_or(20)
      .clamp(1, 100) as usize;
    let page_docs: Vec<_> = docs.into_iter().take(hit_limit).collect();
    let nodes = page_docs
      .into_iter()
      .map(|doc| SearchNodeObjectType {
        fields: serde_json::json!({
            "docId": doc.doc_id.to_string(),
            "workspaceId": doc.workspace_id.to_string(),
            "title": doc.title,
            "plainText": doc.plain_text,
            "updatedAt": doc.updated_at.to_rfc3339(),
        }),
        highlights: None,
      })
      .collect::<Vec<_>>();
    // The total count is the number of ACL-filtered docs we identified in
    // the workspace — not a pre-existing aggregate value. This is the only
    // bucket we ship in P1; no fake facets are invented here.
    let total = nodes.len() as i32;
    Ok(AggregateResultObjectType {
      buckets: vec![AggregateBucketObjectType {
        key: "all".to_string(),
        count: total,
        hits: AggregateBucketHitsObjectType { nodes },
      }],
      pagination: SearchResultPaginationType {
        count: 1,
        has_more: false,
        next_cursor: None,
      },
    })
  }

  #[instrument(skip(self, ctx))]
  async fn blob_upload_part_url(
    &self,
    ctx: &Context<'_>,
    key: String,
    upload_id: String,
    part_number: i32,
  ) -> Result<BlobUploadPartType> {
    if part_number <= 0 {
      return Err(map_gql_error(AuthError::InvalidInput(
        "part number must be >= 1".to_string(),
      )));
    }

    let (state, snapshot) = require_session(ctx).await?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: self.id,
      },
      WorkspaceAction::BlobsWrite,
    )
    .await
    .map_err(map_gql_error)?;

    let meta = state
      .blob()
      .get_blob_metadata(self.id, &key)
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("blob upload session not found".to_string())))?;
    if meta.upload_id.as_deref() != Some(upload_id.as_str()) {
      return Err(map_gql_error(AuthError::InvalidInput(
        "upload id does not match current blob session".to_string(),
      )));
    }

    let ttl = state.config.storage.signed_url_ttl_seconds;
    let upload_url = state
      .blob()
      .create_signed_multipart_part_upload_url("/api/blob-upload/part", self.id, &key, &upload_id, part_number, ttl)
      .map_err(map_gql_error)?;

    Ok(BlobUploadPartType {
      upload_url,
      headers: None,
      expires_at: Some(Utc::now() + chrono::Duration::seconds(ttl as i64)),
    })
  }

  /// Paginated list of docs in workspace, sorted by created_at ASC.
  /// Used by get-doc-created-by-updated-by-list.gql.
  #[instrument(skip(self, ctx))]
  async fn docs(&self, ctx: &Context<'_>, pagination: PaginationInputType) -> Result<super::PaginatedDocType> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;

    let limit = pagination.first.unwrap_or(20).min(100) as i64;
    let offset = pagination.offset.unwrap_or(0) as i64;
    let documents = state
      .doc()
      .list_workspace_docs(self.id, i64::MAX, 0)
      .await
      .map_err(map_gql_error)?;
    let mut documents =
      crate::document_access::filter_readable_workspace_documents(&state, snapshot.user.id, self.id, documents)
        .await
        .map_err(map_gql_error)?;
    documents.retain(|doc| !doc.is_workspace_root);
    documents.sort_by_key(|doc| doc.created_at);
    let total_count = documents.len() as i64;
    let has_next_page = (offset + limit) < total_count;
    let edges: Vec<super::RecentDocEdge> = documents
      .into_iter()
      .skip(offset as usize)
      .take(limit as usize)
      .map(|doc| super::RecentDocEdge {
        node: super::RecentDocNode {
          id: doc.external_id,
          title: Some(doc.title),
          created_at: Some(doc.created_at),
          updated_at: Some(doc.updated_at),
          creator_id: doc.created_by.map(|u| u.to_string()),
          last_updater_id: doc.updated_by.map(|u| u.to_string()),
        },
      })
      .collect();

    Ok(super::PaginatedDocType {
      total_count,
      page_info: PageInfoType {
        has_next_page,
        has_previous_page: offset > 0,
        end_cursor: None,
        start_cursor: None,
      },
      edges,
    })
  }

  // ─── P24: pageMeta, histories, recentlyUpdatedDocs ─────────────────────────

  /// Cloud page metadata — author and timestamp information for a single doc.
  #[instrument(skip(self, ctx))]
  #[graphql(name = "pageMeta")]
  async fn page_meta(
    &self,
    ctx: &Context<'_>,
    #[graphql(name = "pageId")] page_id: String,
  ) -> Result<Option<super::WorkspaceDocMetaType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;

    let doc_uuid = match crate::graphql::utils::resolve_doc_id(&state, self.id, &page_id).await {
      Ok(doc_id) => doc_id,
      Err(_) => return Ok(None),
    };
    let Some(meta) = state.doc().get_metadata(doc_uuid).await.map_err(map_gql_error)? else {
      return Ok(None);
    };
    if meta.workspace_id != Some(self.id) {
      return Ok(None);
    }
    let document_key = DocumentKey::parse(meta.external_id)
      .map_err(|error| async_graphql::Error::new(format!("invalid document key: {error}")))?;
    crate::document_access::authorize_workspace_document(
      &state,
      snapshot.user.id,
      self.id,
      myoxus_application::doc::DocSpaceKind::Workspace,
      &document_key,
      DocAction::Read,
    )
    .await
    .map_err(map_gql_error)?;

    let Some(attribution) = state
      .doc()
      .get_doc_attribution(self.id, doc_uuid)
      .await
      .map_err(map_gql_error)?
    else {
      return Ok(None);
    };

    Ok(Some(super::WorkspaceDocMetaType {
      created_at: attribution.created_at,
      updated_at: attribution.updated_at,
      created_by: attribution.created_by_name.map(|name| super::EditorType {
        name,
        avatar_url: attribution.created_by_avatar_key,
      }),
      updated_by: attribution.updated_by_name.map(|name| super::EditorType {
        name,
        avatar_url: attribution.updated_by_avatar_key,
      }),
    }))
  }

  /// Document version history entries for rollback/review.
  #[instrument(skip(self, ctx))]
  async fn histories(
    &self,
    ctx: &Context<'_>,
    guid: String,
    take: Option<i32>,
    before: Option<DateTime<Utc>>,
    cursor: Option<String>,
    named_only: Option<bool>,
  ) -> Result<Vec<super::DocHistoryGqlType>> {
    let (state, doc_uuid) = authorize_history_document(ctx, self.id, &guid).await?;
    let limit = take.unwrap_or(100);
    if !(1..=500).contains(&limit) || (before.is_some() && cursor.is_some()) {
      return Err(async_graphql::Error::new("Invalid history pagination"));
    }
    let (before_ts, before_id) = if let Some(cursor) = cursor {
      let (timestamp, id) = cursor
        .split_once('|')
        .ok_or_else(|| async_graphql::Error::new("Invalid history cursor"))?;
      let timestamp = DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| async_graphql::Error::new("Invalid history cursor"))?
        .with_timezone(&Utc);
      let id = id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| async_graphql::Error::new("Invalid history cursor"))?;
      (Some(timestamp), Some(id))
    } else {
      (before, None)
    };

    let entries = state
      .doc()
      .history_page(
        self.id,
        doc_uuid,
        before_ts,
        before_id,
        i64::from(limit),
        named_only.unwrap_or(false),
      )
      .await
      .map_err(map_gql_error)?;

    Ok(
      entries
        .into_iter()
        .map(|entry| history_metadata_type(&guid, entry))
        .collect(),
    )
  }

  /// Exact capture metadata, including entries outside the loaded cursor pages.
  /// Snapshot bodies are only read by the existing preview/restore endpoints.
  #[instrument(skip(self, ctx))]
  async fn history(
    &self,
    ctx: &Context<'_>,
    guid: String,
    snapshot_id: ID,
  ) -> Result<Option<super::DocHistoryGqlType>> {
    let (state, doc_id) = authorize_history_document(ctx, self.id, &guid).await?;
    let history_id = snapshot_id
      .as_str()
      .parse::<i64>()
      .ok()
      .filter(|id| *id > 0)
      .ok_or_else(|| async_graphql::Error::new("Invalid snapshot ID"))?;
    let entry = state
      .doc()
      .history_metadata(self.id, doc_id, history_id)
      .await
      .map_err(map_gql_error)?;
    Ok(entry.map(|entry| history_metadata_type(&guid, entry)))
  }

  /// Fixed selected historical state against the current server-persisted head.
  /// Read authorization and lossless identity use the existing history owner.
  #[instrument(skip(self, ctx))]
  async fn history_diff(
    &self,
    ctx: &Context<'_>,
    guid: String,
    snapshot_id: ID,
  ) -> Result<crate::graphql::document_version::DocumentHistoryDiffType> {
    let (state, doc_id) = authorize_history_document(ctx, self.id, &guid).await?;
    let (_, viewer) = require_session(ctx).await?;
    let history_id = snapshot_id
      .as_str()
      .parse::<i64>()
      .ok()
      .filter(|id| *id > 0)
      .ok_or_else(|| async_graphql::Error::new("Invalid snapshot ID"))?;
    let diff = state
      .doc()
      .history_diff_with_fields(
        self.id,
        doc_id,
        history_id,
        state.document_field_resolver().await.as_ref(),
        Some(viewer.user.id),
      )
      .await
      .map_err(map_gql_error)?;
    Ok(diff.into())
  }

  /// Paginated list of recently updated documents in this workspace.
  #[instrument(skip(self, ctx))]
  #[graphql(name = "recentlyUpdatedDocs")]
  async fn recently_updated_docs(
    &self,
    ctx: &Context<'_>,
    pagination: PaginationInputType,
  ) -> Result<super::PaginatedDocType> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;

    let limit = pagination.first.unwrap_or(20).min(100) as i64;
    let offset = pagination.offset.unwrap_or(0) as i64;
    let documents = state
      .doc()
      .list_workspace_docs(self.id, i64::MAX, 0)
      .await
      .map_err(map_gql_error)?;
    let mut documents =
      crate::document_access::filter_readable_workspace_documents(&state, snapshot.user.id, self.id, documents)
        .await
        .map_err(map_gql_error)?;
    documents.retain(|doc| !doc.is_workspace_root);
    documents.sort_by_key(|doc| std::cmp::Reverse(doc.updated_at));
    let total_count = documents.len() as i64;
    let has_next_page = (offset + limit) < total_count;
    let edges: Vec<super::RecentDocEdge> = documents
      .into_iter()
      .skip(offset as usize)
      .take(limit as usize)
      .map(|doc| super::RecentDocEdge {
        node: super::RecentDocNode {
          id: doc.external_id,
          title: Some(doc.title),
          created_at: Some(doc.created_at),
          updated_at: Some(doc.updated_at),
          creator_id: doc.created_by.map(|u| u.to_string()),
          last_updater_id: doc.updated_by.map(|u| u.to_string()),
        },
      })
      .collect();

    Ok(super::PaginatedDocType {
      total_count,
      page_info: PageInfoType {
        has_next_page,
        has_previous_page: offset > 0,
        end_cursor: None,
        start_cursor: None,
      },
      edges,
    })
  }

  // ─── P21: Git Sync workspace sub-resolvers ─────────────────────────────────

  /// Actor-owned pending Git work remains discoverable after dialog closure or
  /// reload, including Disconnect targets without a configured Git profile.
  #[graphql(name = "pendingGitContentOperations")]
  #[instrument(skip_all,fields(workspace_id=%self.id))]
  async fn pending_git_content_operations(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<super::WorkspaceContentOperationType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let Some(service) = state.workspace_content_control_service() else {
      return Ok(Vec::new());
    };
    Ok(
      service
        .pending_git_operations(snapshot.user.id, self.id)
        .await
        .map_err(map_gql_error)?
        .into_iter()
        .map(super::WorkspaceContentOperationType::from_projection)
        .collect(),
    )
  }

  /// Git Sync profile for this workspace.
  ///
  /// Returns configured Git Sync metadata, including paused profiles, or `null` if none
  /// is configured.  Requires workspace read permission.
  #[graphql(name = "gitSyncProfile")]
  #[instrument(skip(self, ctx), fields(workspace_id = %self.id))]
  async fn git_sync_profile(&self, ctx: &Context<'_>) -> Result<Option<crate::graphql::git_sync::GitSyncProfileType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let Some(pool) = state.metrics_pool() else {
      return Ok(None);
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    match store.get_configured_profile_by_workspace(self.id).await {
      Ok(Some(profile)) => {
        // Look up credential expiry if the profile has a credential
        let credential_expires_at = if let Some(cred_id) = profile.credential_id {
          store.get_credential(cred_id).await.ok().and_then(|c| c.expires_at)
        } else {
          None
        };
        Ok(Some(crate::graphql::git_sync::map_profile_with_expiry(
          profile,
          credential_expires_at,
        )))
      }
      Ok(None) => Ok(None),
      Err(e) => {
        tracing::warn!(error = %e, "failed to fetch git sync profile");
        Ok(None)
      }
    }
  }

  /// Git Sync status overview for this workspace.
  ///
  /// Aggregates the profile, latest run, and summary counters into a
  /// single object.  Requires workspace read permission.
  #[graphql(name = "gitSyncStatus")]
  #[instrument(skip(self, ctx), fields(workspace_id = %self.id))]
  async fn git_sync_status(&self, ctx: &Context<'_>) -> Result<crate::graphql::git_sync::GitSyncStatusType> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let Some(pool) = state.metrics_pool() else {
      return Ok(crate::graphql::git_sync::GitSyncStatusType {
        profile: None,
        last_run: None,
        open_conflicts: 0,
        total_bindings: 0,
        open_doc_conflicts: 0,
        open_file_conflicts: 0,
        total_doc_bindings: 0,
        total_file_bindings: 0,
        partial_session_id: None,
        partial_status: None,
        partial_has_more: false,
        partial_total_items: 0,
        partial_processed_items: 0,
        partial_failed_items: 0,
      });
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    let profile = match store.get_configured_profile_by_workspace(self.id).await {
      Ok(p) => p,
      Err(e) => {
        tracing::warn!(error = %e, "failed to fetch git sync profile for status");
        return Ok(crate::graphql::git_sync::GitSyncStatusType {
          profile: None,
          last_run: None,
          open_conflicts: 0,
          total_bindings: 0,
          open_doc_conflicts: 0,
          open_file_conflicts: 0,
          total_doc_bindings: 0,
          total_file_bindings: 0,
          partial_session_id: None,
          partial_status: None,
          partial_has_more: false,
          partial_total_items: 0,
          partial_processed_items: 0,
          partial_failed_items: 0,
        });
      }
    };
    let Some(profile) = profile else {
      return Ok(crate::graphql::git_sync::GitSyncStatusType {
        profile: None,
        last_run: None,
        open_conflicts: 0,
        total_bindings: 0,
        open_doc_conflicts: 0,
        open_file_conflicts: 0,
        total_doc_bindings: 0,
        total_file_bindings: 0,
        partial_session_id: None,
        partial_status: None,
        partial_has_more: false,
        partial_total_items: 0,
        partial_processed_items: 0,
        partial_failed_items: 0,
      });
    };
    let profile_id = profile.id;
    let last_run = store
      .get_runs_by_profile(profile_id, 1)
      .await
      .unwrap_or_default()
      .into_iter()
      .next()
      .map(crate::graphql::git_sync::map_run);

    // File counters are part of the public status contract. The cache payload
    // is versioned in infrastructure so stale doc-only JSON is ignored.
    let cache = myoxus_infrastructure::quota_cache::QuotaCache::with_all_ttls(
      state.redis_port(),
      &state.config.redis.namespace,
      state.config.redis.cache_ttl_quota_seconds,
      state.config.redis.cache_ttl_usage_seconds,
      state.config.redis.cache_ttl_git_status_seconds,
    );
    let cached = cache.get_git_status(self.id).await;
    let status_counts = if let Some(cached) = cached {
      trace!(workspace_id = %self.id, "git_sync_status cache hit");
      cached
    } else {
      let open_doc_conflicts = store
        .get_conflicts_by_profile(profile_id, false)
        .await
        .map(|c| c.len() as i32)
        .unwrap_or(0);
      let open_file_conflicts = store
        .get_file_conflicts_by_profile(profile_id, false)
        .await
        .map(|c| c.len() as i32)
        .unwrap_or(0);
      let total_doc_bindings = store
        .get_bindings_by_profile(profile_id)
        .await
        .map(|b| b.len() as i32)
        .unwrap_or(0);
      let total_file_bindings = store
        .get_file_bindings_by_profile(profile_id)
        .await
        .map(|b| b.len() as i32)
        .unwrap_or(0);
      let partial_session = store.get_latest_partial_session(profile_id).await.ok().flatten();
      let (
        partial_session_id,
        partial_status,
        partial_has_more,
        partial_total_items,
        partial_processed_items,
        partial_failed_items,
      ) = if let Some(session) = partial_session {
        (
          Some(session.id.to_string()),
          Some(session.status.to_string()),
          session.status == myoxus_domain::git_sync::PartialSessionStatus::Open,
          session.total_items,
          session.processed_items,
          session.failed_items,
        )
      } else {
        (None, None, false, 0, 0, 0)
      };
      let fresh = myoxus_infrastructure::quota_cache::GitSyncStatusCached::new(
        open_doc_conflicts,
        open_file_conflicts,
        total_doc_bindings,
        total_file_bindings,
        partial_session_id,
        partial_status,
        partial_has_more,
        partial_total_items,
        partial_processed_items,
        partial_failed_items,
      );
      cache.set_git_status(self.id, &fresh).await;
      trace!(workspace_id = %self.id, "git_sync_status cache miss — populated");
      fresh
    };

    // Look up credential expiry
    let credential_expires_at = if let Some(cred_id) = profile.credential_id {
      store.get_credential(cred_id).await.ok().and_then(|c| c.expires_at)
    } else {
      None
    };

    Ok(crate::graphql::git_sync::GitSyncStatusType {
      profile: Some(crate::graphql::git_sync::map_profile_with_expiry(
        profile,
        credential_expires_at,
      )),
      last_run,
      open_conflicts: status_counts.open_conflicts,
      total_bindings: status_counts.total_bindings,
      open_doc_conflicts: status_counts.open_doc_conflicts,
      open_file_conflicts: status_counts.open_file_conflicts,
      total_doc_bindings: status_counts.total_doc_bindings,
      total_file_bindings: status_counts.total_file_bindings,
      partial_session_id: status_counts.partial_session_id.map(ID::from),
      partial_status: status_counts.partial_status,
      partial_has_more: status_counts.partial_has_more,
      partial_total_items: status_counts.partial_total_items,
      partial_processed_items: status_counts.partial_processed_items,
      partial_failed_items: status_counts.partial_failed_items,
    })
  }

  /// Git Sync run history for this workspace.
  ///
  /// Returns the most recent sync runs, ordered by start time descending.
  /// The optional `take` parameter limits the number of results (default: 20).
  /// Requires workspace read permission.
  #[graphql(name = "gitSyncRuns")]
  #[instrument(skip(self, ctx), fields(workspace_id = %self.id))]
  async fn git_sync_runs(
    &self,
    ctx: &Context<'_>,
    take: Option<i32>,
  ) -> Result<Vec<crate::graphql::git_sync::GitSyncRunType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let Some(pool) = state.metrics_pool() else {
      return Ok(vec![]);
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    let profile = store
      .get_configured_profile_by_workspace(self.id)
      .await
      .map_err(|error| {
        warn!(
          workspace_id = %self.id,
          error = %error,
          "failed to load Git Sync profile for run history"
        );
        async_graphql::Error::new("Failed to load Git Sync run history")
          .extend_with(|_, extension| extension.set("code", "INTERNAL_SERVER_ERROR"))
      })?;
    let Some(profile) = profile else {
      return Ok(vec![]);
    };
    let limit = i64::from(take.unwrap_or(20).clamp(1, 100));
    let runs = store
      .get_runs_by_profile(profile.id, limit)
      .await
      .map_err(|error| {
        warn!(
          workspace_id = %self.id,
          profile_id = %profile.id,
          error = %error,
          "failed to load Git Sync run history"
        );
        async_graphql::Error::new("Failed to load Git Sync run history")
          .extend_with(|_, extension| extension.set("code", "INTERNAL_SERVER_ERROR"))
      })?
      .into_iter()
      .map(crate::graphql::git_sync::map_run)
      .collect();
    Ok(runs)
  }

  /// Git Sync open conflicts for this workspace.
  ///
  /// Returns unresolved conflicts that require user attention.  Requires
  /// workspace read permission.
  #[graphql(name = "gitSyncConflicts")]
  #[instrument(skip(self, ctx), fields(workspace_id = %self.id))]
  async fn git_sync_conflicts(
    &self,
    ctx: &Context<'_>,
  ) -> Result<Vec<crate::graphql::git_sync::GitSyncConflictObjectType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let Some(pool) = state.metrics_pool() else {
      return Ok(vec![]);
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    let profile = match store.get_configured_profile_by_workspace(self.id).await {
      Ok(Some(p)) => p,
      _ => return Ok(vec![]),
    };
    let conflicts = store
      .get_conflicts_by_profile(profile.id, false)
      .await
      .unwrap_or_default()
      .into_iter()
      .map(crate::graphql::git_sync::map_conflict)
      .collect();
    Ok(conflicts)
  }

  /// Git Sync open file conflicts for this workspace.
  ///
  /// File conflicts are exposed separately from document conflicts because
  /// their resolution works with blob/binding hashes, not mergeable text.
  #[graphql(name = "gitSyncFileConflicts")]
  #[instrument(skip(self, ctx), fields(workspace_id = %self.id))]
  async fn git_sync_file_conflicts(
    &self,
    ctx: &Context<'_>,
    resolved: Option<bool>,
  ) -> Result<Vec<crate::graphql::git_sync::GitSyncFileConflictType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let Some(pool) = state.metrics_pool() else {
      return Ok(vec![]);
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    let profile = match store.get_configured_profile_by_workspace(self.id).await {
      Ok(Some(p)) => p,
      _ => return Ok(vec![]),
    };
    let include_resolved = resolved.unwrap_or(false);
    Ok(
      store
        .get_file_conflicts_by_profile(profile.id, include_resolved)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(crate::graphql::git_sync::map_file_conflict)
        .collect(),
    )
  }

  /// Git Sync document-to-file bindings for this workspace.
  ///
  /// Returns active (non-tombstoned) bindings showing which Myoxus
  /// documents are mapped to which Git file paths.  Requires workspace
  /// read permission.
  #[graphql(name = "gitSyncBindings")]
  #[instrument(skip(self, ctx), fields(workspace_id = %self.id))]
  async fn git_sync_bindings(&self, ctx: &Context<'_>) -> Result<Vec<crate::graphql::git_sync::GitSyncBindingType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let Some(pool) = state.metrics_pool() else {
      return Ok(vec![]);
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    let profile = match store.get_configured_profile_by_workspace(self.id).await {
      Ok(Some(p)) => p,
      _ => return Ok(vec![]),
    };
    let bindings = store
      .get_bindings_by_profile(profile.id)
      .await
      .unwrap_or_default()
      .into_iter()
      .map(crate::graphql::git_sync::map_binding)
      .collect();
    Ok(bindings)
  }

  /// Git Sync file-to-blob bindings for this workspace.
  #[graphql(name = "gitSyncFileBindings")]
  #[instrument(skip(self, ctx), fields(workspace_id = %self.id))]
  async fn git_sync_file_bindings(
    &self,
    ctx: &Context<'_>,
    include_tombstoned: Option<bool>,
  ) -> Result<Vec<crate::graphql::git_sync::GitSyncFileBindingType>> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: self.id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let Some(pool) = state.metrics_pool() else {
      return Ok(vec![]);
    };
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
    let profile = match store.get_configured_profile_by_workspace(self.id).await {
      Ok(Some(p)) => p,
      _ => return Ok(vec![]),
    };
    Ok(
      store
        .get_file_bindings_by_profile_for_view(profile.id, include_tombstoned.unwrap_or(false))
        .await
        .unwrap_or_default()
        .into_iter()
        .map(crate::graphql::git_sync::map_file_binding)
        .collect(),
    )
  }
}

#[Object]
impl super::types::WorkspaceTemplateContextType {
  /// Requested automatic document-template facts only; no generic context API.
  #[instrument(skip_all)]
  async fn requested_values(
    &self,
    ctx: &Context<'_>,
    requested: Vec<String>,
    target_doc_id: Option<String>,
    folder_id: Option<String>,
    parent_doc_id: Option<String>,
    #[graphql(default = false)] defer_creation: bool,
  ) -> Result<async_graphql::Json<serde_json::Value>> {
    let (state, session) = require_session(ctx).await?;
    let service = state
      .document_template_service()
      .ok_or("Template context unavailable")?;
    // Core resolves the placement of an existing target. MCP may resolve its
    // validated future destination, but that must not attest an unplaced Core leaf.
    let missing_placement = target_doc_id.is_none()
      && requested
        .iter()
        .any(|name| name == "folder_name" || name == "folder.path");
    let values = service
      .resolve_requested_values(
        session.user.id,
        self.workspace_id,
        &requested.into_iter().collect(),
        target_doc_id.as_deref(),
        folder_id.as_deref(),
        parent_doc_id.as_deref(),
        defer_creation,
      )
      .await
      .and_then(|values| {
        if missing_placement {
          Err(myoxus_application::document_template::DocumentTemplateError::DestinationNotFound)
        } else {
          Ok(values)
        }
      })
      .map_err(|error| {
        use myoxus_application::document_template::DocumentTemplateError as E;
        let reason = match error {
          E::MemberUnavailable => "member-fetch",
          E::CreatorUnavailable => "creator-unavailable",
          E::CreationUnavailable => "metadata-unavailable",
          E::EmptyField => "empty-field",
          E::OrganizationUnavailable => "organization-unavailable",
          E::OwnerUnitUnavailable => "owner-unit-unavailable",
          E::ParentUnavailable => "parent-unavailable",
          E::DestinationAmbiguous => "folder-ambiguous",
          E::DestinationNotFound => "folder-absent",
          E::UnresolvedVariables => "unresolved-variable",
          _ => "metadata-unavailable",
        };
        async_graphql::Error::new("Template context unavailable")
          .extend_with(|_, ext| ext.set("templateReason", reason))
      })?;
    Ok(async_graphql::Json(
      serde_json::to_value(values).map_err(|_| "Template context unavailable")?,
    ))
  }

  // Native field resolvers own laziness, including aliases and @include/@skip;
  // query AST inspection must not fetch a conditionally excluded field.
  async fn organization_name(&self, ctx: &Context<'_>) -> Result<Option<String>> {
    let context = read_organization_template_context(ctx, self.workspace_id, true, false).await?;
    Ok(context.organization_name)
  }

  async fn organization_unit_name(&self, ctx: &Context<'_>) -> Result<Option<String>> {
    let context = read_organization_template_context(ctx, self.workspace_id, false, true).await?;
    Ok(context.organization_unit_name)
  }
}

async fn read_organization_template_context(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  organization: bool,
  owner_unit: bool,
) -> Result<myoxus_application::organization::OrganizationTemplateContext> {
  let (state, snapshot) = require_session(ctx).await?;
  // Revalidate at the consuming field, not only the parent workspace query:
  // names do not grant administrative or OU-membership capabilities.
  state
    .permission_service()
    .assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id,
      },
      WorkspaceAction::Read,
    )
    .await
    .map_err(map_gql_error)?;
  let service = state
    .organization_template_context_service()
    .ok_or("Organization template context unavailable")?;
  service
    .resolve(workspace_id, organization, owner_unit)
    .await
    .map_err(map_gql_error)
}

// ─── P1 helpers (search/aggregate plan execution) ──────────────────────────

/// Filter search results with one bulk document-role read. The search
/// repository has already loaded metadata; this helper never loads content.
async fn filter_readable_docs(
  state: &ApiState,
  user_id: Uuid,
  workspace_id: Uuid,
  docs: Vec<myoxus_domain::entities::SearchDocument>,
) -> myoxus_application::auth::AuthResult<Vec<myoxus_domain::entities::SearchDocument>> {
  let candidate_ids: Vec<Uuid> = docs.iter().map(|doc| doc.doc_id).collect();
  let readable = state
    .permission_service()
    .readable_doc_ids(user_id, workspace_id, &candidate_ids)
    .await?;
  Ok(docs.into_iter().filter(|doc| readable.contains(&doc.doc_id)).collect())
}

fn sort_by_updated_at_desc(
  mut docs: Vec<myoxus_domain::entities::SearchDocument>,
) -> Vec<myoxus_domain::entities::SearchDocument> {
  docs.sort_by_key(|doc| std::cmp::Reverse(doc.updated_at));
  docs
}

/// Convert a [`search_query_plan::SearchPlanError`] into an async-graphql
/// error tagged with the stable `extensions.code`. Validation detail remains
/// public, while execution failures use the variant's neutral display text and
/// retain their repository cause only for internal diagnostics.
fn plan_error_to_gql(operation: &'static str, err: &search_query_plan::SearchPlanError) -> async_graphql::Error {
  let code = err.code();
  let gql_err = async_graphql::Error::new(format!("{operation}: {err}")).extend_with(|_, e| {
    e.set("code", code);
  });
  warn!(
    operation,
    code,
    error = %err,
    "search-query plan rejected request"
  );
  gql_err
}

/// Creation, readback and stop preserve the same structured identity failures.
pub(crate) fn map_workspace_starter_error(
  error: myoxus_application::workspace::WorkspaceStarterError,
) -> async_graphql::Error {
  use myoxus_application::workspace::WorkspaceStarterError;
  match error {
    WorkspaceStarterError::Auth(error) => map_gql_error(error),
    WorkspaceStarterError::Project(error) => super::database::map_project_starter_error(error),
    WorkspaceStarterError::Conflict => async_graphql::Error::new("Workspace starter request changed")
      .extend_with(|_, extensions| extensions.set("code", "XWS_WORKSPACE_STARTER_CONFLICT")),
    WorkspaceStarterError::Gone { workspace_id } => async_graphql::Error::new("Workspace starter target is gone")
      .extend_with(|_, extensions| {
        extensions.set("code", "XWS_WORKSPACE_STARTER_GONE");
        extensions.set("workspaceId", workspace_id.to_string());
      }),
  }
}
