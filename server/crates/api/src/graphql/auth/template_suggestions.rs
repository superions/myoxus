//! Authenticated Workspace GraphQL projections for templates and the Library.
//!
//! Resolvers are read-only. They never trigger template reconcile and never
//! copy template content; creation still flows through the existing client
//! `duplicateFromTemplate` path after the user selects an available item.

use std::sync::Arc;

use async_graphql::{Context, Enum, Error, ErrorExtensions, ID, InputObject, Result, SimpleObject};
use chrono::{DateTime, Utc};
use myoxus_application::template_registry::suggestions::{
  ERR_TEMPLATE_SUGGESTIONS_INPUT_INVALID, ERR_TEMPLATE_SUGGESTIONS_UNAVAILABLE, TemplateLibraryFilter,
  TemplateLibraryKind, TemplateLibraryOrigin, TemplateLibrarySort, TemplateSuggestionError, TemplateSuggestionItem,
  TemplateSuggestionReason, TemplateSuggestionRequest, TemplateSuggestionResult, TemplateSuggestionService,
  TemplateSuggestionSurface,
};
use uuid::Uuid;

use crate::graphql::utils::require_session;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "TemplateSuggestionSurface", rename_items = "PascalCase")]
pub enum TemplateSuggestionSurfaceType {
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

impl From<TemplateSuggestionSurfaceType> for TemplateSuggestionSurface {
  fn from(value: TemplateSuggestionSurfaceType) -> Self {
    match value {
      TemplateSuggestionSurfaceType::Library => Self::Library,
      TemplateSuggestionSurfaceType::BuildingBlock => Self::BuildingBlock,
      TemplateSuggestionSurfaceType::SidebarNewPage => Self::SidebarNewPage,
      TemplateSuggestionSurfaceType::AllPagesNewPage => Self::AllPagesNewPage,
      TemplateSuggestionSurfaceType::CollectionNewPage => Self::CollectionNewPage,
      TemplateSuggestionSurfaceType::DatabaseRowTemplate => Self::DatabaseRowTemplate,
      TemplateSuggestionSurfaceType::StarterBar => Self::StarterBar,
      TemplateSuggestionSurfaceType::JournalOnboarding => Self::JournalOnboarding,
      TemplateSuggestionSurfaceType::JournalSidebarFooter => Self::JournalSidebarFooter,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "TemplateLibraryKind", rename_items = "PascalCase")]
pub enum TemplateLibraryKindType {
  Document,
  BuildingBlock,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "TemplateLibraryOrigin", rename_items = "PascalCase")]
pub enum TemplateLibraryOriginType {
  Builtin,
  Imported,
  Custom,
  Unknown,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "TemplateLibrarySort", rename_items = "PascalCase")]
pub enum TemplateLibrarySortType {
  NameAsc,
  NameDesc,
  UpdatedDesc,
  UpdatedAsc,
}

#[derive(InputObject, Clone)]
pub struct TemplateLibraryFilterInput {
  pub kind: Option<TemplateLibraryKindType>,
  pub search: Option<String>,
  pub origin: Option<TemplateLibraryOriginType>,
  pub work_area_tag: Option<String>,
  pub sort: Option<TemplateLibrarySortType>,
  /// Exact workspace-local source key; returns at most one item, without list traversal.
  pub source_doc_id: Option<ID>,
}

impl From<TemplateLibraryFilterInput> for TemplateLibraryFilter {
  fn from(value: TemplateLibraryFilterInput) -> Self {
    Self {
      kind: value.kind.map(|kind| match kind {
        TemplateLibraryKindType::Document => TemplateLibraryKind::Document,
        TemplateLibraryKindType::BuildingBlock => TemplateLibraryKind::BuildingBlock,
      }),
      search: value.search,
      origin: value.origin.map(|origin| match origin {
        TemplateLibraryOriginType::Builtin => TemplateLibraryOrigin::Builtin,
        TemplateLibraryOriginType::Imported => TemplateLibraryOrigin::Imported,
        TemplateLibraryOriginType::Custom => TemplateLibraryOrigin::Custom,
        TemplateLibraryOriginType::Unknown => TemplateLibraryOrigin::Unknown,
      }),
      work_area_tag: value.work_area_tag,
      sort: match value.sort {
        Some(TemplateLibrarySortType::NameDesc) => TemplateLibrarySort::NameDesc,
        Some(TemplateLibrarySortType::UpdatedDesc) => TemplateLibrarySort::UpdatedDesc,
        Some(TemplateLibrarySortType::UpdatedAsc) => TemplateLibrarySort::UpdatedAsc,
        _ => TemplateLibrarySort::NameAsc,
      },
      source_doc_id: value.source_doc_id.map(|id| id.to_string()),
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "TemplateSuggestionReason", rename_items = "PascalCase")]
pub enum TemplateSuggestionReasonType {
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

impl From<TemplateSuggestionReason> for TemplateSuggestionReasonType {
  fn from(value: TemplateSuggestionReason) -> Self {
    match value {
      TemplateSuggestionReason::WorkspacePolicy => Self::WorkspacePolicy,
      TemplateSuggestionReason::DefaultPolicy => Self::DefaultPolicy,
      TemplateSuggestionReason::SurfaceCategory => Self::SurfaceCategory,
      TemplateSuggestionReason::MetadataDocumentType => Self::MetadataDocumentType,
      TemplateSuggestionReason::MetadataStatus => Self::MetadataStatus,
      TemplateSuggestionReason::MetadataClassification => Self::MetadataClassification,
      TemplateSuggestionReason::InstanceOk => Self::InstanceOk,
      TemplateSuggestionReason::UpdateAvailable => Self::UpdateAvailable,
      TemplateSuggestionReason::Detached => Self::Detached,
      TemplateSuggestionReason::ReconcileRequired => Self::ReconcileRequired,
      TemplateSuggestionReason::InstanceError => Self::InstanceError,
      TemplateSuggestionReason::Redacted => Self::Redacted,
      TemplateSuggestionReason::Preparing => Self::Preparing,
      TemplateSuggestionReason::AccessDenied => Self::AccessDenied,
      TemplateSuggestionReason::SourceMissing => Self::SourceMissing,
      TemplateSuggestionReason::IncompatibleClient => Self::IncompatibleClient,
      TemplateSuggestionReason::RetryableFailure => Self::RetryableFailure,
    }
  }
}

#[derive(InputObject, Clone)]
pub struct TemplateSuggestionInput {
  pub surface: TemplateSuggestionSurfaceType,
  pub locale: String,
  pub client_version: i32,
  pub document_type_id: Option<ID>,
  pub status_id: Option<ID>,
  pub classification_id: Option<ID>,
  pub mode: Option<String>,
  pub collection_id: Option<ID>,
  pub current_doc_id: Option<ID>,
  /// Library pages default to and allow 200 items; contextual pickers default to eight (maximum 20).
  pub first: Option<i32>,
  pub after: Option<String>,
  /// Filters and SQL ordering for Library only; omitted for contextual suggestions.
  pub library: Option<TemplateLibraryFilterInput>,
}

#[derive(SimpleObject)]
#[graphql(name = "TemplateSuggestionItem")]
pub struct TemplateSuggestionItemObjectType {
  pub template_id: ID,
  pub template_doc_id: Option<ID>,
  pub slug: String,
  pub title: String,
  pub description: Option<String>,
  pub source: String,
  pub updated_at: DateTime<Utc>,
  pub category: Option<String>,
  pub title_policy: Option<String>,
  pub source_revision_id: Option<ID>,
  pub tags: Vec<String>,
  pub score: i32,
  pub reasons: Vec<TemplateSuggestionReasonType>,
  pub instance_state: Option<String>,
  pub available: bool,
  pub protected_source: bool,
}

#[derive(SimpleObject)]
#[graphql(name = "TemplatePageDefaultReplacement")]
pub struct TemplatePageDefaultReplacementObjectType {
  pub retired_source_doc_id: ID,
  pub replacement_source_doc_id: Option<ID>,
}

#[derive(SimpleObject)]
#[graphql(name = "TemplateGuideDelivery")]
pub struct TemplateGuideDeliveryObjectType {
  pub slug: String,
  pub document_id: Option<ID>,
  pub pending: bool,
}

#[derive(SimpleObject)]
#[graphql(name = "TemplateSuggestionResult")]
pub struct TemplateSuggestionResultObjectType {
  pub items: Vec<TemplateSuggestionItemObjectType>,
  pub guide_deliveries: Vec<TemplateGuideDeliveryObjectType>,
  pub page_default_replacements: Vec<TemplatePageDefaultReplacementObjectType>,
  pub empty_document_allowed: bool,
  pub reconcile_required: bool,
  pub stale: bool,
  pub has_next_page: bool,
  pub end_cursor: Option<String>,
}

pub(crate) async fn read_template_suggestions(
  ctx: &Context<'_>,
  workspace_id: Uuid,
  input: TemplateSuggestionInput,
) -> Result<TemplateSuggestionResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let registry = state.template_registry().cloned().ok_or_else(|| {
    suggestion_graphql_error(
      ERR_TEMPLATE_SUGGESTIONS_UNAVAILABLE,
      "template registry is not configured",
    )
  })?;
  let service = TemplateSuggestionService::new(
    Arc::new(registry),
    state.document_metadata_policy_repo(),
    Some(state.permission_service()),
  );
  let request = TemplateSuggestionRequest {
    workspace_id,
    user_id: Some(snapshot.user.id),
    surface: input.surface.into(),
    locale: input.locale,
    client_version: input.client_version.max(0) as u32,
    document_type_id: parse_optional_id(input.document_type_id, "documentTypeId")?,
    status_id: parse_optional_id(input.status_id, "statusId")?,
    classification_id: parse_optional_id(input.classification_id, "classificationId")?,
    mode: input.mode,
    collection_id: parse_optional_id(input.collection_id, "collectionId")?,
    current_doc_id: parse_optional_id(input.current_doc_id, "currentDocId")?,
    first: input.first.map(|value| value.max(0) as usize),
    after: input.after,
    library: input.library.map(Into::into),
  };
  service
    .suggest(request)
    .await
    .map(map_result)
    .map_err(map_suggestion_error)
}

fn map_result(result: TemplateSuggestionResult) -> TemplateSuggestionResultObjectType {
  TemplateSuggestionResultObjectType {
    items: result.items.into_iter().map(map_item).collect(),
    guide_deliveries: result
      .guide_deliveries
      .into_iter()
      .map(|delivery| TemplateGuideDeliveryObjectType {
        slug: delivery.slug,
        document_id: delivery.document_id.map(ID::from),
        pending: delivery.pending,
      })
      .collect(),
    page_default_replacements: result
      .page_default_replacements
      .into_iter()
      .map(|replacement| TemplatePageDefaultReplacementObjectType {
        retired_source_doc_id: ID::from(replacement.retired_source_doc_id),
        replacement_source_doc_id: replacement.replacement_source_doc_id.map(ID::from),
      })
      .collect(),
    empty_document_allowed: result.empty_document_allowed,
    reconcile_required: result.reconcile_required,
    stale: result.stale,
    has_next_page: result.has_next_page,
    end_cursor: result.end_cursor,
  }
}

pub(super) fn map_item(item: TemplateSuggestionItem) -> TemplateSuggestionItemObjectType {
  TemplateSuggestionItemObjectType {
    template_id: ID::from(item.template_id),
    template_doc_id: item.template_doc_id.map(ID::from),
    slug: item.slug,
    title: item.title,
    description: item.description,
    source: item.source,
    updated_at: item.updated_at,
    category: item.category,
    title_policy: item.title_policy.map(|policy| match policy {
      myoxus_application::template_registry::bundle::TitlePolicy::Template => "template".into(),
      myoxus_application::template_registry::bundle::TitlePolicy::TemplateDate => "template-date".into(),
      myoxus_application::template_registry::bundle::TitlePolicy::Date => "date".into(),
    }),
    source_revision_id: item.source_revision_id.map(|id| ID::from(id.to_string())),
    tags: item.tags,
    score: item.score,
    reasons: item.reasons.into_iter().map(Into::into).collect(),
    instance_state: item.instance_state,
    available: item.available,
    protected_source: item.protected_source,
  }
}

fn parse_optional_id(id: Option<ID>, field: &'static str) -> Result<Option<Uuid>> {
  id.map(|id| {
    id.as_str()
      .parse::<Uuid>()
      .map_err(|_| suggestion_graphql_error(ERR_TEMPLATE_SUGGESTIONS_INPUT_INVALID, format!("invalid {field}")))
  })
  .transpose()
}

pub(super) fn map_suggestion_error(error: TemplateSuggestionError) -> Error {
  suggestion_graphql_error(error.code(), error.to_string())
}

fn suggestion_graphql_error(code: &'static str, message: impl Into<String>) -> Error {
  Error::new(message.into()).extend_with(|_, extensions| {
    extensions.set("code", code);
  })
}
