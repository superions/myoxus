// SPDX-License-Identifier: AGPL-3.0-or-later
//! Strict native assistant decoding from a declared captured-byte inventory.
use crate::template_files::{SourceBounds, decode_yaml, validate_yaml_path, verify_sha256};
use myoxus_contracts::config_document::{ConfigDocumentFormat, decode_config_document};
use myoxus_domain::{
  assistant_package::{AssistantPackageCatalogSource, AssistantPackageSource},
  repositories::{RepoResult, RepositoryError},
};
use std::collections::{BTreeMap, BTreeSet};

/// Materialize only the declared catalog activation default before the strict
/// native roundtrip. Source bodies and unknown keys keep the generic decoder.
pub(crate) fn decode_assistant_package_catalog(bytes: &[u8]) -> Result<AssistantPackageCatalogSource, String> {
  let text = std::str::from_utf8(bytes).map_err(|_| "input is not UTF-8".to_string())?;
  let mut value = decode_config_document(text, ConfigDocumentFormat::Yaml).map_err(|error| error.to_string())?;
  if let Some(packages) = value.get_mut("packages").and_then(serde_json::Value::as_array_mut) {
    for entry in packages {
      if let Some(entry) = entry.as_object_mut() {
        entry.entry("enabled").or_insert(serde_json::Value::Bool(true));
      }
    }
  }
  let normalized = serde_json::to_vec(&value).map_err(|_| "source schema serialization failed".to_string())?;
  decode_yaml(&normalized)
}

/// Decodes retained package identities and pins without accessing files or
/// requiring a complete active/default selection for an individual fragment.
pub fn decode_assistant_package_sources(
  files: &BTreeMap<String, Vec<u8>>,
) -> RepoResult<(AssistantPackageCatalogSource, Vec<(AssistantPackageSource, String)>)> {
  decode_with_diagnostics(files, |path, message| {
    RepositoryError::Storage(format!("Assistant package {path}: {message}"))
  })
}

pub(super) fn decode_with_diagnostics(
  files: &BTreeMap<String, Vec<u8>>,
  error: impl Fn(&str, &str) -> RepositoryError,
) -> RepoResult<(AssistantPackageCatalogSource, Vec<(AssistantPackageSource, String)>)> {
  let mut inventory_bounds = SourceBounds::default();
  for (path, bytes) in files {
    validate_yaml_path(path)
      .and_then(|()| inventory_bounds.admit(bytes))
      .map_err(|message| error(path, &message))?;
  }
  let mut bounds = SourceBounds::default();
  let mut read = |path: &str| -> RepoResult<&[u8]> {
    validate_yaml_path(path).map_err(|message| error(path, &message))?;
    let bytes = files.get(path).ok_or_else(|| error(path, "missing captured source"))?;
    bounds.admit(bytes).map_err(|message| error(path, &message))?;
    Ok(bytes)
  };
  let source: AssistantPackageCatalogSource =
    decode_assistant_package_catalog(read("catalog.yaml")?).map_err(|message| error("catalog.yaml", &message))?;
  let mut paths = BTreeSet::new();
  let mut definitions = Vec::new();
  for entry in &source.packages {
    for reference in &entry.definitions {
      if reference.path != format!("{}/{}.yaml", entry.id, reference.version) || !paths.insert(&reference.path) {
        return Err(error(
          &reference.path,
          "duplicate or noncanonical immutable package path",
        ));
      }
      let bytes = read(&reference.path)?;
      verify_sha256(bytes, &reference.sha256).map_err(|message| error(&reference.path, &message))?;
      let definition: AssistantPackageSource =
        decode_yaml(bytes).map_err(|message| error(&reference.path, &message))?;
      if definition.id != entry.id || definition.version != reference.version {
        return Err(error(&reference.path, "package identity/version mismatch"));
      }
      definitions.push((definition, reference.sha256.clone()));
    }
  }
  Ok((source, definitions))
}
