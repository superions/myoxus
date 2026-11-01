// SPDX-License-Identifier: AGPL-3.0-or-later
//! Source-only authoring delegates decoding and admission to runtime owners.
use anyhow::{Context, bail};
use clap::Subcommand;
use myoxus_application::feature_bundle::{
  CapturedFeatureBundle, canonical_feature_path, validate_feature_native_sources, validate_feature_references,
};
use myoxus_application::{
  database::definition::templates::compare_template_versions,
  template_registry::bundle::{
    TemplateInputFormat, TemplatePurpose, ValidationSeverity, parse_bundle, validate_manifest,
  },
};
use myoxus_contracts::config_document::{ConfigDocumentFormat, decode_config_document, encode_config_yaml};
use myoxus_domain::feature_bundle::{
  FeatureBundleCatalogSource, FeatureBundleSource, FeatureComponentKind, FeatureComponentSource, FeatureDocumentPolicy,
  FeatureExport, FeatureLink, FeatureNativeReference, FeatureReference, FeatureReleaseDescriptor,
};
use myoxus_infrastructure::feature_bundles::{
  capture_feature_source_with_platform, read_feature_bundle_file, read_feature_source_file,
};
use std::{
  cmp::Ordering,
  collections::{BTreeMap, BTreeSet},
  fs,
  io::Write,
  path::{Path, PathBuf},
};

#[derive(Debug, Subcommand)]
pub enum FeatureBundleCommand {
  /// Add a native document to the mandatory Basis source, without services.
  AddDocument {
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    manifest: String,
    #[arg(long)]
    bundle: PathBuf,
    /// Target Basis version; several sources may share an unpublished cohort.
    #[arg(long)]
    base_version: String,
    /// Required for a new export; omission preserves an existing export's policy.
    #[arg(long)]
    new_workspace_default: Option<bool>,
    /// Admit the complete candidate and report paths without changing the root.
    #[arg(long)]
    dry_run: bool,
  },
  /// Validate a complete release against its independent packaged expectation.
  ValidateRelease {
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    release_manifest: PathBuf,
  },
  /// Validate one captured native source set or an existing packed archive.
  Validate {
    #[arg(long, required_unless_present = "archive", conflicts_with = "archive")]
    root: Option<PathBuf>,
    #[arg(long, requires = "root", required_unless_present = "archive")]
    manifest: Option<String>,
    #[arg(long, conflicts_with = "root")]
    archive: Option<PathBuf>,
    /// Explicit pinned platform archives, dependency order first.
    #[arg(long)]
    platform: Vec<PathBuf>,
  },
  /// Pack captured/admitted bytes without rereading authoring files.
  Pack {
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    manifest: String,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    platform: Vec<PathBuf>,
    /// Write templates/features and independent static/features projections.
    #[arg(long)]
    release_base: bool,
  },
}

struct PreparedDocumentAddition {
  original_manifest: Vec<u8>,
  changes: BTreeMap<String, Vec<u8>>,
}

/// Preparation writes only a private temporary capture. Native admission owns
/// every copied component, typed link and export before any checkout change.
#[tracing::instrument(skip_all)]
fn prepare_document_addition(
  root: &Path,
  manifest_path: &str,
  bundle: &Path,
  base_version: &str,
  new_workspace_default: Option<bool>,
) -> anyhow::Result<PreparedDocumentAddition> {
  if !canonical_feature_path(manifest_path) || !manifest_path.ends_with(".yaml") {
    bail!("expected a confined YAML source manifest");
  }
  let original_bytes = read_feature_source_file(root, manifest_path, 4 * 1024 * 1024)?;
  let original_value = decode_config_document(std::str::from_utf8(&original_bytes)?, ConfigDocumentFormat::Yaml)?;
  let mut source: FeatureBundleSource = serde_json::from_value(original_value.clone())?;
  if source.id != "myoxus.features.base" {
    bail!("add-document requires the myoxus.features.base source manifest");
  }
  if compare_template_versions(base_version, &source.version).map_err(anyhow::Error::msg)? == Ordering::Less {
    bail!("target Basis version cannot go backwards");
  }
  let captured = capture_feature_source_with_platform(root, manifest_path, &[])?;
  validate_feature_native_sources(&captured, &[]).map_err(anyhow::Error::msg)?;
  validate_feature_references(&captured, &[]).map_err(anyhow::Error::msg)?;
  if read_feature_source_file(root, manifest_path, 4 * 1024 * 1024)? != original_bytes {
    bail!("source manifest changed during preparation; retry with its current contents");
  }

  let bundle = std::path::absolute(bundle)?;
  let bundle_name = bundle
    .file_name()
    .and_then(|value| value.to_str())
    .context("bundle filename is not UTF-8")?;
  let bundle_bytes = read_feature_source_file(
    bundle.parent().context("bundle parent missing")?,
    bundle_name,
    50 * 1024 * 1024,
  )?;
  let parsed = parse_bundle(&bundle_bytes)?;
  if parsed.format != TemplateInputFormat::TemplateBundle
    || parsed.manifest.purpose != Some(TemplatePurpose::Template)
    || parsed.manifest.kind.as_deref() != Some("page")
    || validate_manifest(&parsed.manifest)
      .iter()
      .any(|finding| finding.severity == ValidationSeverity::Error)
  {
    bail!("expected a valid canonical page TemplateBundle with purpose template");
  }
  let id = &parsed.manifest.template_id;
  let version = &parsed.manifest.version;
  let document_path = format!("documents/{id}/{version}.zip");
  let component_id = format!("document.{id}.{version}");
  let export_id = format!("document.{id}");
  for previous in &captured.manifest.components {
    if previous
      .native_identity
      .as_ref()
      .is_some_and(|identity| identity.id == *id && identity.version == *version)
      && (previous.id != component_id
        || previous.path != document_path
        || captured.files[&previous.path] != bundle_bytes)
    {
      bail!("native document identity/version is already owned by another component or payload");
    }
  }
  let reference = FeatureNativeReference {
    component: component_id.clone(),
    export: format!("{id}@{version}"),
    key: None,
  };
  let mut changes = BTreeMap::new();
  match fs::symlink_metadata(root.join(&document_path)) {
    Ok(_) => {
      if read_feature_source_file(root, &document_path, 50 * 1024 * 1024)? != bundle_bytes {
        bail!("immutable document identity/version already contains different bytes: {document_path}");
      }
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      // Reject symlink parents even when the final child does not exist yet.
      let mut parent = root.join(&document_path);
      while let Some(path) = parent.parent() {
        if path == root {
          break;
        }
        if let Ok(metadata) = fs::symlink_metadata(path) {
          if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("document output parent is not a confined directory");
          }
        }
        parent = path.to_path_buf();
      }
      changes.insert(document_path.clone(), bundle_bytes.clone());
    }
    Err(error) => return Err(error.into()),
  }
  if let Some(component) = source.components.iter().find(|component| component.id == component_id) {
    if component.kind != FeatureComponentKind::DocumentTemplate
      || component.path != document_path
      || component.artwork.is_some()
    {
      bail!("document component identity collides with another declaration");
    }
  } else {
    source.components.push(FeatureComponentSource {
      id: component_id,
      kind: FeatureComponentKind::DocumentTemplate,
      path: document_path.clone(),
      artwork: None,
    });
  }
  if let Some(export) = source.exports.iter_mut().find(|export| export.id == export_id) {
    let previous = captured
      .manifest
      .components
      .iter()
      .find(|component| component.id == export.source.component)
      .filter(|component| component.kind == FeatureComponentKind::DocumentTemplate)
      .and_then(|component| component.native_identity.as_ref())
      .filter(|identity| identity.id == *id)
      .context("document export identity collides with another native source")?;
    if compare_template_versions(version, &previous.version).map_err(anyhow::Error::msg)? == Ordering::Less {
      bail!("current document export cannot go backwards");
    }
    let policy = export
      .document
      .as_mut()
      .context("existing document export has no default policy")?;
    if let Some(value) = new_workspace_default {
      policy.new_workspace_default = value;
    }
    export.source = reference;
  } else {
    source.exports.push(FeatureExport {
      id: export_id,
      source: reference,
      contexts: Vec::new(),
      document: Some(FeatureDocumentPolicy {
        new_workspace_default: new_workspace_default
          .context("a new document export requires --new-workspace-default true|false")?,
      }),
    });
  }
  source.version = base_version.to_string();
  source.capabilities.insert("documentTemplate".into(), 1);
  // A replaced document version belongs in the runtime only while an export or
  // a typed native dependency still selects it. Git owns obsolete authoring bytes.
  let mut referenced: BTreeSet<_> = source
    .exports
    .iter()
    .map(|export| export.source.component.as_str())
    .collect();
  for link in &source.links {
    let (from, to) = match link {
      FeatureLink::Workflow { from, to }
      | FeatureLink::TaskCore { from, to }
      | FeatureLink::Schema { from, to }
      | FeatureLink::View { from, to }
      | FeatureLink::DocumentComponent { from, to }
      | FeatureLink::DocumentSource { from, to }
      | FeatureLink::Artwork { from, to }
      | FeatureLink::Input { from, to, .. }
      | FeatureLink::Context { from, to, .. }
      | FeatureLink::PriorResult { from, to, .. } => (from, to),
    };
    referenced.insert(from.component.as_str());
    if let FeatureReference::Local { reference } = to {
      referenced.insert(reference.component.as_str());
    }
  }
  source.components.retain(|component| {
    component.kind != FeatureComponentKind::DocumentTemplate || referenced.contains(component.id.as_str())
  });
  // Preserve the exact original manifest on replay; serialization is needed
  // only when its typed source declaration actually changes.
  let manifest_bytes = if serde_json::to_value(&source)? == original_value {
    original_bytes.clone()
  } else {
    let bytes = encode_config_yaml(&source)?.into_bytes();
    changes.insert(manifest_path.to_string(), bytes.clone());
    bytes
  };
  let accepted_archive = root
    .join("features")
    .join(&source.id)
    .join(format!("{base_version}.myoxus.zip"));
  if !changes.is_empty() && accepted_archive.try_exists()? {
    bail!("target Basis archive already exists; choose an unpublished forward version");
  }
  let staged = tempfile::tempdir()?;
  for (path, bytes) in captured
    .files
    .iter()
    .chain(std::iter::once((&document_path, &bundle_bytes)))
  {
    let destination = staged.path().join(path);
    fs::create_dir_all(destination.parent().context("staged component parent missing")?)?;
    fs::write(destination, bytes)?;
  }
  let staged_manifest = staged.path().join(manifest_path);
  fs::create_dir_all(staged_manifest.parent().context("staged manifest parent missing")?)?;
  fs::write(staged_manifest, manifest_bytes)?;
  let candidate = capture_feature_source_with_platform(staged.path(), manifest_path, &[])?;
  validate_feature_native_sources(&candidate, &[]).map_err(anyhow::Error::msg)?;
  validate_feature_references(&candidate, &[]).map_err(anyhow::Error::msg)?;
  Ok(PreparedDocumentAddition {
    original_manifest: original_bytes,
    changes,
  })
}

fn ensure_output_parent(root: &Path, relative: &str, created: &mut Vec<PathBuf>) -> anyhow::Result<()> {
  if !canonical_feature_path(relative) {
    bail!("noncanonical output path");
  }
  let mut cursor = root.to_path_buf();
  for component in Path::new(relative)
    .parent()
    .context("output parent missing")?
    .components()
  {
    cursor.push(component);
    match fs::symlink_metadata(&cursor) {
      Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
      Ok(_) => bail!("output parent is not a confined directory"),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        fs::create_dir(&cursor)?;
        created.push(cursor.clone());
      }
      Err(error) => return Err(error.into()),
    }
  }
  Ok(())
}

/// The immutable child is installed before the manifest selects it. A rejected
/// manifest replacement removes only output created by this application.
#[tracing::instrument(skip_all)]
fn apply_document_addition(root: &Path, manifest: &str, prepared: &PreparedDocumentAddition) -> anyhow::Result<()> {
  if prepared.changes.is_empty() {
    return Ok(());
  }
  read_feature_source_file(root, manifest, 4 * 1024 * 1024)?;
  let manifest_lock = fs::File::open(root.join(manifest))?;
  // Cooperating CLI writers serialize on the opened manifest. Re-read its path
  // after locking: an earlier writer may have replaced that inode atomically.
  manifest_lock.lock()?;
  let check_original = || -> anyhow::Result<()> {
    if read_feature_source_file(root, manifest, 4 * 1024 * 1024)? != prepared.original_manifest {
      bail!("source manifest changed since preparation; retry with its current contents");
    }
    Ok(())
  };
  check_original()?;
  let mut created_files = Vec::new();
  let mut created_directories = Vec::new();
  let result: anyhow::Result<()> = (|| {
    for (path, bytes) in &prepared.changes {
      if path == manifest {
        continue;
      }
      ensure_output_parent(root, path, &mut created_directories)?;
      if write_output(&root.join(path), bytes, true)? {
        created_files.push(path);
      }
    }
    check_original()?;
    if let Some(bytes) = prepared.changes.get(manifest) {
      ensure_output_parent(root, manifest, &mut created_directories)?;
      write_output(&root.join(manifest), bytes, false)?;
    }
    Ok(())
  })();
  if let Err(error) = result {
    for path in created_files.into_iter().rev() {
      let bytes = &prepared.changes[path];
      if read_feature_source_file(root, path, 50 * 1024 * 1024)? != *bytes {
        return Err(error.context("new child changed before rollback; its bytes were preserved"));
      }
      fs::remove_file(root.join(path)).with_context(|| format!("{error:#}; remove unselected child {path}"))?;
    }
    for directory in created_directories.into_iter().rev() {
      fs::remove_dir(&directory)
        .with_context(|| format!("{error:#}; remove staged directory {}", directory.display()))?;
    }
    return Err(error);
  }
  Ok(())
}

fn shell_argument(value: &str) -> String {
  format!("'{}'", value.replace('\'', "'\\''"))
}

fn print_document_authoring_commands(root: &Path, manifest: &str) {
  println!("From the matching checkout, generate native client assets:");
  println!("node build/scripts/templates/generate-document-bundles.mjs");
  println!(
    "myoxus-cli templates feature-bundle pack --root {} --manifest {} --release-base --output ./feature-dist",
    shell_argument(&root.to_string_lossy()),
    shell_argument(manifest)
  );
  println!(
    "myoxus-cli templates feature-bundle validate-release --root ./feature-dist/templates --release-manifest ./feature-dist/static/features/release.yaml"
  );
}

fn platform_sources(paths: &[PathBuf]) -> anyhow::Result<Vec<CapturedFeatureBundle>> {
  if paths.len() > 32 {
    bail!("too many platform archives");
  }
  let mut sources = Vec::new();
  for path in paths {
    let captured = read_feature_bundle_file(path, &sources)?;
    validate_feature_native_sources(&captured, &sources).map_err(anyhow::Error::msg)?;
    validate_feature_references(&captured, &sources).map_err(anyhow::Error::msg)?;
    if sources
      .iter()
      .any(|previous: &CapturedFeatureBundle| previous.pin() == captured.pin())
    {
      bail!("duplicate platform archive: {}", path.display());
    }
    sources.push(captured);
  }
  Ok(sources)
}

/// Existing immutable outputs may be reused byte-for-byte, never overwritten.
/// Authoring writes only its explicit output root; runtime publication has its
/// own locked catalog-rename boundary.
/// Returns false only when an identical immutable output already existed.
fn write_output(path: &Path, bytes: &[u8], immutable: bool) -> anyhow::Result<bool> {
  let parent = path.parent().context("output has no parent")?;
  fs::create_dir_all(parent)?;
  if immutable && path.exists() {
    if fs::read(path)? != bytes {
      bail!("immutable output differs: {}", path.display());
    }
    return Ok(false);
  }
  let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
  temporary.write_all(bytes)?;
  temporary.as_file().sync_all()?;
  if immutable {
    temporary.persist_noclobber(path).map_err(|error| error.error)?;
  } else {
    temporary.persist(path).map_err(|error| error.error)?;
  }
  Ok(true)
}

pub fn run_feature_bundle(command: &FeatureBundleCommand) -> anyhow::Result<()> {
  if let FeatureBundleCommand::AddDocument {
    root,
    manifest,
    bundle,
    base_version,
    new_workspace_default,
    dry_run,
  } = command
  {
    let root = root.canonicalize().context("authoring root is unavailable")?;
    let prepared = prepare_document_addition(&root, manifest, bundle, base_version, *new_workspace_default)?;
    if !dry_run {
      apply_document_addition(&root, manifest, &prepared)?;
    }
    if prepared.changes.is_empty() {
      println!("Basis source is unchanged.");
    } else {
      for path in prepared.changes.keys() {
        println!(
          "{} {}",
          if *dry_run { "Would update" } else { "Updated" },
          root.join(path).display()
        );
      }
    }
    print_document_authoring_commands(&root, manifest);
    return Ok(());
  }
  if let FeatureBundleCommand::ValidateRelease { root, release_manifest } = command {
    let captured = myoxus_infrastructure::feature_bundles::capture_feature_source_set(root, release_manifest)?;
    println!(
      "Feature release {} {} is valid ({})",
      captured.release.base.id, captured.release.base.version, captured.release.base.sha256
    );
    return Ok(());
  }
  let platform_paths = match command {
    FeatureBundleCommand::ValidateRelease { .. } | FeatureBundleCommand::AddDocument { .. } => {
      unreachable!("handled before source-only authoring")
    }
    FeatureBundleCommand::Validate { platform, .. } | FeatureBundleCommand::Pack { platform, .. } => platform,
  };
  let platform = platform_sources(platform_paths)?;
  let captured = match command {
    FeatureBundleCommand::Validate {
      archive: Some(path), ..
    } => read_feature_bundle_file(path, &platform)?,
    FeatureBundleCommand::Validate {
      root: Some(root),
      manifest: Some(manifest),
      ..
    }
    | FeatureBundleCommand::Pack { root, manifest, .. } => {
      capture_feature_source_with_platform(root, manifest, &platform)?
    }
    _ => bail!("specify a source root/manifest or an archive"),
  };
  validate_feature_native_sources(&captured, &platform).map_err(anyhow::Error::msg)?;
  validate_feature_references(&captured, &platform).map_err(anyhow::Error::msg)?;
  if let FeatureBundleCommand::Pack {
    output, release_base, ..
  } = command
  {
    let pin = captured.pin();
    let feature_root = if *release_base {
      output.join("templates/features")
    } else {
      output.clone()
    };
    let release_metadata = if *release_base {
      let release = FeatureReleaseDescriptor {
        format_version: 1,
        base: pin.clone(),
      };
      let catalog = FeatureBundleCatalogSource {
        format_version: 1,
        base: pin.clone(),
        optional: Vec::new(),
        retained: Vec::new(),
      };
      myoxus_application::feature_bundle::assemble_feature_catalogs(
        &release,
        &catalog,
        std::slice::from_ref(&captured),
      )
      .map_err(anyhow::Error::msg)?;
      Some((encode_config_yaml(&release)?, encode_config_yaml(&catalog)?))
    } else {
      None
    };
    write_output(&feature_root.join(pin.archive_path()), &captured.archive_bytes, true)?;
    if let Some((release_bytes, catalog_bytes)) = release_metadata {
      write_output(&feature_root.join("release.yaml"), release_bytes.as_bytes(), false)?;
      write_output(&feature_root.join("catalog.yaml"), catalog_bytes.as_bytes(), false)?;
      write_output(
        &output.join("static/features/release.yaml"),
        release_bytes.as_bytes(),
        false,
      )?;
    }
    println!("{}", feature_root.join(captured.pin().archive_path()).display());
  } else {
    println!(
      "Feature Bundle {} {} is valid ({})",
      captured.manifest.id, captured.manifest.version, captured.archive_sha256
    );
  }
  Ok(())
}
