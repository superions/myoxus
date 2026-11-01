// SPDX-License-Identifier: AGPL-3.0-or-later
//! Compose canonical native bundles from authorized immutable source captures.

use std::{
  collections::{BTreeMap, HashSet},
  io::{Cursor, Write},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tracing::instrument;

use super::{
  TemplateRegistryZipLimits,
  bundle::{
    self, LocalizedContent, Manifest, TemplateBundleZipLimits, TemplatePurpose, TitlePolicy, ValidationSeverity,
  },
  content::prepare_document,
};
use crate::document_template::CapturedDocumentTemplate;

/// The existing editable manifest fields. Content digests, payload paths and
/// workspace attribution are never accepted from the download form.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentTemplateBundleMetadata {
  pub template_id: String,
  pub version: String,
  pub title: String,
  pub locale: String,
  pub description: Option<String>,
  pub category: Option<String>,
  #[serde(default)]
  pub tags: Vec<String>,
  pub title_policy: Option<TitlePolicy>,
}

/// Each language is explicitly backed by a captured native source; composition
/// neither translates the default body nor discovers additional workspace data.
pub struct LocalizedDocumentTemplateCapture {
  pub locale: String,
  pub source: CapturedDocumentTemplate,
}

pub struct DocumentTemplateSourceExport {
  pub bytes: Vec<u8>,
  pub filename: String,
  pub content_checksum: String,
  pub container_checksum: String,
}

#[derive(Debug, Error)]
pub enum DocumentTemplateSourceExportError {
  #[error("invalid native bundle metadata")]
  InvalidMetadata(Vec<bundle::ValidationError>),
  #[error("invalid or duplicate native language mapping")]
  InvalidLocale,
  #[error("source is not supported as a Page template")]
  UnsupportedSource,
  #[error("source cannot be represented as a complete native bundle")]
  InvalidContent,
  #[error("native source bundle exceeds configured archive limits")]
  LimitExceeded,
}

/// Pure composition after capture authorization. Only standard native metadata
/// enters the archive; workspace metadata, bindings, policies and CRDT history
/// stay outside it. No Registry import, revision or publication is performed.
#[instrument(skip_all, fields(locale_sources = localized.len()))]
pub fn compose_source_export(
  metadata: DocumentTemplateBundleMetadata,
  source: &CapturedDocumentTemplate,
  localized: &[LocalizedDocumentTemplateCapture],
  limits: TemplateRegistryZipLimits,
) -> Result<DocumentTemplateSourceExport, DocumentTemplateSourceExportError> {
  use DocumentTemplateSourceExportError as Error;
  let locale = normalize_locale(&metadata.locale)?;
  let mut manifest = Manifest {
    template_id: metadata.template_id.trim().into(),
    version: metadata.version.trim().into(),
    title: metadata.title.trim().into(),
    description: optional_text(metadata.description),
    category: optional_text(metadata.category),
    tags: metadata
      .tags
      .into_iter()
      .map(|tag| tag.trim().to_owned())
      .filter(|tag| !tag.is_empty())
      .collect(),
    locale: Some(locale.clone()),
    kind: Some("page".into()),
    min_server_version: None,
    checksum: None,
    localized_contents: BTreeMap::new(),
    title_policy: metadata.title_policy,
    purpose: Some(TemplatePurpose::Template),
  };
  let findings = bundle::validate_manifest(&manifest);
  if findings
    .iter()
    .any(|finding| finding.severity == ValidationSeverity::Error)
  {
    return Err(Error::InvalidMetadata(findings));
  }
  // Validate all selections before encoding any payload. The default language
  // already owns one source and cannot acquire a second, conflicting mapping.
  let mut locales = HashSet::from([locale]);
  for variant in localized {
    if !locales.insert(normalize_locale(&variant.locale)?) {
      return Err(Error::InvalidLocale);
    }
  }
  let zip_limits = TemplateBundleZipLimits {
    max_entries: limits.max_entries as usize,
    max_single_file_size: limits.max_entry_uncompressed_size_mb.saturating_mul(1024 * 1024),
    max_total_uncompressed_size: limits.max_total_uncompressed_size_mb.saturating_mul(1024 * 1024),
    max_compression_ratio: limits.max_compression_ratio,
    max_path_length: limits.max_path_length as usize,
  };
  if localized.len() as u64 + 2 > limits.max_entries {
    return Err(Error::LimitExceeded);
  }
  let content = snapshot_zip(source, &manifest.template_id, limits)?;
  manifest.checksum = Some(hex::encode(Sha256::digest(&content)));
  let mut budget = bundle::NestedArchiveBudget::new(zip_limits);
  budget.account(&content).map_err(|_| Error::LimitExceeded)?;
  let mut localized_contents = BTreeMap::new();
  for variant in localized {
    let locale = normalize_locale(&variant.locale)?;
    let bytes = snapshot_zip(&variant.source, &manifest.template_id, limits)?;
    budget.account(&bytes).map_err(|_| Error::LimitExceeded)?;
    manifest.localized_contents.insert(
      locale.clone(),
      LocalizedContent {
        path: format!("localized/{locale}.template.zip"),
        sha256: hex::encode(Sha256::digest(&bytes)),
        title: variant.source.title.clone(),
        description: None,
      },
    );
    localized_contents.insert(locale, bytes);
  }
  let bytes =
    bundle::create_export_bundle(&manifest, &content, None, &localized_contents).map_err(|_| Error::InvalidContent)?;
  if bytes.len() as u64 > zip_limits.max_total_uncompressed_size {
    return Err(Error::LimitExceeded);
  }
  // The existing parser owns the cumulative outer + inner archive budget and
  // locale/path/checksum admission. Validate the exact bytes returned to callers.
  let parsed = bundle::parse_bundle_with_limits(&bytes, zip_limits).map_err(|_| Error::InvalidContent)?;
  Ok(DocumentTemplateSourceExport {
    filename: format!("{}-{}.zip", manifest.template_id, manifest.version),
    content_checksum: parsed.content_checksum,
    container_checksum: parsed.bundle_checksum,
    bytes,
  })
}

fn snapshot_zip(
  source: &CapturedDocumentTemplate,
  template_id: &str,
  limits: TemplateRegistryZipLimits,
) -> Result<Vec<u8>, DocumentTemplateSourceExportError> {
  use DocumentTemplateSourceExportError as Error;
  if source.primary_mode.as_deref().is_some_and(|mode| mode != "page") {
    return Err(Error::UnsupportedSource);
  }
  let snapshot =
    yjs::document_to_snapshot(&source.update, template_id, &source.title).map_err(|_| Error::InvalidContent)?;
  let snapshot = serde_json::to_vec(&snapshot).map_err(|_| Error::InvalidContent)?;
  let max_entry = limits.max_entry_uncompressed_size_mb.saturating_mul(1024 * 1024);
  let max_total = limits.max_total_uncompressed_size_mb.saturating_mul(1024 * 1024);
  let path = "source.snapshot.json";
  if source.assets.len() as u64 + 1 > limits.max_entries
    || path.len() as u64 > limits.max_path_length
    || snapshot.len() as u64 > max_entry
  {
    return Err(Error::LimitExceeded);
  }
  let mut total = snapshot.len() as u64;
  for asset in &source.assets {
    total = total
      .checked_add(asset.bytes.len() as u64)
      .ok_or(Error::LimitExceeded)?;
    if asset.path.len() as u64 > limits.max_path_length || asset.bytes.len() as u64 > max_entry || total > max_total {
      return Err(Error::LimitExceeded);
    }
  }
  if total > max_total {
    return Err(Error::LimitExceeded);
  }
  let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
  let options = zip::write::FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);
  writer.start_file(path, options).map_err(|_| Error::InvalidContent)?;
  writer.write_all(&snapshot).map_err(|_| Error::InvalidContent)?;
  for asset in &source.assets {
    writer
      .start_file(asset.path.as_str(), options)
      .map_err(|_| Error::InvalidContent)?;
    writer.write_all(&asset.bytes).map_err(|_| Error::InvalidContent)?;
  }
  let bytes = writer.finish().map_err(|_| Error::InvalidContent)?.into_inner();
  if bytes.len() as u64 > max_entry {
    return Err(Error::LimitExceeded);
  }
  prepare_document(&bytes, limits).map_err(|_| Error::InvalidContent)?;
  Ok(bytes)
}

fn normalize_locale(value: &str) -> Result<String, DocumentTemplateSourceExportError> {
  let locale = value.trim().replace('_', "-").to_ascii_lowercase();
  if locale.is_empty()
    || !locale
      .chars()
      .all(|character| character.is_ascii_alphanumeric() || character == '-')
  {
    return Err(DocumentTemplateSourceExportError::InvalidLocale);
  }
  Ok(locale)
}

fn optional_text(value: Option<String>) -> Option<String> {
  value.and_then(|value| {
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
  })
}
