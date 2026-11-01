// SPDX-License-Identifier: AGPL-3.0-or-later
//! Deterministic wrapping never rewrites native payloads or reopens source paths.
use super::capture::capture_feature_source;
use myoxus_application::feature_bundle::{CapturedFeatureBundle, validate_feature_manifest};
use myoxus_contracts::config_document::encode_config_yaml;
use myoxus_domain::{
  feature_bundle::FeatureBundleManifest,
  repositories::{RepoResult, RepositoryError},
};
use std::{
  collections::{BTreeMap, BTreeSet},
  io::{Cursor, Write},
  path::Path,
};

pub fn pack_feature_source(root: &Path, manifest_path: &str) -> RepoResult<CapturedFeatureBundle> {
  capture_feature_source(root, manifest_path)
}

/// Stable member order, epoch metadata and Stored compression preserve each
/// child ZIP/YAML byte-for-byte and make the outer digest reproducible.
pub fn pack_captured_feature_bundle(
  manifest: &FeatureBundleManifest,
  files: &BTreeMap<String, Vec<u8>>,
) -> RepoResult<Vec<u8>> {
  validate_feature_manifest(manifest, files).map_err(RepositoryError::Validation)?;
  let manifest_bytes = encode_config_yaml(manifest)
    .map_err(|error| RepositoryError::Validation(error.to_string()))?
    .into_bytes();
  let mut entries = files
    .iter()
    .map(|(path, bytes)| (path.as_str(), bytes.as_slice()))
    .collect::<BTreeMap<_, _>>();
  entries.insert("manifest.yaml", &manifest_bytes);
  let mut names = BTreeSet::new();
  if entries.keys().any(|path| !names.insert(path.to_ascii_lowercase())) {
    return Err(RepositoryError::Validation(
      "Feature Bundle duplicate canonical ZIP member".into(),
    ));
  }
  let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
  let options = zip::write::FileOptions::<()>::default()
    .compression_method(zip::CompressionMethod::Stored)
    .last_modified_time(zip::DateTime::default())
    .unix_permissions(0o644);
  for (path, bytes) in entries {
    writer
      .start_file(path, options)
      .map_err(|error| RepositoryError::Storage(format!("Feature Bundle {path}: {error}")))?;
    writer
      .write_all(bytes)
      .map_err(|error| RepositoryError::Storage(format!("Feature Bundle {path}: {error}")))?;
  }
  Ok(
    writer
      .finish()
      .map_err(|error| RepositoryError::Storage(format!("Feature Bundle ZIP finish: {error}")))?
      .into_inner(),
  )
}
