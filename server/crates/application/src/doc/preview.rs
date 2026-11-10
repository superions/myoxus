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
  pub field_freshness: Option<crate::document_fields::context::FieldFreshness>,
  pub fields: Vec<yjs::document_field::DocumentField>,
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
  field_source: Option<Arc<dyn crate::document_fields::context::DocumentFieldContextSource>>,
  field_actor: Option<Uuid>,
}

impl DocumentPreviewSourceService {
  pub fn new(load: Arc<DocLoadService>, blobs: Arc<BlobService>) -> Self {
    Self {
      load,
      blobs,
      field_source: None,
      field_actor: None,
    }
  }

  pub fn with_field_source(
    mut self,
    source: Arc<dyn crate::document_fields::context::DocumentFieldContextSource>,
    actor: Uuid,
  ) -> Self {
    self.field_source = Some(source);
    self.field_actor = Some(actor);
    self
  }

  pub async fn prepare(&self, request: PreviewSourceRequest) -> Result<DocumentPreviewSource, PreviewSourceError> {
    let source = self.prepare_projection(&request).await?;
    self.prepare_assets(&request, source).await
  }

  /// Only admitted excerpt descriptors can load facts. Return their freshness
  /// with the output for warm-cache validation without another native traversal.
  async fn prepare_projection(
    &self,
    request: &PreviewSourceRequest,
  ) -> Result<DocumentPreviewSource, PreviewSourceError> {
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
    let extraction = request.clone();
    let (mut ir, loaded) = tokio::task::spawn_blocking(move || {
      let ir = document_excerpt_from_yjs(
        extraction.workspace_id,
        extraction.doc_id,
        &extraction.identity.title,
        &extraction.identity.public_mode,
        &loaded.payload,
        &extraction.limits,
      );
      ir.map(|ir| (ir, loaded))
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
    let mut field_ids = std::collections::HashSet::new();
    for field in &ir.native_fields {
      let field = field.as_ref().map_err(|_| PreviewSourceError::Invalid)?;
      if !field_ids.insert(field.id()) {
        return Err(PreviewSourceError::Invalid);
      }
      crate::document_fields::validate(field).map_err(|_| PreviewSourceError::Invalid)?;
    }
    let fields = ir
      .native_fields
      .iter()
      .map(|field| field.as_ref().unwrap().clone())
      .collect::<Vec<_>>();
    let field_freshness = if fields.is_empty() {
      None
    } else {
      let revision = loaded.revision.to_string();
      let context = self
        .field_source
        .as_ref()
        .ok_or(PreviewSourceError::Unavailable)?
        .resolve_authorized(
          request.workspace_id,
          request.doc_id,
          revision,
          &fields,
          self.field_actor,
        )
        .await
        .map_err(|_| PreviewSourceError::Unavailable)?;
      let values = fields
        .iter()
        .map(|field| {
          let text = context
            .present(field)
            .map_err(|_| PreviewSourceError::Unavailable)?
            .text
            .ok_or(PreviewSourceError::Unavailable)?;
          Ok((field.id().to_string(), text))
        })
        .collect::<Result<std::collections::BTreeMap<_, _>, PreviewSourceError>>()?;
      project_excerpt_fields(&mut ir, &values, request.limits.max_text_chars)?;
      Some(context.freshness().clone())
    };
    let projection_wall_us = projection_started.elapsed().as_micros() as u64;
    tracing::debug!(target: "myoxus_preview_perf", source_read_us, projection_wall_us, "projected bounded preview source");
    Ok(DocumentPreviewSource {
      ir,
      revision: loaded.revision,
      metadata_revision: request.identity.metadata_revision,
      assets: Vec::new(),
      empty: !loaded.has_real_content,
      fields,
      field_freshness,
    })
  }

  async fn prepare_assets(
    &self,
    request: &PreviewSourceRequest,
    mut source: DocumentPreviewSource,
  ) -> Result<DocumentPreviewSource, PreviewSourceError> {
    let media_started = Instant::now();

    let mut assets = Vec::new();
    let mut total_media_bytes = 0usize;
    for candidate in resolve_asset_candidates(&source.ir) {
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
      media_read_us = media_started.elapsed().as_micros() as u64,
      media_bytes = total_media_bytes,
      "prepared preview source"
    );
    source.assets = assets;
    Ok(source)
  }
}

/// Walk only materialized excerpt text. Expanding a field cannot admit another
/// native block/cell or reveal a later field that the source budget excluded.
fn project_excerpt_fields(
  ir: &mut PublicDocIr,
  values: &std::collections::BTreeMap<String, String>,
  limit: usize,
) -> Result<(), PreviewSourceError> {
  use myoxus_public_render::{Block, InlineText};
  fn clip(text: &mut String, budget: &mut usize) -> bool {
    let count = text.chars().count();
    let clipped = count > *budget;
    if clipped {
      let end = text.char_indices().nth(*budget).map_or(text.len(), |(at, _)| at);
      text.truncate(end);
    }
    *budget = budget.saturating_sub(count);
    clipped
  }
  fn parts(
    parts: &mut Vec<InlineText>,
    values: &std::collections::BTreeMap<String, String>,
    budget: &mut usize,
  ) -> Result<bool, PreviewSourceError> {
    let mut previous = None;
    let mut clipped = false;
    for part in parts.iter_mut() {
      if let Some(field) = part.preview_field.take() {
        if previous.as_ref() == Some(&field) {
          part.text.clear();
          continue;
        }
        part.text = values
          .get(field.id())
          .filter(|text| !text.is_empty())
          .ok_or(PreviewSourceError::Unavailable)?
          .clone();
        previous = Some(field);
      } else {
        previous = None;
      }
      clipped |= clip(&mut part.text, budget);
    }
    parts.retain(|part| !part.text.is_empty());
    Ok(clipped)
  }
  fn walk(
    blocks: &mut [Block],
    values: &std::collections::BTreeMap<String, String>,
    budget: &mut usize,
  ) -> Result<bool, PreviewSourceError> {
    let mut clipped = false;
    for block in blocks {
      match block {
        Block::Paragraph { text, .. } | Block::Heading { text, .. } | Block::Quote { text, .. } => {
          clipped |= parts(text, values, budget)?
        }
        Block::Callout { text, children, .. } => {
          clipped |= parts(text, values, budget)?;
          clipped |= walk(children, values, budget)?;
        }
        Block::FootnoteDefinition { children, .. } => clipped |= walk(children, values, budget)?,
        Block::List { list, .. } => {
          for item in &mut list.items {
            clipped |= parts(&mut item.text, values, budget)?;
            clipped |= walk(&mut item.children, values, budget)?;
          }
        }
        Block::Table { rows, .. } => {
          for row in rows {
            for cell in row {
              clipped |= parts(cell, values, budget)?;
            }
          }
        }
        Block::Code { text, .. } => clipped |= clip(text, budget),
        _ => {}
      }
    }
    Ok(clipped)
  }
  let mut budget = limit;
  let clipped = walk(&mut ir.document.blocks, values, &mut budget)?;
  if clipped {
    ir.diagnostics.push(myoxus_public_render::RenderDiagnostic {
      code: "preview_text_truncated".into(),
      message: "Resolved field text exceeded the configured preview limit.".into(),
      block_id: None,
    });
  }
  Ok(())
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resolved_preview_fields_keep_admitted_owners_marks_and_expanded_text_limits() {
    let captured = serde_json::json!({"type":"metadata","id":"author","key":"createdBy","format":"name"});
    let blocks: Vec<yjs::PortableSnapshotBlock> = serde_json::from_value(serde_json::json!([
      {"id":"page","flavour":"myoxus:page","children":["note"],"props":{"title":"Preview"}},
      {"id":"note","flavour":"myoxus:note","children":["p","outside"]},
      {"id":"p","flavour":"myoxus:paragraph","props":{"text":{"$virgultum:internal:text$":true,"delta":[
        {"insert":" ","attributes":{"bold":true,"documentField":{"type":"input","id":"answer","definition":{"kind":"text","label":"Answer","required":false},"value":"Literal {{answer}}"}}},
        {"insert":"Old ","attributes":{"bold":true,"documentField":captured,"documentFieldCaptured":true}},
        {"insert":"name","attributes":{"italic":true,"documentField":captured,"documentFieldCaptured":true}}
      ]}}},
      {"id":"outside","flavour":"myoxus:paragraph","props":{"text":{"$virgultum:internal:text$":true,"delta":[
        {"insert":" "}
      ]}}}
    ])).unwrap();
    let snapshot = yjs::snapshot_blocks_to_yjs(&blocks).unwrap();
    // Construct the omitted malformed tail after the lossless import owner's
    // whole-snapshot admission; bounded preview extraction must not inspect it.
    use yrs::{Map, ReadTxn, Text, Transact, updates::decoder::Decode};
    let native = yrs::Doc::new();
    let snapshot = {
      let blocks = native.get_or_insert_map("blocks");
      let mut txn = native.transact_mut();
      txn.apply_update(yrs::Update::decode_v1(&snapshot).unwrap()).unwrap();
      let yrs::Out::YMap(block) = blocks.get(&txn, "outside").unwrap() else {
        panic!("outside paragraph")
      };
      let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
        panic!("outside text")
      };
      text.format(
        &mut txn,
        0,
        1,
        yrs::types::Attrs::from([("documentField".into(), yrs::Any::Bool(false))]),
      );
      txn.encode_state_as_update_v1(&Default::default())
    };
    let limits = PreviewProjectionLimits {
      max_input_bytes: 100_000,
      max_source_blocks: 20,
      max_projected_blocks: 1,
      max_text_chars: 24,
      max_depth: 10,
      max_table_rows: 5,
      max_table_columns: 5,
      max_visuals: 5,
    };
    let mut ir = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Preview", "Page", &snapshot, &limits).unwrap();
    assert_eq!(
      ir.native_fields.len(),
      2,
      "only the admitted paragraph can contribute context fields"
    );
    assert!(ir.native_fields.iter().all(Result::is_ok));
    assert!(project_excerpt_fields(&mut ir.clone(), &Default::default(), limits.max_text_chars).is_err());
    let values = [
      ("answer".into(), "Literal {{answer}}".into()),
      ("author".into(), "New author".into()),
    ]
    .into();
    project_excerpt_fields(&mut ir, &values, limits.max_text_chars).unwrap();
    let myoxus_public_render::Block::Paragraph { text, .. } = &ir.document.blocks[0] else {
      panic!("paragraph")
    };
    assert_eq!(
      text.iter().map(|part| part.text.as_str()).collect::<String>(),
      "Literal {{answer}}New au"
    );
    assert!(text[0].bold && text[1].bold);
    assert!(text.iter().all(|part| part.preview_field.is_none()));
    assert!(
      ir.diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "preview_text_truncated")
    );
    assert_eq!(
      ir.document.blocks.len(),
      1,
      "expansion cannot inspect or admit the invalid later paragraph"
    );
  }
}
