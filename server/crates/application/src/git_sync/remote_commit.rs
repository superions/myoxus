// SPDX-License-Identifier: AGPL-3.0-or-later
//! Guarded commit, rebase and authenticated remote-receipt orchestration.

use std::time::Duration;

use tracing::{debug, info, warn};
use uuid::Uuid;

use myoxus_domain::git_sync::GitSyncProfile;

use super::backend::{GitAuth, GitError, GitPushReceipt, GitRemoteRefStatus, GitRepositoryPort};

const REMOTE_RESET_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub struct CommitTrailers {
  pub workspace_id: Uuid,
  pub run_id: Uuid,
  pub profile_id: Uuid,
  pub direction: String,
  pub docs_pushed: u32,
  pub docs_pulled: u32,
  pub files_pushed: u32,
  pub files_pulled: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum RemoteCommitError {
  #[error("{context}: {source}")]
  Git {
    context: String,
    #[source]
    source: GitError,
  },
  #[error("{0}")]
  Retryable(String),
  #[error("{message}")]
  OutcomeUnknown { message: String, intended_oid: String },
}

impl RemoteCommitError {
  pub fn is_retryable(&self) -> bool {
    matches!(
      self,
      Self::Retryable(_)
        | Self::Git {
          source: GitError::Network(_) | GitError::Conflict(_),
          ..
        }
    )
  }
}

fn git_error(context: impl Into<String>, source: GitError) -> RemoteCommitError {
  RemoteCommitError::Git {
    context: context.into(),
    source,
  }
}

fn format_commit_message(trailers: &CommitTrailers) -> String {
  let total_docs = trailers.docs_pushed + trailers.docs_pulled;
  let total_files = trailers.files_pushed + trailers.files_pulled;
  format!(
    "sync: {total_docs} docs, {total_files} files\n\n\
     Myoxus-Workspace: {workspace}\n\
     Myoxus-Run: {run}\n\
     Myoxus-Profile: {profile}\n\
     Myoxus-Direction: {direction}\n\
     Myoxus-Docs-Pushed: {docs_pushed}\n\
     Myoxus-Docs-Pulled: {docs_pulled}\n\
     Myoxus-Files-Pushed: {files_pushed}\n\
     Myoxus-Files-Pulled: {files_pulled}",
    workspace = trailers.workspace_id,
    run = trailers.run_id,
    profile = trailers.profile_id,
    direction = trailers.direction,
    docs_pushed = trailers.docs_pushed,
    docs_pulled = trailers.docs_pulled,
    files_pushed = trailers.files_pushed,
    files_pulled = trailers.files_pulled,
  )
}

async fn reset_to_remote(
  git_repo: &dyn GitRepositoryPort,
  branch: &str,
  context: &str,
) -> Result<String, RemoteCommitError> {
  match tokio::time::timeout(REMOTE_RESET_TIMEOUT, git_repo.reset_to_remote(branch)).await {
    Ok(Ok(oid)) => Ok(oid),
    Ok(Err(error)) => Err(git_error(context, error)),
    Err(_) => Err(RemoteCommitError::Retryable(format!(
      "{context} timed out after {}s",
      REMOTE_RESET_TIMEOUT.as_secs()
    ))),
  }
}

fn receipt_matches(receipt: &GitPushReceipt, branch: &str, intended_oid: &str) -> bool {
  receipt.branch == branch
    && receipt.remote_ref_status == GitRemoteRefStatus::Updated
    && receipt.observed_remote_oid == intended_oid
    && receipt.local_commit_oid == intended_oid
}

async fn observe_failed_push(
  git_repo: &dyn GitRepositoryPort,
  profile: &GitSyncProfile,
  auth: &GitAuth,
  intended_oid: &str,
  push_failure: &str,
) -> Result<Option<GitPushReceipt>, RemoteCommitError> {
  match git_repo.remote_branch_oid(&profile.branch, auth).await {
    Ok(observed_remote_oid) if observed_remote_oid == intended_oid => Ok(Some(GitPushReceipt {
      branch: profile.branch.clone(),
      local_commit_oid: intended_oid.to_string(),
      remote_ref_status: GitRemoteRefStatus::AlreadyCurrent,
      observed_remote_oid,
    })),
    Ok(observed_remote_oid) => {
      debug!(%intended_oid, %observed_remote_oid, "failed push did not install intended commit");
      Ok(None)
    }
    Err(observation_error) => Err(RemoteCommitError::OutcomeUnknown {
      message: format!(
        "push returned `{push_failure}` and authenticated remote observation failed: {observation_error}"
      ),
      intended_oid: intended_oid.to_string(),
    }),
  }
}

/// Commit the prepared working tree and return only authenticated branch truth.
///
/// A rejected push is rebased from a byte snapshot of the prepared diff. The
/// receipt may therefore carry a different final OID than the first local
/// commit; callers must bind persistence only from the returned receipt.
#[allow(clippy::too_many_arguments)]
pub async fn commit_and_push(
  git_repo: &dyn GitRepositoryPort,
  profile: &GitSyncProfile,
  auth: &GitAuth,
  commit_author_name: &str,
  commit_author_email: &str,
  push_max_retries: u32,
  trailers: &CommitTrailers,
) -> Result<Option<GitPushReceipt>, RemoteCommitError> {
  let message = format_commit_message(trailers);
  let pending = git_repo
    .changed_files(None, None)
    .await
    .map_err(|error| git_error("inspect working tree before commit", error))?;
  if pending.is_empty() {
    return Ok(None);
  }

  let mut snapshots = Vec::with_capacity(pending.len());
  for changed in &pending {
    match git_repo.read_file(&changed.path).await {
      Ok(content) => snapshots.push((changed.path.clone(), Some(content))),
      Err(GitError::NotFound(_)) => snapshots.push((changed.path.clone(), None)),
      Err(error) => {
        return Err(git_error(
          format!("snapshot changed file {} before commit", changed.path),
          error,
        ));
      }
    }
  }

  let first_oid = git_repo
    .commit(&message, commit_author_name, commit_author_email)
    .await
    .map_err(|error| git_error("commit non-empty working tree", error))?;
  info!(oid = %first_oid, "commit created, pushing to remote");

  match git_repo.push(&profile.branch, &first_oid, auth).await {
    Ok(receipt) if receipt_matches(&receipt, &profile.branch, &first_oid) => return Ok(Some(receipt)),
    Ok(receipt) => {
      warn!(
        intended_oid = %first_oid,
        local_receipt_oid = %receipt.local_commit_oid,
        observed_remote_oid = %receipt.observed_remote_oid,
        "push receipt did not prove intended remote branch update"
      );
      if let Some(verified) = observe_failed_push(git_repo, profile, auth, &first_oid, "invalid push receipt").await? {
        return Ok(Some(verified));
      }
    }
    Err(error) => {
      warn!(oid = %first_oid, %error, "push rejected, fetching and retrying");
      if let Some(verified) = observe_failed_push(git_repo, profile, auth, &first_oid, &error.to_string()).await? {
        return Ok(Some(verified));
      }
    }
  }

  for attempt in 1..=push_max_retries {
    git_repo.fetch(auth).await.map_err(|error| {
      RemoteCommitError::Retryable(format!(
        "push rejected and retry fetch failed on attempt {attempt} (commit {first_oid} is local-only): {error}"
      ))
    })?;
    reset_to_remote(git_repo, &profile.branch, "reset local mirror before rebase").await?;

    for (path, content) in &snapshots {
      let result = match content {
        Some(content) => git_repo.write_file(path, content).await,
        None => match git_repo.delete_file(path).await {
          Ok(()) | Err(GitError::NotFound(_)) => Ok(()),
          Err(error) => Err(error),
        },
      };
      if let Err(error) = result {
        reset_to_remote(git_repo, &profile.branch, "reset after rebase write failure").await?;
        return Err(RemoteCommitError::Retryable(format!(
          "rebase failed to reapply {path} on attempt {attempt}: {error}"
        )));
      }
    }

    let rebased_changes = match git_repo.changed_files(None, None).await {
      Ok(changes) => changes,
      Err(error) => {
        reset_to_remote(
          git_repo,
          &profile.branch,
          "reset after rebased working-tree inspection failure",
        )
        .await?;
        return Err(git_error(
          format!("inspect rebased working tree on attempt {attempt}"),
          error,
        ));
      }
    };
    if rebased_changes.is_empty() {
      let observed_remote_oid = git_repo
        .remote_branch_oid(&profile.branch, auth)
        .await
        .map_err(|error| git_error("observe remote after no-diff rebase", error))?;
      let local_commit_oid = git_repo
        .head_oid()
        .await
        .map_err(|error| git_error("read HEAD after no-diff rebase", error))?;
      if local_commit_oid != observed_remote_oid {
        return Err(RemoteCommitError::Retryable(format!(
          "no-diff rebase ended with local HEAD {local_commit_oid}, but remote advertises {observed_remote_oid}"
        )));
      }
      return Ok(Some(GitPushReceipt {
        branch: profile.branch.clone(),
        local_commit_oid,
        remote_ref_status: GitRemoteRefStatus::AlreadyCurrent,
        observed_remote_oid,
      }));
    }

    let rebased_oid = match git_repo.commit(&message, commit_author_name, commit_author_email).await {
      Ok(oid) => oid,
      Err(error) => {
        reset_to_remote(git_repo, &profile.branch, "reset after rebase commit failure").await?;
        return Err(RemoteCommitError::Retryable(format!(
          "re-commit after rebase failed on attempt {attempt}: {error}"
        )));
      }
    };
    match git_repo.push(&profile.branch, &rebased_oid, auth).await {
      Ok(receipt) if receipt_matches(&receipt, &profile.branch, &rebased_oid) => return Ok(Some(receipt)),
      Ok(receipt) => {
        if let Some(verified) =
          observe_failed_push(git_repo, profile, auth, &rebased_oid, "invalid retry push receipt").await?
        {
          return Ok(Some(verified));
        }
        if attempt == push_max_retries {
          reset_to_remote(git_repo, &profile.branch, "reset after remote receipt mismatch").await?;
          return Err(RemoteCommitError::Retryable(format!(
            "remote branch verification failed after push: intended {rebased_oid}, observed {}",
            receipt.observed_remote_oid
          )));
        }
      }
      Err(error) => {
        if let Some(verified) = observe_failed_push(git_repo, profile, auth, &rebased_oid, &error.to_string()).await? {
          return Ok(Some(verified));
        }
        if attempt == push_max_retries {
          reset_to_remote(git_repo, &profile.branch, "reset after exhausted push retries").await?;
          return Err(RemoteCommitError::Retryable(format!(
            "push rejected by remote after rebase; will re-sync on next run: {error}"
          )));
        }
      }
    }
  }

  reset_to_remote(git_repo, &profile.branch, "reset after push rejection").await?;
  Err(RemoteCommitError::Retryable(
    "push rejected by remote; push_max_retries is 0".to_string(),
  ))
}
