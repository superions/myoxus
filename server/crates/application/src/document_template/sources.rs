// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only workspace sources for native bundle authoring.

use super::{DocumentTemplateError, DocumentTemplateService, map_auth_error};
use crate::{
  doc::DocSpaceKind,
  document_metadata::DocumentMetadataService,
  template_registry::{TemplateRegistryService, bundle::Manifest},
};
use myoxus_domain::{document_key::DocumentKey, template_registry::WorkspaceTemplateInstance};
use std::collections::HashMap;
use tracing::instrument;
use uuid::Uuid;

pub struct DocumentTemplateSourceRequest {
  pub actor_id: Uuid,
  pub workspace_id: Uuid,
  pub limit: usize,
  pub offset: usize,
}

/// Discovery exposes current persisted revisions for identification. Export
/// reads a fresh transactional snapshot, without pinning these displayed heads.
pub struct DocumentTemplateSource {
  pub external_id: String,
  pub title: String,
  pub document_revision: i64,
  pub metadata_revision: i64,
  pub origin: Option<String>,
  pub identifier: Option<String>,
  pub version: Option<String>,
  pub description: Option<String>,
  pub category: Option<String>,
  pub tags: Vec<String>,
  pub locale: Option<String>,
  pub title_policy: Option<crate::template_registry::bundle::TitlePolicy>,
}

pub struct DocumentTemplateSourcePage {
  pub sources: Vec<DocumentTemplateSource>,
  pub next_offset: Option<usize>,
}

impl DocumentTemplateService {
  #[instrument(skip_all)]
  pub async fn list_sources(
    &self,
    request: DocumentTemplateSourceRequest,
    metadata: &DocumentMetadataService,
    registry: Option<&TemplateRegistryService>,
  ) -> Result<DocumentTemplateSourcePage, DocumentTemplateError> {
    let page = self
      .list(request.actor_id, request.workspace_id, request.limit, request.offset)
      .await?;
    let instances: HashMap<_, _> = match registry {
      Some(registry) => registry
        .store()
        .list_instances_for_workspace(request.workspace_id)
        .await
        .map_err(map_auth_error)?
        .into_iter()
        .filter(|instance| instance.detached_at.is_none() && instance.retired_at.is_none())
        .filter_map(|instance| instance.workspace_doc_id.map(|id| (id, instance)))
        .collect(),
      None => HashMap::new(),
    };
    let mut sources = Vec::with_capacity(page.templates.len());
    for summary in page.templates {
      let key =
        DocumentKey::parse(summary.external_id.clone()).map_err(|_| DocumentTemplateError::InvalidDocumentKey)?;
      let Some(doc_id) = self
        .docs
        .resolve_document_key(request.workspace_id, DocSpaceKind::Workspace, &key)
        .await
        .map_err(map_auth_error)?
      else {
        continue;
      };
      let before = self
        .docs
        .store()
        .preview_source_identity(request.workspace_id, doc_id)
        .await
        .map_err(map_auth_error)?;
      let Some(before) = before.filter(|identity| !identity.deleted) else {
        continue;
      };
      let projection = match metadata.get_projection_uncached(doc_id, request.workspace_id).await {
        Ok(projection) => projection,
        Err(crate::document_metadata::DocumentMetadataServiceError::NotFound) => continue,
        Err(error) => return Err(error.into()),
      };
      let Some(marker) = projection
        .template
        .as_ref()
        .filter(|marker| matches!(marker.state.as_str(), "seeded" | "managed" | "detached"))
      else {
        continue;
      };
      let mut source = DocumentTemplateSource {
        external_id: summary.external_id,
        title: before.title.clone(),
        document_revision: before.revision,
        metadata_revision: projection.metadata_revision,
        origin: marker.origin.clone(),
        identifier: None,
        version: None,
        description: None,
        category: marker.category.clone(),
        tags: marker.tags.clone().unwrap_or_default(),
        locale: None,
        title_policy: None,
      };
      if let (Some(registry), Some(instance)) = (registry, instances.get(&doc_id)) {
        Self::source_registry_metadata(&mut source, registry, instance).await?;
        let current = registry
          .store()
          .get_instance(instance.id)
          .await
          .map_err(map_auth_error)?;
        if current.as_ref().is_none_or(|current| {
          current.workspace_doc_id != instance.workspace_doc_id
            || current.revision_id != instance.revision_id
            || current.detached_at.is_some()
            || current.retired_at.is_some()
        }) {
          continue;
        }
      }
      // Catalog admission belongs to list(), not each source. Retain both
      // native head fences across asynchronous metadata reads.
      let projection_after = match metadata.get_projection_uncached(doc_id, request.workspace_id).await {
        Ok(projection) => projection,
        Err(crate::document_metadata::DocumentMetadataServiceError::NotFound) => continue,
        Err(error) => return Err(error.into()),
      };
      let after = self
        .docs
        .store()
        .preview_source_identity(request.workspace_id, doc_id)
        .await
        .map_err(map_auth_error)?;
      // Preview metadata identity is an updated-at token, not the canonical
      // metadata counter. Compare each head only with its own second read.
      if after.as_ref() == Some(&before) && projection == projection_after {
        sources.push(source);
      }
    }
    Ok(DocumentTemplateSourcePage {
      sources,
      next_offset: page.next_offset,
    })
  }

  async fn source_registry_metadata(
    source: &mut DocumentTemplateSource,
    registry: &TemplateRegistryService,
    instance: &WorkspaceTemplateInstance,
  ) -> Result<(), DocumentTemplateError> {
    let entry = registry
      .store()
      .get_catalog_entry(instance.template_id)
      .await
      .map_err(map_auth_error)?;
    let revision = registry
      .store()
      .get_revision(instance.revision_id)
      .await
      .map_err(map_auth_error)?;
    if let (Some(entry), Some(revision)) = (entry, revision) {
      if revision.template_id != entry.id {
        return Err(DocumentTemplateError::Content);
      }
      source.identifier = Some(entry.slug);
      source.version = Some(revision.version);
      source.description = entry.description;
      source.category = entry.category;
      source.tags = entry.tags;
      source.locale = instance.locale_hash.clone();
      if let Some(manifest) = revision.manifest {
        let manifest: Manifest = serde_json::from_value(manifest).map_err(|_| DocumentTemplateError::Content)?;
        source.title_policy = manifest.title_policy;
        if source.locale.is_none() {
          source.locale = manifest.locale.clone();
        }
        if let Some(variant) = source
          .locale
          .as_ref()
          .and_then(|locale| manifest.localized_contents.get(locale))
        {
          source.description = variant.description.clone();
        }
      }
    }
    Ok(())
  }
}
