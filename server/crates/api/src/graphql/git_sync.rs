//! GraphQL types, queries, and mutations for the Git Sync feature.
//!
//! Defines all input/output types, enums, and conversion functions for managing
//! bidirectional Git synchronisation of workspace documents.

use async_graphql::*;
use chrono::{DateTime, Utc};

use myoxus_domain::git_sync as domain;

// ── Input types ──────────────────────────────────────────────────────────────

/// Input for creating or updating a Git Sync profile.
///
/// Contains the repository URL, branch, authentication credentials, and
/// synchronisation configuration.  The `token`, `username`, `sshPrivateKey`,
/// and `sshPassphrase` fields carry secrets and are never persisted in
/// plaintext — they are encrypted before storage.
#[derive(InputObject)]
#[graphql(name = "GitSyncProfileInput")]
pub struct GitSyncProfileInput {
  /// HTTPS or SSH URL of the remote Git repository.
  pub repo_url: String,
  /// Branch to synchronise with (default: `main`).
  pub branch: Option<String>,
  /// Subdirectory inside the repo for managed content (default: `content/`).
  pub root_path: Option<String>,
  /// Synchronisation direction (default: `Bidirectional`).
  #[graphql(name = "syncDirection")]
  pub sync_direction: Option<GitSyncDirectionType>,
  /// How sync runs are triggered (default: `Manual`).
  #[graphql(name = "triggerMode")]
  pub trigger_mode: Option<GitSyncTriggerModeType>,
  /// Seconds between automatic sync runs (only used with `Polling` trigger mode).
  #[graphql(name = "pollingIntervalSecs")]
  pub polling_interval_secs: Option<i64>,
  #[graphql(name = "cronExpression")]
  pub cron_expression: Option<String>,
  #[graphql(name = "cronTimezone")]
  pub cron_timezone: Option<String>,
  #[graphql(name = "cronMisfirePolicy")]
  pub cron_misfire_policy: Option<GitSyncCronMisfirePolicyType>,
  /// Authentication method for the remote.
  #[graphql(name = "authMethod")]
  pub auth_method: GitSyncAuthMethodType,
  /// Personal access token (for `HttpsToken` auth).
  pub token: Option<String>,
  /// Password (for `HttpsPassword` auth).
  pub password: Option<String>,
  /// Username (for `HttpsPassword` or `HttpsToken` auth).
  pub username: Option<String>,
  /// PEM-encoded SSH private key (for `SshKey` auth).
  #[graphql(name = "sshPrivateKey")]
  pub ssh_private_key: Option<String>,
  /// Passphrase for the SSH private key (optional).
  #[graphql(name = "sshPassphrase")]
  pub ssh_passphrase: Option<String>,
  /// Optional expiry timestamp for the credential (ISO 8601).
  /// If set, the sync engine will refuse to use expired credentials.
  #[graphql(name = "credentialExpiresAt")]
  pub credential_expires_at: Option<DateTime<Utc>>,
  /// Per-workspace mirror storage limit in MB.
  /// If null, the global `max_mirror_storage_mb` from server config is used.
  #[graphql(name = "maxMirrorStorageMb")]
  pub max_mirror_storage_mb: Option<i64>,
}

/// Replacement credential used by partial profile updates.
#[derive(InputObject)]
#[graphql(name = "GitSyncCredentialInput")]
pub struct GitSyncCredentialInput {
  #[graphql(name = "authMethod")]
  pub auth_method: GitSyncAuthMethodType,
  pub token: Option<String>,
  pub password: Option<String>,
  pub username: Option<String>,
  #[graphql(name = "sshPrivateKey")]
  pub ssh_private_key: Option<String>,
  #[graphql(name = "sshPassphrase")]
  pub ssh_passphrase: Option<String>,
  #[graphql(name = "expiresAt")]
  pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitTokenRotationProvider", rename_items = "PascalCase")]
pub enum GitTokenRotationProviderType {
  GitLab,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitTokenRotationState", rename_items = "PascalCase")]
pub enum GitTokenRotationStateType {
  Configured,
  Rotating,
  Completed,
  Failed,
  ManualIntervention,
}

#[derive(InputObject)]
#[graphql(name = "ConfigureGitTokenRotationInput")]
pub struct ConfigureGitTokenRotationInput {
  pub profile_id: String,
  pub provider: GitTokenRotationProviderType,
  pub enabled: bool,
  pub renew_before_days: i32,
  pub requested_lifetime_days: i32,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "GitTokenRotationStatus")]
pub struct GitTokenRotationStatusType {
  pub profile_id: ID,
  pub provider: GitTokenRotationProviderType,
  pub enabled: bool,
  pub state: GitTokenRotationStateType,
  pub renew_before_days: i32,
  pub requested_lifetime_days: i32,
  pub current_credential_expires_at: Option<DateTime<Utc>>,
  pub next_attempt_at: Option<DateTime<Utc>>,
  pub last_attempt_at: Option<DateTime<Utc>>,
  pub last_success_at: Option<DateTime<Utc>>,
  pub diagnosis: Option<String>,
}

/// Patch semantics for an existing profile. Omitted fields preserve persisted
/// values; `null` clears nullable polling/storage limits.
#[derive(InputObject)]
#[graphql(name = "UpdateGitSyncProfileInput")]
pub struct UpdateGitSyncProfileInput {
  #[graphql(name = "repoUrl")]
  pub repo_url: Option<String>,
  pub branch: Option<String>,
  #[graphql(name = "rootPath")]
  pub root_path: Option<String>,
  #[graphql(name = "syncDirection")]
  pub sync_direction: Option<GitSyncDirectionType>,
  #[graphql(name = "triggerMode")]
  pub trigger_mode: Option<GitSyncTriggerModeType>,
  #[graphql(name = "pollingIntervalSecs")]
  pub polling_interval_secs: MaybeUndefined<i64>,
  #[graphql(name = "cronExpression")]
  pub cron_expression: MaybeUndefined<String>,
  #[graphql(name = "cronTimezone")]
  pub cron_timezone: MaybeUndefined<String>,
  #[graphql(name = "cronMisfirePolicy")]
  pub cron_misfire_policy: MaybeUndefined<GitSyncCronMisfirePolicyType>,
  pub enabled: Option<bool>,
  #[graphql(name = "maxMirrorStorageMb")]
  pub max_mirror_storage_mb: MaybeUndefined<i64>,
  pub credential: Option<GitSyncCredentialInput>,
}

/// Input for resolving a Git Sync conflict.
///
/// The caller selects one of the available resolution strategies.  For
/// `ManualMerge`, the `mergedContent` field must contain the user-edited
/// Markdown that replaces both conflicting versions.
#[derive(InputObject)]
#[graphql(name = "ResolveConflictInput")]
pub struct ResolveConflictInput {
  /// ID of the conflict to resolve.
  #[graphql(name = "conflictId")]
  pub conflict_id: String,
  /// Resolution strategy to apply.
  pub resolution: GitSyncConflictResolutionType,
  /// User-edited Markdown content (required for `ManualMerge`).
  #[graphql(name = "mergedContent")]
  pub merged_content: Option<String>,
}

/// Input for resolving a non-Markdown Git Sync file conflict.
///
/// File conflicts are binary/blob decisions. `ManualMerge` is therefore not a
/// valid file resolution and is rejected by the server mutation.
#[derive(InputObject)]
#[graphql(name = "ResolveFileConflictInput")]
pub struct ResolveFileConflictInput {
  /// ID of the file conflict to resolve.
  #[graphql(name = "conflictId")]
  pub conflict_id: String,
  /// Resolution strategy to apply.
  pub resolution: GitSyncConflictResolutionType,
}

// ── Enum types ───────────────────────────────────────────────────────────────

/// Direction of synchronisation for a profile or a single run.
///
/// Maps to [`myoxus_domain::git_sync::SyncDirection`].
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitSyncDirection", rename_items = "PascalCase")]
pub enum GitSyncDirectionType {
  /// Both Myoxus-to-Git and Git-to-Myoxus.
  Bidirectional,
  /// Export only: Myoxus changes pushed to Git.
  MyoxusToGit,
  /// Import only: Git changes pulled into Myoxus.
  GitToMyoxus,
}

/// How sync runs are triggered.
///
/// Maps to [`myoxus_domain::git_sync::TriggerMode`].
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitSyncTriggerMode", rename_items = "PascalCase")]
pub enum GitSyncTriggerModeType {
  /// Sync runs must be triggered explicitly via `triggerGitSync`.
  Manual,
  /// Sync runs are triggered automatically at a configurable interval.
  Polling,
  /// Sync runs are triggered by a webhook from the Git provider (V2).
  Webhook,
  /// Sync runs are admitted from server-calculated durable schedule slots.
  Cron,
  /// Sync runs follow committed document-history captures.
  HistoryCapture,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitSyncCronMisfirePolicy", rename_items = "PascalCase")]
pub enum GitSyncCronMisfirePolicyType {
  Skip,
  RunOnce,
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitSyncRunSource", rename_items = "PascalCase")]
pub enum GitSyncRunSourceType {
  Manual,
  Polling,
  Webhook,
  Cron,
  HistoryCapture,
}

/// Authentication method for the remote Git repository.
///
/// Maps to [`myoxus_domain::git_sync::AuthMethod`].
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitSyncAuthMethod", rename_items = "PascalCase")]
pub enum GitSyncAuthMethodType {
  /// Personal access token over HTTPS.
  HttpsToken,
  /// Username + password over HTTPS.
  HttpsPassword,
  /// PEM-encoded SSH private key.
  SshKey,
}

/// Lifecycle status of a sync run.
///
/// Maps to [`myoxus_domain::git_sync::RunStatus`].
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitSyncRunStatus", rename_items = "PascalCase")]
pub enum GitSyncRunStatusType {
  /// Run is queued but not yet started.
  Pending,
  /// Run is currently executing.
  Running,
  /// Run finished successfully.
  Completed,
  /// Run terminated with an error.
  Failed,
  /// Run was cancelled before completion.
  Cancelled,
}

/// Kind of conflict detected during reconciliation.
///
/// Maps to [`myoxus_domain::git_sync::ConflictType`].
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitSyncConflictKind", rename_items = "PascalCase")]
pub enum GitSyncConflictTypeEnum {
  /// Both Myoxus and Git modified the same document since last sync.
  BothModified,
  /// Deleted in Git, modified in Myoxus.
  DeleteVsModify,
  /// Modified in Git, deleted in Myoxus.
  ModifyVsDelete,
  /// Both sides renamed the document to different targets.
  RenameVsRename,
  /// One side renamed, the other modified.
  RenameVsModify,
}

/// Resolution strategy for a Git Sync conflict.
///
/// Maps to [`myoxus_domain::git_sync::ConflictResolution`] (without `Open`).
#[derive(Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "GitSyncConflictResolution", rename_items = "PascalCase")]
pub enum GitSyncConflictResolutionType {
  /// Myoxus version wins; Git file overwritten on next sync.
  MyoxusWins,
  /// Git version wins; Myoxus document overwritten.
  GitWins,
  /// User provides manually merged content.
  ManualMerge,
  /// Conflict acknowledged but no action taken.
  Dismissed,
}

// ── Output types ─────────────────────────────────────────────────────────────

/// Git Sync profile configuration for a workspace.
///
/// Represents the persistent configuration that binds a workspace to a
/// remote Git repository.  Secrets (tokens, keys) are never exposed here.
#[derive(SimpleObject)]
#[graphql(name = "GitSyncProfileType", complex)]
pub struct GitSyncProfileType {
  pub id: ID,
  #[graphql(name = "repoUrl")]
  pub repo_url: String,
  pub branch: String,
  #[graphql(name = "rootPath")]
  pub root_path: String,
  pub manifest_path: String,
  #[graphql(skip)]
  pub credential_id: Option<uuid::Uuid>,
  #[graphql(name = "syncDirection")]
  pub sync_direction: GitSyncDirectionType,
  #[graphql(name = "triggerMode")]
  pub trigger_mode: GitSyncTriggerModeType,
  #[graphql(name = "pollingIntervalSecs")]
  pub polling_interval_secs: Option<i64>,
  #[graphql(name = "cronExpression")]
  pub cron_expression: Option<String>,
  #[graphql(name = "cronTimezone")]
  pub cron_timezone: Option<String>,
  #[graphql(name = "cronMisfirePolicy")]
  pub cron_misfire_policy: Option<GitSyncCronMisfirePolicyType>,
  #[graphql(name = "cronNextScheduledAt")]
  pub cron_next_scheduled_at: Option<DateTime<Utc>>,
  #[graphql(name = "cronPendingMisfireScheduledFor")]
  pub cron_pending_misfire_scheduled_for: Option<DateTime<Utc>>,
  #[graphql(name = "authMethod")]
  pub auth_method: GitSyncAuthMethodType,
  pub enabled: bool,
  /// Per-workspace mirror storage limit in MB (null = use global limit).
  #[graphql(name = "maxMirrorStorageMb")]
  pub max_mirror_storage_mb: Option<i64>,
  #[graphql(name = "createdAt")]
  pub created_at: DateTime<Utc>,
  #[graphql(name = "updatedAt")]
  pub updated_at: DateTime<Utc>,
  /// When the credential expires (null = never expires).
  #[graphql(name = "credentialExpiresAt")]
  pub credential_expires_at: Option<DateTime<Utc>>,
}

#[ComplexObject]
impl GitSyncProfileType {
  /// Ownership metadata only; neither the active pointer nor secret bytes are
  /// exposed to the client. Profile parents already enforce workspace access.
  async fn credential_inherited(&self, ctx: &Context<'_>) -> Result<bool> {
    let Some(id) = self.credential_id else {
      return Ok(false);
    };
    let state = ctx.data::<std::sync::Arc<crate::state::ApiState>>()?;
    let pool = state
      .metrics_pool()
      .ok_or_else(|| Error::new("Git credential ownership is unavailable"))?;
    let credential = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool)
      .get_credential(id)
      .await
      .map_err(|_| Error::new("Git credential ownership is unavailable"))?;
    Ok(credential.profile_id.to_string() != self.id.as_str())
  }
}

#[derive(SimpleObject)]
#[graphql(name = "GitSyncDeleteImpactType")]
pub struct GitSyncDeleteImpactType {
  #[graphql(name = "profileId")]
  pub profile_id: ID,
  pub runs: i64,
  #[graphql(name = "documentBindings")]
  pub document_bindings: i64,
  #[graphql(name = "fileBindings")]
  pub file_bindings: i64,
  #[graphql(name = "openConflicts")]
  pub open_conflicts: i64,
  pub credentials: i64,
}

/// A concrete synchronisation execution record.
///
/// Contains direction, lifecycle status, timing, counters for docs
/// created/updated/deleted, and optional error information.
#[derive(SimpleObject)]
#[graphql(name = "GitSyncRunType")]
pub struct GitSyncRunType {
  pub id: ID,
  pub direction: GitSyncDirectionType,
  #[graphql(name = "triggerSource")]
  pub trigger_source: GitSyncRunSourceType,
  #[graphql(name = "scheduledFor")]
  pub scheduled_for: Option<DateTime<Utc>>,
  pub status: GitSyncRunStatusType,
  #[graphql(name = "startedAt")]
  pub started_at: DateTime<Utc>,
  #[graphql(name = "finishedAt")]
  pub finished_at: Option<DateTime<Utc>>,
  #[graphql(name = "jobId")]
  pub job_id: Option<String>,
  #[graphql(name = "commitBefore")]
  pub commit_before: Option<String>,
  #[graphql(name = "commitAfter")]
  pub commit_after: Option<String>,
  #[graphql(name = "observedRemoteOid")]
  pub observed_remote_oid: Option<String>,
  #[graphql(name = "reconciliationRequired")]
  pub reconciliation_required: bool,
  #[graphql(name = "reconciliationReason")]
  pub reconciliation_reason: Option<String>,
  #[graphql(name = "docsCreated")]
  pub docs_created: i32,
  #[graphql(name = "docsUpdated")]
  pub docs_updated: i32,
  #[graphql(name = "docsDeleted")]
  pub docs_deleted: i32,
  #[graphql(name = "conflictsFound")]
  pub conflicts_found: i32,
  #[graphql(name = "errorMessage")]
  pub error_message: Option<String>,
  #[graphql(name = "errorClass")]
  pub error_class: Option<String>,
}

#[derive(SimpleObject)]
#[graphql(name = "GitSyncScheduleOccurrence")]
pub struct GitSyncScheduleOccurrenceType {
  #[graphql(name = "scheduledAtUtc")]
  pub scheduled_at_utc: DateTime<Utc>,
  #[graphql(name = "localDateTime")]
  pub local_date_time: String,
  #[graphql(name = "utcOffsetSeconds")]
  pub utc_offset_seconds: i32,
}

/// A persisted conflict between Myoxus and Git states.
///
/// Surfaces the conflicting content so the user can choose a resolution
/// strategy via `resolveGitSyncConflict`.
#[derive(SimpleObject)]
#[graphql(name = "GitSyncConflictType")]
pub struct GitSyncConflictObjectType {
  pub id: ID,
  #[graphql(name = "repoPath")]
  pub repo_path: String,
  #[graphql(name = "conflictType")]
  pub conflict_type: GitSyncConflictTypeEnum,
  pub resolution: String,
  #[graphql(name = "myoxusContent")]
  pub myoxus_content: Option<String>,
  #[graphql(name = "gitContent")]
  pub git_content: Option<String>,
  #[graphql(name = "createdAt")]
  pub created_at: DateTime<Utc>,
}

/// Stable mapping between a Myoxus document and a Git file.
///
/// Identity is maintained via `syncId` (persisted in YAML frontmatter).
/// Path changes do not alter the binding — only the `repoPath` field
/// is updated.
#[derive(SimpleObject)]
#[graphql(name = "GitSyncBindingType")]
pub struct GitSyncBindingType {
  pub id: ID,
  #[graphql(name = "docId")]
  pub doc_id: String,
  #[graphql(name = "syncId")]
  pub sync_id: String,
  #[graphql(name = "repoPath")]
  pub repo_path: String,
  pub tombstone: bool,
}

/// Persisted conflict for a non-Markdown file.
///
/// File conflicts are separate from document conflicts because they identify
/// blob/binding state and do not carry mergeable text bodies.
#[derive(SimpleObject)]
#[graphql(name = "GitSyncFileConflictType")]
pub struct GitSyncFileConflictType {
  pub id: ID,
  #[graphql(name = "runId")]
  pub run_id: ID,
  #[graphql(name = "bindingId")]
  pub binding_id: Option<ID>,
  #[graphql(name = "blobKey")]
  pub blob_key: Option<String>,
  #[graphql(name = "repoPath")]
  pub repo_path: String,
  #[graphql(name = "conflictType")]
  pub conflict_type: GitSyncConflictTypeEnum,
  pub resolution: String,
  #[graphql(name = "gitHash")]
  pub git_hash: Option<String>,
  #[graphql(name = "myoxusHash")]
  pub myoxus_hash: Option<String>,
  #[graphql(name = "baselineHash")]
  pub baseline_hash: Option<String>,
  #[graphql(name = "createdAt")]
  pub created_at: DateTime<Utc>,
  #[graphql(name = "resolvedAt")]
  pub resolved_at: Option<DateTime<Utc>>,
  #[graphql(name = "resolvedBy")]
  pub resolved_by: Option<String>,
}

/// Stable mapping between a Myoxus blob and a Git file.
#[derive(SimpleObject)]
#[graphql(name = "GitSyncFileBindingType")]
pub struct GitSyncFileBindingType {
  pub id: ID,
  #[graphql(name = "blobKey")]
  pub blob_key: String,
  #[graphql(name = "repoPath")]
  pub repo_path: String,
  #[graphql(name = "contentHash")]
  pub content_hash: String,
  #[graphql(name = "mimeType")]
  pub mime_type: String,
  #[graphql(name = "fileSize")]
  pub file_size: i64,
  pub tombstoned: bool,
  #[graphql(name = "createdAt")]
  pub created_at: DateTime<Utc>,
  #[graphql(name = "updatedAt")]
  pub updated_at: DateTime<Utc>,
}

/// Persisted SSH known-host pin used by Git-Sync SSH transports.
#[derive(SimpleObject)]
#[graphql(name = "GitSyncSshHostKeyType")]
pub struct GitSyncSshHostKeyType {
  pub host: String,
  pub port: i32,
  #[graphql(name = "keyType")]
  pub key_type: String,
  #[graphql(name = "fingerprintSha256")]
  pub fingerprint_sha256: String,
  #[graphql(name = "firstSeenAt")]
  pub first_seen_at: DateTime<Utc>,
  #[graphql(name = "lastSeenAt")]
  pub last_seen_at: DateTime<Utc>,
  pub source: String,
  #[graphql(name = "createdBy")]
  pub created_by: Option<ID>,
  pub enabled: bool,
}

/// Aggregated Git Sync status for a workspace.
///
/// `openConflicts` and `totalBindings` are aggregate compatibility fields:
/// `doc + file`. New consumers should prefer the explicit doc/file counters.
#[derive(SimpleObject)]
#[graphql(name = "GitSyncStatusType")]
pub struct GitSyncStatusType {
  pub profile: Option<GitSyncProfileType>,
  #[graphql(name = "lastRun")]
  pub last_run: Option<GitSyncRunType>,
  #[graphql(name = "openConflicts")]
  pub open_conflicts: i32,
  #[graphql(name = "totalBindings")]
  pub total_bindings: i32,
  #[graphql(name = "openDocConflicts")]
  pub open_doc_conflicts: i32,
  #[graphql(name = "openFileConflicts")]
  pub open_file_conflicts: i32,
  #[graphql(name = "totalDocBindings")]
  pub total_doc_bindings: i32,
  #[graphql(name = "totalFileBindings")]
  pub total_file_bindings: i32,
  #[graphql(name = "partialSessionId")]
  pub partial_session_id: Option<ID>,
  #[graphql(name = "partialStatus")]
  pub partial_status: Option<String>,
  #[graphql(name = "partialHasMore")]
  pub partial_has_more: bool,
  #[graphql(name = "partialTotalItems")]
  pub partial_total_items: i32,
  #[graphql(name = "partialProcessedItems")]
  pub partial_processed_items: i32,
  #[graphql(name = "partialFailedItems")]
  pub partial_failed_items: i32,
}

// ── Domain -> GraphQL conversion functions ──────────────────────────────────

pub fn map_token_rotation_provider_to_application(
  provider: GitTokenRotationProviderType,
) -> myoxus_application::git_sync::GitTokenRotationProviderKind {
  match provider {
    GitTokenRotationProviderType::GitLab => myoxus_application::git_sync::GitTokenRotationProviderKind::GitLab,
  }
}

pub fn map_token_rotation_provider(
  provider: myoxus_application::git_sync::GitTokenRotationProviderKind,
) -> GitTokenRotationProviderType {
  match provider {
    myoxus_application::git_sync::GitTokenRotationProviderKind::GitLab => GitTokenRotationProviderType::GitLab,
  }
}

pub fn map_token_rotation_state(
  state: myoxus_application::git_sync::GitTokenRotationState,
) -> GitTokenRotationStateType {
  match state {
    myoxus_application::git_sync::GitTokenRotationState::Configured => GitTokenRotationStateType::Configured,
    myoxus_application::git_sync::GitTokenRotationState::Rotating => GitTokenRotationStateType::Rotating,
    myoxus_application::git_sync::GitTokenRotationState::Completed => GitTokenRotationStateType::Completed,
    myoxus_application::git_sync::GitTokenRotationState::Failed => GitTokenRotationStateType::Failed,
    myoxus_application::git_sync::GitTokenRotationState::ManualIntervention => {
      GitTokenRotationStateType::ManualIntervention
    }
  }
}

pub fn map_token_rotation_status(
  status: myoxus_application::git_sync::GitTokenRotationStatus,
) -> GitTokenRotationStatusType {
  let next_attempt_at = status.next_attempt_at();
  GitTokenRotationStatusType {
    profile_id: ID(status.profile_id.to_string()),
    provider: map_token_rotation_provider(status.provider),
    enabled: status.enabled,
    state: map_token_rotation_state(status.state),
    renew_before_days: i32::from(status.renew_before_days),
    requested_lifetime_days: i32::from(status.requested_lifetime_days),
    current_credential_expires_at: status.current_credential_expires_at,
    next_attempt_at,
    last_attempt_at: status.last_attempt_at,
    last_success_at: status.last_success_at,
    diagnosis: status.diagnosis,
  }
}

/// Convert a domain `SyncDirection` to the GraphQL enum.
pub fn map_sync_direction(d: domain::SyncDirection) -> GitSyncDirectionType {
  match d {
    domain::SyncDirection::Bidirectional => GitSyncDirectionType::Bidirectional,
    domain::SyncDirection::MyoxusToGit => GitSyncDirectionType::MyoxusToGit,
    domain::SyncDirection::GitToMyoxus => GitSyncDirectionType::GitToMyoxus,
  }
}

/// Convert a GraphQL `GitSyncDirectionType` to the domain enum.
pub fn map_sync_direction_to_domain(d: GitSyncDirectionType) -> domain::SyncDirection {
  match d {
    GitSyncDirectionType::Bidirectional => domain::SyncDirection::Bidirectional,
    GitSyncDirectionType::MyoxusToGit => domain::SyncDirection::MyoxusToGit,
    GitSyncDirectionType::GitToMyoxus => domain::SyncDirection::GitToMyoxus,
  }
}

/// Convert a domain `TriggerMode` to the GraphQL enum.
pub fn map_trigger_mode(t: domain::TriggerMode) -> GitSyncTriggerModeType {
  match t {
    domain::TriggerMode::Manual => GitSyncTriggerModeType::Manual,
    domain::TriggerMode::Polling => GitSyncTriggerModeType::Polling,
    domain::TriggerMode::Webhook => GitSyncTriggerModeType::Webhook,
    domain::TriggerMode::Cron => GitSyncTriggerModeType::Cron,
    domain::TriggerMode::HistoryCapture => GitSyncTriggerModeType::HistoryCapture,
  }
}

/// Convert a GraphQL `GitSyncTriggerModeType` to the domain enum.
pub fn map_trigger_mode_to_domain(t: GitSyncTriggerModeType) -> domain::TriggerMode {
  match t {
    GitSyncTriggerModeType::Manual => domain::TriggerMode::Manual,
    GitSyncTriggerModeType::Polling => domain::TriggerMode::Polling,
    GitSyncTriggerModeType::Webhook => domain::TriggerMode::Webhook,
    GitSyncTriggerModeType::Cron => domain::TriggerMode::Cron,
    GitSyncTriggerModeType::HistoryCapture => domain::TriggerMode::HistoryCapture,
  }
}

pub fn map_cron_misfire_policy(value: domain::GitSyncCronMisfirePolicy) -> GitSyncCronMisfirePolicyType {
  match value {
    domain::GitSyncCronMisfirePolicy::Skip => GitSyncCronMisfirePolicyType::Skip,
    domain::GitSyncCronMisfirePolicy::RunOnce => GitSyncCronMisfirePolicyType::RunOnce,
  }
}

pub fn map_cron_misfire_policy_to_domain(value: GitSyncCronMisfirePolicyType) -> domain::GitSyncCronMisfirePolicy {
  match value {
    GitSyncCronMisfirePolicyType::Skip => domain::GitSyncCronMisfirePolicy::Skip,
    GitSyncCronMisfirePolicyType::RunOnce => domain::GitSyncCronMisfirePolicy::RunOnce,
  }
}

pub fn map_run_source(value: domain::GitSyncRunSource) -> GitSyncRunSourceType {
  match value {
    domain::GitSyncRunSource::Manual => GitSyncRunSourceType::Manual,
    domain::GitSyncRunSource::Polling => GitSyncRunSourceType::Polling,
    domain::GitSyncRunSource::Webhook => GitSyncRunSourceType::Webhook,
    domain::GitSyncRunSource::Cron => GitSyncRunSourceType::Cron,
    domain::GitSyncRunSource::HistoryCapture => GitSyncRunSourceType::HistoryCapture,
  }
}

/// Convert a domain `AuthMethod` to the GraphQL enum.
pub fn map_auth_method(a: domain::AuthMethod) -> GitSyncAuthMethodType {
  match a {
    domain::AuthMethod::HttpsToken => GitSyncAuthMethodType::HttpsToken,
    domain::AuthMethod::HttpsPassword => GitSyncAuthMethodType::HttpsPassword,
    domain::AuthMethod::SshKey => GitSyncAuthMethodType::SshKey,
  }
}

/// Convert a GraphQL `GitSyncAuthMethodType` to the domain enum.
pub fn map_auth_method_to_domain(a: GitSyncAuthMethodType) -> domain::AuthMethod {
  match a {
    GitSyncAuthMethodType::HttpsToken => domain::AuthMethod::HttpsToken,
    GitSyncAuthMethodType::HttpsPassword => domain::AuthMethod::HttpsPassword,
    GitSyncAuthMethodType::SshKey => domain::AuthMethod::SshKey,
  }
}

/// Convert a domain `RunStatus` to the GraphQL enum.
pub fn map_run_status(s: domain::RunStatus) -> GitSyncRunStatusType {
  match s {
    domain::RunStatus::Pending => GitSyncRunStatusType::Pending,
    domain::RunStatus::Running => GitSyncRunStatusType::Running,
    domain::RunStatus::Completed => GitSyncRunStatusType::Completed,
    domain::RunStatus::Failed => GitSyncRunStatusType::Failed,
    domain::RunStatus::Cancelled => GitSyncRunStatusType::Cancelled,
  }
}

/// Convert a GraphQL `GitSyncRunStatusType` to the domain enum.
pub fn map_run_status_to_domain(s: GitSyncRunStatusType) -> domain::RunStatus {
  match s {
    GitSyncRunStatusType::Pending => domain::RunStatus::Pending,
    GitSyncRunStatusType::Running => domain::RunStatus::Running,
    GitSyncRunStatusType::Completed => domain::RunStatus::Completed,
    GitSyncRunStatusType::Failed => domain::RunStatus::Failed,
    GitSyncRunStatusType::Cancelled => domain::RunStatus::Cancelled,
  }
}

/// Convert a domain `ConflictType` to the GraphQL enum.
pub fn map_conflict_type(c: domain::ConflictType) -> GitSyncConflictTypeEnum {
  match c {
    domain::ConflictType::BothModified => GitSyncConflictTypeEnum::BothModified,
    domain::ConflictType::DeleteVsModify => GitSyncConflictTypeEnum::DeleteVsModify,
    domain::ConflictType::ModifyVsDelete => GitSyncConflictTypeEnum::ModifyVsDelete,
    domain::ConflictType::RenameVsRename => GitSyncConflictTypeEnum::RenameVsRename,
    domain::ConflictType::RenameVsModify => GitSyncConflictTypeEnum::RenameVsModify,
  }
}

/// Convert a GraphQL `GitSyncConflictResolutionType` to the domain enum.
pub fn map_resolution_to_domain(r: GitSyncConflictResolutionType) -> domain::ConflictResolution {
  match r {
    GitSyncConflictResolutionType::MyoxusWins => domain::ConflictResolution::MyoxusWins,
    GitSyncConflictResolutionType::GitWins => domain::ConflictResolution::GitWins,
    GitSyncConflictResolutionType::ManualMerge => domain::ConflictResolution::ManualMerge,
    GitSyncConflictResolutionType::Dismissed => domain::ConflictResolution::Dismissed,
  }
}

/// Convert a domain `GitSyncProfile` to the GraphQL output type.
pub fn map_profile(p: domain::GitSyncProfile) -> GitSyncProfileType {
  map_profile_with_expiry(p, None)
}

pub fn map_delete_impact(impact: myoxus_application::git_sync::GitSyncDeleteImpact) -> GitSyncDeleteImpactType {
  GitSyncDeleteImpactType {
    profile_id: ID(impact.profile_id.to_string()),
    runs: impact.runs,
    document_bindings: impact.document_bindings,
    file_bindings: impact.file_bindings,
    open_conflicts: impact.open_conflicts,
    credentials: impact.credentials,
  }
}

/// Convert a domain `GitSyncProfile` to the GraphQL output type,
/// with an optional credential expiry timestamp.
pub fn map_profile_with_expiry(
  p: domain::GitSyncProfile,
  credential_expires_at: Option<DateTime<Utc>>,
) -> GitSyncProfileType {
  GitSyncProfileType {
    id: ID(p.id.to_string()),
    repo_url: p.repo_url,
    branch: p.branch,
    root_path: p.root_path,
    manifest_path: p.manifest_path,
    credential_id: p.credential_id,
    sync_direction: map_sync_direction(p.sync_direction),
    trigger_mode: map_trigger_mode(p.trigger_mode),
    polling_interval_secs: p.polling_interval_secs,
    cron_expression: p.cron_expression,
    cron_timezone: p.cron_timezone,
    cron_misfire_policy: p.cron_misfire_policy.map(map_cron_misfire_policy),
    cron_next_scheduled_at: p.cron_next_scheduled_at,
    cron_pending_misfire_scheduled_for: p.cron_pending_misfire_scheduled_for,
    auth_method: map_auth_method(p.auth_method),
    enabled: p.enabled,
    max_mirror_storage_mb: p.max_mirror_storage_mb,
    created_at: p.created_at,
    updated_at: p.updated_at,
    credential_expires_at,
  }
}

/// Convert a domain `GitSyncRun` to the GraphQL output type.
pub fn map_run(r: domain::GitSyncRun) -> GitSyncRunType {
  GitSyncRunType {
    id: ID(r.id.to_string()),
    direction: map_sync_direction(r.direction),
    trigger_source: map_run_source(r.trigger_source),
    scheduled_for: r.scheduled_for,
    status: map_run_status(r.status),
    started_at: r.started_at,
    finished_at: r.finished_at,
    job_id: r.job_id,
    commit_before: r.commit_before,
    commit_after: r.commit_after,
    observed_remote_oid: r.observed_remote_oid,
    reconciliation_required: r.reconciliation_required,
    reconciliation_reason: r.reconciliation_reason,
    docs_created: r.docs_created,
    docs_updated: r.docs_updated,
    docs_deleted: r.docs_deleted,
    conflicts_found: r.conflicts_found,
    error_message: r.error_message,
    error_class: r.error_class.map(|value| value.to_string()),
  }
}

/// Convert a domain `GitSyncConflict` to the GraphQL output type.
pub fn map_conflict(c: domain::GitSyncConflict) -> GitSyncConflictObjectType {
  GitSyncConflictObjectType {
    id: ID(c.id.to_string()),
    repo_path: c.repo_path,
    conflict_type: map_conflict_type(c.conflict_type),
    resolution: c.resolution.to_string(),
    myoxus_content: c.myoxus_content,
    git_content: c.git_content,
    created_at: c.created_at,
  }
}

/// Convert a domain `GitSyncBinding` to the GraphQL output type.
pub fn map_binding(b: domain::GitSyncBinding) -> GitSyncBindingType {
  GitSyncBindingType {
    id: ID(b.id.to_string()),
    doc_id: b.doc_id.to_string(),
    sync_id: b.sync_id.to_string(),
    repo_path: b.repo_path,
    tombstone: b.tombstone,
  }
}

/// Convert a domain `GitSyncFileConflict` to the GraphQL output type.
pub fn map_file_conflict(c: domain::GitSyncFileConflict) -> GitSyncFileConflictType {
  GitSyncFileConflictType {
    id: ID(c.id.to_string()),
    run_id: ID(c.run_id.to_string()),
    binding_id: c.binding_id.map(|id| ID(id.to_string())),
    blob_key: c.blob_key,
    repo_path: c.repo_path,
    conflict_type: map_conflict_type(c.conflict_type),
    resolution: c.resolution.to_string(),
    git_hash: c.git_hash,
    myoxus_hash: c.myoxus_hash,
    baseline_hash: c.baseline_hash,
    created_at: c.created_at,
    resolved_at: c.resolved_at,
    resolved_by: c.resolved_by.map(|id| id.to_string()),
  }
}

/// Convert a domain `GitSyncFileBinding` to the GraphQL output type.
pub fn map_file_binding(b: domain::GitSyncFileBinding) -> GitSyncFileBindingType {
  GitSyncFileBindingType {
    id: ID(b.id.to_string()),
    blob_key: b.blob_key,
    repo_path: b.repo_path,
    content_hash: b.content_hash,
    mime_type: b.mime_type,
    file_size: b.file_size,
    tombstoned: b.tombstoned,
    created_at: b.created_at,
    updated_at: b.updated_at,
  }
}

pub fn map_ssh_host_key(key: myoxus_infrastructure::git_sync::GitSyncSshHostKey) -> GitSyncSshHostKeyType {
  GitSyncSshHostKeyType {
    host: key.host,
    port: key.port,
    key_type: key.key_type,
    fingerprint_sha256: key.fingerprint_sha256,
    first_seen_at: key.first_seen_at,
    last_seen_at: key.last_seen_at,
    source: key.source,
    created_by: key.created_by.map(ID::from),
    enabled: key.enabled,
  }
}
