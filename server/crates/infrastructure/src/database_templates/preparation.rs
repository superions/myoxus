// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native installed-pin retention and no-downgrade checks, independent of delivery.
use super::capture::capture_sources;
use myoxus_application::database::DatabaseStarterTemplateCatalog;
use myoxus_domain::{
  database::DatabaseTemplateCatalogSource,
  repositories::{RepoResult, RepositoryError},
};
use std::{collections::BTreeSet, path::Path};

/// Checks a prepared release against the installed pointer without changing files.
/// Existing definitions and Update pins remain retained; preparation cannot downgrade a
/// starter. This is release-file admission, not an instance migration policy.
pub fn validate_database_template_preparation(
  candidate_root: &Path,
  installed_root: &Path,
) -> myoxus_domain::repositories::RepoResult<()> {
  fn validated_source(root: &Path) -> Result<DatabaseTemplateCatalogSource, RepositoryError> {
    let (source, definitions, updates) = capture_sources(root)?;
    DatabaseStarterTemplateCatalog::from_sources(source.clone(), definitions, updates).map_err(|error| {
      RepositoryError::Storage(format!("Database template {}/catalog.yaml: {error}", root.display()))
    })?;
    Ok(source)
  }
  let candidate = validated_source(candidate_root)?;
  // Installed promotion metadata may precede the current authoring fields.
  // Read only its bounded pin inventory using the same typed decoder; never
  // publish or infer runtime defaults from that inventory. The admitted
  // candidate validates every exact retained artifact below.
  let (installed, _, _) = capture_sources(installed_root)?;
  validate_database_template_source_preparation(&candidate, &installed)
}

/// Compares decoded native inventories; it neither opens files nor publishes a pointer.
/// The candidate must already have passed complete Application catalog admission.
pub fn validate_database_template_source_preparation(
  candidate: &DatabaseTemplateCatalogSource,
  installed: &DatabaseTemplateCatalogSource,
) -> RepoResult<()> {
  if installed.format_version != 1 {
    return Err(RepositoryError::Validation(
      "invalid installed Database catalog format".into(),
    ));
  }
  let mut installed_ids = BTreeSet::new();
  for existing in &installed.templates {
    if !installed_ids.insert(&existing.id)
      || !existing
        .definitions
        .iter()
        .any(|reference| reference.version == existing.current)
    {
      return Err(RepositoryError::Validation(
        "invalid installed Database pin inventory".into(),
      ));
    }
    let next = candidate
      .templates
      .iter()
      .find(|entry| entry.id == existing.id)
      .ok_or_else(|| {
        RepositoryError::Validation(format!(
          "Database template preparation omits installed starter {}",
          existing.id
        ))
      })?;
    if myoxus_application::database::definition::templates::compare_template_versions(&next.current, &existing.current)
      .map_err(RepositoryError::Validation)?
      .is_lt()
    {
      return Err(RepositoryError::Validation(format!(
        "Database template preparation refuses downgrade for {}: {} to {}",
        existing.id, existing.current, next.current
      )));
    }
    for update in &existing.updates {
      if !next.updates.iter().any(|reference| {
        reference.from == update.from
          && reference.to == update.to
          && reference.path == update.path
          && reference.sha256 == update.sha256
      }) {
        return Err(RepositoryError::Validation(format!(
          "Database template preparation must retain immutable installed update {} {} to {}",
          existing.id, update.from, update.to
        )));
      }
    }
    for current in &existing.definitions {
      if !next.definitions.iter().any(|reference| {
        reference.version == current.version
          && reference.path == current.path
          && reference.sha256 == current.sha256
          && current.selections.iter().all(|previous| {
            reference
              .selections
              .iter()
              .any(|selection| selection.input == previous.input && selection.variant == previous.variant)
          })
      }) {
        return Err(RepositoryError::Validation(format!(
          "Database template preparation must retain immutable installed definition {} {}",
          existing.id, current.version
        )));
      }
    }
  }
  Ok(())
}
