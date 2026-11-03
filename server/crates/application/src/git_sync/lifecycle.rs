// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authoritative Git-Sync profile lifecycle.
//!
//! Transports supply authorization and credential decoding/encryption. This
//! service owns profile validation, effective-policy checks, the exact-branch
//! read-only probe, and the ordering of remote validation before persistence.

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::git_sync::{AuthMethod, GitSyncProfile, ProfileId, SyncDirection, TriggerMode};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{info, instrument};
use uuid::Uuid;

use super::{GitAuth, GitError, GitRemoteProbe, GitRepositoryPort};
use crate::scheduling::cron::CronSchedule;
use myoxus_domain::scheduling::CronMisfirePolicy;

/// Stable operator-facing failure classes for read-only remote validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum GitConnectionErrorClass {
  InvalidRepositoryUrl,
  RedirectLoop,
  Authentication,
  Tls,
  MissingBranch,
  PolicyDenied,
  NetworkTimeout,
  Network,
  Repository,
}

impl fmt::Display for GitConnectionErrorClass {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(match self {
      Self::InvalidRepositoryUrl => "InvalidRepositoryUrl",
      Self::RedirectLoop => "RedirectLoop",
      Self::Authentication => "Authentication",
      Self::Tls => "Tls",
      Self::MissingBranch => "MissingBranch",
      Self::PolicyDenied => "PolicyDenied",
      Self::NetworkTimeout => "NetworkTimeout",
      Self::Network => "Network",
      Self::Repository => "Repository",
    })
  }
}

/// Safe diagnosis returned to GraphQL and CLI consumers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Error)]
#[error("{class}: {message}")]
#[serde(rename_all = "camelCase")]
pub struct GitConnectionFailure {
  pub class: GitConnectionErrorClass,
  pub message: String,
}

impl GitConnectionFailure {
  fn new(class: GitConnectionErrorClass, message: impl Into<String>) -> Self {
    Self {
      class,
      message: message.into(),
    }
  }
}

/// Effective server-owned policy used by every lifecycle transport.
#[derive(Debug, Clone)]
pub struct GitSyncLifecyclePolicy {
  pub enabled: bool,
  pub allowed_directions: HashSet<SyncDirection>,
  pub allowed_auth_methods: HashSet<AuthMethod>,
  pub allowed_hosts: HashSet<String>,
  pub auto_sync_allowed: bool,
  pub webhook_allowed: bool,
}

impl GitSyncLifecyclePolicy {
  pub fn validate_profile(&self, profile: &GitSyncProfile) -> Result<(), GitConnectionFailure> {
    self.validate_connection(&profile.repo_url, &profile.branch, profile.auth_method)?;
    if !self.allowed_directions.contains(&profile.sync_direction) {
      return Err(GitConnectionFailure::new(
        GitConnectionErrorClass::PolicyDenied,
        "sync direction is not allowed by administrator policy",
      ));
    }
    if profile.trigger_mode == TriggerMode::Polling {
      if !self.auto_sync_allowed {
        return Err(GitConnectionFailure::new(
          GitConnectionErrorClass::PolicyDenied,
          "automatic sync is disabled by administrator policy",
        ));
      }
      if !matches!(profile.polling_interval_secs, Some(interval) if interval > 0) {
        return Err(GitConnectionFailure::new(
          GitConnectionErrorClass::PolicyDenied,
          "Polling trigger mode requires a positive polling interval",
        ));
      }
    }
    if profile.trigger_mode == TriggerMode::Webhook && !self.webhook_allowed {
      return Err(GitConnectionFailure::new(
        GitConnectionErrorClass::PolicyDenied,
        "webhook sync is disabled by administrator policy",
      ));
    }
    if profile.trigger_mode == TriggerMode::Cron {
      if !self.auto_sync_allowed {
        return Err(GitConnectionFailure::new(
          GitConnectionErrorClass::PolicyDenied,
          "automatic sync is disabled by administrator policy",
        ));
      }
      let expression = profile.cron_expression.as_deref().ok_or_else(|| {
        GitConnectionFailure::new(
          GitConnectionErrorClass::PolicyDenied,
          "Cron trigger mode requires an expression",
        )
      })?;
      let timezone = profile.cron_timezone.as_deref().ok_or_else(|| {
        GitConnectionFailure::new(
          GitConnectionErrorClass::PolicyDenied,
          "Cron trigger mode requires an IANA timezone",
        )
      })?;
      CronSchedule::parse(expression, timezone)
        .map_err(|error| GitConnectionFailure::new(GitConnectionErrorClass::PolicyDenied, error.to_string()))?;
      if profile.cron_misfire_policy.is_none() {
        return Err(GitConnectionFailure::new(
          GitConnectionErrorClass::PolicyDenied,
          "Cron trigger mode requires a misfire policy",
        ));
      }
    }
    if profile.trigger_mode == TriggerMode::HistoryCapture {
      if !self.auto_sync_allowed {
        return Err(GitConnectionFailure::new(
          GitConnectionErrorClass::PolicyDenied,
          "automatic sync is disabled by administrator policy",
        ));
      }
      if profile.sync_direction == SyncDirection::GitToMyoxus {
        return Err(GitConnectionFailure::new(
          GitConnectionErrorClass::PolicyDenied,
          "history capture trigger requires an outgoing sync direction",
        ));
      }
    }

    validate_root_path(&profile.root_path)?;
    Ok(())
  }

  /// Validate only the policy dimensions relevant to a read-only connection
  /// probe. Trigger and direction policy belong to persisted profiles and must
  /// not make an otherwise valid transport diagnosis fail.
  pub fn validate_connection(
    &self,
    repo_url: &str,
    branch: &str,
    auth_method: AuthMethod,
  ) -> Result<(), GitConnectionFailure> {
    if !self.enabled {
      return Err(GitConnectionFailure::new(
        GitConnectionErrorClass::PolicyDenied,
        "Git Sync is disabled by effective administrator policy",
      ));
    }
    if !self.allowed_auth_methods.contains(&auth_method) {
      return Err(GitConnectionFailure::new(
        GitConnectionErrorClass::PolicyDenied,
        "authentication method is not allowed by administrator policy",
      ));
    }

    let host = validate_repository_url(repo_url)?;
    if !self.allowed_hosts.is_empty() && !self.allowed_hosts.contains(&host) {
      return Err(GitConnectionFailure::new(
        GitConnectionErrorClass::PolicyDenied,
        "repository host is not allowed by administrator policy",
      ));
    }
    validate_branch(branch)?;
    Ok(())
  }
}

/// Encrypted credential payload passed through to persistence.
///
/// Debug output deliberately excludes ciphertext because encrypted credentials
/// are still credential-adjacent material.
#[derive(Clone)]
pub struct EncryptedGitCredential {
  pub label: String,
  pub ciphertext: Vec<u8>,
  pub expires_at: Option<DateTime<Utc>>,
}

impl fmt::Debug for EncryptedGitCredential {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("EncryptedGitCredential")
      .field("label", &self.label)
      .field("ciphertext", &"[REDACTED]")
      .field("expires_at", &self.expires_at)
      .finish()
  }
}

/// Partial update contract. `None` preserves the persisted value.
#[derive(Debug, Clone, Default)]
pub struct GitSyncProfilePatch {
  pub repo_url: Option<String>,
  pub branch: Option<String>,
  pub root_path: Option<String>,
  pub sync_direction: Option<SyncDirection>,
  pub trigger_mode: Option<TriggerMode>,
  pub polling_interval_secs: Option<Option<i64>>,
  pub cron_expression: Option<Option<String>>,
  pub cron_timezone: Option<Option<String>>,
  pub cron_misfire_policy: Option<Option<CronMisfirePolicy>>,
  pub auth_method: Option<AuthMethod>,
  pub enabled: Option<bool>,
  pub max_mirror_storage_mb: Option<Option<i64>>,
}

impl GitSyncProfilePatch {
  pub fn apply_to(self, profile: &mut GitSyncProfile) {
    if let Some(value) = self.repo_url {
      profile.repo_url = value;
    }
    if let Some(value) = self.branch {
      profile.branch = value;
    }
    if let Some(value) = self.root_path {
      profile.root_path = value;
    }
    if let Some(value) = self.sync_direction {
      profile.sync_direction = value;
    }
    if let Some(value) = self.trigger_mode {
      profile.trigger_mode = value;
    }
    if let Some(value) = self.polling_interval_secs {
      profile.polling_interval_secs = value;
    }
    if let Some(value) = self.cron_expression {
      profile.cron_expression = value;
    }
    if let Some(value) = self.cron_timezone {
      profile.cron_timezone = value;
    }
    if let Some(value) = self.cron_misfire_policy {
      profile.cron_misfire_policy = value;
    }
    if let Some(value) = self.auth_method {
      profile.auth_method = value;
    }
    if let Some(value) = self.enabled {
      profile.enabled = value;
    }
    if let Some(value) = self.max_mirror_storage_mb {
      profile.max_mirror_storage_mb = value;
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncDeleteImpact {
  pub profile_id: ProfileId,
  pub runs: i64,
  pub document_bindings: i64,
  pub file_bindings: i64,
  pub open_conflicts: i64,
  pub credentials: i64,
}

#[derive(Debug, Error)]
pub enum GitSyncLifecycleStoreError {
  #[error("Git-Sync profile not found")]
  NotFound,
  #[error("Git-Sync profile has a running sync and cannot be changed")]
  RunningSync,
  #[error("Git-Sync lifecycle conflict: {0}")]
  Conflict(String),
  #[error("Git-Sync persistence failed: {0}")]
  Storage(String),
}

/// Persistence boundary for serialized profile lifecycle mutations.
#[async_trait]
pub trait GitSyncLifecycleStore: Send + Sync {
  async fn profile(&self, profile_id: ProfileId) -> Result<GitSyncProfile, GitSyncLifecycleStoreError>;

  async fn create_profile(
    &self,
    profile: GitSyncProfile,
    credential: EncryptedGitCredential,
  ) -> Result<GitSyncProfile, GitSyncLifecycleStoreError>;

  async fn update_profile(
    &self,
    profile: GitSyncProfile,
    credential: Option<EncryptedGitCredential>,
  ) -> Result<GitSyncProfile, GitSyncLifecycleStoreError>;

  async fn delete_impact(&self, profile_id: ProfileId) -> Result<GitSyncDeleteImpact, GitSyncLifecycleStoreError>;

  /// Rehome any shared credential and rotation row before removing the profile;
  /// a surviving Extract descendant must retain its active secret.
  async fn delete_profile(&self, profile_id: ProfileId) -> Result<(), GitSyncLifecycleStoreError>;
}

#[derive(Debug)]
pub struct CreateGitSyncProfile {
  pub workspace_id: Uuid,
  pub owner_id: Uuid,
  pub repo_url: String,
  pub branch: String,
  pub root_path: String,
  pub sync_direction: SyncDirection,
  pub trigger_mode: TriggerMode,
  pub polling_interval_secs: Option<i64>,
  pub cron_expression: Option<String>,
  pub cron_timezone: Option<String>,
  pub cron_misfire_policy: Option<CronMisfirePolicy>,
  pub auth_method: AuthMethod,
  pub enabled: bool,
  pub max_mirror_storage_mb: Option<i64>,
  pub credential: EncryptedGitCredential,
  pub remote_auth: GitAuth,
}

#[derive(Debug)]
pub struct UpdateGitSyncProfile {
  pub profile_id: ProfileId,
  pub patch: GitSyncProfilePatch,
  pub credential: Option<EncryptedGitCredential>,
  pub remote_auth: GitAuth,
}

#[derive(Clone)]
pub struct GitSyncLifecycleService {
  store: Arc<dyn GitSyncLifecycleStore>,
  repository: Arc<dyn GitRepositoryPort>,
}

impl GitSyncLifecycleService {
  pub fn new(store: Arc<dyn GitSyncLifecycleStore>, repository: Arc<dyn GitRepositoryPort>) -> Self {
    Self { store, repository }
  }

  #[instrument(skip(self, policy, command), fields(workspace_id = %command.workspace_id), err)]
  pub async fn create(
    &self,
    policy: &GitSyncLifecyclePolicy,
    command: CreateGitSyncProfile,
  ) -> Result<GitSyncProfile, GitSyncLifecycleError> {
    let now = Utc::now();
    let mut profile = GitSyncProfile {
      id: Uuid::new_v4(),
      workspace_id: command.workspace_id,
      owner_id: command.owner_id,
      repo_url: command.repo_url,
      branch: command.branch,
      root_path: command.root_path,
      manifest_path: super::export::GIT_SYNC_MANIFEST_PATH.to_string(),
      scope_revision: 0,
      sync_direction: command.sync_direction,
      trigger_mode: command.trigger_mode,
      polling_interval_secs: command.polling_interval_secs,
      cron_expression: command.cron_expression,
      cron_timezone: command.cron_timezone,
      cron_misfire_policy: command.cron_misfire_policy,
      cron_next_scheduled_at: None,
      cron_pending_misfire_scheduled_for: None,
      auth_method: command.auth_method,
      credential_id: None,
      enabled: command.enabled,
      max_mirror_storage_mb: command.max_mirror_storage_mb,
      created_at: now,
      updated_at: now,
    };
    initialize_cron_state(&mut profile, now, true)?;
    policy.validate_profile(&profile)?;
    ensure_auth_matches(profile.auth_method, &command.remote_auth)?;
    self.probe(&profile, &command.remote_auth).await?;
    let stored = self.store.create_profile(profile, command.credential).await?;
    info!(profile_id = %stored.id, workspace_id = %stored.workspace_id, "Git-Sync profile created");
    Ok(stored)
  }

  #[instrument(skip(self, policy, command), fields(profile_id = %command.profile_id), err)]
  pub async fn update(
    &self,
    policy: &GitSyncLifecyclePolicy,
    command: UpdateGitSyncProfile,
  ) -> Result<GitSyncProfile, GitSyncLifecycleError> {
    let mut profile = self.store.profile(command.profile_id).await?;
    let previous = profile.clone();
    let previous_auth_method = profile.auth_method;
    command.patch.apply_to(&mut profile);
    let schedule_changed = profile.trigger_mode != previous.trigger_mode
      || profile.cron_expression != previous.cron_expression
      || profile.cron_timezone != previous.cron_timezone
      || profile.cron_misfire_policy != previous.cron_misfire_policy
      || (profile.enabled && !previous.enabled);
    initialize_cron_state(&mut profile, Utc::now(), schedule_changed)?;
    if profile.auth_method != previous_auth_method && command.credential.is_none() {
      return Err(GitSyncLifecycleError::InvalidInput(
        "changing authentication method requires a replacement credential".to_string(),
      ));
    }
    policy.validate_profile(&profile)?;
    ensure_auth_matches(profile.auth_method, &command.remote_auth)?;
    self.probe(&profile, &command.remote_auth).await?;
    let stored = self.store.update_profile(profile, command.credential).await?;
    info!(profile_id = %stored.id, workspace_id = %stored.workspace_id, "Git-Sync profile updated");
    Ok(stored)
  }

  #[instrument(skip(self, policy, auth), fields(branch), err)]
  pub async fn test_connection(
    &self,
    policy: &GitSyncLifecyclePolicy,
    repo_url: &str,
    branch: &str,
    auth_method: AuthMethod,
    auth: &GitAuth,
  ) -> Result<GitRemoteProbe, GitSyncLifecycleError> {
    let now = Utc::now();
    let profile = GitSyncProfile {
      id: Uuid::nil(),
      workspace_id: Uuid::nil(),
      owner_id: Uuid::nil(),
      repo_url: repo_url.to_string(),
      branch: branch.to_string(),
      root_path: "content/".to_string(),
      manifest_path: super::export::GIT_SYNC_MANIFEST_PATH.to_string(),
      scope_revision: 0,
      sync_direction: SyncDirection::Bidirectional,
      trigger_mode: TriggerMode::Manual,
      polling_interval_secs: None,
      cron_expression: None,
      cron_timezone: None,
      cron_misfire_policy: None,
      cron_next_scheduled_at: None,
      cron_pending_misfire_scheduled_for: None,
      auth_method,
      credential_id: None,
      enabled: true,
      max_mirror_storage_mb: None,
      created_at: now,
      updated_at: now,
    };
    policy.validate_connection(repo_url, branch, auth_method)?;
    ensure_auth_matches(auth_method, auth)?;
    self.probe(&profile, auth).await.map_err(Into::into)
  }

  pub async fn delete_impact(&self, profile_id: ProfileId) -> Result<GitSyncDeleteImpact, GitSyncLifecycleError> {
    Ok(self.store.delete_impact(profile_id).await?)
  }

  #[instrument(skip(self), fields(%profile_id), err)]
  pub async fn delete(&self, profile_id: ProfileId) -> Result<GitSyncDeleteImpact, GitSyncLifecycleError> {
    let impact = self.store.delete_impact(profile_id).await?;
    self.store.delete_profile(profile_id).await?;
    info!(%profile_id, "Git-Sync profile deleted");
    Ok(impact)
  }

  async fn probe(&self, profile: &GitSyncProfile, auth: &GitAuth) -> Result<GitRemoteProbe, GitConnectionFailure> {
    self
      .repository
      .probe_remote(&profile.repo_url, Some(&profile.branch), auth)
      .await
      .map_err(classify_git_error)
  }
}

#[derive(Debug, Error)]
pub enum GitSyncLifecycleError {
  #[error("invalid Git-Sync lifecycle input: {0}")]
  InvalidInput(String),
  #[error(transparent)]
  Connection(#[from] GitConnectionFailure),
  #[error(transparent)]
  Store(#[from] GitSyncLifecycleStoreError),
}

fn initialize_cron_state(
  profile: &mut GitSyncProfile,
  now: DateTime<Utc>,
  schedule_changed: bool,
) -> Result<(), GitSyncLifecycleError> {
  if profile.trigger_mode != TriggerMode::Cron {
    profile.cron_expression = None;
    profile.cron_timezone = None;
    profile.cron_misfire_policy = None;
    profile.cron_next_scheduled_at = None;
    profile.cron_pending_misfire_scheduled_for = None;
    return Ok(());
  }
  let expression = profile
    .cron_expression
    .as_deref()
    .ok_or_else(|| GitSyncLifecycleError::InvalidInput("Cron trigger mode requires an expression".into()))?;
  let timezone = profile
    .cron_timezone
    .as_deref()
    .ok_or_else(|| GitSyncLifecycleError::InvalidInput("Cron trigger mode requires an IANA timezone".into()))?;
  if profile.cron_misfire_policy.is_none() {
    return Err(GitSyncLifecycleError::InvalidInput(
      "Cron trigger mode requires a misfire policy".into(),
    ));
  }
  let schedule = CronSchedule::parse(expression, timezone)
    .map_err(|error| GitSyncLifecycleError::InvalidInput(error.to_string()))?;
  profile.cron_expression = Some(schedule.expression().to_string());
  profile.cron_timezone = Some(schedule.timezone_name().to_string());
  if !profile.enabled {
    profile.cron_next_scheduled_at = None;
    profile.cron_pending_misfire_scheduled_for = None;
  } else if schedule_changed || profile.cron_next_scheduled_at.is_none() {
    profile.cron_next_scheduled_at = Some(
      schedule
        .next_after(now)
        .map_err(|error| GitSyncLifecycleError::InvalidInput(error.to_string()))?,
    );
    profile.cron_pending_misfire_scheduled_for = None;
  }
  Ok(())
}

fn ensure_auth_matches(auth_method: AuthMethod, auth: &GitAuth) -> Result<(), GitSyncLifecycleError> {
  let matches = matches!(
    (auth_method, auth),
    (AuthMethod::HttpsToken, GitAuth::HttpsToken { .. })
      | (AuthMethod::HttpsPassword, GitAuth::HttpsPassword { .. })
      | (AuthMethod::SshKey, GitAuth::SshKey { .. })
  );
  if matches {
    Ok(())
  } else {
    Err(GitSyncLifecycleError::InvalidInput(
      "credential payload does not match the selected authentication method".to_string(),
    ))
  }
}

pub fn validate_repository_url(value: &str) -> Result<String, GitConnectionFailure> {
  let value = value.trim();
  if value.is_empty() || value.contains('\0') {
    return Err(invalid_repository_url("repository URL must not be empty"));
  }

  if let Some(rest) = value.strip_prefix("https://") {
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    if authority.contains('@') {
      return Err(invalid_repository_url(
        "repository URL must not embed credentials; use the credential input",
      ));
    }
    let host = host_from_authority(authority)?;
    validate_repository_path(path)?;
    return Ok(host);
  }

  if let Some(rest) = value.strip_prefix("ssh://") {
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host_from_authority(authority)?;
    if authority
      .rsplit_once('@')
      .is_some_and(|(user, _)| user.trim().is_empty() || user.contains(':'))
    {
      return Err(invalid_repository_url(
        "SSH repository URL must not embed a password or empty user",
      ));
    }
    validate_repository_path(path)?;
    return Ok(host);
  }

  if let Some((authority, path)) = value.split_once(':')
    && let Some((user, host)) = authority.split_once('@')
  {
    if user.trim().is_empty() || host.trim().is_empty() || user.contains(':') || host.contains(':') {
      return Err(invalid_repository_url(
        "scp-like repository URL must use user@host:path syntax",
      ));
    }
    validate_repository_path(path)?;
    return Ok(host.to_ascii_lowercase());
  }

  Err(invalid_repository_url(
    "repository URL must use https://, ssh://, or user@host:path syntax",
  ))
}

fn host_from_authority(authority: &str) -> Result<String, GitConnectionFailure> {
  let authority = authority.rsplit('@').next().unwrap_or(authority);
  let host = if let Some(stripped) = authority.strip_prefix('[') {
    stripped.split(']').next().unwrap_or_default()
  } else {
    authority.split(':').next().unwrap_or_default()
  };
  let host = host.trim();
  if host.is_empty() {
    return Err(invalid_repository_url("repository URL must contain a host"));
  }
  Ok(host.to_ascii_lowercase())
}

fn validate_repository_path(path: &str) -> Result<(), GitConnectionFailure> {
  if path.trim_matches('/').is_empty() {
    return Err(invalid_repository_url("repository URL must contain a repository path"));
  }
  Ok(())
}

pub(crate) fn validate_branch(branch: &str) -> Result<(), GitConnectionFailure> {
  let branch = branch.trim();
  let invalid = branch.is_empty()
    || branch.starts_with('-')
    || branch.starts_with('/')
    || branch.ends_with('/')
    || branch.ends_with('.')
    || branch.contains("..")
    || branch.contains("@{")
    || branch.contains("//")
    || branch
      .chars()
      .any(|character| character.is_control() || " ~^:?*[\\".contains(character));
  if invalid {
    return Err(invalid_repository_url("branch is not a valid Git branch name"));
  }
  Ok(())
}

fn validate_root_path(root_path: &str) -> Result<(), GitConnectionFailure> {
  let path = root_path.trim().trim_end_matches('/');
  if path.is_empty()
    || path.starts_with('/')
    || path.contains('\\')
    || path.contains('\0')
    || path.split('/').any(|segment| segment.is_empty() || segment == "..")
  {
    return Err(invalid_repository_url(
      "root path must be a non-empty relative repository path",
    ));
  }
  Ok(())
}

fn invalid_repository_url(message: impl Into<String>) -> GitConnectionFailure {
  GitConnectionFailure::new(GitConnectionErrorClass::InvalidRepositoryUrl, message)
}

fn classify_git_error(error: GitError) -> GitConnectionFailure {
  let message = error.to_string();
  let lower = message.to_ascii_lowercase();
  let class = match error {
    GitError::Auth(_) => GitConnectionErrorClass::Authentication,
    GitError::Tls(_) => GitConnectionErrorClass::Tls,
    GitError::Network(_) if lower.contains("redirect") => GitConnectionErrorClass::RedirectLoop,
    GitError::Network(_) if lower.contains("timed out") || lower.contains("timeout") => {
      GitConnectionErrorClass::NetworkTimeout
    }
    GitError::Network(_) => GitConnectionErrorClass::Network,
    GitError::NotFound(_) => GitConnectionErrorClass::MissingBranch,
    GitError::Repository(_) if lower.contains("did not advertise refs/heads/") || lower.contains("branch") => {
      GitConnectionErrorClass::MissingBranch
    }
    GitError::Repository(_) | GitError::Conflict(_) | GitError::Internal(_) => GitConnectionErrorClass::Repository,
  };
  GitConnectionFailure::new(class, message)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;
  use std::sync::Mutex;

  #[derive(Default)]
  struct FakeRepository {
    probes: Mutex<Vec<(String, Option<String>)>>,
    failure: Mutex<Option<GitConnectionFailure>>,
  }

  #[async_trait]
  impl GitRepositoryPort for FakeRepository {
    async fn probe_remote(&self, url: &str, branch: Option<&str>, _auth: &GitAuth) -> Result<GitRemoteProbe, GitError> {
      self
        .probes
        .lock()
        .unwrap()
        .push((url.to_string(), branch.map(str::to_string)));
      if let Some(failure) = self.failure.lock().unwrap().take() {
        return Err(match failure.class {
          GitConnectionErrorClass::Authentication => GitError::Auth(failure.message),
          GitConnectionErrorClass::Tls => GitError::Tls(failure.message),
          GitConnectionErrorClass::NetworkTimeout => GitError::Network("operation timed out".into()),
          GitConnectionErrorClass::MissingBranch => {
            GitError::Repository("remote did not advertise refs/heads/main".into())
          }
          _ => GitError::Repository(failure.message),
        });
      }
      Ok(GitRemoteProbe {
        branch: branch.map(str::to_string),
        observed_remote_oid: Some("a".repeat(40)),
      })
    }

    async fn clone_repo(&self, _: &str, _: &Path, _: &str, _: &GitAuth) -> Result<(), GitError> {
      unreachable!()
    }
    async fn open_repo(&self, _: &Path) -> Result<(), GitError> {
      unreachable!()
    }
    async fn fetch(&self, _: &GitAuth) -> Result<(), GitError> {
      unreachable!()
    }
    async fn checkout_branch(&self, _: &str) -> Result<(), GitError> {
      unreachable!()
    }
    async fn reset_to_remote(&self, _: &str) -> Result<String, GitError> {
      unreachable!()
    }
    async fn head_oid(&self) -> Result<String, GitError> {
      unreachable!()
    }
    async fn remote_branch_oid(&self, _: &str, _: &GitAuth) -> Result<String, GitError> {
      unreachable!()
    }
    async fn changed_files(
      &self,
      _: Option<&str>,
      _: Option<&str>,
    ) -> Result<Vec<super::super::ChangedFile>, GitError> {
      unreachable!()
    }
    async fn read_file(&self, _: &str) -> Result<Vec<u8>, GitError> {
      unreachable!()
    }
    async fn write_file(&self, _: &str, _: &[u8]) -> Result<(), GitError> {
      unreachable!()
    }
    async fn delete_file(&self, _: &str) -> Result<(), GitError> {
      unreachable!()
    }
    async fn rename_file(&self, _: &str, _: &str) -> Result<(), GitError> {
      unreachable!()
    }
    async fn commit(&self, _: &str, _: &str, _: &str) -> Result<String, GitError> {
      unreachable!()
    }
    async fn push(&self, _: &str, _: &str, _: &GitAuth) -> Result<super::super::backend::GitPushReceipt, GitError> {
      unreachable!()
    }
  }

  #[derive(Default)]
  struct FakeStore {
    profiles: Mutex<Vec<GitSyncProfile>>,
  }

  #[async_trait]
  impl GitSyncLifecycleStore for FakeStore {
    async fn profile(&self, profile_id: ProfileId) -> Result<GitSyncProfile, GitSyncLifecycleStoreError> {
      self
        .profiles
        .lock()
        .unwrap()
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or(GitSyncLifecycleStoreError::NotFound)
    }

    async fn create_profile(
      &self,
      mut profile: GitSyncProfile,
      _: EncryptedGitCredential,
    ) -> Result<GitSyncProfile, GitSyncLifecycleStoreError> {
      profile.credential_id = Some(Uuid::new_v4());
      self.profiles.lock().unwrap().push(profile.clone());
      Ok(profile)
    }

    async fn update_profile(
      &self,
      profile: GitSyncProfile,
      _: Option<EncryptedGitCredential>,
    ) -> Result<GitSyncProfile, GitSyncLifecycleStoreError> {
      let mut profiles = self.profiles.lock().unwrap();
      let existing = profiles
        .iter_mut()
        .find(|candidate| candidate.id == profile.id)
        .ok_or(GitSyncLifecycleStoreError::NotFound)?;
      *existing = profile.clone();
      Ok(profile)
    }

    async fn delete_impact(&self, profile_id: ProfileId) -> Result<GitSyncDeleteImpact, GitSyncLifecycleStoreError> {
      Ok(GitSyncDeleteImpact {
        profile_id,
        runs: 0,
        document_bindings: 0,
        file_bindings: 0,
        open_conflicts: 0,
        credentials: 1,
      })
    }

    async fn delete_profile(&self, profile_id: ProfileId) -> Result<(), GitSyncLifecycleStoreError> {
      self.profiles.lock().unwrap().retain(|profile| profile.id != profile_id);
      Ok(())
    }
  }

  fn policy() -> GitSyncLifecyclePolicy {
    GitSyncLifecyclePolicy {
      enabled: true,
      allowed_directions: HashSet::from([
        SyncDirection::Bidirectional,
        SyncDirection::MyoxusToGit,
        SyncDirection::GitToMyoxus,
      ]),
      allowed_auth_methods: HashSet::from([AuthMethod::HttpsToken, AuthMethod::HttpsPassword, AuthMethod::SshKey]),
      allowed_hosts: HashSet::from(["git.example.test".to_string()]),
      auto_sync_allowed: true,
      webhook_allowed: true,
    }
  }

  fn create_command() -> CreateGitSyncProfile {
    CreateGitSyncProfile {
      workspace_id: Uuid::new_v4(),
      owner_id: Uuid::new_v4(),
      repo_url: "https://git.example.test/team/repository.git".into(),
      branch: "main".into(),
      root_path: "content/".into(),
      sync_direction: SyncDirection::Bidirectional,
      trigger_mode: TriggerMode::Manual,
      polling_interval_secs: None,
      cron_expression: None,
      cron_timezone: None,
      cron_misfire_policy: None,
      auth_method: AuthMethod::HttpsToken,
      enabled: true,
      max_mirror_storage_mb: None,
      credential: EncryptedGitCredential {
        label: "default".into(),
        ciphertext: vec![1, 2, 3],
        expires_at: None,
      },
      remote_auth: GitAuth::HttpsToken {
        username: "operator".into(),
        token: "secret".into(),
      },
    }
  }

  #[tokio::test]
  async fn create_probes_exact_branch_before_persisting() {
    let store = Arc::new(FakeStore::default());
    let repository = Arc::new(FakeRepository::default());
    let service = GitSyncLifecycleService::new(store.clone(), repository.clone());

    let created = service.create(&policy(), create_command()).await.unwrap();

    assert_eq!(store.profiles.lock().unwrap().len(), 1);
    assert!(created.credential_id.is_some());
    assert_eq!(
      repository.probes.lock().unwrap().as_slice(),
      &[(
        "https://git.example.test/team/repository.git".to_string(),
        Some("main".to_string())
      )]
    );
  }

  #[tokio::test]
  async fn failed_exact_branch_probe_leaves_no_profile() {
    let store = Arc::new(FakeStore::default());
    let repository = Arc::new(FakeRepository::default());
    *repository.failure.lock().unwrap() = Some(GitConnectionFailure::new(
      GitConnectionErrorClass::MissingBranch,
      "missing branch",
    ));
    let service = GitSyncLifecycleService::new(store.clone(), repository);

    let error = service.create(&policy(), create_command()).await.unwrap_err();

    assert!(matches!(
      error,
      GitSyncLifecycleError::Connection(GitConnectionFailure {
        class: GitConnectionErrorClass::MissingBranch,
        ..
      })
    ));
    assert!(store.profiles.lock().unwrap().is_empty());
  }

  #[tokio::test]
  async fn connection_probe_is_independent_of_profile_direction_policy() {
    let store = Arc::new(FakeStore::default());
    let repository = Arc::new(FakeRepository::default());
    let service = GitSyncLifecycleService::new(store, repository.clone());
    let mut connection_policy = policy();
    connection_policy.allowed_directions.clear();

    let probe = service
      .test_connection(
        &connection_policy,
        "https://git.example.test/team/repository.git",
        "main",
        AuthMethod::HttpsToken,
        &GitAuth::HttpsToken {
          username: "operator".into(),
          token: "secret".into(),
        },
      )
      .await
      .unwrap();

    assert_eq!(probe.observed_remote_oid, Some("a".repeat(40)));
    assert_eq!(repository.probes.lock().unwrap().len(), 1);
  }

  #[tokio::test]
  async fn unrelated_profile_update_preserves_cron_cursor_and_schedule_change_resets_it() {
    let store = Arc::new(FakeStore::default());
    let repository = Arc::new(FakeRepository::default());
    let service = GitSyncLifecycleService::new(store.clone(), repository);
    let mut command = create_command();
    command.trigger_mode = TriggerMode::Cron;
    command.cron_expression = Some("0 * * * *".into());
    command.cron_timezone = Some("Europe/Berlin".into());
    command.cron_misfire_policy = Some(CronMisfirePolicy::RunOnce);
    let created = service.create(&policy(), command).await.unwrap();
    let original_next = DateTime::parse_from_rfc3339("2099-01-01T05:00:00Z")
      .unwrap()
      .with_timezone(&Utc);
    let pending = original_next - chrono::Duration::minutes(30);
    {
      let mut profiles = store.profiles.lock().unwrap();
      profiles[0].cron_next_scheduled_at = Some(original_next);
      profiles[0].cron_pending_misfire_scheduled_for = Some(pending);
    }
    let unchanged = service
      .update(
        &policy(),
        UpdateGitSyncProfile {
          profile_id: created.id,
          patch: GitSyncProfilePatch {
            repo_url: None,
            branch: None,
            root_path: None,
            sync_direction: None,
            trigger_mode: None,
            polling_interval_secs: None,
            cron_expression: None,
            cron_timezone: None,
            cron_misfire_policy: None,
            auth_method: None,
            enabled: None,
            max_mirror_storage_mb: Some(Some(2048)),
          },
          credential: None,
          remote_auth: GitAuth::HttpsToken {
            username: "operator".into(),
            token: "secret".into(),
          },
        },
      )
      .await
      .unwrap();
    assert_eq!(unchanged.cron_next_scheduled_at, Some(original_next));
    assert_eq!(unchanged.cron_pending_misfire_scheduled_for, Some(pending));

    let changed = service
      .update(
        &policy(),
        UpdateGitSyncProfile {
          profile_id: created.id,
          patch: GitSyncProfilePatch {
            repo_url: None,
            branch: None,
            root_path: None,
            sync_direction: None,
            trigger_mode: None,
            polling_interval_secs: None,
            cron_expression: Some(Some("0 */2 * * *".into())),
            cron_timezone: None,
            cron_misfire_policy: None,
            auth_method: None,
            enabled: None,
            max_mirror_storage_mb: None,
          },
          credential: None,
          remote_auth: GitAuth::HttpsToken {
            username: "operator".into(),
            token: "secret".into(),
          },
        },
      )
      .await
      .unwrap();
    assert_ne!(changed.cron_next_scheduled_at, Some(original_next));
    assert!(changed.cron_pending_misfire_scheduled_for.is_none());
  }

  #[test]
  fn rejects_group_url_embedded_credentials_and_invalid_branch() {
    assert_eq!(
      validate_repository_url("https://git.example.test/team").unwrap(),
      "git.example.test"
    );
    assert!(validate_repository_url("https://git.example.test").is_err());
    assert!(validate_repository_url("https://user:secret@git.example.test/team/repo.git").is_err());
    assert!(validate_branch("feature/good-name").is_ok());
    assert!(validate_branch("refs/heads/main..bad").is_err());
  }

  #[test]
  fn encrypted_credential_debug_never_contains_ciphertext() {
    let credential = EncryptedGitCredential {
      label: "default".into(),
      ciphertext: b"credential-marker".to_vec(),
      expires_at: None,
    };
    let debug = format!("{credential:?}");
    assert!(!debug.contains("credential-marker"));
    assert!(debug.contains("[REDACTED]"));
  }
}
