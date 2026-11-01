// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for the Git2Adapter against real local git repositories.
//!
//! These tests exercise actual git operations (clone, commit, push, fetch,
//! changed_files) using temporary directories with `file://` URLs.
//! No mocks, no network access required.

#[path = "support/git_https_fixture.rs"]
mod git_https_fixture;

use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use tracing::info;

use myoxus_application::git_sync::backend::{GitAuth, GitRepositoryPort, HttpsCertificatePolicy};
use myoxus_application::git_sync::export::{ExportFrontmatter, compose_markdown_file, split_markdown_file};
use myoxus_application::git_sync::import::parse_imported_file;
use myoxus_application::git_sync::reconcile::{BaselineState, ReconcileAction, SideState, reconcile_binding};
use myoxus_application::markdown::{content_hash, prepare_markdown_import};
use myoxus_domain::git_sync::{ConflictType, SyncDirection};
use myoxus_infrastructure::git_sync::Git2Adapter;

use git_https_fixture::{GitHttpsFixture, TestAuthority};

// ─── Helpers ────────────────────────────────────────────────────────────────

fn init_tracing() {
  let _ = tracing_subscriber::fmt()
    .with_env_filter("debug")
    .with_test_writer()
    .try_init();
}

/// Run a git CLI command in a directory and assert success.
fn git(dir: &Path, args: &[&str]) -> String {
  let output = Command::new("git")
    .args(args)
    .current_dir(dir)
    .env("GIT_TERMINAL_PROMPT", "0")
    .output()
    .unwrap_or_else(|e| panic!("failed to run git {}: {e}", args.join(" ")));
  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    panic!("git {} failed in {}:\n{}", args.join(" "), dir.display(), stderr);
  }
  String::from_utf8_lossy(&output.stdout).to_string()
}

/// Create a bare repo (acts as a remote "origin").
fn init_bare_repo() -> TempDir {
  let dir = TempDir::new().unwrap();
  git(dir.path(), &["init", "--bare", "--initial-branch=main"]);
  dir
}

/// Create a repo with an initial commit on branch "main".
fn init_repo_with_file(filename: &str, content: &str) -> TempDir {
  let dir = TempDir::new().unwrap();
  git(dir.path(), &["init", "--initial-branch=main"]);
  git(dir.path(), &["config", "user.email", "test@test.com"]);
  git(dir.path(), &["config", "user.name", "Test"]);
  std::fs::write(dir.path().join(filename), content).unwrap();
  git(dir.path(), &["add", "."]);
  git(dir.path(), &["commit", "-m", "initial"]);
  dir
}

/// Create a repo with initial commit, add a bare remote as "origin", and push.
fn init_repo_with_remote(filename: &str, content: &str) -> (TempDir, TempDir) {
  let bare = init_bare_repo();
  let work = TempDir::new().unwrap();
  git(work.path(), &["init", "--initial-branch=main"]);
  git(work.path(), &["config", "user.email", "test@test.com"]);
  git(work.path(), &["config", "user.name", "Test"]);
  std::fs::write(work.path().join(filename), content).unwrap();
  git(work.path(), &["add", "."]);
  git(work.path(), &["commit", "-m", "initial"]);
  let bare_url = format!("file://{}", bare.path().display());
  git(work.path(), &["remote", "add", "origin", &bare_url]);
  git(work.path(), &["push", "-u", "origin", "main"]);
  (bare, work)
}

fn file_url(dir: &TempDir) -> String {
  format!("file://{}", dir.path().display())
}

/// Ensure git CLI is available (skip test gracefully if not).
fn require_git() {
  let output = Command::new("git").arg("--version").output();
  if output.is_err() || !output.unwrap().status.success() {
    panic!("git CLI not available — cannot run git sync integration tests");
  }
}

#[tokio::test]
async fn configured_private_ca_is_shared_by_probe_clone_fetch_push_and_strict_negative_controls() {
  require_git();
  init_tracing();

  let trusted_root = TestAuthority::root("Git-Sync trusted root");
  let trusted_server = GitHttpsFixture::start(&trusted_root, "localhost", false, None);
  let bundle_root = tempfile::tempdir().expect("private CA bundle root");
  let bundle = bundle_root.path().join("private-ca.pem");
  std::fs::write(&bundle, trusted_root.pem()).expect("write private CA bundle");
  // SAFETY: this integration target materializes its process-global test CA
  // once, before starting any successful HTTPS Git operation.
  unsafe {
    git2::opts::set_ssl_cert_file(&bundle).expect("materialize private CA for libgit2");
  }

  let authenticated_server =
    GitHttpsFixture::start_authenticated(&trusted_root, "localhost", "fixture-user", "valid-token");
  let valid_auth = GitAuth::HttpsToken {
    username: "fixture-user".to_string(),
    token: "valid-token".to_string(),
  };
  let rejected_auth = GitAuth::HttpsToken {
    username: "fixture-user".to_string(),
    token: "rejected-token".to_string(),
  };
  Git2Adapter::with_config(20, 10, 1)
    .probe_remote(authenticated_server.url(), Some("main"), &valid_auth)
    .await
    .expect("authenticated fixture must accept the controlled credential");
  let rejected_probe = Git2Adapter::with_config(20, 10, 1)
    .probe_remote(authenticated_server.url(), Some("main"), &rejected_auth)
    .await;
  assert!(
    matches!(rejected_probe, Err(myoxus_application::git_sync::GitError::Auth(_))),
    "real HTTP authentication denial must remain typed as Auth: {rejected_probe:?}"
  );
  let authenticated_work = tempfile::tempdir().expect("authenticated HTTPS Git worktree");
  let authenticated_clone = authenticated_work.path().join("clone");
  let authenticated_adapter = Git2Adapter::with_config(20, 10, 1);
  authenticated_adapter
    .clone_repo(authenticated_server.url(), &authenticated_clone, "main", &valid_auth)
    .await
    .expect("clone with accepted fixture credential");
  let rejected_fetch = authenticated_adapter.fetch(&rejected_auth).await;
  assert!(
    matches!(rejected_fetch, Err(myoxus_application::git_sync::GitError::Auth(_))),
    "real fetch authentication denial must remain typed as Auth: {rejected_fetch:?}"
  );

  let probe = Git2Adapter::with_config(20, 10, 1)
    .probe_remote(trusted_server.url(), Some("main"), &GitAuth::None)
    .await
    .expect("connection probe must trust the configured private CA");
  assert_eq!(probe.branch.as_deref(), Some("main"));
  assert_eq!(probe.observed_remote_oid.as_deref().map(str::len), Some(40));

  let work = tempfile::tempdir().expect("HTTPS Git worktree");
  let clone_path = work.path().join("clone");
  let adapter = Git2Adapter::with_config(20, 10, 1);
  adapter
    .clone_repo(trusted_server.url(), &clone_path, "main", &GitAuth::None)
    .await
    .expect("clone must use the configured private CA");
  adapter
    .write_file("pushed-over-https.md", b"private CA push\n")
    .await
    .expect("write HTTPS fixture file");
  let intended_oid = adapter
    .commit("Exercise private CA push", "TLS fixture", "tls@example.test")
    .await
    .expect("commit HTTPS fixture file");
  let receipt = adapter
    .push("main", &intended_oid, &GitAuth::None)
    .await
    .expect("push must use the configured private CA");
  assert_eq!(receipt.observed_remote_oid, intended_oid);
  adapter
    .fetch(&GitAuth::None)
    .await
    .expect("fetch must use the configured private CA");
  assert_eq!(
    adapter
      .read_file("pushed-over-https.md")
      .await
      .expect("read file after HTTPS fetch"),
    b"private CA push\n"
  );

  let untrusted_root = TestAuthority::root("Git-Sync untrusted root");
  let wrong_ca_server = GitHttpsFixture::start(&untrusted_root, "localhost", false, None);
  assert!(matches!(
    Git2Adapter::with_config(20, 10, 1)
      .probe_remote(wrong_ca_server.url(), Some("main"), &GitAuth::None)
      .await,
    Err(myoxus_application::git_sync::GitError::Tls(_))
  ));
  Git2Adapter::with_config(20, 10, 1)
    .with_https_certificate_policy(HttpsCertificatePolicy::InsecureNoVerify, ["localhost".to_string()])
    .probe_remote(wrong_ca_server.url(), Some("main"), &GitAuth::None)
    .await
    .expect("explicit exact-host bypass must accept the otherwise untrusted fixture");
  assert!(matches!(
    Git2Adapter::with_config(20, 10, 1)
      .with_https_certificate_policy(
        HttpsCertificatePolicy::InsecureNoVerify,
        ["other.example.test".to_string()]
      )
      .probe_remote(wrong_ca_server.url(), Some("main"), &GitAuth::None)
      .await,
    Err(myoxus_application::git_sync::GitError::Tls(_))
  ));

  let wrong_hostname_server = GitHttpsFixture::start(&trusted_root, "wrong.example.test", false, None);
  assert!(matches!(
    Git2Adapter::with_config(20, 10, 1)
      .probe_remote(wrong_hostname_server.url(), Some("main"), &GitAuth::None)
      .await,
    Err(myoxus_application::git_sync::GitError::Tls(_))
  ));

  let expired_server = GitHttpsFixture::start(&trusted_root, "localhost", true, None);
  assert!(matches!(
    Git2Adapter::with_config(20, 10, 1)
      .probe_remote(expired_server.url(), Some("main"), &GitAuth::None)
      .await,
    Err(myoxus_application::git_sync::GitError::Tls(_))
  ));

  let intermediate = trusted_root.intermediate("Git-Sync intermediate");
  let incomplete_chain_server = GitHttpsFixture::start(&intermediate, "localhost", false, None);
  assert!(matches!(
    Git2Adapter::with_config(20, 10, 1)
      .probe_remote(incomplete_chain_server.url(), Some("main"), &GitAuth::None)
      .await,
    Err(myoxus_application::git_sync::GitError::Tls(_))
  ));
  let complete_chain_server = GitHttpsFixture::start(&intermediate, "localhost", false, Some(&intermediate));
  Git2Adapter::with_config(20, 10, 1)
    .probe_remote(complete_chain_server.url(), Some("main"), &GitAuth::None)
    .await
    .expect("complete private chain must verify through the configured root");

  let redirect_username = "redirect-user";
  let redirect_secret = "redirect-secret";
  let authenticated_target =
    GitHttpsFixture::start_authenticated(&trusted_root, "127.0.0.1", redirect_username, redirect_secret);
  let allowed_redirect = GitHttpsFixture::start_redirect(&trusted_root, authenticated_target.url());
  let redirect_auth = GitAuth::HttpsToken {
    username: redirect_username.to_string(),
    token: redirect_secret.to_string(),
  };
  let redirect_probe = Git2Adapter::with_config(20, 10, 1)
    .with_https_certificate_policy(
      HttpsCertificatePolicy::Strict,
      ["localhost".to_string(), "127.0.0.1".to_string()],
    )
    .probe_remote(allowed_redirect.url(), Some("main"), &redirect_auth)
    .await
    .expect("explicitly allowed redirect target must receive credentials");
  assert_eq!(redirect_probe.branch.as_deref(), Some("main"));

  let redirect_work = tempfile::tempdir().expect("redirect HTTPS Git worktree");
  let redirect_clone_path = redirect_work.path().join("clone");
  let redirect_adapter = Git2Adapter::with_config(20, 10, 1).with_https_certificate_policy(
    HttpsCertificatePolicy::Strict,
    ["localhost".to_string(), "127.0.0.1".to_string()],
  );
  redirect_adapter
    .clone_repo(allowed_redirect.url(), &redirect_clone_path, "main", &redirect_auth)
    .await
    .expect("clone must use the shared redirect-aware callback");
  redirect_adapter
    .write_file("redirect-roundtrip.md", b"redirect-bound credentials\n")
    .await
    .expect("write redirect fixture file");
  let redirect_oid = redirect_adapter
    .commit("Exercise redirect-bound credentials", "TLS fixture", "tls@example.test")
    .await
    .expect("commit redirect fixture file");
  redirect_adapter
    .push("main", &redirect_oid, &redirect_auth)
    .await
    .expect("push and remote verification must use redirect-bound credentials");
  redirect_adapter
    .fetch(&redirect_auth)
    .await
    .expect("fetch must use redirect-bound credentials");
  assert!(
    authenticated_target.credentialed_requests() >= 4,
    "probe, clone, push verification and fetch must reach the allowed target with credentials"
  );

  let rejected_target =
    GitHttpsFixture::start_authenticated(&trusted_root, "127.0.0.1", redirect_username, redirect_secret);
  let rejected_redirect = GitHttpsFixture::start_redirect(&trusted_root, rejected_target.url());
  let rejected = Git2Adapter::with_config(20, 10, 1)
    .with_https_certificate_policy(HttpsCertificatePolicy::Strict, ["localhost".to_string()])
    .probe_remote(rejected_redirect.url(), Some("main"), &redirect_auth)
    .await;
  assert!(
    matches!(rejected, Err(myoxus_application::git_sync::GitError::Auth(_))),
    "unlisted redirect target must fail at the credential boundary: {rejected:?}"
  );
  assert_eq!(
    rejected_target.credentialed_requests(),
    0,
    "unlisted redirect target must never receive an Authorization header"
  );
}

// ─── Git2Adapter: clone & open ───────────────────────────────────────────────

#[tokio::test]
async fn clone_local_repo_and_read_head_oid() {
  require_git();
  init_tracing();

  let (bare, _pusher) = init_repo_with_remote("README.md", "# Test repo\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");

  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .expect("clone must succeed for local file:// URL");

  let oid = adapter.head_oid().await.expect("HEAD OID must be readable");
  assert_eq!(oid.len(), 40, "OID must be 40-char hex SHA-1");
  assert!(oid.chars().all(|c| c.is_ascii_hexdigit()), "OID must be hex: {oid}");
  info!(oid, "clone + head_oid test passed");
}

#[tokio::test]
async fn clone_depth_does_not_break_local_file_remote() {
  require_git();
  init_tracing();

  let (bare, pusher) = init_repo_with_remote("seed.txt", "seed\n");
  for idx in 1..=3 {
    std::fs::write(
      pusher.path().join(format!("change-{idx}.txt")),
      format!("change {idx}\n"),
    )
    .unwrap();
    git(pusher.path(), &["add", "."]);
    git(pusher.path(), &["commit", "-m", &format!("change {idx}")]);
  }
  git(pusher.path(), &["push", "origin", "main"]);

  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::with_config(120, 30, 1);
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .expect("clone_depth must not force unsupported shallow mode for local file:// URL");

  let commit_count = git(&clone_path, &["rev-list", "--count", "HEAD"]);
  assert_eq!(
    commit_count.trim(),
    "4",
    "local file:// remotes do not support shallow fetch in libgit2; adapter must skip depth for this transport"
  );
}

#[tokio::test]
async fn open_existing_repo() {
  require_git();
  init_tracing();

  let origin = init_repo_with_file("README.md", "# Hello\n");
  let adapter = Git2Adapter::new();

  adapter
    .open_repo(origin.path())
    .await
    .expect("opening an existing git repo must succeed");

  let oid = adapter.head_oid().await.unwrap();
  assert!(!oid.is_empty());
}

// ─── Git2Adapter: write, read, commit ────────────────────────────────────────

#[tokio::test]
async fn write_read_roundtrip() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  let content = b"# Hello World\n\nParagraph here.\n";
  adapter
    .write_file("content/test.md", content)
    .await
    .expect("write_file must succeed");

  let read_back = adapter
    .read_file("content/test.md")
    .await
    .expect("read_file must succeed");
  assert_eq!(read_back, content, "read must return exactly what was written");
}

#[tokio::test]
async fn write_delete_and_rename_reject_unsafe_repo_paths() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  let traversal = adapter.write_file("../outside.txt", b"pwned\n").await;
  assert!(traversal.is_err(), "path traversal must be rejected");
  assert!(
    !work.path().join("outside.txt").exists(),
    "unsafe path must not create files outside the repository"
  );

  let git_metadata = adapter.write_file(".git/hooks/post-commit", b"pwned\n").await;
  assert!(git_metadata.is_err(), ".git metadata writes must be rejected");
  assert!(
    !clone_path.join(".git/hooks/post-commit").exists(),
    "unsafe .git metadata write must not create a hook"
  );

  adapter.write_file("safe.txt", b"safe\n").await.unwrap();
  assert!(adapter.rename_file("safe.txt", "../moved.txt").await.is_err());
  assert!(adapter.delete_file("../outside.txt").await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn write_file_rejects_symlink_escape_inside_repo() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let outside = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  std::os::unix::fs::symlink(outside.path(), clone_path.join("escape")).expect("create symlink in test repo");
  let err = adapter.write_file("escape/pwned.txt", b"pwned\n").await;
  assert!(err.is_err(), "writes through repo-local symlinks must be rejected");
  assert!(
    !outside.path().join("pwned.txt").exists(),
    "rejected symlink path must not write outside the repository"
  );
}

#[tokio::test]
async fn commit_creates_new_oid() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  let oid_before = adapter.head_oid().await.unwrap();

  adapter.write_file("new-file.md", b"new content\n").await.unwrap();

  let oid_after = adapter
    .commit("Add new file", "Test Author", "test@author.com")
    .await
    .expect("commit must succeed");

  assert_ne!(oid_before, oid_after, "commit must produce a new OID");
  assert_eq!(oid_after.len(), 40);
}

#[tokio::test]
async fn no_changes_after_commit() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  adapter.write_file("doc.md", b"content\n").await.unwrap();
  adapter.commit("add doc", "Test", "test@test.com").await.unwrap();

  let changes = adapter.changed_files(None, None).await.unwrap();
  assert!(
    changes.is_empty(),
    "working tree must be clean after commit, got: {changes:?}"
  );
}

// ─── Git2Adapter: changed_files detection ────────────────────────────────────

#[tokio::test]
async fn changed_files_detects_new_file() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  // Stage and commit a file to get a baseline, then add another
  adapter.write_file("first.md", b"first\n").await.unwrap();
  let oid1 = adapter.commit("add first", "T", "t@t.com").await.unwrap();

  adapter.write_file("second.md", b"second\n").await.unwrap();
  let oid2 = adapter.commit("add second", "T", "t@t.com").await.unwrap();

  let changes = adapter.changed_files(Some(&oid1), Some(&oid2)).await.unwrap();

  assert_eq!(changes.len(), 1, "should detect exactly one changed file");
  assert_eq!(changes[0].path, "second.md");
  assert_eq!(changes[0].change_type, myoxus_application::git_sync::ChangeType::Added);
}

#[tokio::test]
async fn changed_files_head_vs_worktree_reports_untracked_as_added() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  adapter
    .write_file("untracked.md", b"new working tree file\n")
    .await
    .unwrap();
  let changes = adapter.changed_files(None, None).await.unwrap();

  assert_eq!(changes.len(), 1, "untracked working-tree file must be visible");
  assert_eq!(changes[0].path, "untracked.md");
  assert_eq!(
    changes[0].change_type,
    myoxus_application::git_sync::ChangeType::Added,
    "git2 Delta::Untracked must be classified as Added, not Modified"
  );
}

#[tokio::test]
async fn changed_files_detects_modification() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("doc.md", "original\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  let oid_before = adapter.head_oid().await.unwrap();

  adapter.write_file("doc.md", b"modified\n").await.unwrap();
  let oid_after = adapter.commit("modify doc", "T", "t@t.com").await.unwrap();

  let changes = adapter
    .changed_files(Some(&oid_before), Some(&oid_after))
    .await
    .unwrap();

  assert_eq!(changes.len(), 1);
  assert_eq!(changes[0].path, "doc.md");
  assert_eq!(
    changes[0].change_type,
    myoxus_application::git_sync::ChangeType::Modified
  );
}

#[tokio::test]
async fn changed_files_detects_deletion() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("to-delete.md", "content\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  let oid_before = adapter.head_oid().await.unwrap();

  adapter.delete_file("to-delete.md").await.unwrap();
  let oid_after = adapter.commit("delete file", "T", "t@t.com").await.unwrap();

  let changes = adapter
    .changed_files(Some(&oid_before), Some(&oid_after))
    .await
    .unwrap();

  assert_eq!(changes.len(), 1);
  assert_eq!(changes[0].path, "to-delete.md");
  assert_eq!(
    changes[0].change_type,
    myoxus_application::git_sync::ChangeType::Deleted
  );
}

// ─── Git2Adapter: delete_file / rename_file ──────────────────────────────────

#[tokio::test]
async fn delete_file_removes_from_worktree() {
  require_git();
  init_tracing();

  let origin = init_repo_with_file("target.md", "to be deleted\n");
  let adapter = Git2Adapter::new();
  adapter.open_repo(origin.path()).await.unwrap();

  adapter.delete_file("target.md").await.unwrap();

  let err = adapter.read_file("target.md").await;
  assert!(err.is_err(), "reading deleted file must fail");
}

#[tokio::test]
async fn rename_file_moves_content() {
  require_git();
  init_tracing();

  let origin = init_repo_with_file("old-name.md", "content to move\n");
  let adapter = Git2Adapter::new();
  adapter.open_repo(origin.path()).await.unwrap();

  adapter.rename_file("old-name.md", "new-name.md").await.unwrap();

  let err = adapter.read_file("old-name.md").await;
  assert!(err.is_err(), "old path must not exist after rename");

  let content = adapter.read_file("new-name.md").await.unwrap();
  assert_eq!(content, b"content to move\n");
}

#[tokio::test]
async fn rename_file_creates_parent_dirs() {
  require_git();
  init_tracing();

  let origin = init_repo_with_file("flat.md", "content\n");
  let adapter = Git2Adapter::new();
  adapter.open_repo(origin.path()).await.unwrap();

  adapter.rename_file("flat.md", "sub/dir/moved.md").await.unwrap();

  let content = adapter.read_file("sub/dir/moved.md").await.unwrap();
  assert_eq!(content, b"content\n");
}

// ─── Git2Adapter: push to bare repo ─────────────────────────────────────────

#[tokio::test]
async fn push_to_bare_repo() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  adapter
    .write_file("pushed-file.md", b"push test content\n")
    .await
    .unwrap();
  let intended_oid = adapter
    .commit("add pushed file", "Push Author", "push@test.com")
    .await
    .unwrap();

  adapter
    .push("main", &intended_oid, &GitAuth::None)
    .await
    .expect("push to local bare repo must succeed");

  // Verify: clone from bare again and check the file exists
  let verify_dir = TempDir::new().unwrap();
  let verify_path = verify_dir.path().join("verify");
  let verify_adapter = Git2Adapter::new();
  verify_adapter
    .clone_repo(&file_url(&bare), &verify_path, "main", &GitAuth::None)
    .await
    .unwrap();
  let content = verify_adapter.read_file("pushed-file.md").await.unwrap();
  assert_eq!(content, b"push test content\n");
}

// ─── Git2Adapter: fetch from remote ─────────────────────────────────────────

#[tokio::test]
async fn fetch_picks_up_remote_changes() {
  require_git();
  init_tracing();

  let (bare, pusher) = init_repo_with_remote("seed.txt", "seed\n");

  // Clone into a separate working copy
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  let oid_before = adapter.head_oid().await.unwrap();

  // Push a new commit from the "pusher" clone
  std::fs::write(pusher.path().join("remote-change.md"), "from remote\n").unwrap();
  git(pusher.path(), &["add", "."]);
  git(pusher.path(), &["commit", "-m", "remote commit"]);
  git(pusher.path(), &["push", "origin", "main"]);

  // Fetch must not error and must see the new commit.
  adapter.fetch(&GitAuth::None).await.expect("fetch must succeed");

  // After fetch, origin/main should have advanced
  let remote_oid = git(&clone_path, &["rev-parse", "origin/main"]);
  assert_ne!(remote_oid.trim(), oid_before, "origin/main must advance after fetch");
}

// ─── Export/Import roundtrip through real git ───────────────────────────────

#[tokio::test]
async fn full_export_import_roundtrip_with_real_git() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  // 1. Build export documents
  let sync_id = uuid::Uuid::new_v4();
  let doc_id = uuid::Uuid::new_v4();
  let workspace_id = uuid::Uuid::new_v4();
  let title = "Integration Test Document";
  let markdown_body = "# Main Heading\n\nThis is the body text.\n\n- Item 1\n- Item 2\n";

  let fm = ExportFrontmatter {
    sync_id,
    doc_id,
    workspace_id,
    title: title.to_string(),
  };
  let file_content = compose_markdown_file(&fm, markdown_body);

  // 2. Write to git working tree
  adapter
    .write_file("content/integration-test-document.md", file_content.as_bytes())
    .await
    .unwrap();

  // 3. Commit
  let oid = adapter
    .commit("Export integration test doc", "Myoxus Sync", "sync@myoxus.local")
    .await
    .unwrap();
  assert!(!oid.is_empty());

  // 4. Read back from git working tree
  let read_bytes = adapter.read_file("content/integration-test-document.md").await.unwrap();
  let read_str = String::from_utf8(read_bytes).unwrap();

  // 5. Import (parse)
  let imported = parse_imported_file("content/integration-test-document.md", &read_str).unwrap();

  // 6. Verify identity fields preserved
  assert_eq!(imported.sync_id, Some(sync_id), "sync_id must roundtrip");
  assert_eq!(imported.doc_id, Some(doc_id), "doc_id must roundtrip");
  assert_eq!(imported.title, title, "title must roundtrip");
  assert_eq!(
    imported.classification,
    myoxus_application::git_sync::ImportClassification::ExistingDoc
  );

  // 7. Verify content preserved
  assert!(
    imported.markdown.contains("# Main Heading"),
    "heading must survive: {}",
    imported.markdown
  );
  assert!(
    imported.markdown.contains("- Item 2"),
    "list items must survive: {}",
    imported.markdown
  );

  // 8. Prepare the parsed body through the Application conversion boundary.
  let prepared = prepare_markdown_import(&imported.title, &imported.markdown).expect("prepare imported document");
  assert!(!prepared.yjs_binary.is_empty(), "yjs binary must be non-empty");

  // 9. Content hash is stable
  let (_, body) = split_markdown_file(&read_str);
  let hash = content_hash(&body);
  assert_eq!(
    hash, imported.content_hash,
    "content hash must match between manual and import"
  );

  info!("full export/import roundtrip passed");
}

// ─── Reconcile with real git changes ────────────────────────────────────────

#[tokio::test]
async fn reconcile_detects_pull_to_myoxus_for_git_modification() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  // Export a doc
  let fm = ExportFrontmatter {
    sync_id: uuid::Uuid::new_v4(),
    doc_id: uuid::Uuid::new_v4(),
    workspace_id: uuid::Uuid::new_v4(),
    title: "Reconcile Test".to_string(),
  };
  let original_body = "Original content\n";
  let file_content = compose_markdown_file(&fm, original_body);
  let baseline_hash = content_hash(original_body);

  adapter
    .write_file("content/reconcile-test.md", file_content.as_bytes())
    .await
    .unwrap();
  adapter.commit("export doc", "T", "t@t.com").await.unwrap();

  // Simulate external git modification
  let modified_body = "Modified in git\n";
  let modified_content = compose_markdown_file(&fm, modified_body);
  adapter
    .write_file("content/reconcile-test.md", modified_content.as_bytes())
    .await
    .unwrap();
  adapter
    .commit("external edit", "External", "ext@test.com")
    .await
    .unwrap();

  // Read the modified file
  let read_bytes = adapter.read_file("content/reconcile-test.md").await.unwrap();
  let read_str = String::from_utf8(read_bytes).unwrap();
  let (_, git_body) = split_markdown_file(&read_str);
  let git_hash = content_hash(&git_body);

  // Reconcile: myoxus side unchanged (matches baseline), git side changed
  let myoxus_state = SideState {
    exists: true,
    content_hash: Some(baseline_hash.clone()),
    content: Some(original_body.to_string()),
  };
  let git_state = SideState {
    exists: true,
    content_hash: Some(git_hash),
    content: Some(git_body),
  };
  let baseline = BaselineState {
    content_hash: baseline_hash,
  };

  let action = reconcile_binding(&myoxus_state, &git_state, Some(&baseline), SyncDirection::Bidirectional);
  assert_eq!(
    action,
    ReconcileAction::PullToMyoxus,
    "only git changed => PullToMyoxus"
  );
}

#[tokio::test]
async fn reconcile_detects_conflict_when_both_modified() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  // Export a doc and record baseline
  let fm = ExportFrontmatter {
    sync_id: uuid::Uuid::new_v4(),
    doc_id: uuid::Uuid::new_v4(),
    workspace_id: uuid::Uuid::new_v4(),
    title: "Conflict Test".to_string(),
  };
  let original_body = "Baseline content\n";
  let baseline_hash = content_hash(original_body);

  let file_content = compose_markdown_file(&fm, original_body);
  adapter
    .write_file("content/conflict-test.md", file_content.as_bytes())
    .await
    .unwrap();
  adapter.commit("export", "T", "t@t.com").await.unwrap();

  // Git side: modify
  let git_modified = "Git-side change\n";
  let git_content = compose_markdown_file(&fm, git_modified);
  adapter
    .write_file("content/conflict-test.md", git_content.as_bytes())
    .await
    .unwrap();
  adapter.commit("git edit", "G", "g@g.com").await.unwrap();

  let git_hash = content_hash(git_modified);

  // Myoxus side: also modified (different change)
  let myoxus_modified = "Myoxus-side change\n";
  let myoxus_hash = content_hash(myoxus_modified);

  let myoxus_state = SideState {
    exists: true,
    content_hash: Some(myoxus_hash),
    content: Some(myoxus_modified.to_string()),
  };
  let git_state = SideState {
    exists: true,
    content_hash: Some(git_hash),
    content: Some(git_modified.to_string()),
  };
  let baseline = BaselineState {
    content_hash: baseline_hash,
  };

  let action = reconcile_binding(&myoxus_state, &git_state, Some(&baseline), SyncDirection::Bidirectional);
  assert_eq!(
    action,
    ReconcileAction::Conflict(ConflictType::BothModified),
    "both sides modified => BothModified conflict"
  );
}

// ─── Multi-file export/import with folder structure ─────────────────────────

#[tokio::test]
async fn multi_file_export_preserves_folder_structure() {
  require_git();
  init_tracing();

  let (bare, _) = init_repo_with_remote("seed.txt", "seed\n");
  let work = TempDir::new().unwrap();
  let clone_path = work.path().join("repo");
  let adapter = Git2Adapter::new();
  adapter
    .clone_repo(&file_url(&bare), &clone_path, "main", &GitAuth::None)
    .await
    .unwrap();

  let ws_id = uuid::Uuid::new_v4();

  // Export two docs in different folders
  let fm1 = ExportFrontmatter {
    sync_id: uuid::Uuid::new_v4(),
    doc_id: uuid::Uuid::new_v4(),
    workspace_id: ws_id,
    title: "Root Doc".to_string(),
  };
  let fm2 = ExportFrontmatter {
    sync_id: uuid::Uuid::new_v4(),
    doc_id: uuid::Uuid::new_v4(),
    workspace_id: ws_id,
    title: "Nested Doc".to_string(),
  };

  let file1 = compose_markdown_file(&fm1, "Root content\n");
  let file2 = compose_markdown_file(&fm2, "Nested content\n");

  adapter
    .write_file("content/root-doc.md", file1.as_bytes())
    .await
    .unwrap();
  adapter
    .write_file("content/folder/nested-doc.md", file2.as_bytes())
    .await
    .unwrap();
  adapter.commit("export multi", "T", "t@t.com").await.unwrap();

  // Read both back and import
  let r1 = adapter.read_file("content/root-doc.md").await.unwrap();
  let r2 = adapter.read_file("content/folder/nested-doc.md").await.unwrap();

  let i1 = parse_imported_file("content/root-doc.md", &String::from_utf8(r1).unwrap()).unwrap();
  let i2 = parse_imported_file("content/folder/nested-doc.md", &String::from_utf8(r2).unwrap()).unwrap();

  assert_eq!(i1.sync_id, Some(fm1.sync_id));
  assert_eq!(i2.sync_id, Some(fm2.sync_id));
  assert_eq!(i1.title, "Root Doc");
  assert_eq!(i2.title, "Nested Doc");
  assert_eq!(i1.repo_path, "content/root-doc.md");
  assert_eq!(i2.repo_path, "content/folder/nested-doc.md");
}

// ─── Error cases ────────────────────────────────────────────────────────────

#[tokio::test]
async fn read_nonexistent_file_returns_not_found() {
  require_git();
  init_tracing();

  let origin = init_repo_with_file("exists.md", "yes\n");
  let adapter = Git2Adapter::new();
  adapter.open_repo(origin.path()).await.unwrap();

  let result = adapter.read_file("does-not-exist.md").await;
  assert!(result.is_err());
  let err = result.unwrap_err();
  let err_str = format!("{err}");
  assert!(
    err_str.contains("not found") || err_str.contains("Not found"),
    "error must indicate not found: {err_str}"
  );
}

#[tokio::test]
async fn delete_nonexistent_file_returns_not_found() {
  require_git();
  init_tracing();

  let origin = init_repo_with_file("exists.md", "yes\n");
  let adapter = Git2Adapter::new();
  adapter.open_repo(origin.path()).await.unwrap();

  let result = adapter.delete_file("ghost.md").await;
  assert!(result.is_err());
}

#[tokio::test]
async fn operations_before_open_return_error() {
  init_tracing();

  let adapter = Git2Adapter::new();
  let err = adapter.head_oid().await;
  assert!(err.is_err(), "head_oid before open must fail");

  let err = adapter.read_file("any.md").await;
  assert!(err.is_err(), "read_file before open must fail");

  let err = adapter.write_file("any.md", b"x").await;
  assert!(err.is_err(), "write_file before open must fail");
}
