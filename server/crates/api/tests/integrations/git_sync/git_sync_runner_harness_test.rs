//! Runner-level Git-Sync tests with an injected Git port.
//!
//! The production runner still wires `Git2Adapter`. These tests inject a small
//! deterministic `GitRepositoryPort` so we can exercise the same runner code
//! without permitting `file://` profiles or public network dependencies.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use serde_json::json;
use tempfile::TempDir;
use uuid::Uuid;

use myoxus_api::config::AppConfig;
use myoxus_api::git_sync_engine::runner::{RunnerConfig, run_sync_with_git_repo};
use myoxus_api::git_sync_engine::{loader, locking};
use myoxus_application::doc::DocService;
use myoxus_application::git_sync::backend::{
  ChangeType, ChangedFile, GitAuth, GitError, GitPushReceipt, GitRemoteRefStatus, GitRepositoryIdentity,
  GitRepositoryPort,
};
use myoxus_application::git_sync::file_reconcile::blob_key_for_content;
use myoxus_application::git_sync::{
  GitSyncCoordinationError, GitSyncRepositoryCoordination, GitSyncRepositoryScope, export, projection,
};
use myoxus_application::markdown::{content_hash, markdown_to_yjs, yjs_to_markdown};
use myoxus_application::organizer::{
  CreateOrganizerFolder, CreateOrganizerLink, OrganizerLinkType, OrganizerService, UpdateOrganizerFolder,
};
use myoxus_application::ports::{
  BlobReadResponse, BlobStoragePort, BlobWriteRequest, MultipartCompleteRequest, MultipartCreateRequest,
  MultipartCreateResponse, MultipartPartUrlRequest, MultipartPartUrlResponse, PortError, PortResult,
};
use myoxus_domain::git_sync::{
  AuthMethod, GitSyncProfile, GitSyncRun, GitSyncRunSource, RunStatus, SyncDirection, TriggerMode,
};
use myoxus_infrastructure::crypto;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::git_sync::{PgGitSyncRepositoryCoordination, SqlxGitSyncStore};

use crate::helpers;

const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";
const REPO_PATH: &str = "content/assets/check.png";

/// Feed publication's recorded tree through the existing normal runner harness.
/// The SQL receipt fixture owns handoff; this helper owns no alternate admission.
pub(crate) async fn sync_extracted_tree(
  pool: &sqlx::PgPool,
  config: &RunnerConfig,
  storage: &dyn BlobStoragePort,
  profiles: &[Uuid],
  files: &std::collections::BTreeMap<String, Vec<u8>>,
) -> Vec<std::collections::BTreeMap<String, Vec<u8>>> {
  let entries = files
    .iter()
    .map(|(path, bytes)| (path.as_str(), bytes.as_slice()))
    .collect::<Vec<_>>();
  let repo = HarnessGitRepo::with_files(&entries);
  let store = SqlxGitSyncStore::new(pool.clone());
  let mut results = Vec::new();
  for id in profiles {
    let profile = store.get_profile(*id).await.expect("published follow-up profile");
    let run = create_run(&store, &profile).await;
    let outcome = run_sync_with_git_repo(pool, config, &locking::new_locks(), storage, &repo, *id, run)
      .await
      .expect("normal sync after Extract publication");
    assert_eq!(outcome["status"], "Completed");
    results.push(
      repo
        .files
        .lock()
        .expect("remote tree")
        .iter()
        .map(|(path, bytes)| (path.clone(), bytes.clone()))
        .collect(),
    );
  }
  results
}

#[tokio::test]
async fn source_run_preserves_a_detached_child_with_a_generated_overview() {
  let _policy_lock = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  use futures_util::FutureExt;
  let outcome = std::panic::AssertUnwindSafe(async {
    let config = AppConfig::load().expect("load app config");
    let store = SqlxGitSyncStore::new(pool.clone());
    let temp = TempDir::new().expect("mirror root");
    let child_overview = myoxus_application::workspace_overview::markdown::GIT_OVERVIEW_MARKER.as_bytes();
    let child_manifest = b"child manifest must remain unchanged";
    let repo = HarnessGitRepo::with_files(&[
      ("content/child/README.md", child_overview),
      ("content/child/.myoxus/git-sync-manifest.json", child_manifest),
      ("content/child/note.md", b"child content must remain unchanged"),
      ("content/child/private.md", b"\xff\xfe\0"),
    ]);
    let profile = create_test_profile(
      &pool,
      &store,
      &config,
      workspace_id,
      admin_id,
      &format!("https://example.test/myoxus/detached-{workspace_id}.git"),
      None,
    )
    .await;
    let retained_doc_id = seed_myoxus_doc(&pool, workspace_id, admin_id, "Retained", "# Retained\n").await;
    store
      .add_scope_exclusion(profile.id, "content/child", true, None, Uuid::new_v4(), 0)
      .await
      .expect("detach child subtree");
    let config = RunnerConfig {
      overview_service: overview_state.workspace_overview_service(),
      repo_base_dir: temp.path().join("repos"),
      crypto_key: config.crypto.private_key.clone(),
      min_free_disk_mb: 0,
      max_mirror_storage_mb: 0,
      ..RunnerConfig::default()
    };
    let run_id = create_run(&store, &profile).await;
    let outcome = run_sync_with_git_repo(
      &pool,
      &config,
      &locking::new_locks(),
      &MemoryBlobStorage::default(),
      &repo,
      profile.id,
      run_id,
    )
    .await
    .expect("source continues syncing outside detached child");
    assert_eq!(outcome["status"], "Completed");
    assert_eq!(
      outcome["docsCreated"], 1,
      "the source must still publish its own document"
    );
    let retained_path: String =
      sqlx::query_scalar("SELECT repo_path FROM git_sync_bindings WHERE profile_id = $1 AND doc_id = $2")
        .bind(profile.id)
        .bind(retained_doc_id)
        .fetch_one(&pool)
        .await
        .expect("source retained its own binding");
    assert!(
      repo.remote_text(&retained_path).is_some(),
      "source document must reach Git"
    );
    let follow_up = create_run(&store, &profile).await;
    let follow_up_result = run_sync_with_git_repo(
      &pool,
      &config,
      &locking::new_locks(),
      &MemoryBlobStorage::default(),
      &repo,
      profile.id,
      follow_up,
    )
    .await
    .expect("subsequent source sync must still succeed");
    assert_eq!(follow_up_result["status"], "Completed");
    assert_eq!(
      repo.remote_text("content/child/README.md").as_deref(),
      Some(std::str::from_utf8(child_overview).expect("marker"))
    );
    assert_eq!(
      repo
        .remote_text("content/child/.myoxus/git-sync-manifest.json")
        .as_deref(),
      Some(std::str::from_utf8(child_manifest).expect("manifest bytes"))
    );
    assert_eq!(
      repo.remote_text("content/child/note.md").as_deref(),
      Some("child content must remain unchanged")
    );
    assert_eq!(
      repo
        .files
        .lock()
        .unwrap()
        .get("content/child/private.md")
        .map(Vec::as_slice),
      Some(b"\xff\xfe\0".as_slice()),
      "the source must not read, decode or rewrite the delegated Markdown"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
  cleanup_git_sync_policy(&pool).await;
  outcome.unwrap();
}

#[tokio::test]
async fn runner_cannot_admit_a_run_while_cli_owns_the_same_repository_branch() {
  let _policy_lock = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let temp = TempDir::new().expect("mirror root");
  let repo = HarnessGitRepo::with_files(&[]);
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let remote_url = format!("https://example.test/myoxus/branch-coordination-{workspace_id}.git");
  let profile = create_test_profile(&pool, &store, &config, workspace_id, admin_id, &remote_url, None).await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: temp.path().join("repos"),
    crypto_key: config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    ..RunnerConfig::default()
  };
  let run_id = create_run(&store, &profile).await;
  let scope = GitSyncRepositoryScope::new(&profile.repo_url, &profile.branch).expect("profile scope");
  let coordinator = PgGitSyncRepositoryCoordination::new(pool.clone());
  let mut cli_owner = coordinator.acquire(&scope).await.expect("CLI takes branch first");
  let result = run_sync_with_git_repo(&pool, &runner_config, &locks, &blob_storage, &repo, profile.id, run_id).await;
  assert!(matches!(
    result,
    Err(myoxus_api::git_sync_engine::error::SyncError::Retryable {
      phase: "repository_guard",
      ..
    })
  ));
  let pending = store.get_run(run_id).await.expect("run remains unclaimed");
  assert_eq!(pending.status, RunStatus::Pending);
  let owner_pid: i32 = sqlx::query_scalar(
    "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1
       AND classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)
       AND objid::bigint = (hashtextextended($1, 0) & 4294967295)",
  )
  .bind(scope.advisory_key())
  .fetch_one(&pool)
  .await
  .expect("identify the dedicated branch session");
  assert!(
    sqlx::query_scalar::<_, bool>("SELECT pg_terminate_backend($1)")
      .bind(owner_pid)
      .fetch_one(&pool)
      .await
      .expect("terminate the test's branch session")
  );
  assert!(matches!(
    cli_owner.ensure_owned().await,
    Err(GitSyncCoordinationError::Lost)
  ));
  drop(cli_owner);
  coordinator
    .acquire(&scope)
    .await
    .expect("loss closed and released the session")
    .release()
    .await
    .expect("release replacement");
  helpers::cleanup_users(&pool, &[admin_id]).await;
  cleanup_git_sync_policy(&pool).await;
}
const MARKDOWN_BREADTH_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../../../build/fixtures/seed-documents/complex/03-operations-runbook-fixture.md"
));
const FOOTNOTE_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../../../build/fixtures/markdown/obsidian-vault/Structured footnotes.md"
));
const FOOTNOTE_IMAGE: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../../../build/fixtures/markdown/obsidian-vault/media/pixel.svg"
));

fn assert_parent_local_targets(payload: &[u8]) {
  use yrs::{Array, Map, Text, Transact, updates::decoder::Decode};
  let doc = yrs::Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  doc
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(payload).unwrap())
    .unwrap();
  let txn = doc.transact();
  let definitions = blocks
    .iter(&txn)
    .filter_map(|(id, value)| {
      let yrs::Out::YMap(block) = value else { return None };
      if block
        .get(&txn, "sys:flavour")
        .map(|value| value.to_string(&txn))
        .as_deref()
        != Some("myoxus:footnote-definition")
      {
        return None;
      }
      let Some(yrs::Out::YArray(children)) = block.get(&txn, "sys:children") else {
        panic!("definition needs ordinary children")
      };
      assert!(children.len(&txn) > 0);
      Some(id.to_string())
    })
    .collect::<Vec<_>>();
  assert_eq!(definitions.len(), 2);
  let mut markers = Vec::new();
  for (_, value) in blocks.iter(&txn) {
    let yrs::Out::YMap(block) = value else { continue };
    let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
      continue;
    };
    for segment in text.diff(&txn, yrs::types::text::YChange::identity) {
      let Some(yrs::Any::Map(footnote)) = segment.attributes.as_deref().and_then(|attrs| attrs.get("footnote")) else {
        continue;
      };
      if let Some(yrs::Any::String(id)) = footnote.get("definitionId") {
        assert!(!footnote.contains_key("reference"));
        assert!(definitions.contains(&id.to_string()));
        markers.push(id.to_string());
      }
    }
  }
  assert_eq!(markers.len(), 3);
  assert_eq!(markers[0], markers[1], "repeated labels share the actual local block");
  assert_ne!(markers[1], markers[2]);
}

struct HarnessGitRepo {
  /// Authenticated remote state. Working-tree writes must never update this
  /// map before `push` succeeds.
  files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
  repo_path: Arc<Mutex<Option<PathBuf>>>,
  origin_url: Arc<Mutex<Option<String>>>,
  branch: Arc<Mutex<Option<String>>>,
  commit_counter: Arc<Mutex<u64>>,
  external_revision_counter: Arc<Mutex<u64>>,
  local_oid: Arc<Mutex<String>>,
  remote_oid: Arc<Mutex<String>>,
  clone_count: Arc<Mutex<u64>>,
  clone_failures_remaining: Arc<Mutex<u32>>,
  fetch_count: Arc<Mutex<u64>>,
  fetch_failures: Arc<Mutex<VecDeque<GitError>>>,
  source_probe_count: Arc<Mutex<u64>>,
  source_probe_failures: Arc<Mutex<VecDeque<GitError>>>,
  push_failures_remaining: Arc<Mutex<u32>>,
  push_moves_then_errors_remaining: Arc<Mutex<u32>>,
}

impl Default for HarnessGitRepo {
  fn default() -> Self {
    Self::with_files(&[])
  }
}

impl HarnessGitRepo {
  fn with_file(path: &str, bytes: &[u8]) -> Self {
    Self {
      files: Arc::new(Mutex::new(HashMap::from([(path.to_string(), bytes.to_vec())]))),
      repo_path: Arc::new(Mutex::new(None)),
      origin_url: Arc::new(Mutex::new(None)),
      branch: Arc::new(Mutex::new(None)),
      commit_counter: Arc::new(Mutex::new(0)),
      external_revision_counter: Arc::new(Mutex::new(0)),
      local_oid: Arc::new(Mutex::new("0".repeat(40))),
      remote_oid: Arc::new(Mutex::new("0".repeat(40))),
      clone_count: Arc::new(Mutex::new(0)),
      clone_failures_remaining: Arc::new(Mutex::new(0)),
      fetch_count: Arc::new(Mutex::new(0)),
      fetch_failures: Arc::new(Mutex::new(VecDeque::new())),
      source_probe_count: Arc::new(Mutex::new(0)),
      source_probe_failures: Arc::new(Mutex::new(VecDeque::new())),
      push_failures_remaining: Arc::new(Mutex::new(0)),
      push_moves_then_errors_remaining: Arc::new(Mutex::new(0)),
    }
  }

  fn with_files(files: &[(&str, &[u8])]) -> Self {
    Self {
      files: Arc::new(Mutex::new(
        files
          .iter()
          .map(|(path, bytes)| ((*path).to_string(), (*bytes).to_vec()))
          .collect(),
      )),
      repo_path: Arc::new(Mutex::new(None)),
      origin_url: Arc::new(Mutex::new(None)),
      branch: Arc::new(Mutex::new(None)),
      commit_counter: Arc::new(Mutex::new(0)),
      external_revision_counter: Arc::new(Mutex::new(0)),
      local_oid: Arc::new(Mutex::new("0".repeat(40))),
      remote_oid: Arc::new(Mutex::new("0".repeat(40))),
      clone_count: Arc::new(Mutex::new(0)),
      clone_failures_remaining: Arc::new(Mutex::new(0)),
      fetch_count: Arc::new(Mutex::new(0)),
      fetch_failures: Arc::new(Mutex::new(VecDeque::new())),
      source_probe_count: Arc::new(Mutex::new(0)),
      source_probe_failures: Arc::new(Mutex::new(VecDeque::new())),
      push_failures_remaining: Arc::new(Mutex::new(0)),
      push_moves_then_errors_remaining: Arc::new(Mutex::new(0)),
    }
  }

  fn clone_count(&self) -> u64 {
    *self.clone_count.lock().expect("clone count lock")
  }

  fn commit_count(&self) -> u64 {
    *self.commit_counter.lock().expect("commit counter lock")
  }

  fn fetch_count(&self) -> u64 {
    *self.fetch_count.lock().expect("fetch count lock")
  }

  fn source_probe_count(&self) -> u64 {
    *self.source_probe_count.lock().expect("source probe count lock")
  }

  fn fail_next_clones(self, count: u32) -> Self {
    *self.clone_failures_remaining.lock().expect("clone failure lock") = count;
    self
  }

  fn fail_next_fetch(&self, error: GitError) {
    self.fetch_failures.lock().expect("fetch failure lock").push_back(error);
  }

  fn fail_next_source_probe(&self, error: GitError) {
    self
      .source_probe_failures
      .lock()
      .expect("source probe failure lock")
      .push_back(error);
  }

  fn fail_next_pushes(self, count: u32) -> Self {
    *self.push_failures_remaining.lock().expect("push failure lock") = count;
    self
  }

  fn move_remote_then_fail_next_pushes(self, count: u32) -> Self {
    *self
      .push_moves_then_errors_remaining
      .lock()
      .expect("push move-then-error lock") = count;
    self
  }

  fn advance_external_remote(&self) {
    let mut revision = self.external_revision_counter.lock().expect("external revision lock");
    *revision += 1;
    *self.remote_oid.lock().expect("remote oid lock") = format!("e{:039x}", *revision);
  }

  fn remove_remote_file(&self, path: &str) {
    self.files.lock().expect("files lock").remove(path);
    self.advance_external_remote();
  }

  fn remote_text(&self, path: &str) -> Option<String> {
    self
      .files
      .lock()
      .expect("files lock")
      .get(path)
      .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
  }

  fn remote_bytes(&self, path: &str) -> Option<Vec<u8>> {
    self.files.lock().expect("files lock").get(path).cloned()
  }

  fn remote_oid(&self) -> String {
    self.remote_oid.lock().expect("remote oid lock").clone()
  }

  fn adopt_materialized_head_as_remote(&self, path: &Path) -> String {
    let oid = git2::Repository::open(path)
      .expect("open materialized harness repository")
      .head()
      .expect("materialized harness HEAD")
      .target()
      .expect("direct materialized harness HEAD")
      .to_string();
    *self.local_oid.lock().expect("local oid lock") = oid.clone();
    *self.remote_oid.lock().expect("remote oid lock") = oid.clone();
    oid
  }

  fn set_remote_file(&self, path: &str, bytes: &[u8]) {
    self
      .files
      .lock()
      .expect("files lock")
      .insert(path.to_string(), bytes.to_vec());
    self.advance_external_remote();
  }

  fn materialize(&self, path: &Path) -> Result<(), GitError> {
    std::fs::create_dir_all(path)?;
    let repo = if path.join(".git").is_dir() {
      git2::Repository::open(path).map_err(|error| GitError::Repository(format!("open harness repo: {error}")))?
    } else {
      git2::Repository::init(path).map_err(|error| GitError::Repository(format!("init harness repo: {error}")))?
    };
    for entry in std::fs::read_dir(path)? {
      let entry = entry?;
      if entry.file_name() == ".git" {
        continue;
      }
      let file_type = entry.file_type()?;
      if file_type.is_dir() {
        std::fs::remove_dir_all(entry.path())?;
      } else {
        std::fs::remove_file(entry.path())?;
      }
    }
    for (repo_path, bytes) in self.files.lock().expect("files lock").iter() {
      let full = path.join(repo_path);
      if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
      }
      std::fs::write(full, bytes)?;
    }
    let mut index = repo
      .index()
      .map_err(|error| GitError::Repository(format!("open harness index: {error}")))?;
    index
      .clear()
      .map_err(|error| GitError::Repository(format!("clear harness index: {error}")))?;
    index
      .add_all(["."], git2::IndexAddOption::DEFAULT, None)
      .map_err(|error| GitError::Repository(format!("stage harness worktree: {error}")))?;
    index
      .write()
      .map_err(|error| GitError::Repository(format!("write harness index: {error}")))?;
    let tree_oid = index
      .write_tree()
      .map_err(|error| GitError::Repository(format!("write harness tree: {error}")))?;
    let tree = repo
      .find_tree(tree_oid)
      .map_err(|error| GitError::Repository(format!("find harness tree: {error}")))?;
    let signature = git2::Signature::now("Myoxus Harness", "harness@myoxus.invalid")
      .map_err(|error| GitError::Internal(format!("create harness signature: {error}")))?;
    let parent = match repo.head() {
      Ok(head) => Some(
        head
          .peel_to_commit()
          .map_err(|error| GitError::Repository(format!("resolve harness parent commit: {error}")))?,
      ),
      Err(error) if matches!(error.code(), git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound) => None,
      Err(error) => return Err(GitError::Repository(format!("read harness HEAD: {error}"))),
    };
    let parents = parent.iter().collect::<Vec<_>>();
    repo
      .commit(
        Some("HEAD"),
        &signature,
        &signature,
        "materialize remote fixture",
        &tree,
        &parents,
      )
      .map_err(|error| GitError::Repository(format!("commit harness tree: {error}")))?;
    *self.local_oid.lock().expect("local oid lock") = self.remote_oid.lock().expect("remote oid lock").clone();
    Ok(())
  }

  fn working_files(&self) -> Result<HashMap<String, Vec<u8>>, GitError> {
    fn collect(root: &Path, current: &Path, files: &mut HashMap<String, Vec<u8>>) -> Result<(), GitError> {
      for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
          continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
          collect(root, &path, files)?;
        } else {
          let relative = path
            .strip_prefix(root)
            .map_err(|error| GitError::Internal(format!("strip working-tree prefix: {error}")))?
            .to_string_lossy()
            .replace('\\', "/");
          files.insert(relative, std::fs::read(path)?);
        }
      }
      Ok(())
    }

    let root = self
      .repo_path
      .lock()
      .expect("repo path lock")
      .clone()
      .ok_or_else(|| GitError::Repository("repo not opened".to_string()))?;
    let mut files = HashMap::new();
    collect(&root, &root, &mut files)?;
    Ok(files)
  }
}

#[derive(Debug, PartialEq, Eq)]
struct MirrorRecoverySnapshot {
  head: String,
  index: Vec<(Vec<u8>, String, u16)>,
  files: HashMap<String, Vec<u8>>,
  stashes: Vec<(usize, String, String)>,
}

fn mirror_recovery_snapshot(git_repo: &HarnessGitRepo, repo_path: &Path) -> MirrorRecoverySnapshot {
  let mut repo = git2::Repository::open(repo_path).expect("open recovery mirror");
  let head = repo
    .head()
    .expect("recovery mirror HEAD")
    .target()
    .expect("direct recovery mirror HEAD")
    .to_string();
  let index = repo
    .index()
    .expect("recovery mirror index")
    .iter()
    .map(|entry| (entry.path.clone(), entry.id.to_string(), entry.flags))
    .collect();
  let mut stashes = Vec::new();
  repo
    .stash_foreach(|index, message, oid| {
      stashes.push((index, message.to_string(), oid.to_string()));
      true
    })
    .expect("enumerate recovery stashes");
  MirrorRecoverySnapshot {
    head,
    index,
    files: git_repo.working_files().expect("snapshot recovery working tree"),
    stashes,
  }
}

fn add_recovery_state(git_repo: &HarnessGitRepo, repo_path: &Path, tracked_path: &str) {
  git_repo.materialize(repo_path).expect("clean real harness repository");
  let mut repo = git2::Repository::open(repo_path).expect("open real harness repository");
  let signature = git2::Signature::now("Myoxus Recovery", "recovery@myoxus.invalid").expect("stash signature");

  std::fs::write(repo_path.join(tracked_path), b"pre-existing tracked stash state")
    .expect("write pre-existing tracked stash state");
  std::fs::write(repo_path.join("pre-existing-untracked.txt"), "pre-existing stash")
    .expect("write pre-existing untracked stash state");
  repo
    .stash_save(
      &signature,
      "pre-existing recovery stash",
      Some(git2::StashFlags::INCLUDE_UNTRACKED),
    )
    .expect("create pre-existing recovery stash");

  std::fs::write(repo_path.join(tracked_path), b"indexed tracked recovery state")
    .expect("write indexed recovery state");
  let mut index = repo.index().expect("open recovery index");
  index.add_path(Path::new(tracked_path)).expect("stage recovery state");
  index.write().expect("write recovery index");
  std::fs::write(repo_path.join("recovery-untracked.txt"), "untracked recovery state")
    .expect("write untracked recovery state");
}

#[tokio::test]
async fn runner_processes_git_markdown_partial_session_across_runs() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  use futures_util::FutureExt;
  let outcome = std::panic::AssertUnwindSafe(async {
    let app_config = AppConfig::load().expect("load app config");
    let store = SqlxGitSyncStore::new(pool.clone());
    let repo_dir = TempDir::new().expect("repo tempdir");
    let git_repo = HarnessGitRepo::with_files(&[
      ("content/a.md", b"# Alpha\n\nFirst partial document."),
      ("content/b.md", b"# Beta\n\nSecond partial document."),
    ]);
    let blob_storage = MemoryBlobStorage::default();
    let locks = locking::new_locks();
    let profile = create_test_profile(
      &pool,
      &store,
      &app_config,
      workspace_id,
      admin_id,
      "https://example.test/myoxus/partial-docs.git",
      None,
    )
    .await;
    let runner_config = RunnerConfig {
      overview_service: overview_state.workspace_overview_service(),
      repo_base_dir: repo_dir.path().join("repos"),
      crypto_key: app_config.crypto.private_key.clone(),
      min_free_disk_mb: 0,
      max_mirror_storage_mb: 0,
      max_docs_per_sync: 1,
      mime_validation_mode: "strict".to_string(),
      ..RunnerConfig::default()
    };

    let first_run_id = create_run(&store, &profile).await;
    let first = run_sync_with_git_repo(
      &pool,
      &runner_config,
      &locks,
      &blob_storage,
      &git_repo,
      profile.id,
      first_run_id,
    )
    .await
    .expect("first partial run");
    assert_eq!(first["status"], "Completed");
    assert_eq!(first["partial"], true);
    assert_eq!(first["partialHasMore"], true);
    assert_eq!(first["partialSelectedItems"], 1);
    assert_eq!(first["docsCreated"], 1);
    assert_eq!(first["partialSession"]["status"], "Open");
    assert_eq!(first["partialSession"]["totalItems"], 2);
    assert_eq!(first["partialSession"]["processedItems"], 1);

    let item_statuses: Vec<String> =
      sqlx::query_scalar("SELECT status FROM git_sync_partial_items WHERE profile_id = $1 ORDER BY sort_key")
        .bind(profile.id)
        .fetch_all(&pool)
        .await
        .expect("partial item statuses after first run");
    assert_eq!(
      item_statuses,
      vec!["Completed".to_string(), "Pending".to_string()],
      "first partial run must complete exactly one deterministic item"
    );

    let second_run_id = create_run(&store, &profile).await;
    let second = run_sync_with_git_repo(
      &pool,
      &runner_config,
      &locks,
      &blob_storage,
      &git_repo,
      profile.id,
      second_run_id,
    )
    .await
    .expect("second partial run");
    assert_eq!(second["status"], "Completed");
    assert_eq!(second["partial"], true);
    assert_eq!(second["partialHasMore"], false);
    assert_eq!(second["docsCreated"], 1);
    assert_eq!(second["partialSession"]["status"], "Completed");
    assert_eq!(second["partialSession"]["processedItems"], 2);
    assert_eq!(second["partialSession"]["failedItems"], 0);

    let open_sessions: i64 = sqlx::query_scalar(
      "SELECT COUNT(*)::bigint FROM git_sync_partial_sessions WHERE profile_id = $1 AND status = 'Open'",
    )
    .bind(profile.id)
    .fetch_one(&pool)
    .await
    .expect("open partial session count");
    assert_eq!(open_sessions, 0, "second run must close the partial session");

    let bindings: i64 =
      sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE profile_id = $1 AND tombstone = false")
        .bind(profile.id)
        .fetch_one(&pool)
        .await
        .expect("doc binding count");
    assert_eq!(bindings, 2, "both markdown files must be bound after two partial runs");

    let before: Vec<(Uuid, String)> = sqlx::query_as(
      "SELECT doc_id,repo_path FROM git_sync_bindings WHERE profile_id=$1 AND NOT tombstone ORDER BY doc_id",
    )
    .bind(profile.id)
    .fetch_all(&pool)
    .await
    .unwrap();
    for (index, (id, _)) in before.iter().enumerate() {
      update_myoxus_doc(
        &pool,
        workspace_id,
        *id,
        &format!("Renamed {index}"),
        "Current native body.",
      )
      .await;
    }
    seed_myoxus_doc(
      &pool,
      workspace_id,
      admin_id,
      "Pending new file",
      "Only link after materialization.",
    )
    .await;
    let mut verified_retained = false;
    for _ in 0..3 {
      let id = create_run(&store, &profile).await;
      let batch = run_sync_with_git_repo(&pool, &runner_config, &locks, &blob_storage, &git_repo, profile.id, id)
        .await
        .expect("outbound partial path change");
      let manifest: export::GitSyncManifest =
        serde_json::from_slice(&git_repo.remote_bytes(export::GIT_SYNC_MANIFEST_PATH).unwrap()).unwrap();
      assert!(
        manifest
          .documents
          .iter()
          .all(|doc| git_repo.remote_bytes(&doc.repo_path).is_some()),
        "partial manifest cannot advertise future files"
      );
      if !verified_retained {
        assert!(
          before.iter().any(|(id, path)| manifest
            .documents
            .iter()
            .any(|doc| doc.doc_id == *id && doc.repo_path == *path)),
          "pending moves keep verified existing paths"
        );
        verified_retained = true;
      }
      let root = git_repo.remote_text(&manifest.overview.unwrap().repo_path).unwrap();
      for document in manifest.documents {
        assert!(
          root.contains(&format!("({})", document.repo_path.strip_prefix("content/").unwrap())),
          "register must consume the same final map"
        );
      }
      if batch["partialHasMore"] == false {
        break;
      }
    }
  })
  .catch_unwind()
  .await;
  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
  outcome.expect("partial projection after fixture cleanup");
}

#[tokio::test]
async fn runner_pushes_updates_and_deletes_myoxus_docs_to_git() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  use futures_util::FutureExt;
  let outcome = std::panic::AssertUnwindSafe(async {
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default();
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/doc-push.git",
    None,
  )
  .await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };

  let doc_id = seed_myoxus_doc(&pool, workspace_id, admin_id, "Myoxus Alpha", MARKDOWN_BREADTH_FIXTURE).await;
  let external_id = "RunnerNanoPlacement8kR";
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(doc_id)
    .bind(external_id)
    .execute(&pool)
    .await
    .expect("assign NanoID-shaped external document key");
  let organizer = OrganizerService::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
  let folder_ids = ["operations", "platform", "services", "sync", "procedures"];
  let folder_names = ["Operations", "Platform", "Services", "Sync", "Procedures"];
  for index in 0..folder_ids.len() {
    organizer
      .create_folder(
        workspace_id,
        CreateOrganizerFolder {
          id: folder_ids[index].to_string(),
          parent_id: index.checked_sub(1).map(|parent| folder_ids[parent].to_string()),
          name: folder_names[index].to_string(),
          index: Some("a0".to_string()),
        },
      )
      .await
      .expect("create organizer hierarchy");
  }
  organizer
    .create_folder(
      workspace_id,
      CreateOrganizerFolder {
        id: "empty-reference".to_string(),
        parent_id: Some("operations".to_string()),
        name: "Empty reference".to_string(),
        index: Some("a1".to_string()),
      },
    )
    .await
    .expect("create empty organizer folder");
  organizer
    .create_link(
      workspace_id,
      CreateOrganizerLink {
        id: "myoxus-alpha-link".to_string(),
        parent_id: "procedures".to_string(),
        link_type: OrganizerLinkType::Doc,
        target_id: external_id.to_string(),
        target_workspace_id: None,
        index: Some("a0".to_string()),
      },
    )
    .await
    .expect("link document into organizer hierarchy");

  let first_run_id = create_run(&store, &profile).await;
  let first = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    first_run_id,
  )
  .await
  .expect("create-in-git run");
  assert_eq!(first["status"], "Completed");
  assert_eq!(first["docsCreated"], 1, "first run must export the new Myoxus doc");
  let (binding_id, bound_doc_id, sync_id, repo_path) = active_doc_binding(&pool, profile.id).await;
  assert_eq!(bound_doc_id, doc_id);
  assert_eq!(
    repo_path,
    "content/operations/platform/services/sync/procedures/myoxus-alpha.md"
  );
  let exported = git_repo.remote_text(&repo_path).expect("exported markdown");
  for expected in [
    "# Operations Runbook Fixture",
    "## Scope",
    "### Incident Overview",
    "#### Severity Definitions",
    "##### Severity Notes",
    "###### Severity Leaf",
    "**confirmed regression**",
    "*suspected regression*",
    "`servedBundleHash`",
    "[API](https://example.test/api)",
    "literal \\*marker\\* and A \\| B",
    "A soft line break normalizes to a space, while this hard break\\\nalso normalizes without losing either side.",
    "> Keep the incident channel factual; quote verified observations and preserve literal Markdown punctuation in exported evidence.",
    "1. Create a narrow patch.",
    "   1. Keep unrelated changes out.",
    "- [ ] Confirm the impacted workspace.",
    "- [x] Record the verified outcome.",
    "  - [ ] Link the nested follow-up evidence.",
    "| Severity | Description | Response Target | Evidence |",
    "| :--- | :---: | ---: | --- |",
    "| SEV-4 |  | Planned | Minor copy mismatch |",
    "| Unaligned | Empty | Rich |",
    "| Plain |  | **bold** and `code` |",
    "```bash\nbuild/scripts/server/stack-status.sh",
    "```mermaid\ngraph TD\n    Observe --> Diagnose\n    Diagnose --> Verify\n```",
    "data:image/svg+xml",
    "data:image/png;base64",
    "![Repository diagram](assets/runbook-diagram.svg)",
  ] {
    assert!(
      exported.contains(expected),
      "missing `{expected}` in Git export:\n{exported}"
    );
  }
  assert!(
    !exported.contains("- [ ] Remove accidental local CSS"),
    "bullets must not become unchecked tasks:\n{exported}"
  );
  assert!(
    !exported.contains("- [ ] Create a narrow patch"),
    "numbered items must not become unchecked tasks:\n{exported}"
  );
  assert!(
    exported.contains(&format!("sync_id: {sync_id}")),
    "exported markdown must carry the durable sync id"
  );
  let manifest: serde_json::Value = serde_json::from_str(
    &git_repo
      .remote_text(export::GIT_SYNC_MANIFEST_PATH)
      .expect("Git Sync manifest"),
  )
  .expect("valid Git Sync manifest");
  let manifest_document = manifest["documents"]
    .as_array()
    .expect("manifest documents")
    .iter()
    .find(|document| document["docId"] == doc_id.to_string())
    .expect("NanoID-linked document manifest entry");
  assert_eq!(manifest_document["organizerEntryId"], "myoxus-alpha-link");
  assert_eq!(
    manifest_document["organizerFolderIds"],
    json!(["operations", "platform", "services", "sync", "procedures"])
  );
  assert_eq!(manifest_document["repoPath"], repo_path);
  assert!(
    manifest["folders"]
      .as_array()
      .expect("manifest folders")
      .iter()
      .any(|folder| folder["path"] == json!(["Operations", "Empty reference"])),
    "empty organizer folders must remain represented in the manifest"
  );

  let root_path = manifest["overview"]["repoPath"].as_str().expect("workspace output");
  let root = git_repo.remote_text(root_path).expect("workspace README");
  assert!(root.contains("operations/platform/services/sync/procedures/myoxus-alpha.md"));
  assert!(manifest["folders"].as_array().unwrap().iter().all(|folder|folder["overview"]["repoPath"].as_str().is_some()));
  // The consuming runner must reject derived ownership before document/file
  // execution, not merely expose a validator which no caller uses.
  let original_manifest = git_repo.remote_bytes(export::GIT_SYNC_MANIFEST_PATH).unwrap();
  let mut colliding_manifest = manifest.clone();
  colliding_manifest["overview"] = json!({ "repoPath": repo_path, "contentHash": content_hash("derived") });
  git_repo.files.lock().unwrap().insert(export::GIT_SYNC_MANIFEST_PATH.into(), serde_json::to_vec(&colliding_manifest).unwrap());
  git_repo.advance_external_remote();
  let commits_before = git_repo.commit_count();
  let invalid_run_id = create_run(&store, &profile).await;
  let invalid = run_sync_with_git_repo(&pool, &runner_config, &locks, &blob_storage, &git_repo, profile.id, invalid_run_id)
    .await.expect_err("colliding derived ownership must fail before Git writes");
  assert!(matches!(invalid, myoxus_api::git_sync_engine::error::SyncError::Permanent { phase: "overview_preflight", .. }));
  assert_eq!(git_repo.commit_count(), commits_before);
  git_repo.files.lock().unwrap().insert(export::GIT_SYNC_MANIFEST_PATH.into(), original_manifest);
  git_repo.advance_external_remote();

  let marker = myoxus_application::workspace_overview::markdown::GIT_OVERVIEW_MARKER;
  let derived_path = manifest["overview"]["repoPath"].as_str().expect("native workspace overview path");
  let owned_manifest = manifest.clone();
  git_repo.files.lock().unwrap().insert(export::GIT_SYNC_MANIFEST_PATH.into(), serde_json::to_vec(&owned_manifest).unwrap());
  let mut pull_profile = profile.clone();
  pull_profile.sync_direction = SyncDirection::GitToMyoxus;
  store.update_profile(&pull_profile).await.expect("select actual inbound-only profile policy");
  for bytes in [Some(b"manually edited derived page".to_vec()),None] {
    if let Some(bytes) = bytes { git_repo.files.lock().unwrap().insert(derived_path.into(),bytes); }
    else { git_repo.files.lock().unwrap().remove(derived_path); }
    git_repo.advance_external_remote();
    let before = git_repo.commit_count();
    let pull_id = create_run(&store,&pull_profile).await;
    let pulled = run_sync_with_git_repo(&pool,&runner_config,&locks,&blob_storage,&git_repo,profile.id,pull_id).await.expect("known derived edit/deletion must not import");
    assert_eq!(pulled["docsCreated"],0);
    assert_eq!(pulled["docsUpdated"],0);
    assert_eq!(pulled["docsDeleted"],0);
    assert_eq!(git_repo.commit_count(),before,"inbound-only cannot regenerate derived bytes");
    assert_eq!(git_repo.remote_bytes(export::GIT_SYNC_MANIFEST_PATH).unwrap(),serde_json::to_vec(&owned_manifest).unwrap());
    let count:i64 = sqlx::query_scalar("SELECT count(*) FROM git_sync_bindings WHERE profile_id=$1 AND NOT tombstone").bind(profile.id).fetch_one(&pool).await.unwrap();
    assert_eq!(count,1,"no derived document binding");
  }
  store.update_profile(&profile).await.expect("restore bidirectional profile policy");
  git_repo.files.lock().unwrap().insert(export::GIT_SYNC_MANIFEST_PATH.into(),serde_json::to_vec(&manifest).unwrap());
  for unknown_path in ["content/copied-overview.md","content/copied-overview.txt"] {
    git_repo.files.lock().unwrap().insert(unknown_path.into(),marker.as_bytes().to_vec());
    git_repo.advance_external_remote();
    let before = git_repo.commit_count();
    let id = create_run(&store,&profile).await;
    let error = run_sync_with_git_repo(&pool,&runner_config,&locks,&blob_storage,&git_repo,profile.id,id).await.expect_err("unknown marked output must fail before identities or writes");
    assert!(matches!(error,myoxus_api::git_sync_engine::error::SyncError::Permanent{phase:"overview_preflight",..}));
    assert_eq!(git_repo.commit_count(),before);
    git_repo.files.lock().unwrap().remove(unknown_path);
  }
  git_repo.advance_external_remote();

  let native_lists = base64::engine::general_purpose::STANDARD
    .decode(
      include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../build/fixtures/seed-documents/complex/native-yjs-list-fidelity.b64"
      ))
      .trim(),
    )
    .expect("decode native Yjs list fixture");
  sqlx::query(
    "UPDATE doc_snapshots
     SET payload = $3, last_sequence = last_sequence + 1, updated_at = now()
     WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(native_lists)
  .execute(&pool)
  .await
  .expect("install native list fixture");
  let native_run_id = create_run(&store, &profile).await;
  let native = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    native_run_id,
  )
  .await
  .expect("native-list Git run");
  assert_eq!(native["docsUpdated"], 1);
  let (_, _, _, native_repo_path) = active_doc_binding(&pool, profile.id).await;
  let native_file = git_repo
    .remote_text(&native_repo_path)
    .expect("native list Git projection");
  let (_, native_body) = export::split_markdown_file(&native_file);
  assert_eq!(
    native_body.trim(),
    concat!(
      "- Bullet absent\n",
      "  - Bullet false\n",
      "- Bullet true\n",
      "1. Numbered absent\n",
      "   1. Numbered false\n",
      "1. Numbered true\n",
      "- [ ] Open\n",
      "  - [x] Nested done\n",
      "- [x] Done",
    ),
    "Git must use list type, not the presence or value of checked"
  );

  let mut native_mermaid = yjs::YjsDocumentBuilder::new("Myoxus Alpha");
  native_mermaid.push_mermaid("graph TD\n  Observe --> Verify\n``` embedded", "", "");
  sqlx::query(
    "UPDATE doc_snapshots
     SET payload = $3, last_sequence = last_sequence + 1, updated_at = now()
     WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(native_mermaid.encode())
  .execute(&pool)
  .await
  .expect("install native Mermaid fixture");
  let mermaid_run_id = create_run(&store, &profile).await;
  let mermaid = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    mermaid_run_id,
  )
  .await
  .expect("native-Mermaid Git run");
  assert_eq!(mermaid["docsUpdated"], 1);
  let (_, _, _, mermaid_repo_path) = active_doc_binding(&pool, profile.id).await;
  let mermaid_file = git_repo
    .remote_text(&mermaid_repo_path)
    .expect("native Mermaid Git projection");
  let (_, mermaid_body) = export::split_markdown_file(&mermaid_file);
  assert!(
    mermaid_body.contains("````mermaid\ngraph TD\n  Observe --> Verify\n``` embedded\n````"),
    "Git must export native Mermaid source through a safe fence: {mermaid_body}"
  );

  update_myoxus_doc(
    &pool,
    workspace_id,
    doc_id,
    "Myoxus Alpha",
    "# Myoxus Alpha\n\nUpdated Myoxus body.",
  )
  .await;
  organizer
    .update_folder(
      workspace_id,
      "sync",
      UpdateOrganizerFolder {
        name: Some("Git synchronization".to_string()),
        ..UpdateOrganizerFolder::default()
      },
    )
    .await
    .expect("rename organizer folder");
  let second_run_id = create_run(&store, &profile).await;
  let second = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    second_run_id,
  )
  .await
  .expect("push-to-git run");
  assert_eq!(second["status"], "Completed");
  assert_eq!(
    second["docsUpdated"], 1,
    "second run must push the changed Myoxus state at its renamed organizer path"
  );
  let renamed_repo_path = "content/operations/platform/services/git-synchronization/procedures/myoxus-alpha.md";
  assert!(
    git_repo.remote_text(&native_repo_path).is_none(),
    "organizer rename must remove the obsolete Git path"
  );
  let exported = git_repo
    .remote_text(renamed_repo_path)
    .expect("updated markdown at renamed path");
  assert!(
    exported.contains("Updated Myoxus body."),
    "updated export must overwrite the Git markdown body: {exported}"
  );

  let tags = overview_state.workspace_tag_service().expect("native tags");
  let tag = tags.create_tag(admin_id,workspace_id,"Git register | label","blue",None).await.expect("create native tag");
  tags.set_document_tags(admin_id,workspace_id,doc_id,&[tag.id]).await.expect("assign native tag");
  let before_metadata = git_repo.commit_count();
  let metadata_id = create_run(&store,&profile).await;
  let metadata = run_sync_with_git_repo(&pool,&runner_config,&locks,&blob_storage,&git_repo,profile.id,metadata_id).await.expect("metadata-only projection");
  assert_eq!(metadata["docsUpdated"],0);
  assert_eq!(git_repo.commit_count(),before_metadata+1);
  assert_eq!(git_repo.remote_text(renamed_repo_path).as_deref(),Some(exported.as_str()),"metadata-only projection preserves ordinary bytes");
  let current:serde_json::Value = serde_json::from_slice(&git_repo.remote_bytes(export::GIT_SYNC_MANIFEST_PATH).unwrap()).unwrap();
  assert!(git_repo.remote_text(current["overview"]["repoPath"].as_str().unwrap()).unwrap().contains(r"Git register \| label"));
  let commits_before_unchanged_run = git_repo.commit_count();
  let unchanged_run_id = create_run(&store, &profile).await;
  let unchanged = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    unchanged_run_id,
  )
  .await
  .expect("unchanged run");
  assert_eq!(unchanged["status"], "Completed");
  assert_eq!(unchanged["docsCreated"], 0);
  assert_eq!(unchanged["docsUpdated"], 0);
  assert_eq!(unchanged["docsDeleted"], 0);
  assert_eq!(
    git_repo.commit_count(),
    commits_before_unchanged_run,
    "an unchanged state must not create a Git commit"
  );

  soft_delete_doc(&pool, workspace_id, doc_id).await;
  let delete_run_id = create_run(&store, &profile).await;
  let deleted = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    delete_run_id,
  )
  .await
  .expect("delete-in-git run");
  assert_eq!(deleted["status"], "Completed");
  assert_eq!(
    deleted["docsDeleted"], 1,
    "delete run must remove the Git file for the soft-deleted doc"
  );
  assert!(
    git_repo.remote_text(renamed_repo_path).is_none(),
    "soft-deleted Myoxus doc must remove the bound Git markdown file"
  );
  let tombstoned: bool = sqlx::query_scalar("SELECT tombstone FROM git_sync_bindings WHERE id = $1")
    .bind(binding_id)
    .fetch_one(&pool)
    .await
    .expect("binding tombstone");
  assert!(tombstoned, "DeleteInGit must tombstone the document binding");
  // Exercise an exact old derived destination, including a safely retained
  // lower-case README path, becoming a new ordinary document's destination.
  let mut old:serde_json::Value = serde_json::from_slice(&git_repo.remote_bytes(export::GIT_SYNC_MANIFEST_PATH).unwrap()).unwrap();
  let old_path = old["overview"]["repoPath"].as_str().unwrap().to_string();
  let bytes = git_repo.files.lock().unwrap().remove(&old_path).unwrap();
  git_repo.files.lock().unwrap().insert("content/readme.md".into(),bytes);
  old["overview"]["repoPath"] = json!("content/readme.md");
  git_repo.files.lock().unwrap().insert(export::GIT_SYNC_MANIFEST_PATH.into(),serde_json::to_vec(&old).unwrap());
  git_repo.advance_external_remote();
  let readme_id = seed_myoxus_doc(&pool,workspace_id,admin_id,"README","Ordinary README wins its native path.").await;
  let handover_id = create_run(&store,&profile).await;
  let handover = run_sync_with_git_repo(&pool,&runner_config,&locks,&blob_storage,&git_repo,profile.id,handover_id).await.expect("derived path handover");
  assert_eq!(handover["docsCreated"],1);
  let final_manifest:export::GitSyncManifest = serde_json::from_slice(&git_repo.remote_bytes(export::GIT_SYNC_MANIFEST_PATH).unwrap()).unwrap();
  let ordinary = final_manifest.documents.iter().find(|doc|doc.doc_id==readme_id).unwrap();
  assert_eq!(ordinary.repo_path,"content/readme.md");
  assert!(git_repo.remote_text(&ordinary.repo_path).unwrap().contains("Ordinary README wins"));
  let root = final_manifest.overview.unwrap();
  assert_ne!(root.repo_path.to_lowercase(),ordinary.repo_path);
  let rendered = git_repo.remote_text(&root.repo_path).unwrap();
  assert!(rendered.contains("[README](readme.md)"));
  assert_eq!(root.content_hash,content_hash(&rendered));

  }).catch_unwind().await;
  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
  outcome.expect("runner projection contract after fixture cleanup");
}

#[tokio::test]
async fn runner_reprojects_referrers_after_a_linked_document_moves() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default();
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/document-links.git",
    None,
  )
  .await;
  let mut runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_validation_mode: "strict".to_string(),
    parallel_conversion_threshold: 1,
    ..RunnerConfig::default()
  };

  let source_id = seed_myoxus_doc(&pool, workspace_id, admin_id, "Source", "placeholder").await;
  let target_id = seed_myoxus_doc(&pool, workspace_id, admin_id, "Target", "target body").await;
  let unrelated_id = seed_myoxus_doc(&pool, workspace_id, admin_id, "Unrelated", "unrelated body").await;
  let source_external_id = "RunnerReferenceSource1";
  let target_external_id = "RunnerReferenceTarget1";
  for (doc_id, external_id) in [
    (source_id, source_external_id),
    (target_id, target_external_id),
    (unrelated_id, "RunnerReferenceUnrelated1"),
  ] {
    sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(external_id)
      .execute(&pool)
      .await
      .expect("assign external document key");
  }

  let mut source_builder = yjs::YjsDocumentBuilder::new("Source");
  let mut reference_segment = yjs::YjsTextSegment::plain(" ");
  reference_segment.reference = Some(yjs::MarkdownDocumentReference {
    page_id: target_external_id.to_string(),
    title: Some("Stable alias".to_string()),
    description: None,
    params: None,
  });
  source_builder.push_paragraph(&[reference_segment]);
  sqlx::query(
    "UPDATE doc_snapshots
     SET payload = $3, last_sequence = last_sequence + 1, updated_at = now()
     WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(source_id)
  .bind(source_builder.encode())
  .execute(&pool)
  .await
  .expect("install native document reference");

  let mut subset = loader::load_myoxus_docs(&pool, workspace_id)
    .await
    .expect("load authorized reference inventory");
  subset.docs.retain(|document| document.doc_id == source_id);
  subset.docs[0].planned_repo_path = Some("content/source.md".to_string());
  let projection_ids = std::collections::HashSet::from([source_id]);
  let (captured, selected) = loader::capture_myoxus_docs_in_path_plan(
    &pool,
    workspace_id,
    "https://myoxus.test",
    &subset.docs,
    &subset.reference_documents,
    &subset.reference_external_ids,
    &projection_ids,
  )
  .await
  .expect("capture native projection");
  let (subset_failures, subset_failed_ids, _, _) = loader::project_myoxus_docs_in_path_plan(
    &mut subset.docs,
    &subset.reference_external_ids,
    captured,
    &selected,
    10,
    &std::collections::HashMap::new(),
  )
  .await
  .expect("project subset with omitted authorized target");
  assert_eq!((subset_failures, subset_failed_ids), (0, Vec::new()));
  let subset_source = subset.docs[0].markdown.as_deref().expect("subset source projection");
  assert!(
    subset_source.contains(&format!(
      "[Stable alias](https://myoxus.test/workspace/{workspace_id}/{target_external_id})"
    )),
    "an authorized target outside the Git payload subset needs its canonical link: {subset_source}"
  );
  assert_eq!(
    subset.docs.len(),
    1,
    "link resolution must not expand the Git payload subset"
  );

  let organizer = OrganizerService::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
  for (folder_id, name) in [("source-folder", "Source folder"), ("target-folder", "Target folder")] {
    organizer
      .create_folder(
        workspace_id,
        CreateOrganizerFolder {
          id: folder_id.to_string(),
          parent_id: None,
          name: name.to_string(),
          index: Some("a0".to_string()),
        },
      )
      .await
      .expect("create document folder");
  }
  for (link_id, parent_id, target_id) in [
    ("source-link", "source-folder", source_external_id),
    ("target-link", "target-folder", target_external_id),
  ] {
    organizer
      .create_link(
        workspace_id,
        CreateOrganizerLink {
          id: link_id.to_string(),
          parent_id: parent_id.to_string(),
          link_type: OrganizerLinkType::Doc,
          target_id: target_id.to_string(),
          target_workspace_id: None,
          index: Some("a0".to_string()),
        },
      )
      .await
      .expect("create document organizer link");
  }

  let first_run_id = create_run(&store, &profile).await;
  let first = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    first_run_id,
  )
  .await
  .expect("initial document-reference export");
  assert_eq!(first["docsCreated"], 3);
  assert_eq!(first["projectedDocumentPayloads"], 3);
  assert_eq!(first["documentProjectionConcurrency"], 3);
  assert_eq!(first["documentReferenceInventories"], 1);
  let source_path = "content/source-folder/source.md";
  let first_source = git_repo.remote_text(source_path).expect("source projection");
  assert!(
    first_source.contains("[Stable alias](../target-folder/target.md)"),
    "Git export must use the final relative target path: {first_source}"
  );
  let first_hash: String =
    sqlx::query_scalar("SELECT content_hash FROM git_sync_bindings WHERE profile_id = $1 AND doc_id = $2")
      .bind(profile.id)
      .bind(source_id)
      .fetch_one(&pool)
      .await
      .expect("source binding hash");

  let graph_inventory = loader::load_myoxus_docs(&pool, workspace_id)
    .await
    .expect("load graph freshness inventory");
  for doc_id in [source_id, target_id, unrelated_id] {
    let updated_at = graph_inventory.effective_updated_at[&doc_id];
    sqlx::query(
      "INSERT INTO document_graph_index_state
         (workspace_id, doc_id, source_updated_at, indexed_at, stale_state, occurrence_count)
       VALUES ($1, $2, $3, now(), 'current', $4)
       ON CONFLICT (workspace_id, doc_id) DO UPDATE
       SET source_updated_at = EXCLUDED.source_updated_at,
           indexed_at = EXCLUDED.indexed_at,
           stale_state = EXCLUDED.stale_state,
           occurrence_count = EXCLUDED.occurrence_count",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(updated_at)
    .bind(i32::from(doc_id == source_id))
    .execute(&pool)
    .await
    .expect("seed fresh document graph state");
  }
  sqlx::query(
    "INSERT INTO document_graph_occurrences
       (workspace_id, source_doc_id, source_block_id, raw_target_doc_id, target_doc_id,
        link_kind, params_key, target_state, source_updated_at)
     VALUES ($1, $2, 'reference-block', $3, $4, 'inline_reference', 'none', 'available', $5)",
  )
  .bind(workspace_id)
  .bind(source_id)
  .bind(target_external_id)
  .bind(target_id)
  .bind(graph_inventory.effective_updated_at[&source_id])
  .execute(&pool)
  .await
  .expect("seed source-to-target document graph edge");

  organizer
    .update_folder(
      workspace_id,
      "target-folder",
      UpdateOrganizerFolder {
        name: Some("Moved target".to_string()),
        ..UpdateOrganizerFolder::default()
      },
    )
    .await
    .expect("move target projection path");
  runner_config.max_docs_per_sync = 1;
  let move_run_id = create_run(&store, &profile).await;
  let moved = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    move_run_id,
  )
  .await
  .expect("target move export");
  assert_eq!(moved["docsUpdated"], 1);
  assert_eq!(moved["partial"], true);
  assert_eq!(moved["partialHasMore"], true);
  assert_eq!(moved["projectedDocumentPayloads"], 2);
  assert_eq!(moved["documentProjectionConcurrency"], 2);
  assert_eq!(moved["documentReferenceInventories"], 1);
  assert_eq!(moved["documentGraphDependenciesUsed"], true);
  let move_completion_run_id = create_run(&store, &profile).await;
  let move_completion = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    move_completion_run_id,
  )
  .await
  .expect("target move partial-session completion");
  assert_eq!(move_completion["docsUpdated"], 1);
  assert_eq!(move_completion["partial"], true);
  assert_eq!(move_completion["partialHasMore"], false);
  assert_eq!(move_completion["partialSession"]["status"], "Completed");
  assert_eq!(move_completion["projectedDocumentPayloads"], 1);
  assert_eq!(move_completion["documentProjectionConcurrency"], 1);
  assert_eq!(move_completion["documentReferenceInventories"], 1);
  let moved_source = git_repo.remote_text(source_path).expect("reprojected source");
  assert!(
    moved_source.contains("[Stable alias](../moved-target/target.md)"),
    "referrer must follow the moved final path: {moved_source}"
  );
  let moved_hash: String =
    sqlx::query_scalar("SELECT content_hash FROM git_sync_bindings WHERE profile_id = $1 AND doc_id = $2")
      .bind(profile.id)
      .bind(source_id)
      .fetch_one(&pool)
      .await
      .expect("moved source binding hash");
  assert_ne!(
    moved_hash, first_hash,
    "referrer hash must include the final relative link"
  );

  let commits_before_noop = git_repo.commit_count();
  let noop_run_id = create_run(&store, &profile).await;
  let noop = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    noop_run_id,
  )
  .await
  .expect("unchanged reference export");
  assert_eq!(noop["docsCreated"], 0);
  assert_eq!(noop["docsUpdated"], 0);
  assert_eq!(noop["docsDeleted"], 0);
  assert_eq!(noop["projectedDocumentPayloads"], 0);
  assert_eq!(noop["documentProjectionConcurrency"], 1);
  assert_eq!(noop["documentReferenceInventories"], 1);
  assert_eq!(git_repo.commit_count(), commits_before_noop);

  // Continue the same real runner journey with native selectors. A changed
  // source must not erase an export-only anchor used by an unchanged referrer.
  let target_binary = markdown_to_yjs(
    "Target",
    "# Über Größe\n\nRelease instruction\n\n- Check backup\n\nAdditional instruction\n",
  )
  .expect("current precise target body");
  let native_targets = yjs::markdown::markdown_native_targets(&target_binary).expect("current native tree");
  assert_eq!(native_targets.len(), 4);
  let native_source = |title: &str, targets: &[(&str, usize)]| {
    let mut builder = yjs::YjsDocumentBuilder::new(title);
    for (alias, index) in targets {
      let mut segment = yjs::YjsTextSegment::plain(" ");
      segment.reference = Some(yjs::MarkdownDocumentReference {
        page_id: target_external_id.to_string(),
        title: Some(alias.to_string()),
        description: None,
        params: Some(json!({"mode":"page", "blockIds":[native_targets[*index].block_id]})),
      });
      builder.push_paragraph(&[segment]);
    }
    builder.encode()
  };
  update_myoxus_payload(&pool, workspace_id, target_id, target_binary.clone()).await;
  update_myoxus_payload(
    &pool,
    workspace_id,
    source_id,
    native_source("Source", &[("Heading alias", 0), ("Instruction alias", 1)]),
  )
  .await;
  update_myoxus_payload(
    &pool,
    workspace_id,
    unrelated_id,
    native_source("Unrelated", &[("Backup alias", 2)]),
  )
  .await;
  runner_config.max_docs_per_sync = 100;
  let precise_run_id = create_run(&store, &profile).await;
  let precise = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    precise_run_id,
  )
  .await
  .expect("precise native target export");
  assert_eq!(precise["docsUpdated"], 3);
  assert_eq!(precise["projectedDocumentPayloads"], 3);
  assert_eq!(precise["documentReferenceInventories"], 1);
  let target_path = "content/moved-target/target.md";
  let anchor = |index: usize| format!("myoxus-{}", content_hash(&native_targets[index].block_id));
  let target_file = git_repo.remote_text(target_path).expect("actual prepared target file");
  for index in 0..3 {
    assert!(
      target_file.contains(&format!(" ^{}", anchor(index))),
      "the serialized target must own every linked anchor: {target_file}"
    );
  }
  assert!(
    !target_file.contains(&anchor(3)),
    "unreferenced blocks must not gain anchors"
  );
  let source_file = git_repo.remote_text(source_path).expect("precise source file");
  assert!(source_file.contains(&format!("[Heading alias](../moved-target/target.md#%5E{})", anchor(0))));
  assert!(source_file.contains(&format!(
    "[Instruction alias](../moved-target/target.md#%5E{})",
    anchor(1)
  )));
  let other_path = "content/unrelated.md";
  let unchanged_referrer = git_repo.remote_text(other_path).expect("second precise referrer");
  assert!(unchanged_referrer.contains(&format!("[Backup alias](moved-target/target.md#%5E{})", anchor(2))));

  let graph_service = myoxus_application::document_graph::DocumentGraphService::new(
    Arc::new(myoxus_infrastructure::document_graph::PgDocumentGraphRepository::new(
      pool.clone(),
    )),
    Arc::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))),
    Arc::new(myoxus_application::permission::PermissionService::new(
      auth_store.clone(),
    )),
    Arc::new(myoxus_application::document_metadata::DocumentMetadataService::new(
      Arc::new(myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository::new(pool.clone())),
    )),
    None,
    None,
    None,
    myoxus_application::document_graph::DocumentGraphLimits::default(),
  );
  for id in [source_id, target_id, unrelated_id] {
    graph_service
      .reindex_document_now(workspace_id, id)
      .await
      .expect("index actual native references");
  }
  update_myoxus_payload(
    &pool,
    workspace_id,
    source_id,
    native_source(
      "Source",
      &[("Heading alias", 0), ("Instruction alias", 1), ("Additional alias", 3)],
    ),
  )
  .await;
  graph_service
    .reindex_document_now(workspace_id, source_id)
    .await
    .expect("refresh the changed referrer");
  let incremental_run_id = create_run(&store, &profile).await;
  let incremental = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    incremental_run_id,
  )
  .await
  .expect("incremental precise target export");
  assert_eq!(
    incremental["docsUpdated"], 2,
    "only changed source and newly anchored target need writes"
  );
  assert_eq!(
    incremental["projectedDocumentPayloads"], 3,
    "complete precise batch must retain other referrers' anchors"
  );
  assert_eq!(incremental["documentGraphDependenciesUsed"], true);
  assert_eq!(
    git_repo.remote_text(other_path).expect("unchanged referrer"),
    unchanged_referrer
  );
  let target_file = git_repo.remote_text(target_path).expect("updated prepared target");
  for index in 0..4 {
    assert!(target_file.contains(&format!(" ^{}", anchor(index))));
  }
  let live_target = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .load_full_doc(workspace_id, target_id)
    .await
    .expect("live target after both exports");
  assert_eq!(
    yjs::markdown::markdown_native_targets(&live_target).expect("unchanged live native tree"),
    native_targets,
    "export preparation must not write anchors into the live document"
  );

  let mut partial_inventory = loader::load_myoxus_docs(&pool, workspace_id)
    .await
    .expect("partial target inventory");
  let paths = HashMap::from([
    (source_id, source_path.to_string()),
    (target_id, target_path.to_string()),
    (unrelated_id, other_path.to_string()),
  ]);
  for doc in &mut partial_inventory.docs {
    doc.planned_repo_path = Some(paths[&doc.doc_id].clone());
  }
  let selection = loader::select_projection_doc_ids(
    &pool,
    workspace_id,
    &partial_inventory.docs,
    &partial_inventory.effective_updated_at,
    Some(Utc::now()),
    &paths.keys().copied().collect(),
    &paths,
    Some(&std::collections::HashSet::from([target_id])),
  )
  .await
  .expect("fresh graph protects anchors in a target-only partial batch");
  assert!(selection.used_fresh_document_graph);
  assert_eq!(selection.doc_ids, paths.keys().copied().collect());
  let commits_before_precise_noop = git_repo.commit_count();
  let precise_noop_id = create_run(&store, &profile).await;
  let precise_noop = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    precise_noop_id,
  )
  .await
  .expect("precise native reference noop");
  assert_eq!(precise_noop["docsUpdated"], 0);
  assert_eq!(precise_noop["projectedDocumentPayloads"], 0);
  assert_eq!(git_repo.commit_count(), commits_before_precise_noop);

  // A source-only remote edit must resolve generated export anchors against
  // the unchanged native target, whose persisted body has no source anchors.
  let edited_source = git_repo
    .remote_text(source_path)
    .expect("exported source before remote edit")
    .replace("Instruction alias", "Reviewed instruction");
  git_repo.set_remote_file(source_path, edited_source.as_bytes());
  let pull_id = create_run(&store, &profile).await;
  let pulled = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    pull_id,
  )
  .await
  .expect("source-only edit of generated anchor links");
  assert_eq!(pulled["docsUpdated"], 1);
  assert_eq!(pulled["conflictsFound"], 0);
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let imported_source = service
    .load_full_doc(workspace_id, source_id)
    .await
    .expect("pulled source");
  let references = yjs::extract_document_references_from_yjs(&imported_source).expect("pulled exact references");
  for (alias, index) in [
    ("Heading alias", 0),
    ("Reviewed instruction", 1),
    ("Additional alias", 3),
  ] {
    let reference = references
      .occurrences
      .iter()
      .find(|reference| reference.params_json["title"] == alias)
      .unwrap_or_else(|| panic!("generated anchor link lost native identity: {alias}: {references:?}"));
    assert_eq!(reference.raw_target_doc_id, target_external_id);
    assert_eq!(
      reference.params_json["params"]["blockIds"],
      json!([native_targets[index].block_id])
    );
  }
  let target_after_pull = service
    .load_full_doc(workspace_id, target_id)
    .await
    .expect("unchanged target after pull");
  assert_eq!(
    yjs::markdown::markdown_native_targets(&target_after_pull).unwrap(),
    native_targets
  );
  assert_eq!(git_repo.remote_text(target_path).unwrap(), target_file);
  let commits_before_pull_noop = git_repo.commit_count();
  let pull_noop_id = create_run(&store, &profile).await;
  let pull_noop = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    pull_noop_id,
  )
  .await
  .expect("source-only native pull baseline is a noop");
  assert_eq!(pull_noop["docsUpdated"], 0);
  assert_eq!(pull_noop["conflictsFound"], 0);
  assert_eq!(git_repo.commit_count(), commits_before_pull_noop);

  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_imports_precise_forward_and_existing_targets_with_matching_persisted_baselines() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  use futures_util::FutureExt;
  let outcome = std::panic::AssertUnwindSafe(async {
  let app_config = AppConfig::load().expect("app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("isolated Git directory");
  let source = "[[target#^instruction|Instruction alias]]\n\n[Heading alias](target.md#%C3%9Cber%20Gr%C3%B6%C3%9Fe)\n\n[Local alias](#Local)\n\n## Local\n";
  let git_repo = HarnessGitRepo::with_files(&[
    ("content/source.md", source.as_bytes()),
    (
      "content/target.md",
      "# Über Größe\n\nRelease instruction ^instruction\n\n[[source|Source alias]]\n".as_bytes(),
    ),
  ]);
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/precise-import.git",
    None,
  )
  .await;
  let config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_validation_mode: "strict".into(),
    ..RunnerConfig::default()
  };
  let run_id = create_run(&store, &profile).await;
  let first = run_sync_with_git_repo(&pool, &config, &locks, &blob_storage, &git_repo, profile.id, run_id)
    .await
    .expect("atomic two-file native import");
  assert_eq!(first["docsCreated"], 2);
  assert_eq!(first["conflictsFound"], 0);
  let documents = loader::load_myoxus_docs(&pool, workspace_id)
    .await
    .expect("current imported documents");
  let by_title = documents
    .docs
    .iter()
    .map(|document| (document.title.as_str(), document.doc_id))
    .collect::<HashMap<_, _>>();
  let source_id = by_title["Source"];
  let target_id = by_title["Target"];
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let target = service
    .load_full_doc(workspace_id, target_id)
    .await
    .expect("persisted target");
  let targets = yjs::markdown::markdown_native_targets(&target).expect("persisted target tree");
  let target_external_id = &documents.reference_external_ids[&target_id];
  let assert_source = |binary: &[u8], heading_alias: &str| {
    let source_targets = yjs::markdown::markdown_native_targets(binary).expect("persisted source tree");
    let references = yjs::extract_document_references_from_yjs(binary).expect("persisted native references");
    for (alias, external_id, tree, fragment) in [
      (
        "Instruction alias",
        target_external_id.as_str(),
        &targets,
        "^instruction",
      ),
      (heading_alias, target_external_id.as_str(), &targets, "Über Größe"),
      (
        "Local alias",
        documents.reference_external_ids[&source_id].as_str(),
        &source_targets,
        "Local",
      ),
    ] {
      let occurrence = references
        .occurrences
        .iter()
        .find(|reference| reference.params_json["title"] == alias)
        .unwrap_or_else(|| panic!("missing actual native reference {alias}: {references:?}"));
      let target = yjs::markdown::resolve_markdown_target(tree, fragment).expect("unique persisted native target");
      assert_eq!(occurrence.raw_target_doc_id, external_id);
      assert_eq!(occurrence.params_json["params"]["blockIds"], json!([target.block_id]));
    }
  };
  assert_source(
    &service
      .load_full_doc(workspace_id, source_id)
      .await
      .expect("imported source"),
    "Heading alias",
  );
  let mut projected = loader::load_myoxus_docs(&pool, workspace_id)
    .await
    .expect("independent persisted baseline read");
  for document in &mut projected.docs {
    document.planned_repo_path = Some(
      if document.doc_id == source_id {
        "content/source.md"
      } else {
        "content/target.md"
      }
      .into(),
    );
  }
  let projection_ids = projected.docs.iter().map(|document| document.doc_id).collect();
  let (captured, selected) = loader::capture_myoxus_docs_in_path_plan(
    &pool, workspace_id, &config.server_origin, &projected.docs,
    &projected.reference_documents, &projected.reference_external_ids, &projection_ids,
  ).await.expect("capture native projection");
  let (failures, failed_ids, _, _) = loader::project_myoxus_docs_in_path_plan(
    &mut projected.docs,
    &projected.reference_external_ids,
    captured,
    &selected,
    10,
    &std::collections::HashMap::new(),
  )
  .await
  .expect("actual future outbound projection");
  assert_eq!((failures, failed_ids), (0, Vec::new()));
  for document in projected.docs {
    let baseline: String = sqlx::query_scalar("SELECT bl.content_hash FROM git_sync_baselines bl JOIN git_sync_bindings b ON b.id = bl.binding_id WHERE b.profile_id = $1 AND b.doc_id = $2")
      .bind(profile.id).bind(document.doc_id).fetch_one(&pool).await.expect("persisted imported baseline");
    assert_eq!(
      document.content_hash.as_deref(),
      Some(baseline.as_str()),
      "baseline must describe the stored native body and exact target paths, not a fresh conversion of source Markdown"
    );
  }
  let before_manifest:serde_json::Value = serde_json::from_slice(&git_repo.remote_bytes(export::GIT_SYNC_MANIFEST_PATH).unwrap()).unwrap();
  let overview_path = before_manifest["overview"]["repoPath"].as_str().unwrap();
  let overview_before = git_repo.remote_text(overview_path);
  let commits_before_noop = git_repo.commit_count();
  let unchanged_id = create_run(&store, &profile).await;
  let unchanged = run_sync_with_git_repo(
    &pool,
    &config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    unchanged_id,
  )
  .await
  .expect("imported organizer identities converge without document changes");
  assert_eq!(unchanged["docsUpdated"], 0);
  assert_eq!(unchanged["conflictsFound"], 0);
  assert_eq!(
    git_repo.commit_count(),
    commits_before_noop,
    "first import manifest must already contain its newly published parent; overview before={overview_before:?}, after={:?}",git_repo.remote_text(overview_path)
  );
  assert_eq!(
    git_repo.remote_text("content/source.md").as_deref(),
    Some(source),
    "manifest convergence must not rewrite authored Markdown"
  );
  let converged_commit_count = git_repo.commit_count();
  let converged_id = create_run(&store, &profile).await;
  let converged = run_sync_with_git_repo(
    &pool,
    &config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    converged_id,
  )
  .await
  .expect("converged native import is a genuine noop");
  assert_eq!(converged["docsUpdated"], 0);
  assert_eq!(converged["conflictsFound"], 0);
  assert_eq!(git_repo.commit_count(), converged_commit_count);

  let updated = source.replace("Heading alias", "Current heading alias");
  git_repo.set_remote_file("content/source.md", updated.as_bytes());
  let pull_id = create_run(&store, &profile).await;
  let pulled = run_sync_with_git_repo(&pool, &config, &locks, &blob_storage, &git_repo, profile.id, pull_id)
    .await
    .expect("existing target lookup uses current native IDs");
  assert_eq!(pulled["docsUpdated"], 1);
  assert_eq!(pulled["conflictsFound"], 0);
  assert_source(
    &service
      .load_full_doc(workspace_id, source_id)
      .await
      .expect("replaced source"),
    "Current heading alias",
  );
  assert_eq!(
    yjs::markdown::markdown_native_targets(
      &service
        .load_full_doc(workspace_id, target_id)
        .await
        .expect("unchanged target")
    )
    .expect("unchanged native target tree"),
    targets
  );
  let commits_after_pull = git_repo.commit_count();
  let next_id = create_run(&store, &profile).await;
  let next = run_sync_with_git_repo(&pool, &config, &locks, &blob_storage, &git_repo, profile.id, next_id)
    .await
    .expect("unchanged reimport is a genuine noop");
  assert_eq!(
    (
      next["docsCreated"].as_i64(),
      next["docsUpdated"].as_i64(),
      next["docsDeleted"].as_i64()
    ),
    (Some(0), Some(0), Some(0))
  );
  assert_eq!(next["conflictsFound"], 0);
  assert_eq!(git_repo.commit_count(), commits_after_pull);
  }).catch_unwind().await;
  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
  outcome.expect("precise import projection after fixture cleanup");
}

#[tokio::test]
async fn empty_document_materializes_and_second_run_is_exact_noop() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/empty-document.git",
    None,
  )
  .await;
  let empty_doc_id = seed_doc_metadata_only(&pool, workspace_id, admin_id, "Empty document").await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    ..RunnerConfig::default()
  };

  let first_run_id = create_run(&store, &profile).await;
  let first = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locking::new_locks(),
    &MemoryBlobStorage::default(),
    &git_repo,
    profile.id,
    first_run_id,
  )
  .await
  .expect("empty-document outbound run");
  assert_eq!(first["status"], "Completed");
  assert_eq!(first["docsCreated"], 1);
  assert_eq!(git_repo.commit_count(), 1, "first materialization must commit once");

  let (binding_id, bound_doc_id, sync_id, repo_path) = active_doc_binding(&pool, profile.id).await;
  assert_eq!(bound_doc_id, empty_doc_id);
  assert_eq!(repo_path, "content/empty-document.md");
  let remote_file = git_repo.remote_text(&repo_path).expect("frontmatter-only remote file");
  let (frontmatter_yaml, body) = export::split_markdown_file(&remote_file);
  let frontmatter =
    export::ExportFrontmatter::from_yaml(&frontmatter_yaml.expect("empty document has canonical frontmatter"))
      .expect("valid empty-document frontmatter");
  assert_eq!(frontmatter.sync_id, sync_id);
  assert_eq!(frontmatter.doc_id, empty_doc_id);
  assert_eq!(frontmatter.workspace_id, workspace_id);
  assert_eq!(frontmatter.title, "Empty document");
  assert!(body.is_empty(), "empty document must have an empty Markdown body");

  let empty_hash = content_hash("");
  let binding_hash: Option<String> = sqlx::query_scalar("SELECT content_hash FROM git_sync_bindings WHERE id = $1")
    .bind(binding_id)
    .fetch_one(&pool)
    .await
    .expect("empty binding hash");
  assert_eq!(binding_hash.as_deref(), Some(empty_hash.as_str()));
  let baseline_hash: String = sqlx::query_scalar("SELECT content_hash FROM git_sync_baselines WHERE binding_id = $1")
    .bind(binding_id)
    .fetch_one(&pool)
    .await
    .expect("empty baseline hash");
  assert_eq!(baseline_hash, empty_hash);
  let manifest: export::GitSyncManifest = serde_json::from_str(
    &git_repo
      .remote_text(export::GIT_SYNC_MANIFEST_PATH)
      .expect("Git Sync manifest"),
  )
  .expect("valid Git Sync manifest");
  let manifest_doc = manifest
    .documents
    .iter()
    .find(|document| document.doc_id == empty_doc_id)
    .expect("empty document manifest entry");
  assert_eq!(manifest_doc.repo_path, repo_path);
  assert_eq!(manifest_doc.content_hash, empty_hash);

  let commits_before_noop = git_repo.commit_count();
  let second_run_id = create_run(&store, &profile).await;
  let second = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locking::new_locks(),
    &MemoryBlobStorage::default(),
    &git_repo,
    profile.id,
    second_run_id,
  )
  .await
  .expect("unchanged empty-document run");
  assert_eq!(second["status"], "Completed");
  assert_eq!(second["docsCreated"], 0);
  assert_eq!(second["docsUpdated"], 0);
  assert_eq!(second["docsDeleted"], 0);
  assert_eq!(
    git_repo.commit_count(),
    commits_before_noop,
    "unchanged empty document must not create another commit"
  );

  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn empty_document_contract_keeps_conversion_failure_before_git_mutation() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/conversion-failure.git",
    None,
  )
  .await;
  let broken_doc_id = seed_doc_metadata_only(&pool, workspace_id, admin_id, "Broken document").await;
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 1, now())",
  )
  .bind(broken_doc_id)
  .bind(workspace_id)
  .bind(vec![0xff_u8, 0xff, 0xff])
  .execute(&pool)
  .await
  .expect("insert invalid Yjs snapshot");

  let run_id = create_run(&store, &profile).await;
  let error = run_sync_with_git_repo(
    &pool,
    &RunnerConfig {
      overview_service: overview_state.workspace_overview_service(),
      repo_base_dir: repo_dir.path().join("repos"),
      crypto_key: app_config.crypto.private_key.clone(),
      min_free_disk_mb: 0,
      max_mirror_storage_mb: 0,
      ..RunnerConfig::default()
    },
    &locking::new_locks(),
    &MemoryBlobStorage::default(),
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect_err("invalid Yjs conversion must fail the run");
  assert!(!error.is_retryable(), "persisted conversion failure is permanent");
  assert_eq!(git_repo.commit_count(), 0, "conversion failure must precede commit");
  assert!(
    git_repo.remote_text(export::GIT_SYNC_MANIFEST_PATH).is_none(),
    "conversion failure must not publish a manifest"
  );
  let bindings: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE profile_id = $1")
    .bind(profile.id)
    .fetch_one(&pool)
    .await
    .expect("binding count after conversion failure");
  assert_eq!(bindings, 0, "conversion failure must not create a binding");

  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn unsupported_git_html_fails_before_document_or_repository_mutation() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let source = "# Valid heading\n\n<div data-secret='hidden'>unsupported</div>";
  let git_repo = HarnessGitRepo::with_file("content/unsupported.md", source.as_bytes());
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/unsupported-html.git",
    None,
  )
  .await;
  let docs_before: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("document count before rejected Git import");
  let run_id = create_run(&store, &profile).await;
  let error = run_sync_with_git_repo(
    &pool,
    &RunnerConfig {
      overview_service: overview_state.workspace_overview_service(),
      repo_base_dir: repo_dir.path().join("repos"),
      crypto_key: app_config.crypto.private_key.clone(),
      min_free_disk_mb: 0,
      max_mirror_storage_mb: 0,
      ..RunnerConfig::default()
    },
    &locking::new_locks(),
    &MemoryBlobStorage::default(),
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect_err("raw Git HTML must fail before persistence");
  assert!(!error.to_string().contains("hidden"));
  assert_eq!(git_repo.commit_count(), 0);
  let docs_after: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("document count after rejected Git import");
  let bindings: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE profile_id = $1")
    .bind(profile.id)
    .fetch_one(&pool)
    .await
    .expect("binding count after rejected Git import");
  assert_eq!(docs_after, docs_before);
  assert_eq!(bindings, 0);
  assert_eq!(git_repo.remote_text("content/unsupported.md").as_deref(), Some(source));

  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn rejected_push_never_materializes_normal_state_or_a_successful_commit() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default().fail_next_pushes(1);
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/rejected-push.git",
    None,
  )
  .await;
  seed_myoxus_doc(
    &pool,
    workspace_id,
    admin_id,
    "Rejected push",
    "# Rejected push\n\nThis must never become remote truth.",
  )
  .await;
  let run_id = create_run(&store, &profile).await;
  let error = run_sync_with_git_repo(
    &pool,
    &RunnerConfig {
      overview_service: overview_state.workspace_overview_service(),
      repo_base_dir: repo_dir.path().join("repos"),
      crypto_key: app_config.crypto.private_key.clone(),
      min_free_disk_mb: 0,
      max_mirror_storage_mb: 0,
      push_max_retries: 0,
      ..RunnerConfig::default()
    },
    &locking::new_locks(),
    &MemoryBlobStorage::default(),
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect_err("rejected push must fail the runner");
  assert!(
    error.is_retryable(),
    "transport rejection must retain queue retry semantics"
  );
  assert!(
    git_repo.remote_text("content/rejected-push.md").is_none(),
    "working-tree bytes must not leak into remote state before a successful push"
  );

  let pending = store.get_run(run_id).await.expect("pending retry run");
  assert_eq!(pending.status, RunStatus::Pending);
  assert_eq!(pending.commit_after, None);
  assert_eq!(pending.observed_remote_oid, None);
  assert!(!pending.reconciliation_required);
  for table in ["git_sync_bindings", "git_sync_version_links"] {
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*)::bigint FROM {table} WHERE profile_id = $1"))
      .bind(profile.id)
      .fetch_one(&pool)
      .await
      .expect("normal state count");
    assert_eq!(count, 0, "{table} must remain empty after push rejection");
  }
  let baseline_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::bigint
     FROM git_sync_baselines b
     JOIN git_sync_bindings d ON d.id = b.binding_id
     WHERE d.profile_id = $1",
  )
  .bind(profile.id)
  .fetch_one(&pool)
  .await
  .expect("document baseline count");
  assert_eq!(
    baseline_count, 0,
    "document baselines must remain empty after push rejection"
  );

  let job_id = format!("git-sync-{run_id}");
  assert!(
    store
      .fail_pending_run_after_retry_exhaustion(run_id, &job_id, "queue retry budget exhausted after push rejection")
      .await
      .expect("terminalize exhausted run")
  );
  let failed = store.get_run(run_id).await.expect("failed run");
  assert_eq!(failed.status, RunStatus::Failed);
  assert_eq!(failed.commit_after, None);
  assert!(!failed.reconciliation_required);

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn transport_error_after_remote_move_is_recovered_from_authenticated_remote_truth() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default().move_remote_then_fail_next_pushes(1);
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/moved-before-error.git",
    None,
  )
  .await;
  seed_myoxus_doc(
    &pool,
    workspace_id,
    admin_id,
    "Remote truth",
    "# Remote truth\n\nThe transport loses its acknowledgement.",
  )
  .await;
  let run_id = create_run(&store, &profile).await;
  let result = run_sync_with_git_repo(
    &pool,
    &RunnerConfig {
      overview_service: overview_state.workspace_overview_service(),
      repo_base_dir: repo_dir.path().join("repos"),
      crypto_key: app_config.crypto.private_key.clone(),
      min_free_disk_mb: 0,
      max_mirror_storage_mb: 0,
      push_max_retries: 0,
      ..RunnerConfig::default()
    },
    &locking::new_locks(),
    &MemoryBlobStorage::default(),
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect("authenticated ref observation must recover the lost push acknowledgement");
  assert_eq!(result["status"], "Completed");
  assert!(
    git_repo.remote_text("content/remote-truth.md").is_some(),
    "fixture must actually move the remote before returning its transport error"
  );
  let run = store.get_run(run_id).await.expect("completed run");
  assert_eq!(run.status, RunStatus::Completed);
  assert_eq!(run.commit_after, run.observed_remote_oid);
  assert!(run.commit_after.is_some());
  assert!(!run.reconciliation_required);

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_pulls_updates_and_deletes_git_markdown_to_myoxus() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::with_files(&[
    ("content/git-alpha.md", b"# Git Alpha\n\nInitial Git body."),
    ("content/.gitkeep", b""),
  ]);
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/doc-pull.git",
    None,
  )
  .await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };

  let first_run_id = create_run(&store, &profile).await;
  let first = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    first_run_id,
  )
  .await
  .expect("create-in-myoxus run");
  assert_eq!(first["status"], "Completed");
  assert_eq!(first["docsCreated"], 1, "first run must import the Git markdown file");
  let (binding_id, doc_id, sync_id, repo_path) = active_doc_binding(&pool, profile.id).await;
  assert_eq!(repo_path, "content/git-alpha.md");
  assert!(
    doc_markdown(&pool, doc_id).await.contains("Initial Git body."),
    "imported Myoxus snapshot must contain the Git body"
  );

  let registration: String =
    sqlx::query_scalar("SELECT state FROM page_registration_evidence WHERE workspace_id=$1 AND doc_id=$2")
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  let root = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .load_full_doc(workspace_id, workspace_id)
    .await
    .unwrap();
  assert_eq!(
    (
      registration.as_str(),
      yjs::extract_workspace_root_metadata(&root)
        .unwrap()
        .pages
        .iter()
        .any(|page| page.id == doc_id.to_string())
    ),
    ("registered", true),
    "a native Git import must open through the ordinary editor, without local recovery"
  );

  let updated_git = export::compose_markdown_file(
    &export::ExportFrontmatter {
      sync_id,
      doc_id,
      workspace_id,
      title: "Git Alpha".to_string(),
    },
    "# Git Alpha\n\nUpdated Git body.",
  );
  git_repo.set_remote_file(&repo_path, updated_git.as_bytes());
  let second_run_id = create_run(&store, &profile).await;
  let second = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    second_run_id,
  )
  .await
  .expect("pull-to-myoxus run");
  assert_eq!(second["status"], "Completed");
  assert_eq!(
    second["docsUpdated"], 1,
    "second run must pull the changed Git markdown"
  );
  assert!(
    doc_markdown(&pool, doc_id).await.contains("Updated Git body."),
    "updated Git markdown must overwrite the Myoxus snapshot"
  );

  git_repo.remove_remote_file(&repo_path);
  let third_run_id = create_run(&store, &profile).await;
  let third = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    third_run_id,
  )
  .await
  .expect("delete-in-myoxus run");
  assert_eq!(third["status"], "Completed");
  assert_eq!(
    third["docsDeleted"], 1,
    "third run must soft-delete the Myoxus doc after Git delete"
  );
  let deleted_at_exists: bool = sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("doc deleted_at");
  assert!(deleted_at_exists, "DeleteInMyoxus must soft-delete the imported doc");
  let tombstoned: bool = sqlx::query_scalar("SELECT tombstone FROM git_sync_bindings WHERE id = $1")
    .bind(binding_id)
    .fetch_one(&pool)
    .await
    .expect("binding tombstone");
  assert!(tombstoned, "DeleteInMyoxus must tombstone the document binding");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_keeps_normalized_markdown_noop_and_propagates_later_edits() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  use futures_util::FutureExt;
  let outcome=std::panic::AssertUnwindSafe(async {
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");

  let external_doc_id = Uuid::new_v4();
  let external_sync_id = Uuid::new_v4();
  let external_path = "content/external-roundtrip.md";
  let external_body = "# External roundtrip\r\n\r\nsoft\r\nwrap\r\n\r\nold hard break  \r\nstays visible\r\n\r\n```text\r\ncode  \r\nbytes\\\r\n```\r\n";
  const HEADER_TABLES: &str = "<table><tbody><tr><td><strong>Headerless label</strong></td><td></td></tr><tr><td>first<br>second</td><td>&lt;literal&gt;</td></tr></tbody></table>\n\n<table><thead><tr><th>First header</th></tr><tr><th><em>Second header</em></th></tr></thead><tbody><tr><td>Body</td></tr></tbody></table>";
  let external_body = format!("{external_body}\r\n{FOOTNOTE_FIXTURE}\n\n{HEADER_TABLES}");
  let external_file = export::compose_markdown_file(
    &export::ExportFrontmatter {
      sync_id: external_sync_id,
      doc_id: external_doc_id,
      workspace_id,
      title: "External roundtrip".to_string(),
    },
    &external_body,
  );
  let git_repo = HarnessGitRepo::with_files(&[
    (external_path, external_file.as_bytes()),
    ("content/media/pixel.svg", FOOTNOTE_IMAGE),
  ]);
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/roundtrip-noop.git",
    None,
  )
  .await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };

  let native_doc_id = seed_myoxus_doc(&pool, workspace_id, admin_id, "Native roundtrip", "placeholder").await;
  let mut native = yjs::YjsDocumentBuilder::new("Native roundtrip");
  let mut native_break = yjs::YjsTextSegment::plain("native hard\nbreak");
  native_break.bold = true;
  native.push_paragraph(&[native_break]);
  native.push_paragraph(&[yjs::YjsTextSegment::plain("separate paragraph")]);
  let headerless_rows=vec![vec![yjs::YjsTextSegment::plain("Native first body")],vec![yjs::YjsTextSegment::plain("Native second body")]].into_iter().map(|row|row.into_iter().map(|cell|vec![cell]).collect::<Vec<_>>()).collect::<Vec<_>>();
  native.push_table(&headerless_rows);
  update_myoxus_payload(&pool, workspace_id, native_doc_id, native.encode()).await;

  let first = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    create_run(&store, &profile).await,
  )
  .await
  .expect("initial bidirectional normalization run");
  assert_eq!(first["status"], "Completed");
  assert_eq!(first["docsCreated"], 2);
  assert_eq!(first["conflictsFound"], 0);
  let imported = doc_markdown(&pool, external_doc_id).await;
  assert!(
    imported.contains("soft wrap"),
    "soft wrap must normalize to a space: {imported}"
  );
  assert!(
    imported.contains("old hard break\\\nstays visible"),
    "two-space hard break must normalize once to the canonical spelling: {imported}"
  );
  assert!(
    imported.contains("```text\ncode  \nbytes\\\n```"),
    "code bytes must retain their source spelling: {imported}"
  );
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let payload = service.load_full_doc(workspace_id, external_doc_id).await.unwrap();
  assert_parent_local_targets(&payload);
  assert_eq!(imported.matches("[^Research]:").count(), 1);
  assert!(imported.contains("    3. Ordered item"));
  assert!(imported.contains("    | :--- | :---: | ---: |"));
  assert!(imported.contains("<table><tbody><tr><td><strong>Headerless label</strong>"));
  assert!(imported.contains("<thead><tr><th>First header</th></tr><tr><th><em>Second header</em>"));
  assert!(imported.contains("first<br>second")&&imported.contains("&lt;literal&gt;"));
  let assets = yjs::extract_portable_asset_references(&payload).unwrap();
  assert_eq!(assets.len(), 1);
  assert_eq!(
    blob_storage
      .read_blob(&format!("{workspace_id}/{}", assets[0].source_key))
      .await
      .unwrap()
      .data
      .as_ref(),
    FOOTNOTE_IMAGE
  );
  let metadata: (String, i64) = sqlx::query_as("SELECT status,size FROM blobs WHERE workspace_id=$1 AND key=$2")
    .bind(workspace_id)
    .bind(&assets[0].source_key)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(metadata, ("completed".into(), FOOTNOTE_IMAGE.len() as i64));
  let document_count: i64 =
    sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1 AND NOT is_workspace_root")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(
    document_count, 2,
    "only the normal native and imported source parents exist"
  );
  let native_path: String = sqlx::query_scalar(
    "SELECT repo_path FROM git_sync_bindings WHERE profile_id = $1 AND doc_id = $2 AND tombstone = false",
  )
  .bind(profile.id)
  .bind(native_doc_id)
  .fetch_one(&pool)
  .await
  .expect("native binding path");
  let native_export = git_repo.remote_text(&native_path).expect("native Git projection");
  assert!(native_export.contains("**native hard\\\nbreak**"));
  assert!(native_export.contains("<table><tbody><tr><td>Native first body</td></tr>"),"an absent native count must export without an invented header");

  let first_external_bytes = git_repo.remote_bytes(external_path).expect("external source bytes");
  // Persisted-body baselines and the deterministic organizer projection must
  // make the very next unchanged run a noop, including its manifest.
  let first_commit_count_before_followup = git_repo.commit_count();
  let manifest_convergence = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    create_run(&store, &profile).await,
  )
  .await
  .expect("converge imported document manifest identity");
  assert_eq!(manifest_convergence["docsCreated"], 0);
  assert_eq!(manifest_convergence["docsUpdated"], 0);
  assert_eq!(manifest_convergence["docsDeleted"], 0);
  assert_eq!(manifest_convergence["conflictsFound"], 0);
  assert_eq!(
    git_repo.commit_count(),
    first_commit_count_before_followup,
    "the second unchanged sync must not publish a corrective commit"
  );
  assert_eq!(
    git_repo.remote_bytes(external_path).as_deref(),
    Some(first_external_bytes.as_slice())
  );

  let first_oid = git_repo.remote_oid();
  let first_commit_count = git_repo.commit_count();
  let first_state = document_sync_hash_state(&pool, profile.id).await;
  for pass in 1..=2 {
    let unchanged = run_sync_with_git_repo(
      &pool,
      &runner_config,
      &locks,
      &blob_storage,
      &git_repo,
      profile.id,
      create_run(&store, &profile).await,
    )
    .await
    .unwrap_or_else(|error| panic!("unchanged normalization run {pass}: {error}"));
    assert_eq!(unchanged["docsCreated"], 0);
    assert_eq!(unchanged["docsUpdated"], 0);
    assert_eq!(unchanged["docsDeleted"], 0);
    assert_eq!(unchanged["conflictsFound"], 0);
    assert_eq!(git_repo.remote_oid(), first_oid);
    assert_eq!(git_repo.commit_count(), first_commit_count);
    assert_eq!(
      git_repo.remote_bytes(external_path).as_deref(),
      Some(first_external_bytes.as_slice())
    );
    assert_eq!(document_sync_hash_state(&pool, profile.id).await, first_state);
  }

  let mut native_edit = yjs::YjsDocumentBuilder::new("Native roundtrip");
  native_edit.push_paragraph(&[yjs::YjsTextSegment::plain("native edit\nstill visible")]);
  native_edit.push_table(&headerless_rows);
  update_myoxus_payload(&pool, workspace_id, native_doc_id, native_edit.encode()).await;
  let pushed = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    create_run(&store, &profile).await,
  )
  .await
  .expect("push later native edit");
  assert_eq!(pushed["docsUpdated"], 1);
  assert_eq!(pushed["conflictsFound"], 0);
  assert!(
    git_repo
      .remote_text(&native_path)
      .expect("edited native projection")
      .contains("native edit\\\nstill visible")
  );

  let external_edit_body = external_body.replace("soft\r\nwrap", "remote\r\nedit");
  let external_edit = export::compose_markdown_file(
    &export::ExportFrontmatter {
      sync_id: external_sync_id,
      doc_id: external_doc_id,
      workspace_id,
      title: "External roundtrip".to_string(),
    },
    &external_edit_body,
  );
  git_repo.set_remote_file(external_path, external_edit.as_bytes());
  let pulled = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    create_run(&store, &profile).await,
  )
  .await
  .expect("pull later external edit");
  assert_eq!(pulled["docsUpdated"], 1);
  assert_eq!(pulled["conflictsFound"], 0);
  assert!(doc_markdown(&pool, external_doc_id).await.contains("remote edit"));
  assert_parent_local_targets(&service.load_full_doc(workspace_id, external_doc_id).await.unwrap());
  let final_body=doc_markdown(&pool,external_doc_id).await;
  assert!(final_body.contains("<table><tbody><tr><td><strong>Headerless label</strong>")&&final_body.contains("<em>Second header</em>"));
  assert!(git_repo.remote_text(&native_path).unwrap().contains("<table><tbody><tr><td>Native first body</td></tr>"));

  let final_oid = git_repo.remote_oid();
  let final_commit_count = git_repo.commit_count();
  let final_files = (
    git_repo.remote_bytes(external_path),
    git_repo.remote_bytes(&native_path),
  );
  let final_state = document_sync_hash_state(&pool, profile.id).await;
  for pass in 1..=2 {
    let unchanged = run_sync_with_git_repo(
      &pool,
      &runner_config,
      &locks,
      &blob_storage,
      &git_repo,
      profile.id,
      create_run(&store, &profile).await,
    )
    .await
    .unwrap_or_else(|error| panic!("post-edit no-op run {pass}: {error}"));
    assert_eq!(unchanged["docsCreated"], 0);
    assert_eq!(unchanged["docsUpdated"], 0);
    assert_eq!(unchanged["docsDeleted"], 0);
    assert_eq!(unchanged["conflictsFound"], 0);
    assert_eq!(git_repo.remote_oid(), final_oid);
    assert_eq!(git_repo.commit_count(), final_commit_count);
    assert_eq!(
      (
        git_repo.remote_bytes(external_path),
        git_repo.remote_bytes(&native_path)
      ),
      final_files
    );
    assert_eq!(document_sync_hash_state(&pool, profile.id).await, final_state);
  }
  let open_conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_conflicts WHERE profile_id = $1")
    .bind(profile.id)
    .fetch_one(&pool)
    .await
    .expect("open conflict count");
  assert_eq!(open_conflicts, 0);

  }).catch_unwind().await;
  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn runner_creates_document_conflict_for_bidirectional_changes() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  use futures_util::FutureExt;
  let outcome = std::panic::AssertUnwindSafe(async {
    let app_config = AppConfig::load().expect("load app config");
    let store = SqlxGitSyncStore::new(pool.clone());
    let repo_dir = TempDir::new().expect("repo tempdir");
    let git_repo = HarnessGitRepo::default();
    let blob_storage = MemoryBlobStorage::default();
    let locks = locking::new_locks();
    let profile = create_test_profile(
      &pool,
      &store,
      &app_config,
      workspace_id,
      admin_id,
      "https://example.test/myoxus/doc-conflict.git",
      None,
    )
    .await;
    let runner_config = RunnerConfig {
      overview_service: overview_state.workspace_overview_service(),
      repo_base_dir: repo_dir.path().join("repos"),
      crypto_key: app_config.crypto.private_key.clone(),
      min_free_disk_mb: 0,
      max_mirror_storage_mb: 0,
      mime_validation_mode: "strict".to_string(),
      ..RunnerConfig::default()
    };

    let doc_id = seed_myoxus_doc(
      &pool,
      workspace_id,
      admin_id,
      "Conflict Alpha",
      "# Conflict Alpha\n\nBase body.",
    )
    .await;
    let first_run_id = create_run(&store, &profile).await;
    run_sync_with_git_repo(
      &pool,
      &runner_config,
      &locks,
      &blob_storage,
      &git_repo,
      profile.id,
      first_run_id,
    )
    .await
    .expect("baseline export run");
    let (_binding_id, _bound_doc_id, sync_id, repo_path) = active_doc_binding(&pool, profile.id).await;

    update_myoxus_doc(
      &pool,
      workspace_id,
      doc_id,
      "Conflict Alpha",
      "# Conflict Alpha\n\nMyoxus side body.",
    )
    .await;
    let git_side = export::compose_markdown_file(
      &export::ExportFrontmatter {
        sync_id,
        doc_id,
        workspace_id,
        title: "Conflict Alpha".to_string(),
      },
      "# Conflict Alpha\n\nGit side body.",
    );
    git_repo.set_remote_file(&repo_path, git_side.as_bytes());

    let second_run_id = create_run(&store, &profile).await;
    let second = run_sync_with_git_repo(
      &pool,
      &runner_config,
      &locks,
      &blob_storage,
      &git_repo,
      profile.id,
      second_run_id,
    )
    .await
    .expect("bidirectional conflict run");
    assert_eq!(second["status"], "Completed");
    assert_eq!(
      second["conflictsFound"], 1,
      "bidirectional divergent edits must create a conflict"
    );
    let conflict: (String, Option<String>, Option<String>) = sqlx::query_as(
      "SELECT resolution, myoxus_content, git_content FROM git_sync_conflicts WHERE profile_id = $1 AND doc_id = $2",
    )
    .bind(profile.id)
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("document conflict row");
    assert_eq!(conflict.0, "Open");
    assert!(
      conflict
        .1
        .as_deref()
        .is_some_and(|content| content.contains("Myoxus side body.")),
      "conflict must preserve Myoxus content"
    );
    assert!(
      conflict
        .2
        .as_deref()
        .is_some_and(|content| content.contains("Git side body.")),
      "conflict must preserve Git content"
    );

    let original = store
      .get_conflicts_by_profile(profile.id, false)
      .await
      .unwrap()
      .pop()
      .unwrap();
    let repeat = create_run(&store, &profile).await;
    let repeated = run_sync_with_git_repo(
      &pool,
      &runner_config,
      &locks,
      &blob_storage,
      &git_repo,
      profile.id,
      repeat,
    )
    .await
    .unwrap();
    assert_eq!(
      repeated["conflictsCreated"], 0,
      "unchanged divergence must not copy the full payload again"
    );
    let mut repeated_input = original.clone();
    repeated_input.id = Uuid::new_v4();
    assert_eq!(
      store.create_conflict(&repeated_input).await.unwrap().id,
      original.id,
      "direct writes use the same rule"
    );
    let current = store.get_conflicts_by_profile(profile.id, false).await.unwrap();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].id, original.id);
    assert_eq!(current[0].created_at, original.created_at);
    let changed = git_side.replace("Git side body.", "New Git side body.");
    git_repo.set_remote_file(&repo_path, changed.as_bytes());
    let next = create_run(&store, &profile).await;
    let observed = run_sync_with_git_repo(
      &pool,
      &runner_config,
      &locks,
      &blob_storage,
      &git_repo,
      profile.id,
      next,
    )
    .await
    .unwrap();
    assert_eq!(observed["conflictsCreated"], 1);
    let replacement = store.get_conflicts_by_profile(profile.id, false).await.unwrap();
    assert_eq!(replacement.len(), 1);
    assert_ne!(replacement[0].id, original.id);
    assert_eq!(
      store.get_conflict(original.id).await.unwrap().resolution,
      myoxus_domain::git_sync::ConflictResolution::Dismissed
    );
    let before: Vec<u8> = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
      .load_full_doc(workspace_id, doc_id)
      .await
      .unwrap();
    assert!(
      myoxus_api::git_sync_engine::conflicts::resolve_document_conflict(
        &store,
        &original,
        &profile,
        myoxus_domain::git_sync::ConflictResolution::GitWins,
        None,
        admin_id
      )
      .await
      .is_err(),
      "a stale Open clone is no longer authority to replace content"
    );
    let after = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
      .load_full_doc(workspace_id, doc_id)
      .await
      .unwrap();
    assert_eq!(after, before, "superseded resolution must fail before a document write");
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[async_trait]
impl GitRepositoryPort for HarnessGitRepo {
  async fn probe_remote(
    &self,
    _url: &str,
    branch: Option<&str>,
    _auth: &GitAuth,
  ) -> Result<myoxus_application::git_sync::GitRemoteProbe, GitError> {
    Ok(myoxus_application::git_sync::GitRemoteProbe {
      branch: branch.map(str::to_string),
      observed_remote_oid: branch.map(|_| self.remote_oid.lock().expect("remote oid lock").clone()),
    })
  }

  async fn clone_repo(&self, url: &str, path: &Path, branch: &str, _auth: &GitAuth) -> Result<(), GitError> {
    *self.clone_count.lock().expect("clone count lock") += 1;
    let mut failures = self.clone_failures_remaining.lock().expect("clone failure lock");
    if *failures > 0 {
      *failures -= 1;
      return Err(GitError::Network("injected transient clone failure".to_string()));
    }
    drop(failures);
    self.materialize(path)?;
    *self.repo_path.lock().expect("repo path lock") = Some(path.to_path_buf());
    *self.origin_url.lock().expect("origin URL lock") = Some(url.to_string());
    *self.branch.lock().expect("branch lock") = Some(branch.to_string());
    Ok(())
  }

  async fn open_repo(&self, path: &Path) -> Result<(), GitError> {
    if !path.exists() {
      return Err(GitError::NotFound(path.display().to_string()));
    }
    *self.repo_path.lock().expect("repo path lock") = Some(path.to_path_buf());
    Ok(())
  }

  async fn repository_identity(&self) -> Result<GitRepositoryIdentity, GitError> {
    let repo_path = self
      .repo_path
      .lock()
      .expect("repo path lock")
      .clone()
      .ok_or_else(|| GitError::Repository("repo not opened".to_string()))?;
    Ok(GitRepositoryIdentity {
      workdir: std::fs::canonicalize(repo_path)?,
      origin_url: self
        .origin_url
        .lock()
        .expect("origin URL lock")
        .clone()
        .ok_or_else(|| GitError::Repository("origin not configured".to_string()))?,
      head_branch: self
        .branch
        .lock()
        .expect("branch lock")
        .clone()
        .ok_or_else(|| GitError::Repository("branch not configured".to_string()))?,
      head_oid: self.local_oid.lock().expect("local oid lock").clone(),
      head_tree_oid: "fixture-tree".to_string(),
    })
  }

  async fn fetch(&self, _auth: &GitAuth) -> Result<(), GitError> {
    *self.fetch_count.lock().expect("fetch count lock") += 1;
    if let Some(error) = self.fetch_failures.lock().expect("fetch failure lock").pop_front() {
      return Err(error);
    }
    self
      .repo_path
      .lock()
      .expect("repo path lock")
      .clone()
      .ok_or_else(|| GitError::Repository("repo not opened".to_string()))?;
    Ok(())
  }

  async fn checkout_branch(&self, _branch: &str) -> Result<(), GitError> {
    Ok(())
  }

  async fn reset_to_remote(&self, _branch: &str) -> Result<String, GitError> {
    let repo_path = self
      .repo_path
      .lock()
      .expect("repo path lock")
      .clone()
      .ok_or_else(|| GitError::Repository("repo not opened".to_string()))?;
    self.materialize(&repo_path)?;
    self.head_oid().await
  }

  async fn stash_if_dirty(&self) -> Result<bool, GitError> {
    let repo_path = self
      .repo_path
      .lock()
      .expect("repo path lock")
      .clone()
      .ok_or_else(|| GitError::Repository("repo not opened".to_string()))?;
    myoxus_infrastructure::git_sync::stash_if_dirty(&repo_path)
  }

  async fn drop_all_stashes(&self) -> Result<(), GitError> {
    let repo_path = self
      .repo_path
      .lock()
      .expect("repo path lock")
      .clone()
      .ok_or_else(|| GitError::Repository("repo not opened".to_string()))?;
    myoxus_infrastructure::git_sync::drop_all_stashes(&repo_path);
    Ok(())
  }

  async fn head_oid(&self) -> Result<String, GitError> {
    Ok(self.local_oid.lock().expect("local oid lock").clone())
  }

  async fn remote_branch_oid(&self, _branch: &str, _auth: &GitAuth) -> Result<String, GitError> {
    *self.source_probe_count.lock().expect("source probe count lock") += 1;
    if let Some(error) = self
      .source_probe_failures
      .lock()
      .expect("source probe failure lock")
      .pop_front()
    {
      return Err(error);
    }
    Ok(self.remote_oid.lock().expect("remote oid lock").clone())
  }

  async fn changed_files(&self, _from: Option<&str>, _to: Option<&str>) -> Result<Vec<ChangedFile>, GitError> {
    let remote = self.files.lock().expect("files lock").clone();
    let working = self.working_files()?;
    let mut paths = remote.keys().chain(working.keys()).cloned().collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    Ok(
      paths
        .into_iter()
        .filter_map(|path| match (remote.get(&path), working.get(&path)) {
          (None, Some(_)) => Some(ChangedFile {
            path,
            change_type: myoxus_application::git_sync::backend::ChangeType::Added,
            old_path: None,
          }),
          (Some(_), None) => Some(ChangedFile {
            path,
            change_type: myoxus_application::git_sync::backend::ChangeType::Deleted,
            old_path: None,
          }),
          (Some(remote), Some(working)) if remote != working => Some(ChangedFile {
            path,
            change_type: myoxus_application::git_sync::backend::ChangeType::Modified,
            old_path: None,
          }),
          _ => None,
        })
        .collect(),
    )
  }

  async fn read_file(&self, path: &str) -> Result<Vec<u8>, GitError> {
    let repo_path = self
      .repo_path
      .lock()
      .expect("repo path lock")
      .clone()
      .ok_or_else(|| GitError::Repository("repo not opened".to_string()))?;
    let full_path = repo_path.join(path);
    std::fs::read(&full_path).map_err(|error| {
      if error.kind() == std::io::ErrorKind::NotFound {
        GitError::NotFound(full_path.display().to_string())
      } else {
        GitError::Internal(format!("read failed: {error}"))
      }
    })
  }

  async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), GitError> {
    if let Some(repo_path) = self.repo_path.lock().expect("repo path lock").clone() {
      let full = repo_path.join(path);
      if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
      }
      std::fs::write(full, content)?;
    }
    Ok(())
  }

  async fn delete_file(&self, path: &str) -> Result<(), GitError> {
    if let Some(repo_path) = self.repo_path.lock().expect("repo path lock").clone() {
      let _ = std::fs::remove_file(repo_path.join(path));
    }
    Ok(())
  }

  async fn rename_file(&self, from: &str, to: &str) -> Result<(), GitError> {
    let repo_path = self
      .repo_path
      .lock()
      .expect("repo path lock")
      .clone()
      .ok_or_else(|| GitError::Repository("repo not opened".to_string()))?;
    let source = repo_path.join(from);
    let target = repo_path.join(to);
    if let Some(parent) = target.parent() {
      std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(source, target)?;
    Ok(())
  }

  async fn commit(&self, _message: &str, _author_name: &str, _author_email: &str) -> Result<String, GitError> {
    let mut counter = self.commit_counter.lock().expect("commit counter lock");
    *counter += 1;
    let oid = format!("c{:039x}", *counter);
    *self.local_oid.lock().expect("local oid lock") = oid.clone();
    Ok(oid)
  }

  async fn push(&self, branch: &str, intended_oid: &str, _auth: &GitAuth) -> Result<GitPushReceipt, GitError> {
    let mut moved_failures = self
      .push_moves_then_errors_remaining
      .lock()
      .expect("push move-then-error lock");
    if *moved_failures > 0 {
      *moved_failures -= 1;
      *self.files.lock().expect("files lock") = self.working_files()?;
      *self.remote_oid.lock().expect("remote oid lock") = intended_oid.to_string();
      return Err(GitError::Network(
        "injected transport error after remote update".to_string(),
      ));
    }
    drop(moved_failures);
    let mut failures = self.push_failures_remaining.lock().expect("push failure lock");
    if *failures > 0 {
      *failures -= 1;
      return Err(GitError::Network("injected push rejection".to_string()));
    }
    drop(failures);
    *self.files.lock().expect("files lock") = self.working_files()?;
    *self.remote_oid.lock().expect("remote oid lock") = intended_oid.to_string();
    Ok(GitPushReceipt {
      branch: branch.to_string(),
      local_commit_oid: intended_oid.to_string(),
      remote_ref_status: GitRemoteRefStatus::Updated,
      observed_remote_oid: intended_oid.to_string(),
    })
  }
}

#[derive(Clone, Default)]
struct MemoryBlobStorage {
  blobs: Arc<Mutex<HashMap<String, Bytes>>>,
  deleted: Arc<Mutex<Vec<String>>>,
  write_failures_remaining: Arc<Mutex<u32>>,
}

impl MemoryBlobStorage {
  fn put(&self, key: &str, bytes: &[u8]) {
    self
      .blobs
      .lock()
      .expect("blob lock")
      .insert(key.to_string(), Bytes::copy_from_slice(bytes));
  }

  fn contains(&self, key: &str) -> bool {
    self.blobs.lock().expect("blob lock").contains_key(key)
  }

  fn deleted_keys(&self) -> Vec<String> {
    self.deleted.lock().expect("deleted lock").clone()
  }

  fn fail_next_writes(self, count: u32) -> Self {
    *self.write_failures_remaining.lock().expect("write failures lock") = count;
    self
  }

  fn is_empty(&self) -> bool {
    self.blobs.lock().expect("blob lock").is_empty()
  }
}

#[async_trait]
impl BlobStoragePort for MemoryBlobStorage {
  async fn write_blob(&self, req: BlobWriteRequest) -> PortResult<()> {
    let mut failures = self.write_failures_remaining.lock().expect("write failures lock");
    if *failures > 0 {
      *failures -= 1;
      return Err(PortError::Transport(format!(
        "injected blob write failure for {}",
        req.key
      )));
    }
    drop(failures);
    self.blobs.lock().expect("blob lock").insert(req.key, req.body);
    Ok(())
  }

  async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
    let data = self
      .blobs
      .lock()
      .expect("blob lock")
      .get(key)
      .cloned()
      .ok_or_else(|| PortError::NotFound(key.to_string()))?;
    Ok(BlobReadResponse {
      key: key.to_string(),
      content_type: Some("image/png".to_string()),
      data: data.clone(),
      last_modified: None,
      content_length: data.len() as u64,
    })
  }

  async fn delete_blob(&self, key: &str) -> PortResult<()> {
    self.blobs.lock().expect("blob lock").remove(key);
    self.deleted.lock().expect("deleted lock").push(key.to_string());
    Ok(())
  }

  async fn put_avatar(&self, _key: &str, _data: Bytes, _content_type: &str) -> PortResult<String> {
    Err(PortError::InvalidInput(
      "avatar storage is not part of this test".into(),
    ))
  }

  async fn get_avatar(&self, key: &str) -> PortResult<BlobReadResponse> {
    self.read_blob(key).await
  }

  async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
    Ok(())
  }

  async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
    Err(PortError::InvalidInput(
      "multipart upload is not part of this test".into(),
    ))
  }

  async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
    Err(PortError::InvalidInput(
      "multipart upload is not part of this test".into(),
    ))
  }

  async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
    Err(PortError::InvalidInput(
      "multipart upload is not part of this test".into(),
    ))
  }

  async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
    Ok(())
  }
}

fn pending_run(profile: &GitSyncProfile) -> GitSyncRun {
  let id = Uuid::new_v4();
  GitSyncRun {
    id,
    profile_id: profile.id,
    direction: profile.sync_direction,
    trigger_source: GitSyncRunSource::Manual,
    scheduled_for: None,
    status: RunStatus::Pending,
    started_at: Utc::now(),
    finished_at: None,
    commit_before: None,
    commit_after: None,
    observed_remote_oid: None,
    reconciliation_required: false,
    reconciliation_reason: None,
    docs_created: 0,
    docs_updated: 0,
    docs_deleted: 0,
    conflicts_found: 0,
    error_message: None,
    error_class: None,
    job_id: Some(format!("git-sync-{id}")),
  }
}

async fn create_run(store: &SqlxGitSyncStore, profile: &GitSyncProfile) -> Uuid {
  store
    .create_run(&pending_run(profile))
    .await
    .expect("create sync run")
    .id
}

async fn seed_myoxus_doc(pool: &sqlx::PgPool, workspace_id: Uuid, actor_id: Uuid, title: &str, markdown: &str) -> Uuid {
  let doc_id = Uuid::new_v4();
  let payload = markdown_to_yjs(title, markdown).expect("markdown to yjs");
  sqlx::query(
    r#"
    INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)
    VALUES ($1, $2, $3, 'viewer', false, $4, $4)
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(title)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("insert myoxus doc");
  sqlx::query(
    r#"
    INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
    VALUES ($1, $2, $3, 1, now())
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(payload)
  .execute(pool)
  .await
  .expect("insert myoxus doc snapshot");
  doc_id
}

async fn seed_doc_metadata_only(pool: &sqlx::PgPool, workspace_id: Uuid, actor_id: Uuid, title: &str) -> Uuid {
  let doc_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)
    VALUES ($1, $2, $3, 'viewer', false, $4, $4)
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(title)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("insert document metadata");
  doc_id
}

async fn update_myoxus_doc(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid, title: &str, markdown: &str) {
  let payload = markdown_to_yjs(title, markdown).expect("markdown to yjs");
  sqlx::query(
    r#"
    UPDATE docs SET title = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(title)
  .execute(pool)
  .await
  .expect("update doc title");
  sqlx::query(
    r#"
    INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
    VALUES ($1, $2, $3, 2, now())
    ON CONFLICT (doc_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          last_sequence = doc_snapshots.last_sequence + 1,
          updated_at = now()
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(payload)
  .execute(pool)
  .await
  .expect("update myoxus doc snapshot");
}

async fn update_myoxus_payload(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid, payload: Vec<u8>) {
  sqlx::query("UPDATE docs SET updated_at = now() WHERE workspace_id = $1 AND id = $2")
    .bind(workspace_id)
    .bind(doc_id)
    .execute(pool)
    .await
    .expect("update native Myoxus document timestamp");
  sqlx::query(
    "UPDATE doc_snapshots
     SET payload = $3, last_sequence = last_sequence + 1, updated_at = now()
     WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(payload)
  .execute(pool)
  .await
  .expect("update native Myoxus payload");
}

async fn document_sync_hash_state(pool: &sqlx::PgPool, profile_id: Uuid) -> Vec<(Uuid, String, String)> {
  sqlx::query_as(
    "SELECT b.doc_id, b.content_hash, bl.content_hash
     FROM git_sync_bindings b
     JOIN git_sync_baselines bl ON bl.binding_id = b.id
     WHERE b.profile_id = $1 AND b.tombstone = false
     ORDER BY b.doc_id",
  )
  .bind(profile_id)
  .fetch_all(pool)
  .await
  .expect("document binding and baseline hashes")
}

async fn soft_delete_doc(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid) {
  sqlx::query("UPDATE docs SET deleted_at = now(), updated_at = now() WHERE id = $1 AND workspace_id = $2")
    .bind(doc_id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("soft delete doc");
}

async fn doc_markdown(pool: &sqlx::PgPool, doc_id: Uuid) -> String {
  let payload: Vec<u8> = sqlx::query_scalar("SELECT payload FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(pool)
    .await
    .expect("doc snapshot payload");
  yjs_to_markdown(&payload)
    .expect("yjs to markdown")
    .expect("markdown content")
    .markdown
}

async fn active_doc_binding(pool: &sqlx::PgPool, profile_id: Uuid) -> (Uuid, Uuid, Uuid, String) {
  sqlx::query_as(
    "SELECT id, doc_id, sync_id, repo_path FROM git_sync_bindings WHERE profile_id = $1 AND tombstone = false",
  )
  .bind(profile_id)
  .fetch_one(pool)
  .await
  .expect("active doc binding")
}

fn file_hash(bytes: &[u8]) -> String {
  use sha2::{Digest, Sha256};

  let mut hasher = Sha256::new();
  hasher.update(bytes);
  format!("{:x}", hasher.finalize())
}

async fn seed_file_binding(
  pool: &sqlx::PgPool,
  profile: &GitSyncProfile,
  blob_key: &str,
  repo_path: &str,
  bytes: &[u8],
  tombstoned: bool,
) -> Uuid {
  let binding_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO git_sync_file_bindings
      (id, profile_id, workspace_id, blob_key, repo_path, content_hash, mime_type, file_size, tombstoned)
    VALUES ($1, $2, $3, $4, $5, $6, 'image/png', $7, $8)
    "#,
  )
  .bind(binding_id)
  .bind(profile.id)
  .bind(profile.workspace_id)
  .bind(blob_key)
  .bind(repo_path)
  .bind(file_hash(bytes))
  .bind(bytes.len() as i64)
  .bind(tombstoned)
  .execute(pool)
  .await
  .expect("seed file binding");
  binding_id
}

async fn seed_file_baseline(pool: &sqlx::PgPool, profile: &GitSyncProfile, blob_key: &str, bytes: &[u8]) {
  sqlx::query(
    r#"
    INSERT INTO git_sync_file_baselines (profile_id, blob_key, content_hash, commit_oid)
    VALUES ($1, $2, $3, '1111111111111111111111111111111111111111')
    ON CONFLICT (profile_id, blob_key)
      DO UPDATE SET content_hash = EXCLUDED.content_hash, commit_oid = EXCLUDED.commit_oid, synced_at = now()
    "#,
  )
  .bind(profile.id)
  .bind(blob_key)
  .bind(file_hash(bytes))
  .execute(pool)
  .await
  .expect("seed file baseline");
}

async fn upsert_app_config(pool: &sqlx::PgPool, id: &str, value: serde_json::Value) {
  sqlx::query(
    r#"
    INSERT INTO app_configs (id, value)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    "#,
  )
  .bind(id)
  .bind(value)
  .execute(pool)
  .await
  .expect("upsert app config");
}

async fn cleanup_git_sync_policy(pool: &sqlx::PgPool) {
  sqlx::query("DELETE FROM app_configs WHERE id LIKE 'git_sync.%'")
    .execute(pool)
    .await
    .ok();
}

async fn create_test_profile(
  pool: &sqlx::PgPool,
  store: &SqlxGitSyncStore,
  app_config: &AppConfig,
  workspace_id: Uuid,
  owner_id: Uuid,
  repo_url: &str,
  max_mirror_storage_mb: Option<i64>,
) -> GitSyncProfile {
  let has_root: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1 AND workspace_id=$1 AND is_workspace_root)")
      .bind(workspace_id)
      .fetch_one(pool)
      .await
      .unwrap();
  if !has_root {
    helpers::create_workspace_root_doc(pool, workspace_id, owner_id).await;
  }
  let profile = GitSyncProfile {
    id: Uuid::new_v4(),
    workspace_id,
    owner_id,
    repo_url: repo_url.to_string(),
    branch: "main".to_string(),
    root_path: "content/".to_string(),
    manifest_path: export::GIT_SYNC_MANIFEST_PATH.to_string(),
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
    max_mirror_storage_mb,
    created_at: Utc::now(),
    updated_at: Utc::now(),
  };
  let encrypted = crypto::encrypt(
    &app_config.crypto.private_key,
    json!({ "username": "runner-test", "token": "test-token" })
      .to_string()
      .as_bytes(),
  )
  .expect("encrypt git credential");
  store
    .upsert_profile_with_credential(&profile, "runner-test", &encrypted)
    .await
    .expect("profile with credential")
}

#[tokio::test]
async fn history_capture_run_exports_current_content_without_importing_remote_only_document() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let mut profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/history-capture.git",
    None,
  )
  .await;
  sqlx::query("UPDATE git_sync_profiles SET trigger_mode='HistoryCapture' WHERE id=$1")
    .bind(profile.id)
    .execute(&pool)
    .await
    .expect("enable history capture trigger");
  profile.trigger_mode = TriggerMode::HistoryCapture;

  let doc_id = seed_myoxus_doc(
    &pool,
    workspace_id,
    admin_id,
    "Current local",
    "# Current local\n\nInitial content.",
  )
  .await;
  update_myoxus_doc(
    &pool,
    workspace_id,
    doc_id,
    "Current local",
    "# Current local\n\nRecent uncompacted edit.",
  )
  .await;
  let remote_only_path = "content/remote-only.md";
  let remote_only = b"# Remote only\n\nThis must not be imported by the automatic run.\n";
  let git_repo = HarnessGitRepo::with_file(remote_only_path, remote_only);
  let repo_dir = TempDir::new().expect("repo tempdir");
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };
  let locks = locking::new_locks();
  let blob_storage = MemoryBlobStorage::default();

  let mut capture_run = pending_run(&profile);
  capture_run.direction = SyncDirection::MyoxusToGit;
  capture_run.trigger_source = GitSyncRunSource::HistoryCapture;
  let capture_run_id = store.create_run(&capture_run).await.unwrap().id;
  let capture_result = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    capture_run_id,
  )
  .await
  .expect("history capture run");

  assert_eq!(capture_result["status"], "Completed");
  assert_eq!(capture_result["docsCreated"], 1);
  assert_eq!(
    git_repo.remote_bytes(remote_only_path).as_deref(),
    Some(remote_only.as_slice())
  );
  let (_, _, _, exported_path) = active_doc_binding(&pool, profile.id).await;
  assert!(
    git_repo
      .remote_text(&exported_path)
      .expect("current document export")
      .contains("Recent uncompacted edit."),
    "the automatic run must export authoritative current workspace content"
  );
  let docs_after_capture: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::bigint FROM docs WHERE workspace_id=$1 AND deleted_at IS NULL AND NOT is_workspace_root",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(
    docs_after_capture, 1,
    "outgoing capture run must not import remote content"
  );
  let history_after_capture: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM doc_histories WHERE workspace_id=$1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(
    history_after_capture, 0,
    "Git export must not create another saved version"
  );

  let commits_before_noop = git_repo.commit_count();
  let mut noop_capture = pending_run(&profile);
  noop_capture.direction = SyncDirection::MyoxusToGit;
  noop_capture.trigger_source = GitSyncRunSource::HistoryCapture;
  let noop_id = store.create_run(&noop_capture).await.unwrap().id;
  run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    noop_id,
  )
  .await
  .expect("no-change history capture run");
  assert_eq!(
    git_repo.commit_count(),
    commits_before_noop,
    "a no-change follow-up must settle without a capture/sync feedback loop"
  );

  let manual_id = create_run(&store, &profile).await;
  let manual = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    manual_id,
  )
  .await
  .expect("manual bidirectional run");
  assert_eq!(
    manual["docsCreated"], 1,
    "manual run must retain bidirectional import behavior"
  );
  let docs_after_manual: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::bigint FROM docs WHERE workspace_id=$1 AND deleted_at IS NULL AND NOT is_workspace_root",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(docs_after_manual, 2);

  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn blob_preparation_failure_cannot_publish_prepared_document_or_persistence_state() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::with_files(&[
    (REPO_PATH, PNG_BYTES),
    (
      "content/footnote-parent.md",
      b"# Incoming parent\n\nReference[^body]\n\n[^body]: ![normal image](assets/check.png)\n",
    ),
  ]);
  let remote_oid_before = git_repo.remote_oid();
  let blob_storage = MemoryBlobStorage::default().fail_next_writes(1);
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/pre-push-blob-failure.git",
    None,
  )
  .await;
  seed_myoxus_doc(
    &pool,
    workspace_id,
    admin_id,
    "Prepared but unpublished",
    "# Prepared but unpublished\n\nThis must never reach Git.",
  )
  .await;
  let run_id = create_run(&store, &profile).await;

  let error = run_sync_with_git_repo(
    &pool,
    &RunnerConfig {
      overview_service: overview_state.workspace_overview_service(),
      repo_base_dir: repo_dir.path().join("repos"),
      crypto_key: app_config.crypto.private_key.clone(),
      min_free_disk_mb: 0,
      max_mirror_storage_mb: 0,
      mime_allowlist_admin: vec!["image/png".to_string()],
      mime_validation_mode: "strict".to_string(),
      ..RunnerConfig::default()
    },
    &locking::new_locks(),
    &blob_storage,
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect_err("injected blob preparation failure must fail before remote mutation");

  assert!(
    !error.is_retryable(),
    "deterministic blob preparation failure is permanent"
  );
  assert_eq!(git_repo.commit_count(), 0, "blob preparation must precede local commit");
  assert_eq!(
    git_repo.remote_oid(),
    remote_oid_before,
    "blob preparation failure must leave the authenticated remote OID unchanged"
  );
  assert_eq!(
    git_repo.remote_bytes(REPO_PATH).as_deref(),
    Some(PNG_BYTES),
    "the original remote file must remain untouched"
  );
  assert!(
    git_repo.remote_text(export::GIT_SYNC_MANIFEST_PATH).is_none(),
    "the prepared manifest must not be published"
  );

  let (document_bindings, file_bindings, document_baselines, file_baselines, promotions): (i64, i64, i64, i64, i64) =
    sqlx::query_as(
      r#"
    SELECT
      (SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE profile_id = $1),
      (SELECT COUNT(*)::bigint FROM git_sync_file_bindings WHERE profile_id = $1),
      (SELECT COUNT(*)::bigint
       FROM git_sync_baselines baseline
       JOIN git_sync_bindings binding ON binding.id = baseline.binding_id
       WHERE binding.profile_id = $1),
      (SELECT COUNT(*)::bigint FROM git_sync_file_baselines WHERE profile_id = $1),
      (SELECT COUNT(*)::bigint FROM git_sync_blob_promotions WHERE run_id = $2)
    "#,
    )
    .bind(profile.id)
    .bind(run_id)
    .fetch_one(&pool)
    .await
    .expect("normal persistence state after pre-push failure");
  assert_eq!(
    (
      document_bindings,
      file_bindings,
      document_baselines,
      file_baselines,
      promotions
    ),
    (0, 0, 0, 0, 0),
    "pre-push failure must leave no normal binding, baseline, or promotion state"
  );
  assert!(
    blob_storage.is_empty(),
    "failed preparation must leave no staged or promoted blob"
  );
  assert!(
    blob_storage
      .deleted_keys()
      .iter()
      .any(|key| key.starts_with("git-sync-staging/")),
    "the failed stage must be explicitly cleaned"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_file_pull_nochange_and_delete_use_the_same_content_addressed_blob_key() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::with_files(&[(REPO_PATH, PNG_BYTES), ("content/.gitkeep", b"")]);
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();

  let profile = GitSyncProfile {
    id: Uuid::new_v4(),
    workspace_id,
    owner_id: admin_id,
    repo_url: "https://example.test/myoxus/git-sync-runner.git".to_string(),
    branch: "main".to_string(),
    root_path: "content/".to_string(),
    manifest_path: export::GIT_SYNC_MANIFEST_PATH.to_string(),
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
  };
  let encrypted = crypto::encrypt(
    &app_config.crypto.private_key,
    json!({ "username": "runner-test", "token": "test-token" })
      .to_string()
      .as_bytes(),
  )
  .expect("encrypt git credential");
  let profile = store
    .upsert_profile_with_credential(&profile, "runner-test", &encrypted)
    .await
    .expect("profile with credential");

  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_allowlist_admin: vec!["image/png".to_string()],
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };
  let expected_blob_key = blob_key_for_content(profile.id, &file_hash(PNG_BYTES));

  let first_run_id = create_run(&store, &profile).await;
  let first = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    first_run_id,
  )
  .await
  .expect("first file pull run");
  assert_eq!(first["status"], "Completed");
  assert_eq!(first["filesPulled"], 1);
  assert_eq!(first["fileExecPulled"], 1);
  assert_eq!(
    first["versionLinksCreated"], 1,
    "a successful file pull must create one provenance link"
  );

  let bindings: Vec<(String, String, bool)> = sqlx::query_as(
    "SELECT repo_path, blob_key, tombstoned
     FROM git_sync_file_bindings
     WHERE profile_id = $1
     ORDER BY repo_path",
  )
  .bind(profile.id)
  .fetch_all(&pool)
  .await
  .expect("file bindings");
  assert_eq!(
    bindings.len(),
    1,
    "first pull run must persist exactly one file binding, got {bindings:?}"
  );
  let (actual_repo_path, binding_key, tombstoned) = &bindings[0];
  assert_eq!(actual_repo_path, REPO_PATH);
  assert!(!tombstoned, "newly pulled binding must be active");
  assert_eq!(binding_key, &expected_blob_key);
  let baseline_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_file_baselines WHERE profile_id = $1 AND blob_key = $2")
      .bind(profile.id)
      .bind(&expected_blob_key)
      .fetch_one(&pool)
      .await
      .expect("baseline count");
  assert_eq!(baseline_count, 1, "baseline must use the same blob_key as binding");
  assert!(
    blob_storage.contains(&format!("{workspace_id}/{expected_blob_key}")),
    "pulled blob must be readable through normal workspace blob storage"
  );
  let blobs = myoxus_application::ports::blob_service::BlobService::new(
    Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone())),
    Arc::new(blob_storage.clone()),
    "fixture-key".into(),
  );
  assert_eq!(
    blobs
      .get_blob(workspace_id, &expected_blob_key)
      .await
      .expect("normal BlobService read")
      .data
      .as_ref(),
    PNG_BYTES
  );
  let first_links: Vec<(String, String, Option<String>, String, Option<String>)> = sqlx::query_as(
    "SELECT sync_object_kind, sync_object_id, git_commit_oid, repo_path, content_hash
     FROM git_sync_version_links
     WHERE run_id = $1
     ORDER BY created_at ASC",
  )
  .bind(first_run_id)
  .fetch_all(&pool)
  .await
  .expect("first run version links");
  assert_eq!(first_links.len(), 1, "file pull must have one version link");
  assert_eq!(first_links[0].0, "file");
  assert_eq!(
    first_links[0].1, REPO_PATH,
    "file pull links use repo_path as sync object id because no blob existed before pull"
  );
  assert_eq!(
    first_links[0].2,
    first["commitOid"].as_str().map(str::to_string),
    "file provenance must carry the remote revision verified at finalization"
  );
  assert_eq!(first_links[0].3, REPO_PATH);
  let pulled_hash = first_links[0].4.as_deref().expect("file version link content hash");
  assert_eq!(pulled_hash.len(), 64, "file version link must carry SHA-256 hex");
  assert!(
    pulled_hash.chars().all(|c| c.is_ascii_hexdigit()),
    "file version link hash must be hex"
  );

  let second_run_id = create_run(&store, &profile).await;
  let second = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    second_run_id,
  )
  .await
  .expect("second no-change run");
  assert_eq!(second["status"], "Completed");
  assert_eq!(second["filesPulled"], 0, "unchanged file must not be pulled again");
  assert_eq!(
    second["fileExecPulled"], 0,
    "unchanged file must not rewrite blob storage"
  );
  assert_eq!(
    second["versionLinksCreated"], 0,
    "no-change run must not create provenance noise"
  );

  let active_bindings: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::bigint FROM git_sync_file_bindings WHERE profile_id = $1 AND repo_path = $2 AND tombstoned = false",
  )
  .bind(profile.id)
  .bind(REPO_PATH)
  .fetch_one(&pool)
  .await
  .expect("active binding count");
  assert_eq!(active_bindings, 1, "no-change run must not duplicate bindings");

  git_repo.remove_remote_file(REPO_PATH);
  let third_run_id = create_run(&store, &profile).await;
  let third = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    third_run_id,
  )
  .await
  .expect("delete-from-myoxus run");
  assert_eq!(third["status"], "Completed");
  assert_eq!(third["filesDeleted"], 1);
  assert!(
    blob_storage.contains(&format!("{workspace_id}/{expected_blob_key}")),
    "runner finalization must retain content-addressed bytes for reference-aware GC"
  );

  let active_after_delete: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::bigint FROM git_sync_file_bindings WHERE profile_id = $1 AND tombstoned = false",
  )
  .bind(profile.id)
  .fetch_one(&pool)
  .await
  .expect("active binding count after delete");
  let baselines_after_delete: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_file_baselines WHERE profile_id = $1")
      .bind(profile.id)
      .fetch_one(&pool)
      .await
      .expect("baseline count after delete");
  assert_eq!(active_after_delete, 0, "delete run must tombstone the file binding");
  assert_eq!(baselines_after_delete, 0, "delete run must remove the file baseline");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_pushes_and_deletes_myoxus_file_bindings_to_git() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default();
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/file-push.git",
    None,
  )
  .await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_allowlist_admin: vec!["image/png".to_string()],
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };

  const PUSH_PATH: &str = "content/assets/from-myoxus.png";
  let blob_key = "from-myoxus";
  let storage_key = myoxus_application::ports::blob::BlobKey::parse(blob_key)
    .unwrap()
    .storage_key(workspace_id);
  blob_storage.put(&storage_key, PNG_BYTES);
  sqlx::query("INSERT INTO blobs (workspace_id,key,size,mime,status) VALUES ($1,$2,$3,'image/png','completed')")
    .bind(workspace_id)
    .bind(blob_key)
    .bind(PNG_BYTES.len() as i64)
    .execute(&pool)
    .await
    .unwrap();
  let doc_id = seed_myoxus_doc(&pool, workspace_id, admin_id, "Image", "").await;
  let mut body = yjs::YjsDocumentBuilder::new("Image");
  body.push_image(blob_key, "Editor image");
  sqlx::query("UPDATE doc_snapshots SET payload=$3, last_sequence=last_sequence+1, updated_at=now() WHERE workspace_id=$1 AND doc_id=$2")
    .bind(workspace_id).bind(doc_id).bind(body.encode()).execute(&pool).await.unwrap();

  let first_run_id = create_run(&store, &profile).await;
  let first = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    first_run_id,
  )
  .await
  .expect("file push run");
  assert_eq!(first["status"], "Completed");
  assert_eq!(first["filesPushed"], 1);
  assert_eq!(first["fileExecPushed"], 1);
  assert_eq!(
    git_repo.remote_bytes(PUSH_PATH).as_deref(),
    Some(PNG_BYTES),
    "PushToGit must write the Myoxus blob bytes to the Git working tree"
  );
  let baseline_exists: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_file_baselines WHERE profile_id = $1 AND blob_key = $2)")
      .bind(profile.id)
      .bind(blob_key)
      .fetch_one(&pool)
      .await
      .expect("file baseline exists");
  assert!(
    baseline_exists,
    "file push must persist a baseline for later delete/conflict decisions"
  );

  sqlx::query("UPDATE git_sync_file_bindings SET tombstoned = true, updated_at = now() WHERE profile_id = $1")
    .bind(profile.id)
    .execute(&pool)
    .await
    .expect("tombstone myoxus file binding");
  let second_run_id = create_run(&store, &profile).await;
  let second = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    second_run_id,
  )
  .await
  .expect("file delete-from-git run");
  assert_eq!(second["status"], "Completed");
  assert_eq!(second["filesDeleted"], 1);
  assert_eq!(second["fileExecDeletedGit"], 1);
  assert!(
    git_repo.remote_bytes(PUSH_PATH).is_none(),
    "tombstoned Myoxus file binding must delete the Git file"
  );
  let baseline_after_delete: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_file_baselines WHERE profile_id = $1 AND blob_key = $2)")
      .bind(profile.id)
      .bind(blob_key)
      .fetch_one(&pool)
      .await
      .expect("file baseline after delete");
  assert!(
    !baseline_after_delete,
    "file delete must remove the stale file baseline"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_denies_blocked_git_file_without_binding_or_blob_write() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::with_file("content/assets/malware.exe", b"MZ\x00blocked");
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/file-mime.git",
    None,
  )
  .await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_allowlist_admin: vec!["image/png".to_string()],
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };

  let run_id = create_run(&store, &profile).await;
  let result = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect("mime denied file run");
  assert_eq!(result["status"], "Completed");
  assert_eq!(result["filesDenied"], 1);
  assert_eq!(result["filesPulled"], 0);
  assert_eq!(result["fileExecPulled"], 0);
  let bindings: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_file_bindings WHERE profile_id = $1")
    .bind(profile.id)
    .fetch_one(&pool)
    .await
    .expect("file binding count");
  assert_eq!(bindings, 0, "MIME-denied files must not create file bindings");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_persists_file_conflict_when_git_and_myoxus_blob_changed() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::with_file("content/assets/conflict.png", b"\x89PNG\r\n\x1a\ngit-side");
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/file-conflict.git",
    None,
  )
  .await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_allowlist_admin: vec!["image/png".to_string()],
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };

  let blob_key = "workspace-files/conflict.png";
  let baseline_bytes = b"\x89PNG\r\n\x1a\nbaseline";
  let myoxus_bytes = b"\x89PNG\r\n\x1a\nmyoxus-side";
  blob_storage.put(blob_key, myoxus_bytes);
  seed_file_binding(
    &pool,
    &profile,
    blob_key,
    "content/assets/conflict.png",
    myoxus_bytes,
    false,
  )
  .await;
  seed_file_baseline(&pool, &profile, blob_key, baseline_bytes).await;

  let run_id = create_run(&store, &profile).await;
  let result = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect("file conflict run");
  assert_eq!(result["status"], "Completed");
  assert_eq!(result["filesConflicted"], 1);
  assert_eq!(result["fileExecErrors"], 0);
  let conflict: (String, String, String) = sqlx::query_as(
    "SELECT git_hash, myoxus_hash, baseline_hash FROM git_sync_file_conflicts WHERE profile_id = $1 AND repo_path = 'content/assets/conflict.png'",
  )
  .bind(profile.id)
  .fetch_one(&pool)
  .await
  .expect("file conflict row");
  assert_eq!(conflict.0, file_hash(b"\x89PNG\r\n\x1a\ngit-side"));
  assert_eq!(conflict.1, file_hash(myoxus_bytes));
  assert_eq!(conflict.2, file_hash(baseline_bytes));

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_rechecks_current_policy_before_git_io() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  cleanup_git_sync_policy(&pool).await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default();
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();

  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/policy-runner.git",
    None,
  )
  .await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    static_policy: app_config.git_sync.clone(),
    config_overrides: Arc::new(tokio::sync::RwLock::new(
      myoxus_api::config_reload::ConfigOverrides::new(HashMap::from([
        ("git_sync.enabled".to_string(), json!(true)),
        ("git_sync.allowed_hosts".to_string(), json!(["blocked.example.test"])),
      ])),
    )),
    crypto_key: app_config.crypto.private_key.clone(),
    max_mirror_storage_mb: 0,
    min_free_disk_mb: 0,
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };
  let run_id = create_run(&store, &profile).await;
  let err = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect_err("disallowed host must block runner");

  assert!(
    err.to_string().contains("administrator policy"),
    "runner error must explain policy block: {err}"
  );
  assert_eq!(git_repo.clone_count(), 0, "policy block must happen before clone/fetch");
  let run: (String, Option<String>, Option<String>) =
    sqlx::query_as("SELECT status, error_message, error_class FROM git_sync_runs WHERE id = $1")
      .bind(run_id)
      .fetch_one(&pool)
      .await
      .expect("run row");
  assert_eq!(run.0, "Failed");
  assert!(
    run.1.unwrap_or_default().contains("repository host is not allowed"),
    "run error must preserve policy reason"
  );
  assert_eq!(run.2.as_deref(), Some("InternalError"));
  let binding_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_file_bindings WHERE profile_id = $1")
      .bind(profile.id)
      .fetch_one(&pool)
      .await
      .expect("binding count");
  assert_eq!(binding_count, 0, "blocked runner must not create bindings");

  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_rejects_terminal_run_before_git_or_binding_io() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default();
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/terminal-run.git",
    None,
  )
  .await;
  let run_id = create_run(&store, &profile).await;
  sqlx::query(
    "UPDATE git_sync_runs
     SET status = 'Failed', finished_at = now(), error_class = 'InternalError',
         error_message = 'synthetic terminal test state'
     WHERE id = $1",
  )
  .bind(run_id)
  .execute(&pool)
  .await
  .expect("make run terminal before worker delivery");

  let error = run_sync_with_git_repo(
    &pool,
    &RunnerConfig {
      overview_service: overview_state.workspace_overview_service(),
      repo_base_dir: repo_dir.path().join("repos"),
      crypto_key: app_config.crypto.private_key.clone(),
      min_free_disk_mb: 0,
      max_mirror_storage_mb: 0,
      ..RunnerConfig::default()
    },
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect_err("terminal run must never execute again");

  assert!(
    error.to_string().contains("terminal, stale, disabled"),
    "admission rejection must explain why execution stopped: {error}"
  );
  assert_eq!(
    git_repo.clone_count(),
    0,
    "terminal run rejection must happen before clone/fetch"
  );
  let binding_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE profile_id = $1")
    .bind(profile.id)
    .fetch_one(&pool)
    .await
    .expect("binding count");
  assert_eq!(binding_count, 0, "terminal replay must not mutate bindings");
  let status: String = sqlx::query_scalar("SELECT status FROM git_sync_runs WHERE id = $1")
    .bind(run_id)
    .fetch_one(&pool)
    .await
    .expect("terminal run status");
  assert_eq!(status, "Failed", "terminal replay must preserve terminal state");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn auth_denial_preserves_existing_mirror_and_terminal_replay_performs_no_git_io() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::with_file(REPO_PATH, PNG_BYTES);
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/mirror-recovery.git",
    None,
  )
  .await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_allowlist_admin: vec!["image/png".to_string()],
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };

  let initial_run_id = create_run(&store, &profile).await;
  run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    initial_run_id,
  )
  .await
  .expect("initial sync");
  let mirror_path = runner_config.repo_base_dir.join(profile.id.to_string());
  let physical_guard =
    myoxus_infrastructure::git_sync::acquire_profile_mirror(&runner_config.repo_base_dir, profile.id)
      .await
      .expect("runner released physical mirror ownership after native work");
  assert_eq!(
    physical_guard.mirror_path(),
    std::fs::canonicalize(&runner_config.repo_base_dir)
      .expect("canonical repo base")
      .join(profile.id.to_string())
  );
  assert!(
    physical_guard.lock_path().is_file(),
    "runner must use the stable profile lock file"
  );
  drop(physical_guard);
  add_recovery_state(&git_repo, &mirror_path, REPO_PATH);
  // Model a production adapter's real commit identity. The older harness used
  // a synthetic OID which forced the loader down its full-scan fallback and
  // therefore could not detect the delta-as-state regression.
  let materialized_oid = git_repo.adopt_materialized_head_as_remote(&mirror_path);
  sqlx::query(
    "UPDATE git_sync_runs
     SET commit_before = $2, commit_after = $2, observed_remote_oid = $2
     WHERE id = $1",
  )
  .bind(initial_run_id)
  .bind(&materialized_oid)
  .execute(&pool)
  .await
  .expect("record real harness commit identity");
  let recovery_before = mirror_recovery_snapshot(&git_repo, &mirror_path);
  assert_eq!(
    recovery_before.stashes.len(),
    1,
    "fixture must include an existing stash"
  );
  assert!(
    recovery_before.files.contains_key("recovery-untracked.txt"),
    "fixture must include untracked recovery content"
  );
  let clone_count_before = git_repo.clone_count();
  let fetch_count_before = git_repo.fetch_count();
  let probe_count_before = git_repo.source_probe_count();
  let commit_count_before = git_repo.commit_count();
  let state_counts_before: (i64, i64, i64, i64) = sqlx::query_as(
    "SELECT
       (SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE profile_id = $1),
       (SELECT COUNT(*)::bigint
        FROM git_sync_baselines baseline
        JOIN git_sync_bindings binding ON binding.id = baseline.binding_id
        WHERE binding.profile_id = $1),
       (SELECT COUNT(*)::bigint FROM git_sync_file_bindings WHERE profile_id = $1),
       (SELECT COUNT(*)::bigint FROM git_sync_file_baselines WHERE profile_id = $1)",
  )
  .bind(profile.id)
  .fetch_one(&pool)
  .await
  .expect("binding and baseline counts before denial");
  let file_identity_before: (Uuid, Uuid, String, String, bool, String, String) = sqlx::query_as(
    "SELECT binding.id, baseline.id, binding.blob_key, binding.repo_path,
            binding.tombstoned, binding.content_hash, baseline.content_hash
     FROM git_sync_file_bindings binding
     JOIN git_sync_file_baselines baseline
       ON baseline.profile_id = binding.profile_id
      AND baseline.blob_key = binding.blob_key
     WHERE binding.profile_id = $1 AND binding.repo_path = $2",
  )
  .bind(profile.id)
  .bind(REPO_PATH)
  .fetch_one(&pool)
  .await
  .expect("stable file binding identity before denial");

  git_repo.fail_next_fetch(GitError::Auth("controlled token rejection".to_string()));
  let denied_run_id = create_run(&store, &profile).await;
  let denied = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    denied_run_id,
  )
  .await
  .expect_err("authentication denial must fail the run");
  assert!(!denied.is_retryable(), "authentication denial must be terminal");
  assert_eq!(denied.to_error_class(), myoxus_domain::git_sync::ErrorClass::GitAuth);
  assert_eq!(git_repo.clone_count(), clone_count_before, "denial must never re-clone");
  assert_eq!(
    git_repo.fetch_count(),
    fetch_count_before + 1,
    "one denied fetch is the only remote attempt"
  );
  assert_eq!(
    git_repo.source_probe_count(),
    probe_count_before,
    "denied fetch must stop before source probing"
  );
  assert_eq!(git_repo.commit_count(), commit_count_before, "denial must not commit");
  assert_eq!(
    mirror_recovery_snapshot(&git_repo, &mirror_path),
    recovery_before,
    "denial must preserve HEAD, index, tracked/untracked content and stashes"
  );
  let denied_run: (String, Option<String>) =
    sqlx::query_as("SELECT status, error_class FROM git_sync_runs WHERE id = $1")
      .bind(denied_run_id)
      .fetch_one(&pool)
      .await
      .expect("denied run state");
  assert_eq!(denied_run.0, "Failed");
  assert_eq!(denied_run.1.as_deref(), Some("GitAuth"));
  let state_counts_after: (i64, i64, i64, i64) = sqlx::query_as(
    "SELECT
       (SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE profile_id = $1),
       (SELECT COUNT(*)::bigint
        FROM git_sync_baselines baseline
        JOIN git_sync_bindings binding ON binding.id = baseline.binding_id
        WHERE binding.profile_id = $1),
       (SELECT COUNT(*)::bigint FROM git_sync_file_bindings WHERE profile_id = $1),
       (SELECT COUNT(*)::bigint FROM git_sync_file_baselines WHERE profile_id = $1)",
  )
  .bind(profile.id)
  .fetch_one(&pool)
  .await
  .expect("binding and baseline counts after denial");
  assert_eq!(
    state_counts_after, state_counts_before,
    "denial must not change normal persisted state"
  );

  run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    denied_run_id,
  )
  .await
  .expect_err("terminal replay must be rejected");
  assert_eq!(
    git_repo.fetch_count(),
    fetch_count_before + 1,
    "terminal replay must perform no Git I/O"
  );
  assert_eq!(
    git_repo.clone_count(),
    clone_count_before,
    "terminal replay must not clone"
  );

  let encrypted = crypto::encrypt(
    &app_config.crypto.private_key,
    json!({ "username": "runner-test", "token": "replacement-token" })
      .to_string()
      .as_bytes(),
  )
  .expect("encrypt replacement credential");
  let rotated_profile = store
    .upsert_profile_with_credential(&profile, "runner-test-replacement", &encrypted)
    .await
    .expect("rotate profile credential");
  assert_ne!(
    rotated_profile.credential_id, profile.credential_id,
    "rotation must replace credential identity"
  );

  let recovery_run_id = create_run(&store, &rotated_profile).await;
  let recovered = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    recovery_run_id,
  )
  .await
  .expect("rotated credential must permit a fresh run");
  assert_eq!(recovered["status"], "Completed");
  assert_eq!(
    git_repo.clone_count(),
    clone_count_before,
    "recovery must fetch the existing mirror"
  );

  let noop_run_id = create_run(&store, &rotated_profile).await;
  let noop = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    noop_run_id,
  )
  .await
  .expect("immediate no-op run");
  assert_eq!(noop["status"], "Completed");
  assert_eq!(noop["docsCreated"], 0);
  assert_eq!(noop["docsUpdated"], 0);
  assert_eq!(noop["docsDeleted"], 0);
  assert_eq!(noop["filesPulled"], 0);
  assert_eq!(noop["filesPushed"], 0);
  assert_eq!(noop["filesDeleted"], 0);
  assert_eq!(
    git_repo.clone_count(),
    clone_count_before,
    "no-op must retain mirror identity"
  );
  let file_identity_after: (Uuid, Uuid, String, String, bool, String, String) = sqlx::query_as(
    "SELECT binding.id, baseline.id, binding.blob_key, binding.repo_path,
            binding.tombstoned, binding.content_hash, baseline.content_hash
     FROM git_sync_file_bindings binding
     JOIN git_sync_file_baselines baseline
       ON baseline.profile_id = binding.profile_id
      AND baseline.blob_key = binding.blob_key
     WHERE binding.profile_id = $1 AND binding.repo_path = $2",
  )
  .bind(profile.id)
  .bind(REPO_PATH)
  .fetch_one(&pool)
  .await
  .expect("stable file binding identity after recovery and no-op");
  assert_eq!(
    file_identity_after, file_identity_before,
    "recovery and an unchanged source must preserve binding/baseline identity and active state"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn source_probe_denial_preserves_recovery_state_and_transient_fetch_retries_same_run() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::with_file(REPO_PATH, PNG_BYTES);
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/source-observation.git",
    None,
  )
  .await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    mime_allowlist_admin: vec!["image/png".to_string()],
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };

  let initial_run_id = create_run(&store, &profile).await;
  run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    initial_run_id,
  )
  .await
  .expect("initial sync");
  let mirror_path = runner_config.repo_base_dir.join(profile.id.to_string());
  add_recovery_state(&git_repo, &mirror_path, REPO_PATH);
  let recovery_before = mirror_recovery_snapshot(&git_repo, &mirror_path);
  let clone_count_before = git_repo.clone_count();

  git_repo.fail_next_source_probe(GitError::Auth("controlled source probe rejection".to_string()));
  let denied_run_id = create_run(&store, &profile).await;
  let denied = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    denied_run_id,
  )
  .await
  .expect_err("source probe denial must fail");
  assert_eq!(denied.to_error_class(), myoxus_domain::git_sync::ErrorClass::GitAuth);
  assert_eq!(
    git_repo.clone_count(),
    clone_count_before,
    "probe denial must not clone"
  );
  assert_eq!(
    mirror_recovery_snapshot(&git_repo, &mirror_path),
    recovery_before,
    "probe denial must happen before stash/reset/checkout"
  );

  git_repo.fail_next_fetch(GitError::Network("controlled transient fetch failure".to_string()));
  let retry_run_id = create_run(&store, &profile).await;
  let transient = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    retry_run_id,
  )
  .await
  .expect_err("transient fetch must release the run for retry");
  assert!(transient.is_retryable());
  assert_eq!(
    store.get_run(retry_run_id).await.expect("retry run").status,
    RunStatus::Pending
  );
  let recovered = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    retry_run_id,
  )
  .await
  .expect("same run must complete after the transient transport recovers");
  assert_eq!(recovered["status"], "Completed");
  assert_eq!(
    git_repo.clone_count(),
    clone_count_before,
    "transient recovery must not clone"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_releases_transient_failure_for_one_exact_retry() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default().fail_next_clones(1);
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/retry-run.git",
    None,
  )
  .await;
  let run_id = create_run(&store, &profile).await;
  let runner_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_dir.path().join("repos"),
    crypto_key: app_config.crypto.private_key.clone(),
    min_free_disk_mb: 0,
    max_mirror_storage_mb: 0,
    ..RunnerConfig::default()
  };

  let first_error = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect_err("injected network failure must be retryable");
  assert!(first_error.is_retryable());
  let released = store.get_run(run_id).await.expect("released run");
  assert_eq!(
    released.status,
    RunStatus::Pending,
    "retryable attempt must atomically release Running back to Pending"
  );
  let canonical_mirror = runner_config.repo_base_dir.join(profile.id.to_string());
  assert!(
    !canonical_mirror.exists(),
    "failed first clone must never leave a partial canonical mirror"
  );
  let staging_profile = runner_config
    .repo_base_dir
    .join(".staging")
    .join(profile.id.to_string());
  let failed_staging = std::fs::read_dir(&staging_profile)
    .expect("failed staging profile directory")
    .collect::<Result<Vec<_>, _>>()
    .expect("failed staging entries");
  assert_eq!(failed_staging.len(), 1, "failed attempt remains uniquely inspectable");
  assert!(failed_staging[0].path().join("ownership.json").is_file());

  let second = run_sync_with_git_repo(
    &pool,
    &runner_config,
    &locks,
    &blob_storage,
    &git_repo,
    profile.id,
    run_id,
  )
  .await
  .expect("second delivery must claim and complete the same run");
  assert_eq!(second["status"], "Completed");
  assert_eq!(git_repo.clone_count(), 2);
  assert!(
    canonical_mirror.join(".git").is_dir(),
    "retry publishes one complete mirror"
  );
  assert_eq!(
    std::fs::read_dir(&staging_profile)
      .expect("staging profile after retry")
      .count(),
    1,
    "successful retry removes only its own staging container"
  );
  let completed = store.get_run(run_id).await.expect("completed retry run");
  assert_eq!(completed.status, RunStatus::Completed);
  assert!(completed.error_message.is_none());
  assert!(completed.error_class.is_none());
  assert_eq!(
    completed.job_id, released.job_id,
    "retry must preserve queue correlation"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn runner_applies_disk_preflight_before_git_io_and_honors_profile_override() {
  let (_app, pool, auth_store, overview_state) = helpers::setup_app_with_state().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let app_config = AppConfig::load().expect("load app config");
  let store = SqlxGitSyncStore::new(pool.clone());
  let repo_dir = TempDir::new().expect("repo tempdir");
  let git_repo = HarnessGitRepo::default();
  let blob_storage = MemoryBlobStorage::default();
  let locks = locking::new_locks();
  let repo_base_dir = repo_dir.path().join("repos");
  tokio::fs::create_dir_all(&repo_base_dir).await.expect("repo base dir");
  tokio::fs::write(repo_base_dir.join("existing-mirror.bin"), vec![7_u8; 2 * 1024 * 1024])
    .await
    .expect("inflate repo base dir");

  let blocked_profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    workspace_id,
    admin_id,
    "https://example.test/myoxus/disk-blocked.git",
    None,
  )
  .await;
  let blocked_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir: repo_base_dir.clone(),
    static_policy: app_config.git_sync.clone(),
    crypto_key: app_config.crypto.private_key.clone(),
    max_mirror_storage_mb: 1,
    min_free_disk_mb: 0,
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };
  let blocked_run_id = create_run(&store, &blocked_profile).await;
  let blocked = run_sync_with_git_repo(
    &pool,
    &blocked_config,
    &locks,
    &blob_storage,
    &git_repo,
    blocked_profile.id,
    blocked_run_id,
  )
  .await
  .expect_err("global mirror limit must block runner");
  assert!(
    blocked.to_string().contains("storage limit exceeded"),
    "disk error must mention storage limit: {blocked}"
  );
  assert_eq!(
    git_repo.clone_count(),
    0,
    "global disk preflight failure must happen before clone/fetch"
  );

  let override_profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    helpers::create_workspace(&pool, admin_id).await,
    admin_id,
    "https://example.test/myoxus/disk-override.git",
    Some(0),
  )
  .await;
  let override_run_id = create_run(&store, &override_profile).await;
  let override_result = run_sync_with_git_repo(
    &pool,
    &blocked_config,
    &locks,
    &blob_storage,
    &git_repo,
    override_profile.id,
    override_run_id,
  )
  .await
  .expect("profile override 0 must disable mirror-size limit for this profile");
  assert_eq!(override_result["status"], "Completed");
  assert_eq!(git_repo.clone_count(), 1, "override run must reach clone/fetch");

  let min_free_profile = create_test_profile(
    &pool,
    &store,
    &app_config,
    helpers::create_workspace(&pool, admin_id).await,
    admin_id,
    "https://example.test/myoxus/min-free.git",
    Some(0),
  )
  .await;
  let min_free_config = RunnerConfig {
    overview_service: overview_state.workspace_overview_service(),
    repo_base_dir,
    static_policy: app_config.git_sync.clone(),
    crypto_key: app_config.crypto.private_key.clone(),
    max_mirror_storage_mb: 0,
    min_free_disk_mb: 1_000_000_000,
    mime_validation_mode: "strict".to_string(),
    ..RunnerConfig::default()
  };
  let min_free_run_id = create_run(&store, &min_free_profile).await;
  let min_free = run_sync_with_git_repo(
    &pool,
    &min_free_config,
    &locks,
    &blob_storage,
    &git_repo,
    min_free_profile.id,
    min_free_run_id,
  )
  .await
  .expect_err("unreachable min_free_disk_mb must block runner");
  assert!(
    min_free.to_string().contains("insufficient free disk space"),
    "disk error must mention free space: {min_free}"
  );
  assert_eq!(
    git_repo.clone_count(),
    1,
    "min-free preflight failure must not perform another clone/fetch"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
