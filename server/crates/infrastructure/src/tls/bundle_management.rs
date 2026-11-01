// SPDX-License-Identifier: AGPL-3.0-or-later
//! File-only additional trust administration. Running transport snapshots are never mutated.

use crate::app_config::{
  acquire_writeback_lock_bounded, decode_writeback_document, set_nested_json, write_bytes_atomic_with_permissions,
};
use chrono::{DateTime, Utc};
use myoxus_contracts::runtime_config::{
  ServerConfigSources, load_server_config_sources, load_server_config_sources_for_candidate, resolve_additional_ca_path,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
  fs,
  io::Read,
  path::{Path, PathBuf},
};

pub const MAX_BUNDLE_BYTES: usize = 1024 * 1024;
const MANAGED_FILE: &str = "additional-ca.pem";
const CONFIG_KEY: &str = "tls.additional_ca_bundle_path";

#[derive(Clone, Debug)]
pub struct BundleMetadata {
  pub fingerprint: String,
  pub certificate_count: usize,
  pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct BundleStatus {
  pub path: Option<String>,
  pub metadata: Option<BundleMetadata>,
  pub file_error: Option<&'static str>,
  pub restriction: Option<&'static str>,
  pub rollback_available: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct BundleError {
  pub code: &'static str,
}
impl BundleError {
  fn new(code: &'static str) -> Self {
    Self { code }
  }
}
type Result<T> = std::result::Result<T, BundleError>;

pub enum BundleAction {
  Apply(Vec<u8>),
  Restore,
  Remove,
}

#[derive(Default, Deserialize)]
struct Bootstrap {
  #[serde(default)]
  tls: myoxus_contracts::runtime_config::TlsConfig,
  #[serde(default)]
  git_sync: LegacyTrust,
}
#[derive(Default, Deserialize)]
struct LegacyTrust {
  https_ca_bundle_path: Option<String>,
}

fn configured_path(sources: ServerConfigSources) -> Result<(PathBuf, Option<String>)> {
  let root = sources
    .paths
    .writeback_path
    .as_ref()
    .and_then(|path| path.parent())
    .unwrap_or(&sources.paths.base_path)
    .canonicalize()
    .map_err(|_| BundleError::new("CA_CONFIG_UNAVAILABLE"))?;
  let config: Bootstrap = sources
    .config
    .try_deserialize()
    .map_err(|_| BundleError::new("CA_CONFIG_UNAVAILABLE"))?;
  let path = resolve_additional_ca_path(
    config.tls.additional_ca_bundle_path.as_deref(),
    config.git_sync.https_ca_bundle_path.as_deref(),
  )
  .map_err(|_| BundleError::new("CA_CONFIG_CONFLICT"))?
  .filter(|path| !path.is_empty());
  Ok((root, path))
}

fn bounded_read(path: &Path) -> Result<Vec<u8>> {
  let file = fs::File::open(path).map_err(|_| BundleError::new("CA_FILE_UNAVAILABLE"))?;
  let mut bytes = Vec::new();
  file
    .take((MAX_BUNDLE_BYTES + 1) as u64)
    .read_to_end(&mut bytes)
    .map_err(|_| BundleError::new("CA_FILE_UNAVAILABLE"))?;
  if bytes.len() > MAX_BUNDLE_BYTES {
    return Err(BundleError::new("CA_TOO_LARGE"));
  }
  Ok(bytes)
}

pub fn inspect_bytes(bytes: &[u8]) -> Result<BundleMetadata> {
  metadata(bytes, true)
}

fn metadata(bytes: &[u8], require_current: bool) -> Result<BundleMetadata> {
  use x509_parser::prelude::FromDer;
  if bytes.len() > MAX_BUNDLE_BYTES {
    return Err(BundleError::new("CA_TOO_LARGE"));
  }
  let certificates = super::parse_ca_pem(bytes, require_current).map_err(|_| BundleError::new("CA_INVALID_BUNDLE"))?;
  let earliest = certificates
    .iter()
    .map(|der| {
      x509_parser::certificate::X509Certificate::from_der(der)
        .map(|(_, cert)| cert.validity().not_after.timestamp())
        .map_err(|_| BundleError::new("CA_INVALID_BUNDLE"))
    })
    .collect::<Result<Vec<_>>>()?
    .into_iter()
    .min()
    .ok_or_else(|| BundleError::new("CA_INVALID_BUNDLE"))?;
  Ok(BundleMetadata {
    fingerprint: hex::encode(Sha256::digest(bytes)),
    certificate_count: certificates.len(),
    expires_at: DateTime::from_timestamp(earliest, 0).ok_or_else(|| BundleError::new("CA_INVALID_BUNDLE"))?,
  })
}

fn backup_path(active: &Path) -> PathBuf {
  let name = active.file_name().unwrap_or_default().to_string_lossy();
  active.with_file_name(format!(".{name}.previous"))
}

/// Never follow a backup symlink: the backup is server-owned, unlike an existing configured path.
fn check_owned_file(path: &Path) -> Result<()> {
  match fs::symlink_metadata(path) {
    Ok(meta) if meta.file_type().is_file() => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    _ => Err(BundleError::new("CA_FILE_UNAVAILABLE")),
  }
}

fn publish(path: &Path, bytes: &[u8]) -> Result<()> {
  publish_with_permissions(path, bytes, None)
}

fn publish_active(path: &Path, bytes: &[u8]) -> Result<()> {
  // Existing operator CA modes survive replacement; YAML/backups keep private writer defaults.
  let permissions = fs::metadata(path)
    .map_err(|_| BundleError::new("CA_FILE_UNAVAILABLE"))?
    .permissions();
  publish_with_permissions(path, bytes, Some(permissions))
}

fn publish_with_permissions(path: &Path, bytes: &[u8], permissions: Option<fs::Permissions>) -> Result<()> {
  write_bytes_atomic_with_permissions(path, bytes, permissions).map_err(|error| {
    if error.published {
      let matches_candidate = bounded_read(path).is_ok_and(|actual| actual == bytes);
      tracing::warn!(
        matches_candidate,
        "CA/config publication visible but directory durability uncertain"
      );
    }
    BundleError::new(if error.published {
      "CA_PUBLICATION_UNCERTAIN"
    } else {
      "CA_WRITE_FAILED"
    })
  })
}

fn env_owned() -> bool {
  [
    "MYOXUS__TLS__ADDITIONAL_CA_BUNDLE_PATH",
    "MYOXUS__GIT_SYNC__HTTPS_CA_BUNDLE_PATH",
  ]
  .iter()
  .any(|key| std::env::var_os(key).is_some())
}

struct Context {
  root: PathBuf,
  configured: Option<String>,
  writeback: Option<PathBuf>,
  restriction: Option<&'static str>,
  _lock: Option<fs::File>,
}
impl Context {
  fn load() -> Result<Self> {
    let sources = load_server_config_sources().map_err(|_| BundleError::new("CA_CONFIG_UNAVAILABLE"))?;
    let writeback = sources.paths.writeback_path.clone();
    // All CA actions, including inspection, share the same lock as YAML writers.
    let lock = writeback
      .as_ref()
      .map(|path| acquire_writeback_lock_bounded(path))
      .transpose();
    let (lock, lock_failed) = match lock {
      Ok(lock) => (lock, false),
      Err(_) => (None, true),
    };
    let sources = load_server_config_sources().map_err(|_| BundleError::new("CA_CONFIG_UNAVAILABLE"))?;
    let (root, configured) = configured_path(sources)?;
    let restriction = if env_owned() {
      Some("CA_ENV_OVERRIDE")
    } else if writeback.is_none()
      || lock_failed
      || writeback.as_ref().is_some_and(|path| {
        fs::metadata(path).is_ok_and(|meta| meta.permissions().readonly())
          || path
            .parent()
            .is_none_or(|parent| fs::metadata(parent).map_or(true, |meta| meta.permissions().readonly()))
      })
    {
      Some("CA_CONFIG_READ_ONLY")
    } else {
      None
    };
    Ok(Self {
      root,
      configured,
      writeback,
      restriction,
      _lock: lock,
    })
  }
  fn active(&self) -> Result<Option<PathBuf>> {
    self
      .configured
      .as_deref()
      .map(|path| {
        let active =
          super::resolve_below_root(&self.root, path).map_err(|_| BundleError::new("CA_FILE_UNAVAILABLE"))?;
        if self.writeback.as_ref().is_some_and(|config| {
          let name = config.file_name().unwrap_or_default().to_string_lossy();
          [config.clone(), config.with_file_name(format!(".{name}.lock"))]
            .iter()
            .any(|protected| protected.canonicalize().is_ok_and(|protected| protected == active))
        }) {
          return Err(BundleError::new("CA_CONFIG_CONFLICT"));
        }
        Ok(active)
      })
      .transpose()
  }
  fn status(&self) -> BundleStatus {
    let bytes = self
      .active()
      .and_then(|path| path.map(|path| bounded_read(&path)).transpose());
    let (metadata, file_error) = match bytes {
      Ok(Some(bytes)) => {
        let file_error = inspect_bytes(&bytes).err().map(|error| error.code);
        (metadata(&bytes, false).ok(), file_error)
      }
      Ok(None) => (None, None),
      Err(error) => (None, Some(error.code)),
    };
    let rollback_available = self.active().ok().flatten().is_some_and(|path| {
      let backup = backup_path(&path);
      check_owned_file(&backup)
        .and_then(|()| bounded_read(&backup))
        .and_then(|bytes| inspect_bytes(&bytes))
        .is_ok_and(|backup| {
          metadata
            .as_ref()
            .is_none_or(|active| active.fingerprint != backup.fingerprint)
        })
    });
    BundleStatus {
      path: self.configured.clone(),
      metadata,
      file_error,
      restriction: self.restriction,
      rollback_available,
    }
  }
  fn candidate_yaml(&self, configured: &str) -> Result<String> {
    let path = self
      .writeback
      .as_ref()
      .ok_or_else(|| BundleError::new("CA_CONFIG_READ_ONLY"))?;
    let original = match fs::read_to_string(path) {
      Ok(value) => value,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
      Err(_) => return Err(BundleError::new("CA_CONFIG_READ_ONLY")),
    };
    let mut document = decode_writeback_document(&original).map_err(|_| BundleError::new("CA_CONFIG_UNAVAILABLE"))?;
    set_nested_json(
      &mut document,
      CONFIG_KEY,
      serde_json::Value::String(configured.to_owned()),
    )
    .map_err(|_| BundleError::new("CA_CONFIG_UNAVAILABLE"))?;
    let yaml = myoxus_contracts::config_document::encode_config_yaml(&document)
      .map_err(|_| BundleError::new("CA_CONFIG_UNAVAILABLE"))?;
    let (_, effective) = configured_path(
      load_server_config_sources_for_candidate(Some(&yaml)).map_err(|_| BundleError::new("CA_CONFIG_CONFLICT"))?,
    )?;
    if effective.as_deref().unwrap_or("") != configured {
      return Err(BundleError::new("CA_CONFIG_CONFLICT"));
    }
    Ok(yaml)
  }
  fn write_config(&self, yaml: &str, expected: &str) -> Result<()> {
    publish(
      self
        .writeback
        .as_ref()
        .ok_or_else(|| BundleError::new("CA_CONFIG_READ_ONLY"))?,
      yaml.as_bytes(),
    )?;
    let (_, effective) =
      configured_path(load_server_config_sources().map_err(|_| BundleError::new("CA_PUBLICATION_UNCERTAIN"))?)
        .map_err(|_| BundleError::new("CA_PUBLICATION_UNCERTAIN"))?;
    if effective.as_deref().unwrap_or("") != expected {
      return Err(BundleError::new("CA_PUBLICATION_UNCERTAIN"));
    }
    Ok(())
  }
}

pub fn inspect() -> Result<BundleStatus> {
  Ok(Context::load()?.status())
}

/// One lock covers both bundle files and bootstrap publication. No database state is involved.
pub fn manage(action: BundleAction) -> Result<BundleStatus> {
  // Invalid input cannot create locks, stage files, or displace the previous backup.
  if let BundleAction::Apply(bytes) = &action {
    inspect_bytes(bytes)?;
  }
  let context = Context::load()?;
  if let Some(code) = context.restriction {
    return Err(BundleError::new(code));
  }
  match action {
    BundleAction::Apply(bytes) => {
      match context.active()? {
        Some(active) => replace(&active, &bytes)?,
        None => {
          let yaml = context.candidate_yaml(MANAGED_FILE)?;
          let active = context.root.join(MANAGED_FILE);
          // Never appropriate an unconfigured operator file, even if it is valid PEM.
          if fs::symlink_metadata(&active).is_ok() {
            return Err(BundleError::new("CA_FILE_EXISTS"));
          }
          if let Err(error) = publish(&active, &bytes) {
            // The path is newly owned and has not been enabled in bootstrap.
            let _ = fs::remove_file(&active);
            return Err(error);
          }
          if let Err(error) = context.write_config(&yaml, MANAGED_FILE) {
            if error.code != "CA_PUBLICATION_UNCERTAIN" {
              let _ = fs::remove_file(&active);
            }
            return Err(error);
          }
        }
      }
    }
    BundleAction::Restore => {
      let active = context
        .active()?
        .ok_or_else(|| BundleError::new("CA_BACKUP_UNAVAILABLE"))?;
      let backup = backup_path(&active);
      check_owned_file(&backup)?;
      let bytes = bounded_read(&backup).map_err(|_| BundleError::new("CA_BACKUP_UNAVAILABLE"))?;
      inspect_bytes(&bytes)?;
      // Retaining this single backup makes an uncertain/retried restore idempotent.
      publish_active(&active, &bytes)?;
    }
    BundleAction::Remove => {
      let active = context.active()?;
      if let Some(path) = &active {
        check_owned_file(&backup_path(path))?;
      }
      let yaml = context.candidate_yaml("")?;
      // An explicit empty value masks base YAML. Confirm bootstrap before touching trust files.
      context.write_config(&yaml, "")?;
      if let Some(active) = active {
        let backup = backup_path(&active);
        check_owned_file(&backup)?;
        for path in [&active, &backup] {
          match fs::remove_file(path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(BundleError::new("CA_CLEANUP_FAILED")),
          }
        }
        fs::File::open(active.parent().ok_or_else(|| BundleError::new("CA_CLEANUP_FAILED"))?)
          .and_then(|directory| directory.sync_all())
          .map_err(|_| BundleError::new("CA_PUBLICATION_UNCERTAIN"))?;
      }
    }
  }
  // Read actual files/configuration; the loaded transport snapshot remains owned by startup.
  drop(context);
  inspect()
}

fn replace(active: &Path, bytes: &[u8]) -> Result<()> {
  if fs::metadata(active).map_or(true, |meta| meta.permissions().readonly()) {
    return Err(BundleError::new("CA_CONFIG_READ_ONLY"));
  }
  let previous = bounded_read(active)?;
  if previous == bytes {
    return Ok(());
  }
  let backup = backup_path(active);
  check_owned_file(&backup)?;
  let old_backup = if backup.exists() {
    Some(bounded_read(&backup)?)
  } else {
    None
  };
  publish(&backup, &previous)?;
  if let Err(error) = publish_active(active, bytes) {
    if error.code != "CA_PUBLICATION_UNCERTAIN" {
      let restored = match old_backup {
        Some(bytes) => publish(&backup, &bytes),
        None => fs::remove_file(&backup).map_err(|_| BundleError::new("CA_WRITE_FAILED")),
      };
      if restored.is_err() {
        return Err(BundleError::new("CA_PUBLICATION_UNCERTAIN"));
      }
    }
    return Err(error);
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;

  fn ca(name: &str) -> Vec<u8> {
    let mut params = rcgen::CertificateParams::new(vec![name.to_owned()]);
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    rcgen::Certificate::from_params(params)
      .expect("CA")
      .serialize_pem()
      .expect("PEM")
      .into_bytes()
  }

  fn child(root: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("test executable"));
    command
      .env_clear()
      .current_dir(root)
      .env("RUN_MODE", "development")
      .env("MYOXUS_CA_TEST_ROOT", root)
      .env("MYOXUS__CONFIG__WRITEBACK_PATH", root.join("runtime/local.yaml"))
      .arg("--exact")
      .arg("tls::bundle_management::tests::file_lifecycle_is_atomic_and_bootstrap_safe")
      .arg("--nocapture");
    command
  }

  // Subprocesses isolate the real bootstrap loader's environment and working directory;
  // no global environment mutation can race other library tests or operator state.
  #[test]
  fn file_lifecycle_is_atomic_and_bootstrap_safe() {
    let Ok(root) = std::env::var("MYOXUS_CA_TEST_ROOT") else {
      let root = tempfile::tempdir().expect("isolated bootstrap");
      fs::create_dir(root.path().join("config")).expect("base directory");
      fs::create_dir(root.path().join("runtime")).expect("runtime directory");
      fs::write(
        root.path().join("config/default.yaml"),
        "tls: {additional_ca_bundle_path: base.pem}\n",
      )
      .expect("base config");
      fs::write(
        root.path().join("runtime/local.yaml"),
        "tls: {additional_ca_bundle_path: ''}\nunrelated: {retained: true}\n",
      )
      .expect("overlay");
      let result = child(root.path()).output().expect("run isolated lifecycle");
      assert!(
        result.status.success(),
        "isolated lifecycle failed: {} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
      );
      assert!(
        String::from_utf8_lossy(&result.stdout).contains("1 passed"),
        "child test must actually execute"
      );
      return;
    };
    let root = PathBuf::from(root);
    let active = root.join("runtime/additional-ca.pem");
    let backup = backup_path(&active);
    if std::env::var_os("MYOXUS_CA_TEST_ENV").is_some() {
      assert_eq!(inspect().expect("inspect ENV").restriction, Some("CA_ENV_OVERRIDE"));
      assert_eq!(
        manage(BundleAction::Remove).expect_err("ENV removal must fail").code,
        "CA_ENV_OVERRIDE"
      );
      assert_eq!(
        bounded_read(&active).expect("retained active"),
        fs::read(root.join("input-b.pem")).expect("input")
      );
      return;
    }
    let a = ca("first.example.test");
    let b = ca("second.example.test");
    fs::write(root.join("input-b.pem"), &b).expect("ENV expected bytes");
    fs::write(root.join("runtime/base.pem"), &a).expect("preserved base-path file");
    let first = manage(BundleAction::Apply(a.clone())).expect("first apply");
    assert_eq!(first.path.as_deref(), Some(MANAGED_FILE));
    assert!(bounded_read(&active).expect("published input") == a);
    assert!(!backup.exists());
    let loaded = super::super::load_bundle(&root.join("runtime"), MANAGED_FILE)
      .expect("load snapshot")
      .expect("bundle");
    #[cfg(unix)]
    {
      use std::os::unix::fs::{MetadataExt, PermissionsExt};
      fs::set_permissions(&active, fs::Permissions::from_mode(0o640)).expect("operator mode");
      manage(BundleAction::Apply(b.clone())).expect("replace");
      assert_eq!(fs::metadata(&active).expect("mode").mode() & 0o777, 0o640);
    }
    #[cfg(not(unix))]
    manage(BundleAction::Apply(b.clone())).expect("replace");
    assert!(bounded_read(&backup).expect("previous input") == a);
    manage(BundleAction::Apply(b.clone())).expect("identical retry");
    assert!(bounded_read(&backup).expect("retry backup") == a);
    assert!(fs::read(loaded.materialized_path()).expect("immutable materialization") == a);
    let mut invalid = rcgen::CertificateParams::default();
    invalid.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    invalid.not_before = rcgen::date_time_ymd(2000, 1, 1);
    invalid.not_after = rcgen::date_time_ymd(2001, 1, 1);
    let expired = rcgen::Certificate::from_params(invalid)
      .expect("expired CA")
      .serialize_pem()
      .expect("PEM")
      .into_bytes();
    for input in [
      Vec::new(),
      b"malformed PEM".to_vec(),
      expired,
      vec![b'x'; MAX_BUNDLE_BYTES + 1],
    ] {
      assert!(manage(BundleAction::Apply(input)).is_err());
      assert!(bounded_read(&active).expect("rejected active") == b);
      assert!(bounded_read(&backup).expect("rejected backup") == a);
    }
    let overlay = root.join("runtime/local.yaml");
    let original_permissions = fs::metadata(&overlay).expect("overlay metadata").permissions();
    let mut read_only = original_permissions.clone();
    read_only.set_readonly(true);
    fs::set_permissions(&overlay, read_only).expect("read-only overlay");
    assert_eq!(
      manage(BundleAction::Remove).expect_err("read-only removal").code,
      "CA_CONFIG_READ_ONLY"
    );
    assert!(active.exists() && backup.exists());
    fs::set_permissions(&overlay, original_permissions).expect("restore overlay mode");
    let result = child(&root)
      .env("MYOXUS_CA_TEST_ENV", "1")
      .env("MYOXUS__TLS__ADDITIONAL_CA_BUNDLE_PATH", MANAGED_FILE)
      .output()
      .expect("ENV child");
    assert!(
      result.status.success(),
      "ENV restriction failed: {}",
      String::from_utf8_lossy(&result.stderr)
    );
    manage(BundleAction::Restore).expect("rollback");
    assert!(bounded_read(&active).expect("restored active") == a);
    assert!(!inspect().expect("restored inspection").rollback_available);
    let writers: Vec<_> = (0..8)
      .map(|index| {
        let bytes = if index % 2 == 0 { a.clone() } else { b.clone() };
        std::thread::spawn(move || manage(BundleAction::Apply(bytes)).expect("concurrent writer"))
      })
      .collect();
    for writer in writers {
      writer.join().expect("writer terminated");
    }
    let current = bounded_read(&active).expect("concurrent active");
    let previous = bounded_read(&backup).expect("concurrent backup");
    assert!(current == a || current == b);
    assert!(previous == a || previous == b);
    assert!(current != previous, "identical retries cannot overwrite previous bytes");
    let yaml = fs::read_to_string(&overlay).expect("persisted overlay");
    let document = decode_writeback_document(&yaml).expect("valid YAML");
    assert_eq!(document.pointer("/unrelated/retained"), Some(&serde_json::json!(true)));
    manage(BundleAction::Remove).expect("remove");
    assert!(!active.exists() && !backup.exists());
    assert!(root.join("runtime/base.pem").exists());
    assert!(
      inspect().expect("disabled bootstrap").path.is_none(),
      "base YAML must remain masked"
    );
    assert_eq!(
      manage(BundleAction::Restore).expect_err("missing backup").code,
      "CA_BACKUP_UNAVAILABLE"
    );
    assert!(fs::read(loaded.materialized_path()).expect("snapshot after removal") == a);
    // A normal operator path ending in .lock is not the bootstrap writer's lock.
    let existing = root.join("runtime/company.lock");
    fs::write(&existing, &a).expect("existing CA");
    fs::write(&overlay, "tls: {additional_ca_bundle_path: company.lock}\n").expect("existing-path configuration");
    assert_eq!(
      manage(BundleAction::Apply(b.clone()))
        .expect("existing path apply")
        .path
        .as_deref(),
      Some("company.lock")
    );
    assert_eq!(bounded_read(&existing).expect("existing path bytes"), b);
    assert_eq!(bounded_read(&backup_path(&existing)).expect("existing path backup"), a);
    manage(BundleAction::Restore).expect("existing path restore");
    assert_eq!(bounded_read(&existing).expect("existing path restored"), a);
    manage(BundleAction::Remove).expect("existing path removal");
    assert!(!existing.exists());
    for protected in ["local.yaml", ".local.yaml.lock"] {
      fs::write(&overlay, format!("tls: {{additional_ca_bundle_path: {protected}}}\n")).expect("misconfigured target");
      let before = fs::read(&overlay).expect("protected YAML");
      assert_eq!(
        manage(BundleAction::Apply(b.clone()))
          .expect_err("bootstrap files must not receive PEM")
          .code,
        "CA_CONFIG_CONFLICT"
      );
      assert_eq!(fs::read(&overlay).expect("retained YAML"), before);
    }
    assert!(
      fs::read_dir(root.join("runtime"))
        .expect("runtime files")
        .all(|entry| { !entry.expect("entry").file_name().to_string_lossy().contains(".tmp.") }),
      "staging files must be cleaned"
    );
  }
}
