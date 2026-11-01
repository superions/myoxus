// SPDX-License-Identifier: AGPL-3.0-or-later
//! Confined named-byte capture and native Application catalog admission.
use super::decode::{decode_assistant_package_catalog, decode_with_diagnostics};
use crate::template_files::Capture;
use myoxus_application::database::DatabaseStarterTemplateCatalog;
use myoxus_application::workspace::assistant_packages::{AssistantPackageCatalog, AssistantPackageSourcePort};
use myoxus_domain::assistant_package::{AssistantPackageCatalogSource, AssistantPackageSource};
use myoxus_domain::repositories::RepositoryError;
use std::{
  collections::BTreeMap,
  path::{Path, PathBuf},
  sync::Arc,
};

pub struct FilesystemAssistantPackageSource {
  root: PathBuf,
  templates: Arc<DatabaseStarterTemplateCatalog>,
}
impl FilesystemAssistantPackageSource {
  pub fn new(root: PathBuf, templates: Arc<DatabaseStarterTemplateCatalog>) -> Self {
    Self { root, templates }
  }
}
impl AssistantPackageSourcePort for FilesystemAssistantPackageSource {
  fn capture(&self) -> Result<AssistantPackageCatalog, String> {
    load_assistant_package_catalog(&self.root, &self.templates).map_err(|error| error.to_string())
  }
}
pub fn load_assistant_package_catalog(
  root: &Path,
  templates: &DatabaseStarterTemplateCatalog,
) -> Result<AssistantPackageCatalog, RepositoryError> {
  let (source, definitions) = capture_sources(root)?;
  AssistantPackageCatalog::from_sources(source, definitions, templates).map_err(|message| {
    RepositoryError::Storage(format!("Assistant package {}/catalog.yaml: {message}", root.display()))
  })
}
fn capture_named_files(
  capture: &mut Capture,
  catalog_path: &str,
) -> Result<BTreeMap<String, Vec<u8>>, RepositoryError> {
  let prefix = catalog_path
    .strip_suffix("catalog.yaml")
    .filter(|prefix| prefix.is_empty() || prefix.ends_with('/'))
    .ok_or_else(|| capture.error(catalog_path, "native catalog root must be catalog.yaml"))?;
  let bytes = capture.read(catalog_path)?;
  let source = decode_assistant_package_catalog(&bytes).map_err(|message| capture.error(catalog_path, &message))?;
  let mut files = BTreeMap::from([("catalog.yaml".into(), bytes)]);
  for entry in &source.packages {
    for reference in &entry.definitions {
      files.insert(
        reference.path.clone(),
        capture.read(&format!("{prefix}{}", reference.path))?,
      );
    }
  }
  Ok(files)
}

pub fn capture_assistant_package_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, RepositoryError> {
  capture_assistant_package_files_at(root, "catalog.yaml")
}

pub fn capture_assistant_package_files_at(
  root: &Path,
  catalog_path: &str,
) -> Result<BTreeMap<String, Vec<u8>>, RepositoryError> {
  capture_named_files(&mut Capture::new(root, "Assistant package")?, catalog_path)
}

pub(super) fn capture_sources(
  root: &Path,
) -> Result<(AssistantPackageCatalogSource, Vec<(AssistantPackageSource, String)>), RepositoryError> {
  let mut capture = Capture::new(root, "Assistant package")?;
  let files = capture_named_files(&mut capture, "catalog.yaml")?;
  decode_with_diagnostics(&files, |path, message| capture.error(path, message))
}
