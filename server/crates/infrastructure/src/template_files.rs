// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded regular-file capture shared by immutable YAML template families.
use myoxus_contracts::config_document::{ConfigDocumentFormat, decode_config_document};
use myoxus_domain::repositories::RepositoryError;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::{
  io::Read,
  path::{Component, Path},
};

const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CATALOG_BYTES: usize = 64 * 1024 * 1024;
const MAX_REFERENCES: usize = 256;

pub(crate) struct Capture {
  family: &'static str,
  root: std::path::PathBuf,
  bounds: SourceBounds,
}
impl Capture {
  pub(crate) fn new(root: &Path, family: &'static str) -> Result<Self, RepositoryError> {
    let root = root
      .canonicalize()
      .map_err(|error| RepositoryError::Storage(format!("{family} root {}: {error}", root.display())))?;
    Ok(Self {
      root,
      family,
      bounds: SourceBounds::default(),
    })
  }

  pub(crate) fn read(&mut self, relative: &str) -> Result<Vec<u8>, RepositoryError> {
    validate_yaml_path(relative).map_err(|message| self.error(relative, &message))?;
    self
      .bounds
      .reference()
      .map_err(|message| self.error(relative, &message))?;
    let bytes = read_confined_file(&self.root, relative, MAX_FILE_BYTES, self.family)?;
    self
      .bounds
      .bytes(&bytes)
      .map_err(|message| self.error(relative, &message))?;
    Ok(bytes)
  }
  pub(crate) fn read_optional(&mut self, relative: &str) -> Result<Option<Vec<u8>>, RepositoryError> {
    validate_yaml_path(relative).map_err(|message| self.error(relative, &message))?;
    match std::fs::symlink_metadata(self.root.join(relative)) {
      Ok(_) => self.read(relative).map(Some),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
      Err(error) => Err(self.error(relative, &error.to_string())),
    }
  }
  pub(crate) fn error(&self, relative: &str, message: &str) -> RepositoryError {
    RepositoryError::Storage(format!(
      "{} {}: {message}",
      self.family,
      self.root.join(relative).display()
    ))
  }
  pub(crate) fn decode<T: DeserializeOwned + serde::Serialize>(
    &self,
    relative: &str,
    bytes: &[u8],
  ) -> Result<T, RepositoryError> {
    decode_yaml(bytes).map_err(|message| self.error(relative, &message))
  }
}

/// Shared byte limits count logical references, including repeated shared cores.
#[derive(Default)]
pub(crate) struct SourceBounds {
  bytes: usize,
  references: usize,
}
impl SourceBounds {
  pub(crate) fn reference(&mut self) -> Result<(), String> {
    self.references += 1;
    if self.references > MAX_REFERENCES {
      return Err("reference limit exceeded".into());
    }
    Ok(())
  }
  pub(crate) fn bytes(&mut self, bytes: &[u8]) -> Result<(), String> {
    self.bytes += bytes.len();
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES || self.bytes > MAX_CATALOG_BYTES {
      return Err("catalog size limit exceeded".into());
    }
    Ok(())
  }
  pub(crate) fn admit(&mut self, bytes: &[u8]) -> Result<(), String> {
    self.reference()?;
    self.bytes(bytes)
  }
}

pub(crate) fn validate_yaml_path(relative: &str) -> Result<(), String> {
  if !relative.ends_with(".yaml")
    || Path::new(relative)
      .components()
      .any(|part| !matches!(part, Component::Normal(_)))
  {
    return Err("expected a confined .yaml path".into());
  }
  Ok(())
}

/// Uses the bounded duplicate-aware config decoder and rejects ignored native keys.
pub(crate) fn decode_yaml<T: DeserializeOwned + serde::Serialize>(bytes: &[u8]) -> Result<T, String> {
  let text = std::str::from_utf8(bytes).map_err(|_| "input is not UTF-8".to_string())?;
  let value = decode_config_document(text, ConfigDocumentFormat::Yaml).map_err(|error| error.to_string())?;
  let decoded: T = serde_json::from_value(value.clone()).map_err(|error| format!("invalid source schema: {error}"))?;
  let encoded = serde_json::to_value(&decoded).map_err(|_| "source schema serialization failed".to_string())?;
  if encoded != value {
    return Err("source contains unknown or noncanonical native keys".into());
  }
  Ok(decoded)
}

pub(crate) fn verify_sha256(bytes: &[u8], digest: &str) -> Result<(), String> {
  if digest.len() != 64
    || !digest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    || format!("{:x}", Sha256::digest(bytes)) != digest
  {
    return Err("SHA-256 mismatch".into());
  }
  Ok(())
}

/// Read one regular file beneath an already canonical root with the same inode
/// and symlink safeguards as YAML capture. Callers own aggregate byte budgets.
pub(crate) fn read_confined_file(
  root: &Path,
  relative: &str,
  max_bytes: usize,
  family: &str,
) -> Result<Vec<u8>, RepositoryError> {
  let diagnostic =
    |message: &str| RepositoryError::Storage(format!("{family} {}: {message}", root.join(relative).display()));
  if relative.is_empty()
    || Path::new(relative)
      .components()
      .any(|part| !matches!(part, Component::Normal(_)))
  {
    return Err(diagnostic("expected a confined file path"));
  }
  let path = root.join(relative);
  let canonical = path.canonicalize().map_err(|error| diagnostic(&error.to_string()))?;
  if !canonical.starts_with(root) {
    return Err(diagnostic("path escapes root"));
  }
  let mut cursor = root.to_path_buf();
  for component in Path::new(relative).components() {
    cursor.push(component);
    if std::fs::symlink_metadata(&cursor)
      .map_err(|error| diagnostic(&error.to_string()))?
      .file_type()
      .is_symlink()
    {
      return Err(diagnostic("input contains a symlink"));
    }
  }
  let expected = std::fs::metadata(&canonical).map_err(|error| diagnostic(&error.to_string()))?;
  if !expected.is_file() {
    return Err(diagnostic("input must be a regular file"));
  }
  let mut options = std::fs::OpenOptions::new();
  options.read(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
  }
  let file = options
    .open(&canonical)
    .map_err(|error| diagnostic(&error.to_string()))?;
  let opened = file.metadata().map_err(|error| diagnostic(&error.to_string()))?;
  if !opened.is_file() {
    return Err(diagnostic("input changed to a nonregular file"));
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::MetadataExt;
    // The opened inode must still be the confined file checked above.
    if expected.dev() != opened.dev() || expected.ino() != opened.ino() {
      return Err(diagnostic("input changed during capture"));
    }
  }
  let mut bytes = Vec::new();
  file
    .take(max_bytes as u64 + 1)
    .read_to_end(&mut bytes)
    .map_err(|error| diagnostic(&error.to_string()))?;
  if bytes.is_empty() || bytes.len() > max_bytes {
    return Err(diagnostic("file size limit exceeded"));
  }
  Ok(bytes)
}
