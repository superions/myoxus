// SPDX-License-Identifier: AGPL-3.0-or-later
//! ROB-21 — Integration test for the push-rejection rebase loop in
//! `application::git_sync::remote_commit::commit_and_push`.
//!
//! ## Background — the silent push-loss bug
//!
//! The original `commit_and_push` retry logic, after a non-fast-forward
//! `push` rejection, called `git_repo.changed_files(None, None)` to find out
//! which files our commit had changed. But that call returns the diff
//! between HEAD and the working tree — and the working tree is **clean**
//! immediately after a successful `commit`. The rebase loop therefore:
//!
//!   - Captured an empty file list;
//!   - Reset to remote HEAD (dropping our local commit);
//!   - Re-applied nothing;
//!   - Saw no diff, returned `Ok(Some(oid))` for a commit that had been
//!     dropped seconds earlier.
//!
//! The caller upstream treated `Some(oid)` as "push succeeded" and
//! recorded the run as completed. The bug was silent: each conflicted
//! sync looked successful in the run log while the remote never received
//! the commit.
//!
//! ## Fix (ROB-21)
//!
//! Snapshot the file contents **before** the commit, while the working
//! tree still has the changes. The snapshot survives the post-commit
//! clean-tree state and the `reset_to_remote` call, so the rebase loop
//! has real data to re-apply on top of fresh remote HEAD. After
//! re-applying we detect "remote already has our changes" by checking
//! `changed_files(None, None)` for emptiness and return an `AlreadyCurrent`
//! receipt carrying the freshly observed remote OID (instead of a stale
//! local-only `oid`).
//!
//! ## What this test exercises
//!
//! Two clones of the same bare repo race a push:
//!   - Clone A pushes a commit on `main`.
//!   - Clone B writes a different file and calls `commit_and_push` —
//!     its first push attempt is rejected (non-fast-forward), the
//!     retry loop must rebase its file onto Clone A's remote head and
//!     push successfully.
//!
//! Verification queries the bare repo afterwards and asserts BOTH files
//! are present. Without the fix, only Clone A's file would be there.

#![allow(clippy::too_many_lines)]

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use chrono::Utc;
use tempfile::TempDir;
use uuid::Uuid;

use myoxus_api::git_sync_engine::executor::execute_file_git_actions;
use myoxus_application::git_sync::backend::{
  ChangedFile, GitAuth, GitError, GitOperationGuard, GitPushReceipt, GitRemoteRefStatus, GitRepositoryIdentity,
  GitRepositoryPort,
};
use myoxus_application::git_sync::file_reconcile::FileReconcileAction;
use myoxus_application::git_sync::remote_commit::{CommitTrailers, commit_and_push};
use myoxus_application::ports::{
  BlobReadResponse, BlobStoragePort, BlobWriteRequest, MultipartCompleteRequest, MultipartCreateRequest,
  MultipartCreateResponse, MultipartPartUrlRequest, MultipartPartUrlResponse, PortError, PortResult,
};
use myoxus_domain::git_sync::{AuthMethod, GitSyncProfile, SyncDirection, TriggerMode};
use myoxus_infrastructure::git_sync::Git2Adapter;

// ─── Helpers (mirror those in `infrastructure/tests/git_sync_integration_test.rs`) ──

fn require_git() {
  let output = Command::new("git").arg("--version").output();
  if output.is_err() || !output.as_ref().unwrap().status.success() {
    panic!("git CLI not available — cannot run git_sync rebase test");
  }
  // Test-only tracing so debugging the rebase logic doesn't require
  // a `--nocapture` + RUST_LOG dance from the parent shell.
  let _ = tracing_subscriber::fmt()
    .with_env_filter(
      tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new(
          "info,myoxus_api::git_sync_engine=debug,myoxus_infrastructure::git_sync=debug",
        )
      }),
    )
    .with_test_writer()
    .try_init();
}

fn git(dir: &Path, args: &[&str]) -> String {
  let output = Command::new("git")
    .args(args)
    .current_dir(dir)
    .env("GIT_TERMINAL_PROMPT", "0")
    .output()
    .unwrap_or_else(|e| panic!("git {} failed: {e}", args.join(" ")));
  if !output.status.success() {
    panic!(
      "git {} failed in {}:\n{}",
      args.join(" "),
      dir.display(),
      String::from_utf8_lossy(&output.stderr)
    );
  }
  String::from_utf8_lossy(&output.stdout).to_string()
}

fn init_bare_repo() -> TempDir {
  let dir = TempDir::new().unwrap();
  git(dir.path(), &["init", "--bare", "--initial-branch=main"]);
  dir
}

/// Create a clone of `bare_url` populated with the seed file (so HEAD
/// exists and `commit_and_push` has a meaningful diff base).
fn init_seeded_clone(bare_url: &str, seed_filename: &str, seed_content: &str) -> TempDir {
  let dir = TempDir::new().unwrap();
  git(dir.path(), &["init", "--initial-branch=main"]);
  git(dir.path(), &["config", "user.email", "test@test.com"]);
  git(dir.path(), &["config", "user.name", "Test"]);
  std::fs::write(dir.path().join(seed_filename), seed_content).unwrap();
  git(dir.path(), &["add", "."]);
  git(dir.path(), &["commit", "-m", "seed"]);
  git(dir.path(), &["remote", "add", "origin", bare_url]);
  git(dir.path(), &["push", "-u", "origin", "main"]);
  dir
}

/// Clone the bare repo into a fresh working dir at `target`. Used to
/// simulate a second worker syncing the same profile.
fn clone_into(bare_url: &str, target: &Path) {
  Command::new("git")
    .args(["clone", "--branch=main", bare_url])
    .arg(target)
    .output()
    .expect("git clone");
  // Guard rail: clone must produce a populated working tree.
  assert!(target.join("seed.txt").exists(), "clone must include seed file");
  // Configure committer identity for the local config so the adapter
  // can create commits without inheriting a global identity.
  git(target, &["config", "user.email", "b@test.com"]);
  git(target, &["config", "user.name", "Clone B"]);
}

fn make_profile(repo_url: &str) -> GitSyncProfile {
  GitSyncProfile {
    id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    owner_id: Uuid::new_v4(),
    repo_url: repo_url.to_string(),
    branch: "main".to_string(),
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

fn make_trailers(profile_id: Uuid, workspace_id: Uuid) -> CommitTrailers {
  CommitTrailers {
    workspace_id,
    run_id: Uuid::new_v4(),
    profile_id,
    direction: "Bidirectional".to_string(),
    docs_pushed: 1,
    docs_pulled: 0,
    files_pushed: 1,
    files_pulled: 0,
  }
}

struct FalseSuccessGitRepo {
  inner: Git2Adapter,
  observed_remote_oid: String,
}

#[async_trait]
impl GitRepositoryPort for FalseSuccessGitRepo {
  async fn retain_operation_guard(&self, guard: Arc<dyn GitOperationGuard>) -> Result<(), GitError> {
    self.inner.retain_operation_guard(guard).await
  }

  async fn probe_remote(
    &self,
    url: &str,
    branch: Option<&str>,
    auth: &GitAuth,
  ) -> Result<myoxus_application::git_sync::GitRemoteProbe, GitError> {
    self.inner.probe_remote(url, branch, auth).await
  }

  async fn clone_repo(&self, url: &str, path: &Path, branch: &str, auth: &GitAuth) -> Result<(), GitError> {
    self.inner.clone_repo(url, path, branch, auth).await
  }

  async fn open_repo(&self, path: &Path) -> Result<(), GitError> {
    self.inner.open_repo(path).await
  }

  async fn repository_identity(&self) -> Result<GitRepositoryIdentity, GitError> {
    self.inner.repository_identity().await
  }

  async fn fetch(&self, auth: &GitAuth) -> Result<(), GitError> {
    self.inner.fetch(auth).await
  }

  async fn checkout_branch(&self, branch: &str) -> Result<(), GitError> {
    self.inner.checkout_branch(branch).await
  }

  async fn reset_to_remote(&self, branch: &str) -> Result<String, GitError> {
    self.inner.reset_to_remote(branch).await
  }

  async fn stash_if_dirty(&self) -> Result<bool, GitError> {
    self.inner.stash_if_dirty().await
  }

  async fn drop_all_stashes(&self) -> Result<(), GitError> {
    self.inner.drop_all_stashes().await
  }

  async fn head_oid(&self) -> Result<String, GitError> {
    self.inner.head_oid().await
  }

  async fn remote_branch_oid(&self, branch: &str, auth: &GitAuth) -> Result<String, GitError> {
    self.inner.remote_branch_oid(branch, auth).await
  }

  async fn changed_files(&self, from: Option<&str>, to: Option<&str>) -> Result<Vec<ChangedFile>, GitError> {
    self.inner.changed_files(from, to).await
  }

  async fn read_file(&self, path: &str) -> Result<Vec<u8>, GitError> {
    self.inner.read_file(path).await
  }

  async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), GitError> {
    self.inner.write_file(path, content).await
  }

  async fn delete_file(&self, path: &str) -> Result<(), GitError> {
    self.inner.delete_file(path).await
  }

  async fn rename_file(&self, from: &str, to: &str) -> Result<(), GitError> {
    self.inner.rename_file(from, to).await
  }

  async fn commit(&self, message: &str, author_name: &str, author_email: &str) -> Result<String, GitError> {
    self.inner.commit(message, author_name, author_email).await
  }

  async fn push(&self, branch: &str, intended_oid: &str, _auth: &GitAuth) -> Result<GitPushReceipt, GitError> {
    Ok(GitPushReceipt {
      branch: branch.to_string(),
      local_commit_oid: intended_oid.to_string(),
      remote_ref_status: GitRemoteRefStatus::Updated,
      observed_remote_oid: self.observed_remote_oid.clone(),
    })
  }
}

#[derive(Clone, Default)]
struct MemoryBlobStorage {
  blobs: Arc<HashMap<String, Bytes>>,
}

impl MemoryBlobStorage {
  fn with_blob(key: &str, bytes: &'static [u8]) -> Self {
    Self {
      blobs: Arc::new(HashMap::from([(key.to_string(), Bytes::from_static(bytes))])),
    }
  }
}

#[async_trait]
impl BlobStoragePort for MemoryBlobStorage {
  async fn write_blob(&self, _req: BlobWriteRequest) -> PortResult<()> {
    Ok(())
  }

  async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
    let data = self
      .blobs
      .get(key)
      .cloned()
      .ok_or_else(|| PortError::NotFound(key.to_string()))?;
    Ok(BlobReadResponse {
      key: key.to_string(),
      content_type: Some("application/octet-stream".to_string()),
      content_length: data.len() as u64,
      data,
      last_modified: None,
    })
  }

  async fn delete_blob(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }

  async fn put_avatar(&self, _key: &str, _data: Bytes, _content_type: &str) -> PortResult<String> {
    Err(PortError::InvalidInput("avatar storage not implemented in test".into()))
  }

  async fn get_avatar(&self, key: &str) -> PortResult<BlobReadResponse> {
    self.read_blob(key).await
  }

  async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }

  async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
    Err(PortError::InvalidInput(
      "multipart storage not implemented in test".into(),
    ))
  }

  async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
    Err(PortError::InvalidInput(
      "multipart storage not implemented in test".into(),
    ))
  }

  async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
    Err(PortError::InvalidInput(
      "multipart storage not implemented in test".into(),
    ))
  }

  async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
    Ok(())
  }
}

// ─── INV-GITSYNC-REBASE-01 — push-rejection retry actually rebases ──────────

/// `commit_and_push` recovers from a non-fast-forward rejection by
/// rebasing the commit onto the latest remote HEAD and pushing again.
/// Both the racing-pusher's commit AND our commit must be present in
/// the bare repo after the call.
///
/// Without the ROB-21 fix this test would fail because only Clone A's
/// file would land in the bare repo — Clone B's commit_and_push call
/// would silently return success without actually rebasing.
#[tokio::test(flavor = "multi_thread")]
async fn inv_gitsync_rebase_01_push_rejection_rebases_and_pushes() {
  require_git();
  let bare = init_bare_repo();
  let bare_url = format!("file://{}", bare.path().display());

  // Clone A — racing pusher. This clone races Clone B by pushing
  // first. Clone B's push will be rejected (non-fast-forward) and the
  // retry loop must rebase Clone B's change on top.
  let a = init_seeded_clone(&bare_url, "seed.txt", "seed\n");

  // Clone B — driven by `commit_and_push`. Cloned BEFORE A's race-push
  // so its origin/main pointer is stale.
  let b_dir = TempDir::new().unwrap();
  let b_path = b_dir.path().join("clone-b");
  clone_into(&bare_url, &b_path);

  // Clone A pushes a new file FIRST. After this, Clone B's
  // origin/main is one commit behind the remote.
  std::fs::write(a.path().join("from-a.md"), "from clone A\n").unwrap();
  git(a.path(), &["add", "."]);
  git(a.path(), &["commit", "-m", "A: add from-a.md"]);
  git(a.path(), &["push", "origin", "main"]);

  // Clone B writes its own file in its working tree (no commit yet —
  // commit_and_push does that). The change must show up in the
  // pre-commit `changed_files(None, None)` snapshot.
  std::fs::write(b_path.join("from-b.md"), "from clone B\n").unwrap();

  // Drive Clone B through commit_and_push. The first push attempt will
  // be rejected; the retry loop must rebase from-b.md on top of A's
  // commit and push the result.
  let adapter = Git2Adapter::new();
  adapter.open_repo(&b_path).await.expect("open clone B");
  let profile = make_profile(&bare_url);
  let trailers = make_trailers(profile.id, profile.workspace_id);

  let result = commit_and_push(
    &adapter,
    &profile,
    &GitAuth::None,
    "Clone B",
    "b@test.com",
    /* push_max_retries */ 3,
    &trailers,
  )
  .await;

  let receipt = result
    .expect("commit_and_push must succeed after rebase")
    .expect("commit_and_push must report Some(oid) for the rebased commit");
  let pushed_oid = &receipt.observed_remote_oid;

  // Verification: clone the bare repo into a third location and check
  // BOTH files are present. Without ROB-21, from-b.md would be missing.
  let verify_dir = TempDir::new().unwrap();
  let verify_path = verify_dir.path().join("verify");
  clone_into(&bare_url, &verify_path);
  assert!(
    verify_path.join("from-a.md").exists(),
    "from-a.md must be on remote (pushed by clone A before the race)"
  );
  assert!(
    verify_path.join("from-b.md").exists(),
    "INV-GITSYNC-REBASE-01: from-b.md must be on remote — \
     commit_and_push reported success ({pushed_oid}) but the rebase loop did not actually push the change. \
     This is the ROB-21 silent push-loss bug."
  );
  let from_b = std::fs::read_to_string(verify_path.join("from-b.md")).unwrap();
  assert_eq!(from_b, "from clone B\n", "from-b.md content must match clone B's input");
  // Cleanup happens via TempDir Drop.
}

// ─── INV-GITSYNC-FILE-ORDER-01 — binary file pushes are committed ───────────

/// A `PushToGit` file action must mutate the working tree before
/// `commit_and_push`. This is the regression gate for the production bug where
/// file actions ran after the remote commit, causing successful-looking runs
/// whose binary files never landed in Git.
#[tokio::test(flavor = "multi_thread")]
async fn inv_gitsync_file_order_01_push_to_git_is_in_remote_commit() {
  require_git();
  let bare = init_bare_repo();
  let bare_url = format!("file://{}", bare.path().display());
  let _seed = init_seeded_clone(&bare_url, "seed.txt", "seed\n");

  let work_dir = TempDir::new().unwrap();
  let work_path = work_dir.path().join("worker");
  clone_into(&bare_url, &work_path);

  let adapter = Git2Adapter::new();
  adapter.open_repo(&work_path).await.expect("open worker clone");
  let profile = make_profile(&bare_url);
  let blob_key = "file-order";
  let bytes = b"binary payload with tables and umlauts: \xc3\xa4\xc3\xb6\xc3\xbc\n";
  let blob_storage = MemoryBlobStorage::with_blob(&format!("{}/{blob_key}", profile.workspace_id), bytes);
  let actions = vec![FileReconcileAction::PushToGit {
    repo_path: "assets/export.bin".to_string(),
    blob_key: blob_key.to_string(),
    content_hash: myoxus_application::markdown::content_hash(std::str::from_utf8(bytes).unwrap()),
  }];

  let file_exec = execute_file_git_actions(&actions, &adapter, &blob_storage, profile.workspace_id, profile.id).await;
  assert!(
    file_exec.errors.is_empty(),
    "file git execution errors: {:?}",
    file_exec.errors
  );
  assert_eq!(
    file_exec.pushed.len(),
    1,
    "exactly one file must be written before commit"
  );
  assert!(
    file_exec.git_changed,
    "file push must mark the Git working tree as changed"
  );

  let receipt = commit_and_push(
    &adapter,
    &profile,
    &GitAuth::None,
    "File Order Test",
    "file-order@test.local",
    1,
    &make_trailers(profile.id, profile.workspace_id),
  )
  .await
  .expect("commit_and_push must succeed")
  .expect("file push must create a commit");
  let pushed_oid = &receipt.observed_remote_oid;

  let verify_dir = TempDir::new().unwrap();
  let verify_path = verify_dir.path().join("verify");
  clone_into(&bare_url, &verify_path);
  let remote_bytes = std::fs::read(verify_path.join("assets/export.bin")).unwrap_or_else(|err| {
    panic!("remote commit {pushed_oid} did not contain the pushed file assets/export.bin: {err}")
  });
  assert_eq!(
    remote_bytes, b"binary payload with tables and umlauts: \xc3\xa4\xc3\xb6\xc3\xbc\n",
    "remote file bytes must match the blob storage payload"
  );
}

// ─── INV-GITSYNC-REBASE-02 — empty diff returns verified remote truth ─────

/// When the racing pusher's content happens to be byte-identical to
/// what Clone B was about to push, the rebase loop's re-application
/// produces an empty diff. The function must return an `AlreadyCurrent`
/// receipt for the actual remote branch instead of losing revision truth or
/// falsely claiming success with the stale local-only OID.
#[tokio::test(flavor = "multi_thread")]
async fn inv_gitsync_rebase_02_empty_diff_after_rebase_returns_remote_receipt() {
  require_git();
  let bare = init_bare_repo();
  let bare_url = format!("file://{}", bare.path().display());

  let a = init_seeded_clone(&bare_url, "seed.txt", "seed\n");
  let b_dir = TempDir::new().unwrap();
  let b_path = b_dir.path().join("clone-b");
  clone_into(&bare_url, &b_path);

  // Both clones write the SAME content under the same path. After A
  // pushes first, B's rebase will write the same bytes back on top of
  // A's commit, producing an empty diff.
  let payload = "shared content\n";
  std::fs::write(a.path().join("shared.md"), payload).unwrap();
  git(a.path(), &["add", "."]);
  git(a.path(), &["commit", "-m", "A: shared content"]);
  git(a.path(), &["push", "origin", "main"]);

  std::fs::write(b_path.join("shared.md"), payload).unwrap();

  let adapter = Git2Adapter::new();
  adapter.open_repo(&b_path).await.expect("open clone B");
  let profile = make_profile(&bare_url);
  let trailers = make_trailers(profile.id, profile.workspace_id);

  let result = commit_and_push(
    &adapter,
    &profile,
    &GitAuth::None,
    "Clone B",
    "b@test.com",
    3,
    &trailers,
  )
  .await
  .expect("commit_and_push must succeed");

  let receipt = result.expect("remote-already-current outcome must retain remote revision evidence");
  assert_eq!(
    receipt.remote_ref_status,
    GitRemoteRefStatus::AlreadyCurrent,
    "the receipt must distinguish an externally materialized identical commit from this runner's push"
  );
  let remote_oid = git2::Repository::open_bare(bare.path())
    .expect("open bare remote")
    .find_reference("refs/heads/main")
    .expect("remote main")
    .target()
    .expect("remote main direct target")
    .to_string();
  assert_eq!(
    receipt.observed_remote_oid, remote_oid,
    "the runner must persist the actual remote branch OID after the no-diff rebase"
  );
}

#[tokio::test(flavor = "multi_thread")]
async fn callback_success_without_remote_ref_movement_is_rejected() {
  require_git();
  let bare = init_bare_repo();
  let bare_url = format!("file://{}", bare.path().display());
  let seed = init_seeded_clone(&bare_url, "seed.txt", "seed\n");
  drop(seed);
  let observed_before = git(bare.path(), &["rev-parse", "refs/heads/main"]).trim().to_string();

  let work = TempDir::new().expect("work directory");
  let work_path = work.path().join("work");
  clone_into(&bare_url, &work_path);
  std::fs::write(work_path.join("must-not-reach-remote.md"), "local only\n").expect("write local change");

  let inner = Git2Adapter::new();
  inner.open_repo(&work_path).await.expect("open worktree");
  let false_success = FalseSuccessGitRepo {
    inner,
    observed_remote_oid: observed_before.clone(),
  };
  let profile = make_profile(&bare_url);
  let error = commit_and_push(
    &false_success,
    &profile,
    &GitAuth::None,
    "False success",
    "false-success@test.local",
    0,
    &make_trailers(profile.id, profile.workspace_id),
  )
  .await
  .expect_err("remote ref mismatch must reject callback-level success");

  assert!(error.is_retryable(), "remote verification mismatch must be retryable");
  assert_eq!(
    git(bare.path(), &["rev-parse", "refs/heads/main"]).trim(),
    observed_before,
    "the fixture must prove the remote branch did not move"
  );
}
