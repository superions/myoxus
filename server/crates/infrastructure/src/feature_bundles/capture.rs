// SPDX-License-Identifier: AGPL-3.0-or-later
//! Capture explicit authoring roots; packing never searches a checkout or copies providers.
use super::{
  archive::{archive_limits, catalog_prefix, document_identity, invalid},
  pack::pack_captured_feature_bundle,
  read_feature_bundle_with_platform,
};
use crate::{
  assistant_packages::capture_assistant_package_files_at,
  database_templates::capture_database_template_files_at,
  template_files::{decode_yaml, read_confined_file},
};
use myoxus_application::{
  feature_bundle::{CapturedFeatureBundle, MAX_FEATURE_COMPONENTS, canonical_feature_path, resolve_feature_task_core},
  template_registry::bundle::NestedArchiveBudget,
};
use myoxus_domain::{database::DatabaseTemplateTaskCore, feature_bundle::*, repositories::RepoResult};
use sha2::{Digest, Sha256};
use std::{
  collections::{BTreeMap, BTreeSet},
  path::Path,
};

/// Read one explicit authoring file through native capture's regular-file,
/// symlink and byte boundary. The caller owns the aggregate candidate budget.
pub fn read_feature_source_file(root: &Path, relative: &str, max_bytes: usize) -> RepoResult<Vec<u8>> {
  if !canonical_feature_path(relative) {
    return Err(invalid(relative, "noncanonical authoring file path"));
  }
  let root = root.canonicalize().map_err(|error| invalid(relative, error))?;
  read_confined_file(&root, relative, max_bytes, "Feature Bundle")
}

pub fn capture_feature_source(root: &Path, manifest_path: &str) -> RepoResult<CapturedFeatureBundle> {
  capture_feature_source_with_platform(root, manifest_path, &[])
}

/// Every local payload belongs to the explicit root. Platform cores enter only
/// the native decoder namespace and never become locally owned archive members.
pub fn capture_feature_source_with_platform(
  root: &Path,
  manifest_path: &str,
  platform: &[CapturedFeatureBundle],
) -> RepoResult<CapturedFeatureBundle> {
  if !canonical_feature_path(manifest_path) || !manifest_path.ends_with(".yaml") {
    return Err(invalid(manifest_path, "noncanonical source manifest path"));
  }
  let root = root.canonicalize().map_err(|error| invalid(manifest_path, error))?;
  let source_bytes = read_confined_file(&root, manifest_path, 4 * 1024 * 1024, "Feature Bundle")?;
  let source: FeatureBundleSource = decode_yaml(&source_bytes).map_err(|error| invalid(manifest_path, error))?;
  if source.components.is_empty() || source.components.len() > MAX_FEATURE_COMPONENTS {
    return Err(invalid(manifest_path, "invalid component count"));
  }
  let mut files = BTreeMap::new();
  let mut total = 0usize;
  for component in &source.components {
    if !canonical_feature_path(&component.path) {
      return Err(invalid(&component.path, "noncanonical component path"));
    }
    match component.kind {
      FeatureComponentKind::DatabaseCatalog => {
        let prefix = catalog_prefix(&component.path)?;
        let mut external = BTreeSet::new();
        let native = capture_database_template_files_at(&root, &component.path, |definition, core| {
          let bytes = resolve_feature_task_core(
            &source.links,
            &component.id,
            &definition.id,
            &definition.version,
            core,
            platform,
          )
          .map_err(|error| invalid(&component.path, error))?;
          if bytes.is_some() {
            external.insert(core.path.clone());
          }
          Ok(bytes)
        })
        .map_err(|error| invalid(&component.path, error))?;
        for (path, bytes) in native {
          if !external.contains(&path) {
            insert_file(&mut files, &mut total, format!("{prefix}{path}"), bytes)?;
          }
        }
      }
      FeatureComponentKind::AssistantCatalog => {
        let prefix = catalog_prefix(&component.path)?;
        for (path, bytes) in
          capture_assistant_package_files_at(&root, &component.path).map_err(|error| invalid(&component.path, error))?
        {
          insert_file(&mut files, &mut total, format!("{prefix}{path}"), bytes)?;
        }
      }
      FeatureComponentKind::TaskCore
      | FeatureComponentKind::DocumentTemplate
      | FeatureComponentKind::Artwork
      | FeatureComponentKind::Workflow => {
        let max_bytes = if matches!(
          component.kind,
          FeatureComponentKind::TaskCore | FeatureComponentKind::Workflow
        ) {
          4 * 1024 * 1024
        } else {
          50 * 1024 * 1024
        };
        let bytes = read_confined_file(&root, &component.path, max_bytes, "Feature Bundle")?;
        insert_file(&mut files, &mut total, component.path.clone(), bytes)?;
      }
    }
  }
  let mut budget = NestedArchiveBudget::new(archive_limits());
  let mut components = Vec::new();
  for component in source.components {
    let bytes = &files[&component.path];
    let native_identity = match component.kind {
      FeatureComponentKind::TaskCore => {
        let core: DatabaseTemplateTaskCore = decode_yaml(bytes).map_err(|error| invalid(&component.path, error))?;
        Some(FeatureBundleIdentity {
          id: core.id,
          version: core.version,
        })
      }
      FeatureComponentKind::DocumentTemplate => Some(document_identity(bytes, &component.path, &mut budget)?),
      FeatureComponentKind::Workflow => {
        let workflow: myoxus_domain::assistant_package::AssistantWorkflowSource =
          decode_yaml(bytes).map_err(|error| invalid(&component.path, error))?;
        Some(FeatureBundleIdentity {
          id: workflow.id,
          version: workflow.version,
        })
      }
      _ => None,
    };
    components.push(FeatureComponent {
      id: component.id,
      kind: component.kind,
      path: component.path,
      sha256: format!("{:x}", Sha256::digest(bytes)),
      native_identity,
      artwork: component.artwork,
    });
  }
  let manifest = FeatureBundleManifest {
    format_version: source.format_version,
    id: source.id,
    version: source.version,
    capabilities: source.capabilities,
    components,
    files: files
      .iter()
      .map(|(path, bytes)| (path.clone(), format!("{:x}", Sha256::digest(bytes))))
      .collect(),
    links: source.links,
    exports: source.exports,
  };
  let archive = pack_captured_feature_bundle(&manifest, &files)?;
  // Source and uploaded archives share closed-inventory, native decoding and
  // cumulative outer/child/content ZIP admission without reopening any path.
  read_feature_bundle_with_platform(&archive, platform)
}
fn insert_file(
  files: &mut BTreeMap<String, Vec<u8>>,
  total: &mut usize,
  path: String,
  bytes: Vec<u8>,
) -> RepoResult<()> {
  if !canonical_feature_path(&path) || path == "manifest.yaml" {
    return Err(invalid(&path, "noncanonical or reserved payload path"));
  }
  if let Some(existing) = files.get(&path) {
    if existing != &bytes {
      return Err(invalid(&path, "captured path changed or conflicting native ownership"));
    }
    return Ok(());
  }
  *total = total
    .checked_add(bytes.len())
    .ok_or_else(|| invalid(&path, "source byte size overflow"))?;
  if files.len() >= 4096 || bytes.is_empty() || bytes.len() > 50 * 1024 * 1024 || *total > 200 * 1024 * 1024 {
    return Err(invalid(&path, "source inventory size limit exceeded"));
  }
  files.insert(path, bytes);
  Ok(())
}
