// SPDX-License-Identifier: AGPL-3.0-or-later
//! Confined filesystem capture; native decoding does not reopen captured paths.
use super::decode::decode_with_diagnostics;
use crate::template_files::{Capture, verify_sha256};
use myoxus_application::database::{DatabaseStarterTemplateCatalog, DatabaseStarterTemplateSource};
use myoxus_domain::{database::*, repositories::RepositoryError};
use std::{collections::BTreeMap, path::Path};

/// Reads only the configured root. No SQL writes or checkout fallback occur.
/// Every retained version and pinned Task core is checked before returning.
pub fn load_database_template_catalog(root: &Path) -> Result<DatabaseStarterTemplateCatalog, RepositoryError> {
  FilesystemDatabaseTemplateSource::new(root.to_path_buf())
    .capture()
    .map_err(RepositoryError::Storage)
}

/// A startup source owns a configured root, never an SQL connection or a watcher.
pub struct FilesystemDatabaseTemplateSource {
  root: std::path::PathBuf,
}
impl FilesystemDatabaseTemplateSource {
  pub fn new(root: std::path::PathBuf) -> Self {
    Self { root }
  }
}
impl DatabaseStarterTemplateSource for FilesystemDatabaseTemplateSource {
  fn capture(&self) -> Result<DatabaseStarterTemplateCatalog, String> {
    let (source, definitions, updates) = capture_sources(&self.root).map_err(|error| error.to_string())?;
    DatabaseStarterTemplateCatalog::from_sources(source, definitions, updates)
      .map_err(|error| format!("Database template {}/catalog.yaml: {error}", self.root.display()))
  }
}

/// Captures only the native declared closure, with names relative to its catalog.
pub fn capture_database_template_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, RepositoryError> {
  capture_database_template_files_at(root, "catalog.yaml", |_, _| Ok(None))
}

/// Feature sources retain one enclosing root even for nested native catalogs.
/// The typed provider may supply only an explicitly pinned external Task core.
pub fn capture_database_template_files_at(
  root: &Path,
  catalog_path: &str,
  mut task_core: impl FnMut(
    &DatabaseTemplateDefinitionSource,
    &DatabaseTemplateCoreReference,
  ) -> Result<Option<Vec<u8>>, RepositoryError>,
) -> Result<BTreeMap<String, Vec<u8>>, RepositoryError> {
  let mut capture = Capture::new(root, "Database template")?;
  capture_named_files(&mut capture, catalog_path, &mut task_core)
}

#[cfg(test)]
pub(super) use capture_database_template_files as capture_files;

fn capture_named_files(
  capture: &mut Capture,
  catalog_path: &str,
  task_core: &mut impl FnMut(
    &DatabaseTemplateDefinitionSource,
    &DatabaseTemplateCoreReference,
  ) -> Result<Option<Vec<u8>>, RepositoryError>,
) -> Result<BTreeMap<String, Vec<u8>>, RepositoryError> {
  let prefix = catalog_path
    .strip_suffix("catalog.yaml")
    .filter(|prefix| prefix.is_empty() || prefix.ends_with('/'))
    .ok_or_else(|| capture.error(catalog_path, "native catalog root must be catalog.yaml"))?;
  let bytes = capture.read(catalog_path)?;
  let source: DatabaseTemplateCatalogSource = capture.decode(catalog_path, &bytes)?;
  let mut files = BTreeMap::from([("catalog.yaml".into(), bytes)]);
  for entry in &source.templates {
    for reference in &entry.definitions {
      let path = format!("{prefix}{}", reference.path);
      let bytes = capture.read(&path)?;
      verify_sha256(&bytes, &reference.sha256).map_err(|message| capture.error(&path, &message))?;
      let definition: DatabaseTemplateDefinitionSource = capture.decode(&path, &bytes)?;
      files.insert(reference.path.clone(), bytes);
      if let Some(core) = &definition.task_core {
        let path = format!("{prefix}{}", core.path);
        let provided = task_core(&definition, core)?;
        let bytes = if let Some(bytes) = provided {
          if let Some(local) = capture.read_optional(&path)? {
            if local != bytes {
              return Err(capture.error(&path, "local Task core differs from pinned platform source"));
            }
          }
          bytes
        } else {
          capture.read(&path)?
        };
        files.insert(core.path.clone(), bytes);
      }
    }
    for reference in &entry.updates {
      let path = format!("{prefix}{}", reference.path);
      let bytes = capture.read(&path)?;
      verify_sha256(&bytes, &reference.sha256).map_err(|message| capture.error(&path, &message))?;
      files.insert(reference.path.clone(), bytes);
    }
  }
  Ok(files)
}

pub(super) fn capture_sources(
  root: &Path,
) -> Result<
  (
    DatabaseTemplateCatalogSource,
    Vec<DatabaseTemplateDefinitionSource>,
    Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
  ),
  RepositoryError,
> {
  let mut capture = Capture::new(root, "Database template")?;
  let files = capture_named_files(&mut capture, "catalog.yaml", &mut |_, _| Ok(None))?;
  decode_with_diagnostics(&files, |path, message| capture.error(path, message))
}
