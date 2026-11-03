//! Git Sync domain model — profiles, bindings, runs, conflicts, credentials, baselines.
//!
//! This module defines the pure domain types for the bidirectional Git
//! synchronisation feature.  All types are persistence-agnostic and carry no
//! I/O dependencies beyond `uuid`, `chrono`, `serde`, and `tracing`.

use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::instrument;
use uuid::Uuid;

use crate::ids::{UserId, WorkspaceId};

// ─── Type Aliases ────────────────────────────────────────────────────────────

/// Stable identifier persisted in Git frontmatter to survive renames/moves.
pub type SyncId = Uuid;
/// Identifier for a [`GitSyncProfile`].
pub type ProfileId = Uuid;
/// Identifier for a [`GitSyncBinding`].
pub type BindingId = Uuid;

// ─── Enums ───────────────────────────────────────────────────────────────────

/// Direction of synchronisation for a profile or a single run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SyncDirection {
  Bidirectional,
  MyoxusToGit,
  GitToMyoxus,
}

impl fmt::Display for SyncDirection {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Bidirectional => f.write_str("Bidirectional"),
      Self::MyoxusToGit => f.write_str("MyoxusToGit"),
      Self::GitToMyoxus => f.write_str("GitToMyoxus"),
    }
  }
}

/// How sync runs are triggered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TriggerMode {
  Manual,
  Polling,
  Webhook,
  Cron,
  HistoryCapture,
}

impl fmt::Display for TriggerMode {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Manual => f.write_str("Manual"),
      Self::Polling => f.write_str("Polling"),
      Self::Webhook => f.write_str("Webhook"),
      Self::Cron => f.write_str("Cron"),
      Self::HistoryCapture => f.write_str("HistoryCapture"),
    }
  }
}

/// Concrete ingress that admitted one run.
///
/// This is deliberately distinct from [`TriggerMode`]: an operator may start
/// a manual run for any enabled profile without changing its automatic mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GitSyncRunSource {
  Manual,
  Polling,
  Webhook,
  Cron,
  HistoryCapture,
}

impl fmt::Display for GitSyncRunSource {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Manual => f.write_str("Manual"),
      Self::Polling => f.write_str("Polling"),
      Self::Webhook => f.write_str("Webhook"),
      Self::Cron => f.write_str("Cron"),
      Self::HistoryCapture => f.write_str("HistoryCapture"),
    }
  }
}

/// Authentication method for the remote Git repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AuthMethod {
  HttpsToken,
  HttpsPassword,
  SshKey,
}

impl fmt::Display for AuthMethod {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::HttpsToken => f.write_str("HttpsToken"),
      Self::HttpsPassword => f.write_str("HttpsPassword"),
      Self::SshKey => f.write_str("SshKey"),
    }
  }
}

/// Lifecycle status of a [`GitSyncRun`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunStatus {
  Pending,
  Running,
  Completed,
  Failed,
  Cancelled,
}

impl fmt::Display for RunStatus {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Pending => f.write_str("Pending"),
      Self::Running => f.write_str("Running"),
      Self::Completed => f.write_str("Completed"),
      Self::Failed => f.write_str("Failed"),
      Self::Cancelled => f.write_str("Cancelled"),
    }
  }
}

/// Lifecycle of a multi-run partial sync session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PartialSessionStatus {
  Open,
  Completed,
  CompletedWithFailures,
  Cancelled,
}

impl fmt::Display for PartialSessionStatus {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Open => f.write_str("Open"),
      Self::Completed => f.write_str("Completed"),
      Self::CompletedWithFailures => f.write_str("CompletedWithFailures"),
      Self::Cancelled => f.write_str("Cancelled"),
    }
  }
}

/// Kind of work tracked by a partial sync session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PartialItemKind {
  /// Myoxus-originated document work, keyed by document id.
  Doc,
  /// Git-originated markdown work, keyed by repo path.
  GitMarkdown,
}

impl fmt::Display for PartialItemKind {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Doc => f.write_str("Doc"),
      Self::GitMarkdown => f.write_str("GitMarkdown"),
    }
  }
}

/// Processing state of one partial sync work item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PartialItemStatus {
  Pending,
  Running,
  Completed,
  Failed,
  Conflicted,
}

impl fmt::Display for PartialItemStatus {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Pending => f.write_str("Pending"),
      Self::Running => f.write_str("Running"),
      Self::Completed => f.write_str("Completed"),
      Self::Failed => f.write_str("Failed"),
      Self::Conflicted => f.write_str("Conflicted"),
    }
  }
}

/// Broad error classification for failed sync runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorClass {
  GitAuth,
  GitNetwork,
  GitConflict,
  ImportError,
  ExportError,
  InternalError,
}

impl fmt::Display for ErrorClass {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::GitAuth => f.write_str("GitAuth"),
      Self::GitNetwork => f.write_str("GitNetwork"),
      Self::GitConflict => f.write_str("GitConflict"),
      Self::ImportError => f.write_str("ImportError"),
      Self::ExportError => f.write_str("ExportError"),
      Self::InternalError => f.write_str("InternalError"),
    }
  }
}

/// Kind of conflict detected during reconciliation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConflictType {
  BothModified,
  DeleteVsModify,
  ModifyVsDelete,
  RenameVsRename,
  RenameVsModify,
}

impl fmt::Display for ConflictType {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::BothModified => f.write_str("BothModified"),
      Self::DeleteVsModify => f.write_str("DeleteVsModify"),
      Self::ModifyVsDelete => f.write_str("ModifyVsDelete"),
      Self::RenameVsRename => f.write_str("RenameVsRename"),
      Self::RenameVsModify => f.write_str("RenameVsModify"),
    }
  }
}

/// Resolution state of a [`GitSyncConflict`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConflictResolution {
  Open,
  MyoxusWins,
  GitWins,
  ManualMerge,
  Dismissed,
}

impl ConflictResolution {
  /// Returns `true` for terminal (resolved) states.
  pub fn is_resolved(self) -> bool {
    !matches!(self, Self::Open)
  }
}

impl fmt::Display for ConflictResolution {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Open => f.write_str("Open"),
      Self::MyoxusWins => f.write_str("MyoxusWins"),
      Self::GitWins => f.write_str("GitWins"),
      Self::ManualMerge => f.write_str("ManualMerge"),
      Self::Dismissed => f.write_str("Dismissed"),
    }
  }
}

// ─── Value Objects ───────────────────────────────────────────────────────────

/// Validated relative path inside a Git repository.
///
/// Invariants enforced at construction:
/// - non-empty
/// - no leading `/`
/// - no backslashes (Windows-style paths)
/// - no `..` traversal segments
/// - no null bytes
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RepoPath(String);

impl RepoPath {
  /// Create a new `RepoPath`, returning an error message if validation fails.
  pub fn new(path: impl Into<String>) -> Result<Self, &'static str> {
    let path = path.into();
    if path.is_empty() {
      return Err("repo path must not be empty");
    }
    if path.starts_with('/') {
      return Err("repo path must not start with '/'");
    }
    if path.contains('\0') {
      return Err("repo path must not contain null bytes");
    }
    if path.contains('\\') {
      return Err("repo path must not contain backslashes");
    }
    if path.split('/').any(|seg| seg == "..") {
      return Err("repo path must not contain '..' traversal segments");
    }
    Ok(Self(path))
  }

  /// Returns the inner path string.
  pub fn as_str(&self) -> &str {
    &self.0
  }

  /// Consumes `self` and returns the inner `String`.
  pub fn into_inner(self) -> String {
    self.0
  }
}

impl fmt::Display for RepoPath {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(&self.0)
  }
}

// ─── Domain Errors ───────────────────────────────────────────────────────────

/// Errors from domain guard violations.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GitSyncDomainError {
  #[error("invalid status transition from {from} to {to}")]
  InvalidStatusTransition { from: String, to: String },

  #[error("cannot mark binding as tombstone while it has open conflicts")]
  TombstoneWithOpenConflicts,

  #[error("conflict is already resolved ({0})")]
  ConflictAlreadyResolved(ConflictResolution),

  /// DOM-RV-01b: `Open` is the initial state, not a valid resolution target.
  #[error("Open is not a valid conflict resolution target")]
  InvalidResolutionTarget,
}

// ─── Entities ────────────────────────────────────────────────────────────────

/// Address of deployed Git-Sync manifests. New extracted scopes have their own
/// nested address; existing profiles retain this one across migration.
pub const LEGACY_GIT_SYNC_MANIFEST_PATH: &str = ".myoxus/git-sync-manifest.json";

fn legacy_git_sync_manifest_path() -> String {
  LEGACY_GIT_SYNC_MANIFEST_PATH.to_string()
}

/// Configuration of a Git target for a workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncProfile {
  pub id: ProfileId,
  pub workspace_id: WorkspaceId,
  pub owner_id: UserId,
  pub repo_url: String,
  pub branch: String,
  /// Root path inside the repository (default `"content/"`).
  pub root_path: String,
  /// Server-derived repository address; never changed through profile editing.
  #[serde(default = "legacy_git_sync_manifest_path")]
  pub manifest_path: String,
  /// Incremented with each scope-fence publication, including Undo.
  #[serde(default)]
  pub scope_revision: i64,
  pub sync_direction: SyncDirection,
  pub trigger_mode: TriggerMode,
  pub polling_interval_secs: Option<i64>,
  pub cron_expression: Option<String>,
  pub cron_timezone: Option<String>,
  pub cron_misfire_policy: Option<crate::scheduling::CronMisfirePolicy>,
  pub cron_next_scheduled_at: Option<DateTime<Utc>>,
  pub cron_pending_misfire_scheduled_for: Option<DateTime<Utc>>,
  pub auth_method: AuthMethod,
  /// Active encrypted credential; an Extract descendant may share this pointer
  /// while the credential's `profile_id` names a different lifecycle steward.
  pub credential_id: Option<Uuid>,
  pub enabled: bool,
  /// Per-workspace mirror storage limit in MB. `None` means use the global
  /// `max_mirror_storage_mb` limit from server config.
  pub max_mirror_storage_mb: Option<i64>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// One durable path fence owned by the source profile, independent of the
/// destination's lifetime and the originating Extract receipt's retention.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncScopeExclusion {
  pub id: Uuid,
  pub profile_id: ProfileId,
  pub repo_path: RepoPath,
  pub is_directory: bool,
  pub destination_profile_id: Option<ProfileId>,
  pub originating_operation_id: Uuid,
  pub scope_revision: i64,
}

impl GitSyncScopeExclusion {
  /// Match a whole directory segment or one exact repository file, never a
  /// textual prefix of a sibling (such as `manual` versus `manual-old`).
  pub fn excludes(&self, path: &RepoPath) -> bool {
    path == &self.repo_path
      || (self.is_directory
        && path
          .as_str()
          .strip_prefix(self.repo_path.as_str())
          .is_some_and(|suffix| suffix.starts_with('/')))
  }
}

/// Stable binding between a Myoxus document and a Git file path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncBinding {
  pub id: BindingId,
  pub profile_id: ProfileId,
  pub workspace_id: WorkspaceId,
  pub doc_id: Uuid,
  /// Stable identity that survives renames/moves (persisted in Git frontmatter).
  pub sync_id: SyncId,
  /// Relative path inside the repository.
  pub repo_path: String,
  pub last_commit_oid: Option<String>,
  /// Exact Markdown body hash last observed in Git. This can differ from the
  /// normalized Myoxus baseline without indicating a content change.
  pub content_hash: Option<String>,
  pub structure_hash: Option<String>,
  pub tombstone: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl GitSyncBinding {
  /// Mark this binding as a tombstone (soft-delete).
  ///
  /// # Errors
  ///
  /// Returns [`GitSyncDomainError::TombstoneWithOpenConflicts`] if there are
  /// unresolved conflicts for this binding.
  #[instrument(skip(self), fields(binding_id = %self.id))]
  pub fn mark_tombstone(&mut self, has_open_conflicts: bool) -> Result<(), GitSyncDomainError> {
    if has_open_conflicts {
      tracing::warn!("attempted to tombstone binding with open conflicts");
      return Err(GitSyncDomainError::TombstoneWithOpenConflicts);
    }
    self.tombstone = true;
    self.updated_at = Utc::now();
    tracing::debug!("binding marked as tombstone");
    Ok(())
  }
}

/// A concrete sync run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncRun {
  pub id: Uuid,
  pub profile_id: ProfileId,
  pub direction: SyncDirection,
  /// Persisted ingress source for this concrete run, independent of later
  /// profile configuration changes.
  pub trigger_source: GitSyncRunSource,
  /// Exact UTC schedule slot for automatic Cron ingress.
  pub scheduled_for: Option<DateTime<Utc>>,
  pub status: RunStatus,
  pub started_at: DateTime<Utc>,
  pub finished_at: Option<DateTime<Utc>>,
  pub commit_before: Option<String>,
  pub commit_after: Option<String>,
  /// Remote branch OID observed by the Git transport after push/fetch.
  pub observed_remote_oid: Option<String>,
  /// True only when the remote moved but normal Myoxus finalization rolled back.
  pub reconciliation_required: bool,
  /// Operator-facing recovery context for a cross-system partial outcome.
  pub reconciliation_reason: Option<String>,
  pub docs_created: i32,
  pub docs_updated: i32,
  pub docs_deleted: i32,
  pub conflicts_found: i32,
  pub error_message: Option<String>,
  pub error_class: Option<ErrorClass>,
  pub job_id: Option<String>,
}

/// Stable multi-run batch envelope for `max_docs_per_sync`.
///
/// Runs are operational attempts; this session is the user-visible progress
/// contract for large document/markdown syncs that must span multiple runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncPartialSession {
  pub id: Uuid,
  pub profile_id: ProfileId,
  pub direction: SyncDirection,
  pub source_workspace_watermark: Option<DateTime<Utc>>,
  pub source_git_commit_oid: Option<String>,
  pub status: PartialSessionStatus,
  pub total_items: i32,
  pub processed_items: i32,
  pub failed_items: i32,
  pub created_run_id: Uuid,
  pub last_run_id: Option<Uuid>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub completed_at: Option<DateTime<Utc>>,
}

/// One deterministic unit of work inside a partial sync session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncPartialItem {
  pub id: Uuid,
  pub session_id: Uuid,
  pub profile_id: ProfileId,
  pub item_kind: PartialItemKind,
  pub item_key: String,
  pub doc_id: Option<Uuid>,
  pub repo_path: Option<String>,
  pub sort_key: String,
  pub status: PartialItemStatus,
  pub attempts: i32,
  pub last_run_id: Option<Uuid>,
  pub error_class: Option<ErrorClass>,
  pub error_message: Option<String>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl GitSyncRun {
  /// Transition the run to [`RunStatus::Completed`].
  ///
  /// # Errors
  ///
  /// Returns an error if the current status is not `Running`.
  #[instrument(skip(self), fields(run_id = %self.id, from = %self.status))]
  pub fn complete(&mut self, commit_after: Option<String>) -> Result<(), GitSyncDomainError> {
    if self.status != RunStatus::Running {
      return Err(GitSyncDomainError::InvalidStatusTransition {
        from: self.status.to_string(),
        to: RunStatus::Completed.to_string(),
      });
    }
    self.status = RunStatus::Completed;
    self.commit_after = commit_after;
    self.reconciliation_required = false;
    self.reconciliation_reason = None;
    self.finished_at = Some(Utc::now());
    tracing::info!("sync run completed");
    Ok(())
  }

  /// Transition the run to [`RunStatus::Failed`].
  ///
  /// # Errors
  ///
  /// Returns an error if the current status is not `Pending` or `Running`.
  #[instrument(skip(self), fields(run_id = %self.id, from = %self.status))]
  pub fn fail(&mut self, error_message: String, error_class: ErrorClass) -> Result<(), GitSyncDomainError> {
    if !matches!(self.status, RunStatus::Pending | RunStatus::Running) {
      return Err(GitSyncDomainError::InvalidStatusTransition {
        from: self.status.to_string(),
        to: RunStatus::Failed.to_string(),
      });
    }
    self.status = RunStatus::Failed;
    self.error_message = Some(error_message);
    self.error_class = Some(error_class);
    self.finished_at = Some(Utc::now());
    tracing::warn!(error_class = %error_class, "sync run failed");
    Ok(())
  }

  /// Transition the run from `Pending` to `Running`.
  ///
  /// # Errors
  ///
  /// Returns an error if the current status is not `Pending`.
  #[instrument(skip(self), fields(run_id = %self.id, from = %self.status))]
  pub fn start(&mut self) -> Result<(), GitSyncDomainError> {
    if self.status != RunStatus::Pending {
      return Err(GitSyncDomainError::InvalidStatusTransition {
        from: self.status.to_string(),
        to: RunStatus::Running.to_string(),
      });
    }
    self.status = RunStatus::Running;
    self.started_at = Utc::now();
    tracing::debug!("sync run started");
    Ok(())
  }

  /// Transition the run to [`RunStatus::Cancelled`].
  ///
  /// # Errors
  ///
  /// Returns an error if the current status is not `Pending` or `Running`.
  #[instrument(skip(self), fields(run_id = %self.id, from = %self.status))]
  pub fn cancel(&mut self) -> Result<(), GitSyncDomainError> {
    if !matches!(self.status, RunStatus::Pending | RunStatus::Running) {
      return Err(GitSyncDomainError::InvalidStatusTransition {
        from: self.status.to_string(),
        to: RunStatus::Cancelled.to_string(),
      });
    }
    self.status = RunStatus::Cancelled;
    self.finished_at = Some(Utc::now());
    tracing::info!("sync run cancelled");
    Ok(())
  }
}

/// Persisted conflict between Myoxus and Git states.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncConflict {
  pub id: Uuid,
  pub profile_id: ProfileId,
  /// The binding this conflict relates to. `None` when the conflict is for a
  /// doc that has no binding yet (e.g. detected during first sync before a
  /// binding was created).
  pub binding_id: Option<BindingId>,
  pub doc_id: Uuid,
  pub repo_path: String,
  pub conflict_type: ConflictType,
  pub resolution: ConflictResolution,
  pub base_content: Option<String>,
  pub myoxus_content: Option<String>,
  pub git_content: Option<String>,
  pub created_at: DateTime<Utc>,
  pub resolved_at: Option<DateTime<Utc>>,
  pub resolved_by: Option<UserId>,
}

impl GitSyncConflict {
  /// Resolve this conflict with the given resolution strategy.
  ///
  /// # Errors
  ///
  /// Returns [`GitSyncDomainError::ConflictAlreadyResolved`] if the conflict
  /// is no longer `Open`.
  #[instrument(skip(self), fields(conflict_id = %self.id, resolution = %resolution))]
  pub fn resolve(&mut self, resolution: ConflictResolution, resolved_by: UserId) -> Result<(), GitSyncDomainError> {
    if self.resolution != ConflictResolution::Open {
      tracing::warn!(
          current = %self.resolution,
          "attempted to resolve already-resolved conflict"
      );
      return Err(GitSyncDomainError::ConflictAlreadyResolved(self.resolution));
    }
    // DOM-RV-01: Open is not a valid resolution target — it's the initial state.
    if resolution == ConflictResolution::Open {
      return Err(GitSyncDomainError::InvalidResolutionTarget);
    }
    self.resolution = resolution;
    self.resolved_at = Some(Utc::now());
    self.resolved_by = Some(resolved_by);
    tracing::info!("conflict resolved");
    Ok(())
  }
}

/// Reference to encrypted credential material.
///
/// The actual secret (token, password, SSH key) is stored encrypted in the
/// database and is never exposed via the API layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCredentialRef {
  pub id: Uuid,
  /// Steward of the encrypted row and its rotation configuration, not
  /// necessarily every profile consuming this active credential.
  pub profile_id: ProfileId,
  pub auth_method: AuthMethod,
  /// User-visible label, e.g. "GitHub Token".
  pub label: String,
  pub created_at: DateTime<Utc>,
  /// Optional expiry timestamp. If set and in the past, the credential is expired.
  pub expires_at: Option<DateTime<Utc>>,
}

impl GitCredentialRef {
  /// Returns `true` if the credential has an expiry date that is in the past.
  pub fn is_expired(&self) -> bool {
    self.expires_at.is_some_and(|exp| exp < Utc::now())
  }

  /// Returns `true` if the credential expires within the given duration.
  pub fn expires_within(&self, duration: chrono::Duration) -> bool {
    self.expires_at.is_some_and(|exp| exp < Utc::now() + duration)
  }
}

/// Last known common state for 3-way merge (baseline snapshot).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncBaseline {
  pub binding_id: BindingId,
  pub content_hash: String,
  pub commit_oid: String,
  pub myoxus_updated_at: DateTime<Utc>,
  pub captured_at: DateTime<Utc>,
}

// ─── File Sync Entities ───────────────────────────────────────────────────────

/// Binding between a non-markdown file (blob) and a Git repository path.
///
/// Unlike [`GitSyncBinding`] which maps Myoxus documents (markdown) to git
/// paths, this maps binary files (images, PDFs, etc.) stored in the blob store
/// to their corresponding paths in the git repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncFileBinding {
  pub id: Uuid,
  pub profile_id: ProfileId,
  pub workspace_id: WorkspaceId,
  pub blob_key: String,
  pub repo_path: String,
  pub content_hash: String,
  pub mime_type: String,
  pub file_size: i64,
  pub tombstoned: bool,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Last-synced state for a file binding, used in 3-way merge reconciliation.
///
/// Analogous to [`GitSyncBaseline`] but keyed on `(profile_id, blob_key)`
/// instead of `binding_id`, since file bindings are identified by their blob
/// store key within a profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncFileBaseline {
  pub id: Uuid,
  pub profile_id: ProfileId,
  pub blob_key: String,
  pub content_hash: String,
  pub commit_oid: Option<String>,
  pub synced_at: DateTime<Utc>,
}

// ─── File Conflict Entity ─────────────────────────────────────────────────────

/// Persisted conflict for a non-markdown file (image, PDF, etc.) detected
/// during sync.  Unlike [`GitSyncConflict`] which is doc-oriented and
/// requires a binding_id + doc_id, file conflicts are keyed by repo_path
/// and store content hashes instead of full content bodies.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncFileConflict {
  pub id: Uuid,
  pub profile_id: ProfileId,
  pub run_id: Uuid,
  /// Optional binding identity. `None` is valid for git-only files that do not
  /// have a Myoxus blob binding yet.
  pub binding_id: Option<Uuid>,
  /// Optional blob key. Present when the conflict can be tied to a Myoxus blob.
  pub blob_key: Option<String>,
  pub repo_path: String,
  pub conflict_type: ConflictType,
  pub resolution: ConflictResolution,
  pub git_hash: Option<String>,
  pub myoxus_hash: Option<String>,
  pub baseline_hash: Option<String>,
  pub created_at: DateTime<Utc>,
  pub resolved_at: Option<DateTime<Utc>>,
  pub resolved_by: Option<UserId>,
}

// ─── Version Link Entity ──────────────────────────────────────────────────────

/// Provenance record linking a synced object to its git commit and/or Myoxus
/// history entry.
///
/// Each version link captures the state at the moment of sync for a single
/// object (document or file) within a run. This provides a full audit trail:
/// given a commit OID, you can find every Myoxus object that was pushed in
/// that commit; given a doc/blob, you can find every sync event in its history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncVersionLink {
  pub id: Uuid,
  pub profile_id: ProfileId,
  pub run_id: Uuid,
  /// `"doc"` or `"file"`.
  pub sync_object_kind: String,
  /// Document ID (as string) or blob key.
  pub sync_object_id: String,
  /// `"push"` or `"pull"`.
  pub direction: String,
  /// Git commit hash (set after push, or source commit for pull).
  pub git_commit_oid: Option<String>,
  /// Optional link to `doc_histories.id` for document version tracking.
  pub myoxus_history_id: Option<Uuid>,
  /// Relative file path inside the git repository.
  pub repo_path: String,
  /// Content hash at time of sync.
  pub content_hash: Option<String>,
  pub created_at: DateTime<Utc>,
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;

  // ── Helpers ──────────────────────────────────────────────────────────

  fn make_conflict() -> GitSyncConflict {
    let now = Utc::now();
    GitSyncConflict {
      id: Uuid::new_v4(),
      profile_id: Uuid::new_v4(),
      binding_id: Some(Uuid::new_v4()),
      doc_id: Uuid::new_v4(),
      repo_path: "content/test.md".into(),
      conflict_type: ConflictType::BothModified,
      resolution: ConflictResolution::Open,
      base_content: None,
      myoxus_content: None,
      git_content: None,
      created_at: now,
      resolved_at: None,
      resolved_by: None,
    }
  }

  fn make_binding() -> GitSyncBinding {
    let now = Utc::now();
    GitSyncBinding {
      id: Uuid::new_v4(),
      profile_id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      sync_id: Uuid::new_v4(),
      repo_path: "content/test.md".into(),
      last_commit_oid: None,
      content_hash: None,
      structure_hash: None,
      tombstone: false,
      created_at: now,
      updated_at: now,
    }
  }

  fn make_run(status: RunStatus) -> GitSyncRun {
    let now = Utc::now();
    GitSyncRun {
      id: Uuid::new_v4(),
      profile_id: Uuid::new_v4(),
      direction: SyncDirection::Bidirectional,
      trigger_source: GitSyncRunSource::Manual,
      scheduled_for: None,
      status,
      started_at: now,
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
      job_id: None,
    }
  }

  // ── Conflict resolution transitions ─────────────────────────────────

  #[test]
  fn conflict_open_to_myoxus_wins_ok() {
    let mut c = make_conflict();
    let user = Uuid::new_v4();
    assert!(c.resolve(ConflictResolution::MyoxusWins, user).is_ok());
    assert_eq!(c.resolution, ConflictResolution::MyoxusWins);
    assert!(c.resolved_at.is_some());
    assert_eq!(c.resolved_by, Some(user));
  }

  #[test]
  fn conflict_open_to_git_wins_ok() {
    let mut c = make_conflict();
    assert!(c.resolve(ConflictResolution::GitWins, Uuid::new_v4()).is_ok());
    assert_eq!(c.resolution, ConflictResolution::GitWins);
  }

  #[test]
  fn conflict_open_to_manual_merge_ok() {
    let mut c = make_conflict();
    assert!(c.resolve(ConflictResolution::ManualMerge, Uuid::new_v4()).is_ok());
  }

  #[test]
  fn conflict_open_to_dismissed_ok() {
    let mut c = make_conflict();
    assert!(c.resolve(ConflictResolution::Dismissed, Uuid::new_v4()).is_ok());
  }

  #[test]
  fn conflict_resolved_cannot_reopen() {
    let mut c = make_conflict();
    c.resolve(ConflictResolution::MyoxusWins, Uuid::new_v4()).unwrap();
    let err = c.resolve(ConflictResolution::Open, Uuid::new_v4()).unwrap_err();
    assert!(matches!(err, GitSyncDomainError::ConflictAlreadyResolved(_)));
  }

  /// DOM-RV-01: `resolve(Open, ...)` on an open conflict must fail.
  #[test]
  fn conflict_open_cannot_resolve_to_open() {
    let mut c = make_conflict();
    let err = c.resolve(ConflictResolution::Open, Uuid::new_v4()).unwrap_err();
    assert!(matches!(err, GitSyncDomainError::InvalidResolutionTarget));
    // Conflict must remain unchanged
    assert_eq!(c.resolution, ConflictResolution::Open);
    assert!(c.resolved_at.is_none());
    assert!(c.resolved_by.is_none());
  }

  #[test]
  fn conflict_resolved_cannot_change_resolution() {
    let mut c = make_conflict();
    c.resolve(ConflictResolution::GitWins, Uuid::new_v4()).unwrap();
    let err = c.resolve(ConflictResolution::MyoxusWins, Uuid::new_v4()).unwrap_err();
    assert!(matches!(err, GitSyncDomainError::ConflictAlreadyResolved(_)));
  }

  // ── Binding tombstone rules ─────────────────────────────────────────

  #[test]
  fn binding_tombstone_no_conflicts_ok() {
    let mut b = make_binding();
    assert!(b.mark_tombstone(false).is_ok());
    assert!(b.tombstone);
  }

  #[test]
  fn binding_tombstone_with_open_conflicts_fails() {
    let mut b = make_binding();
    let err = b.mark_tombstone(true).unwrap_err();
    assert!(matches!(err, GitSyncDomainError::TombstoneWithOpenConflicts));
    assert!(!b.tombstone);
  }

  // ── Run status transitions ──────────────────────────────────────────

  #[test]
  fn run_pending_to_running_ok() {
    let mut r = make_run(RunStatus::Pending);
    assert!(r.start().is_ok());
    assert_eq!(r.status, RunStatus::Running);
  }

  #[test]
  fn run_running_to_completed_ok() {
    let mut r = make_run(RunStatus::Running);
    assert!(r.complete(Some("abc123".into())).is_ok());
    assert_eq!(r.status, RunStatus::Completed);
    assert_eq!(r.commit_after.as_deref(), Some("abc123"));
    assert!(r.finished_at.is_some());
  }

  #[test]
  fn run_running_to_failed_ok() {
    let mut r = make_run(RunStatus::Running);
    assert!(r.fail("auth denied".into(), ErrorClass::GitAuth).is_ok());
    assert_eq!(r.status, RunStatus::Failed);
    assert_eq!(r.error_class, Some(ErrorClass::GitAuth));
  }

  #[test]
  fn run_pending_to_failed_ok() {
    let mut r = make_run(RunStatus::Pending);
    assert!(r.fail("network".into(), ErrorClass::GitNetwork).is_ok());
    assert_eq!(r.status, RunStatus::Failed);
  }

  #[test]
  fn run_pending_to_cancelled_ok() {
    let mut r = make_run(RunStatus::Pending);
    assert!(r.cancel().is_ok());
    assert_eq!(r.status, RunStatus::Cancelled);
  }

  #[test]
  fn run_running_to_cancelled_ok() {
    let mut r = make_run(RunStatus::Running);
    assert!(r.cancel().is_ok());
    assert_eq!(r.status, RunStatus::Cancelled);
  }

  #[test]
  fn run_completed_cannot_fail() {
    let mut r = make_run(RunStatus::Completed);
    let err = r.fail("oops".into(), ErrorClass::InternalError).unwrap_err();
    assert!(matches!(err, GitSyncDomainError::InvalidStatusTransition { .. }));
  }

  #[test]
  fn run_completed_cannot_start() {
    let mut r = make_run(RunStatus::Completed);
    assert!(r.start().is_err());
  }

  #[test]
  fn run_failed_cannot_complete() {
    let mut r = make_run(RunStatus::Failed);
    assert!(r.complete(None).is_err());
  }

  #[test]
  fn run_cancelled_cannot_complete() {
    let mut r = make_run(RunStatus::Cancelled);
    assert!(r.complete(None).is_err());
  }

  #[test]
  fn run_pending_cannot_complete() {
    let mut r = make_run(RunStatus::Pending);
    assert!(r.complete(None).is_err());
  }

  // ── RepoPath validation ─────────────────────────────────────────────

  #[test]
  fn repo_path_valid() {
    let p = RepoPath::new("content/docs/test.md").unwrap();
    assert_eq!(p.as_str(), "content/docs/test.md");
  }

  #[test]
  fn detached_scope_fence_matches_only_its_own_path_segments() {
    let fence = GitSyncScopeExclusion {
      id: Uuid::new_v4(),
      profile_id: Uuid::new_v4(),
      repo_path: RepoPath::new("content/projects/manual").unwrap(),
      is_directory: true,
      destination_profile_id: None,
      originating_operation_id: Uuid::new_v4(),
      scope_revision: 1,
    };
    assert!(fence.excludes(&RepoPath::new("content/projects/manual/note.md").unwrap()));
    assert!(!fence.excludes(&RepoPath::new("content/projects/manual-old/note.md").unwrap()));
    assert!(!fence.excludes(&RepoPath::new("content/projects").unwrap()));
    let file_fence = GitSyncScopeExclusion {
      repo_path: RepoPath::new("content/projects/manual/note.md").unwrap(),
      is_directory: false,
      ..fence
    };
    assert!(file_fence.excludes(&RepoPath::new("content/projects/manual/note.md").unwrap()));
    assert!(!file_fence.excludes(&RepoPath::new("content/projects/manual/note.md.backup").unwrap()));
  }

  #[test]
  fn repo_path_empty_rejected() {
    assert!(RepoPath::new("").is_err());
  }

  #[test]
  fn repo_path_leading_slash_rejected() {
    assert!(RepoPath::new("/content/test.md").is_err());
  }

  #[test]
  fn repo_path_traversal_rejected() {
    assert!(RepoPath::new("content/../etc/passwd").is_err());
  }

  #[test]
  fn repo_path_null_byte_rejected() {
    assert!(RepoPath::new("content/\0test.md").is_err());
  }

  #[test]
  fn repo_path_backslash_rejected() {
    assert!(RepoPath::new("content\\test.md").is_err());
  }

  #[test]
  fn repo_path_leading_dotdot_rejected() {
    assert!(RepoPath::new("../etc/passwd").is_err());
  }

  #[test]
  fn repo_path_single_dot_segment_allowed() {
    // Single dots (current dir) are harmless and allowed.
    assert!(RepoPath::new("content/./test.md").is_ok());
  }

  #[test]
  fn repo_path_display() {
    let p = RepoPath::new("a/b.md").unwrap();
    assert_eq!(format!("{p}"), "a/b.md");
  }

  // ── Display impls ───────────────────────────────────────────────────

  #[test]
  fn enum_display_roundtrip() {
    assert_eq!(SyncDirection::Bidirectional.to_string(), "Bidirectional");
    assert_eq!(TriggerMode::Webhook.to_string(), "Webhook");
    assert_eq!(AuthMethod::SshKey.to_string(), "SshKey");
    assert_eq!(RunStatus::Completed.to_string(), "Completed");
    assert_eq!(ErrorClass::GitAuth.to_string(), "GitAuth");
    assert_eq!(ConflictType::BothModified.to_string(), "BothModified");
    assert_eq!(ConflictResolution::Open.to_string(), "Open");
  }

  // ── Credential expiry tests ────────────────────────────────────────

  #[test]
  fn credential_not_expired_when_no_expiry() {
    let cred = GitCredentialRef {
      id: Uuid::new_v4(),
      profile_id: Uuid::new_v4(),
      auth_method: AuthMethod::HttpsToken,
      label: "test".into(),
      created_at: Utc::now(),
      expires_at: None,
    };
    assert!(!cred.is_expired());
    assert!(!cred.expires_within(chrono::Duration::days(7)));
  }

  #[test]
  fn credential_expired_when_in_past() {
    let cred = GitCredentialRef {
      id: Uuid::new_v4(),
      profile_id: Uuid::new_v4(),
      auth_method: AuthMethod::HttpsToken,
      label: "test".into(),
      created_at: Utc::now(),
      expires_at: Some(Utc::now() - chrono::Duration::hours(1)),
    };
    assert!(cred.is_expired());
    assert!(cred.expires_within(chrono::Duration::days(7)));
  }

  #[test]
  fn credential_not_expired_when_in_future() {
    let cred = GitCredentialRef {
      id: Uuid::new_v4(),
      profile_id: Uuid::new_v4(),
      auth_method: AuthMethod::HttpsToken,
      label: "test".into(),
      created_at: Utc::now(),
      expires_at: Some(Utc::now() + chrono::Duration::days(30)),
    };
    assert!(!cred.is_expired());
    assert!(!cred.expires_within(chrono::Duration::days(7)));
  }

  #[test]
  fn credential_expires_within_7_days() {
    let cred = GitCredentialRef {
      id: Uuid::new_v4(),
      profile_id: Uuid::new_v4(),
      auth_method: AuthMethod::HttpsToken,
      label: "test".into(),
      created_at: Utc::now(),
      expires_at: Some(Utc::now() + chrono::Duration::days(3)),
    };
    assert!(!cred.is_expired());
    assert!(cred.expires_within(chrono::Duration::days(7)));
  }

  #[test]
  fn conflict_resolution_is_resolved() {
    assert!(!ConflictResolution::Open.is_resolved());
    assert!(ConflictResolution::MyoxusWins.is_resolved());
    assert!(ConflictResolution::GitWins.is_resolved());
    assert!(ConflictResolution::ManualMerge.is_resolved());
    assert!(ConflictResolution::Dismissed.is_resolved());
  }
}
