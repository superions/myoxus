// SPDX-License-Identifier: AGPL-3.0-or-later
//! Git repository working-tree management: clone, fetch, stash, checkout, commit, push.

use std::path::{Path, PathBuf};

use tracing::{debug, info, warn};
use uuid::Uuid;

use myoxus_application::git_sync::backend::{GitAuth, GitRepositoryIdentity, GitRepositoryPort};
use myoxus_domain::git_sync::GitSyncProfile;
use myoxus_infrastructure::{
  disk,
  git_sync::{
    MirrorPathState, MirrorStorageError, create_staged_mirror, inspect_profile_mirror, publish_staged_mirror,
  },
};

use super::error::SyncError;

/// Compute the local clone directory for a profile.
pub fn repo_dir(base: &Path, profile_id: Uuid) -> PathBuf {
  base.join(profile_id.to_string())
}

#[derive(Debug, Clone, Copy)]
pub struct MirrorMaterializationContext {
  pub attempt_id: Uuid,
  pub max_storage_mb: u64,
  pub min_free_disk_mb: u64,
}

/// Result of preparing a mirror for one runner attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRepository {
  /// Authenticated remote branch revision observed before any local mutation.
  pub source_remote_oid: String,
}

/// Prepare the local working tree: clone if missing, fetch if existing, checkout branch.
///
/// Handles:
/// - Fresh clone when no local repo exists
/// - Open + fetch for existing repos
/// - Branch checkout after fetch
pub async fn prepare(
  git_repo: &dyn GitRepositoryPort,
  profile: &GitSyncProfile,
  auth: &GitAuth,
  repo_base_dir: &Path,
  materialization: Option<MirrorMaterializationContext>,
  ensure_owned: &(dyn Fn(&'static str) -> Result<(), SyncError> + Send + Sync),
) -> Result<PreparedRepository, SyncError> {
  let state = inspect_profile_mirror(repo_base_dir, profile.id)
    .await
    .map_err(|error| mirror_storage_error(error, profile.id, "prepare_path_inspection"))?;
  let source_remote_oid = if let MirrorPathState::Existing { canonical_path } = state {
    ensure_owned("prepare_fetch")?;
    git_repo
      .open_repo(&canonical_path)
      .await
      .map_err(|error| SyncError::from_git_error(error, "open existing Git-Sync mirror", "prepare_open"))?;
    verify_repository_identity(git_repo, &canonical_path, profile, false, "prepare_existing_identity").await?;
    debug!("repo exists, preparing for sync");

    // Observe the authenticated source before mutating the local recovery
    // state. A rejected/failed remote cannot cause a stash or hard reset.
    git_repo
      .fetch(auth)
      .await
      .map_err(|error| SyncError::from_git_error(error, "fetch existing Git-Sync mirror", "prepare_fetch"))?;
    let source_remote_oid = git_repo
      .remote_branch_oid(&profile.branch, auth)
      .await
      .map_err(|error| {
        SyncError::from_git_error(
          error,
          format!("observe authenticated remote branch {}", profile.branch),
          "prepare_source_observation",
        )
      })?;

    // Only now may preparation preserve and then normalize local state.
    ensure_owned("prepare_stash")?;
    stash_if_dirty(git_repo).await?;
    ensure_owned("prepare_reset")?;
    reset_to_remote(git_repo, &profile.branch).await?;
    ensure_owned("prepare_checkout")?;
    git_repo.checkout_branch(&profile.branch).await.map_err(|error| {
      SyncError::from_git_error(
        error,
        format!("checkout prepared branch {}", profile.branch),
        "prepare_checkout",
      )
    })?;
    verify_repository_identity(git_repo, &canonical_path, profile, true, "prepare_checked_out_identity").await?;
    source_remote_oid
  } else {
    let context = materialization.ok_or_else(|| {
      SyncError::permanent(
        "managed mirror is absent and this operation does not own first materialization",
        profile.id,
        "prepare_clone",
      )
    })?;
    materialize_missing_mirror(git_repo, profile, auth, repo_base_dir, context, ensure_owned).await?
  };

  // ROB-13 / ROB-27: Reject the sync if any symlink lives inside root_path.
  // Symlinks in a synced repo can escape the repo subtree (e.g.
  // `content/foo -> /etc/passwd`) and the loader would then read the
  // foreign target. Defense-in-policy: refuse the run rather than warn.
  let canonical_path = repo_dir(repo_base_dir, profile.id);
  check_for_symlinks(&canonical_path, &profile.root_path, profile.id).await?;

  Ok(PreparedRepository { source_remote_oid })
}

pub(crate) async fn materialize_missing_mirror(
  git_repo: &dyn GitRepositoryPort,
  profile: &GitSyncProfile,
  auth: &GitAuth,
  repo_base_dir: &Path,
  context: MirrorMaterializationContext,
  ensure_owned: &(dyn Fn(&'static str) -> Result<(), SyncError> + Send + Sync),
) -> Result<String, SyncError> {
  info!(
    profile_id = %profile.id,
    attempt_id = %context.attempt_id,
    branch = %profile.branch,
    "materializing absent Git-Sync mirror through attempt-owned staging"
  );
  ensure_owned("prepare_clone")?;
  disk::materialization_preflight_check(repo_base_dir, context.max_storage_mb, context.min_free_disk_mb)
    .await
    .map_err(|message| SyncError::permanent(message, profile.id, "prepare_clone_disk"))?;
  let staged = create_staged_mirror(repo_base_dir, profile.id, context.attempt_id)
    .await
    .map_err(|error| mirror_storage_error(error, profile.id, "prepare_clone_staging"))?;
  git_repo
    .clone_repo(&profile.repo_url, staged.repository_path(), &profile.branch, auth)
    .await
    .map_err(|error| SyncError::from_git_error(error, "clone absent Git-Sync mirror into staging", "prepare_clone"))?;
  let identity = verify_repository_identity(
    git_repo,
    staged.repository_path(),
    profile,
    true,
    "prepare_staged_identity",
  )
  .await?;
  check_for_symlinks(staged.repository_path(), &profile.root_path, profile.id).await?;
  let remote_oid = git_repo
    .remote_branch_oid(&profile.branch, auth)
    .await
    .map_err(|error| {
      SyncError::from_git_error(
        error,
        format!(
          "observe authenticated remote branch {} for staged mirror",
          profile.branch
        ),
        "prepare_source_observation",
      )
    })?;
  if identity.head_oid != remote_oid {
    return Err(SyncError::permanent(
      format!(
        "staged mirror HEAD {} does not match authenticated remote branch {} at {remote_oid}",
        identity.head_oid, profile.branch
      ),
      profile.id,
      "prepare_staged_identity",
    ));
  }
  disk::materialization_preflight_check(repo_base_dir, context.max_storage_mb, context.min_free_disk_mb)
    .await
    .map_err(|message| SyncError::permanent(message, profile.id, "prepare_publish_disk"))?;
  ensure_owned("prepare_publish")?;
  let canonical_path = publish_staged_mirror(&staged, repo_base_dir, profile.id)
    .await
    .map_err(|error| mirror_storage_error(error, profile.id, "prepare_publish"))?;
  git_repo
    .open_repo(&canonical_path)
    .await
    .map_err(|error| SyncError::from_git_error(error, "reopen published Git-Sync mirror", "prepare_publish"))?;
  let published_identity =
    verify_repository_identity(git_repo, &canonical_path, profile, true, "prepare_published_identity").await?;
  if published_identity.head_oid != remote_oid {
    return Err(SyncError::permanent(
      "published Git-Sync mirror changed identity while reopening",
      profile.id,
      "prepare_published_identity",
    ));
  }
  Ok(remote_oid)
}

pub(crate) async fn prepare_remote_observation(
  git_repo: &dyn GitRepositoryPort,
  profile: &GitSyncProfile,
  auth: &GitAuth,
  repo_base_dir: &Path,
  context: MirrorMaterializationContext,
  ensure_owned: &(dyn Fn(&'static str) -> Result<(), SyncError> + Send + Sync),
) -> Result<String, SyncError> {
  match inspect_profile_mirror(repo_base_dir, profile.id)
    .await
    .map_err(|error| mirror_storage_error(error, profile.id, "stale_run_path_inspection"))?
  {
    MirrorPathState::Absent { .. } => {
      materialize_missing_mirror(git_repo, profile, auth, repo_base_dir, context, ensure_owned).await
    }
    MirrorPathState::Existing { canonical_path } => {
      ensure_owned("stale_run_reconciliation")?;
      git_repo.open_repo(&canonical_path).await.map_err(|error| {
        SyncError::from_git_error(
          error,
          "open stale-run mirror for remote observation",
          "stale_run_reconciliation",
        )
      })?;
      verify_repository_identity(git_repo, &canonical_path, profile, false, "stale_run_existing_identity").await?;
      git_repo
        .remote_branch_oid(&profile.branch, auth)
        .await
        .map_err(|error| {
          SyncError::from_git_error(error, "observe stale-run remote branch", "stale_run_reconciliation")
        })
    }
  }
}

async fn verify_repository_identity(
  git_repo: &dyn GitRepositoryPort,
  expected_workdir: &Path,
  profile: &GitSyncProfile,
  require_configured_branch: bool,
  phase: &'static str,
) -> Result<GitRepositoryIdentity, SyncError> {
  let identity = git_repo
    .repository_identity()
    .await
    .map_err(|error| SyncError::from_git_error(error, "inspect managed repository identity", phase))?;
  let expected_workdir = tokio::fs::canonicalize(expected_workdir).await.map_err(|error| {
    SyncError::permanent(
      format!("canonicalize expected managed worktree: {error}"),
      profile.id,
      phase,
    )
  })?;
  if identity.workdir != expected_workdir {
    return Err(SyncError::permanent(
      format!(
        "managed repository worktree mismatch: expected {}, observed {}",
        expected_workdir.display(),
        identity.workdir.display()
      ),
      profile.id,
      phase,
    ));
  }
  if identity.origin_url != profile.repo_url {
    return Err(SyncError::permanent(
      "managed repository origin does not match the configured profile remote",
      profile.id,
      phase,
    ));
  }
  if require_configured_branch && identity.head_branch != profile.branch {
    return Err(SyncError::permanent(
      format!(
        "managed repository branch mismatch: expected {}, observed {}",
        profile.branch, identity.head_branch
      ),
      profile.id,
      phase,
    ));
  }
  if identity.head_oid.is_empty() || identity.head_tree_oid.is_empty() {
    return Err(SyncError::permanent(
      "managed repository commit/tree identity is incomplete",
      profile.id,
      phase,
    ));
  }
  Ok(identity)
}

fn mirror_storage_error(error: MirrorStorageError, profile_id: Uuid, phase: &'static str) -> SyncError {
  SyncError::permanent(error.to_string(), profile_id, phase)
}

/// Scan the repo's `root_path` subtree for symlinks.
///
/// Returns `Err(path)` with the first offending symlink found, or `Ok(())`
/// if the subtree is clean.  Hidden directories (e.g. `.git`) are skipped.
/// Caller decides what to do with the offending path; in `prepare` it is
/// surfaced as a permanent `SyncError`.
async fn check_for_symlinks(repo_path: &Path, root_path: &str, profile_id: Uuid) -> Result<(), SyncError> {
  let scan_dir = repo_path.join(root_path);
  match tokio::fs::symlink_metadata(&scan_dir).await {
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(error) => {
      return Err(SyncError::permanent(
        format!("inspect configured root_path {}: {error}", scan_dir.display()),
        profile_id,
        "prepare_repo",
      ));
    }
    Ok(metadata) if metadata.file_type().is_symlink() => {
      return Err(SyncError::permanent(
        format!("symlink in root_path subtree is not allowed: {}", scan_dir.display()),
        profile_id,
        "prepare_repo",
      ));
    }
    Ok(metadata) if !metadata.is_dir() => {
      return Err(SyncError::permanent(
        format!("configured root_path is not a directory: {}", scan_dir.display()),
        profile_id,
        "prepare_repo",
      ));
    }
    Ok(_) => {}
  }
  check_for_symlinks_recursive(&scan_dir, 0, profile_id).await
}

/// Maximum depth for recursive symlink scanning to prevent unbounded traversal.
const MAX_SYMLINK_SCAN_DEPTH: u32 = 20;

async fn check_for_symlinks_recursive(dir: &Path, depth: u32, profile_id: Uuid) -> Result<(), SyncError> {
  if depth > MAX_SYMLINK_SCAN_DEPTH {
    return Err(SyncError::permanent(
      format!("root_path safety scan exceeded maximum depth at {}", dir.display()),
      profile_id,
      "prepare_repo",
    ));
  }
  let mut entries = tokio::fs::read_dir(dir).await.map_err(|error| {
    SyncError::permanent(
      format!("read root_path directory {}: {error}", dir.display()),
      profile_id,
      "prepare_repo",
    )
  })?;
  while let Some(entry) = entries.next_entry().await.map_err(|error| {
    SyncError::permanent(
      format!("enumerate root_path directory {}: {error}", dir.display()),
      profile_id,
      "prepare_repo",
    )
  })? {
    let ft = entry.file_type().await.map_err(|error| {
      SyncError::permanent(
        format!("inspect root_path entry {}: {error}", entry.path().display()),
        profile_id,
        "prepare_repo",
      )
    })?;
    if ft.is_symlink() {
      let offending = entry.path();
      warn!(profile_id = %profile_id, path = %offending.display(), "rejecting Git-Sync root_path symlink");
      return Err(SyncError::permanent(
        format!("symlink in root_path subtree is not allowed: {}", offending.display()),
        profile_id,
        "prepare_repo",
      ));
    } else if ft.is_dir() {
      // Skip hidden directories (e.g. .git)
      let name = entry.file_name();
      if !name.to_str().is_some_and(|n| n.starts_with('.')) {
        Box::pin(check_for_symlinks_recursive(&entry.path(), depth + 1, profile_id)).await?;
      }
    }
  }
  Ok(())
}

/// Stash any uncommitted changes in the working tree.
///
/// This prevents fetch/checkout from failing due to dirty state left over
/// from a previous interrupted sync. The stash is never popped — we start
/// fresh from remote HEAD each time.
async fn stash_if_dirty(git_repo: &dyn GitRepositoryPort) -> Result<bool, SyncError> {
  git_repo
    .stash_if_dirty()
    .await
    .map_err(|error| SyncError::from_git_error(error, "stash dirty Git-Sync mirror", "prepare_stash"))
}

/// Hard-reset to the remote tracking branch to discard any local-only commits.
///
/// After a failed push, the local branch may be ahead of remote. Resetting
/// ensures we start each sync from the same state as the remote, preventing
/// divergence accumulation across runs.
async fn reset_to_remote(git_repo: &dyn GitRepositoryPort, branch: &str) -> Result<String, SyncError> {
  git_repo
    .reset_to_remote(branch)
    .await
    .map_err(|error| SyncError::from_git_error(error, "reset local mirror to remote branch", "reset_remote"))
}

/// Drop all stashes to prevent unbounded accumulation from `stash_if_dirty`.
///
/// Called after a successful sync completion (MED-01).
pub(crate) async fn drop_stashes(git_repo: &dyn GitRepositoryPort) {
  if let Err(error) = git_repo.drop_all_stashes().await {
    warn!(%error, "failed to clean Git-Sync recovery stashes");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use std::sync::atomic::{AtomicUsize, Ordering};

  use super::*;
  use chrono::Utc;
  use myoxus_domain::git_sync::{AuthMethod, SyncDirection, TriggerMode};
  use myoxus_infrastructure::git_sync::Git2Adapter;
  use tempfile::TempDir;

  fn create_source_repository(path: &Path) -> String {
    std::fs::create_dir_all(path).expect("source directory");
    let repository = git2::Repository::init(path).expect("source repository");
    std::fs::write(path.join("README.md"), "# source\n").expect("source content");
    let mut index = repository.index().expect("source index");
    index.add_path(Path::new("README.md")).expect("index source content");
    let tree_oid = index.write_tree().expect("source tree");
    {
      let tree = repository.find_tree(tree_oid).expect("find source tree");
      let signature = git2::Signature::now("Git Sync Test", "git-sync@example.invalid").expect("signature");
      repository
        .commit(Some("refs/heads/main"), &signature, &signature, "seed", &tree, &[])
        .expect("source commit");
    }
    repository.set_head("refs/heads/main").expect("select main");
    std::fs::canonicalize(path)
      .expect("canonical source")
      .to_string_lossy()
      .into_owned()
  }

  fn profile(repo_url: String, branch: &str) -> GitSyncProfile {
    GitSyncProfile {
      id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      owner_id: Uuid::new_v4(),
      repo_url,
      branch: branch.to_string(),
      root_path: ".".to_string(),
      manifest_path: myoxus_application::git_sync::export::GIT_SYNC_MANIFEST_PATH.to_string(),
      scope_revision: 0,
      sync_direction: SyncDirection::Bidirectional,
      trigger_mode: TriggerMode::Manual,
      polling_interval_secs: None,
      cron_expression: None,
      cron_timezone: None,
      cron_misfire_policy: None,
      cron_next_scheduled_at: None,
      cron_pending_misfire_scheduled_for: None,
      auth_method: AuthMethod::HttpsToken,
      credential_id: None,
      enabled: true,
      max_mirror_storage_mb: None,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    }
  }

  fn materialization() -> MirrorMaterializationContext {
    MirrorMaterializationContext {
      attempt_id: Uuid::new_v4(),
      max_storage_mb: 0,
      min_free_disk_mb: 0,
    }
  }

  fn init_existing_mirror(path: &Path, origin_url: Option<&str>) {
    let repository = git2::Repository::init(path).expect("existing repository");
    std::fs::write(path.join("preserve.txt"), "recovery evidence").expect("existing content");
    let mut index = repository.index().expect("existing index");
    index
      .add_path(Path::new("preserve.txt"))
      .expect("index existing content");
    let tree_oid = index.write_tree().expect("existing tree");
    {
      let tree = repository.find_tree(tree_oid).expect("find existing tree");
      let signature = git2::Signature::now("Git Sync Test", "git-sync@example.invalid").expect("signature");
      repository
        .commit(Some("refs/heads/main"), &signature, &signature, "existing", &tree, &[])
        .expect("existing commit");
    }
    repository.set_head("refs/heads/main").expect("select main");
    if let Some(origin_url) = origin_url {
      repository.remote("origin", origin_url).expect("origin remote");
    }
  }

  #[tokio::test]
  async fn normal_and_stale_first_materialization_publish_the_same_verified_layout() {
    let temp = TempDir::new().expect("tempdir");
    let source_url = create_source_repository(&temp.path().join("source"));
    let repo_base = temp.path().join("mirrors");
    tokio::fs::create_dir(&repo_base).await.expect("mirror base");

    let normal_profile = profile(source_url.clone(), "main");
    let normal_adapter = Git2Adapter::new();
    let normal = prepare(
      &normal_adapter,
      &normal_profile,
      &GitAuth::None,
      &repo_base,
      Some(materialization()),
      &|_| Ok(()),
    )
    .await
    .expect("normal first materialization");
    assert!(repo_dir(&repo_base, normal_profile.id).join("README.md").is_file());
    assert_eq!(
      normal_adapter
        .repository_identity()
        .await
        .expect("normal identity")
        .head_oid,
      normal.source_remote_oid
    );

    let stale_profile = profile(source_url, "main");
    let stale_adapter = Git2Adapter::new();
    let stale_oid = prepare_remote_observation(
      &stale_adapter,
      &stale_profile,
      &GitAuth::None,
      &repo_base,
      materialization(),
      &|_| Ok(()),
    )
    .await
    .expect("stale first materialization");
    assert!(repo_dir(&repo_base, stale_profile.id).join("README.md").is_file());
    assert_eq!(
      stale_adapter
        .repository_identity()
        .await
        .expect("stale identity")
        .head_oid,
      stale_oid
    );
  }

  #[tokio::test]
  async fn failed_branch_and_lost_lease_never_publish_partial_mirrors() {
    let temp = TempDir::new().expect("tempdir");
    let source_url = create_source_repository(&temp.path().join("source"));
    let repo_base = temp.path().join("mirrors");
    tokio::fs::create_dir(&repo_base).await.expect("mirror base");

    let missing_branch = profile(source_url.clone(), "missing");
    let error = prepare(
      &Git2Adapter::new(),
      &missing_branch,
      &GitAuth::None,
      &repo_base,
      Some(materialization()),
      &|_| Ok(()),
    )
    .await
    .expect_err("missing branch must fail");
    assert!(matches!(error, SyncError::Git { .. }));
    assert!(!repo_dir(&repo_base, missing_branch.id).exists());

    let lost_lease = profile(source_url, "main");
    let ownership_checks = AtomicUsize::new(0);
    let error = prepare(
      &Git2Adapter::new(),
      &lost_lease,
      &GitAuth::None,
      &repo_base,
      Some(materialization()),
      &|phase| {
        if ownership_checks.fetch_add(1, Ordering::SeqCst) == 0 {
          Ok(())
        } else {
          Err(SyncError::retryable("lease lost", lost_lease.id, phase))
        }
      },
    )
    .await
    .expect_err("lease loss before publication must fail");
    assert!(matches!(
      error,
      SyncError::Retryable {
        phase: "prepare_publish",
        ..
      }
    ));
    assert!(!repo_dir(&repo_base, lost_lease.id).exists());
    assert!(repo_base.join(".staging").join(lost_lease.id.to_string()).is_dir());
  }

  #[tokio::test]
  async fn foreign_missing_origin_and_corrupt_existing_mirrors_are_preserved() {
    let temp = TempDir::new().expect("tempdir");
    let source_url = create_source_repository(&temp.path().join("source"));
    let repo_base = temp.path().join("mirrors");
    tokio::fs::create_dir(&repo_base).await.expect("mirror base");

    for existing_origin in [Some("/foreign/repository"), None] {
      let candidate = profile(source_url.clone(), "main");
      let canonical = repo_dir(&repo_base, candidate.id);
      init_existing_mirror(&canonical, existing_origin);
      prepare(
        &Git2Adapter::new(),
        &candidate,
        &GitAuth::None,
        &repo_base,
        None,
        &|_| Ok(()),
      )
      .await
      .expect_err("foreign existing repository must fail before fetch");
      assert_eq!(
        std::fs::read_to_string(canonical.join("preserve.txt")).expect("preserved evidence"),
        "recovery evidence"
      );
    }

    let corrupt = profile(source_url, "main");
    let canonical = repo_dir(&repo_base, corrupt.id);
    std::fs::create_dir(&canonical).expect("corrupt mirror directory");
    std::fs::write(canonical.join("preserve.txt"), "corrupt recovery evidence").expect("corrupt evidence");
    prepare(&Git2Adapter::new(), &corrupt, &GitAuth::None, &repo_base, None, &|_| {
      Ok(())
    })
    .await
    .expect_err("corrupt existing repository must remain terminal");
    assert_eq!(
      std::fs::read_to_string(canonical.join("preserve.txt")).expect("preserved corrupt evidence"),
      "corrupt recovery evidence"
    );
  }

  /// ROB-27: an empty subtree (nothing to scan) is valid and returns Ok.
  #[tokio::test]
  async fn check_for_symlinks_passes_on_empty_subtree() {
    let dir = TempDir::new().expect("tempdir");
    let result = check_for_symlinks(dir.path(), "", Uuid::nil()).await;
    assert!(result.is_ok());
  }

  /// ROB-27: a clean tree with regular files only passes.
  #[tokio::test]
  async fn check_for_symlinks_passes_on_regular_files() {
    let dir = TempDir::new().expect("tempdir");
    tokio::fs::write(dir.path().join("a.md"), "hello").await.expect("write");
    tokio::fs::create_dir(dir.path().join("sub")).await.expect("mkdir");
    tokio::fs::write(dir.path().join("sub/b.md"), "world")
      .await
      .expect("write");
    let result = check_for_symlinks(dir.path(), "", Uuid::nil()).await;
    assert!(result.is_ok(), "regular files must not trip the symlink check");
  }

  /// ROB-27: a top-level symlink is rejected and the offending path is returned.
  #[cfg(unix)]
  #[tokio::test]
  async fn check_for_symlinks_rejects_top_level_symlink() {
    let dir = TempDir::new().expect("tempdir");
    let target = dir.path().join("real.md");
    tokio::fs::write(&target, "ok").await.expect("write");
    let link = dir.path().join("link.md");
    std::os::unix::fs::symlink(&target, &link).expect("symlink");

    let result = check_for_symlinks(dir.path(), "", Uuid::nil()).await;
    let offending = result.expect_err("symlink must be rejected").to_string();
    assert!(
      offending.contains(&link.display().to_string()),
      "rejection must report the symlink path"
    );
  }

  /// ROB-27: a nested symlink (inside a sub-directory) is also rejected.
  #[cfg(unix)]
  #[tokio::test]
  async fn check_for_symlinks_rejects_nested_symlink() {
    let dir = TempDir::new().expect("tempdir");
    let inner = dir.path().join("docs/sub");
    tokio::fs::create_dir_all(&inner).await.expect("mkdir");
    let target = inner.join("real.md");
    tokio::fs::write(&target, "ok").await.expect("write");
    let link = inner.join("escape.md");
    std::os::unix::fs::symlink(&target, &link).expect("symlink");

    let result = check_for_symlinks(dir.path(), "docs", Uuid::nil()).await;
    let offending = result.expect_err("nested symlink must be rejected").to_string();
    assert!(offending.contains(&link.display().to_string()));
  }

  /// ROB-27: hidden directories (e.g. `.git`) are skipped — we don't need
  /// to validate the git internals, only the user-visible subtree.
  #[cfg(unix)]
  #[tokio::test]
  async fn check_for_symlinks_skips_hidden_directories() {
    let dir = TempDir::new().expect("tempdir");
    let git_dir = dir.path().join(".git");
    tokio::fs::create_dir(&git_dir).await.expect("mkdir");
    let target = dir.path().join("README.md");
    tokio::fs::write(&target, "ok").await.expect("write");
    // libgit2 itself stores symlinks under .git (e.g. HEAD link on some setups).
    // The scanner must not trip on those.
    std::os::unix::fs::symlink(&target, git_dir.join("HEAD-link")).expect("symlink");

    let result = check_for_symlinks(dir.path(), "", Uuid::nil()).await;
    assert!(result.is_ok(), "symlinks under hidden dirs must be ignored");
  }

  /// ROB-27: a missing root_path subtree is treated as clean (the loader
  /// will surface the missing-directory error elsewhere; we don't double-fail).
  #[tokio::test]
  async fn check_for_symlinks_passes_when_subtree_does_not_exist() {
    let dir = TempDir::new().expect("tempdir");
    let result = check_for_symlinks(dir.path(), "does-not-exist", Uuid::nil()).await;
    assert!(result.is_ok());
  }
}
