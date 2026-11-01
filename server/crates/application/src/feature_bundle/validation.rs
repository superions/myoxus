// SPDX-License-Identifier: AGPL-3.0-or-later
use super::MAX_FEATURE_COMPONENTS;
use crate::database::definition::templates::compare_template_versions;
use myoxus_domain::feature_bundle::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Archive and authoring paths use the same unambiguous, portable spelling.
pub fn canonical_feature_path(path: &str) -> bool {
  !path.is_empty()
    && path.len() <= 512
    && !path.contains(['\\', ':'])
    && !path.chars().any(char::is_control)
    && path
      .split('/')
      .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub(super) fn valid_key(key: &str) -> bool {
  !key.is_empty()
    && key.len() <= 160
    && !matches!(key, "." | "..")
    && key
      .bytes()
      // Existing native assistant identities are case-sensitive (taskHome,
      // taskInventory). Delivery identifiers must preserve those spellings.
      .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub(super) fn valid_pin(pin: &FeatureBundlePin) -> bool {
  valid_key(&pin.id) && compare_template_versions(&pin.version, &pin.version).is_ok() && valid_digest(&pin.sha256)
}

fn valid_digest(value: &str) -> bool {
  value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Verify the closed captured inventory before any native registration/write.
/// Native bodies and typed endpoint resolution are admitted separately against
/// the captured source set, never by trusting these wrapper declarations.
pub fn validate_feature_manifest(
  manifest: &FeatureBundleManifest,
  files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
  if manifest.format_version != 1
    || !valid_key(&manifest.id)
    || compare_template_versions(&manifest.version, &manifest.version).is_err()
    || manifest.components.is_empty()
    || manifest.components.len() > MAX_FEATURE_COMPONENTS
    || manifest.files.len() > 4096
    || manifest.links.len() > 1024
    || manifest.exports.len() > 1024
  {
    return Err("invalid or unbounded Feature Bundle manifest".into());
  }
  if manifest.capabilities.is_empty()
    || manifest.capabilities.iter().any(|(name, version)| {
      *version != 1
        || !matches!(
          name.as_str(),
          "database" | "assistant" | "documentTemplate" | "artwork" | "workflow"
        )
    })
  {
    return Err("unsupported Feature Bundle capability version".into());
  }
  if manifest.files.len() != files.len() {
    return Err("Feature Bundle inventory differs from captured files".into());
  }
  let mut total = 0usize;
  for (path, digest) in &manifest.files {
    let bytes = files
      .get(path)
      .ok_or_else(|| format!("Feature Bundle missing file {path}"))?;
    total = total
      .checked_add(bytes.len())
      .ok_or("Feature Bundle byte size overflow")?;
    if path == "manifest.yaml"
      || !canonical_feature_path(path)
      || !valid_digest(digest)
      || bytes.is_empty()
      || bytes.len() > 50 * 1024 * 1024
      || total > 200 * 1024 * 1024
      || format!("{:x}", Sha256::digest(bytes)) != *digest
    {
      return Err(format!("Feature Bundle invalid file or SHA-256: {path}"));
    }
  }
  let mut components = BTreeSet::new();
  for component in &manifest.components {
    let capability = match component.kind {
      FeatureComponentKind::DatabaseCatalog | FeatureComponentKind::TaskCore => "database",
      FeatureComponentKind::AssistantCatalog => "assistant",
      FeatureComponentKind::DocumentTemplate => "documentTemplate",
      FeatureComponentKind::Artwork => "artwork",
      FeatureComponentKind::Workflow => "workflow",
    };
    if !valid_key(&component.id)
      || !components.insert(component.id.as_str())
      || manifest.capabilities.get(capability) != Some(&1)
      || manifest.files.get(&component.path) != Some(&component.sha256)
      || matches!(component.kind, FeatureComponentKind::Artwork) != component.artwork.is_some()
      || matches!(
        component.kind,
        FeatureComponentKind::DocumentTemplate | FeatureComponentKind::TaskCore | FeatureComponentKind::Workflow
      ) != component.native_identity.is_some()
    {
      return Err(format!(
        "Feature Bundle invalid component {} ({})",
        component.id, component.path
      ));
    }
    if let Some(identity) = &component.native_identity {
      if !valid_key(&identity.id) || compare_template_versions(&identity.version, &identity.version).is_err() {
        return Err(format!("Feature Bundle invalid native identity: {}", component.id));
      }
    }
    if let Some(metadata) = &component.artwork {
      super::artwork::validate_artwork(&files[&component.path], metadata)
        .map_err(|message| format!("Artwork {} ({}): {message}", component.id, component.path))?;
    }
  }
  let mut exports = BTreeSet::new();
  for export in &manifest.exports {
    if !valid_key(&export.id) || !exports.insert(&export.id) || !components.contains(export.source.component.as_str()) {
      return Err(format!("Feature Bundle invalid export {}", export.id));
    }
  }
  Ok(())
}
