// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only, authenticated branch evidence for Extract preflight.

use std::collections::BTreeSet;
use std::path::Path;

use async_trait::async_trait;
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::git_sync::backend::GitError;
use myoxus_application::git_sync::export::GitSyncManifest;
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_application::workspace_content_operation::{
  WorkspaceContentGitSyncCapture, WorkspaceContentGitSyncCapturePort,
};
use myoxus_domain::git_sync::{GitSyncProfile, RepoPath};
use myoxus_domain::permission::WorkspaceAction;
use myoxus_infrastructure::git_sync::SqlxGitSyncStore;
use sha2::{Digest, Sha256};

use crate::state::ApiState;

use super::{GitRepositoryBuilder, PolicyBoundGitRepositoryBuilder, credential};

pub struct ExtractGitCapture {
  state: ApiState,
}

impl ExtractGitCapture {
  pub fn new(state: ApiState) -> Self {
    Self { state }
  }
}

/// Clone inventory must include unbound authored files: a binding-only list
/// cannot establish whether a derived overview or subtree root is occupied.
pub(super) fn observed_files(root: &Path) -> Option<BTreeSet<String>> {
  let mut pending = vec![root.to_path_buf()];
  let mut files = BTreeSet::new();
  let mut entries = 0usize;
  while let Some(directory) = pending.pop() {
    for entry in std::fs::read_dir(&directory).ok()? {
      let entry = entry.ok()?;
      let path = entry.path();
      if path == root.join(".git") {
        continue;
      }
      if entry.file_name() == ".git" {
        return None;
      }
      entries += 1;
      if entries > 50_000 {
        return None;
      }
      let kind = entry.file_type().ok()?;
      if kind.is_symlink() {
        return None;
      }
      if kind.is_dir() {
        pending.push(path);
      } else if kind.is_file() {
        let relative = path.strip_prefix(root).ok()?.to_str()?;
        let validated = RepoPath::new(relative.to_owned()).ok()?;
        files.insert(validated.as_str().to_owned());
      } else {
        return None;
      }
    }
  }
  Some(files)
}

#[async_trait]
impl WorkspaceContentGitSyncCapturePort for ExtractGitCapture {
  async fn capture(
    &self,
    actor_id: uuid::Uuid,
    profile: &GitSyncProfile,
    _folder_id: &str,
    paths: &[String],
  ) -> AuthResult<Option<WorkspaceContentGitSyncCapture>> {
    // Preflight builds the graph before the final authorization projection;
    // do not read a private remote using this profile's credential for a
    // caller who cannot manage the source Workspace and its Git profile.
    let resource = WorkspaceResource {
      user_id: actor_id,
      workspace_id: profile.workspace_id,
    };
    if !self
      .state
      .permission_service()
      .can(&resource, WorkspaceAction::OrganizeUpdate)
      .await
      || !self
        .state
        .permission_service()
        .can(&resource, WorkspaceAction::SettingsUpdate)
        .await
    {
      return Ok(None);
    }
    let pool = self
      .state
      .metrics_pool()
      .ok_or_else(|| AuthError::Storage("database unavailable".into()))?;
    let policy = self
      .state
      .effective_git_sync_policy()
      .await
      .map_err(|_| AuthError::Storage("Git-Sync policy unavailable".into()))?;
    if !policy.is_repo_host_allowed(&profile.repo_url) || !policy.is_auth_method_allowed(profile.auth_method) {
      return Ok(None);
    }
    let store = SqlxGitSyncStore::new(pool.clone());
    let cached = store
      .verified_extract_capture(profile)
      .await
      .map_err(|_| AuthError::Storage("Git-Sync verified inventory unavailable".into()))?;
    let Some(credential_id) = profile.credential_id else {
      return Ok(cached);
    };
    let encrypted = match store.get_credential_encrypted_data(credential_id).await {
      Ok(value) => value,
      Err(_) => return Ok(cached),
    };
    let payload = match credential::decrypt(&self.state.config.crypto.private_key, &encrypted) {
      Ok(value) => value,
      Err(_) => return Ok(cached),
    };
    let auth = match credential::build_auth(profile.id, profile.auth_method, &payload) {
      Ok(value) => value,
      Err(_) => return Ok(cached),
    };
    let repo = PolicyBoundGitRepositoryBuilder::new(&self.state.config.git_sync).build(
      pool.clone(),
      &policy,
      "extract_preflight",
      None,
    );
    let dir = tempfile::tempdir().map_err(|_| AuthError::Storage("Git-Sync preflight workspace unavailable".into()))?;
    let clone = dir.path().join("repo");
    if repo
      .clone_repo(&profile.repo_url, &clone, &profile.branch, &auth)
      .await
      .is_err()
    {
      return Ok(cached);
    }
    let head_oid = repo
      .head_oid()
      .await
      .map_err(|_| AuthError::Storage("Git-Sync branch observation failed".into()))?;
    // The branch may advance between clone and preflight; a local HEAD alone
    // cannot prove that the captured tree is still the remote branch.
    match repo.remote_branch_oid(&profile.branch, &auth).await {
      Ok(remote) if remote == head_oid => {}
      Ok(_) => return Ok(None),
      Err(_) => return Ok(cached),
    }
    let manifest_bytes = match repo.read_file(&profile.manifest_path).await {
      Ok(bytes) if bytes.len() <= 2 * 1024 * 1024 => bytes,
      Ok(_) => {
        return Err(AuthError::InvalidInput(
          "Git-Sync manifest exceeds preflight limit".into(),
        ));
      }
      Err(GitError::NotFound(_)) => return Ok(None),
      Err(_) => return Ok(None),
    };
    let manifest: GitSyncManifest = serde_json::from_slice(&manifest_bytes)
      .map_err(|_| AuthError::InvalidInput("Git-Sync manifest is invalid".into()))?;
    let Some(observed_paths) = observed_files(&clone) else {
      return Ok(None);
    };
    let mut path_hashes = std::collections::BTreeMap::new();
    let mut document_body_hashes = std::collections::BTreeMap::new();
    let document_paths = manifest
      .documents
      .iter()
      .map(|document| document.repo_path.as_str())
      .collect::<BTreeSet<_>>();
    let overview_paths = manifest
      .overview
      .iter()
      .chain(manifest.folders.iter().filter_map(|folder| folder.overview.as_ref()))
      .map(|overview| overview.repo_path.as_str());
    for path in paths.iter().map(String::as_str).chain(overview_paths) {
      if RepoPath::new(path).is_err()
        || path
          .split('/')
          .any(|part| part.is_empty() || part == "." || part == ".git")
      {
        return Ok(None);
      }
      // The backend returns an owned Vec; bound assets can be arbitrarily
      // large. Refuse to hash a giant remote file in a preflight request.
      if std::fs::metadata(clone.join(path)).is_ok_and(|metadata| metadata.len() > 256 * 1024 * 1024) {
        return Ok(None);
      }
      match repo.read_file(path).await {
        Ok(bytes) => {
          if document_paths.contains(path) {
            let markdown = std::str::from_utf8(&bytes)
              .map_err(|_| AuthError::InvalidInput("Git-Sync document is invalid".into()))?;
            document_body_hashes.insert(
              path.to_owned(),
              myoxus_application::markdown::content_hash(
                &myoxus_application::git_sync::export::split_markdown_file(markdown).1,
              ),
            );
          }
          path_hashes.insert(path.to_owned(), hex::encode(Sha256::digest(bytes)));
        }
        Err(GitError::NotFound(_)) => {}
        Err(_) => return Ok(None),
      }
    }
    let capture = WorkspaceContentGitSyncCapture {
      remote_verified: true,
      head_oid,
      manifest,
      observed_paths,
      path_hashes,
      document_body_hashes,
    };
    store
      .save_verified_extract_capture(profile, &capture)
      .await
      .map_err(|_| AuthError::Storage("Git-Sync verified inventory unavailable".into()))?;
    Ok(Some(capture))
  }
}
