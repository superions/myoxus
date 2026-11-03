// SPDX-License-Identifier: AGPL-3.0-or-later
//! Provider-neutral ownership for Git-Sync token rotation.
//!
//! This module owns admission and lifecycle transitions. Provider endpoints,
//! authentication headers and response formats stay in infrastructure
//! adapters. Credential plaintext is represented only by redacted-debug value
//! objects while an admitted operation is running.

use std::{fmt, sync::Arc};

use async_trait::async_trait;
use chrono::{DateTime, Days, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use super::EncryptedGitCredential;

pub const MIN_ROTATION_DAYS: u16 = 1;
pub const MAX_ROTATION_DAYS: u16 = 365;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum GitTokenRotationProviderKind {
  GitLab,
}

impl fmt::Display for GitTokenRotationProviderKind {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(match self {
      Self::GitLab => "GitLab",
    })
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum GitTokenRotationState {
  Configured,
  Rotating,
  Completed,
  Failed,
  ManualIntervention,
}

impl fmt::Display for GitTokenRotationState {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(match self {
      Self::Configured => "Configured",
      Self::Rotating => "Rotating",
      Self::Completed => "Completed",
      Self::Failed => "Failed",
      Self::ManualIntervention => "ManualIntervention",
    })
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitTokenRotationConfiguration {
  pub provider: GitTokenRotationProviderKind,
  pub enabled: bool,
  pub renew_before_days: u16,
  pub requested_lifetime_days: u16,
}

impl GitTokenRotationConfiguration {
  pub fn validate(&self) -> Result<(), GitTokenRotationError> {
    for (name, value) in [
      ("renew_before_days", self.renew_before_days),
      ("requested_lifetime_days", self.requested_lifetime_days),
    ] {
      if !(MIN_ROTATION_DAYS..=MAX_ROTATION_DAYS).contains(&value) {
        return Err(GitTokenRotationError::InvalidConfiguration(format!(
          "{name} must be between {MIN_ROTATION_DAYS} and {MAX_ROTATION_DAYS}"
        )));
      }
    }
    if self.renew_before_days >= self.requested_lifetime_days {
      return Err(GitTokenRotationError::InvalidConfiguration(
        "renew_before_days must be smaller than requested_lifetime_days".into(),
      ));
    }
    Ok(())
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTokenRotationStatus {
  /// Profile that stewards this credential and its single rotation row. A
  /// fenced Extract descendant may read the same status via its active pointer.
  pub profile_id: Uuid,
  pub provider: GitTokenRotationProviderKind,
  pub enabled: bool,
  pub renew_before_days: u16,
  pub requested_lifetime_days: u16,
  pub state: GitTokenRotationState,
  pub latest_attempt_id: Option<Uuid>,
  pub admitted_credential_id: Option<Uuid>,
  pub current_credential_expires_at: Option<DateTime<Utc>>,
  pub last_attempt_at: Option<DateTime<Utc>>,
  pub last_success_at: Option<DateTime<Utc>>,
  pub diagnosis: Option<String>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl GitTokenRotationStatus {
  pub fn next_attempt_at(&self) -> Option<DateTime<Utc>> {
    if !self.enabled
      || matches!(
        self.state,
        GitTokenRotationState::Rotating | GitTokenRotationState::ManualIntervention
      )
    {
      return None;
    }
    if self.state == GitTokenRotationState::Failed {
      return self.last_attempt_at.and_then(|attempt| {
        attempt
          .date_naive()
          .succ_opt()?
          .and_hms_opt(0, 0, 0)
          .map(|value| DateTime::from_naive_utc_and_offset(value, Utc))
      });
    }
    self
      .current_credential_expires_at
      .and_then(|expiry| expiry.checked_sub_days(Days::new(u64::from(self.renew_before_days))))
  }
}

/// Secret-bearing HTTPS credential with deliberately redacted debug output.
#[derive(Clone)]
pub struct GitTokenCredential {
  /// Preserve the stored optional username shape exactly. GitLab authenticates
  /// the REST request with the token itself; the username is retained only for
  /// the replacement Git credential.
  pub username: Option<String>,
  pub token: String,
}

impl fmt::Debug for GitTokenCredential {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter
      .debug_struct("GitTokenCredential")
      .field("username", &self.username)
      .field("token", &"[REDACTED]")
      .finish()
  }
}

/// Persisted admission data. Ciphertext remains credential-adjacent and is
/// therefore omitted from debug output just like the lifecycle credential.
#[derive(Clone)]
pub struct GitTokenRotationAdmission {
  pub profile_id: Uuid,
  pub workspace_id: Uuid,
  pub repository_url: String,
  pub provider: GitTokenRotationProviderKind,
  pub attempt_id: Uuid,
  pub credential_id: Uuid,
  pub credential_label: String,
  pub encrypted_credential: Vec<u8>,
  pub requested_expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTokenRotationAttempt {
  pub profile_id: Uuid,
  pub attempt_id: Uuid,
}

impl fmt::Debug for GitTokenRotationAdmission {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter
      .debug_struct("GitTokenRotationAdmission")
      .field("profile_id", &self.profile_id)
      .field("workspace_id", &self.workspace_id)
      .field("repository_url", &self.repository_url)
      .field("provider", &self.provider)
      .field("attempt_id", &self.attempt_id)
      .field("credential_id", &self.credential_id)
      .field("credential_label", &self.credential_label)
      .field("encrypted_credential", &"[REDACTED]")
      .field("requested_expires_at", &self.requested_expires_at)
      .finish()
  }
}

#[derive(Debug)]
pub struct GitTokenRotationProviderRequest {
  pub profile_id: Uuid,
  pub workspace_id: Uuid,
  pub repository_url: String,
  pub credential: GitTokenCredential,
  pub requested_expires_at: DateTime<Utc>,
}

pub struct GitTokenRotationProviderResult {
  pub replacement_token: String,
  pub expires_at: DateTime<Utc>,
}

impl fmt::Debug for GitTokenRotationProviderResult {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter
      .debug_struct("GitTokenRotationProviderResult")
      .field("replacement_token", &"[REDACTED]")
      .field("expires_at", &self.expires_at)
      .finish()
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitTokenRotationProviderFailureKind {
  /// The adapter proved that no request containing the active token was sent.
  BeforeRequest,
  /// Rejection or indeterminate transport outcome after transmission. Because
  /// providers may revoke immediately, this must never be retried.
  ManualIntervention,
}

#[derive(Debug, Error)]
#[error("token rotation provider failed ({kind:?}): {diagnosis}")]
pub struct GitTokenRotationProviderError {
  pub kind: GitTokenRotationProviderFailureKind,
  /// Stable scrubbed diagnosis; never a raw provider response.
  pub diagnosis: String,
}

#[derive(Debug, Error)]
pub enum GitTokenRotationStoreError {
  #[error("Git-Sync profile or token-rotation configuration not found")]
  NotFound,
  #[error("token rotation conflicts with an unfinished Git-Sync run")]
  UnfinishedRun,
  #[error("token rotation conflicts with an active token rotation")]
  RotationInProgress,
  #[error("token rotation requires an enabled HTTPS-token profile with an expiring credential")]
  IncompatibleProfile,
  #[error("token rotation state changed concurrently")]
  Conflict,
  #[error("token rotation persistence failed: {0}")]
  Storage(String),
}

#[derive(Debug, Error)]
pub enum GitTokenRotationCodecError {
  #[error("credential processing failed")]
  Credential,
}

#[derive(Debug, Error)]
pub enum GitTokenRotationError {
  #[error("invalid token rotation configuration: {0}")]
  InvalidConfiguration(String),
  #[error(transparent)]
  Store(#[from] GitTokenRotationStoreError),
  #[error(transparent)]
  Codec(#[from] GitTokenRotationCodecError),
  #[error(transparent)]
  Provider(#[from] GitTokenRotationProviderError),
}

#[async_trait]
pub trait GitTokenRotationProvider: Send + Sync {
  fn kind(&self) -> GitTokenRotationProviderKind;

  async fn rotate(
    &self,
    request: GitTokenRotationProviderRequest,
  ) -> Result<GitTokenRotationProviderResult, GitTokenRotationProviderError>;
}

#[async_trait]
pub trait GitTokenCredentialCodec: Send + Sync {
  async fn decrypt_https_token(&self, encrypted: &[u8]) -> Result<GitTokenCredential, GitTokenRotationCodecError>;

  async fn encrypt_https_token(
    &self,
    credential: &GitTokenCredential,
    label: &str,
    expires_at: DateTime<Utc>,
  ) -> Result<EncryptedGitCredential, GitTokenRotationCodecError>;
}

#[async_trait]
pub trait GitTokenRotationStore: Send + Sync {
  async fn configure(
    &self,
    profile_id: Uuid,
    configuration: GitTokenRotationConfiguration,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError>;

  async fn status(&self, profile_id: Uuid) -> Result<Option<GitTokenRotationStatus>, GitTokenRotationStoreError>;

  /// Locks all current credential consumers in UUID order, chooses an eligible
  /// steward, and atomically changes the one rotation row to `Rotating`.
  /// `Ok(None)` means disabled, not due, or a same-day failed attempt.
  async fn admit(
    &self,
    profile_id: Uuid,
    now: DateTime<Utc>,
    force: bool,
  ) -> Result<Option<GitTokenRotationAdmission>, GitTokenRotationStoreError>;

  /// Reload an already admitted attempt for execution without putting its
  /// encrypted credential into a queue payload. Callers must never use this to
  /// retry a delivery whose provider outcome is unknown.
  async fn admitted(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
  ) -> Result<GitTokenRotationAdmission, GitTokenRotationStoreError>;

  async fn record_pre_request_failure(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
    diagnosis: &str,
    now: DateTime<Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError>;

  async fn record_manual_intervention(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
    diagnosis: &str,
    now: DateTime<Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError>;

  /// Atomically insert the encrypted replacement, switch every dependent
  /// active pointer, mark completion, and remove the superseded credential.
  async fn install_replacement(
    &self,
    admission: &GitTokenRotationAdmission,
    replacement: &EncryptedGitCredential,
    now: DateTime<Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError>;

  /// Resolve an ambiguous commit acknowledgement without retaining the secret.
  async fn completion_by_attempt(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
  ) -> Result<Option<GitTokenRotationStatus>, GitTokenRotationStoreError>;
}

#[derive(Clone)]
pub struct GitTokenRotationService {
  store: Arc<dyn GitTokenRotationStore>,
  codec: Arc<dyn GitTokenCredentialCodec>,
  providers: Vec<Arc<dyn GitTokenRotationProvider>>,
}

impl GitTokenRotationService {
  pub fn new(
    store: Arc<dyn GitTokenRotationStore>,
    codec: Arc<dyn GitTokenCredentialCodec>,
    providers: Vec<Arc<dyn GitTokenRotationProvider>>,
  ) -> Self {
    Self {
      store,
      codec,
      providers,
    }
  }

  /// Provider identifiers exposed to operator interfaces come from the
  /// concrete adapters wired into this service. Keeping discovery here avoids
  /// advertising a provider whose complete safe rotation contract is absent
  /// from the running server.
  pub fn available_providers(&self) -> Vec<GitTokenRotationProviderKind> {
    let mut available = Vec::new();
    for provider in &self.providers {
      let kind = provider.kind();
      if !available.contains(&kind) {
        available.push(kind);
      }
    }
    available
  }

  pub async fn configure(
    &self,
    profile_id: Uuid,
    configuration: GitTokenRotationConfiguration,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationError> {
    configuration.validate()?;
    if configuration.enabled
      && !self
        .providers
        .iter()
        .any(|provider| provider.kind() == configuration.provider)
    {
      return Err(GitTokenRotationError::InvalidConfiguration(
        "selected token rotation provider is not available".into(),
      ));
    }
    Ok(self.store.configure(profile_id, configuration).await?)
  }

  pub async fn status(&self, profile_id: Uuid) -> Result<Option<GitTokenRotationStatus>, GitTokenRotationError> {
    Ok(self.store.status(profile_id).await?)
  }

  pub async fn rotate(
    &self,
    profile_id: Uuid,
    now: DateTime<Utc>,
    force: bool,
  ) -> Result<Option<GitTokenRotationStatus>, GitTokenRotationError> {
    let configured_provider = match self.store.status(profile_id).await? {
      Some(status) if status.enabled => status.provider,
      _ => return Ok(None),
    };
    let provider = self
      .providers
      .iter()
      .find(|provider| provider.kind() == configured_provider)
      .cloned()
      .ok_or_else(|| {
        GitTokenRotationError::InvalidConfiguration("configured token rotation provider is not available".into())
      })?;
    let Some(admission) = self.store.admit(profile_id, now, force).await? else {
      return Ok(None);
    };
    self.execute_admission(admission, provider, now).await
  }

  /// Execute the first delivery of a durable admitted attempt. Only the
  /// profile and attempt identifiers need to cross the queue boundary; the
  /// credential stays encrypted in PostgreSQL until this operation owns it.
  pub async fn execute_attempt(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
    now: DateTime<Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationError> {
    let admission = self.store.admitted(profile_id, attempt_id).await?;
    let Some(provider) = self
      .providers
      .iter()
      .find(|provider| provider.kind() == admission.provider)
      .cloned()
    else {
      self
        .store
        .record_pre_request_failure(
          admission.profile_id,
          admission.attempt_id,
          "configured token rotation provider is not available",
          now,
        )
        .await?;
      return Err(GitTokenRotationError::InvalidConfiguration(
        "configured token rotation provider is not available".into(),
      ));
    };
    self
      .execute_admission(admission, provider, now)
      .await?
      .ok_or(GitTokenRotationStoreError::Conflict.into())
  }

  /// A redelivered admitted job cannot prove whether the previous worker sent
  /// the one-time rotation request. Close it without a provider retry.
  pub async fn mark_process_loss(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
    now: DateTime<Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationError> {
    Ok(
      self
        .store
        .record_manual_intervention(
          profile_id,
          attempt_id,
          "rotation worker restarted after admission; the provider outcome cannot be proven",
          now,
        )
        .await?,
    )
  }

  async fn execute_admission(
    &self,
    admission: GitTokenRotationAdmission,
    provider: Arc<dyn GitTokenRotationProvider>,
    now: DateTime<Utc>,
  ) -> Result<Option<GitTokenRotationStatus>, GitTokenRotationError> {
    if provider.kind() != admission.provider {
      self
        .store
        .record_pre_request_failure(
          admission.profile_id,
          admission.attempt_id,
          "configured token rotation provider changed before admission",
          now,
        )
        .await?;
      return Err(GitTokenRotationError::InvalidConfiguration(
        "configured token rotation provider changed before admission".into(),
      ));
    }
    let credential = match self.codec.decrypt_https_token(&admission.encrypted_credential).await {
      Ok(credential) => credential,
      Err(error) => {
        self
          .store
          .record_pre_request_failure(
            admission.profile_id,
            admission.attempt_id,
            "active credential could not be decoded",
            now,
          )
          .await?;
        return Err(error.into());
      }
    };
    let username = credential.username.clone();
    let result = provider
      .rotate(GitTokenRotationProviderRequest {
        profile_id: admission.profile_id,
        workspace_id: admission.workspace_id,
        repository_url: admission.repository_url.clone(),
        credential,
        requested_expires_at: admission.requested_expires_at,
      })
      .await;
    let result = match result {
      Ok(result) => result,
      Err(error) => {
        match error.kind {
          GitTokenRotationProviderFailureKind::BeforeRequest => {
            self
              .store
              .record_pre_request_failure(admission.profile_id, admission.attempt_id, &error.diagnosis, now)
              .await?;
          }
          GitTokenRotationProviderFailureKind::ManualIntervention => {
            self
              .store
              .record_manual_intervention(admission.profile_id, admission.attempt_id, &error.diagnosis, now)
              .await?;
          }
        }
        return Err(error.into());
      }
    };

    let replacement = match self
      .codec
      .encrypt_https_token(
        &GitTokenCredential {
          username,
          token: result.replacement_token,
        },
        &admission.credential_label,
        result.expires_at,
      )
      .await
    {
      Ok(replacement) => replacement,
      Err(error) => {
        self
          .store
          .record_manual_intervention(
            admission.profile_id,
            admission.attempt_id,
            "provider succeeded but the replacement credential could not be encrypted",
            now,
          )
          .await?;
        return Err(error.into());
      }
    };

    match self.store.install_replacement(&admission, &replacement, now).await {
      Ok(status) => Ok(Some(status)),
      Err(write_error) => {
        if let Some(status) = self
          .store
          .completion_by_attempt(admission.profile_id, admission.attempt_id)
          .await?
          .filter(|status| status.state == GitTokenRotationState::Completed)
        {
          return Ok(Some(status));
        }
        // A transport-level PostgreSQL failure may mean either rollback or a
        // lost commit acknowledgement. The one retry is safe while this
        // process still owns the replacement secret: the store revalidates the
        // same attempt and admitted active credential under the profile lock.
        if matches!(write_error, GitTokenRotationStoreError::Storage(_)) {
          if let Ok(status) = self.store.install_replacement(&admission, &replacement, now).await {
            return Ok(Some(status));
          }
          if let Some(status) = self
            .store
            .completion_by_attempt(admission.profile_id, admission.attempt_id)
            .await?
            .filter(|status| status.state == GitTokenRotationState::Completed)
          {
            return Ok(Some(status));
          }
        }
        self
          .store
          .record_manual_intervention(
            admission.profile_id,
            admission.attempt_id,
            "provider succeeded but local credential replacement was not confirmed",
            now,
          )
          .await?;
        Err(write_error.into())
      }
    }
  }
}

pub fn requested_expiry(
  now: DateTime<Utc>,
  requested_lifetime_days: u16,
) -> Result<DateTime<Utc>, GitTokenRotationStoreError> {
  now
    .checked_add_days(Days::new(u64::from(requested_lifetime_days)))
    .ok_or_else(|| GitTokenRotationStoreError::Storage("requested expiry is outside the supported date range".into()))
}
