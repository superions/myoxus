// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Seek};
use std::path::{Component, Path};

use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use zip::ZipArchive;

use crate::{DecodedAsset, WorkspaceImportDiagnostic, WorkspaceImportDiagnosticCode};

const ZIP_UNIX_FILE_TYPE_MASK: u32 = 0o170000;
const ZIP_UNIX_SYMLINK: u32 = 0o120000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveLimits {
  pub max_entries: usize,
  pub max_entry_bytes: u64,
  pub max_expanded_bytes: u64,
  pub max_compression_ratio: u64,
  pub max_path_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
  pub name: String,
  pub size_bytes: u64,
  pub compressed_size_bytes: u64,
  pub ignored: bool,
  pub directory: bool,
  pub(crate) archive_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveIndex {
  pub entries: Vec<ArchiveEntry>,
  pub expanded_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortableArchiveKind {
  Snapshot,
  RawWorkspace,
  SnapshotIncomplete,
  Unknown,
}

impl ArchiveIndex {
  pub fn entry_names(&self) -> Vec<String> {
    self.entries.iter().map(|entry| entry.name.clone()).collect()
  }

  pub fn ignored_entry_names(&self) -> Vec<String> {
    self
      .entries
      .iter()
      .filter(|entry| entry.ignored)
      .map(|entry| entry.name.clone())
      .collect()
  }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotArchive {
  pub index: ArchiveIndex,
  pub info: Option<Value>,
  pub workspace_tags: Vec<crate::DecodedWorkspaceTag>,
  pub documents: Vec<SnapshotDocument>,
  pub assets: Vec<DecodedAsset>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotDocument {
  pub value: Value,
  pub size_bytes: u64,
}

#[derive(Debug, Error)]
pub enum ArchiveError {
  #[error("{0}")]
  Invalid(String),
  #[error("{0}")]
  Limit(String),
  #[error("{0}")]
  MissingAsset(String),
  #[error("{0}")]
  InvalidSnapshot(String),
}

impl ArchiveError {
  pub fn diagnostic(&self) -> WorkspaceImportDiagnostic {
    match self {
      Self::Invalid(message) => {
        WorkspaceImportDiagnostic::blocking(WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid, message)
      }
      Self::Limit(message) => {
        WorkspaceImportDiagnostic::blocking(WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveLimit, message)
      }
      Self::MissingAsset(message) => {
        WorkspaceImportDiagnostic::blocking(WorkspaceImportDiagnosticCode::MixWorkspaceImportAssetMissing, message)
      }
      Self::InvalidSnapshot(message) => WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSnapshotInvalid,
        message,
      ),
    }
  }
}

fn open_zip(bytes: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, ArchiveError> {
  ZipArchive::new(Cursor::new(bytes))
    .map_err(|_| ArchiveError::Invalid("ZIP_INVALID: invalid ZIP archive for workspace import".to_string()))
}

fn canonical_entry_name(name: &str, max_path_bytes: usize) -> Result<String, ArchiveError> {
  if name.len() > max_path_bytes {
    return Err(ArchiveError::Limit(
      "ZIP_LIMIT_PATH_LENGTH: workspace archive entry path exceeds the configured byte limit".to_string(),
    ));
  }
  if name.is_empty() || name.starts_with('/') || name.starts_with('\\') {
    return Err(ArchiveError::Invalid(
      "ZIP_SLIP_PATH: workspace archive contains an invalid entry path".to_string(),
    ));
  }
  let bytes = name.as_bytes();
  if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
    return Err(ArchiveError::Invalid(
      "ZIP_SLIP_PATH: workspace archive contains an absolute drive path".to_string(),
    ));
  }
  if name.contains('\\') {
    return Err(ArchiveError::Invalid(
      "ZIP_SLIP_PATH: workspace archive paths must use forward slashes".to_string(),
    ));
  }

  let mut segments = Vec::new();
  for component in Path::new(name.trim_end_matches('/')).components() {
    match component {
      Component::Normal(segment) => {
        let segment = segment.to_string_lossy();
        if segment.is_empty() || segment == "." {
          continue;
        }
        segments.push(segment.into_owned());
      }
      Component::CurDir => {}
      Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
        return Err(ArchiveError::Invalid(
          "ZIP_SLIP_PATH: workspace archive contains a traversal path".to_string(),
        ));
      }
    }
  }
  if segments.is_empty() {
    return Err(ArchiveError::Invalid(
      "ZIP_SLIP_PATH: workspace archive contains an empty canonical path".to_string(),
    ));
  }
  Ok(segments.join("/"))
}

pub fn is_ignored_archive_entry(name: &str) -> bool {
  let trimmed = name.trim_end_matches('/');
  trimmed == ".DS_Store"
    || trimmed.starts_with("__MACOSX/")
    || trimmed
      .rsplit('/')
      .next()
      .map(|segment| segment == ".DS_Store" || segment.starts_with("._"))
      .unwrap_or(false)
}

pub fn is_snapshot_json_path(name: &str) -> bool {
  let base = name.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
  base.ends_with(".snapshot.json") && base != ".snapshot.json"
}

/// Classify portable workspace structure from canonical archive entry names.
/// Transport filenames and extensions are intentionally absent from this API.
pub fn detect_portable_archive_kind(entry_names: &[String]) -> PortableArchiveKind {
  let mut has_snapshot = false;
  let mut has_workspace_marker = false;
  let mut has_snapshot_hint = false;
  for name in entry_names {
    if is_ignored_archive_entry(name) {
      continue;
    }
    let lower = name.to_ascii_lowercase();
    let base = lower.rsplit('/').next().unwrap_or_default();
    has_snapshot |= is_snapshot_json_path(&lower);
    has_snapshot_hint |= base == "info.json" || lower.starts_with("assets/") || lower.contains("/assets/");
    has_workspace_marker |= lower.contains("/doc-data/")
      || lower.starts_with("doc-data/")
      || lower.contains("workspace")
      || base.ends_with(".snapshot")
      || base.ends_with(".yjs");
  }
  if has_snapshot {
    PortableArchiveKind::Snapshot
  } else if has_snapshot_hint {
    PortableArchiveKind::SnapshotIncomplete
  } else if has_workspace_marker {
    PortableArchiveKind::RawWorkspace
  } else {
    PortableArchiveKind::Unknown
  }
}

pub(crate) fn inspect_zip_archive<R: Read + Seek>(
  archive: &mut ZipArchive<R>,
  limits: ArchiveLimits,
) -> Result<ArchiveIndex, ArchiveError> {
  if archive.len() > limits.max_entries {
    return Err(ArchiveError::Limit(
      "ZIP_LIMIT_ENTRIES: workspace archive contains too many entries".to_string(),
    ));
  }

  let mut names = HashSet::new();
  let mut entries = Vec::with_capacity(archive.len());
  let mut expanded_bytes = 0_u64;
  for index in 0..archive.len() {
    let file = archive.by_index(index).map_err(|_| {
      ArchiveError::Invalid("ZIP_ENTRY_INVALID: workspace archive entry cannot be inspected".to_string())
    })?;
    let directory = file.is_dir();
    let name = file.name().map_err(|_| {
      ArchiveError::Invalid("ZIP_ENTRY_INVALID: workspace archive entry name cannot be decoded".to_string())
    })?;
    let canonical = canonical_entry_name(&name, limits.max_path_bytes)?;
    let duplicate_key = canonical.to_ascii_lowercase();
    if !names.insert(duplicate_key) {
      return Err(ArchiveError::Invalid(
        "ZIP_DUPLICATE_ENTRY: workspace archive contains duplicate canonical entries".to_string(),
      ));
    }
    if file
      .unix_mode()
      .is_some_and(|mode| mode & ZIP_UNIX_FILE_TYPE_MASK == ZIP_UNIX_SYMLINK)
    {
      return Err(ArchiveError::Invalid(
        "ZIP_SYMLINK_ENTRY: workspace archive contains a symlink-like entry".to_string(),
      ));
    }
    if file.size() > limits.max_entry_bytes {
      return Err(ArchiveError::Limit(
        "ZIP_LIMIT_FILE_SIZE: workspace archive entry exceeds the configured byte limit".to_string(),
      ));
    }
    if file.compressed_size() == 0 && file.size() > 0 {
      return Err(ArchiveError::Limit(
        "ZIP_LIMIT_COMPRESSION_RATIO: workspace archive entry has an invalid compression ratio".to_string(),
      ));
    }
    if file.compressed_size() > 0 && file.size() > file.compressed_size().saturating_mul(limits.max_compression_ratio) {
      return Err(ArchiveError::Limit(
        "ZIP_LIMIT_COMPRESSION_RATIO: workspace archive entry exceeds the configured compression ratio".to_string(),
      ));
    }
    expanded_bytes = expanded_bytes.checked_add(file.size()).ok_or_else(|| {
      ArchiveError::Limit("ZIP_LIMIT_TOTAL_SIZE: workspace archive expanded size overflow".to_string())
    })?;
    if expanded_bytes > limits.max_expanded_bytes {
      return Err(ArchiveError::Limit(
        "ZIP_LIMIT_TOTAL_SIZE: workspace archive exceeds the configured expanded byte limit".to_string(),
      ));
    }
    entries.push(ArchiveEntry {
      ignored: is_ignored_archive_entry(&canonical),
      name: canonical,
      size_bytes: file.size(),
      compressed_size_bytes: file.compressed_size(),
      directory,
      archive_name: name.into_owned(),
    });
  }
  entries.sort_by(|left, right| left.name.cmp(&right.name));
  Ok(ArchiveIndex {
    entries,
    expanded_bytes,
  })
}

pub fn inspect_zip_bytes(bytes: &[u8], limits: ArchiveLimits) -> Result<ArchiveIndex, ArchiveError> {
  inspect_zip_archive(&mut open_zip(bytes)?, limits)
}

fn hash_entry<R: Read + Seek>(archive: &mut ZipArchive<R>, name: &str, limit: u64) -> Result<String, ArchiveError> {
  let mut entry = archive
    .by_name(name)
    .map_err(|_| ArchiveError::Invalid("workspace archive entry cannot be opened".to_string()))?;
  if entry.size() > limit {
    return Err(ArchiveError::Limit(
      "workspace archive entry exceeds the configured byte limit".to_string(),
    ));
  }
  let mut hasher = Sha256::new();
  let mut total = 0_u64;
  let mut buffer = [0_u8; 64 * 1024];
  loop {
    let read = entry
      .read(&mut buffer)
      .map_err(|_| ArchiveError::Invalid("workspace archive entry cannot be read".to_string()))?;
    if read == 0 {
      break;
    }
    total = total.saturating_add(read as u64);
    if total > limit {
      return Err(ArchiveError::Limit(
        "workspace archive entry exceeds the configured byte limit".to_string(),
      ));
    }
    hasher.update(&buffer[..read]);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn normalize_asset_key(name: &str) -> Option<String> {
  let trimmed = name.trim_end_matches('/');
  if let Some(key) = trimmed.strip_prefix("assets/") {
    return (!key.is_empty()).then(|| format!("assets/{key}"));
  }
  trimmed.find("/assets/").map(|index| trimmed[index + 1..].to_string())
}

pub fn asset_aliases(key: &str) -> Vec<String> {
  let mut aliases = vec![key.to_string()];
  if let Some(value) = key.strip_prefix("assets/") {
    aliases.push(value.to_string());
  }
  aliases.extend(
    aliases
      .clone()
      .into_iter()
      .filter_map(|alias| strip_last_extension(&alias).map(str::to_string)),
  );
  aliases.sort();
  aliases.dedup();
  aliases
}

fn strip_last_extension(value: &str) -> Option<&str> {
  let (stem, extension) = value.rsplit_once('.')?;
  (!extension.contains('/') && !extension.is_empty()).then_some(stem)
}

fn collect_asset_references(value: &Value, references: &mut Vec<String>) {
  match value {
    Value::Object(map) => {
      for (key, value) in map {
        if matches!(key.as_str(), "sourceId" | "source_id")
          && let Some(value) = value.as_str()
          && !value.trim().is_empty()
        {
          references.push(value.trim().trim_start_matches('/').to_string());
        }
        collect_asset_references(value, references);
      }
    }
    Value::Array(values) => {
      for value in values {
        collect_asset_references(value, references);
      }
    }
    _ => {}
  }
}

fn asset_reference_candidates(reference: &str) -> Vec<String> {
  let normalized = reference.trim_start_matches('/');
  let mut values = vec![normalized.to_string()];
  if !normalized.starts_with("assets/") {
    values.push(format!("assets/{normalized}"));
  }
  if let Some(value) = normalized.strip_prefix("workspace/") {
    values.push(value.to_string());
    if !value.starts_with("assets/") {
      values.push(format!("assets/{value}"));
    }
  }
  values.sort();
  values.dedup();
  values
}

/// Validate and decode the neutral upstream snapshot structure. Asset bytes
/// are hashed one entry at a time and are not retained in the returned model.
pub fn validate_snapshot_archive(bytes: &[u8], limits: ArchiveLimits) -> Result<SnapshotArchive, ArchiveError> {
  validate_snapshot_archive_reader(open_zip(bytes)?, limits)
}

/// Validate a snapshot archive directly from a staged seekable reader. This is
/// the worker-facing path and avoids materializing the complete upload in RAM.
pub fn validate_snapshot_archive_reader<R: Read + Seek>(
  mut archive: ZipArchive<R>,
  limits: ArchiveLimits,
) -> Result<SnapshotArchive, ArchiveError> {
  let index = inspect_zip_archive(&mut archive, limits)?;
  if index.entries.iter().any(|entry| {
    if entry.ignored || entry.directory || is_snapshot_json_path(&entry.name) {
      return false;
    }
    let base = entry.name.rsplit('/').next().unwrap_or_default();
    !base.eq_ignore_ascii_case("info.json") && normalize_asset_key(&entry.name).is_none()
  }) {
    return Err(ArchiveError::InvalidSnapshot(
      "SNAPSHOT_ENTRY_UNSUPPORTED: workspace snapshot archive contains an unsupported entry".to_string(),
    ));
  }
  let snapshot_names = index
    .entries
    .iter()
    .filter(|entry| !entry.ignored && !entry.directory && is_snapshot_json_path(&entry.name))
    .map(|entry| (entry.name.clone(), entry.archive_name.clone()))
    .collect::<Vec<_>>();
  if snapshot_names.is_empty() {
    return Err(ArchiveError::InvalidSnapshot(
      "SNAPSHOT_ENTRY_MISSING: workspace snapshot archive has no document snapshots".to_string(),
    ));
  }

  let info_names = index
    .entries
    .iter()
    .filter(|entry| {
      !entry.ignored
        && !entry.directory
        && entry
          .name
          .rsplit('/')
          .next()
          .is_some_and(|name| name.eq_ignore_ascii_case("info.json"))
    })
    .map(|entry| (entry.name.clone(), entry.archive_name.clone()))
    .collect::<Vec<_>>();
  if info_names.len() > 1 {
    return Err(ArchiveError::InvalidSnapshot(
      "INFO_JSON_DUPLICATE: workspace snapshot archive contains multiple info records".to_string(),
    ));
  }

  let asset_names = index
    .entries
    .iter()
    .filter_map(|entry| {
      (!entry.ignored && !entry.directory)
        .then(|| normalize_asset_key(&entry.name))
        .flatten()
        .map(|key| (entry.archive_name.clone(), key, entry.size_bytes))
    })
    .collect::<Vec<_>>();
  let mut assets_by_key = HashMap::<String, DecodedAsset>::with_capacity(asset_names.len());
  let mut asset_alias_index = HashMap::<String, String>::new();
  for (entry_name, source_key, size_bytes) in asset_names {
    let content_hash = hash_entry(&mut archive, &entry_name, limits.max_entry_bytes)?;
    for alias in asset_aliases(&source_key) {
      if let Some(existing_hash) = asset_alias_index.insert(alias, content_hash.clone())
        && existing_hash != content_hash
      {
        return Err(ArchiveError::InvalidSnapshot(
          "SNAPSHOT_ASSET_ALIAS_CONFLICT: workspace snapshot archive has an ambiguous asset alias".to_string(),
        ));
      }
    }
    if let Some(existing) = assets_by_key.get(&source_key)
      && existing.content_hash != content_hash
    {
      return Err(ArchiveError::InvalidSnapshot(
        "SNAPSHOT_ASSET_ALIAS_CONFLICT: workspace snapshot archive has an ambiguous asset alias".to_string(),
      ));
    }
    assets_by_key.entry(source_key.clone()).or_insert(DecodedAsset {
      source_key,
      size_bytes,
      content_hash,
    });
  }

  let mut documents = Vec::with_capacity(snapshot_names.len());
  for (snapshot_index, (_, archive_name)) in snapshot_names.into_iter().enumerate() {
    let mut entry = archive
      .by_name(&archive_name)
      .map_err(|_| ArchiveError::Invalid("workspace archive entry cannot be opened".to_string()))?;
    let size_bytes = entry.size();
    let value: Value =
      serde_json::from_reader((&mut entry).take(limits.max_entry_bytes.saturating_add(1))).map_err(|_| {
        ArchiveError::InvalidSnapshot(format!(
          "SNAPSHOT_JSON_INVALID: workspace document snapshot at /snapshots/{snapshot_index} is not valid JSON"
        ))
      })?;
    let object = value.as_object().ok_or_else(|| {
      ArchiveError::InvalidSnapshot(format!(
        "SNAPSHOT_STRUCTURE_INVALID: workspace document snapshot at /snapshots/{snapshot_index} must be an object"
      ))
    })?;
    let has_id = object
      .get("meta")
      .and_then(Value::as_object)
      .and_then(|meta| meta.get("id"))
      .and_then(Value::as_str)
      .is_some_and(|id| !id.trim().is_empty());
    if !has_id {
      return Err(ArchiveError::InvalidSnapshot(format!(
        "SNAPSHOT_META_ID_MISSING: workspace document snapshot is missing /snapshots/{snapshot_index}/meta/id"
      )));
    }
    let Some(blocks) = object.get("blocks") else {
      return Err(ArchiveError::InvalidSnapshot(format!(
        "SNAPSHOT_BLOCKS_MISSING: workspace document snapshot is missing /snapshots/{snapshot_index}/blocks"
      )));
    };
    if !blocks.is_array() && !blocks.is_object() {
      return Err(ArchiveError::InvalidSnapshot(format!(
        "SNAPSHOT_BLOCKS_INVALID: workspace document snapshot has invalid /snapshots/{snapshot_index}/blocks"
      )));
    }
    let mut references = Vec::new();
    collect_asset_references(&value, &mut references);
    for reference in references {
      if !asset_reference_candidates(&reference)
        .iter()
        .any(|candidate| asset_alias_index.contains_key(candidate))
      {
        return Err(ArchiveError::MissingAsset(format!(
          "SNAPSHOT_ASSET_REFERENCE_MISSING: workspace document snapshot references a missing declared asset at /snapshots/{snapshot_index}"
        )));
      }
    }
    documents.push(SnapshotDocument { value, size_bytes });
  }

  let info = info_names
    .first()
    .map(|(_, archive_name)| {
      let mut entry = archive
        .by_name(archive_name)
        .map_err(|_| ArchiveError::Invalid("workspace archive entry cannot be opened".to_string()))?;
      let value: Value =
        serde_json::from_reader((&mut entry).take(limits.max_entry_bytes.saturating_add(1))).map_err(|_| {
          ArchiveError::InvalidSnapshot(
            "INFO_JSON_INVALID: workspace snapshot info record is not valid JSON".to_string(),
          )
        })?;
      value.as_object().ok_or_else(|| {
        ArchiveError::InvalidSnapshot("INFO_JSON_INVALID: workspace snapshot info record must be an object".to_string())
      })?;
      Ok(value)
    })
    .transpose()?;

  let mut assets = assets_by_key.into_values().collect::<Vec<_>>();
  assets.sort_by(|left, right| left.source_key.cmp(&right.source_key));
  let workspace_tags = serde_json::from_value(
    info
      .as_ref()
      .and_then(|info| info.get("workspaceTags"))
      .cloned()
      .unwrap_or_else(|| serde_json::json!([])),
  )
  .map_err(|_| ArchiveError::InvalidSnapshot("INFO_LABELS_INVALID: portable label catalog is invalid".into()))?;
  Ok(SnapshotArchive {
    workspace_tags,
    index,
    info,
    documents,
    assets,
  })
}
