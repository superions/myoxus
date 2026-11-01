// SPDX-License-Identifier: AGPL-3.0-or-later
//! Physical ownership for managed Git-Sync mirror directories.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

const STAGING_METADATA_FILE: &str = "ownership.json";
const STAGING_REPOSITORY_DIR: &str = "mirror";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MirrorPathState {
  Absent { canonical_path: PathBuf },
  Existing { canonical_path: PathBuf },
}

impl MirrorPathState {
  pub fn canonical_path(&self) -> &Path {
    match self {
      Self::Absent { canonical_path } | Self::Existing { canonical_path } => canonical_path,
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagingOwnership {
  pub version: u8,
  pub profile_id: Uuid,
  pub attempt_id: Uuid,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct StagedMirror {
  root_path: PathBuf,
  repository_path: PathBuf,
  metadata_path: PathBuf,
  ownership: StagingOwnership,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagingCleanupCandidate {
  pub root_path: PathBuf,
  pub ownership: StagingOwnership,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MirrorCleanupInventory {
  pub canonical_profile_ids: Vec<Uuid>,
  pub staging: Vec<StagingCleanupCandidate>,
  pub retained_unknown_entries: usize,
}

impl StagedMirror {
  pub fn root_path(&self) -> &Path {
    &self.root_path
  }

  pub fn repository_path(&self) -> &Path {
    &self.repository_path
  }

  pub fn metadata_path(&self) -> &Path {
    &self.metadata_path
  }

  pub fn ownership(&self) -> &StagingOwnership {
    &self.ownership
  }
}

#[derive(Debug, Error)]
pub enum MirrorStorageError {
  #[error("unsafe managed mirror path: {0}")]
  Unsafe(String),
  #[error("managed mirror destination already exists: {0}")]
  DestinationExists(PathBuf),
  #[error("atomic no-replace directory publication is unsupported on this platform")]
  PublicationUnsupported,
  #[error("managed mirror filesystem error: {0}")]
  Filesystem(#[from] io::Error),
  #[error("invalid staging ownership metadata: {0}")]
  Metadata(String),
}

/// A process-independent exclusive lock for one canonical profile mirror.
///
/// The stable lock file is intentionally retained after unlock. Removing it
/// could let concurrent processes lock different inodes for the same profile.
#[derive(Debug)]
pub struct MirrorDirectoryGuard {
  file: File,
  lock_path: PathBuf,
  mirror_path: PathBuf,
}

impl MirrorDirectoryGuard {
  pub fn mirror_path(&self) -> &Path {
    &self.mirror_path
  }

  pub fn lock_path(&self) -> &Path {
    &self.lock_path
  }
}

impl Drop for MirrorDirectoryGuard {
  fn drop(&mut self) {
    let _ = FileExt::unlock(&self.file);
  }
}

#[derive(Debug, Error)]
pub enum MirrorLockError {
  #[error("mirror is already owned by another native operation")]
  Busy,
  #[error("unsafe mirror lock path: {0}")]
  Unsafe(String),
  #[error("mirror lock filesystem error: {0}")]
  Filesystem(#[from] io::Error),
}

/// Acquire the stable physical guard for `<repo_base>/<profile_uuid>`.
///
/// The caller must already own the distributed profile lease. Filesystems
/// that cannot provide a verifiable advisory lock fail closed.
pub async fn acquire_profile_mirror(
  repo_base: &Path,
  profile_id: Uuid,
) -> Result<MirrorDirectoryGuard, MirrorLockError> {
  let repo_base = repo_base.to_path_buf();
  tokio::task::spawn_blocking(move || acquire_profile_mirror_blocking(&repo_base, profile_id))
    .await
    .map_err(|error| MirrorLockError::Unsafe(format!("mirror lock worker failed: {error}")))?
}

fn acquire_profile_mirror_blocking(
  repo_base: &Path,
  profile_id: Uuid,
) -> Result<MirrorDirectoryGuard, MirrorLockError> {
  std::fs::create_dir_all(repo_base)?;
  let canonical_base = std::fs::canonicalize(repo_base)?;
  let base_metadata = std::fs::symlink_metadata(repo_base)?;
  if base_metadata.file_type().is_symlink() || !base_metadata.is_dir() {
    return Err(MirrorLockError::Unsafe(format!(
      "repository base is not a physical directory: {}",
      repo_base.display()
    )));
  }

  let locks_dir = canonical_base.join(".locks");
  match std::fs::symlink_metadata(&locks_dir) {
    Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
      return Err(MirrorLockError::Unsafe(format!(
        "reserved lock path is not a physical directory: {}",
        locks_dir.display()
      )));
    }
    Ok(_) => {}
    Err(error) if error.kind() == io::ErrorKind::NotFound => std::fs::create_dir(&locks_dir)?,
    Err(error) => return Err(error.into()),
  }
  let canonical_locks = std::fs::canonicalize(&locks_dir)?;
  if canonical_locks.parent() != Some(canonical_base.as_path()) {
    return Err(MirrorLockError::Unsafe(format!(
      "reserved lock directory escaped repository base: {}",
      canonical_locks.display()
    )));
  }

  let lock_path = canonical_locks.join(format!("{profile_id}.lock"));
  if let Ok(metadata) = std::fs::symlink_metadata(&lock_path)
    && (metadata.file_type().is_symlink() || !metadata.is_file())
  {
    return Err(MirrorLockError::Unsafe(format!(
      "profile lock is not a regular file: {}",
      lock_path.display()
    )));
  }

  let mut options = OpenOptions::new();
  options.read(true).write(true).create(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    options.mode(0o600);
  }
  let file = options.open(&lock_path)?;
  let metadata = file.metadata()?;
  if !metadata.is_file() {
    return Err(MirrorLockError::Unsafe(format!(
      "opened profile lock is not a regular file: {}",
      lock_path.display()
    )));
  }
  match file.try_lock_exclusive() {
    Ok(()) => {}
    Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Err(MirrorLockError::Busy),
    Err(error) => return Err(MirrorLockError::Filesystem(error)),
  }

  Ok(MirrorDirectoryGuard {
    file,
    lock_path,
    mirror_path: canonical_base.join(profile_id.to_string()),
  })
}

/// Inspect exactly `<canonical repo base>/<profile_uuid>` without following a
/// symlink or treating permission and metadata errors as absence.
pub async fn inspect_profile_mirror(repo_base: &Path, profile_id: Uuid) -> Result<MirrorPathState, MirrorStorageError> {
  let repo_base = repo_base.to_path_buf();
  tokio::task::spawn_blocking(move || inspect_profile_mirror_blocking(&repo_base, profile_id))
    .await
    .map_err(|error| MirrorStorageError::Unsafe(format!("mirror inspection worker failed: {error}")))?
}

fn inspect_profile_mirror_blocking(repo_base: &Path, profile_id: Uuid) -> Result<MirrorPathState, MirrorStorageError> {
  let canonical_base = std::fs::canonicalize(repo_base)?;
  let canonical_path = canonical_base.join(profile_id.to_string());
  match std::fs::symlink_metadata(&canonical_path) {
    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(MirrorPathState::Absent { canonical_path }),
    Err(error) => Err(error.into()),
    Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
      Err(MirrorStorageError::Unsafe(format!(
        "canonical mirror is not a physical directory: {}",
        canonical_path.display()
      )))
    }
    Ok(_) => {
      let observed = std::fs::canonicalize(&canonical_path)?;
      if observed != canonical_path {
        return Err(MirrorStorageError::Unsafe(format!(
          "canonical mirror resolved to an unexpected path: {}",
          observed.display()
        )));
      }
      Ok(MirrorPathState::Existing { canonical_path })
    }
  }
}

/// Create a unique attempt-owned staging container on the mirror filesystem.
/// The repository itself is cloned into the still-absent `mirror` child.
pub async fn create_staged_mirror(
  repo_base: &Path,
  profile_id: Uuid,
  attempt_id: Uuid,
) -> Result<StagedMirror, MirrorStorageError> {
  let repo_base = repo_base.to_path_buf();
  tokio::task::spawn_blocking(move || create_staged_mirror_blocking(&repo_base, profile_id, attempt_id))
    .await
    .map_err(|error| MirrorStorageError::Unsafe(format!("staging worker failed: {error}")))?
}

fn create_staged_mirror_blocking(
  repo_base: &Path,
  profile_id: Uuid,
  attempt_id: Uuid,
) -> Result<StagedMirror, MirrorStorageError> {
  let canonical_base = std::fs::canonicalize(repo_base)?;
  let staging_base = ensure_physical_directory(&canonical_base.join(".staging"))?;
  let profile_base = ensure_physical_directory(&staging_base.join(profile_id.to_string()))?;
  if profile_base.parent() != Some(staging_base.as_path()) {
    return Err(MirrorStorageError::Unsafe(format!(
      "profile staging directory escaped reserved staging root: {}",
      profile_base.display()
    )));
  }

  let root_path = profile_base.join(format!("{attempt_id}-{}", Uuid::new_v4()));
  std::fs::create_dir(&root_path)?;
  let ownership = StagingOwnership {
    version: 1,
    profile_id,
    attempt_id,
    created_at: Utc::now(),
  };
  let metadata_path = root_path.join(STAGING_METADATA_FILE);
  let metadata = serde_json::to_vec(&ownership)
    .map_err(|error| MirrorStorageError::Metadata(format!("serialize ownership metadata: {error}")))?;
  let mut options = OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    options.mode(0o600);
  }
  let mut file = options.open(&metadata_path)?;
  use std::io::Write;
  file.write_all(&metadata)?;
  file.sync_all()?;

  Ok(StagedMirror {
    repository_path: root_path.join(STAGING_REPOSITORY_DIR),
    root_path,
    metadata_path,
    ownership,
  })
}

/// Publish a completely verified staged repository into an absent canonical
/// profile path. The filesystem primitive must provide no-replace semantics.
pub async fn publish_staged_mirror(
  staged: &StagedMirror,
  repo_base: &Path,
  profile_id: Uuid,
) -> Result<PathBuf, MirrorStorageError> {
  let staged = staged.clone();
  let repo_base = repo_base.to_path_buf();
  tokio::task::spawn_blocking(move || publish_staged_mirror_blocking(&staged, &repo_base, profile_id))
    .await
    .map_err(|error| MirrorStorageError::Unsafe(format!("publication worker failed: {error}")))?
}

/// Enumerate only cleanup candidates with a structurally proven owner.
/// Reserved lock files and unknown names remain untouched. Any symlink or
/// malformed metadata in an otherwise owned staging path fails the complete
/// inventory so maintenance cannot proceed from partial evidence.
pub async fn inspect_cleanup_inventory(repo_base: &Path) -> Result<MirrorCleanupInventory, MirrorStorageError> {
  let repo_base = repo_base.to_path_buf();
  tokio::task::spawn_blocking(move || inspect_cleanup_inventory_blocking(&repo_base))
    .await
    .map_err(|error| MirrorStorageError::Unsafe(format!("cleanup inventory worker failed: {error}")))?
}

fn inspect_cleanup_inventory_blocking(repo_base: &Path) -> Result<MirrorCleanupInventory, MirrorStorageError> {
  match std::fs::symlink_metadata(repo_base) {
    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(MirrorCleanupInventory::default()),
    Err(error) => return Err(error.into()),
    Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
      return Err(MirrorStorageError::Unsafe(format!(
        "repository base is not a physical directory: {}",
        repo_base.display()
      )));
    }
    Ok(_) => {}
  }
  let canonical_base = std::fs::canonicalize(repo_base)?;
  let mut inventory = MirrorCleanupInventory::default();
  for entry in std::fs::read_dir(&canonical_base)? {
    let entry = entry?;
    let name = entry.file_name();
    let name = name.to_string_lossy();
    if name == ".locks" {
      let metadata = entry.file_type()?;
      if metadata.is_symlink() || !metadata.is_dir() {
        return Err(MirrorStorageError::Unsafe(format!(
          "reserved lock path is not a physical directory: {}",
          entry.path().display()
        )));
      }
      continue;
    }
    if name == ".staging" {
      inspect_staging_inventory(&canonical_base, &entry.path(), &mut inventory)?;
      continue;
    }
    let Ok(profile_id) = Uuid::parse_str(&name) else {
      inventory.retained_unknown_entries += 1;
      continue;
    };
    let metadata = entry.file_type()?;
    if metadata.is_symlink() || !metadata.is_dir() {
      return Err(MirrorStorageError::Unsafe(format!(
        "canonical cleanup candidate is not a physical directory: {}",
        entry.path().display()
      )));
    }
    let observed = std::fs::canonicalize(entry.path())?;
    let expected_name = profile_id.to_string();
    if observed.parent() != Some(canonical_base.as_path()) || observed.file_name() != Some(expected_name.as_ref()) {
      return Err(MirrorStorageError::Unsafe(format!(
        "canonical cleanup candidate escaped repository base: {}",
        observed.display()
      )));
    }
    inventory.canonical_profile_ids.push(profile_id);
  }
  Ok(inventory)
}

fn inspect_staging_inventory(
  canonical_base: &Path,
  staging_path: &Path,
  inventory: &mut MirrorCleanupInventory,
) -> Result<(), MirrorStorageError> {
  let metadata = std::fs::symlink_metadata(staging_path)?;
  if metadata.file_type().is_symlink() || !metadata.is_dir() {
    return Err(MirrorStorageError::Unsafe(format!(
      "reserved staging path is not a physical directory: {}",
      staging_path.display()
    )));
  }
  let canonical_staging = std::fs::canonicalize(staging_path)?;
  if canonical_staging.parent() != Some(canonical_base) {
    return Err(MirrorStorageError::Unsafe(format!(
      "reserved staging path escaped repository base: {}",
      canonical_staging.display()
    )));
  }
  for profile_entry in std::fs::read_dir(&canonical_staging)? {
    let profile_entry = profile_entry?;
    let profile_name = profile_entry.file_name();
    let Ok(profile_id) = Uuid::parse_str(profile_name.to_string_lossy().as_ref()) else {
      inventory.retained_unknown_entries += 1;
      continue;
    };
    let file_type = profile_entry.file_type()?;
    if file_type.is_symlink() || !file_type.is_dir() {
      return Err(MirrorStorageError::Unsafe(format!(
        "profile staging path is not a physical directory: {}",
        profile_entry.path().display()
      )));
    }
    let profile_path = std::fs::canonicalize(profile_entry.path())?;
    let expected_profile_name = profile_id.to_string();
    if profile_path.parent() != Some(canonical_staging.as_path())
      || profile_path.file_name() != Some(expected_profile_name.as_ref())
    {
      return Err(MirrorStorageError::Unsafe(format!(
        "profile staging path escaped reserved staging root: {}",
        profile_path.display()
      )));
    }
    for attempt_entry in std::fs::read_dir(&profile_path)? {
      let attempt_entry = attempt_entry?;
      let file_type = attempt_entry.file_type()?;
      if file_type.is_symlink() || !file_type.is_dir() {
        return Err(MirrorStorageError::Unsafe(format!(
          "attempt staging path is not a physical directory: {}",
          attempt_entry.path().display()
        )));
      }
      let root_path = std::fs::canonicalize(attempt_entry.path())?;
      if root_path.parent() != Some(profile_path.as_path()) {
        return Err(MirrorStorageError::Unsafe(format!(
          "attempt staging path escaped profile staging root: {}",
          root_path.display()
        )));
      }
      let metadata_path = root_path.join(STAGING_METADATA_FILE);
      let metadata_file = std::fs::symlink_metadata(&metadata_path)?;
      if metadata_file.file_type().is_symlink() || !metadata_file.is_file() {
        return Err(MirrorStorageError::Unsafe(format!(
          "staging ownership metadata is not a physical file: {}",
          metadata_path.display()
        )));
      }
      let ownership: StagingOwnership = serde_json::from_slice(&std::fs::read(&metadata_path)?)
        .map_err(|error| MirrorStorageError::Metadata(format!("parse {}: {error}", metadata_path.display())))?;
      if ownership.version != 1
        || ownership.profile_id != profile_id
        || !staging_attempt_name_matches(
          attempt_entry.file_name().to_string_lossy().as_ref(),
          ownership.attempt_id,
        )
      {
        return Err(MirrorStorageError::Metadata(format!(
          "staging ownership does not match bounded path {}",
          root_path.display()
        )));
      }
      inventory.staging.push(StagingCleanupCandidate { root_path, ownership });
    }
  }
  Ok(())
}

fn staging_attempt_name_matches(name: &str, attempt_id: Uuid) -> bool {
  name.len() == 73
    && name.as_bytes().get(36) == Some(&b'-')
    && name.get(..36) == Some(attempt_id.to_string().as_str())
    && name.get(37..).is_some_and(|nonce| Uuid::parse_str(nonce).is_ok())
}

/// Remove one canonical mirror only after revalidating its exact bounded path.
/// Callers must hold distributed and physical profile ownership.
pub async fn remove_canonical_mirror(repo_base: &Path, profile_id: Uuid) -> Result<bool, MirrorStorageError> {
  let repo_base = repo_base.to_path_buf();
  tokio::task::spawn_blocking(move || match inspect_profile_mirror_blocking(&repo_base, profile_id)? {
    MirrorPathState::Absent { .. } => Ok(false),
    MirrorPathState::Existing { canonical_path } => {
      std::fs::remove_dir_all(&canonical_path)?;
      sync_directory(canonical_path.parent().expect("canonical mirror has parent"))?;
      Ok(true)
    }
  })
  .await
  .map_err(|error| MirrorStorageError::Unsafe(format!("canonical cleanup worker failed: {error}")))?
}

/// Remove one previously inspected staging owner after exact metadata/path
/// revalidation. Callers own the profile exclusion and retention decision.
pub async fn remove_staging_candidate(candidate: &StagingCleanupCandidate) -> Result<bool, MirrorStorageError> {
  let candidate = candidate.clone();
  tokio::task::spawn_blocking(move || remove_staging_candidate_blocking(&candidate))
    .await
    .map_err(|error| MirrorStorageError::Unsafe(format!("staging cleanup worker failed: {error}")))?
}

fn remove_staging_candidate_blocking(candidate: &StagingCleanupCandidate) -> Result<bool, MirrorStorageError> {
  match std::fs::symlink_metadata(&candidate.root_path) {
    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
    Err(error) => return Err(error.into()),
    Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
      return Err(MirrorStorageError::Unsafe(format!(
        "staging cleanup candidate is not a physical directory: {}",
        candidate.root_path.display()
      )));
    }
    Ok(_) => {}
  }
  let observed_root = std::fs::canonicalize(&candidate.root_path)?;
  if observed_root != candidate.root_path {
    return Err(MirrorStorageError::Unsafe(format!(
      "staging cleanup candidate changed path: {}",
      observed_root.display()
    )));
  }
  let metadata_path = observed_root.join(STAGING_METADATA_FILE);
  let metadata = std::fs::symlink_metadata(&metadata_path)?;
  if metadata.file_type().is_symlink() || !metadata.is_file() {
    return Err(MirrorStorageError::Unsafe(format!(
      "staging cleanup metadata is not a physical file: {}",
      metadata_path.display()
    )));
  }
  let ownership: StagingOwnership = serde_json::from_slice(&std::fs::read(&metadata_path)?)
    .map_err(|error| MirrorStorageError::Metadata(format!("parse {}: {error}", metadata_path.display())))?;
  if ownership != candidate.ownership {
    return Err(MirrorStorageError::Metadata(format!(
      "staging ownership changed before cleanup: {}",
      observed_root.display()
    )));
  }
  std::fs::remove_dir_all(&observed_root)?;
  sync_directory(observed_root.parent().expect("staging candidate has parent"))?;
  Ok(true)
}

fn publish_staged_mirror_blocking(
  staged: &StagedMirror,
  repo_base: &Path,
  profile_id: Uuid,
) -> Result<PathBuf, MirrorStorageError> {
  if staged.ownership.profile_id != profile_id {
    return Err(MirrorStorageError::Metadata(
      "staging profile does not match publication target".to_string(),
    ));
  }
  let metadata = std::fs::read(&staged.metadata_path)?;
  let observed: StagingOwnership = serde_json::from_slice(&metadata)
    .map_err(|error| MirrorStorageError::Metadata(format!("parse ownership metadata: {error}")))?;
  if observed != staged.ownership {
    return Err(MirrorStorageError::Metadata(
      "staging ownership metadata changed before publication".to_string(),
    ));
  }

  let canonical_staging_root = std::fs::canonicalize(&staged.root_path)?;
  let canonical_repository = std::fs::canonicalize(&staged.repository_path)?;
  if canonical_repository.parent() != Some(canonical_staging_root.as_path()) {
    return Err(MirrorStorageError::Unsafe(format!(
      "staged repository escaped its ownership root: {}",
      canonical_repository.display()
    )));
  }
  let destination = match inspect_profile_mirror_blocking(repo_base, profile_id)? {
    MirrorPathState::Absent { canonical_path } => canonical_path,
    MirrorPathState::Existing { canonical_path } => {
      return Err(MirrorStorageError::DestinationExists(canonical_path));
    }
  };
  rename_directory_noreplace(&canonical_repository, &destination)?;
  sync_directory(destination.parent().expect("canonical mirror has parent"))?;

  if let Err(error) = std::fs::remove_file(&staged.metadata_path).and_then(|_| std::fs::remove_dir(&staged.root_path)) {
    warn!(
      staging_root = %staged.root_path.display(),
      %error,
      "published mirror left removable staging ownership residue"
    );
  }
  Ok(destination)
}

fn ensure_physical_directory(path: &Path) -> Result<PathBuf, MirrorStorageError> {
  match std::fs::symlink_metadata(path) {
    Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
      return Err(MirrorStorageError::Unsafe(format!(
        "reserved path is not a physical directory: {}",
        path.display()
      )));
    }
    Ok(_) => {}
    Err(error) if error.kind() == io::ErrorKind::NotFound => std::fs::create_dir(path)?,
    Err(error) => return Err(error.into()),
  }
  Ok(std::fs::canonicalize(path)?)
}

#[cfg(target_os = "linux")]
fn rename_directory_noreplace(source: &Path, destination: &Path) -> Result<(), MirrorStorageError> {
  use std::ffi::CString;
  use std::os::unix::ffi::OsStrExt;

  let source = CString::new(source.as_os_str().as_bytes())
    .map_err(|_| MirrorStorageError::Unsafe("staging path contains a NUL byte".to_string()))?;
  let destination = CString::new(destination.as_os_str().as_bytes())
    .map_err(|_| MirrorStorageError::Unsafe("destination path contains a NUL byte".to_string()))?;
  let result = unsafe {
    libc::renameat2(
      libc::AT_FDCWD,
      source.as_ptr(),
      libc::AT_FDCWD,
      destination.as_ptr(),
      libc::RENAME_NOREPLACE,
    )
  };
  if result == 0 {
    return Ok(());
  }
  let error = io::Error::last_os_error();
  if error.raw_os_error() == Some(libc::EEXIST) {
    Err(MirrorStorageError::DestinationExists(PathBuf::from(
      destination.to_string_lossy().into_owned(),
    )))
  } else if error.raw_os_error() == Some(libc::ENOSYS) || error.raw_os_error() == Some(libc::EINVAL) {
    Err(MirrorStorageError::PublicationUnsupported)
  } else {
    Err(error.into())
  }
}

#[cfg(not(target_os = "linux"))]
fn rename_directory_noreplace(_source: &Path, _destination: &Path) -> Result<(), MirrorStorageError> {
  Err(MirrorStorageError::PublicationUnsupported)
}

fn sync_directory(path: &Path) -> Result<(), MirrorStorageError> {
  File::open(path)?.sync_all()?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;
  use std::time::{Duration, Instant};

  #[tokio::test]
  async fn stable_lock_excludes_a_second_owner_and_survives_release() {
    let temp = tempfile::tempdir().expect("tempdir");
    let profile_id = Uuid::new_v4();
    let first = acquire_profile_mirror(temp.path(), profile_id)
      .await
      .expect("first guard");
    let lock_path = first.lock_path().to_path_buf();
    assert!(matches!(
      acquire_profile_mirror(temp.path(), profile_id).await,
      Err(MirrorLockError::Busy)
    ));
    drop(first);
    assert!(lock_path.is_file(), "stable lock inode must not be removed");
    let second = acquire_profile_mirror(temp.path(), profile_id)
      .await
      .expect("second guard");
    assert_eq!(second.lock_path(), lock_path);
  }

  #[tokio::test]
  async fn staged_repository_publishes_complete_without_replacing_any_destination() {
    let temp = tempfile::tempdir().expect("tempdir");
    let profile_id = Uuid::new_v4();
    let attempt_id = Uuid::new_v4();
    let staged = create_staged_mirror(temp.path(), profile_id, attempt_id)
      .await
      .expect("staging");
    std::fs::create_dir(staged.repository_path()).expect("staged repo root");
    std::fs::write(staged.repository_path().join("complete.txt"), b"complete").expect("staged content");
    assert_eq!(staged.ownership().profile_id, profile_id);
    assert_eq!(staged.ownership().attempt_id, attempt_id);
    assert!(staged.metadata_path().is_file());

    let published = publish_staged_mirror(&staged, temp.path(), profile_id)
      .await
      .expect("publish");
    assert_eq!(
      std::fs::read(published.join("complete.txt")).expect("published file"),
      b"complete"
    );
    assert!(!staged.root_path().exists(), "successful staging residue is removed");

    let second = create_staged_mirror(temp.path(), profile_id, Uuid::new_v4())
      .await
      .expect("second staging");
    std::fs::create_dir(second.repository_path()).expect("second repo root");
    std::fs::write(second.repository_path().join("replacement.txt"), b"replacement").expect("replacement");
    assert!(matches!(
      publish_staged_mirror(&second, temp.path(), profile_id).await,
      Err(MirrorStorageError::DestinationExists(_))
    ));
    assert_eq!(
      std::fs::read(published.join("complete.txt")).expect("preserved file"),
      b"complete"
    );
    assert!(!published.join("replacement.txt").exists());
    assert!(
      second.repository_path().is_dir(),
      "rejected staging remains inspectable"
    );
  }

  #[tokio::test]
  async fn changed_staging_metadata_blocks_publication_and_preserves_absence() {
    let temp = tempfile::tempdir().expect("tempdir");
    let profile_id = Uuid::new_v4();
    let staged = create_staged_mirror(temp.path(), profile_id, Uuid::new_v4())
      .await
      .expect("staging");
    std::fs::create_dir(staged.repository_path()).expect("staged repo root");
    std::fs::write(staged.metadata_path(), b"{}").expect("corrupt metadata");
    assert!(matches!(
      publish_staged_mirror(&staged, temp.path(), profile_id).await,
      Err(MirrorStorageError::Metadata(_))
    ));
    assert!(matches!(
      inspect_profile_mirror(temp.path(), profile_id).await.expect("inspect"),
      MirrorPathState::Absent { .. }
    ));
  }

  #[tokio::test]
  async fn cleanup_inventory_rejects_unverifiable_staging_without_removing_it() {
    let temp = tempfile::tempdir().expect("tempdir");
    let profile_id = Uuid::new_v4();
    let staged = create_staged_mirror(temp.path(), profile_id, Uuid::new_v4())
      .await
      .expect("staging");
    std::fs::write(staged.metadata_path(), b"not ownership metadata").expect("corrupt metadata");
    assert!(matches!(
      inspect_cleanup_inventory(temp.path()).await,
      Err(MirrorStorageError::Metadata(_))
    ));
    assert!(staged.root_path().is_dir(), "unverifiable staging must be retained");
  }

  #[test]
  fn lock_child_process() {
    let Ok(repo_base) = std::env::var("MYOXUS_MIRROR_LOCK_CHILD_BASE") else {
      return;
    };
    let profile_id = std::env::var("MYOXUS_MIRROR_LOCK_CHILD_PROFILE")
      .expect("child profile")
      .parse()
      .expect("profile uuid");
    let ready = PathBuf::from(std::env::var("MYOXUS_MIRROR_LOCK_CHILD_READY").expect("ready path"));
    let release = PathBuf::from(std::env::var("MYOXUS_MIRROR_LOCK_CHILD_RELEASE").expect("release path"));
    let runtime = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .expect("child runtime");
    let _guard = runtime
      .block_on(acquire_profile_mirror(Path::new(&repo_base), profile_id))
      .expect("child guard");
    std::fs::write(&ready, b"ready").expect("signal ready");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !release.is_file() && Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(10));
    }
    assert!(release.is_file(), "parent did not release child lock fixture");
  }

  #[tokio::test]
  async fn physical_lock_excludes_a_separate_process() {
    let temp = tempfile::tempdir().expect("tempdir");
    let profile_id = Uuid::new_v4();
    let ready = temp.path().join("child-ready");
    let release = temp.path().join("child-release");
    let mut child = Command::new(std::env::current_exe().expect("test executable"))
      .args(["--exact", "git_sync::mirror::tests::lock_child_process", "--nocapture"])
      .env("MYOXUS_MIRROR_LOCK_CHILD_BASE", temp.path())
      .env("MYOXUS_MIRROR_LOCK_CHILD_PROFILE", profile_id.to_string())
      .env("MYOXUS_MIRROR_LOCK_CHILD_READY", &ready)
      .env("MYOXUS_MIRROR_LOCK_CHILD_RELEASE", &release)
      .spawn()
      .expect("spawn lock child");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.is_file() && Instant::now() < deadline {
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(ready.is_file(), "child did not acquire physical mirror lock");
    assert!(matches!(
      acquire_profile_mirror(temp.path(), profile_id).await,
      Err(MirrorLockError::Busy)
    ));
    std::fs::write(&release, b"release").expect("release child");
    assert!(child.wait().expect("wait child").success());
    acquire_profile_mirror(temp.path(), profile_id)
      .await
      .expect("parent reacquires after child completion");
  }

  #[cfg(unix)]
  #[tokio::test]
  async fn symlinked_reserved_lock_directory_fails_closed() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("tempdir");
    let outside = tempfile::tempdir().expect("outside");
    symlink(outside.path(), temp.path().join(".locks")).expect("symlink");
    assert!(matches!(
      acquire_profile_mirror(temp.path(), Uuid::new_v4()).await,
      Err(MirrorLockError::Unsafe(_))
    ));
  }

  #[cfg(unix)]
  #[tokio::test]
  async fn symlinked_canonical_mirror_is_never_treated_as_absent_or_existing() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("tempdir");
    let outside = tempfile::tempdir().expect("outside");
    let profile_id = Uuid::new_v4();
    symlink(outside.path(), temp.path().join(profile_id.to_string())).expect("symlink");
    assert!(matches!(
      inspect_profile_mirror(temp.path(), profile_id).await,
      Err(MirrorStorageError::Unsafe(_))
    ));
  }
}
