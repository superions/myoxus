// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
use crate::template_files::decode_yaml;
use myoxus_application::feature_bundle::CapturedFeatureBundle;
use myoxus_contracts::config_document::encode_config_yaml;
use myoxus_domain::{assistant_package::AssistantLocalizedText, feature_bundle::*};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::LazyLock};

static BASE: LazyLock<CapturedFeatureBundle> = LazyLock::new(|| {
  capture_feature_source(
    &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates"),
    "features/base/manifest.yaml",
  )
  .unwrap()
});
fn version(version: &str) -> CapturedFeatureBundle {
  let mut manifest = BASE.manifest.clone();
  manifest.version = version.into();
  read_feature_bundle(&pack_captured_feature_bundle(&manifest, &BASE.files).unwrap()).unwrap()
}
fn optional(id: &str) -> CapturedFeatureBundle {
  // Optional providers cannot own the platform Task core. This fixture only
  // measures ordered provider retention; use the implemented static asset kind.
  let bytes = br#"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><path d="M0 0L12 8"/></svg>"#.to_vec();
  let sha256 = format!("{:x}", Sha256::digest(&bytes));
  let manifest = FeatureBundleManifest {
    format_version: 1,
    id: id.into(),
    version: "1.0.0".into(),
    capabilities: BTreeMap::from([("artwork".into(), 1)]),
    components: vec![FeatureComponent {
      id: "artwork".into(),
      kind: FeatureComponentKind::Artwork,
      path: "artwork.svg".into(),
      sha256: sha256.clone(),
      native_identity: None,
      artwork: Some(FeatureArtwork {
        role: None,
        media_type: "image/svg+xml".into(),
        width: 12,
        height: 8,
        alternative: AssistantLocalizedText {
          en: "Preview".into(),
          de: "Vorschau".into(),
          fr: "Aperçu".into(),
          es: "Vista previa".into(),
        },
        caption: None,
      }),
    }],
    files: BTreeMap::from([("artwork.svg".into(), sha256)]),
    links: vec![],
    exports: vec![],
  };
  read_feature_bundle(
    &pack_captured_feature_bundle(&manifest, &BTreeMap::from([("artwork.svg".into(), bytes)])).unwrap(),
  )
  .unwrap()
}
fn put(root: &Path, bundle: &CapturedFeatureBundle) {
  let path = root.join("features").join(bundle.pin().archive_path());
  std::fs::create_dir_all(path.parent().unwrap()).unwrap();
  std::fs::write(path, &bundle.archive_bytes).unwrap();
}
fn catalog(
  root: &Path,
  base: &CapturedFeatureBundle,
  optional: &[CapturedFeatureBundle],
  retained: &[CapturedFeatureBundle],
) -> FeatureBundleCatalogSource {
  for bundle in std::iter::once(base).chain(optional).chain(retained) {
    put(root, bundle);
  }
  let catalog = FeatureBundleCatalogSource {
    format_version: 1,
    base: base.pin(),
    optional: optional.iter().map(CapturedFeatureBundle::pin).collect(),
    retained: retained.iter().map(CapturedFeatureBundle::pin).collect(),
  };
  std::fs::write(
    root.join("features/catalog.yaml"),
    encode_config_yaml(&catalog).unwrap(),
  )
  .unwrap();
  std::fs::write(
    root.join("release.yaml"),
    encode_config_yaml(&FeatureReleaseDescriptor {
      format_version: 1,
      base: base.pin(),
    })
    .unwrap(),
  )
  .unwrap();
  catalog
}
fn prepare(source: &Path, installed: Option<&Path>) -> PreparedFeatureSourceSet {
  prepare_feature_source_set(source, installed, &source.join("release.yaml"), None).unwrap()
}

#[test]
fn initial_selection_and_refresh_preserve_native_optional_order() {
  let source = tempfile::tempdir().unwrap();
  let installed = tempfile::tempdir().unwrap();
  let old = version("1.0.0");
  let selected = vec![optional("example.second"), optional("example.first")];
  let previous = catalog(installed.path(), &old, &selected, &[]);
  // A release's new optional suggestion cannot silently replace installed choices.
  let next = version("1.1.0");
  let suggestion = optional("example.suggestion");
  let source_catalog = catalog(source.path(), &next, &[suggestion], &[]);
  let initial = prepare(source.path(), None);
  let initial_catalog: FeatureBundleCatalogSource = decode_yaml(&initial.catalog_bytes).unwrap();
  assert_eq!(initial_catalog.optional, source_catalog.optional);
  let refreshed = prepare(source.path(), Some(installed.path()));
  let refreshed_catalog: FeatureBundleCatalogSource = decode_yaml(&refreshed.catalog_bytes).unwrap();
  assert_eq!(refreshed_catalog.optional, previous.optional);
  assert_eq!(
    refreshed.resolved.active.iter().skip(1).cloned().collect::<Vec<_>>(),
    previous.optional
  );
}

#[test]
fn admitted_output_survives_source_removal_and_refuses_to_overwrite_an_active_root() {
  let source = tempfile::tempdir().unwrap();
  let output = tempfile::tempdir().unwrap();
  let base = version("1.0.0");
  catalog(source.path(), &base, &[], &[]);
  let prepared = prepare(source.path(), None);
  let expected_catalog = prepared.catalog_bytes.clone();
  source.close().unwrap();
  write_prepared_feature_source_set(&prepared, output.path()).unwrap();
  assert_eq!(
    std::fs::read(output.path().join("features/catalog.yaml")).unwrap(),
    expected_catalog
  );
  let loaded = capture_feature_source_set(output.path(), &output.path().join("features/release.yaml")).unwrap();
  assert_eq!(loaded.resolved.active, vec![base.pin()]);
  assert!(
    write_prepared_feature_source_set(&prepared, output.path())
      .unwrap_err()
      .to_string()
      .contains("fresh empty")
  );
  assert_eq!(
    std::fs::read(output.path().join("features/catalog.yaml")).unwrap(),
    expected_catalog
  );
}

#[test]
fn source_set_decode_shares_expansion_budget_across_valid_archives() {
  use super::archive::archive_limits;
  use super::source_set::{CapturedArchives, decode_captured_archives, decode_captured_archives_with_budget};
  use myoxus_application::template_registry::bundle::NestedArchiveBudget;

  let first = optional("budget-first");
  let second = optional("budget-second");
  let archives: CapturedArchives = [&first, &second]
    .into_iter()
    .map(|bundle| {
      (
        (bundle.manifest.id.clone(), bundle.manifest.version.clone()),
        (bundle.pin(), bundle.archive_bytes.clone()),
      )
    })
    .collect();
  let expanded = [&first, &second].map(|bundle| {
    NestedArchiveBudget::new(archive_limits())
      .account(&bundle.archive_bytes)
      .unwrap()
      .expanded_bytes
  });
  let mut limits = archive_limits();
  limits.max_total_uncompressed_size = *expanded.iter().max().unwrap();
  assert!(expanded.iter().sum::<u64>() > limits.max_total_uncompressed_size);
  // Both exact archives are individually valid even with this small limit.
  // Only cumulative source-set expansion is forbidden.
  for (key, value) in &archives {
    let single = BTreeMap::from([(key.clone(), value.clone())]);
    let mut budget = NestedArchiveBudget::new(limits);
    let decoded = decode_captured_archives_with_budget("budget-first", &single, &mut budget).unwrap();
    assert_eq!(decoded[0].pin(), value.0);
  }
  let mut budget = NestedArchiveBudget::new(limits);
  let error = decode_captured_archives_with_budget("budget-first", &archives, &mut budget).unwrap_err();
  assert!(
    error.to_string().contains("aggregate nested archive limit exceeded"),
    "{error}"
  );
  // A collection can admit both valid inputs without increasing either ZIP's
  // own expansion limit. The larger collection still has a cumulative ceiling.
  let total = expanded.iter().sum::<u64>();
  let mut collection = NestedArchiveBudget::with_aggregate_limit(limits, total);
  assert_eq!(
    decode_captured_archives_with_budget("budget-first", &archives, &mut collection)
      .unwrap()
      .len(),
    2
  );
  let mut too_small = NestedArchiveBudget::with_aggregate_limit(limits, total - 1);
  assert!(
    decode_captured_archives_with_budget("budget-first", &archives, &mut too_small)
      .unwrap_err()
      .to_string()
      .contains("aggregate nested archive limit exceeded")
  );
  let mut per_archive = limits;
  per_archive.max_total_uncompressed_size = expanded.iter().min().unwrap() - 1;
  let mut collection = NestedArchiveBudget::with_aggregate_limit(per_archive, total);
  assert!(
    decode_captured_archives_with_budget("budget-first", &archives, &mut collection)
      .unwrap_err()
      .to_string()
      .contains("ZIP_LIMIT_TOTAL_SIZE")
  );

  let decoded = decode_captured_archives("budget-first", &archives).unwrap();
  assert_eq!(
    decoded.iter().map(CapturedFeatureBundle::pin).collect::<Vec<_>>(),
    vec![first.pin(), second.pin()]
  );
}
