// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
use myoxus_application::{
  feature_bundle::CapturedFeatureBundle,
  template_registry::bundle::{TemplateBundleZipLimits, create_export_bundle, parse_bundle_with_limits},
};
use myoxus_contracts::config_document::encode_config_yaml;
use myoxus_domain::{assistant_package::AssistantLocalizedText, feature_bundle::*};
use sha2::{Digest, Sha256};
use std::{
  collections::{BTreeMap, BTreeSet},
  io::{Cursor, Write},
  path::Path,
};

fn shipped() -> std::path::PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates")
}
fn copy_tree(from: &Path, to: &Path) {
  std::fs::create_dir_all(to).unwrap();
  for entry in std::fs::read_dir(from).unwrap() {
    let entry = entry.unwrap();
    let to = to.join(entry.file_name());
    if entry.file_type().unwrap().is_dir() {
      copy_tree(&entry.path(), &to);
    } else {
      std::fs::copy(entry.path(), to).unwrap();
    }
  }
}
fn text() -> AssistantLocalizedText {
  AssistantLocalizedText {
    en: "Preview".into(),
    de: "Vorschau".into(),
    fr: "Aperçu".into(),
    es: "Vista previa".into(),
  }
}
fn component(id: &str, kind: FeatureComponentKind, path: &str) -> FeatureComponentSource {
  FeatureComponentSource {
    id: id.into(),
    kind,
    path: path.into(),
    artwork: None,
  }
}
fn source(components: Vec<FeatureComponentSource>) -> FeatureBundleSource {
  FeatureBundleSource {
    format_version: 1,
    id: "example.feature".into(),
    version: "1.0.0".into(),
    capabilities: [
      ("database".into(), 1),
      ("assistant".into(), 1),
      ("documentTemplate".into(), 1),
      ("artwork".into(), 1),
    ]
    .into(),
    components,
    links: vec![],
    exports: vec![],
  }
}
fn write_source(root: &Path, source: &FeatureBundleSource) {
  std::fs::write(root.join("feature.yaml"), encode_config_yaml(source).unwrap()).unwrap();
}
fn fixture() -> tempfile::TempDir {
  let root = tempfile::tempdir().unwrap();
  copy_tree(&shipped().join("databases"), &root.path().join("native/databases"));
  copy_tree(&shipped().join("assistants"), &root.path().join("native/assistants"));
  std::fs::copy(
    shipped().join("documents/meeting-notes/1.0.0.zip"),
    root.path().join("document.zip"),
  )
  .unwrap();
  std::fs::write(
    root.path().join("preview.svg"),
    b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"></svg>",
  )
  .unwrap();
  let mut artwork = component("preview", FeatureComponentKind::Artwork, "preview.svg");
  artwork.artwork = Some(FeatureArtwork {
    role: None,
    media_type: "image/svg+xml".into(),
    width: 1,
    height: 1,
    alternative: text(),
    caption: None,
  });
  write_source(
    root.path(),
    &source(vec![
      component(
        "databases",
        FeatureComponentKind::DatabaseCatalog,
        "native/databases/catalog.yaml",
      ),
      component(
        "assistants",
        FeatureComponentKind::AssistantCatalog,
        "native/assistants/catalog.yaml",
      ),
      component("document", FeatureComponentKind::DocumentTemplate, "document.zip"),
      artwork,
    ]),
  );
  root
}
fn digest(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}
#[test]
fn tampered_undeclared_or_wrong_native_components_fail_before_any_publication() {
  let root = fixture();
  let captured = capture_feature_source(root.path(), "feature.yaml").unwrap();
  let mut files = captured.files.clone();
  files.get_mut("document.zip").unwrap().push(0);
  assert!(
    pack_captured_feature_bundle(&captured.manifest, &files)
      .unwrap_err()
      .to_string()
      .contains("SHA-256")
  );
  let mut manifest = captured.manifest.clone();
  files = captured.files.clone();
  files.insert("undeclared.yaml".into(), b"x: 1\n".to_vec());
  manifest
    .files
    .insert("undeclared.yaml".into(), digest(&files["undeclared.yaml"]));
  let archive = pack_captured_feature_bundle(&manifest, &files).unwrap();
  assert!(
    read_feature_bundle(&archive)
      .unwrap_err()
      .to_string()
      .contains("undeclared native closure")
  );
  let mut manifest = captured.manifest.clone();
  manifest
    .components
    .iter_mut()
    .find(|component| component.id == "document")
    .unwrap()
    .native_identity
    .as_mut()
    .unwrap()
    .id = "other-document".into();
  let archive = pack_captured_feature_bundle(&manifest, &captured.files).unwrap();
  assert!(
    read_feature_bundle(&archive)
      .unwrap_err()
      .to_string()
      .contains("native document identity/version mismatch")
  );
}

#[test]
fn source_and_packed_admission_share_the_component_capacity() {
  let root = fixture();
  let mut authored: FeatureBundleSource =
    crate::template_files::decode_yaml(&std::fs::read(root.path().join("feature.yaml")).unwrap()).unwrap();
  let artwork = authored
    .components
    .iter()
    .find(|component| component.id == "preview")
    .unwrap()
    .clone();
  for index in authored.components.len()..256 {
    let mut component = artwork.clone();
    component.id = format!("preview-{index}");
    authored.components.push(component);
  }
  write_source(root.path(), &authored);
  // Capture reopens its packed archive through the native admission owner.
  let admitted = capture_feature_source(root.path(), "feature.yaml").unwrap();
  assert_eq!(admitted.manifest.components.len(), 256);

  let mut extra = artwork;
  extra.id = "preview-over-capacity".into();
  authored.components.push(extra);
  write_source(root.path(), &authored);
  assert!(
    capture_feature_source(root.path(), "feature.yaml")
      .unwrap_err()
      .to_string()
      .contains("invalid component count")
  );
  let mut over_capacity = admitted.manifest.clone();
  let mut extra = over_capacity
    .components
    .iter()
    .find(|component| component.id == "preview")
    .unwrap()
    .clone();
  extra.id = "preview-over-capacity".into();
  over_capacity.components.push(extra);
  assert!(myoxus_application::feature_bundle::validate_feature_manifest(&over_capacity, &admitted.files).is_err());
}

fn raw_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
  let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
  let options = zip::write::FileOptions::<()>::default().compression_method(zip::CompressionMethod::Stored);
  for (name, bytes) in entries {
    writer.start_file(*name, options).unwrap();
    writer.write_all(bytes).unwrap();
  }
  writer.finish().unwrap().into_inner()
}
#[test]
fn archive_aliases_traversal_and_document_wrapper_substitution_are_rejected() {
  for paths in [
    ["native/a.yaml", "native/./a.yaml"],
    ["native/a.yaml", "native/A.yaml"],
    ["manifest.yaml", "../escape.yaml"],
  ] {
    let bytes = raw_archive(&[(paths[0], b"a"), (paths[1], b"b")]);
    assert!(read_feature_bundle(&bytes).is_err(), "{paths:?}");
  }
  let root = fixture();
  std::fs::write(
    root.path().join("document.zip"),
    raw_archive(&[("onboarding-manifest.json", b"{}")]),
  )
  .unwrap();
  assert!(capture_feature_source(root.path(), "feature.yaml").is_err());
  let raw = raw_archive(&[("doc-data/abc.snapshot", b"snapshot-data")]);
  assert_eq!(
    parse_bundle_with_limits(&raw, TemplateBundleZipLimits::default())
      .unwrap()
      .format,
    myoxus_application::template_registry::bundle::TemplateInputFormat::RawWorkspaceZip
  );
  std::fs::write(root.path().join("document.zip"), raw).unwrap();
  assert!(
    capture_feature_source(root.path(), "feature.yaml")
      .unwrap_err()
      .to_string()
      .contains("canonical native TemplateBundle")
  );
}
#[test]
fn source_capture_rejects_symlink_and_parent_escape_without_reading_outside_its_root() {
  let root = fixture();
  assert!(capture_feature_source(root.path(), "../feature.yaml").is_err());
  #[cfg(unix)]
  {
    let outside = tempfile::tempdir().unwrap();
    let document = root.path().join("document.zip");
    std::fs::rename(&document, outside.path().join("document.zip")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("document.zip"), &document).unwrap();
    assert!(capture_feature_source(root.path(), "feature.yaml").is_err());
  }
}
fn platform_fixture(versions: &BTreeSet<String>) -> (tempfile::TempDir, CapturedFeatureBundle) {
  let root = tempfile::tempdir().unwrap();
  let mut authored = source(Vec::new());
  for version in versions {
    let path = format!("core-{version}.yaml");
    let id = format!("core-{}", version.replace('.', "-"));
    std::fs::copy(
      shipped().join(format!("databases/myoxus.project.task-core/{version}.yaml")),
      root.path().join(&path),
    )
    .unwrap();
    authored
      .components
      .push(component(&id, FeatureComponentKind::TaskCore, &path));
    authored.exports.push(FeatureExport {
      id: format!("task-core-{}", version.replace('.', "-")),
      source: FeatureNativeReference {
        component: id,
        export: format!("myoxus.project.task-core@{version}"),
        key: None,
      },
      contexts: vec![],
      document: None,
    });
  }
  write_source(root.path(), &authored);
  let captured = capture_feature_source(root.path(), "feature.yaml").unwrap();
  (root, captured)
}
#[test]
fn explicit_pinned_platform_task_core_is_decoder_only_and_never_copied_as_local_ownership() {
  let root = tempfile::tempdir().unwrap();
  copy_tree(&shipped().join("databases"), &root.path().join("db"));
  let files = crate::database_templates::capture_database_template_files(&root.path().join("db")).unwrap();
  let (_, definitions, _) = crate::database_templates::decode_database_template_sources(&files).unwrap();
  let versions = definitions
    .iter()
    .filter_map(|definition| definition.task_core.as_ref())
    .map(|core| core.version.clone())
    .collect::<BTreeSet<_>>();
  let (_platform_root, platform) = platform_fixture(&versions);
  let mut authored = source(vec![component(
    "database",
    FeatureComponentKind::DatabaseCatalog,
    "db/catalog.yaml",
  )]);
  for definition in definitions.iter().filter(|definition| definition.task_core.is_some()) {
    authored.links.push(FeatureLink::TaskCore {
      from: FeatureNativeReference {
        component: "database".into(),
        export: format!("{}@{}", definition.id, definition.version),
        key: None,
      },
      to: FeatureReference::Platform {
        bundle: platform.pin(),
        export: format!(
          "task-core-{}",
          definition.task_core.as_ref().unwrap().version.replace('.', "-")
        ),
      },
    });
  }
  let core_paths = versions
    .iter()
    .map(|version| format!("db/myoxus.project.task-core/{version}.yaml"))
    .collect::<Vec<_>>();
  for path in &core_paths {
    std::fs::remove_file(root.path().join(path)).unwrap();
  }
  write_source(root.path(), &authored);
  assert!(capture_feature_source(root.path(), "feature.yaml").is_err());
  let capture =
    capture_feature_source_with_platform(root.path(), "feature.yaml", std::slice::from_ref(&platform)).unwrap();
  for path in &core_paths {
    assert!(!capture.files.contains_key(path));
    assert!(!capture.manifest.files.contains_key(path));
  }
  assert_eq!(
    serde_json::to_value(&capture.databases["database"].definitions).unwrap(),
    serde_json::to_value(&definitions).unwrap()
  );
  assert!(read_feature_bundle(&capture.archive_bytes).is_err());
  read_feature_bundle_with_platform(&capture.archive_bytes, std::slice::from_ref(&platform)).unwrap();
  // Every definition needs its own exact dependency link even when preceding
  // definitions referenced the same already decoded Core bytes.
  let mut incomplete = capture.manifest.clone();
  incomplete.links.pop().unwrap();
  let archive = pack_captured_feature_bundle(&incomplete, &capture.files).unwrap();
  assert!(read_feature_bundle_with_platform(&archive, std::slice::from_ref(&platform)).is_err());
  let mut wrong = platform.clone();
  wrong.archive_sha256 = "f".repeat(64);
  assert!(read_feature_bundle_with_platform(&capture.archive_bytes, &[wrong]).is_err());
  std::fs::write(root.path().join(&core_paths[0]), b"different local core").unwrap();
  assert!(
    capture_feature_source_with_platform(root.path(), "feature.yaml", &[platform])
      .unwrap_err()
      .to_string()
      .contains("local Task core differs")
  );
}
#[test]
fn nested_document_layers_share_one_aggregate_entry_budget() {
  let root = tempfile::tempdir().unwrap();
  let entries = (0..4093).map(|index| format!("{index}.txt")).collect::<Vec<_>>();
  let payload = raw_archive(
    &entries
      .iter()
      .map(|path| (path.as_str(), b"x".as_slice()))
      .collect::<Vec<_>>(),
  );
  let original = std::fs::read(shipped().join("documents/meeting-notes/1.0.0.zip")).unwrap();
  let mut native = parse_bundle_with_limits(&original, TemplateBundleZipLimits::default())
    .unwrap()
    .manifest;
  native.localized_contents.clear();
  native.checksum = Some(digest(&payload));
  let child = create_export_bundle(&native, &payload, None, &BTreeMap::new()).unwrap();
  std::fs::write(root.path().join("document.zip"), &child).unwrap();
  write_source(
    root.path(),
    &source(vec![component(
      "document",
      FeatureComponentKind::DocumentTemplate,
      "document.zip",
    )]),
  );
  let error = capture_feature_source(root.path(), "feature.yaml")
    .unwrap_err()
    .to_string();
  assert!(error.contains("aggregate nested archive limit exceeded"), "{error}");
}

#[test]
fn feature_database_update_files_remain_required_pinned_native_children() {
  let root = fixture();
  let captured = capture_feature_source(root.path(), "feature.yaml").unwrap();
  let reference = &captured.databases["databases"].updates[0].1;
  let path = format!("native/databases/{}", reference.path);
  assert_eq!(captured.manifest.files[&path], reference.sha256);
  let mut files = captured.files.clone();
  files.remove(&path).unwrap();
  let mut manifest = captured.manifest.clone();
  manifest.files.remove(&path).unwrap();
  let archive = pack_captured_feature_bundle(&manifest, &files).unwrap();
  let error = read_feature_bundle(&archive).unwrap_err().to_string();
  assert!(error.contains(&path), "{error}");

  let mut files = captured.files.clone();
  files.get_mut(&path).unwrap().push(b' ');
  let mut manifest = captured.manifest.clone();
  // Re-pin only the enclosing delivery inventory; the native catalog pin must
  // still reject altered child bytes through the sole Database decoder.
  manifest.files.insert(path.clone(), digest(&files[&path]));
  let archive = pack_captured_feature_bundle(&manifest, &files).unwrap();
  let error = read_feature_bundle(&archive).unwrap_err().to_string();
  assert!(
    error.contains(&reference.path) && error.contains("SHA-256 mismatch"),
    "{error}"
  );
}
