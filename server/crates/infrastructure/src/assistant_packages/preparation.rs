// SPDX-License-Identifier: AGPL-3.0-or-later
//! Immutable retention and monotonic source promotion, independent of delivery.
use super::capture::capture_sources;
use myoxus_application::{
  database::DatabaseStarterTemplateCatalog, workspace::assistant_packages::AssistantPackageCatalog,
};
use myoxus_domain::{
  assistant_package::AssistantPackageCatalogSource,
  repositories::{RepoResult, RepositoryError},
};
use std::path::Path;

/// Check immutable retention and monotonic source promotion without writing.
pub fn validate_assistant_template_preparation(
  release_root: &Path,
  installed_root: &Path,
  templates: &DatabaseStarterTemplateCatalog,
) -> Result<(), RepositoryError> {
  fn admitted(
    root: &Path,
    templates: &DatabaseStarterTemplateCatalog,
  ) -> Result<AssistantPackageCatalogSource, RepositoryError> {
    let (source, definitions) = capture_sources(root)?;
    AssistantPackageCatalog::from_sources(source.clone(), definitions, templates).map_err(|message| {
      RepositoryError::Storage(format!("Assistant package {}/catalog.yaml: {message}", root.display()))
    })?;
    Ok(source)
  }
  let candidate = admitted(release_root, templates)?;
  let installed = admitted(installed_root, templates)?;
  validate_assistant_package_source_preparation(&candidate, &installed)
}

/// Compares decoded native pins without reopening paths or publishing a catalog.
/// Both inventories must already have passed native Application admission.
pub fn validate_assistant_package_source_preparation(
  candidate: &AssistantPackageCatalogSource,
  installed: &AssistantPackageCatalogSource,
) -> RepoResult<()> {
  for existing in &installed.packages {
    let next = candidate
      .packages
      .iter()
      .find(|entry| entry.id == existing.id)
      .ok_or_else(|| {
        RepositoryError::Validation(format!("Assistant preparation omits installed package {}", existing.id))
      })?;
    if myoxus_application::database::definition::templates::compare_template_versions(&next.current, &existing.current)
      .map_err(RepositoryError::Validation)?
      .is_lt()
    {
      return Err(RepositoryError::Validation(format!(
        "Assistant preparation refuses downgrade for {}",
        existing.id
      )));
    }
    for reference in &existing.definitions {
      if !next.definitions.iter().any(|retained| {
        retained.version == reference.version && retained.path == reference.path && retained.sha256 == reference.sha256
      }) {
        return Err(RepositoryError::Validation(format!(
          "Assistant preparation must retain immutable package {} {}",
          existing.id, reference.version
        )));
      }
    }
  }
  Ok(())
}
