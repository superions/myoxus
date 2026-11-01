// SPDX-License-Identifier: AGPL-3.0-or-later
//! One repository/branch ownership boundary shared by all Git-Sync writers.

use async_trait::async_trait;
use std::{fmt, sync::Arc};
use thiserror::Error;

use super::lifecycle::{validate_branch, validate_repository_url};

/// Exact configured repository spelling and branch, not an inferred URL alias.
/// URL userinfo and query/fragment credentials are refused. Callers re-read
/// the profile after acquisition before acting on an earlier preview.
#[derive(Clone)]
pub struct GitSyncRepositoryScope {
  repo_url: String,
  branch: String,
}

impl GitSyncRepositoryScope {
  pub fn new(repo_url: &str, branch: &str) -> Result<Self, GitSyncCoordinationError> {
    // Git URLs do not need query strings or fragments. Refuse them rather
    // than hashing a potentially secret-bearing URL into an advisory key.
    if repo_url.contains('?') || repo_url.contains('#') || repo_url.chars().any(char::is_control) {
      return Err(GitSyncCoordinationError::InvalidScope);
    }
    if let Some(path) = repo_url.strip_prefix("file://") {
      // Trusted database-direct CLI fixtures already use local bare remotes.
      // This does not change lifecycle/API admission for new profiles.
      if !path.starts_with('/') || path.starts_with("//") || path == "/" {
        return Err(GitSyncCoordinationError::InvalidScope);
      }
    } else {
      validate_repository_url(repo_url).map_err(|_| GitSyncCoordinationError::InvalidScope)?;
    }
    validate_branch(branch).map_err(|_| GitSyncCoordinationError::InvalidScope)?;
    Ok(Self {
      repo_url: repo_url.to_owned(),
      branch: branch.to_owned(),
    })
  }

  pub fn matches(&self, repo_url: &str, branch: &str) -> bool {
    self.repo_url == repo_url && self.branch == branch
  }

  /// The byte-length prefix separates the exact repository spelling from the
  /// branch. PostgreSQL text cannot contain NUL; the key never enters logs,
  /// receipts, or queue messages.
  pub fn advisory_key(&self) -> String {
    format!(
      "git-sync-repository-branch/{}/{}{}",
      self.repo_url.len(),
      self.repo_url,
      self.branch
    )
  }
}

#[derive(Debug, Error)]
pub enum GitSyncCoordinationError {
  #[error("Git-Sync repository or branch is invalid")]
  InvalidScope,
  #[error("Git-Sync repository branch is busy; retry after the other writer completes")]
  Busy,
  #[error("Git-Sync repository branch ownership was lost")]
  Lost,
  #[error("Git-Sync repository branch coordination is unavailable")]
  Unavailable,
}

/// The session must remain alive until authenticated remote observation and
/// durable receipt readback finish. Dropping without release closes the session.
#[async_trait]
pub trait GitSyncRepositoryGuard: Send {
  async fn ensure_owned(&mut self) -> Result<(), GitSyncCoordinationError>;
  async fn release(self: Box<Self>) -> Result<(), GitSyncCoordinationError>;
}

#[async_trait]
pub trait GitSyncRepositoryCoordination: Send + Sync {
  async fn acquire(
    &self,
    scope: &GitSyncRepositoryScope,
  ) -> Result<Box<dyn GitSyncRepositoryGuard>, GitSyncCoordinationError>;
}

/// Shared with native Git operations so cancelling an async caller cannot
/// free repository ownership while its libgit2 worker is still active.
pub struct GitSyncNativeOwnership(tokio::sync::Mutex<Box<dyn GitSyncRepositoryGuard>>);

impl GitSyncNativeOwnership {
  pub fn new(guard: Box<dyn GitSyncRepositoryGuard>) -> Arc<Self> {
    Arc::new(Self(tokio::sync::Mutex::new(guard)))
  }

  pub async fn ensure_owned(&self) -> Result<(), GitSyncCoordinationError> {
    self.0.lock().await.ensure_owned().await
  }
}

impl fmt::Debug for GitSyncNativeOwnership {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("GitSyncNativeOwnership")
  }
}
