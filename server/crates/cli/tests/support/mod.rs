// SPDX-License-Identifier: AGPL-3.0-or-later

use std::str::FromStr;

use sqlx::postgres::PgConnectOptions;

const DEFAULT_TEST_DATABASE_URL: &str = "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test";
pub const REQUIRED_TEST_PORT: u16 = 5434;
const REQUIRED_TEST_DATABASE: &str = "myoxus_test";

/// Real shipped bytes are cached in memory only; each process fixture gets its
/// own distribution paths, independent of Cargo's shared target/static tree.
#[allow(dead_code)]
pub fn feature_sources() -> &'static myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet {
  use myoxus_domain::feature_bundle::{FeatureBundleCatalogSource, FeatureReleaseDescriptor};
  static SOURCES: std::sync::OnceLock<myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet> =
    std::sync::OnceLock::new();
  SOURCES.get_or_init(|| {
    let bundle = myoxus_infrastructure::feature_bundles::capture_feature_source(
      &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates"),
      "features/base/manifest.yaml",
    )
    .expect("capture shipped Feature source");
    let release = FeatureReleaseDescriptor {
      format_version: 1,
      base: bundle.pin(),
    };
    let catalog = FeatureBundleCatalogSource {
      format_version: 1,
      base: bundle.pin(),
      optional: vec![],
      retained: vec![],
    };
    let bundles = vec![bundle];
    let resolved = myoxus_application::feature_bundle::assemble_feature_catalogs(&release, &catalog, &bundles)
      .expect("admit complete shipped Feature catalog");
    myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet {
      release,
      catalog,
      bundles,
      resolved,
    }
  })
}

#[allow(dead_code)]
pub fn database_starter_catalog() -> std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog> {
  std::sync::Arc::new(feature_sources().resolved.databases.clone())
}

/// The guard owns the private executable/expectation layout. Keep it alive
/// until any explicitly spawned child has exited, just as for its storage.
#[allow(dead_code)]
pub struct CliCommand {
  command: std::process::Command,
  _distribution: tempfile::TempDir,
}
impl std::ops::Deref for CliCommand {
  type Target = std::process::Command;
  fn deref(&self) -> &Self::Target {
    &self.command
  }
}
impl std::ops::DerefMut for CliCommand {
  fn deref_mut(&mut self) -> &mut Self::Target {
    &mut self.command
  }
}

/// Use the native distribution resolver unchanged. A real hard link (not a
/// symlink) keeps current_exe inside the private bin/static distribution.
#[allow(dead_code)]
pub fn cli_command() -> CliCommand {
  let binary = std::path::Path::new(env!("CARGO_BIN_EXE_myoxus-cli"));
  // The unique private directory shares the binary's filesystem, avoiding
  // repeated copies of a large debug executable. Nothing writes target/static.
  let distribution = tempfile::Builder::new()
    .prefix(".cli-distribution-")
    .tempdir_in(binary.parent().expect("CLI binary parent"))
    .expect("private CLI distribution");
  let root = distribution.path();
  std::fs::create_dir(root.join("bin")).expect("create private CLI bin");
  let executable = root.join("bin/myoxus-cli");
  std::fs::hard_link(binary, &executable)
    .or_else(|_| std::fs::copy(binary, &executable).map(|_| ()))
    .expect("link actual compiled CLI into private distribution");
  copy_feature_templates(&root.join("templates"));
  std::fs::create_dir_all(root.join("static/features")).expect("create independent release directory");
  std::fs::write(
    root.join("static/features/release.yaml"),
    myoxus_contracts::config_document::encode_config_yaml(&feature_sources().release).unwrap(),
  )
  .expect("write independent CLI release expectation");
  copy_tree(
    &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
    &root.join("templates/html"),
  );
  let mut command = std::process::Command::new(executable);
  command.env("MYOXUS__TEMPLATES__ROOT_DIR", root.join("templates"));
  CliCommand {
    command,
    _distribution: distribution,
  }
}

/// PDF commands use the packaged compiler beside their actual executable.
/// The owning CLI gate builds it; this fixture never builds or changes lookup.
#[allow(dead_code)]
pub fn cli_command_with_pdf_compiler() -> CliCommand {
  let command = cli_command();
  let cli = std::path::Path::new(env!("CARGO_BIN_EXE_myoxus-cli"));
  let compiler = cli.with_file_name("myoxus-pdf-compiler");
  assert!(
    compiler.is_file(),
    "required already-built PDF compiler is missing: {}; server.cli.integration must build the native compiler prerequisite",
    compiler.display(),
  );
  let packaged = command._distribution.path().join("bin/myoxus-pdf-compiler");
  std::fs::hard_link(&compiler, &packaged)
    .or_else(|_| std::fs::copy(&compiler, &packaged).map(|_| ()))
    .expect("link actual compiled PDF compiler beside the private CLI executable");
  command
}

#[allow(dead_code)]
pub fn copy_feature_templates(root: &std::path::Path) {
  let sources = feature_sources();
  for bundle in &sources.bundles {
    let path = root.join("features").join(bundle.pin().archive_path());
    std::fs::create_dir_all(path.parent().unwrap()).expect("create immutable Feature fixture directory");
    std::fs::write(path, &bundle.archive_bytes).expect("write exact captured Feature bytes");
  }
  std::fs::write(
    root.join("features/catalog.yaml"),
    myoxus_contracts::config_document::encode_config_yaml(&sources.catalog).unwrap(),
  )
  .expect("write native Feature catalog");
}

fn copy_tree(source: &std::path::Path, target: &std::path::Path) {
  std::fs::create_dir_all(target).expect("create template fixture directory");
  for entry in std::fs::read_dir(source).expect("read shipped template directory") {
    let entry = entry.expect("read shipped template entry");
    let target = target.join(entry.file_name());
    if entry.file_type().expect("inspect shipped template entry").is_dir() {
      copy_tree(&entry.path(), &target);
    } else {
      std::fs::copy(entry.path(), target).expect("copy shipped template fixture");
    }
  }
}

/// Add a unique native assistant provider; the mandatory archive/pin remains
/// exactly the one independently owned by every private executable fixture.
#[allow(dead_code)]
pub fn add_assistant_feature(
  root: &std::path::Path,
  package: &myoxus_domain::assistant_package::AssistantPackageSource,
  original: &myoxus_domain::assistant_package::AssistantPackageIdentity,
) -> anyhow::Result<()> {
  use myoxus_contracts::config_document::encode_config_yaml;
  use myoxus_domain::{assistant_package::*, feature_bundle::*};
  use sha2::{Digest, Sha256};
  let base = feature_sources();
  let source = tempfile::tempdir()?;
  let bytes = encode_config_yaml(package)?.into_bytes();
  let relative = format!("{}/{}.yaml", package.id, package.version);
  let package_path = source.path().join(&relative);
  std::fs::create_dir_all(package_path.parent().unwrap())?;
  std::fs::write(package_path, &bytes)?;
  let catalog = AssistantPackageCatalogSource {
    format_version: 1,
    packages: vec![AssistantPackageCatalogEntry {
      enabled: true,
      id: package.id.clone(),
      current: package.version.clone(),
      default_for: vec![],
      definitions: vec![AssistantPackageFileReference {
        version: package.version.clone(),
        path: relative,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
      }],
    }],
  };
  std::fs::write(source.path().join("catalog.yaml"), encode_config_yaml(&catalog)?)?;
  let owner = base
    .bundles
    .iter()
    .find(|bundle| {
      bundle.assistants.values().any(|sources| {
        sources.definitions.iter().any(|(source, digest)| {
          source.id == original.id && source.version == original.version && digest == &original.digest
        })
      })
    })
    .ok_or_else(|| anyhow::anyhow!("original native assistant identity unavailable"))?;
  let original_export = format!("{}@{}", original.id, original.version);
  let mut links = Vec::new();
  for component in &package.components {
    let is_document = match &component.action {
      AssistantNativeAction::CreateProject { .. } => false,
      AssistantNativeAction::CreateDocument { .. } => true,
      _ => continue,
    };
    let key = format!("component/{}", component.id);
    let targets = owner
      .manifest
      .links
      .iter()
      .filter_map(|link| {
        let (from, to) = match link {
          FeatureLink::Schema { from, to } if !is_document => (from, to),
          FeatureLink::DocumentComponent { from, to } if is_document => (from, to),
          _ => return None,
        };
        (from.export == original_export && from.key.as_deref() == Some(key.as_str())).then_some((from, to))
      })
      .collect::<Vec<_>>();
    anyhow::ensure!(
      targets.len() == 1,
      "original native component requires one exact delivery link"
    );
    let (original_from, target) = targets[0];
    // Preserve the original provider and native export, rather than guessing a
    // source from a slug or selecting a different retained revision.
    let to = match target {
      FeatureReference::Platform { .. } => target.clone(),
      FeatureReference::Local { reference } => {
        let export = owner
          .manifest
          .exports
          .iter()
          .find(|export| &export.source == reference)
          .ok_or_else(|| anyhow::anyhow!("original component target has no platform export"))?;
        FeatureReference::Platform {
          bundle: owner.pin(),
          export: export.id.clone(),
        }
      }
    };
    let from = FeatureNativeReference {
      component: "assistants".into(),
      export: format!("{}@{}", package.id, package.version),
      key: original_from.key.clone(),
    };
    links.push(if is_document {
      FeatureLink::DocumentComponent { from, to }
    } else {
      FeatureLink::Schema { from, to }
    });
  }
  let manifest = FeatureBundleSource {
    format_version: 1,
    id: "example.cli.fixture".into(),
    version: "1.0.0".into(),
    capabilities: std::collections::BTreeMap::from([("assistant".into(), 1)]),
    components: vec![FeatureComponentSource {
      id: "assistants".into(),
      kind: FeatureComponentKind::AssistantCatalog,
      path: "catalog.yaml".into(),
      artwork: None,
    }],
    links,
    exports: vec![FeatureExport {
      id: package.id.clone(),
      source: FeatureNativeReference {
        component: "assistants".into(),
        export: format!("{}@{}", package.id, package.version),
        key: None,
      },
      contexts: package.contexts.clone(),
      document: None,
    }],
  };
  std::fs::write(source.path().join("feature.yaml"), encode_config_yaml(&manifest)?)?;
  let captured = myoxus_infrastructure::feature_bundles::capture_feature_source_with_platform(
    source.path(),
    "feature.yaml",
    &base.bundles,
  )?;
  let catalog = FeatureBundleCatalogSource {
    format_version: 1,
    base: base.release.base.clone(),
    optional: vec![captured.pin()],
    retained: vec![],
  };
  let mut bundles = base.bundles.clone();
  bundles.push(captured.clone());
  myoxus_application::feature_bundle::assemble_feature_catalogs(&base.release, &catalog, &bundles)
    .map_err(anyhow::Error::msg)?;
  let path = root.join("features").join(captured.pin().archive_path());
  std::fs::create_dir_all(path.parent().unwrap())?;
  std::fs::write(path, &captured.archive_bytes)?;
  std::fs::write(root.join("features/catalog.yaml"), encode_config_yaml(&catalog)?)?;
  Ok(())
}

/// Resolve the only database URL that DB-backed CLI integration tests may use.
///
/// General runtime variables are intentionally ignored: inheriting a local
/// `DATABASE_URL` or `MYOXUS__DATABASE__URL` would let a test write to the
/// development database before its cleanup path can run.
pub fn database_url() -> String {
  let url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| DEFAULT_TEST_DATABASE_URL.to_string());
  validate_database_url(&url)
    .unwrap_or_else(|reason| panic!("refusing unsafe CLI integration-test database: {reason}"));
  url
}

pub fn validate_database_url(url: &str) -> Result<(), String> {
  let options =
    PgConnectOptions::from_str(url).map_err(|_| "TEST_DATABASE_URL is not a valid PostgreSQL URL".to_string())?;
  if options.get_database() != Some(REQUIRED_TEST_DATABASE) {
    return Err(format!(
      "TEST_DATABASE_URL must select the isolated '{REQUIRED_TEST_DATABASE}' database"
    ));
  }
  if options.get_port() != REQUIRED_TEST_PORT {
    return Err(format!(
      "TEST_DATABASE_URL must point at the isolated test stack on port {REQUIRED_TEST_PORT}"
    ));
  }
  Ok(())
}
