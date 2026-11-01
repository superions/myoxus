// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded, body-free Library projection. Contextual ranking and provisioning
//! deliberately do not participate in this read operation.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use myoxus_domain::{ids::WorkspaceId, template_registry::InstanceState};
use serde::{Deserialize, Serialize};
use tracing::instrument;
use uuid::Uuid;

use super::{
  Availability, TemplateSuggestionError, TemplateSuggestionItem, TemplateSuggestionReason, TemplateSuggestionRequest,
  TemplateSuggestionResult, TemplateSuggestionService, availability_from_state,
};
use crate::template_registry::bundle::TitlePolicy;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemplateLibraryKind {
  Document,
  BuildingBlock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemplateLibraryOrigin {
  Builtin,
  Imported,
  Custom,
  Unknown,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemplateLibrarySort {
  #[default]
  NameAsc,
  NameDesc,
  UpdatedDesc,
  UpdatedAsc,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateLibraryFilter {
  pub kind: Option<TemplateLibraryKind>,
  pub search: Option<String>,
  pub origin: Option<TemplateLibraryOrigin>,
  pub work_area_tag: Option<String>,
  pub sort: TemplateLibrarySort,
  pub source_doc_id: Option<String>,
}

/// A cursor carries only the last SQL order tuple and its query scope. It never
/// encodes an offset or requires reading an earlier page to find its position.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateLibraryCursor {
  pub workspace_id: WorkspaceId,
  pub key: String,
  pub title: String,
  pub updated_at: DateTime<Utc>,
  pub filter: TemplateLibraryFilter,
  pub locale: String,
}

#[derive(Debug, Clone)]
pub struct TemplateLibraryQuery {
  pub workspace_id: WorkspaceId,
  pub filter: TemplateLibraryFilter,
  pub locale: String,
  pub after: Option<TemplateLibraryCursor>,
  /// Includes at most one continuation probe; exact-key requests are limited to one.
  pub limit: usize,
}

/// SQL-selected facts only: no bundle, snapshot, export or per-source user roles.
#[derive(Debug, Clone)]
pub struct TemplateLibrarySource {
  pub key: String,
  pub template_id: String,
  pub document_key: Option<String>,
  pub slug: String,
  pub title: String,
  pub description: Option<String>,
  pub source: String,
  pub updated_at: DateTime<Utc>,
  pub category: Option<String>,
  pub tags: Vec<String>,
  pub title_policy: Option<TitlePolicy>,
  pub revision_id: Option<Uuid>,
  pub instance_state: Option<InstanceState>,
  pub min_client_version: u32,
  pub protected_source: bool,
}

impl TemplateSuggestionService {
  #[instrument(skip_all, fields(workspace_id = %request.workspace_id))]
  pub(super) async fn suggest_library(
    &self,
    request: &TemplateSuggestionRequest,
  ) -> Result<TemplateSuggestionResult, TemplateSuggestionError> {
    let mut filter = request.library.clone().unwrap_or_default();
    filter.search = filter
      .search
      .map(|value| value.trim().to_owned())
      .filter(|value| !value.is_empty());
    if filter.search.as_ref().is_some_and(|value| value.len() > 1024)
      || filter.work_area_tag.as_ref().is_some_and(|value| value.len() > 256)
    {
      return Err(TemplateSuggestionError::InputInvalid(
        "library filter is too long".into(),
      ));
    }
    if let Some(key) = &filter.source_doc_id {
      myoxus_domain::document_key::DocumentKey::parse(key.clone())
        .map_err(|_| TemplateSuggestionError::InputInvalid("sourceDocId".into()))?;
      if request.after.is_some() {
        return Err(TemplateSuggestionError::InputInvalid(
          "exact source lookup has no continuation".into(),
        ));
      }
    }
    let after = request
      .after
      .as_ref()
      .map(|encoded| {
        let bytes = URL_SAFE_NO_PAD
          .decode(encoded)
          .map_err(|_| TemplateSuggestionError::InputInvalid("after".into()))?;
        let cursor: TemplateLibraryCursor =
          serde_json::from_slice(&bytes).map_err(|_| TemplateSuggestionError::InputInvalid("after".into()))?;
        if cursor.workspace_id != request.workspace_id || cursor.filter != filter || cursor.locale != request.locale {
          return Err(TemplateSuggestionError::InputInvalid(
            "continuation belongs to another Library query".into(),
          ));
        }
        Ok(cursor)
      })
      .transpose()?;
    let first = if filter.source_doc_id.is_some() {
      1
    } else {
      request.first.unwrap_or(200).clamp(1, 200)
    };
    let mut sources = self
      .registry
      .store
      .library_sources(&TemplateLibraryQuery {
        workspace_id: request.workspace_id,
        filter: filter.clone(),
        locale: request.locale.clone(),
        after,
        limit: if filter.source_doc_id.is_some() { 1 } else { first + 1 },
      })
      .await?;
    let has_next_page = sources.len() > first;
    sources.truncate(first);
    let end_cursor = sources
      .last()
      .map(|source| {
        serde_json::to_vec(&TemplateLibraryCursor {
          workspace_id: request.workspace_id,
          key: source.key.clone(),
          title: source.title.clone(),
          updated_at: source.updated_at,
          filter,
          locale: request.locale.clone(),
        })
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| TemplateSuggestionError::Unavailable)
      })
      .transpose()?;
    let items = sources
      .into_iter()
      .map(|source| {
        let native_custom = source.source != "bundle" && source.source != "builtin";
        let availability = if source.min_client_version > request.client_version {
          Availability {
            template_doc_id: None,
            instance_state: source.instance_state.map(|state| state.to_string()),
            available: false,
            bonus: 0,
            reasons: vec![TemplateSuggestionReason::IncompatibleClient],
          }
        } else if native_custom {
          Availability {
            template_doc_id: source.document_key,
            instance_state: Some("local".into()),
            available: true,
            bonus: 0,
            reasons: Vec::new(),
          }
        } else if source.instance_state.is_none() {
          Availability {
            template_doc_id: None,
            instance_state: None,
            available: false,
            bonus: 0,
            reasons: vec![
              TemplateSuggestionReason::ReconcileRequired,
              TemplateSuggestionReason::Preparing,
            ],
          }
        } else {
          availability_from_state(
            source.instance_state,
            source.document_key,
            source.instance_state.map(|state| state.to_string()),
          )
        };
        TemplateSuggestionItem {
          template_id: source.template_id,
          template_doc_id: availability.template_doc_id,
          slug: source.slug,
          title: source.title,
          description: source.description,
          source: source.source,
          updated_at: source.updated_at,
          category: source.category,
          title_policy: source.title_policy,
          source_revision_id: source.revision_id,
          tags: source.tags,
          score: 0,
          reasons: availability.reasons,
          instance_state: availability.instance_state,
          available: availability.available,
          protected_source: source.protected_source,
        }
      })
      .collect::<Vec<_>>();
    Ok(TemplateSuggestionResult {
      reconcile_required: items
        .iter()
        .any(|item| item.reasons.contains(&TemplateSuggestionReason::ReconcileRequired)),
      items,
      guide_deliveries: Vec::new(),
      page_default_replacements: Vec::new(),
      empty_document_allowed: true,
      stale: false,
      has_next_page,
      end_cursor,
    })
  }
}
