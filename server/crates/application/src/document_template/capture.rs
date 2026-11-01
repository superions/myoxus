// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authorized immutable source capture for native bundle export.

use std::collections::{BTreeMap, HashMap};

use bytes::Bytes;
use myoxus_domain::{
  document_key::DocumentKey,
  permission::{DocAction, WorkspaceAction},
};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tracing::instrument;
use uuid::Uuid;

use super::{
  DocumentTemplateAssetReader, DocumentTemplateError, DocumentTemplateService, DocumentTemplateSourceState,
  map_auth_error,
};
use crate::{
  permission::{AccessController, DocResource, WorkspaceResource},
  template_registry::TemplateRegistryZipLimits,
};

pub struct DocumentTemplateCaptureRequest {
  pub actor_id: Uuid,
  pub workspace_id: Uuid,
  pub external_ids: Vec<String>,
}

/// Internal capture, not a transport DTO. Reusable manifest composition must
/// select its allowed fields rather than serializing workspace attribution.
pub struct CapturedDocumentTemplate {
  pub external_id: String,
  pub title: String,
  pub document_revision: i64,
  pub metadata_revision: i64,
  pub primary_mode: Option<String>,
  pub update: Vec<u8>,
  pub assets: Vec<CapturedDocumentTemplateAsset>,
}

pub struct CapturedDocumentTemplateAsset {
  pub path: String,
  pub mime: String,
  pub bytes: Bytes,
}

#[derive(Debug, Error)]
pub enum DocumentTemplateCaptureError {
  #[error(transparent)]
  Template(#[from] DocumentTemplateError),
  #[error("workspace template source contains unsupported native content")]
  UnsupportedContent,
  #[error("workspace template source has an unsupported resource closure")]
  UnsupportedReference,
  #[error("workspace template source asset is unavailable")]
  AssetUnavailable,
  #[error("workspace template source exceeds the bundle limits")]
  LimitExceeded,
}

impl DocumentTemplateService {
  /// Read all selected sources from one current database snapshot, then close
  /// their referenced assets. Discovery revisions impose no preconditions.
  #[instrument(skip_all)]
  pub async fn capture_sources(
    &self,
    request: DocumentTemplateCaptureRequest,
    assets: &dyn DocumentTemplateAssetReader,
    limits: TemplateRegistryZipLimits,
  ) -> Result<Vec<CapturedDocumentTemplate>, DocumentTemplateCaptureError> {
    let DocumentTemplateCaptureRequest {
      actor_id,
      workspace_id,
      external_ids,
    } = request;
    self.assert_workspace_read(actor_id, workspace_id).await?;
    for external_id in &external_ids {
      DocumentKey::parse(external_id.clone()).map_err(|_| DocumentTemplateError::InvalidDocumentKey)?;
    }
    let sources = self
      .repo
      .capture_sources(workspace_id, &external_ids)
      .await
      .map_err(DocumentTemplateError::from)?
      .ok_or(DocumentTemplateError::NotFound)?;
    let mut captured = Vec::with_capacity(sources.len());
    let mut total = 0_u64;
    for source in sources {
      let source = self
        .capture_source_resources(actor_id, workspace_id, source, assets, limits)
        .await?;
      for size in std::iter::once(source.update.len()).chain(source.assets.iter().map(|asset| asset.bytes.len())) {
        total = total
          .checked_add(size as u64)
          .ok_or(DocumentTemplateCaptureError::LimitExceeded)?;
      }
      if total > limits.max_total_uncompressed_size_mb.saturating_mul(1024 * 1024) {
        return Err(DocumentTemplateCaptureError::LimitExceeded);
      }
      captured.push(source);
    }
    Ok(captured)
  }

  async fn capture_source_resources(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    source: DocumentTemplateSourceState,
    assets: &dyn DocumentTemplateAssetReader,
    limits: TemplateRegistryZipLimits,
  ) -> Result<CapturedDocumentTemplate, DocumentTemplateCaptureError> {
    let DocumentTemplateSourceState {
      doc_id,
      external_id,
      title,
      document_revision,
      metadata_revision,
      primary_mode,
      update,
    } = source;
    self
      .assert_capture_document_read(actor_id, workspace_id, doc_id)
      .await?;
    let max_entry = limits.max_entry_uncompressed_size_mb.saturating_mul(1024 * 1024);
    let max_total = limits.max_total_uncompressed_size_mb.saturating_mul(1024 * 1024);
    let source_bytes = update.len() as u64;
    if source_bytes > max_entry || source_bytes > max_total || limits.max_entries == 0 {
      return Err(DocumentTemplateCaptureError::LimitExceeded);
    }
    let snapshot = yjs::document_to_snapshot(&update, &external_id, &title).map_err(|reason| {
      // Native capture reports static structural reasons, never source values.
      tracing::warn!(%reason, "native template source capture rejected");
      DocumentTemplateCaptureError::UnsupportedContent
    })?;
    let references = yjs::extract_document_references_from_yjs(&update)
      .map_err(|_| DocumentTemplateCaptureError::UnsupportedReference)?;
    // A standalone document bundle has no document-graph binding owner. Never
    // copy unrelated/private documents or leave their native references dangling.
    if references.extraction_partial
      || !references.occurrences.is_empty()
      || !yjs::inspect_native_template_references(&update)
        .map_err(|_| DocumentTemplateCaptureError::UnsupportedReference)?
        .is_empty()
    {
      return Err(DocumentTemplateCaptureError::UnsupportedReference);
    }
    let references = yjs::extract_portable_asset_references(&update)
      .map_err(|_| DocumentTemplateCaptureError::UnsupportedReference)?;
    assert_supported_asset_locations(&snapshot, &references)?;
    drop(snapshot);
    for reference in &references {
      if reference
        .workspace_id
        .as_ref()
        .is_some_and(|scope| Uuid::parse_str(scope).ok() != Some(workspace_id))
      {
        return Err(DocumentTemplateCaptureError::UnsupportedReference);
      }
    }
    if !references.is_empty() {
      self.assert_capture_blobs_read(actor_id, workspace_id).await?;
    }
    let mut resource_paths = HashMap::new();
    let mut captured_assets = BTreeMap::new();
    let mut captured_bytes = source_bytes;
    for reference in &references {
      if resource_paths.contains_key(&reference.source_key) {
        continue;
      }
      let resource = assets
        .read_completed_asset(workspace_id, &reference.source_key, max_entry)
        .await?;
      if resource.data.len() as u64 > max_entry {
        return Err(DocumentTemplateCaptureError::LimitExceeded);
      }
      let mime = resource
        .content_type
        .unwrap_or_else(|| "application/octet-stream".into());
      let extension = mime_guess::get_mime_extensions_str(mime.split(';').next().unwrap_or_default().trim())
        .and_then(|extensions| extensions.first())
        .copied()
        .unwrap_or("bin");
      let path = format!("assets/{}.{}", hex::encode(Sha256::digest(&resource.data)), extension);
      if !captured_assets.contains_key(&path) {
        captured_bytes = captured_bytes
          .checked_add(resource.data.len() as u64)
          .ok_or(DocumentTemplateCaptureError::LimitExceeded)?;
        if captured_bytes > max_total
          || captured_assets.len() as u64 >= limits.max_entries.saturating_sub(1)
          || path.len() as u64 > limits.max_path_length
        {
          return Err(DocumentTemplateCaptureError::LimitExceeded);
        }
        captured_assets.insert(
          path.clone(),
          CapturedDocumentTemplateAsset {
            path: path.clone(),
            mime,
            bytes: resource.data,
          },
        );
      }
      resource_paths.insert(reference.source_key.clone(), path);
    }

    self
      .assert_capture_document_read(actor_id, workspace_id, doc_id)
      .await?;
    if !references.is_empty() {
      self.assert_capture_blobs_read(actor_id, workspace_id).await?;
    }
    let rewrites = references
      .into_iter()
      .map(|reference| yjs::NativeReferenceRewrite {
        replacement: Some(yjs::NativeReferenceReplacement {
          id: resource_paths[&reference.source_key].clone(),
          workspace_id: None,
        }),
        position: reference.position,
        expected_id: reference.raw_source_key,
        expected_workspace_id: reference.workspace_id,
      })
      .collect::<Vec<_>>();
    let update = if rewrites.is_empty() {
      update
    } else {
      let digest = Sha256::digest(&update);
      let client_id =
        (u64::from_le_bytes(digest[..8].try_into().expect("SHA-256 prefix")) & ((1_u64 << 53) - 1)).max(1);
      yjs::rewrite_native_references(&update, &rewrites, client_id)
        .map_err(|_| DocumentTemplateCaptureError::UnsupportedReference)?
        .full_state
    };
    let rewritten_bytes = update.len() as u64;
    let captured_bytes = (captured_bytes - source_bytes)
      .checked_add(rewritten_bytes)
      .ok_or(DocumentTemplateCaptureError::LimitExceeded)?;
    if rewritten_bytes > max_entry || captured_bytes > max_total {
      return Err(DocumentTemplateCaptureError::LimitExceeded);
    }
    Ok(CapturedDocumentTemplate {
      external_id,
      title,
      document_revision,
      metadata_revision,
      primary_mode,
      update,
      assets: captured_assets.into_values().collect(),
    })
  }

  async fn assert_capture_document_read(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> Result<(), DocumentTemplateCaptureError> {
    self
      .permission
      .assert(
        &DocResource {
          user_id: actor_id,
          workspace_id,
          doc_id,
        },
        DocAction::Read,
      )
      .await
      .map_err(map_auth_error)?;
    Ok(())
  }

  async fn assert_capture_blobs_read(
    &self,
    actor_id: Uuid,
    workspace_id: Uuid,
  ) -> Result<(), DocumentTemplateCaptureError> {
    self
      .permission
      .assert(
        &WorkspaceResource {
          user_id: actor_id,
          workspace_id,
        },
        WorkspaceAction::BlobsRead,
      )
      .await
      .map_err(map_auth_error)?;
    Ok(())
  }
}

fn assert_supported_asset_locations(
  snapshot: &serde_json::Value,
  references: &[yjs::PortableAssetReference],
) -> Result<(), DocumentTemplateCaptureError> {
  for block in snapshot["blocks"]
    .as_array()
    .ok_or(DocumentTemplateCaptureError::UnsupportedContent)?
  {
    let flavour = block["flavour"].as_str().unwrap_or_default();
    if flavour == "myoxus:database" {
      return Err(DocumentTemplateCaptureError::UnsupportedReference);
    }
    if matches!(flavour, "myoxus:image" | "myoxus:attachment" | "myoxus:bookmark")
      && let Some(source) = block["props"].get("sourceId")
      && source.as_str() != Some("")
      && !references.iter().any(|reference| {
        Some(reference.block_id.as_str()) == block["id"].as_str()
          && reference.raw_source_key == source.as_str().unwrap_or_default()
          && matches!(&reference.position, yjs::NativeReferencePosition::BlockProperty { property, .. }
              if property == "prop:sourceId" || property == "sourceId")
      })
    {
      return Err(DocumentTemplateCaptureError::UnsupportedReference);
    }
    // The canonical reference writer has no Surface-element selector. Preserve
    // ordinary canvas shapes/text, but reject resource-bearing elements rather
    // than exporting an image whose bytes cannot be bound by that owner.
    if flavour == "myoxus:surface"
      && block["props"]["elements"]
        .as_object()
        .is_some_and(|elements| elements.values().any(|element| element.get("sourceId").is_some()))
    {
      return Err(DocumentTemplateCaptureError::UnsupportedReference);
    }
  }
  Ok(())
}
