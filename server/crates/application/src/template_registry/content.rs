// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::io::{Cursor, Read};

use myoxus_workspace_import::{DecodedDocumentContent, WorkspaceDecoder, WorkspaceImportLimits, asset_aliases};
use sha2::{Digest, Sha256};

use super::TemplateRegistryZipLimits;
use crate::auth::{AuthError, AuthResult};

/// Shared preflight for single bundles and all package children. Keep native
/// validation before persistence, including languages not selected by a reader.
pub(super) fn validation_findings(
  parsed: &super::bundle::ParsedBundle,
  limits: TemplateRegistryZipLimits,
) -> Vec<super::bundle::ValidationError> {
  use super::bundle::{ValidationError, ValidationSeverity, validate_manifest};
  let mut findings = validate_manifest(&parsed.manifest);
  for (locale, bytes) in &parsed.localized_contents {
    if let Err(error) = document_update(bytes, limits) {
      findings.push(ValidationError {
        code: "INVALID_TEMPLATE_CONTENT".into(),
        message: format!("INVALID_TEMPLATE_CONTENT: {error}"),
        field: Some("localized_contents".into()),
        path: Some(format!("/localized_contents/{locale}")),
        severity: ValidationSeverity::Error,
      });
    }
  }
  if let Err(error) = document_update(&parsed.content_bytes, limits) {
    findings.push(ValidationError {
      code: "INVALID_TEMPLATE_CONTENT".into(),
      message: format!("INVALID_TEMPLATE_CONTENT: {error}"),
      field: None,
      path: Some("/content".into()),
      severity: ValidationSeverity::Error,
    });
  }
  findings
}

/// Decode without workspace writes, including validation and accepted-source capture.
pub(super) fn document_update(content: &[u8], limits: TemplateRegistryZipLimits) -> AuthResult<Vec<u8>> {
  Ok(prepare_document(content, limits)?.update)
}

pub(super) struct PreparedDocument {
  pub update: Vec<u8>,
  pub assets: Vec<PreparedAsset>,
}

pub(super) struct PreparedAsset {
  pub key: String,
  pub sha256: String,
  pub mime: String,
  pub bytes: Vec<u8>,
}

/// Retain archive bytes with their validated native references. Only the
/// mutating Registry materializer may upload these into a target workspace.
pub(super) fn prepare_document(content: &[u8], limits: TemplateRegistryZipLimits) -> AuthResult<PreparedDocument> {
  if !content.starts_with(b"PK") {
    yjs::validate_update_v1(content).map_err(|_| AuthError::InvalidInput("invalid template Yjs content".into()))?;
    return Ok(PreparedDocument {
      update: validate_native_content(content.to_vec(), &HashMap::new())?,
      assets: Vec::new(),
    });
  }
  let decoder = WorkspaceDecoder::new(WorkspaceImportLimits {
    max_upload_bytes: limits.max_entry_uncompressed_size_mb.saturating_mul(1024 * 1024),
    max_expanded_bytes: limits.max_total_uncompressed_size_mb.saturating_mul(1024 * 1024),
    max_entry_bytes: limits.max_entry_uncompressed_size_mb.saturating_mul(1024 * 1024),
    max_archive_entries: limits.max_entries as usize,
    max_compression_ratio: limits.max_compression_ratio as u64,
    max_documents: 1,
    ..WorkspaceImportLimits::default()
  });
  let mut decoded = decoder
    .decode_snapshot_bytes(content)
    .map_err(|error| AuthError::InvalidInput(format!("template snapshot rejected: {}", error.code.as_str())))?;
  if decoded.documents.len() != 1 {
    return Err(AuthError::InvalidInput(
      "template materialization requires exactly one document".into(),
    ));
  }
  let document = decoded.documents.remove(0);
  if document.is_trashed {
    return Err(AuthError::InvalidInput(
      "cannot materialize a trashed template source".into(),
    ));
  }
  let update = match document.content {
    DecodedDocumentContent::SnapshotBlocks(blocks) => {
      yjs::snapshot_blocks_to_yjs(&blocks).map_err(AuthError::InvalidInput)?
    }
    DecodedDocumentContent::YjsV1(update) => update,
    DecodedDocumentContent::MarkdownUtf8(_) => {
      return Err(AuthError::InvalidInput(
        "template content cannot be materialized from unprepared Markdown".into(),
      ));
    }
  };
  let title_delta = yjs::update_document_title(&update, &document.title).map_err(AuthError::InvalidInput)?;
  let update = yjs::merge_updates(vec![update, title_delta]).map_err(AuthError::InvalidInput)?;
  let mut archive =
    zip::ZipArchive::new(Cursor::new(content)).map_err(|error| AuthError::InvalidInput(error.to_string()))?;
  let mut assets = Vec::new();
  let mut targets = HashMap::new();
  for asset in decoded.assets {
    let mut bytes = Vec::new();
    archive
      .by_name(&asset.source_key)
      .map_err(|_| AuthError::InvalidInput("template archive asset is unavailable".into()))?
      .take(asset.size_bytes.saturating_add(1))
      .read_to_end(&mut bytes)
      .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
    if bytes.len() as u64 != asset.size_bytes || hex::encode(Sha256::digest(&bytes)) != asset.content_hash {
      return Err(AuthError::InvalidInput(
        "template archive asset checksum mismatch".into(),
      ));
    }
    let key = format!("assets/{}", asset.content_hash);
    for alias in asset_aliases(&asset.source_key) {
      targets.insert(alias, key.clone());
    }
    let mime = crate::mime_policy::detect_mime(&bytes, &asset.source_key, "").effective_mime;
    assets.push(PreparedAsset {
      key,
      sha256: asset.content_hash,
      mime,
      bytes,
    });
  }
  let update = validate_native_content(update, &targets)?;
  let rewrites = yjs::extract_portable_asset_references(&update)
    .map_err(AuthError::InvalidInput)?
    .into_iter()
    .map(|reference| {
      Ok(yjs::NativeReferenceRewrite {
        replacement: Some(yjs::NativeReferenceReplacement {
          id: targets
            .get(&reference.source_key)
            .ok_or_else(|| AuthError::InvalidInput("template archive asset is missing".into()))?
            .clone(),
          workspace_id: None,
        }),
        position: reference.position,
        expected_id: reference.raw_source_key,
        expected_workspace_id: reference.workspace_id,
      })
    })
    .collect::<AuthResult<Vec<_>>>()?;
  // Keep the reference writer separate from the decoded snapshot's CRDT clients.
  let update = if rewrites.is_empty() {
    update
  } else {
    let digest = Sha256::digest(content);
    let client_id = (u64::from_le_bytes(digest[..8].try_into().expect("SHA-256 prefix")) & ((1_u64 << 53) - 1)).max(1);
    yjs::rewrite_native_references(&update, &rewrites, client_id)
      .map_err(AuthError::InvalidInput)?
      .full_state
  };
  Ok(PreparedDocument { update, assets })
}

fn validate_native_content(update: Vec<u8>, assets: &HashMap<String, String>) -> AuthResult<Vec<u8>> {
  let asset_references = yjs::extract_portable_asset_references(&update).map_err(AuthError::InvalidInput)?;
  if asset_references
    .iter()
    .any(|reference| !assets.contains_key(&reference.source_key))
  {
    return Err(AuthError::InvalidInput(
      "template content references assets that are not materialized with the source".into(),
    ));
  }
  yjs::instantiate_native_template(&update, &HashMap::new())
    .map_err(|error| AuthError::InvalidInput(format!("invalid native template structure: {error}")))?;
  Ok(update)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  #[test]
  fn native_snapshot_requires_its_image_and_retains_exact_asset_bytes() {
    let snapshot = serde_json::json!({
      "meta": { "id": "source", "title": "Guide" },
      "blocks": { "type": "block", "id": "page", "flavour": "myoxus:page", "props": {}, "children": [
        { "type": "block", "id": "note", "flavour": "myoxus:note", "props": {}, "children": [
          { "type": "block", "id": "image", "flavour": "myoxus:image", "props": {
            "sourceId": "figure", "caption": "A useful caption", "width": 394, "height": 263
          }, "children": [] }
        ] }
      ] }
    });
    let bytes = b"RIFF\x04\x00\x00\x00WEBP";
    let archive = |include_image| {
      let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
      let options = zip::write::FileOptions::<()>::default();
      writer.start_file("guide.snapshot.json", options).unwrap();
      writer
        .write_all(serde_json::to_string(&snapshot).unwrap().as_bytes())
        .unwrap();
      if include_image {
        writer.start_file("assets/figure.webp", options).unwrap();
        writer.write_all(bytes).unwrap();
      }
      writer.finish().unwrap().into_inner()
    };
    assert!(prepare_document(&archive(false), TemplateRegistryZipLimits::default()).is_err());
    let prepared = prepare_document(&archive(true), TemplateRegistryZipLimits::default()).unwrap();
    assert_eq!(prepared.assets.len(), 1);
    assert_eq!(prepared.assets[0].bytes, bytes);
    assert_eq!(prepared.assets[0].mime, "image/webp");
    assert_eq!(
      yjs::extract_portable_asset_references(&prepared.update).unwrap()[0].source_key,
      prepared.assets[0].key
    );
    // A raw reference without the packaged bytes remains rejected.
    assert!(document_update(&prepared.update, TemplateRegistryZipLimits::default()).is_err());
  }
}
