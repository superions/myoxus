// SPDX-License-Identifier: AGPL-3.0-or-later
//! Metadata-only contextual pages. Application owns policy parameters and reasons;
//! the Store applies them to set projections before returning a bounded page.

use super::*;

pub struct ContextualTemplateQuery {
  pub workspace_id: WorkspaceId,
  pub category: Option<&'static str>,
  pub exclude_building_blocks: bool,
  pub client_version: u32,
  pub base_score: i32,
  pub tag_bonuses: Vec<(String, i32)>,
  pub state_bonuses: [i32; 3],
  pub after: Option<Uuid>,
  pub limit: usize,
}

#[derive(Debug)]
pub struct ContextualTemplateSource {
  pub template_id: Uuid,
  pub document_key: Option<String>,
  pub slug: String,
  pub title: String,
  pub description: Option<String>,
  pub source: String,
  pub updated_at: DateTime<Utc>,
  pub category: Option<String>,
  pub tags: Vec<String>,
  pub title_policy: Option<super::super::bundle::TitlePolicy>,
  pub revision_id: Option<Uuid>,
  pub state: Option<InstanceState>,
  pub incompatible: bool,
  pub protected_source: bool,
  pub score: i32,
}

pub struct ContextualTemplatePage {
  pub sources: Vec<ContextualTemplateSource>,
  /// The cursor identifies a currently eligible, deduplicated ranked source.
  pub cursor_valid: bool,
}

pub struct ContextualGuideDelivery {
  pub slug: String,
  pub document_key: Option<String>,
  pub document_id: Option<Uuid>,
  pub pending: bool,
}

impl TemplateSuggestionService {
  pub(super) async fn suggest_contextual(
    &self,
    request: &TemplateSuggestionRequest,
  ) -> Result<TemplateSuggestionResult, TemplateSuggestionError> {
    let metadata = self.validate_metadata(request).await?;
    let first = request.first.unwrap_or(DEFAULT_FIRST).clamp(1, MAX_FIRST);
    let query = ContextualTemplateQuery::new(request, &metadata, first + 1)?;
    let mut page = self.registry.store.contextual_template_page(&query).await?;
    if !page.cursor_valid {
      return Err(TemplateSuggestionError::InputInvalid("after".into()));
    }
    let has_next_page = page.sources.len() > first;
    page.sources.truncate(first);
    let items: Vec<_> = page
      .sources
      .into_iter()
      .map(|source| source.into_item(&metadata))
      .collect();
    let mut guides = self
      .registry
      .store
      .contextual_guide_deliveries(request.workspace_id)
      .await?;
    let ids: Vec<_> = guides.iter().filter_map(|guide| guide.document_id).collect();
    if let (Some(permission), Some(actor)) = (&self.permission_service, request.user_id) {
      let readable = permission.readable_doc_ids(actor, request.workspace_id, &ids).await?;
      for guide in &mut guides {
        if guide.document_id.is_some_and(|id| !readable.contains(&id)) {
          guide.document_key = None;
        }
      }
    }
    let guide_deliveries: Vec<_> = guides
      .into_iter()
      .map(|guide| TemplateGuideDelivery {
        slug: guide.slug,
        document_id: guide.document_key,
        pending: guide.pending,
      })
      .collect();
    let page_default_replacements = self
      .registry
      .store
      .contextual_page_default_replacements(request.workspace_id)
      .await?;
    let reconcile_required = guide_deliveries.iter().any(|guide| guide.pending)
      || items
        .iter()
        .any(|item| item.reasons.contains(&TemplateSuggestionReason::ReconcileRequired));
    let end_cursor = items
      .last()
      .map(|item| Uuid::parse_str(&item.template_id).map(encode_suggestion_cursor))
      .transpose()
      .map_err(|_| TemplateSuggestionError::Unavailable)?;
    Ok(TemplateSuggestionResult {
      items,
      guide_deliveries,
      page_default_replacements,
      reconcile_required,
      has_next_page,
      end_cursor,
      empty_document_allowed: true,
      stale: false,
    })
  }
}

impl ContextualTemplateQuery {
  fn new(
    request: &TemplateSuggestionRequest,
    metadata: &MetadataMatches,
    limit: usize,
  ) -> Result<Self, TemplateSuggestionError> {
    let category = match request.surface {
      TemplateSuggestionSurface::BuildingBlock => Some("building-blocks"),
      TemplateSuggestionSurface::JournalOnboarding | TemplateSuggestionSurface::JournalSidebarFooter => {
        Some("journal-daily")
      }
      _ => None,
    };
    let tag_bonuses = [
      (metadata.document_type_id, "document-type", 80),
      (metadata.status_id, "status", 40),
      (metadata.classification_id, "classification", 40),
    ]
    .into_iter()
    .filter_map(|(id, prefix, bonus)| id.map(|id| (format!("{prefix}:{id}"), bonus)))
    .collect();
    Ok(Self {
      workspace_id: request.workspace_id,
      category,
      exclude_building_blocks: request.surface != TemplateSuggestionSurface::BuildingBlock,
      client_version: request.client_version,
      base_score: 1200,
      tag_bonuses,
      state_bonuses: [30, 20, 10],
      after: request.after.as_deref().map(decode_suggestion_cursor).transpose()?,
      limit,
    })
  }
}

impl ContextualTemplateSource {
  fn into_item(self, metadata: &MetadataMatches) -> TemplateSuggestionItem {
    let availability = if self.incompatible {
      Availability {
        template_doc_id: None,
        instance_state: self.state.map(|state| state.to_string()),
        available: false,
        bonus: 0,
        reasons: vec![TemplateSuggestionReason::IncompatibleClient],
      }
    } else {
      availability_from_state(self.state, self.document_key, self.state.map(|state| state.to_string()))
    };
    let mut reasons = vec![
      TemplateSuggestionReason::WorkspacePolicy,
      TemplateSuggestionReason::SurfaceCategory,
    ];
    let mut ignored_score = 0;
    for (id, prefix, reason) in [
      (
        metadata.document_type_id,
        "document-type",
        TemplateSuggestionReason::MetadataDocumentType,
      ),
      (metadata.status_id, "status", TemplateSuggestionReason::MetadataStatus),
      (
        metadata.classification_id,
        "classification",
        TemplateSuggestionReason::MetadataClassification,
      ),
    ] {
      apply_metadata_score(&mut ignored_score, &mut reasons, &self.tags, id, prefix, 0, reason);
    }
    reasons.extend(availability.reasons);
    TemplateSuggestionItem {
      template_id: self.template_id.to_string(),
      template_doc_id: availability.template_doc_id,
      slug: self.slug,
      title: self.title,
      description: self.description,
      source: self.source,
      updated_at: self.updated_at,
      category: self.category,
      title_policy: self.title_policy,
      source_revision_id: self.revision_id,
      tags: self.tags,
      score: self.score,
      reasons,
      instance_state: availability.instance_state,
      available: availability.available,
      protected_source: self.protected_source,
    }
  }
}
