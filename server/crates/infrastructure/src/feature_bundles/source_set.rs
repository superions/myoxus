// SPDX-License-Identifier: AGPL-3.0-or-later
//! One captured release selection is admitted before native startup owners run.
use super::archive::{archive_limits, read_feature_bundle_with_budget};
use crate::template_files::{decode_yaml, read_confined_file};
use myoxus_application::{
  feature_bundle::{CapturedFeatureBundle, ResolvedFeatureCatalogs, assemble_feature_catalogs},
  template_registry::bundle::NestedArchiveBudget,
};
use myoxus_domain::{
  feature_bundle::*,
  repositories::{RepoResult, RepositoryError},
};
use sha2::{Digest, Sha256};
use std::{
  collections::{BTreeMap, BTreeSet},
  path::Path,
};

// Active and retained versions share one bounded operation. Keep the 200 MiB
// per-archive inspector independent from this cumulative source-set capacity.
const MAX_SOURCE_SET_EXPANDED_BYTES: u64 = 512 * 1024 * 1024;

pub struct CapturedFeatureSourceSet {
  pub release: FeatureReleaseDescriptor,
  pub catalog: FeatureBundleCatalogSource,
  pub bundles: Vec<CapturedFeatureBundle>,
  pub resolved: ResolvedFeatureCatalogs,
}

fn invalid(message: impl Into<String>) -> RepositoryError {
  RepositoryError::Validation(message.into())
}

pub(super) fn explicit_file(path: &Path) -> RepoResult<Vec<u8>> {
  let absolute = std::path::absolute(path).map_err(|error| invalid(error.to_string()))?;
  for ancestor in absolute.ancestors() {
    if std::fs::symlink_metadata(ancestor)
      .map_err(|error| invalid(error.to_string()))?
      .file_type()
      .is_symlink()
    {
      return Err(invalid("Feature release descriptor path contains a symlink"));
    }
  }
  let parent = absolute
    .parent()
    .ok_or_else(|| invalid("Feature release descriptor has no parent"))?
    .canonicalize()
    .map_err(|error| invalid(error.to_string()))?;
  let name = absolute
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or_else(|| invalid("invalid Feature release descriptor filename"))?;
  read_confined_file(&parent, name, 4 * 1024 * 1024, "Feature release")
}

/// The expectation is an explicit binary-owned path, independent of the mount.
/// Every archive is captured once under the mounted root before composition.
pub fn capture_feature_source_set(root: &Path, release_manifest: &Path) -> RepoResult<CapturedFeatureSourceSet> {
  let expected_bytes = explicit_file(release_manifest)?;
  let release: FeatureReleaseDescriptor = decode_yaml(&expected_bytes).map_err(invalid)?;
  let root = root.canonicalize().map_err(|error| invalid(error.to_string()))?;
  // Only catalog.yaml publishes the active selection. The packaged copy of
  // release.yaml is authoring metadata, not a second independently renamed
  // pointer inside an operator mount. Its base must match the binary-owned pin.
  let catalog: FeatureBundleCatalogSource = decode_yaml(&read_confined_file(
    &root,
    "features/catalog.yaml",
    4 * 1024 * 1024,
    "Feature release",
  )?)
  .map_err(invalid)?;
  capture_feature_selection(&root, release, catalog)
}

/// Resolve the fixed layout of an installed executable without probing the
/// checkout, current directory, operator configuration or mounted templates.
pub fn packaged_feature_release_manifest() -> RepoResult<std::path::PathBuf> {
  let executable = std::env::current_exe().map_err(|error| invalid(error.to_string()))?;
  let directory = executable
    .parent()
    .ok_or_else(|| invalid("executable parent unavailable"))?;
  if directory == Path::new("/usr/local/bin") {
    Ok("/opt/myoxus/static/features/release.yaml".into())
  } else if directory == Path::new("/usr/bin") {
    Ok("/usr/share/myoxus/static/features/release.yaml".into())
  } else {
    let root = directory
      .parent()
      .ok_or_else(|| invalid("native bundle root unavailable"))?;
    Ok(root.join("static/features/release.yaml"))
  }
}

/// Preparation supplies its admitted pointer explicitly; archive bytes still
/// come solely from this captured root, never ambient authoring paths.
pub fn capture_feature_selection(
  root: &Path,
  release: FeatureReleaseDescriptor,
  catalog: FeatureBundleCatalogSource,
) -> RepoResult<CapturedFeatureSourceSet> {
  if release.format_version != 1 || release.base != catalog.base {
    return Err(invalid("invalid Feature release selection"));
  }
  let archives = capture_catalog_archives(root, &catalog)?;
  let bundles = decode_captured_archives(&release.base.id, &archives)?;
  let resolved = assemble_feature_catalogs(&release, &catalog, &bundles).map_err(invalid)?;
  Ok(CapturedFeatureSourceSet {
    release,
    catalog,
    bundles,
    resolved,
  })
}

pub(super) type CapturedArchives = BTreeMap<(String, String), (FeatureBundlePin, Vec<u8>)>;

pub(super) fn catalog_pins(catalog: &FeatureBundleCatalogSource) -> RepoResult<Vec<&FeatureBundlePin>> {
  if catalog.format_version != 1 || catalog.optional.len() > 128 || catalog.retained.len() > 256 {
    return Err(invalid("invalid bounded Feature catalog"));
  }
  let mut unique = BTreeSet::new();
  let mut pins = Vec::new();
  for pin in std::iter::once(&catalog.base)
    .chain(&catalog.optional)
    .chain(&catalog.retained)
  {
    if !unique.insert((pin.id.clone(), pin.version.clone())) {
      return Err(invalid("duplicate Feature selection identity"));
    }
    pins.push(pin);
  }
  Ok(pins)
}

pub(super) fn capture_catalog_archives(
  root: &Path,
  catalog: &FeatureBundleCatalogSource,
) -> RepoResult<CapturedArchives> {
  let mut captured = BTreeMap::new();
  let mut total = 0usize;
  capture_catalog_archives_into(root, catalog, &mut captured, &mut total)?;
  Ok(captured)
}

pub(super) fn capture_catalog_archives_into(
  root: &Path,
  catalog: &FeatureBundleCatalogSource,
  captured: &mut CapturedArchives,
  total: &mut usize,
) -> RepoResult<()> {
  let root = root.canonicalize().map_err(|error| invalid(error.to_string()))?;
  for pin in catalog_pins(catalog)? {
    capture_archive(&root, pin, captured, total)?;
  }
  Ok(())
}

pub(super) fn capture_archive(
  root: &Path,
  pin: &FeatureBundlePin,
  captured: &mut CapturedArchives,
  total: &mut usize,
) -> RepoResult<()> {
  let path = format!("features/{}", pin.archive_path());
  let remaining = (200usize * 1024 * 1024)
    .checked_sub(*total)
    .ok_or_else(|| invalid("Feature source set byte limit exceeded"))?;
  let bytes = read_confined_file(root, &path, remaining, "Feature release")?;
  *total = total
    .checked_add(bytes.len())
    .ok_or_else(|| invalid("Feature source set byte size overflow"))?;
  if format!("{:x}", Sha256::digest(&bytes)) != pin.sha256 {
    return Err(invalid(format!("Feature archive SHA-256 mismatch: {path}")));
  }
  merge_archive(captured, pin.clone(), bytes)
}

pub(super) fn merge_archive(captured: &mut CapturedArchives, pin: FeatureBundlePin, bytes: Vec<u8>) -> RepoResult<()> {
  let identity = (pin.id.clone(), pin.version.clone());
  if let Some((previous, previous_bytes)) = captured.get(&identity) {
    if previous != &pin || previous_bytes != &bytes {
      return Err(invalid(format!(
        "immutable Feature archive differs: {} {}",
        pin.id, pin.version
      )));
    }
  } else {
    captured.insert(identity, (pin, bytes));
  }
  Ok(())
}

pub(super) fn decode_captured_archives(
  base_id: &str,
  archives: &CapturedArchives,
) -> RepoResult<Vec<CapturedFeatureBundle>> {
  let mut budget = NestedArchiveBudget::with_aggregate_limit(archive_limits(), MAX_SOURCE_SET_EXPANDED_BYTES);
  decode_captured_archives_with_budget(base_id, archives, &mut budget)
}

/// The complete selected/retained source set has one expansion/entry bound,
/// including nested native document payloads, regardless of compression ratio.
pub(super) fn decode_captured_archives_with_budget(
  base_id: &str,
  archives: &CapturedArchives,
  budget: &mut NestedArchiveBudget,
) -> RepoResult<Vec<CapturedFeatureBundle>> {
  let mut ordered = archives.values().collect::<Vec<_>>();
  // Retained platform versions precede extensions, independently of offering order.
  ordered.sort_by_key(|(pin, _)| pin.id != base_id);
  let mut bundles = Vec::new();
  for (pin, bytes) in ordered {
    let bundle = read_feature_bundle_with_budget(bytes, &bundles, budget)?;
    if bundle.pin() != *pin {
      return Err(invalid(format!(
        "Feature archive identity mismatch: {} {}",
        pin.id, pin.version
      )));
    }
    bundles.push(bundle);
  }
  Ok(bundles)
}
