// SPDX-License-Identifier: AGPL-3.0-or-later
//! Capture a complete publication set before its delivery owner activates it.
use super::source_set::{
  CapturedArchives, capture_archive, capture_catalog_archives, catalog_pins, decode_captured_archives, explicit_file,
};
use crate::template_files::{decode_yaml, read_confined_file};
use myoxus_application::feature_bundle::{
  CapturedFeatureBundle, ResolvedFeatureCatalogs, canonical_feature_path, prepare_feature_release_catalog,
  validate_feature_release_candidate,
};
use myoxus_contracts::config_document::encode_config_yaml;
use myoxus_domain::{
  feature_bundle::{FeatureBundleCatalogSource, FeatureReleaseDescriptor},
  repositories::{RepoResult, RepositoryError},
};
use std::{collections::BTreeMap, io::Write, path::Path};

pub struct PreparedFeatureSourceSet {
  pub release_bytes: Vec<u8>,
  pub catalog_bytes: Vec<u8>,
  /// Root-relative immutable archive paths; the catalog is the sole active pointer.
  pub archives: BTreeMap<String, Vec<u8>>,
  pub resolved: ResolvedFeatureCatalogs,
}

fn invalid(message: impl Into<String>) -> RepositoryError {
  RepositoryError::Validation(message.into())
}
fn storage(error: std::io::Error) -> RepositoryError {
  RepositoryError::Storage(format!("Feature preparation: {error}"))
}
fn read_catalog(root: &Path) -> RepoResult<FeatureBundleCatalogSource> {
  decode_yaml(&read_confined_file(
    root,
    "features/catalog.yaml",
    4 * 1024 * 1024,
    "Feature preparation",
  )?)
  .map_err(invalid)
}
fn selected_bundles(
  catalog: &FeatureBundleCatalogSource,
  decoded: &[CapturedFeatureBundle],
) -> RepoResult<Vec<CapturedFeatureBundle>> {
  catalog_pins(catalog)?
    .into_iter()
    .map(|pin| {
      decoded
        .iter()
        .find(|bundle| bundle.pin() == *pin)
        .cloned()
        .ok_or_else(|| invalid(format!("missing captured Feature archive: {} {}", pin.id, pin.version)))
    })
    .collect()
}

/// Sources are captured once while the caller holds its publication lock.
/// Composition and native admission use only captured bytes; no SQL or native
/// instance effects participate in this filesystem preparation boundary.
pub fn prepare_feature_source_set(
  candidate_root: &Path,
  installed_root: Option<&Path>,
  release_manifest: &Path,
  optional_catalog: Option<&Path>,
) -> RepoResult<PreparedFeatureSourceSet> {
  let release_bytes = explicit_file(release_manifest)?;
  let release: FeatureReleaseDescriptor = decode_yaml(&release_bytes).map_err(invalid)?;
  let candidate_root = candidate_root.canonicalize().map_err(storage)?;
  let source = read_catalog(&candidate_root)?;
  let installed_root = installed_root
    .map(|root| root.canonicalize().map_err(storage))
    .transpose()?;
  let installed = installed_root.as_deref().map(read_catalog).transpose()?;
  let explicit = optional_catalog
    .map(|path| {
      explicit_file(path).and_then(|bytes| decode_yaml::<FeatureBundleCatalogSource>(&bytes).map_err(invalid))
    })
    .transpose()?;
  let catalog =
    prepare_feature_release_catalog(&release, &source, installed.as_ref(), explicit.as_ref()).map_err(invalid)?;
  let mut archives = CapturedArchives::new();
  let mut total = 0usize;
  // Capture only the selected providers. Installed history and unselected source
  // suggestions are not dependencies of this release.
  for pin in catalog_pins(&catalog)? {
    let root = if pin == &catalog.base || catalog_pins(&source)?.contains(&pin) {
      candidate_root.as_path()
    } else if installed
      .as_ref()
      .is_some_and(|installed| installed.optional.contains(pin))
    {
      installed_root
        .as_deref()
        .ok_or_else(|| invalid("installed Feature root missing"))?
    } else {
      candidate_root.as_path()
    };
    capture_archive(root, pin, &mut archives, &mut total)?;
  }
  let decoded = decode_captured_archives(&release.base.id, &archives)?;
  let candidate = selected_bundles(&catalog, &decoded)?;
  // Compare with the installed active providers only. Superseded wrappers are
  // neither read nor republished, and do not consume the candidate's ZIP budget.
  let mut installed = installed;
  if let Some(installed) = installed.as_mut() {
    installed.retained.clear();
  }
  let previous = installed
    .as_ref()
    .map(|catalog| {
      let root = installed_root
        .as_deref()
        .ok_or_else(|| invalid("installed Feature root missing"))?;
      let archives = capture_catalog_archives(root, catalog)?;
      decode_captured_archives(&catalog.base.id, &archives)
    })
    .transpose()?;
  // Installed base identity comes from its one active catalog, never a second
  // mutable release.yaml pointer. The candidate pin remains artifact-owned.
  let previous_release = installed.as_ref().map(|catalog| FeatureReleaseDescriptor {
    format_version: 1,
    base: catalog.base.clone(),
  });
  let previous_inputs = previous_release
    .as_ref()
    .zip(installed.as_ref())
    .zip(previous.as_ref())
    .map(|((release, catalog), bundles)| (release, catalog, bundles.as_slice()));
  let resolved =
    validate_feature_release_candidate(&release, &catalog, &candidate, previous_inputs).map_err(invalid)?;
  let catalog_bytes = encode_config_yaml(&catalog)
    .map_err(|error| invalid(error.to_string()))?
    .into_bytes();
  let archives = publication_archives(&catalog, archives)?;
  Ok(PreparedFeatureSourceSet {
    release_bytes,
    catalog_bytes,
    archives,
    resolved,
  })
}

fn publication_archives(
  catalog: &FeatureBundleCatalogSource,
  mut captured: CapturedArchives,
) -> RepoResult<BTreeMap<String, Vec<u8>>> {
  catalog_pins(catalog)?
    .into_iter()
    .map(|pin| {
      let (_, bytes) = captured
        .remove(&(pin.id.clone(), pin.version.clone()))
        .ok_or_else(|| invalid("publication archive missing after admission"))?;
      Ok((format!("features/{}", pin.archive_path()), bytes))
    })
    .collect()
}

/// Write only a fresh private directory. Publication/ownership and the final
/// atomic catalog rename belong to the locked delivery caller, not this writer.
pub fn write_prepared_feature_source_set(prepared: &PreparedFeatureSourceSet, prepared_root: &Path) -> RepoResult<()> {
  let absolute = std::path::absolute(prepared_root).map_err(storage)?;
  for ancestor in absolute.ancestors() {
    match std::fs::symlink_metadata(ancestor) {
      Ok(metadata) if metadata.file_type().is_symlink() => {
        return Err(invalid("prepared output path contains a symlink"));
      }
      Ok(_) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(storage(error)),
    }
  }
  if absolute.exists() {
    if std::fs::read_dir(&absolute).map_err(storage)?.next().is_some() {
      return Err(invalid("prepared output must be a fresh empty directory"));
    }
  } else {
    std::fs::create_dir(&absolute).map_err(storage)?;
  }
  let write = |relative: &str, bytes: &[u8]| -> RepoResult<()> {
    if !canonical_feature_path(relative) || !relative.starts_with("features/") {
      return Err(invalid("invalid prepared output path"));
    }
    let path = absolute.join(relative);
    std::fs::create_dir_all(path.parent().ok_or_else(|| invalid("prepared output parent missing"))?)
      .map_err(storage)?;
    let mut file = std::fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(path)
      .map_err(storage)?;
    file.write_all(bytes).map_err(storage)
  };
  for (path, bytes) in &prepared.archives {
    write(path, bytes)?;
  }
  write("features/release.yaml", &prepared.release_bytes)?;
  write("features/catalog.yaml", &prepared.catalog_bytes)
}
