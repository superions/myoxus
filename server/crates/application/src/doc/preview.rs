// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded source preparation for private document previews.
//!
//! This owner pairs a consistent Yjs source with its committed revision and
//! resolves only assets referenced by the bounded public-render excerpt. It
//! does not authorize, cache, select themes or expose transport semantics;
//! those remain request-scoped API responsibilities.

use std::sync::Arc;
use std::time::Instant;

use myoxus_public_render::{
  PreviewAsset, PreviewAssetKind, PreviewProjectionLimits, PublicDocIr, document_excerpt_from_yjs,
  resolve_asset_candidates,
};
use thiserror::Error;
use uuid::Uuid;

use super::{DocLoadService, DocPreviewSourceIdentity};
use crate::{
  auth::AuthError,
  ports::{blob::BlobStatus, blob_service::BlobService},
};

#[derive(Debug, Clone)]
pub struct PreviewSourceRequest {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub identity: DocPreviewSourceIdentity,
  pub limits: PreviewProjectionLimits,
  pub max_media_bytes: usize,
  pub max_svg_input_bytes: usize,
}

#[derive(Debug, Clone)]
pub struct DocumentPreviewSource {
  pub ir: PublicDocIr,
  pub revision: i64,
  pub metadata_revision: i64,
  pub assets: Vec<PreviewAsset>,
  pub empty: bool,
}

#[derive(Debug, Error)]
pub enum PreviewSourceError {
  #[error("document source changed while preparing its preview")]
  Stale,
  #[error("document preview source exceeds a configured limit")]
  Limit,
  #[error("document preview mode is unsupported")]
  Unsupported,
  #[error("document preview source is invalid")]
  Invalid,
  #[error("document preview dependency is temporarily unavailable")]
  Unavailable,
}

#[derive(Clone)]
pub struct DocumentPreviewSourceService {
  load: Arc<DocLoadService>,
  blobs: Arc<BlobService>,
}

impl DocumentPreviewSourceService {
  pub fn new(load: Arc<DocLoadService>, blobs: Arc<BlobService>) -> Self {
    Self { load, blobs }
  }

  pub async fn prepare(&self, request: PreviewSourceRequest) -> Result<DocumentPreviewSource, PreviewSourceError> {
    let started = Instant::now();
    let loaded = self
      .load
      .load_full_doc_with_revision_bounded(request.workspace_id, request.doc_id, request.limits.max_input_bytes)
      .await
      .map_err(map_load_error)?;
    if loaded.revision != request.identity.revision {
      return Err(PreviewSourceError::Stale);
    }
    let source_read_us = started.elapsed().as_micros() as u64;
    // The API retains its admission permits through preparation and rendering.
    // Decoding/projection must not occupy an async executor thread either.
    let projection_started = Instant::now();
    let ir = tokio::task::spawn_blocking(move || {
      document_excerpt_from_yjs(
        request.workspace_id,
        request.doc_id,
        &request.identity.title,
        &request.identity.public_mode,
        &loaded.payload,
        &request.limits,
      )
    })
    .await
    .map_err(|error| {
      tracing::error!(
        cancelled = error.is_cancelled(),
        panicked = error.is_panic(),
        "document preview projection worker failed"
      );
      PreviewSourceError::Unavailable
    })?
    .map_err(|diagnostic| match diagnostic.code.as_str() {
      "preview_unsupported_mode" => PreviewSourceError::Unsupported,
      code if code.ends_with("_limit") => PreviewSourceError::Limit,
      _ => PreviewSourceError::Invalid,
    })?;
    let projection_wall_us = projection_started.elapsed().as_micros() as u64;
    let media_started = Instant::now();

    let mut assets = Vec::new();
    let mut total_media_bytes = 0usize;
    for candidate in resolve_asset_candidates(&ir) {
      let Some(metadata) = self
        .blobs
        .get_blob_metadata(request.workspace_id, &candidate.blob_key)
        .await
        .map_err(|_| PreviewSourceError::Unavailable)?
      else {
        continue;
      };
      if metadata.deleted_at.is_some() || metadata.status != BlobStatus::Completed {
        continue;
      }
      let size = usize::try_from(metadata.size).map_err(|_| PreviewSourceError::Limit)?;
      total_media_bytes = total_media_bytes.checked_add(size).ok_or(PreviewSourceError::Limit)?;
      if size > request.max_media_bytes || total_media_bytes > request.max_media_bytes {
        return Err(PreviewSourceError::Limit);
      }
      let kind = if metadata.mime == "image/svg+xml" {
        if size > request.max_svg_input_bytes {
          return Err(PreviewSourceError::Limit);
        }
        PreviewAssetKind::Svg
      } else if metadata.mime.starts_with("image/") {
        PreviewAssetKind::Raster
      } else {
        continue;
      };
      let blob = self
        .blobs
        .get_blob(request.workspace_id, &candidate.blob_key)
        .await
        .map_err(|_| PreviewSourceError::Unavailable)?;
      if blob.data.len() != size {
        return Err(PreviewSourceError::Stale);
      }
      assets.push(PreviewAsset {
        source: candidate.blob_key,
        revision: asset_revision(&metadata),
        kind,
        bytes: blob.data.to_vec(),
      });
    }

    tracing::debug!(
      target: "myoxus_preview_perf",
      workspace_id = %request.workspace_id,
      doc_id = %request.doc_id,
      source_read_us,
      projection_wall_us,
      media_read_us = media_started.elapsed().as_micros() as u64,
      media_bytes = total_media_bytes,
      "prepared preview source"
    );
    Ok(DocumentPreviewSource {
      ir,
      revision: loaded.revision,
      metadata_revision: request.identity.metadata_revision,
      assets,
      empty: !loaded.has_real_content,
    })
  }
}

pub fn asset_revision(metadata: &crate::ports::blob::BlobMetadata) -> String {
  metadata.checksum.clone().unwrap_or_else(|| {
    format!(
      "{}:{}:{}",
      metadata.blob_id,
      metadata.size,
      metadata.updated_at.timestamp_micros()
    )
  })
}

fn map_load_error(error: AuthError) -> PreviewSourceError {
  match error {
    AuthError::DocSyncPayloadTooLarge { .. } => PreviewSourceError::Limit,
    AuthError::NotFound(_) => PreviewSourceError::Unavailable,
    _ => PreviewSourceError::Unavailable,
  }
}
