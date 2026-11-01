// SPDX-License-Identifier: AGPL-3.0-or-later
//! Receipt-owned external metadata completion, separate from content publication.

use std::{
  collections::{BTreeMap, BTreeSet},
  sync::Arc,
};

use async_trait::async_trait;
use myoxus_application::{
  auth::{AuthError, AuthResult},
  git_sync::{GitRepositoryPort, GitSyncNativeOwnership, GitSyncRepositoryCoordination, GitSyncRepositoryScope},
  workspace_content_operation::{
    WorkspaceContentGitSyncChoice, extract::WorkspaceContentExtractGitWork, extract_git_profile_id,
    worker::WorkspaceContentGitMetadataExecutor,
  },
};
use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
use myoxus_infrastructure::{
  git_sync::{PgGitSyncRepositoryCoordination, SqlxGitSyncStore},
  workspace_content_operation::PgWorkspaceContentOperationRepository,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{credential, locking};
use crate::state::ApiState;

pub struct ExtractGitMetadata {
  state: ApiState,
  repository: Arc<PgWorkspaceContentOperationRepository>,
  locks: locking::ProfileLocks,
}

impl ExtractGitMetadata {
  pub fn new(
    state: ApiState,
    repository: Arc<PgWorkspaceContentOperationRepository>,
    locks: locking::ProfileLocks,
  ) -> Self {
    Self {
      state,
      repository,
      locks,
    }
  }
}

/// Cancellation must retain the branch, leases and temporary clone until the
/// last non-cancellable native Git operation has actually stopped.
struct NativeOwner {
  branch: Arc<GitSyncNativeOwnership>,
  _directory: Arc<tempfile::TempDir>,
  profiles: Vec<locking::ProfileLockGuard>,
}
impl std::fmt::Debug for NativeOwner {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("ExtractGitMetadataOwnership")
  }
}
impl NativeOwner {
  async fn ensure_owned(&self) -> AuthResult<()> {
    self.branch.ensure_owned().await.map_err(|_| unavailable())?;
    for profile in &self.profiles {
      profile
        .ensure_owned("extract_git_metadata")
        .map_err(|_| unavailable())?;
    }
    Ok(())
  }
}

fn unavailable() -> AuthError {
  AuthError::Storage(WorkspaceContentErrorCode::GitSyncRemoteUnavailable.as_str().into())
}
fn conflict() -> AuthError {
  AuthError::InvalidInput(WorkspaceContentErrorCode::GitSyncMetadataConflict.as_str().into())
}
fn git_failure(error: myoxus_application::git_sync::backend::GitError) -> AuthError {
  use myoxus_application::git_sync::backend::GitError;
  match error {
    GitError::Network(_) | GitError::Internal(_) => unavailable(),
    GitError::Auth(_) | GitError::Tls(_) => {
      AuthError::InvalidInput(WorkspaceContentErrorCode::GitSyncMetadataAuthDenied.as_str().into())
    }
    _ => conflict(),
  }
}
fn hash(bytes: &[u8]) -> String {
  hex::encode(Sha256::digest(bytes))
}

async fn read_manifest(
  repo: &dyn GitRepositoryPort,
  path: &str,
) -> AuthResult<myoxus_application::git_sync::export::GitSyncManifest> {
  let bytes = repo.read_file(path).await.map_err(git_failure)?;
  if bytes.len() > 2 * 1024 * 1024 {
    return Err(conflict());
  }
  serde_json::from_slice(&bytes).map_err(|_| conflict())
}

impl ExtractGitMetadata {
  async fn finish(&self, work: WorkspaceContentExtractGitWork) -> AuthResult<()> {
    let pool = self.state.metrics_pool().ok_or_else(unavailable)?.clone();
    let scope = GitSyncRepositoryScope::new(&work.plan.repository, &work.plan.branch).map_err(|_| conflict())?;
    let branch = GitSyncNativeOwnership::new(
      PgGitSyncRepositoryCoordination::new(pool.clone())
        .acquire(&scope)
        .await
        .map_err(|_| unavailable())?,
    );
    let mut profile_ids = vec![work.plan.source_profile_id];
    if work.plan.choice == WorkspaceContentGitSyncChoice::Move {
      profile_ids.push(extract_git_profile_id(
        work
          .plan
          .undo
          .as_ref()
          .map_or(work.operation_id, |undo| undo.origin_operation_id),
      ));
    }
    profile_ids.sort();
    let mut profiles = Vec::new();
    for id in profile_ids {
      profiles.push(
        locking::acquire(
          &self.locks,
          id,
          &self.state.redis_port(),
          self.state.config.git_sync.lock_ttl_seconds,
        )
        .await
        .map_err(|_| unavailable())?,
      );
    }
    let directory = Arc::new(tempfile::tempdir().map_err(|_| unavailable())?);
    let owner = Arc::new(NativeOwner {
      branch,
      _directory: directory.clone(),
      profiles,
    });
    // Re-read pending and current profiles only after ownership acquisition.
    let Some(work) = self.repository.pending_extract_git_work(work.operation_id).await? else {
      return Ok(());
    };
    let undo = work.plan.undo.is_some();
    if undo {
      self.repository.validate_git_undo_scope(&work).await?;
    }
    let disconnect = work.plan.choice == WorkspaceContentGitSyncChoice::Disconnect && !undo;
    if disconnect {
      if !self.repository.disconnect_outbound_admitted(work.operation_id).await? {
        return Err(AuthError::Storage(
          WorkspaceContentErrorCode::GitSyncOutboundCleanupPending.as_str().into(),
        ));
      }
    } else {
      self
        .repository
        .validate_extract_git_bindings(&work)
        .await
        .map_err(|_| conflict())?;
    }
    let store = SqlxGitSyncStore::new(pool.clone());
    let source = store
      .get_profile(work.plan.source_profile_id)
      .await
      .map_err(|_| conflict())?;
    let target = if work.plan.choice == WorkspaceContentGitSyncChoice::Disconnect {
      source.clone()
    } else {
      store
        .get_profile(extract_git_profile_id(
          work
            .plan
            .undo
            .as_ref()
            .map_or(work.operation_id, |undo| undo.origin_operation_id),
        ))
        .await
        .map_err(|_| conflict())?
    };
    if !scope.matches(&source.repo_url, &source.branch)
      || source.workspace_id != work.source_workspace_id
      || source.root_path != work.plan.source_root
      || !scope.matches(&target.repo_url, &target.branch)
      || (work.plan.choice == WorkspaceContentGitSyncChoice::Move
        && (target.workspace_id != work.target_workspace_id
          || target.root_path != work.plan.target_root
          || target.manifest_path != work.plan.target_manifest))
      || source.owner_id != work.plan.source_profile_owner_id
      || target.owner_id != work.plan.source_profile_owner_id
      || source.manifest_path != work.plan.source_manifest
    {
      return Err(conflict());
    }
    if disconnect
      && !store
        .scope_exclusions(source.id)
        .await
        .map_err(|_| unavailable())?
        .iter()
        .any(|fence| {
          fence.repo_path.as_str() == work.plan.target_root
            && fence.is_directory
            && fence.destination_profile_id.is_none()
            && fence.originating_operation_id == work.operation_id
        })
    {
      return Err(conflict());
    }
    for profile in [&source, &target] {
      if !store
        .owner_has_active_workspace_access(profile.owner_id, profile.workspace_id)
        .await
        .map_err(|_| unavailable())?
      {
        return Err(AuthError::ActionForbidden);
      }
    }
    let authenticated_profile = if undo { &source } else { &target };
    let credential_id = authenticated_profile.credential_id.ok_or_else(conflict)?;
    if store
      .get_credential(credential_id)
      .await
      .map_err(|_| unavailable())?
      .is_expired()
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::GitSyncMetadataAuthDenied.as_str().into(),
      ));
    }
    let rotating = store
      .credential_rotation_in_progress(credential_id)
      .await
      .map_err(|_| unavailable())?;
    if rotating {
      return Err(unavailable());
    }
    let policy = self
      .state
      .effective_git_sync_policy()
      .await
      .map_err(|_| unavailable())?;
    if !policy.enabled || (disconnect && !policy.is_sync_direction_allowed(source.sync_direction)) {
      return Err(AuthError::ActionForbidden);
    }
    if !policy.is_repo_host_allowed(&authenticated_profile.repo_url)
      || !policy.is_auth_method_allowed(authenticated_profile.auth_method)
    {
      return Err(AuthError::ActionForbidden);
    }
    let encrypted = store
      .get_credential_encrypted_data(credential_id)
      .await
      .map_err(|_| unavailable())?;
    let payload = credential::decrypt(&self.state.config.crypto.private_key, &encrypted).map_err(|_| conflict())?;
    let auth = credential::build_auth(authenticated_profile.id, authenticated_profile.auth_method, &payload)
      .map_err(|_| conflict())?;
    let repo = self
      .state
      .git_sync_repository_builder()
      .build(pool.clone(), &policy, "extract_git_metadata", None);
    repo.retain_operation_guard(owner.clone()).await.map_err(git_failure)?;
    repo
      .clone_repo_full(&source.repo_url, &directory.path().join("repo"), &source.branch, &auth)
      .await
      .map_err(|error| match error {
        myoxus_application::git_sync::backend::GitError::Auth(_)
        | myoxus_application::git_sync::backend::GitError::Tls(_) => git_failure(error),
        _ => unavailable(),
      })?;
    let observed = super::extract_capture::observed_files(&directory.path().join("repo")).ok_or_else(conflict)?;
    let prefix = format!("{}/", work.plan.target_root);
    if let Some(inverse) = &work.plan.undo {
      if observed.iter().any(|path| {
        path.starts_with(&prefix)
          && !inverse.expected_hashes.contains_key(path)
          && !work.plan.delegated_descendants.iter().any(|fence| {
            *path == fence.repo_path || (fence.is_directory && path.starts_with(&format!("{}/", fence.repo_path)))
          })
      }) {
        return Err(conflict());
      }
    }
    if !disconnect
      && !undo
      && observed.iter().filter(|path| path.starts_with(&prefix)).any(|path| {
        !work.plan.observed_hashes.contains_key(path)
          && path != &work.plan.target_manifest
          && !work.plan.shared_files.iter().any(|file| file.target_repo_path == *path)
          && !work.plan.delegated_descendants.iter().any(|fence| {
            path.as_str() == fence.repo_path
              || (fence.is_directory && path.starts_with(&format!("{}/", fence.repo_path)))
          })
      })
    {
      return Err(conflict());
    }
    owner.ensure_owned().await?;
    let head = repo.head_oid().await.map_err(git_failure)?;
    if repo
      .remote_branch_oid(&source.branch, &auth)
      .await
      .map_err(git_failure)?
      != head
    {
      return Err(unavailable());
    }
    let current = read_manifest(repo.as_ref(), &source.manifest_path).await?;
    if disconnect {
      self.verify_disconnect_membership(&work, &current)?;
    }
    if let Some(prepared) = &work.prepared_oid {
      if repo.commit_is_ancestor(prepared, &head).await.map_err(git_failure)? {
        let bodies = self.verify_applied(repo.as_ref(), &work, &current).await?;
        owner.ensure_owned().await?;
        return self
          .repository
          .complete_extract_git_work(work.operation_id, prepared, &bodies)
          .await;
      }
    }
    let original = work.plan.remote_oid.as_deref().ok_or_else(conflict)?;
    if !repo.commit_is_ancestor(original, &head).await.map_err(git_failure)? {
      return Err(conflict());
    }
    // An existing target manifest is neither an empty destination nor authority
    // to adopt arbitrary external ownership after a rejected/unknown push.
    if !disconnect && !undo {
      match repo.read_file(&target.manifest_path).await {
        Err(myoxus_application::git_sync::backend::GitError::NotFound(_)) => {}
        _ => return Err(conflict()),
      }
    }
    let recorded: myoxus_application::git_sync::export::GitSyncManifest =
      serde_json::from_value(work.plan.manifest_inventory.clone().ok_or_else(conflict)?).map_err(|_| conflict())?;
    let paths = if let Some(inverse) = &work.plan.undo {
      inverse
        .expected_hashes
        .keys()
        .filter(|path| observed.contains(*path))
        .cloned()
        .chain(current.overview_outputs().map(|output| output.repo_path.clone()))
        .collect::<BTreeSet<_>>()
    } else if disconnect {
      recorded
        .overview_outputs()
        .filter(|output| output.repo_path.starts_with(&prefix) && observed.contains(&output.repo_path))
        .map(|output| output.repo_path.clone())
        .collect::<BTreeSet<_>>()
    } else {
      work
        .plan
        .documents
        .iter()
        .map(|doc| doc.repo_path.clone())
        .chain(work.plan.files.iter().map(|file| file.repo_path.clone()))
        .chain(work.plan.shared_files.iter().map(|file| file.source.repo_path.clone()))
        .chain(
          recorded
            .overview_outputs()
            .filter(|output| output.repo_path.starts_with(&prefix))
            .map(|output| output.repo_path.clone()),
        )
        .chain(current.overview_outputs().map(|output| output.repo_path.clone()))
        .collect::<BTreeSet<_>>()
    };
    let mut files = BTreeMap::new();
    let limit_mb = match authenticated_profile.max_mirror_storage_mb {
      Some(value) if value >= 0 => value as u64,
      Some(_) => return Err(conflict()),
      None => policy.max_mirror_storage_mb,
    };
    let mut prepared_bytes = 0u64;
    for shared in work.plan.shared_files.iter().filter(|_| !disconnect && !undo) {
      if observed.contains(&shared.target_repo_path) {
        return Err(conflict());
      }
    }
    for path in paths {
      if std::fs::metadata(directory.path().join("repo").join(&path))
        .is_ok_and(|metadata| metadata.len() > 256 * 1024 * 1024)
      {
        return Err(conflict());
      }
      let bytes = repo.read_file(&path).await.map_err(git_failure)?;
      prepared_bytes = prepared_bytes.saturating_add(bytes.len() as u64);
      if limit_mb > 0 && prepared_bytes > limit_mb.saturating_mul(1024 * 1024) {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::InventoryLimit.as_str().into(),
        ));
      }
      files.insert(path.clone(), bytes);
    }
    let (writes, deletions, target_hashes) = if let Some(inverse) = &work.plan.undo {
      let paths = work
        .plan
        .documents
        .iter()
        .map(|document| document.repo_path.clone())
        .chain(
          recorded
            .overview_outputs()
            .filter(|output| {
              output.repo_path.starts_with(&prefix)
                && !work.plan.delegated_descendants.iter().any(|fence| {
                  output.repo_path == fence.repo_path
                    || (fence.is_directory && output.repo_path.starts_with(&format!("{}/", fence.repo_path)))
                })
            })
            .map(|output| output.repo_path.clone()),
        )
        .collect::<BTreeSet<_>>();
      let mut originals = BTreeMap::new();
      for path in paths {
        originals.insert(
          path.clone(),
          repo
            .read_file_at_revision(&inverse.original_oid, &path)
            .await
            .map_err(git_failure)?,
        );
      }
      let (changes, deletions) = myoxus_application::git_sync::extract_metadata::prepare_undo(
        &work.plan,
        work.source_workspace_id,
        &work.source_folder_id,
        &current,
        &files,
        &originals,
      )
      .map_err(|_| conflict())?;
      let mut hashes = BTreeMap::new();
      for path in &changes.target_paths {
        hashes.insert(path.clone(), Some(hash(changes.writes.get(path).ok_or_else(conflict)?)));
      }
      for path in &deletions {
        hashes.insert(path.clone(), None);
      }
      (changes.writes, deletions, hashes)
    } else if disconnect {
      let deletions = myoxus_application::git_sync::extract_metadata::disconnect_cleanup_paths(
        &work.plan,
        work.source_workspace_id,
        &files,
      )
      .map_err(|_| conflict())?;
      let hashes = deletions.iter().map(|path| (path.clone(), None)).collect();
      (BTreeMap::new(), deletions, hashes)
    } else {
      let changes = myoxus_application::git_sync::extract_metadata::prepare(
        &work.plan,
        work.source_workspace_id,
        work.target_workspace_id,
        &work.source_folder_id,
        &work.target_name,
        &current,
        &files,
      )
      .map_err(|_| conflict())?;
      let mut target_hashes = BTreeMap::new();
      for path in &changes.target_paths {
        let bytes = changes
          .writes
          .get(path)
          .or_else(|| files.get(path))
          .ok_or_else(conflict)?;
        target_hashes.insert(path.clone(), Some(hash(bytes)));
      }
      (changes.writes, Vec::new(), target_hashes)
    };
    owner.ensure_owned().await?;
    if disconnect && deletions.is_empty() {
      self
        .repository
        .prepare_extract_git_commit(work.operation_id, &head, &target_hashes)
        .await?;
      return self
        .repository
        .complete_extract_git_work(work.operation_id, &head, &BTreeMap::new())
        .await;
    }
    for (path, bytes) in writes {
      repo.write_file(&path, &bytes).await.map_err(git_failure)?;
    }
    for path in deletions {
      repo.delete_file(&path).await.map_err(git_failure)?;
    }
    let oid = repo
      .commit(
        &format!(
          "extract: Git ownership metadata\n\nMyoxus-Operation: {}",
          work.operation_id
        ),
        &self.state.config.git_sync.commit_author_name,
        &self.state.config.git_sync.commit_author_email,
      )
      .await
      .map_err(git_failure)?;
    self
      .repository
      .prepare_extract_git_commit(work.operation_id, &oid, &target_hashes)
      .await?;
    owner.ensure_owned().await?;
    // No snapshot replay/rebase: a rejected branch update is rebuilt from a new
    // authenticated inventory on the next bounded delivery.
    let push = repo.push(&source.branch, &oid, &auth).await;
    let observed = repo
      .remote_branch_oid(&source.branch, &auth)
      .await
      .map_err(git_failure)?;
    if observed != oid {
      repo.fetch(&auth).await.map_err(git_failure)?;
      if !repo.commit_is_ancestor(&oid, &observed).await.map_err(git_failure)? {
        if let Err(error) = push {
          return Err(git_failure(error));
        }
        return Err(unavailable());
      }
      repo.reset_to_remote(&source.branch).await.map_err(git_failure)?;
    }
    let Some(work) = self.repository.pending_extract_git_work(work.operation_id).await? else {
      return Ok(());
    };
    let current = read_manifest(repo.as_ref(), &source.manifest_path).await?;
    let bodies = self.verify_applied(repo.as_ref(), &work, &current).await?;
    owner.ensure_owned().await?;
    self
      .repository
      .complete_extract_git_work(work.operation_id, &oid, &bodies)
      .await
  }

  async fn verify_applied(
    &self,
    repo: &dyn GitRepositoryPort,
    work: &WorkspaceContentExtractGitWork,
    current: &myoxus_application::git_sync::export::GitSyncManifest,
  ) -> AuthResult<BTreeMap<Uuid, String>> {
    if work.plan.undo.is_some() {
      current
        .validate_overviews(work.source_workspace_id, std::iter::empty())
        .map_err(|_| conflict())?;
      let recorded: myoxus_application::git_sync::export::GitSyncManifest =
        serde_json::from_value(work.plan.manifest_inventory.clone().ok_or_else(conflict)?).map_err(|_| conflict())?;
      for document in &work.plan.documents {
        if !current.documents.iter().any(|entry| {
          entry.doc_id == document.doc_id
            && entry.repo_path == document.repo_path
            && recorded
              .documents
              .iter()
              .any(|old| old.doc_id == entry.doc_id && old.content_hash == entry.content_hash)
        }) {
          return Err(conflict());
        }
      }
      if !current
        .folders
        .iter()
        .any(|folder| folder.organizer_id == work.source_folder_id)
      {
        return Err(conflict());
      }
      for (path, expected) in &work.prepared_hashes {
        match (repo.read_file(path).await, expected) {
          (Ok(bytes), Some(expected)) if hash(&bytes) == *expected => {}
          (Err(myoxus_application::git_sync::backend::GitError::NotFound(_)), None) => {}
          _ => return Err(conflict()),
        }
      }
    } else {
      if work.plan.choice == WorkspaceContentGitSyncChoice::Disconnect {
        self.verify_disconnect_membership(work, current)?;
        // An applied deletion needs no replay. Later external reintroductions are
        // detached authored state and must survive lost-acknowledgement recovery.
        if work.prepared_hashes.values().any(Option::is_some) {
          return Err(conflict());
        }
        return Ok(BTreeMap::new());
      }
      current
        .validate_overviews(work.source_workspace_id, std::iter::empty())
        .map_err(|_| conflict())?;
      if current
        .documents
        .iter()
        .any(|doc| work.plan.documents.iter().any(|binding| binding.doc_id == doc.doc_id))
        || current
          .folders
          .iter()
          .any(|folder| folder.organizer_path.contains(&work.source_folder_id))
      {
        return Err(conflict());
      }
      if !work.prepared_hashes.contains_key(&work.plan.target_manifest) {
        return Err(conflict());
      }
      for (path, expected) in &work.prepared_hashes {
        if Some(hash(&repo.read_file(path).await.map_err(git_failure)?)) != *expected {
          return Err(conflict());
        }
      }
    }
    let mut bodies = BTreeMap::new();
    for document in &work.plan.documents {
      let bytes = repo.read_file(&document.repo_path).await.map_err(git_failure)?;
      let text = std::str::from_utf8(&bytes).map_err(|_| conflict())?;
      bodies.insert(
        document.doc_id,
        myoxus_application::markdown::content_hash(&myoxus_application::git_sync::export::split_markdown_file(text).1),
      );
    }
    Ok(bodies)
  }

  fn verify_disconnect_membership(
    &self,
    work: &WorkspaceContentExtractGitWork,
    current: &myoxus_application::git_sync::export::GitSyncManifest,
  ) -> AuthResult<()> {
    current
      .validate_overviews(work.source_workspace_id, std::iter::empty())
      .map_err(|_| conflict())?;
    let prefix = format!("{}/", work.plan.target_root).to_lowercase();
    if current.documents.iter().any(|document| {
      document.repo_path.to_lowercase().starts_with(&prefix)
        || work
          .plan
          .documents
          .iter()
          .any(|binding| binding.doc_id == document.doc_id)
    }) || current
      .folders
      .iter()
      .any(|folder| folder.organizer_path.contains(&work.source_folder_id))
      || current
        .overview_outputs()
        .any(|output| output.repo_path.to_lowercase().starts_with(&prefix))
    {
      return Err(conflict());
    }
    Ok(())
  }
}

#[async_trait]
impl WorkspaceContentGitMetadataExecutor for ExtractGitMetadata {
  #[tracing::instrument(skip_all,fields(%operation_id))]
  async fn execute(&self, operation_id: Uuid) -> AuthResult<()> {
    if let Some(work) = self.repository.pending_extract_git_work(operation_id).await? {
      self.finish(work).await?;
    }
    Ok(())
  }
}
