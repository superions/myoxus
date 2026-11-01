// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded archive admission projects captured bytes into existing native decoders.
use crate::{
  assistant_packages::{decode_assistant_package_catalog, decode_assistant_package_sources},
  database_templates::decode_database_template_sources_with_core_provider,
  template_files::{decode_yaml, read_confined_file},
};
use myoxus_application::{
  feature_bundle::{
    CapturedFeatureBundle, FeatureAssistantSources, FeatureDatabaseSources, canonical_feature_path,
    resolve_feature_task_core, validate_feature_manifest,
  },
  template_registry::bundle::{
    NestedArchiveBudget, TemplateBundleZipLimits, TemplateInputFormat, ValidationSeverity, parse_bundle_with_limits,
    validate_content_checksum, validate_manifest,
  },
};
use myoxus_domain::{
  database::{DatabaseTemplateCatalogSource, DatabaseTemplateTaskCore},
  feature_bundle::*,
  repositories::{RepoResult, RepositoryError},
};
use sha2::{Digest, Sha256};
use std::{
  collections::{BTreeMap, BTreeSet},
  io::{Cursor, Read},
  path::Path,
};

pub(super) fn invalid(path: &str, message: impl std::fmt::Display) -> RepositoryError {
  RepositoryError::Validation(format!("Feature Bundle {path}: {message}"))
}
pub(super) fn archive_limits() -> TemplateBundleZipLimits {
  TemplateBundleZipLimits {
    max_entries: 4096,
    ..TemplateBundleZipLimits::default()
  }
}
/// Read an explicit archive path through the same nonblocking regular-file
/// boundary as source capture; directories, FIFOs and symlinks fail closed.
pub fn read_feature_bundle_file(path: &Path, platform: &[CapturedFeatureBundle]) -> RepoResult<CapturedFeatureBundle> {
  let absolute = std::path::absolute(path).map_err(|error| invalid("archive", error))?;
  let filename = absolute
    .file_name()
    .and_then(|name| name.to_str())
    .filter(|name| canonical_feature_path(name))
    .ok_or_else(|| invalid("archive", "expected a normal archive filename"))?;
  let parent = absolute
    .parent()
    .ok_or_else(|| invalid("archive", "archive parent missing"))?;
  for ancestor in absolute.ancestors() {
    let metadata = std::fs::symlink_metadata(ancestor).map_err(|error| invalid(filename, error))?;
    if metadata.file_type().is_symlink() {
      return Err(invalid(filename, "archive path contains a symlink"));
    }
  }
  let root = parent.canonicalize().map_err(|error| invalid(filename, error))?;
  let bytes = read_confined_file(&root, filename, 200 * 1024 * 1024, "Feature Bundle")?;
  read_feature_bundle_with_platform(&bytes, platform)
}

pub fn read_feature_bundle(bytes: &[u8]) -> RepoResult<CapturedFeatureBundle> {
  read_feature_bundle_with_platform(bytes, &[])
}

/// Platform inputs are already captured pins. Only an explicit native TaskCore
/// link may add their bytes to a Database decoder's private namespace.
pub fn read_feature_bundle_with_platform(
  bytes: &[u8],
  platform: &[CapturedFeatureBundle],
) -> RepoResult<CapturedFeatureBundle> {
  let mut budget = NestedArchiveBudget::new(archive_limits());
  read_feature_bundle_with_budget(bytes, platform, &mut budget)
}

/// Source-set decoding shares this budget across wrappers and every native ZIP
/// layer. Standalone archive callers retain their own independent budget.
pub(super) fn read_feature_bundle_with_budget(
  bytes: &[u8],
  platform: &[CapturedFeatureBundle],
  budget: &mut NestedArchiveBudget,
) -> RepoResult<CapturedFeatureBundle> {
  if bytes.is_empty() || bytes.len() > 200 * 1024 * 1024 {
    return Err(invalid("archive", "archive byte limit exceeded"));
  }
  let index = budget.account(bytes).map_err(|error| invalid("archive", error))?;
  let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| invalid("archive", error))?;
  let mut files = BTreeMap::new();
  // The shared inspector rejects aliases/case-folded duplicates and symlinks.
  // Require the raw spelling too, so by-name access can never resolve an alias.
  for i in 0..archive.len() {
    let mut member = archive.by_index(i).map_err(|error| invalid("archive", error))?;
    let name = member.name().map_err(|error| invalid("archive", error))?.into_owned();
    if member.is_dir()
      || member
        .unix_mode()
        .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000))
      || !canonical_feature_path(&name)
      || !index.entries.iter().any(|entry| entry.name == name && !entry.directory)
    {
      return Err(invalid(&name, "noncanonical or non-file ZIP member"));
    }
    let mut content = Vec::new();
    member
      .by_ref()
      .take(50 * 1024 * 1024 + 1)
      .read_to_end(&mut content)
      .map_err(|error| invalid(&name, error))?;
    if content.len() as u64 != member.size() || content.len() > 50 * 1024 * 1024 {
      return Err(invalid(&name, "entry byte limit or size mismatch"));
    }
    if files.insert(name.clone(), content).is_some() {
      return Err(invalid(&name, "duplicate ZIP member"));
    }
  }
  let manifest_bytes = files
    .remove("manifest.yaml")
    .ok_or_else(|| invalid("manifest.yaml", "manifest missing"))?;
  if manifest_bytes.len() > 4 * 1024 * 1024 {
    return Err(invalid("manifest.yaml", "manifest byte limit exceeded"));
  }
  let manifest: FeatureBundleManifest =
    decode_yaml(&manifest_bytes).map_err(|error| invalid("manifest.yaml", error))?;
  validate_feature_manifest(&manifest, &files).map_err(|error| invalid("manifest.yaml", error))?;
  let mut used = BTreeSet::new();
  let mut databases = BTreeMap::new();
  let mut assistants = BTreeMap::new();
  let mut workflows = BTreeMap::new();
  let mut documents: BTreeMap<String, FeatureBundleIdentity> = BTreeMap::new();
  for component in &manifest.components {
    let component_bytes = payload(&files, &component.path, &mut used)?;
    match component.kind {
      FeatureComponentKind::DatabaseCatalog => {
        let prefix = catalog_prefix(&component.path)?;
        let source: DatabaseTemplateCatalogSource =
          decode_yaml(component_bytes).map_err(|error| invalid(&component.path, error))?;
        let mut namespace = BTreeMap::from([("catalog.yaml".into(), component_bytes.to_vec())]);
        for entry in &source.templates {
          for reference in &entry.definitions {
            let path = format!("{prefix}{}", reference.path);
            let bytes = payload(&files, &path, &mut used)?;
            namespace.insert(reference.path.clone(), bytes.to_vec());
          }
          for reference in &entry.updates {
            let path = format!("{prefix}{}", reference.path);
            let bytes = payload(&files, &path, &mut used)?;
            namespace.insert(reference.path.clone(), bytes.to_vec());
          }
        }
        let (catalog, definitions, updates) =
          decode_database_template_sources_with_core_provider(&namespace, |definition, core| {
            let path = format!("{prefix}{}", core.path);
            let provided = resolve_feature_task_core(
              &manifest.links,
              &component.id,
              &definition.id,
              &definition.version,
              core,
              platform,
            )
            .map_err(|error| invalid(&path, error))?;
            match (files.get(&path), provided) {
              (Some(local), Some(provided)) => {
                if local != &provided {
                  return Err(invalid(&path, "local Task core differs from pinned platform source"));
                }
                used.insert(path);
                Ok(local.clone())
              }
              (None, Some(provided)) => Ok(provided),
              (Some(local), None) => {
                used.insert(path);
                Ok(local.clone())
              }
              (None, None) => Err(invalid(
                &path,
                "native Task core is missing and has no pinned platform dependency",
              )),
            }
          })
          .map_err(|error| invalid(&component.path, error))?;
        databases.insert(
          component.id.clone(),
          FeatureDatabaseSources {
            catalog,
            definitions,
            updates,
          },
        );
      }
      FeatureComponentKind::AssistantCatalog => {
        let prefix = catalog_prefix(&component.path)?;
        let source =
          decode_assistant_package_catalog(component_bytes).map_err(|error| invalid(&component.path, error))?;
        let mut namespace = BTreeMap::from([("catalog.yaml".into(), component_bytes.to_vec())]);
        for entry in &source.packages {
          for reference in &entry.definitions {
            let path = format!("{prefix}{}", reference.path);
            namespace.insert(reference.path.clone(), payload(&files, &path, &mut used)?.to_vec());
          }
        }
        let (catalog, definitions) =
          decode_assistant_package_sources(&namespace).map_err(|error| invalid(&component.path, error))?;
        assistants.insert(component.id.clone(), FeatureAssistantSources { catalog, definitions });
      }
      FeatureComponentKind::TaskCore => {
        if component_bytes.len() > 4 * 1024 * 1024 {
          return Err(invalid(&component.path, "native Task core byte limit exceeded"));
        }
        let core: DatabaseTemplateTaskCore =
          decode_yaml(component_bytes).map_err(|error| invalid(&component.path, error))?;
        if core.format_version != 1
          || component.native_identity.as_ref()
            != Some(&FeatureBundleIdentity {
              id: core.id,
              version: core.version,
            })
        {
          return Err(invalid(&component.path, "native Task core identity/version mismatch"));
        }
      }
      FeatureComponentKind::DocumentTemplate => {
        let identity = if let Some(identity) = documents.get(&component.path) {
          identity.clone()
        } else {
          let identity = document_identity(component_bytes, &component.path, budget)?;
          documents.insert(component.path.clone(), identity.clone());
          identity
        };
        if component.native_identity.as_ref() != Some(&identity) {
          return Err(invalid(&component.path, "native document identity/version mismatch"));
        }
      }
      FeatureComponentKind::Workflow => {
        if component_bytes.len() > 4 * 1024 * 1024 {
          return Err(invalid(&component.path, "native workflow byte limit exceeded"));
        }
        let workflow: myoxus_domain::assistant_package::AssistantWorkflowSource =
          decode_yaml(component_bytes).map_err(|error| invalid(&component.path, error))?;
        myoxus_application::feature_bundle::validate_assistant_workflow_source(&workflow)
          .map_err(|error| invalid(&component.path, error))?;
        if component
          .native_identity
          .as_ref()
          .is_none_or(|identity| identity.id != workflow.id || identity.version != workflow.version)
        {
          return Err(invalid(&component.path, "native workflow identity mismatch"));
        }
        workflows.insert(component.id.clone(), workflow);
      }
      FeatureComponentKind::Artwork => {}
    }
  }
  if let Some(path) = files.keys().find(|path| !used.contains(*path)) {
    return Err(invalid(path, "undeclared native closure member"));
  }
  Ok(CapturedFeatureBundle {
    manifest,
    archive_sha256: format!("{:x}", Sha256::digest(bytes)),
    archive_bytes: bytes.to_vec(),
    files,
    databases,
    assistants,
    workflows,
  })
}
fn payload<'a>(files: &'a BTreeMap<String, Vec<u8>>, path: &str, used: &mut BTreeSet<String>) -> RepoResult<&'a [u8]> {
  if !canonical_feature_path(path) {
    return Err(invalid(path, "noncanonical native file reference"));
  }
  let bytes = files
    .get(path)
    .ok_or_else(|| invalid(path, "declared native file missing"))?;
  used.insert(path.into());
  Ok(bytes)
}
pub(super) fn catalog_prefix(path: &str) -> RepoResult<&str> {
  path
    .strip_suffix("catalog.yaml")
    .filter(|prefix| prefix.is_empty() || prefix.ends_with('/'))
    .ok_or_else(|| invalid(path, "native catalog component root must be catalog.yaml"))
}
pub(super) fn document_identity(
  bytes: &[u8],
  path: &str,
  budget: &mut NestedArchiveBudget,
) -> RepoResult<FeatureBundleIdentity> {
  budget.account(bytes).map_err(|error| invalid(path, error))?;
  let parsed = parse_bundle_with_limits(bytes, archive_limits()).map_err(|error| invalid(path, error))?;
  if parsed.format != TemplateInputFormat::TemplateBundle {
    return Err(invalid(
      path,
      "document component requires a canonical native TemplateBundle",
    ));
  }
  if let Some(error) = validate_manifest(&parsed.manifest)
    .into_iter()
    .find(|error| matches!(error.severity, ValidationSeverity::Error))
  {
    return Err(invalid(path, error.message));
  }
  validate_content_checksum(&parsed.manifest, &parsed.content_checksum)
    .map_err(|error| invalid(path, error.message))?;
  for content in std::iter::once(&parsed.content_bytes).chain(parsed.localized_contents.values()) {
    if content.starts_with(b"PK") {
      budget.account(content).map_err(|error| invalid(path, error))?;
    }
  }
  Ok(FeatureBundleIdentity {
    id: parsed.manifest.template_id,
    version: parsed.manifest.version,
  })
}
