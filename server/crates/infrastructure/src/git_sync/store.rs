//! SQLx-backed Git Sync store implementation.
//!
//! [`SqlxGitSyncStore`] provides CRUD operations for Git Sync profiles,
//! bindings, runs, conflicts, credentials, and baselines against PostgreSQL.

use sqlx::{PgConnection, PgPool, Row};
use tracing::{debug, error, instrument, trace};
use uuid::Uuid;

mod conflict_observation;
mod retention;
mod rotation_admission;
pub use retention::GitSyncHistoryCleanupBatch;

use myoxus_application::git_sync::bootstrap::{
  BootstrapAttempt, BootstrapAttemptPhase, BootstrapPlan, BootstrapReport,
};
use myoxus_application::git_sync::export::GitSyncWriterScope;
use myoxus_application::git_sync::finalization::GitSyncPostPushPlan;
use myoxus_application::git_sync::{
  EncryptedGitCredential, GitSyncDeleteImpact, GitSyncLifecyclePolicy, GitSyncLifecycleStore,
  GitSyncLifecycleStoreError, GitSyncReconciliationInventory, GitSyncReconciliationPlan, GitSyncReconciliationStore,
  GitSyncReconciliationStoreError, GitSyncWebhookDelivery, GitSyncWebhookDeliveryAdmission, GitSyncWebhookStore,
  GitSyncWebhookStoreError, GitTokenRotationAdmission, GitTokenRotationConfiguration, GitTokenRotationProviderKind,
  GitTokenRotationState, GitTokenRotationStatus, GitTokenRotationStore, GitTokenRotationStoreError,
  ReconciliationDocument, git_token_rotation::requested_expiry,
};
use myoxus_application::scheduling::cron::CronSchedule;
use myoxus_domain::git_sync::{
  AuthMethod, ConflictResolution, ConflictType, ErrorClass, GitCredentialRef, GitSyncBaseline, GitSyncBinding,
  GitSyncConflict, GitSyncFileBaseline, GitSyncFileBinding, GitSyncFileConflict, GitSyncPartialItem,
  GitSyncPartialSession, GitSyncProfile, GitSyncRun, GitSyncRunSource, GitSyncScopeExclusion, GitSyncVersionLink,
  PartialItemKind, PartialItemStatus, PartialSessionStatus, RepoPath, RunStatus, SyncDirection, TriggerMode,
};
use myoxus_domain::scheduling::CronMisfirePolicy;

use crate::document_metadata::initial_sync_audit::{
  ImportedWorkspaceDocumentCreate, ensure_imported_workspace_document_at, workspace_document_first_create_lock_key,
};

use super::ssh_host_keys::{GitSyncSshHostKey, ObservedSshHostKey};

// Profile timing projections retain their existing public names, not a second
// native cursor or a compatibility view over the removed columns.
const PROFILE_SELECT: &str = "SELECT p.id,p.workspace_id,p.owner_id,p.repo_url,p.branch,p.root_path,p.manifest_path,p.scope_revision,p.sync_direction,p.trigger_mode,p.polling_interval_secs,p.cron_expression,p.cron_timezone,p.cron_misfire_policy,cron.next_due_at AS cron_next_scheduled_at,cron.pending_due_at AS cron_pending_misfire_scheduled_for,p.auth_method,p.credential_id,p.enabled,p.max_mirror_storage_mb,p.created_at,p.updated_at FROM git_sync_profiles p LEFT JOIN scheduling_schedules cron ON cron.id=p.id AND cron.target_json->>'kind'='git_cron'";

/// A grandchild has permission to run only when every intermediate configured
/// profile still owns the next exact subtree. A missing intermediate leaves
/// its source fence intact but cannot grant an unproven new writer access.
fn has_delegation_chain(
  ancestor: &GitSyncProfile,
  descendant: &GitSyncProfile,
  peers: &[(GitSyncProfile, GitSyncWriterScope)],
) -> GitSyncResult<bool> {
  let mut pending = vec![ancestor.id];
  let mut visited = std::collections::HashSet::new();
  while let Some(parent_id) = pending.pop() {
    if !visited.insert(parent_id) {
      continue;
    }
    let Some((parent, scope)) = peers.iter().find(|(profile, _)| profile.id == parent_id) else {
      continue;
    };
    for (candidate, _) in peers {
      if scope
        .delegates_to(parent, candidate)
        .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?
      {
        if candidate.id == descendant.id {
          return Ok(true);
        }
        pending.push(candidate.id);
      }
    }
  }
  Ok(false)
}

/// Lock the selected profile and every consumer of its active credential in
/// stable order before a replacement takes any profile-row lock. A concurrent
/// pointer change invalidates this inventory and must be retried by the caller.
async fn lock_credential_dependents(tx: &mut PgConnection, profile_id: Uuid) -> Result<bool, sqlx::Error> {
  let original: Option<Uuid> = sqlx::query_scalar("SELECT credential_id FROM git_sync_profiles WHERE id = $1")
    .bind(profile_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
  sqlx::query(
    "SELECT id FROM git_sync_profiles
     WHERE id = $1 OR credential_id = $2
       OR credential_id IN (SELECT id FROM git_sync_credentials WHERE profile_id = $1)
       OR id = (SELECT profile_id FROM git_sync_credentials WHERE id = $2)
     ORDER BY id FOR UPDATE",
  )
  .bind(profile_id)
  .bind(original)
  .fetch_all(&mut *tx)
  .await?;
  let locked: Option<Uuid> = sqlx::query_scalar("SELECT credential_id FROM git_sync_profiles WHERE id = $1")
    .bind(profile_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
  if original != locked {
    return Ok(false);
  }
  // Metadata completion has no normal run marker. Its repository session guard
  // still excludes credential replacement/rotation during actual native I/O.
  let scopes = sqlx::query(
    "SELECT DISTINCT repo_url,branch FROM git_sync_profiles WHERE id=$1 OR credential_id=$2 ORDER BY repo_url,branch",
  )
  .bind(profile_id)
  .bind(locked)
  .fetch_all(&mut *tx)
  .await?;
  for scope in scopes {
    let scope = myoxus_application::git_sync::GitSyncRepositoryScope::new(scope.get("repo_url"), scope.get("branch"))
      .map_err(|_| sqlx::Error::Protocol("invalid Git-Sync repository coordination scope".into()))?;
    let owned: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1::text,0))")
      .bind(scope.advisory_key())
      .fetch_one(&mut *tx)
      .await?;
    if !owned {
      return Ok(false);
    }
  }
  Ok(true)
}

/// Move credential stewardship before deleting profiles (including a Workspace
/// cascade). The caller holds the deletion transaction; no secret bytes leave SQL.
/// Lock all affected profiles in UUID order before changing either FK owner.
pub(crate) async fn rehome_credentials_before_profile_deletion(
  tx: &mut PgConnection,
  profile_ids: &[Uuid],
) -> Result<(), sqlx::Error> {
  if profile_ids.is_empty() {
    return Ok(());
  }
  let owned = sqlx::query("SELECT id, profile_id FROM git_sync_credentials WHERE profile_id = ANY($1) ORDER BY id")
    .bind(profile_ids)
    .fetch_all(&mut *tx)
    .await?;
  let credential_ids: Vec<Uuid> = owned.iter().map(|row| row.get("id")).collect();
  let profiles = sqlx::query(
    "SELECT id, credential_id FROM git_sync_profiles
     WHERE id = ANY($1) OR credential_id = ANY($2)
     ORDER BY id FOR UPDATE",
  )
  .bind(profile_ids)
  .bind(&credential_ids)
  .fetch_all(&mut *tx)
  .await?;
  for row in owned {
    let credential_id: Uuid = row.get("id");
    let old_owner: Uuid = row.get("profile_id");
    let next_owner = profiles
      .iter()
      .filter(|profile| {
        let id: Uuid = profile.get("id");
        !profile_ids.contains(&id) && profile.get::<Option<Uuid>, _>("credential_id") == Some(credential_id)
      })
      .map(|profile| profile.get::<Uuid, _>("id"))
      .min();
    if let Some(next_owner) = next_owner {
      let rotation_belongs_to_credential = profiles.iter().any(|profile| {
        profile.get::<Uuid, _>("id") == old_owner
          && profile.get::<Option<Uuid>, _>("credential_id") == Some(credential_id)
      });
      if rotation_belongs_to_credential {
        // An admitted renewal must be reconciled before its steward can move.
        let rotating: bool = sqlx::query_scalar(
          "SELECT EXISTS(SELECT 1 FROM git_token_rotation WHERE profile_id = $1 AND state = 'Rotating')",
        )
        .bind(old_owner)
        .fetch_one(&mut *tx)
        .await?;
        if rotating {
          return Err(sqlx::Error::Protocol(
            "Git-Sync credential rotation is in progress".into(),
          ));
        }
        sqlx::query("UPDATE git_token_rotation SET profile_id = $2, updated_at = now() WHERE profile_id = $1")
          .bind(old_owner)
          .bind(next_owner)
          .execute(&mut *tx)
          .await?;
      }
      sqlx::query("UPDATE git_sync_credentials SET profile_id = $2 WHERE id = $1 AND profile_id = $3")
        .bind(credential_id)
        .bind(next_owner)
        .bind(old_owner)
        .execute(&mut *tx)
        .await?;
    }
  }
  Ok(())
}

// ─── Error Handling ──────────────────────────────────────────────────────────

/// Errors from Git Sync persistence operations.
#[derive(Debug, thiserror::Error)]
pub enum GitSyncStoreError {
  #[error("database error: {0}")]
  Database(#[from] sqlx::Error),

  #[error("not found")]
  NotFound,

  #[error("invalid enum value: {field} = {value}")]
  InvalidEnum { field: String, value: String },

  #[error(
    "unfinished run conflicts with requested admission: existing direction={existing_direction}, \
     trigger={existing_trigger}; requested direction={requested_direction}, trigger={requested_trigger}"
  )]
  UnfinishedRunConflict {
    existing_direction: SyncDirection,
    existing_trigger: GitSyncRunSource,
    requested_direction: SyncDirection,
    requested_trigger: GitSyncRunSource,
  },

  #[error("SSH host key conflict: {0}")]
  SshHostKeyConflict(String),

  #[error("invalid Git-Sync persistence plan: {0}")]
  Validation(String),

  #[error("Git-Sync post-push commit outcome is unknown for run {run_id}: {message}")]
  CommitOutcomeUnknown {
    run_id: Uuid,
    message: String,
    document_conflicts_created: usize,
    file_conflicts_created: usize,
  },
}

pub type GitSyncResult<T> = Result<T, GitSyncStoreError>;

/// Insertion counts describe this committed observation, not every open decision
/// seen by planning. They also survive an unknown COMMIT acknowledgement.
#[derive(Debug)]
pub struct GitSyncPostPushCommit {
  pub run: GitSyncRun,
  pub document_conflicts_created: usize,
  pub file_conflicts_created: usize,
}

#[derive(Debug, Clone)]
pub struct PendingGitSyncDispatch {
  pub run: GitSyncRun,
}

#[derive(Debug, Clone)]
pub struct GitSyncCronAdmission {
  pub profile_id: Uuid,
  pub run: Option<GitSyncRun>,
  pub skipped_occurrences: usize,
  pub pending_misfire_scheduled_for: Option<chrono::DateTime<chrono::Utc>>,
  pub policy_denial: Option<String>,
}

/// Persistence projection used to materialize the current document set for a
/// Git-Sync run. Payload loading remains owned by `DocService`.
#[derive(Debug, Clone)]
pub struct GitSyncDocumentProjection {
  pub id: Uuid,
  pub title: String,
  pub external_id: Option<String>,
  pub effective_updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct GitSyncBlobPromotion {
  pub id: Uuid,
  pub run_id: Uuid,
  pub profile_id: Uuid,
  pub workspace_id: Uuid,
  pub stage_key: String,
  pub final_key: String,
  pub newly_promoted: Option<bool>,
  pub db_committed: bool,
  pub run_status: RunStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitSyncProfileCleanupState {
  pub exists: bool,
  pub has_unfinished_run: bool,
}

// ─── Enum Parsing ────────────────────────────────────────────────────────────

fn parse_sync_direction(s: &str) -> Result<SyncDirection, GitSyncStoreError> {
  match s {
    "Bidirectional" => Ok(SyncDirection::Bidirectional),
    "MyoxusToGit" => Ok(SyncDirection::MyoxusToGit),
    "GitToMyoxus" => Ok(SyncDirection::GitToMyoxus),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "sync_direction".into(),
      value: s.into(),
    }),
  }
}

fn parse_trigger_mode(s: &str) -> Result<TriggerMode, GitSyncStoreError> {
  match s {
    "Manual" => Ok(TriggerMode::Manual),
    "Polling" => Ok(TriggerMode::Polling),
    "Webhook" => Ok(TriggerMode::Webhook),
    "Cron" => Ok(TriggerMode::Cron),
    "HistoryCapture" => Ok(TriggerMode::HistoryCapture),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "trigger_mode".into(),
      value: s.into(),
    }),
  }
}

fn parse_run_source(s: &str) -> Result<GitSyncRunSource, GitSyncStoreError> {
  match s {
    "Manual" => Ok(GitSyncRunSource::Manual),
    "Polling" => Ok(GitSyncRunSource::Polling),
    "Webhook" => Ok(GitSyncRunSource::Webhook),
    "Cron" => Ok(GitSyncRunSource::Cron),
    "HistoryCapture" => Ok(GitSyncRunSource::HistoryCapture),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "trigger_source".into(),
      value: s.into(),
    }),
  }
}

fn parse_cron_misfire_policy(s: &str) -> Result<CronMisfirePolicy, GitSyncStoreError> {
  match s {
    "Skip" => Ok(CronMisfirePolicy::Skip),
    "RunOnce" => Ok(CronMisfirePolicy::RunOnce),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "cron_misfire_policy".into(),
      value: s.into(),
    }),
  }
}

fn parse_token_rotation_provider(value: &str) -> Result<GitTokenRotationProviderKind, GitTokenRotationStoreError> {
  match value {
    "GitLab" => Ok(GitTokenRotationProviderKind::GitLab),
    _ => Err(GitTokenRotationStoreError::Storage(
      "invalid persisted token rotation provider".into(),
    )),
  }
}

fn parse_token_rotation_state(value: &str) -> Result<GitTokenRotationState, GitTokenRotationStoreError> {
  match value {
    "Configured" => Ok(GitTokenRotationState::Configured),
    "Rotating" => Ok(GitTokenRotationState::Rotating),
    "Completed" => Ok(GitTokenRotationState::Completed),
    "Failed" => Ok(GitTokenRotationState::Failed),
    "ManualIntervention" => Ok(GitTokenRotationState::ManualIntervention),
    _ => Err(GitTokenRotationStoreError::Storage(
      "invalid persisted token rotation state".into(),
    )),
  }
}

fn is_https_repository(value: &str) -> bool {
  reqwest::Url::parse(value).is_ok_and(|url| url.scheme() == "https")
}

fn parse_auth_method(s: &str) -> Result<AuthMethod, GitSyncStoreError> {
  match s {
    "HttpsToken" => Ok(AuthMethod::HttpsToken),
    "HttpsPassword" => Ok(AuthMethod::HttpsPassword),
    "SshKey" => Ok(AuthMethod::SshKey),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "auth_method".into(),
      value: s.into(),
    }),
  }
}

fn parse_run_status(s: &str) -> Result<RunStatus, GitSyncStoreError> {
  match s {
    "Pending" => Ok(RunStatus::Pending),
    "Running" => Ok(RunStatus::Running),
    "Completed" => Ok(RunStatus::Completed),
    "Failed" => Ok(RunStatus::Failed),
    "Cancelled" => Ok(RunStatus::Cancelled),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "status".into(),
      value: s.into(),
    }),
  }
}

fn parse_error_class(s: &str) -> Result<ErrorClass, GitSyncStoreError> {
  match s {
    "GitAuth" => Ok(ErrorClass::GitAuth),
    "GitNetwork" => Ok(ErrorClass::GitNetwork),
    "GitConflict" => Ok(ErrorClass::GitConflict),
    "ImportError" => Ok(ErrorClass::ImportError),
    "ExportError" => Ok(ErrorClass::ExportError),
    "InternalError" => Ok(ErrorClass::InternalError),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "error_class".into(),
      value: s.into(),
    }),
  }
}

fn parse_conflict_type(s: &str) -> Result<ConflictType, GitSyncStoreError> {
  match s {
    "BothModified" => Ok(ConflictType::BothModified),
    "DeleteVsModify" => Ok(ConflictType::DeleteVsModify),
    "ModifyVsDelete" => Ok(ConflictType::ModifyVsDelete),
    "RenameVsRename" => Ok(ConflictType::RenameVsRename),
    "RenameVsModify" => Ok(ConflictType::RenameVsModify),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "conflict_type".into(),
      value: s.into(),
    }),
  }
}

fn parse_conflict_resolution(s: &str) -> Result<ConflictResolution, GitSyncStoreError> {
  match s {
    "Open" => Ok(ConflictResolution::Open),
    "MyoxusWins" => Ok(ConflictResolution::MyoxusWins),
    "GitWins" => Ok(ConflictResolution::GitWins),
    "ManualMerge" => Ok(ConflictResolution::ManualMerge),
    "Dismissed" => Ok(ConflictResolution::Dismissed),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "resolution".into(),
      value: s.into(),
    }),
  }
}

fn parse_partial_session_status(s: &str) -> Result<PartialSessionStatus, GitSyncStoreError> {
  match s {
    "Open" => Ok(PartialSessionStatus::Open),
    "Completed" => Ok(PartialSessionStatus::Completed),
    "CompletedWithFailures" => Ok(PartialSessionStatus::CompletedWithFailures),
    "Cancelled" => Ok(PartialSessionStatus::Cancelled),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "partial_session_status".into(),
      value: s.into(),
    }),
  }
}

fn parse_partial_item_kind(s: &str) -> Result<PartialItemKind, GitSyncStoreError> {
  match s {
    "Doc" => Ok(PartialItemKind::Doc),
    "GitMarkdown" => Ok(PartialItemKind::GitMarkdown),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "partial_item_kind".into(),
      value: s.into(),
    }),
  }
}

fn parse_partial_item_status(s: &str) -> Result<PartialItemStatus, GitSyncStoreError> {
  match s {
    "Pending" => Ok(PartialItemStatus::Pending),
    "Running" => Ok(PartialItemStatus::Running),
    "Completed" => Ok(PartialItemStatus::Completed),
    "Failed" => Ok(PartialItemStatus::Failed),
    "Conflicted" => Ok(PartialItemStatus::Conflicted),
    _ => Err(GitSyncStoreError::InvalidEnum {
      field: "partial_item_status".into(),
      value: s.into(),
    }),
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

/// PostgreSQL-backed implementation of Git Sync persistence.
pub struct SqlxGitSyncStore {
  pool: PgPool,
}

impl SqlxGitSyncStore {
  /// Construct a `SqlxGitSyncStore` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  /// Clone the underlying pool for infrastructure helpers that must combine
  /// store data with adjacent async policy lookups.
  pub fn pool(&self) -> PgPool {
    self.pool.clone()
  }

  /// Return every persisted profile id for conservative local mirror cleanup.
  /// Scheduler enablement is intentionally unrelated to filesystem ownership.
  pub async fn list_profile_ids(&self) -> GitSyncResult<Vec<Uuid>> {
    sqlx::query_scalar("SELECT id FROM git_sync_profiles")
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  /// Recheck durable profile ownership and unfinished run state while cleanup
  /// already holds the profile's distributed and physical guards.
  pub async fn profile_cleanup_state(&self, profile_id: Uuid) -> GitSyncResult<GitSyncProfileCleanupState> {
    let row = sqlx::query(
      "SELECT
         EXISTS(SELECT 1 FROM git_sync_profiles WHERE id = $1) AS profile_exists,
         EXISTS(
           SELECT 1 FROM git_sync_runs
           WHERE profile_id = $1 AND status IN ('Pending', 'Running')
         ) AS unfinished_run",
    )
    .bind(profile_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(GitSyncProfileCleanupState {
      exists: row.get("profile_exists"),
      has_unfinished_run: row.get("unfinished_run"),
    })
  }

  /// Load active document metadata and the uncompacted-update watermark used
  /// by Git-Sync reconciliation.
  pub async fn list_document_projections(&self, workspace_id: Uuid) -> GitSyncResult<Vec<GitSyncDocumentProjection>> {
    let rows = sqlx::query(
      "SELECT d.id, d.title, d.external_id,
              GREATEST(
                d.updated_at,
                COALESCE(s.updated_at, d.updated_at),
                COALESCE(u.updated_at, d.updated_at)
              ) AS effective_updated_at
       FROM docs d
       LEFT JOIN doc_snapshots s ON s.doc_id = d.id
       LEFT JOIN (
         SELECT doc_id, MAX(server_timestamp) AS updated_at
         FROM doc_updates
         GROUP BY doc_id
       ) u ON u.doc_id = d.id
       WHERE d.workspace_id = $1
         AND d.deleted_at IS NULL
         AND d.is_workspace_root = false
         AND d.blocked = false
       ORDER BY d.created_at ASC",
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| GitSyncDocumentProjection {
          id: row.get("id"),
          title: row.get("title"),
          external_id: row.get("external_id"),
          effective_updated_at: row.get("effective_updated_at"),
        })
        .collect(),
    )
  }

  /// Return document ids deleted at or after the supplied reconciliation
  /// watermark. Database failures are surfaced instead of silently dropping
  /// delete propagation.
  pub async fn list_deleted_document_ids_since(
    &self,
    workspace_id: Uuid,
    cutoff: chrono::DateTime<chrono::Utc>,
  ) -> GitSyncResult<Vec<Uuid>> {
    sqlx::query_scalar(
      "SELECT id FROM docs
       WHERE workspace_id = $1
         AND deleted_at IS NOT NULL
         AND deleted_at >= $2
         AND is_workspace_root = false",
    )
    .bind(workspace_id)
    .bind(cutoff)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  /// Atomically replace the current document snapshot selected by Git conflict
  /// resolution while preserving workspace ownership and editor attribution.
  pub async fn apply_resolved_document_snapshot(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: &str,
    actor_id: Uuid,
    payload: &[u8],
  ) -> GitSyncResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    crate::document_metadata::reject_guide_content_write(&mut tx, doc_id)
      .await
      .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
    let updated = sqlx::query(
      "UPDATE docs
       SET title = $3, updated_by = $4, updated_at = now(), deleted_at = NULL
       WHERE id = $1 AND workspace_id = $2",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(title)
    .bind(actor_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if updated.rows_affected() == 0 {
      return Err(GitSyncStoreError::NotFound);
    }
    sqlx::query(
      "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
       VALUES ($1, $2, $3, 1, now())
       ON CONFLICT (doc_id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         payload = EXCLUDED.payload,
         last_sequence = EXCLUDED.last_sequence,
         updated_at = now()",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(payload)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)
  }

  /// Check the concrete active-workspace membership required before a Git-Sync
  /// run may mutate document state.
  pub async fn owner_has_active_workspace_access(&self, owner_id: Uuid, workspace_id: Uuid) -> GitSyncResult<bool> {
    sqlx::query_scalar(
      "SELECT EXISTS(
         SELECT 1
           FROM workspace_memberships membership
           JOIN workspaces workspace ON workspace.id = membership.workspace_id
            AND workspace.lifecycle_state = 'active'
            AND workspace.deleted_at IS NULL
          WHERE membership.user_id = $1
            AND membership.workspace_id = $2
            AND membership.status = 'Accepted'
       )",
    )
    .bind(owner_id)
    .bind(workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  fn map_db_err(err: sqlx::Error) -> GitSyncStoreError {
    if crate::auth::is_terminal_account_error(&err) {
      return GitSyncStoreError::NotFound;
    }
    error!(error = %err, "database error in git sync store");
    GitSyncStoreError::Database(err)
  }

  fn parse_bootstrap_phase(value: &str) -> GitSyncResult<BootstrapAttemptPhase> {
    match value {
      "Prepared" => Ok(BootstrapAttemptPhase::Prepared),
      "RemoteApplied" => Ok(BootstrapAttemptPhase::RemoteApplied),
      "Completed" => Ok(BootstrapAttemptPhase::Completed),
      "Failed" => Ok(BootstrapAttemptPhase::Failed),
      _ => Err(GitSyncStoreError::InvalidEnum {
        field: "bootstrap_phase".into(),
        value: value.into(),
      }),
    }
  }

  fn map_bootstrap_attempt(row: sqlx::postgres::PgRow) -> GitSyncResult<BootstrapAttempt> {
    let report = serde_json::from_value::<BootstrapReport>(row.get("report"))
      .map_err(|error| GitSyncStoreError::Validation(format!("invalid persisted bootstrap report: {error}")))?;
    Ok(BootstrapAttempt {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      phase: Self::parse_bootstrap_phase(row.get("phase"))?,
      expected_remote_oid: row.get("expected_remote_oid"),
      observed_remote_oid: row.get("observed_remote_oid"),
      desired_tree_fingerprint: row.get("desired_tree_fingerprint"),
      report,
      error_class: row.get("error_class"),
      error_message: row.get("error_message"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
      completed_at: row.get("completed_at"),
    })
  }

  /// Admit one bootstrap only while the profile is disabled and no normal run
  /// can mutate the same state. The report is scrubbed and contains no content
  /// bytes or credentials.
  #[instrument(skip(self, report), fields(%profile_id, %attempt_id))]
  pub async fn create_bootstrap_attempt(
    &self,
    attempt_id: Uuid,
    profile_id: Uuid,
    expected_remote_oid: &str,
    report: &BootstrapReport,
  ) -> GitSyncResult<BootstrapAttempt> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let enabled = sqlx::query_scalar::<_, bool>("SELECT enabled FROM git_sync_profiles WHERE id = $1 FOR UPDATE")
      .bind(profile_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(GitSyncStoreError::NotFound)?;
    if enabled {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync profile must be disabled before bootstrap".into(),
      ));
    }
    let pending: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_content_extract_targets e
      JOIN git_sync_profiles p ON p.workspace_id = e.target_workspace_id WHERE p.id = $1 AND e.git_sync_pending)",
    )
    .bind(profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if pending {
      return Err(GitSyncStoreError::Validation("XWS_GIT_SYNC_HANDOFF_UNAVAILABLE".into()));
    }
    let unfinished = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(
         SELECT 1 FROM git_sync_runs
         WHERE profile_id = $1 AND status IN ('Pending', 'Running')
       )",
    )
    .bind(profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if unfinished {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync profile has an unfinished normal run".into(),
      ));
    }
    let report_json = serde_json::to_value(report)
      .map_err(|error| GitSyncStoreError::Validation(format!("serialize bootstrap report: {error}")))?;
    let row = sqlx::query(
      "INSERT INTO git_sync_bootstrap_attempts
         (id, profile_id, phase, expected_remote_oid,
          desired_tree_fingerprint, report)
       VALUES ($1, $2, 'Prepared', $3, $4, $5)
       RETURNING id, profile_id, phase, expected_remote_oid,
         observed_remote_oid, desired_tree_fingerprint, report,
         error_class, error_message, created_at, updated_at, completed_at",
    )
    .bind(attempt_id)
    .bind(profile_id)
    .bind(expected_remote_oid)
    .bind(&report.desired_tree_fingerprint)
    .bind(report_json)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Self::map_bootstrap_attempt(row)
  }

  #[instrument(skip(self))]
  pub async fn get_bootstrap_attempt(&self, attempt_id: Uuid) -> GitSyncResult<BootstrapAttempt> {
    let row = sqlx::query(
      "SELECT id, profile_id, phase, expected_remote_oid,
         observed_remote_oid, desired_tree_fingerprint, report,
         error_class, error_message, created_at, updated_at, completed_at
       FROM git_sync_bootstrap_attempts WHERE id = $1",
    )
    .bind(attempt_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;
    Self::map_bootstrap_attempt(row)
  }

  /// Persist authenticated remote truth before any normal-state SQL mutation.
  #[instrument(skip(self))]
  pub async fn mark_bootstrap_remote_applied(
    &self,
    attempt_id: Uuid,
    observed_remote_oid: &str,
  ) -> GitSyncResult<BootstrapAttempt> {
    let row = sqlx::query(
      "UPDATE git_sync_bootstrap_attempts
       SET phase = 'RemoteApplied', observed_remote_oid = $2,
           error_class = NULL, error_message = NULL, updated_at = now()
       WHERE id = $1 AND phase = 'Prepared'
       RETURNING id, profile_id, phase, expected_remote_oid,
         observed_remote_oid, desired_tree_fingerprint, report,
         error_class, error_message, created_at, updated_at, completed_at",
    )
    .bind(attempt_id)
    .bind(observed_remote_oid)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| GitSyncStoreError::Validation("bootstrap attempt is not Prepared".into()))?;
    Self::map_bootstrap_attempt(row)
  }

  /// Atomically replace normal-state bindings/baselines and complete the audit.
  ///
  /// All active owners are first tombstoned so existing path-owner triggers can
  /// safely derive swaps and moves. The owner ledger is never written directly.
  #[instrument(skip(self, plan), fields(%attempt_id, %remote_oid))]
  pub async fn complete_bootstrap(
    &self,
    attempt_id: Uuid,
    remote_oid: &str,
    plan: &BootstrapPlan,
  ) -> GitSyncResult<BootstrapAttempt> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query(
      "SELECT a.profile_id, a.phase, a.observed_remote_oid,
              a.desired_tree_fingerprint, p.enabled
       FROM git_sync_bootstrap_attempts a
       JOIN git_sync_profiles p ON p.id = a.profile_id
       WHERE a.id = $1
       FOR UPDATE OF a, p",
    )
    .bind(attempt_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;
    let profile_id: Uuid = row.get("profile_id");
    let phase: String = row.get("phase");
    let observed: Option<String> = row.get("observed_remote_oid");
    let fingerprint: String = row.get("desired_tree_fingerprint");
    let enabled: bool = row.get("enabled");
    if profile_id != plan.report.profile_id
      || phase != "RemoteApplied"
      || observed.as_deref() != Some(remote_oid)
      || fingerprint != plan.report.desired_tree_fingerprint
      || enabled
    {
      return Err(GitSyncStoreError::Validation(
        "bootstrap finalization guard does not match persisted remote truth".into(),
      ));
    }
    let unfinished = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(
         SELECT 1 FROM git_sync_runs
         WHERE profile_id = $1 AND status IN ('Pending', 'Running')
       )",
    )
    .bind(profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if unfinished {
      return Err(GitSyncStoreError::Validation(
        "normal Git-Sync run became active during bootstrap".into(),
      ));
    }

    sqlx::query(
      "UPDATE git_sync_bindings SET tombstone = true, updated_at = now() WHERE profile_id = $1 AND tombstone = false",
    )
    .bind(profile_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query("UPDATE git_sync_file_bindings SET tombstoned = true, updated_at = now() WHERE profile_id = $1 AND tombstoned = false")
      .bind(profile_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    for binding in &plan.document_bindings {
      let result = sqlx::query(
        "INSERT INTO git_sync_bindings
           (id, profile_id, workspace_id, doc_id, sync_id, repo_path,
            last_commit_oid, content_hash, structure_hash, tombstone,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,now())
         ON CONFLICT (id) DO UPDATE SET
           repo_path = EXCLUDED.repo_path,
           last_commit_oid = EXCLUDED.last_commit_oid,
           content_hash = EXCLUDED.content_hash,
           structure_hash = EXCLUDED.structure_hash,
           tombstone = false,
           updated_at = now()
         WHERE git_sync_bindings.profile_id = EXCLUDED.profile_id
           AND git_sync_bindings.workspace_id = EXCLUDED.workspace_id
           AND git_sync_bindings.doc_id = EXCLUDED.doc_id
           AND git_sync_bindings.sync_id = EXCLUDED.sync_id",
      )
      .bind(binding.id)
      .bind(binding.profile_id)
      .bind(binding.workspace_id)
      .bind(binding.doc_id)
      .bind(binding.sync_id)
      .bind(&binding.repo_path)
      .bind(remote_oid)
      .bind(&binding.content_hash)
      .bind(&binding.structure_hash)
      .bind(binding.created_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if result.rows_affected() != 1 {
        return Err(GitSyncStoreError::Validation(format!(
          "document binding {} conflicts with persisted ownership",
          binding.id
        )));
      }
    }
    for baseline in &plan.document_baselines {
      sqlx::query(
        "INSERT INTO git_sync_baselines
           (binding_id, content_hash, commit_oid, myoxus_updated_at, captured_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (binding_id) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           commit_oid = EXCLUDED.commit_oid,
           myoxus_updated_at = EXCLUDED.myoxus_updated_at,
           captured_at = EXCLUDED.captured_at",
      )
      .bind(baseline.binding_id)
      .bind(&baseline.content_hash)
      .bind(remote_oid)
      .bind(baseline.myoxus_updated_at)
      .bind(baseline.captured_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    for binding in &plan.file_bindings {
      let result = sqlx::query(
        "INSERT INTO git_sync_file_bindings
           (id, profile_id, workspace_id, blob_key, repo_path,
            content_hash, mime_type, file_size, tombstoned, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,now())
         ON CONFLICT (id) DO UPDATE SET
           blob_key = EXCLUDED.blob_key,
           repo_path = EXCLUDED.repo_path,
           content_hash = EXCLUDED.content_hash,
           mime_type = EXCLUDED.mime_type,
           file_size = EXCLUDED.file_size,
           tombstoned = false,
           updated_at = now()
         WHERE git_sync_file_bindings.profile_id = EXCLUDED.profile_id
           AND git_sync_file_bindings.workspace_id = EXCLUDED.workspace_id",
      )
      .bind(binding.id)
      .bind(binding.profile_id)
      .bind(binding.workspace_id)
      .bind(&binding.blob_key)
      .bind(&binding.repo_path)
      .bind(&binding.content_hash)
      .bind(&binding.mime_type)
      .bind(binding.file_size)
      .bind(binding.created_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if result.rows_affected() != 1 {
        return Err(GitSyncStoreError::Validation(format!(
          "file binding {} conflicts with persisted ownership",
          binding.id
        )));
      }
    }
    sqlx::query("DELETE FROM git_sync_file_baselines WHERE profile_id = $1")
      .bind(profile_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    for baseline in &plan.file_baselines {
      sqlx::query(
        "INSERT INTO git_sync_file_baselines
           (id, profile_id, blob_key, content_hash, commit_oid, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6)",
      )
      .bind(baseline.id)
      .bind(baseline.profile_id)
      .bind(&baseline.blob_key)
      .bind(&baseline.content_hash)
      .bind(remote_oid)
      .bind(baseline.synced_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    let result = sqlx::query(
      "UPDATE git_sync_bootstrap_attempts
       SET phase = 'Completed', completed_at = now(), updated_at = now()
       WHERE id = $1 AND phase = 'RemoteApplied'
       RETURNING id, profile_id, phase, expected_remote_oid,
         observed_remote_oid, desired_tree_fingerprint, report,
         error_class, error_message, created_at, updated_at, completed_at",
    )
    .bind(attempt_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Self::map_bootstrap_attempt(result)
  }

  #[instrument(skip(self, message))]
  pub async fn fail_bootstrap_attempt(
    &self,
    attempt_id: Uuid,
    class: &str,
    message: &str,
  ) -> GitSyncResult<BootstrapAttempt> {
    let row = sqlx::query(
      "UPDATE git_sync_bootstrap_attempts
       SET phase = 'Failed', error_class = $2, error_message = $3,
           observed_remote_oid = NULL, completed_at = NULL, updated_at = now()
       WHERE id = $1 AND phase = 'Prepared'
       RETURNING id, profile_id, phase, expected_remote_oid,
         observed_remote_oid, desired_tree_fingerprint, report,
         error_class, error_message, created_at, updated_at, completed_at",
    )
    .bind(attempt_id)
    .bind(class)
    .bind(message)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| GitSyncStoreError::Validation("bootstrap attempt cannot transition to Failed".into()))?;
    Self::map_bootstrap_attempt(row)
  }

  /// Attach a scrubbed diagnostic while preserving the resumable saga phase.
  #[instrument(skip(self, message))]
  pub async fn record_bootstrap_error(&self, attempt_id: Uuid, class: &str, message: &str) -> GitSyncResult<()> {
    let result = sqlx::query(
      "UPDATE git_sync_bootstrap_attempts
       SET error_class = $2, error_message = $3, updated_at = now()
       WHERE id = $1 AND phase IN ('Prepared', 'RemoteApplied')",
    )
    .bind(attempt_id)
    .bind(class)
    .bind(message)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() != 1 {
      return Err(GitSyncStoreError::Validation(
        "bootstrap attempt is not recoverable".into(),
      ));
    }
    Ok(())
  }

  // ── Row Mappers ──────────────────────────────────────────────────────

  fn map_profile_row(row: sqlx::postgres::PgRow) -> GitSyncResult<GitSyncProfile> {
    Ok(GitSyncProfile {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      owner_id: row.get("owner_id"),
      repo_url: row.get("repo_url"),
      branch: row.get("branch"),
      root_path: row.get("root_path"),
      manifest_path: row.get("manifest_path"),
      scope_revision: row.get("scope_revision"),
      sync_direction: parse_sync_direction(&row.get::<String, _>("sync_direction"))?,
      trigger_mode: parse_trigger_mode(&row.get::<String, _>("trigger_mode"))?,
      polling_interval_secs: row.get("polling_interval_secs"),
      cron_expression: row.get("cron_expression"),
      cron_timezone: row.get("cron_timezone"),
      cron_misfire_policy: row
        .get::<Option<String>, _>("cron_misfire_policy")
        .as_deref()
        .map(parse_cron_misfire_policy)
        .transpose()?,
      cron_next_scheduled_at: row.get("cron_next_scheduled_at"),
      cron_pending_misfire_scheduled_for: row.get("cron_pending_misfire_scheduled_for"),
      auth_method: parse_auth_method(&row.get::<String, _>("auth_method"))?,
      credential_id: row.get("credential_id"),
      enabled: row.get("enabled"),
      max_mirror_storage_mb: row.get("max_mirror_storage_mb"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    })
  }

  pub(crate) async fn profile_in(conn: &mut sqlx::PgConnection, id: Uuid) -> GitSyncResult<GitSyncProfile> {
    let row = sqlx::query(&format!("{PROFILE_SELECT} WHERE p.id=$1"))
      .bind(id)
      .fetch_optional(conn)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(GitSyncStoreError::NotFound)?;
    Self::map_profile_row(row)
  }

  async fn locked_profile_in(conn: &mut sqlx::PgConnection, id: Uuid) -> GitSyncResult<GitSyncProfile> {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM git_sync_profiles WHERE id=$1 FOR UPDATE")
      .bind(id)
      .fetch_optional(&mut *conn)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(GitSyncStoreError::NotFound)?;
    // A second statement reads the cursor after waiting for the profile lock.
    // An earlier joined snapshot could precede a concurrent admitted Git slot.
    Self::profile_in(conn, id).await
  }

  pub(crate) async fn write_schedules_in(
    conn: &mut sqlx::PgConnection,
    previous: Option<&GitSyncProfile>,
    updated: &GitSyncProfile,
  ) -> GitSyncResult<()> {
    crate::scheduling::git_cron::replace_in(conn, previous, updated)
      .await
      .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
    crate::scheduling::git_polling::replace_in(conn, previous, updated)
      .await
      .map_err(|error| GitSyncStoreError::Validation(error.to_string()))
  }

  fn map_binding_row(row: sqlx::postgres::PgRow) -> GitSyncResult<GitSyncBinding> {
    Ok(GitSyncBinding {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      sync_id: row.get("sync_id"),
      repo_path: row.get("repo_path"),
      last_commit_oid: row.get("last_commit_oid"),
      content_hash: row.get("content_hash"),
      structure_hash: row.get("structure_hash"),
      tombstone: row.get("tombstone"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    })
  }

  fn map_run_row(row: sqlx::postgres::PgRow) -> GitSyncResult<GitSyncRun> {
    let error_class_str: Option<String> = row.get("error_class");
    let error_class = error_class_str.as_deref().map(parse_error_class).transpose()?;

    Ok(GitSyncRun {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      direction: parse_sync_direction(&row.get::<String, _>("direction"))?,
      trigger_source: parse_run_source(&row.get::<String, _>("trigger_source"))?,
      scheduled_for: row.get("scheduled_for"),
      status: parse_run_status(&row.get::<String, _>("status"))?,
      started_at: row.get("started_at"),
      finished_at: row.get("finished_at"),
      commit_before: row.get("commit_before"),
      commit_after: row.get("commit_after"),
      observed_remote_oid: row.get("observed_remote_oid"),
      reconciliation_required: row.get("reconciliation_required"),
      reconciliation_reason: row.get("reconciliation_reason"),
      docs_created: row.get("docs_created"),
      docs_updated: row.get("docs_updated"),
      docs_deleted: row.get("docs_deleted"),
      conflicts_found: row.get("conflicts_found"),
      error_message: row.get("error_message"),
      error_class,
      job_id: row.get("job_id"),
    })
  }

  fn map_conflict_row(row: sqlx::postgres::PgRow) -> GitSyncResult<GitSyncConflict> {
    Ok(GitSyncConflict {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      binding_id: row.get("binding_id"),
      doc_id: row.get("doc_id"),
      repo_path: row.get("repo_path"),
      conflict_type: parse_conflict_type(&row.get::<String, _>("conflict_type"))?,
      resolution: parse_conflict_resolution(&row.get::<String, _>("resolution"))?,
      base_content: row.get("base_content"),
      myoxus_content: row.get("myoxus_content"),
      git_content: row.get("git_content"),
      created_at: row.get("created_at"),
      resolved_at: row.get("resolved_at"),
      resolved_by: row.get("resolved_by"),
    })
  }

  fn map_ssh_host_key_row(row: sqlx::postgres::PgRow) -> GitSyncSshHostKey {
    GitSyncSshHostKey {
      host: row.get("host"),
      port: row.get("port"),
      key_type: row.get("key_type"),
      fingerprint_sha256: row.get("fingerprint_sha256"),
      first_seen_at: row.get("first_seen_at"),
      last_seen_at: row.get("last_seen_at"),
      source: row.get("source"),
      created_by: row.get("created_by"),
      enabled: row.get("enabled"),
    }
  }

  fn map_file_binding_row(row: sqlx::postgres::PgRow) -> GitSyncResult<GitSyncFileBinding> {
    Ok(GitSyncFileBinding {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      workspace_id: row.get("workspace_id"),
      blob_key: row.get("blob_key"),
      repo_path: row.get("repo_path"),
      content_hash: row.get("content_hash"),
      mime_type: row.get("mime_type"),
      file_size: row.get("file_size"),
      tombstoned: row.get("tombstoned"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    })
  }

  fn map_file_conflict_row(row: sqlx::postgres::PgRow) -> GitSyncResult<GitSyncFileConflict> {
    Ok(GitSyncFileConflict {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      run_id: row.get("run_id"),
      binding_id: row.get("binding_id"),
      blob_key: row.get("blob_key"),
      repo_path: row.get("repo_path"),
      conflict_type: parse_conflict_type(&row.get::<String, _>("conflict_type"))?,
      resolution: parse_conflict_resolution(&row.get::<String, _>("resolution"))?,
      git_hash: row.get("git_hash"),
      myoxus_hash: row.get("myoxus_hash"),
      baseline_hash: row.get("baseline_hash"),
      created_at: row.get("created_at"),
      resolved_at: row.get("resolved_at"),
      resolved_by: row.get("resolved_by"),
    })
  }

  fn map_file_baseline_row(row: sqlx::postgres::PgRow) -> GitSyncResult<GitSyncFileBaseline> {
    Ok(GitSyncFileBaseline {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      blob_key: row.get("blob_key"),
      content_hash: row.get("content_hash"),
      commit_oid: row.get("commit_oid"),
      synced_at: row.get("synced_at"),
    })
  }

  fn map_partial_session_row(row: sqlx::postgres::PgRow) -> GitSyncResult<GitSyncPartialSession> {
    Ok(GitSyncPartialSession {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      direction: parse_sync_direction(&row.get::<String, _>("direction"))?,
      source_workspace_watermark: row.get("source_workspace_watermark"),
      source_git_commit_oid: row.get("source_git_commit_oid"),
      status: parse_partial_session_status(&row.get::<String, _>("status"))?,
      total_items: row.get("total_items"),
      processed_items: row.get("processed_items"),
      failed_items: row.get("failed_items"),
      created_run_id: row.get("created_run_id"),
      last_run_id: row.get("last_run_id"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
      completed_at: row.get("completed_at"),
    })
  }

  fn map_partial_item_row(row: sqlx::postgres::PgRow) -> GitSyncResult<GitSyncPartialItem> {
    let error_class_str: Option<String> = row.get("error_class");
    Ok(GitSyncPartialItem {
      id: row.get("id"),
      session_id: row.get("session_id"),
      profile_id: row.get("profile_id"),
      item_kind: parse_partial_item_kind(&row.get::<String, _>("item_kind"))?,
      item_key: row.get("item_key"),
      doc_id: row.get("doc_id"),
      repo_path: row.get("repo_path"),
      sort_key: row.get("sort_key"),
      status: parse_partial_item_status(&row.get::<String, _>("status"))?,
      attempts: row.get("attempts"),
      last_run_id: row.get("last_run_id"),
      error_class: error_class_str.as_deref().map(parse_error_class).transpose()?,
      error_message: row.get("error_message"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    })
  }

  // ── Profile Operations ───────────────────────────────────────────────

  pub async fn credential_rotation_in_progress(&self, credential_id: Uuid) -> GitSyncResult<bool> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_credentials c JOIN git_token_rotation r ON r.profile_id=c.profile_id WHERE c.id=$1 AND r.state='Rotating')")
      .bind(credential_id).fetch_one(&self.pool).await.map_err(Self::map_db_err)
  }

  pub async fn verified_extract_capture(
    &self,
    profile: &GitSyncProfile,
  ) -> GitSyncResult<Option<myoxus_application::workspace_content_operation::WorkspaceContentGitSyncCapture>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Capture {
      updated_at: chrono::DateTime<chrono::Utc>,
      scope_revision: i64,
      capture: myoxus_application::workspace_content_operation::WorkspaceContentGitSyncCapture,
    }
    let value: Option<serde_json::Value> =
      sqlx::query_scalar("SELECT extract_verified_capture FROM git_sync_profiles WHERE id=$1")
        .bind(profile.id)
        .fetch_one(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    let Some(value) = value else {
      return Ok(None);
    };
    let mut capture: Capture = serde_json::from_value(value)
      .map_err(|_| GitSyncStoreError::Validation("invalid verified Extract inventory".into()))?;
    capture.capture.remote_verified = false;
    Ok(
      (capture.updated_at == profile.updated_at && capture.scope_revision == profile.scope_revision)
        .then_some(capture.capture),
    )
  }

  pub async fn save_verified_extract_capture(
    &self,
    profile: &GitSyncProfile,
    capture: &myoxus_application::workspace_content_operation::WorkspaceContentGitSyncCapture,
  ) -> GitSyncResult<()> {
    sqlx::query(
      "UPDATE git_sync_profiles SET extract_verified_capture=$2 WHERE id=$1 AND updated_at=$3 AND scope_revision=$4",
    )
    .bind(profile.id)
    .bind(serde_json::json!({"updatedAt":profile.updated_at,"scopeRevision":profile.scope_revision,"capture":capture}))
    .bind(profile.updated_at)
    .bind(profile.scope_revision)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Serialize scope admission for every profile mutation on a configured
  /// remote/branch. A surviving, disabled profile still reserves its paths.
  async fn admit_profile_scope(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    profile: &GitSyncProfile,
  ) -> GitSyncResult<()> {
    let export = &profile.manifest_path;
    if export != myoxus_application::git_sync::export::GIT_SYNC_MANIFEST_PATH
      && !myoxus_application::git_sync::export::extracted_manifest_path(&profile.root_path)
        .is_ok_and(|path| path == *export)
    {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync profile has an invalid manifest address".into(),
      ));
    }
    myoxus_application::git_sync::export::profile_scope_conflict(
      &profile.root_path,
      export,
      &profile.root_path,
      export,
    )
    .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 4))")
      .bind(format!("{}\n{}", profile.repo_url, profile.branch))
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    let guarded_scope = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(
         SELECT 1 FROM git_sync_profiles p
         JOIN git_sync_scope_exclusions e ON e.profile_id = p.id
         WHERE p.id = $1 AND (p.repo_url <> $2 OR p.branch <> $3 OR p.root_path <> $4)
       )",
    )
    .bind(profile.id)
    .bind(&profile.repo_url)
    .bind(&profile.branch)
    .bind(&profile.root_path)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    if guarded_scope {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync profile with delegated paths cannot change its repository scope".into(),
      ));
    }
    let shared_scope_change: bool = sqlx::query_scalar(
      "SELECT EXISTS(
        SELECT 1 FROM git_sync_profiles p
        WHERE p.id = $1 AND (p.repo_url <> $2 OR p.branch <> $3)
          AND (EXISTS(SELECT 1 FROM git_sync_profiles dependent
                      WHERE dependent.credential_id = p.credential_id AND dependent.id <> p.id)
               OR EXISTS(SELECT 1 FROM git_sync_credentials c
                         WHERE c.id = p.credential_id AND c.profile_id <> p.id))
      )",
    )
    .bind(profile.id)
    .bind(&profile.repo_url)
    .bind(&profile.branch)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    if shared_scope_change {
      return Err(GitSyncStoreError::Validation(
        "shared credential cannot change repository scope".into(),
      ));
    }
    let others = sqlx::query(
      "SELECT id, root_path, manifest_path FROM git_sync_profiles
       WHERE repo_url = $1 AND branch = $2 AND id <> $3",
    )
    .bind(&profile.repo_url)
    .bind(&profile.branch)
    .bind(profile.id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    for other in others {
      if myoxus_application::git_sync::export::profile_scope_conflict(
        &profile.root_path,
        export,
        &other.get::<String, _>("root_path"),
        &other.get::<String, _>("manifest_path"),
      )
      .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?
      {
        return Err(GitSyncStoreError::Validation(format!(
          "Git-Sync scope conflicts with configured profile {}",
          other.get::<Uuid, _>("id")
        )));
      }
    }
    Ok(())
  }

  /// Refuse competing writers on the same branch, including disabled profiles.
  /// A nested root is safe only through explicit parent-to-child fences;
  /// detached fences keep the source runnable but cannot admit a new child.
  pub async fn assert_profile_scope_unambiguous(&self, profile: &GitSyncProfile) -> GitSyncResult<()> {
    // Direct CLI bootstrap/reconciliation have no normal run admission. They
    // must honor the target pause too, while the parent continues scoped sync.
    let pending: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_content_extract_targets
      WHERE target_workspace_id = $1 AND git_sync_pending)",
    )
    .bind(profile.workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if pending {
      return Err(GitSyncStoreError::Validation("XWS_GIT_SYNC_HANDOFF_UNAVAILABLE".into()));
    }
    let valid_manifest = profile.manifest_path == myoxus_application::git_sync::export::GIT_SYNC_MANIFEST_PATH
      || myoxus_application::git_sync::export::extracted_manifest_path(&profile.root_path)
        .is_ok_and(|path| path == profile.manifest_path);
    if !valid_manifest {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync profile has an invalid manifest address".into(),
      ));
    }
    myoxus_application::git_sync::export::profile_scope_conflict(
      &profile.root_path,
      &profile.manifest_path,
      &profile.root_path,
      &profile.manifest_path,
    )
    .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
    let scope = self.writer_scope(profile).await?;
    let others = sqlx::query(
      "SELECT id FROM git_sync_profiles
       WHERE repo_url = $1 AND branch = $2 AND id <> $3",
    )
    .bind(&profile.repo_url)
    .bind(&profile.branch)
    .bind(profile.id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let mut peers = vec![(profile.clone(), scope.clone())];
    for other in others {
      let other_id: Uuid = other.get("id");
      let other_profile = self.get_profile(other_id).await?;
      let other_scope = self.writer_scope(&other_profile).await?;
      peers.push((other_profile, other_scope));
    }
    for (other_profile, other_scope) in peers.iter().skip(1) {
      let conflict = scope
        .conflicts_with(profile, &other_profile, &other_scope)
        .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
      if !conflict {
        continue;
      }
      if !profile.manifest_path.eq_ignore_ascii_case(&other_profile.manifest_path)
        && (has_delegation_chain(profile, other_profile, &peers)?
          || has_delegation_chain(other_profile, profile, &peers)?)
      {
        continue;
      }
      return Err(GitSyncStoreError::Validation(format!(
        "Git-Sync scope conflicts with configured profile {}; this writer cannot mutate the branch until ownership is resolved",
        other_profile.id
      )));
    }
    Ok(())
  }

  /// Read persistent ownership fences, including detached destinations. A
  /// destination's removal never makes its source paths eligible for adoption.
  pub async fn scope_exclusions(&self, profile_id: Uuid) -> GitSyncResult<Vec<GitSyncScopeExclusion>> {
    let rows = sqlx::query(
      "SELECT id, profile_id, repo_path, is_directory, destination_profile_id,
              originating_operation_id, scope_revision
       FROM git_sync_scope_exclusions WHERE profile_id = $1 ORDER BY scope_revision",
    )
    .bind(profile_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    rows
      .into_iter()
      .map(|row| {
        Ok(GitSyncScopeExclusion {
          id: row.get("id"),
          profile_id: row.get("profile_id"),
          repo_path: RepoPath::new(row.get::<String, _>("repo_path"))
            .map_err(|reason| GitSyncStoreError::Validation(reason.into()))?,
          is_directory: row.get("is_directory"),
          destination_profile_id: row.get("destination_profile_id"),
          originating_operation_id: row.get("originating_operation_id"),
          scope_revision: row.get("scope_revision"),
        })
      })
      .collect()
  }

  /// Validate Extract's newly published scopes in the same transaction as its
  /// parent fence. Ordinary profile-create cannot admit an unfenced child.
  pub(crate) async fn validate_extract_scopes(
    tx: &mut PgConnection,
    repository: &str,
    branch: &str,
    profile_ids: &[Uuid],
  ) -> GitSyncResult<()> {
    use myoxus_application::git_sync::export::GitSyncWriterScope;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 4))")
      .bind(format!("{repository}\n{branch}"))
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let profiles = sqlx::query(&format!("{PROFILE_SELECT} WHERE p.repo_url=$1 AND p.branch=$2"))
      .bind(repository)
      .bind(branch)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let mut peers = Vec::new();
    for row in profiles {
      let profile = Self::map_profile_row(row)?;
      let exclusions = sqlx::query("SELECT * FROM git_sync_scope_exclusions WHERE profile_id = $1")
        .bind(profile.id)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      let exclusions = exclusions
        .into_iter()
        .map(|row| {
          Ok(GitSyncScopeExclusion {
            id: row.get("id"),
            profile_id: row.get("profile_id"),
            repo_path: RepoPath::new(row.get::<String, _>("repo_path"))
              .map_err(|reason| GitSyncStoreError::Validation(reason.into()))?,
            is_directory: row.get("is_directory"),
            destination_profile_id: row.get("destination_profile_id"),
            originating_operation_id: row.get("originating_operation_id"),
            scope_revision: row.get("scope_revision"),
          })
        })
        .collect::<GitSyncResult<Vec<_>>>()?;
      peers.push((profile, GitSyncWriterScope::new(exclusions)));
    }
    for (profile, scope) in peers.iter().filter(|(profile, _)| profile_ids.contains(&profile.id)) {
      for (other, other_scope) in peers.iter().filter(|(other, _)| other.id != profile.id) {
        if scope
          .conflicts_with(profile, other, other_scope)
          .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?
          && (profile.manifest_path.eq_ignore_ascii_case(&other.manifest_path)
            || !(has_delegation_chain(profile, other, &peers)? || has_delegation_chain(other, profile, &peers)?))
        {
          return Err(GitSyncStoreError::Validation(
            "Extract Git scope ownership changed; repeat preflight".into(),
          ));
        }
      }
    }
    Ok(())
  }

  /// Read fences against the profile revision held by the writer; a later
  /// Extract cannot be silently treated as an empty or stale inventory.
  pub async fn writer_scope(
    &self,
    profile: &GitSyncProfile,
  ) -> GitSyncResult<myoxus_application::git_sync::export::GitSyncWriterScope> {
    let exclusions = self.scope_exclusions(profile.id).await?;
    let revision: Option<i64> = sqlx::query_scalar("SELECT scope_revision FROM git_sync_profiles WHERE id = $1")
      .bind(profile.id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    if revision != Some(profile.scope_revision)
      || exclusions
        .iter()
        .any(|fence| fence.scope_revision > profile.scope_revision)
    {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync scope changed while reading exclusions; retry with a current profile".into(),
      ));
    }
    let scope = myoxus_application::git_sync::export::GitSyncWriterScope::new(exclusions);
    if scope
      .excludes(&profile.manifest_path)
      .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?
    {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync profile manifest is inside its own excluded subtree".into(),
      ));
    }
    Ok(scope)
  }

  /// An Extract can move a document while leaving a stale source binding.
  /// Absence from the source document inventory must not turn that binding
  /// into a Git deletion; real deletion inside the source remains admissible.
  pub async fn assert_bound_documents_in_workspace(&self, profile: &GitSyncProfile) -> GitSyncResult<()> {
    let moved: bool = sqlx::query_scalar(
      "SELECT EXISTS(
         SELECT 1 FROM git_sync_bindings binding
         LEFT JOIN docs document ON document.id = binding.doc_id
         WHERE binding.profile_id = $1 AND NOT binding.tombstone
           AND (binding.workspace_id <> $2 OR (document.id IS NOT NULL AND document.workspace_id <> $2))
       )",
    )
    .bind(profile.id)
    .bind(profile.workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if moved {
      return Err(GitSyncStoreError::Validation(
        "a bound document moved to another Workspace without a Git-Sync scope handoff".into(),
      ));
    }
    Ok(())
  }

  /// Blob ownership is Workspace-scoped even when a Git path stays the same.
  /// Reject a partial file handoff before an import or outbound delete can
  /// mistake another Workspace's bytes for missing source content.
  pub async fn assert_bound_files_in_workspace(&self, profile: &GitSyncProfile) -> GitSyncResult<()> {
    let moved: bool = sqlx::query_scalar(
      "SELECT EXISTS(
         SELECT 1 FROM git_sync_file_bindings
         WHERE profile_id = $1 AND NOT tombstoned AND workspace_id <> $2
       )",
    )
    .bind(profile.id)
    .bind(profile.workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if moved {
      return Err(GitSyncStoreError::Validation(
        "a bound file moved to another Workspace without a Git-Sync scope handoff".into(),
      ));
    }
    Ok(())
  }

  /// Publish one scope fence only against the revision observed by Extract.
  /// The SQL transaction advances the profile and the fence together so a
  /// stale Undo cannot remove ownership created by later work.
  #[allow(clippy::too_many_arguments)]
  pub async fn add_scope_exclusion(
    &self,
    profile_id: Uuid,
    repo_path: &str,
    is_directory: bool,
    destination_profile_id: Option<Uuid>,
    originating_operation_id: Uuid,
    expected_scope_revision: i64,
  ) -> GitSyncResult<GitSyncScopeExclusion> {
    let path = RepoPath::new(repo_path).map_err(|reason| GitSyncStoreError::Validation(reason.into()))?;
    if destination_profile_id == Some(profile_id) {
      return Err(GitSyncStoreError::Validation(
        "a Git-Sync scope cannot delegate to itself".into(),
      ));
    }
    if path.as_str().ends_with('/')
      || path
        .as_str()
        .split('/')
        .any(|segment| segment.is_empty() || segment == ".")
    {
      return Err(GitSyncStoreError::Validation("scope path is not normalized".into()));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let (revision, root, manifest): (i64, String, String) = sqlx::query_as(
      "UPDATE git_sync_profiles SET scope_revision = scope_revision + 1, updated_at = now()
       WHERE id = $1 AND scope_revision = $2 RETURNING scope_revision, root_path, manifest_path",
    )
    .bind(profile_id)
    .bind(expected_scope_revision)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| GitSyncStoreError::Validation("Git-Sync scope changed; repeat preflight".into()))?;
    if path.as_str() == manifest
      || myoxus_application::git_sync::export::is_git_sync_control_path(path.as_str())
      || !myoxus_application::git_sync::export::is_nested_scope_path(&root, &path)
        .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?
    {
      return Err(GitSyncStoreError::Validation(
        "scope fence must be inside its source root and outside Git-Sync metadata".into(),
      ));
    }
    let existing = sqlx::query("SELECT repo_path, is_directory FROM git_sync_scope_exclusions WHERE profile_id = $1")
      .bind(profile_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let overlaps = |parent: &str, child: &str| child.strip_prefix(parent).is_some_and(|tail| tail.starts_with('/'));
    let folded_path = path.as_str().to_lowercase();
    for fence in existing {
      let current: String = fence.get("repo_path");
      let folded_current = current.to_lowercase();
      if folded_current == folded_path
        || (is_directory && overlaps(&folded_path, &folded_current))
        || (fence.get::<bool, _>("is_directory") && overlaps(&folded_current, &folded_path))
      {
        return Err(GitSyncStoreError::Validation(format!(
          "Git-Sync scope overlaps an existing source fence at {current}"
        )));
      }
    }
    let row = sqlx::query(
      "INSERT INTO git_sync_scope_exclusions
         (profile_id, repo_path, is_directory, destination_profile_id, originating_operation_id, scope_revision)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(profile_id)
    .bind(path.as_str())
    .bind(is_directory)
    .bind(destination_profile_id)
    .bind(originating_operation_id)
    .bind(revision)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(GitSyncScopeExclusion {
      id: row.get("id"),
      profile_id,
      repo_path: path,
      is_directory,
      destination_profile_id,
      originating_operation_id,
      scope_revision: revision,
    })
  }

  /// Undo only fences still owned by the recorded operation and observed
  /// revision. A changed profile or an absent fence cannot silently release a
  /// newer descendant's exclusion.
  pub async fn revoke_scope_exclusions(
    &self,
    profile_id: Uuid,
    originating_operation_id: Uuid,
    expected_scope_revision: i64,
  ) -> GitSyncResult<Vec<GitSyncScopeExclusion>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let current = sqlx::query_scalar::<_, i64>("SELECT scope_revision FROM git_sync_profiles WHERE id = $1 FOR UPDATE")
      .bind(profile_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(GitSyncStoreError::NotFound)?;
    if current != expected_scope_revision {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync scope changed; Undo requires fresh preflight".into(),
      ));
    }
    let rows = sqlx::query(
      "DELETE FROM git_sync_scope_exclusions
       WHERE profile_id = $1 AND originating_operation_id = $2
       RETURNING id, repo_path, is_directory, destination_profile_id, scope_revision",
    )
    .bind(profile_id)
    .bind(originating_operation_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if rows.is_empty() {
      return Err(GitSyncStoreError::Validation(
        "no unchanged Git-Sync fences belong to this Extract".into(),
      ));
    }
    sqlx::query("UPDATE git_sync_profiles SET scope_revision = scope_revision + 1, updated_at = now() WHERE id = $1")
      .bind(profile_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    rows
      .into_iter()
      .map(|row| {
        Ok(GitSyncScopeExclusion {
          id: row.get("id"),
          profile_id,
          repo_path: RepoPath::new(row.get::<String, _>("repo_path"))
            .map_err(|reason| GitSyncStoreError::Validation(reason.into()))?,
          is_directory: row.get("is_directory"),
          destination_profile_id: row.get("destination_profile_id"),
          originating_operation_id,
          scope_revision: row.get("scope_revision"),
        })
      })
      .collect()
  }

  /// Insert a new Git sync profile.
  #[instrument(skip(self), fields(profile_id = %profile.id, workspace_id = %profile.workspace_id))]
  pub async fn create_profile(&self, profile: &GitSyncProfile) -> GitSyncResult<GitSyncProfile> {
    if profile.credential_id.is_some() {
      return Err(GitSyncStoreError::Validation(
        "profile creation cannot attach an existing Git-Sync credential".into(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::admit_profile_scope(&mut tx, profile).await?;
    sqlx::query(
      r#"
            INSERT INTO git_sync_profiles
                (id, workspace_id, owner_id, repo_url, branch, root_path,
                 sync_direction, trigger_mode, polling_interval_secs,
                 cron_expression, cron_timezone, cron_misfire_policy,
                 auth_method, credential_id, enabled, max_mirror_storage_mb, manifest_path)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            "#,
    )
    .bind(profile.id)
    .bind(profile.workspace_id)
    .bind(profile.owner_id)
    .bind(&profile.repo_url)
    .bind(&profile.branch)
    .bind(&profile.root_path)
    .bind(profile.sync_direction.to_string())
    .bind(profile.trigger_mode.to_string())
    .bind(profile.polling_interval_secs)
    .bind(&profile.cron_expression)
    .bind(&profile.cron_timezone)
    .bind(profile.cron_misfire_policy.map(|value| value.to_string()))
    .bind(profile.auth_method.to_string())
    .bind(profile.credential_id)
    .bind(profile.enabled)
    .bind(profile.max_mirror_storage_mb)
    .bind(&profile.manifest_path)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    Self::write_schedules_in(&mut tx, None, profile).await?;
    let result = Self::profile_in(&mut tx, profile.id).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    debug!(profile_id = %result.id, "git sync profile created");
    Ok(result)
  }

  /// Create or update the latest workspace profile and atomically rotate credentials.
  ///
  /// The operation is transactional:
  /// 1. lock latest profile row for the workspace (if present),
  /// 2. insert/update profile metadata,
  /// 3. insert new credential,
  /// 4. update `credential_id`,
  /// 5. transfer stewardship if shared; otherwise delete the old credential.
  #[instrument(skip(self, profile, encrypted_data), fields(workspace_id = %profile.workspace_id))]
  pub async fn upsert_profile_with_credential(
    &self,
    profile: &GitSyncProfile,
    credential_label: &str,
    encrypted_data: &[u8],
  ) -> GitSyncResult<GitSyncProfile> {
    self
      .upsert_profile_with_credential_expiry(profile, credential_label, encrypted_data, None)
      .await
  }

  /// Create or update the latest workspace profile and atomically rotate credentials,
  /// with an optional credential expiry timestamp.
  #[instrument(skip(self, profile, encrypted_data), fields(workspace_id = %profile.workspace_id))]
  pub async fn upsert_profile_with_credential_expiry(
    &self,
    profile: &GitSyncProfile,
    credential_label: &str,
    encrypted_data: &[u8],
    credential_expires_at: Option<chrono::DateTime<chrono::Utc>>,
  ) -> GitSyncResult<GitSyncProfile> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // This upsert addresses the latest profile in a Workspace, not necessarily
    // the supplied profile ID. Lock that current lineage before its own row.
    if let Some(existing_id) = sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM git_sync_profiles WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(profile.workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    {
      let stable = lock_credential_dependents(&mut tx, existing_id)
        .await
        .map_err(Self::map_db_err)?;
      if !stable {
        return Err(GitSyncStoreError::Validation(
          "credential changed while locking dependents; retry".into(),
        ));
      }
    }

    let existing = sqlx::query(
      r#"
            SELECT id, owner_id, credential_id, manifest_path
            FROM git_sync_profiles
            WHERE workspace_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE
            "#,
    )
    .bind(profile.workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let previous = if let Some(row) = existing.as_ref() {
      Some(Self::profile_in(&mut tx, row.get("id")).await?)
    } else {
      None
    };
    let (profile_id, owner_id, old_credential_id) = if let Some(row) = existing {
      if row.get::<String, _>("manifest_path") != profile.manifest_path {
        return Err(GitSyncStoreError::Validation(
          "Git-Sync manifest address is immutable".into(),
        ));
      }
      (
        row.get::<Uuid, _>("id"),
        row.get::<Uuid, _>("owner_id"),
        row.get::<Option<Uuid>, _>("credential_id"),
      )
    } else {
      if profile.credential_id.is_some() {
        return Err(GitSyncStoreError::Validation(
          "profile creation cannot attach a credential".into(),
        ));
      }
      (profile.id, profile.owner_id, None)
    };
    if old_credential_id.is_some() && profile.credential_id != old_credential_id {
      return Err(GitSyncStoreError::Validation(
        "profile update cannot attach a credential".into(),
      ));
    }
    if let Some(credential_id) = old_credential_id {
      let rotating: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM git_token_rotation rotation
         JOIN git_sync_credentials c ON c.profile_id = rotation.profile_id
         WHERE c.id = $1 AND rotation.state = 'Rotating')",
      )
      .bind(credential_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if rotating {
        return Err(GitSyncStoreError::Validation(
          "credential rotation is in progress".into(),
        ));
      }
    }
    let mut admitted = profile.clone();
    admitted.id = profile_id;
    admitted.owner_id = owner_id;
    admitted.enabled = true;
    Self::admit_profile_scope(&mut tx, &admitted).await?;

    let existing_any = sqlx::query_scalar::<_, i32>("SELECT 1 FROM git_sync_profiles WHERE id = $1")
      .bind(profile_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .is_some();

    if existing_any {
      sqlx::query(
        r#"
                UPDATE git_sync_profiles
                SET owner_id = $2,
                    repo_url = $3,
                    branch = $4,
                    root_path = $5,
                    sync_direction = $6,
                    trigger_mode = $7,
                    polling_interval_secs = $8,
                    cron_expression = $9,
                    cron_timezone = $10,
                    cron_misfire_policy = $11,
                    auth_method = $12,
                    max_mirror_storage_mb = $13,
                    enabled = true,
                    updated_at = now()
                WHERE id = $1
                "#,
      )
      .bind(profile_id)
      .bind(owner_id)
      .bind(&profile.repo_url)
      .bind(&profile.branch)
      .bind(&profile.root_path)
      .bind(profile.sync_direction.to_string())
      .bind(profile.trigger_mode.to_string())
      .bind(profile.polling_interval_secs)
      .bind(&profile.cron_expression)
      .bind(&profile.cron_timezone)
      .bind(profile.cron_misfire_policy.map(|value| value.to_string()))
      .bind(profile.auth_method.to_string())
      .bind(profile.max_mirror_storage_mb)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    } else {
      sqlx::query(
        r#"
                INSERT INTO git_sync_profiles
                    (id, workspace_id, owner_id, repo_url, branch, root_path,
                     sync_direction, trigger_mode, polling_interval_secs,
                     cron_expression, cron_timezone, cron_misfire_policy,
                       auth_method, credential_id, enabled, max_mirror_storage_mb, manifest_path)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, true, $14, $15)
                "#,
      )
      .bind(profile_id)
      .bind(profile.workspace_id)
      .bind(owner_id)
      .bind(&profile.repo_url)
      .bind(&profile.branch)
      .bind(&profile.root_path)
      .bind(profile.sync_direction.to_string())
      .bind(profile.trigger_mode.to_string())
      .bind(profile.polling_interval_secs)
      .bind(&profile.cron_expression)
      .bind(&profile.cron_timezone)
      .bind(profile.cron_misfire_policy.map(|value| value.to_string()))
      .bind(profile.auth_method.to_string())
      .bind(profile.max_mirror_storage_mb)
      .bind(&profile.manifest_path)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    let new_credential_id: Uuid = sqlx::query_scalar(
      r#"
            INSERT INTO git_sync_credentials
                (profile_id, auth_method, label, encrypted_data, expires_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            "#,
    )
    .bind(profile_id)
    .bind(profile.auth_method.to_string())
    .bind(credential_label)
    .bind(encrypted_data)
    .bind(credential_expires_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    if old_credential_id.is_some() {
      rehome_credentials_before_profile_deletion(&mut tx, &[profile_id])
        .await
        .map_err(Self::map_db_err)?;
    }
    sqlx::query(
      r#"
            UPDATE git_sync_profiles
            SET credential_id = $1,
                updated_at = now()
            WHERE id = $2
            "#,
    )
    .bind(new_credential_id)
    .bind(profile_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    if let Some(previous_credential_id) = old_credential_id
      && previous_credential_id != new_credential_id
    {
      sqlx::query("DELETE FROM git_sync_credentials WHERE id = $1 AND profile_id = $2")
        .bind(previous_credential_id)
        .bind(profile_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }

    Self::write_schedules_in(&mut tx, previous.as_ref(), &admitted).await?;
    let result = Self::profile_in(&mut tx, profile_id).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    debug!(profile_id = %result.id, credential_id = %new_credential_id, "profile upserted with credential");
    Ok(result)
  }

  /// Share the source's active pointer only with its fenced Extract child.
  /// Descendants may repeat this operation without copying encrypted bytes.
  #[instrument(skip(self))]
  pub async fn inherit_extracted_credential(&self, source_id: Uuid, target_id: Uuid) -> GitSyncResult<Uuid> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let rows = sqlx::query(
      "SELECT id, workspace_id, owner_id, repo_url, branch, root_path, auth_method, credential_id
       FROM git_sync_profiles WHERE id IN ($1, $2) ORDER BY id FOR UPDATE",
    )
    .bind(source_id)
    .bind(target_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if source_id == target_id || rows.len() != 2 {
      return Err(GitSyncStoreError::Validation(
        "Extract needs two distinct profiles".into(),
      ));
    }
    let source = rows
      .iter()
      .find(|row| row.get::<Uuid, _>("id") == source_id)
      .ok_or(GitSyncStoreError::NotFound)?;
    let target = rows
      .iter()
      .find(|row| row.get::<Uuid, _>("id") == target_id)
      .ok_or(GitSyncStoreError::NotFound)?;
    if source.get::<Uuid, _>("workspace_id") == target.get::<Uuid, _>("workspace_id")
      || source.get::<Uuid, _>("owner_id") != target.get::<Uuid, _>("owner_id")
      || source.get::<String, _>("repo_url") != target.get::<String, _>("repo_url")
      || source.get::<String, _>("branch") != target.get::<String, _>("branch")
      || source.get::<String, _>("auth_method") != target.get::<String, _>("auth_method")
    {
      return Err(GitSyncStoreError::Validation(
        "Extract credential scope does not match".into(),
      ));
    }
    let credential_id: Uuid = source
      .get::<Option<Uuid>, _>("credential_id")
      .ok_or_else(|| GitSyncStoreError::Validation("Extract source has no active credential".into()))?;
    if target
      .get::<Option<Uuid>, _>("credential_id")
      .is_some_and(|id| id != credential_id)
    {
      return Err(GitSyncStoreError::Validation(
        "Extract target already has a credential".into(),
      ));
    }
    let independently_configured: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_token_rotation WHERE profile_id = $1)")
        .bind(target_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    if independently_configured {
      return Err(GitSyncStoreError::Validation(
        "Extract target already has an independent rotation configuration".into(),
      ));
    }
    let fenced: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM git_sync_scope_exclusions
       WHERE profile_id = $1 AND destination_profile_id = $2
         AND is_directory AND repo_path = trim(trailing '/' from $3))",
    )
    .bind(source_id)
    .bind(target_id)
    .bind(target.get::<String, _>("root_path"))
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let steward_matches: bool = sqlx::query_scalar(
      "SELECT EXISTS(
       SELECT 1 FROM git_sync_credentials c JOIN git_sync_profiles steward ON steward.id = c.profile_id
       WHERE c.id = $1 AND steward.owner_id = $2 AND steward.repo_url = $3
         AND steward.branch = $4 AND c.auth_method = $5)",
    )
    .bind(credential_id)
    .bind(source.get::<Uuid, _>("owner_id"))
    .bind(source.get::<String, _>("repo_url"))
    .bind(source.get::<String, _>("branch"))
    .bind(source.get::<String, _>("auth_method"))
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if !fenced || !steward_matches {
      return Err(GitSyncStoreError::Validation(
        "Extract credential lineage is not registered".into(),
      ));
    }
    let rotation_active: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM git_token_rotation rotation
        JOIN git_sync_credentials c ON c.profile_id = rotation.profile_id
        WHERE c.id = $1 AND rotation.state = 'Rotating')",
    )
    .bind(credential_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if rotation_active {
      return Err(GitSyncStoreError::Validation(
        "Extract cannot inherit a credential during rotation".into(),
      ));
    }
    sqlx::query("UPDATE git_sync_profiles SET credential_id = $2, updated_at = now() WHERE id = $1")
      .bind(target_id)
      .bind(credential_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(credential_id)
  }

  /// Fetch a profile by its ID.
  #[instrument(skip(self))]
  pub async fn get_profile(&self, profile_id: Uuid) -> GitSyncResult<GitSyncProfile> {
    let mut conn = self.pool.acquire().await.map_err(Self::map_db_err)?;
    let result = Self::profile_in(&mut conn, profile_id).await?;
    trace!(profile_id = %result.id, "profile fetched by id");
    Ok(result)
  }

  /// Fetch the (enabled) profile for a workspace.
  #[instrument(skip(self))]
  pub async fn get_profile_by_workspace(&self, workspace_id: Uuid) -> GitSyncResult<Option<GitSyncProfile>> {
    let row = sqlx::query(&format!("{PROFILE_SELECT} WHERE p.workspace_id=$1 AND p.enabled=true"))
      .bind(workspace_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_profile_row).transpose()?;
    trace!(found = result.is_some(), "profile lookup by workspace");
    Ok(result)
  }

  /// Configuration/status reads include paused profiles. Display ordering is
  /// not run admission; collision checks still cover every configured scope.
  pub async fn get_configured_profile_by_workspace(&self, workspace_id: Uuid) -> GitSyncResult<Option<GitSyncProfile>> {
    sqlx::query(&format!(
      "{PROFILE_SELECT} WHERE p.workspace_id=$1 ORDER BY p.enabled DESC,p.created_at DESC,p.id DESC LIMIT 1"
    ))
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .map(Self::map_profile_row)
    .transpose()
  }

  /// Update mutable fields of a profile.
  #[instrument(skip(self))]
  pub async fn update_profile(&self, profile: &GitSyncProfile) -> GitSyncResult<GitSyncProfile> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let current = Self::locked_profile_in(&mut tx, profile.id).await?;
    if current.manifest_path != profile.manifest_path {
      return Err(GitSyncStoreError::Validation(
        "Git-Sync manifest address is immutable".into(),
      ));
    }
    if current.credential_id != profile.credential_id {
      return Err(GitSyncStoreError::Validation(
        "profile update cannot attach a credential".into(),
      ));
    }
    let rotating: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM git_token_rotation rotation
       JOIN git_sync_credentials c ON c.profile_id = rotation.profile_id
       WHERE c.id = $1 AND rotation.state = 'Rotating')",
    )
    .bind(profile.credential_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if rotating {
      return Err(GitSyncStoreError::Validation(
        "credential rotation is in progress".into(),
      ));
    }
    if current.repo_url != profile.repo_url
      || current.branch != profile.branch
      || current.root_path != profile.root_path
    {
      Self::admit_profile_scope(&mut tx, profile).await?;
    }
    sqlx::query(
      r#"
            UPDATE git_sync_profiles
            SET repo_url = $2, branch = $3, root_path = $4,
                sync_direction = $5, trigger_mode = $6,
                polling_interval_secs = $7, cron_expression = $8,
                cron_timezone = $9, cron_misfire_policy = $10,
                auth_method = $11, credential_id = $12, enabled = $13,
                max_mirror_storage_mb = $14, updated_at = now()
            WHERE id = $1
            "#,
    )
    .bind(profile.id)
    .bind(&profile.repo_url)
    .bind(&profile.branch)
    .bind(&profile.root_path)
    .bind(profile.sync_direction.to_string())
    .bind(profile.trigger_mode.to_string())
    .bind(profile.polling_interval_secs)
    .bind(&profile.cron_expression)
    .bind(&profile.cron_timezone)
    .bind(profile.cron_misfire_policy.map(|value| value.to_string()))
    .bind(profile.auth_method.to_string())
    .bind(profile.credential_id)
    .bind(profile.enabled)
    .bind(profile.max_mirror_storage_mb)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    Self::write_schedules_in(&mut tx, Some(&current), profile).await?;
    let result = Self::profile_in(&mut tx, profile.id).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    debug!(profile_id = %result.id, "git sync profile updated");
    Ok(result)
  }

  /// Delete a profile and all associated data (cascading).
  #[instrument(skip(self))]
  pub async fn delete_profile(&self, profile_id: Uuid) -> GitSyncResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    rehome_credentials_before_profile_deletion(&mut tx, &[profile_id])
      .await
      .map_err(Self::map_db_err)?;
    let result = sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
      .bind(profile_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    if result.rows_affected() == 0 {
      return Err(GitSyncStoreError::NotFound);
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    debug!("git sync profile deleted");
    Ok(())
  }

  // ── Binding Operations ───────────────────────────────────────────────

  /// Insert a new binding.
  #[instrument(skip(self), fields(binding_id = %binding.id, doc_id = %binding.doc_id))]
  pub async fn create_binding(&self, binding: &GitSyncBinding) -> GitSyncResult<GitSyncBinding> {
    let row = sqlx::query(
      r#"
            INSERT INTO git_sync_bindings
                (id, profile_id, workspace_id, doc_id, sync_id, repo_path,
                 last_commit_oid, content_hash, structure_hash, tombstone)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id, profile_id, workspace_id, doc_id, sync_id, repo_path,
                      last_commit_oid, content_hash, structure_hash, tombstone,
                      created_at, updated_at
            "#,
    )
    .bind(binding.id)
    .bind(binding.profile_id)
    .bind(binding.workspace_id)
    .bind(binding.doc_id)
    .bind(binding.sync_id)
    .bind(&binding.repo_path)
    .bind(&binding.last_commit_oid)
    .bind(&binding.content_hash)
    .bind(&binding.structure_hash)
    .bind(binding.tombstone)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = Self::map_binding_row(row)?;
    debug!(binding_id = %result.id, "binding created");
    Ok(result)
  }

  /// Fetch a binding by its ID.
  #[instrument(skip(self))]
  pub async fn get_binding(&self, binding_id: Uuid) -> GitSyncResult<GitSyncBinding> {
    let row = sqlx::query(
      r#"
            SELECT id, profile_id, workspace_id, doc_id, sync_id, repo_path,
                   last_commit_oid, content_hash, structure_hash, tombstone,
                   created_at, updated_at
            FROM git_sync_bindings
            WHERE id = $1
            "#,
    )
    .bind(binding_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    let result = Self::map_binding_row(row)?;
    trace!(binding_id = %result.id, "binding fetched by id");
    Ok(result)
  }

  /// Fetch all non-tombstoned bindings for a profile.
  #[instrument(skip(self))]
  pub async fn get_bindings_by_profile(&self, profile_id: Uuid) -> GitSyncResult<Vec<GitSyncBinding>> {
    let rows = sqlx::query(
      r#"
            SELECT id, profile_id, workspace_id, doc_id, sync_id, repo_path,
                   last_commit_oid, content_hash, structure_hash, tombstone,
                   created_at, updated_at
            FROM git_sync_bindings
            WHERE profile_id = $1 AND tombstone = false
            ORDER BY created_at ASC
            "#,
    )
    .bind(profile_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result: GitSyncResult<Vec<GitSyncBinding>> = rows.into_iter().map(Self::map_binding_row).collect();
    let bindings = result?;
    trace!(count = bindings.len(), "bindings fetched by profile");
    Ok(bindings)
  }

  /// Verify that planned document paths do not collide with current owners.
  ///
  /// This is intentionally read-only. `git_sync_path_owners` is a derived
  /// ledger written only by the canonical binding triggers.
  /// A concurrent change after this preflight is still rejected by those
  /// triggers in the guarded final transaction and enters normal
  /// reconciliation-required recovery if the remote already moved.
  #[instrument(skip(self, paths), fields(%profile_id, path_count = paths.len()))]
  pub async fn validate_document_paths_available(
    &self,
    profile_id: Uuid,
    paths: &[(Uuid, String)],
  ) -> GitSyncResult<()> {
    let mut planned = std::collections::HashMap::new();
    for (doc_id, repo_path) in paths {
      if repo_path.trim().is_empty() {
        return Err(GitSyncStoreError::Validation(format!(
          "planned path for document {doc_id} is empty"
        )));
      }
      if let Some(existing_doc_id) = planned.insert(repo_path.as_str(), *doc_id)
        && existing_doc_id != *doc_id
      {
        return Err(GitSyncStoreError::Validation(format!(
          "planned repository path {repo_path} is assigned to multiple documents"
        )));
      }
    }
    let repo_paths = paths.iter().map(|(_, path)| path.clone()).collect::<Vec<_>>();
    let owners = sqlx::query(
      "SELECT repo_path, owner_kind, owner_id
       FROM git_sync_path_owners
       WHERE profile_id = $1 AND repo_path = ANY($2)",
    )
    .bind(profile_id)
    .bind(&repo_paths)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    for owner in owners {
      let repo_path: String = owner.get("repo_path");
      let owner_kind: String = owner.get("owner_kind");
      let owner_id: Uuid = owner.get("owner_id");
      if owner_kind != "document" || planned.get(repo_path.as_str()) != Some(&owner_id) {
        return Err(GitSyncStoreError::Validation(format!(
          "planned repository path {repo_path} is already owned by {owner_kind} {owner_id}"
        )));
      }
    }
    Ok(())
  }

  /// Update mutable fields of a binding (repo_path, hashes, commit OID).
  #[instrument(skip(self))]
  pub async fn update_binding(&self, binding: &GitSyncBinding) -> GitSyncResult<GitSyncBinding> {
    let row = sqlx::query(
      r#"
            UPDATE git_sync_bindings
            SET repo_path = $2, last_commit_oid = $3, content_hash = $4,
                structure_hash = $5, updated_at = now()
            WHERE id = $1
            RETURNING id, profile_id, workspace_id, doc_id, sync_id, repo_path,
                      last_commit_oid, content_hash, structure_hash, tombstone,
                      created_at, updated_at
            "#,
    )
    .bind(binding.id)
    .bind(&binding.repo_path)
    .bind(&binding.last_commit_oid)
    .bind(&binding.content_hash)
    .bind(&binding.structure_hash)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    let result = Self::map_binding_row(row)?;
    debug!(binding_id = %result.id, "binding updated");
    Ok(result)
  }

  /// Mark a binding as tombstoned (soft-delete).
  #[instrument(skip(self))]
  pub async fn mark_tombstone(&self, binding_id: Uuid) -> GitSyncResult<()> {
    let result = sqlx::query("UPDATE git_sync_bindings SET tombstone = true, updated_at = now() WHERE id = $1")
      .bind(binding_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;

    if result.rows_affected() == 0 {
      return Err(GitSyncStoreError::NotFound);
    }
    debug!("binding marked as tombstone");
    Ok(())
  }

  // ── Run Operations ───────────────────────────────────────────────────

  /// Insert a new sync run.
  #[instrument(skip(self), fields(run_id = %run.id, status = %run.status))]
  pub async fn create_run(&self, run: &GitSyncRun) -> GitSyncResult<GitSyncRun> {
    let error_class_str = run.error_class.map(|ec| ec.to_string());

    let row = sqlx::query(
      r#"
            INSERT INTO git_sync_runs
                (id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
                 commit_before, commit_after, observed_remote_oid,
                 reconciliation_required, reconciliation_reason,
                 docs_created, docs_updated, docs_deleted, conflicts_found,
                 error_message, error_class, job_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            RETURNING id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
                      commit_before, commit_after, observed_remote_oid,
                      reconciliation_required, reconciliation_reason,
                      docs_created, docs_updated, docs_deleted, conflicts_found,
                      error_message, error_class, job_id
            "#,
    )
    .bind(run.id)
    .bind(run.profile_id)
    .bind(run.direction.to_string())
    .bind(run.trigger_source.to_string())
    .bind(run.scheduled_for)
    .bind(run.status.to_string())
    .bind(run.started_at)
    .bind(run.finished_at)
    .bind(&run.commit_before)
    .bind(&run.commit_after)
    .bind(&run.observed_remote_oid)
    .bind(run.reconciliation_required)
    .bind(&run.reconciliation_reason)
    .bind(run.docs_created)
    .bind(run.docs_updated)
    .bind(run.docs_deleted)
    .bind(run.conflicts_found)
    .bind(&run.error_message)
    .bind(&error_class_str)
    .bind(&run.job_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = Self::map_run_row(row)?;
    debug!(run_id = %result.id, "sync run created");
    Ok(result)
  }

  /// Create a pending manual run unless an unfinished run already exists.
  ///
  /// GraphQL, CLI and later webhook code use this method so trigger ingress
  /// paths share the same dedupe boundary. The runner still owns execution and
  /// final status transitions; this method only creates the queue-visible run
  /// marker when no `Pending`/`Running` run is already active for the profile.
  #[instrument(skip(self), fields(profile_id = %profile_id, direction = %direction))]
  pub async fn create_pending_run_if_absent(
    &self,
    profile_id: Uuid,
    direction: SyncDirection,
    trigger_source: GitSyncRunSource,
  ) -> GitSyncResult<(GitSyncRun, bool)> {
    if trigger_source == GitSyncRunSource::Polling {
      return Err(GitSyncStoreError::Validation(
        "Polling Run admission requires its shared schedule".into(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Profile lifecycle updates take the same row lock. A trigger can
    // therefore never admit work from configuration that is concurrently
    // being replaced or disabled.
    let profile_exists =
      sqlx::query_scalar::<_, bool>("SELECT enabled FROM git_sync_profiles WHERE id = $1 FOR UPDATE")
        .bind(profile_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .ok_or(GitSyncStoreError::NotFound)?;
    if !profile_exists {
      return Err(GitSyncStoreError::Validation(
        "cannot admit work for a disabled Git-Sync profile".to_string(),
      ));
    }
    let rotation_in_progress = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(
         SELECT 1 FROM git_token_rotation rotation
         JOIN git_sync_credentials credential ON credential.profile_id = rotation.profile_id
         JOIN git_sync_profiles consumer ON consumer.credential_id = credential.id
         WHERE consumer.id = $1 AND rotation.state = 'Rotating'
        )",
    )
    .bind(profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if rotation_in_progress {
      return Err(GitSyncStoreError::Validation(
        "cannot admit a Git-Sync run while token rotation is active".to_string(),
      ));
    }

    let inserted = sqlx::query(
      r#"
      INSERT INTO git_sync_runs
          (id, profile_id, direction, trigger_source, status, started_at,
           docs_created, docs_updated, docs_deleted, conflicts_found)
      VALUES (gen_random_uuid(), $1, $2, $3, 'Pending', now(), 0, 0, 0, 0)
      ON CONFLICT (profile_id) WHERE status IN ('Pending', 'Running')
      DO NOTHING
      RETURNING id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
                commit_before, commit_after, observed_remote_oid,
                reconciliation_required, reconciliation_reason,
                docs_created, docs_updated, docs_deleted, conflicts_found,
                error_message, error_class, job_id
      "#,
    )
    .bind(profile_id)
    .bind(direction.to_string())
    .bind(trigger_source.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    if let Some(row) = inserted {
      let run = Self::map_run_row(row)?;
      tx.commit().await.map_err(Self::map_db_err)?;
      debug!(run_id = %run.id, "pending sync run created");
      return Ok((run, true));
    }

    let row = sqlx::query(
      r#"
      SELECT id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
             commit_before, commit_after, observed_remote_oid,
             reconciliation_required, reconciliation_reason,
             docs_created, docs_updated, docs_deleted, conflicts_found,
             error_message, error_class, job_id,
             trigger_source
      FROM git_sync_runs
      WHERE profile_id = $1 AND status IN ('Pending', 'Running')
      ORDER BY CASE status WHEN 'Running' THEN 0 ELSE 1 END, started_at, id
      LIMIT 1
      "#,
    )
    .bind(profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let existing_direction = parse_sync_direction(&row.get::<String, _>("direction"))?;
    let existing_trigger = parse_run_source(&row.get::<String, _>("trigger_source"))?;
    if existing_direction != direction || existing_trigger != trigger_source {
      return Err(GitSyncStoreError::UnfinishedRunConflict {
        existing_direction,
        existing_trigger,
        requested_direction: direction,
        requested_trigger: trigger_source,
      });
    }
    let run = Self::map_run_row(row)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    debug!(run_id = %run.id, "unfinished sync run reused");
    Ok((run, false))
  }

  /// Assign a committed history capture to an outgoing run under the profile
  /// lifecycle lock. A conflicting/running source leaves the receipt pending
  /// for the scheduler's next drain pass.
  #[instrument(skip(self, lifecycle_policy), fields(%profile_id, history_id, generation))]
  pub async fn admit_history_capture(
    &self,
    profile_id: Uuid,
    history_id: i64,
    generation: i64,
    lifecycle_policy: &GitSyncLifecyclePolicy,
  ) -> GitSyncResult<Option<GitSyncRun>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let current_generation: Option<i64> =
      sqlx::query_scalar("SELECT activation_generation FROM git_sync_profiles WHERE id=$1 FOR UPDATE")
        .bind(profile_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    let Some(current_generation) = current_generation else {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(None);
    };
    let profile = Self::profile_in(&mut tx, profile_id).await?;

    let receipt = sqlx::query(
      "SELECT assigned_run_id, discarded_at FROM git_sync_history_capture_receipts
       WHERE profile_id = $1 AND history_id = $2 FOR UPDATE",
    )
    .bind(profile_id)
    .bind(history_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let Some(receipt) = receipt else {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(None);
    };
    if receipt.get::<Option<Uuid>, _>("assigned_run_id").is_some()
      || receipt
        .get::<Option<chrono::DateTime<chrono::Utc>>, _>("discarded_at")
        .is_some()
    {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(None);
    }

    let permanently_ineligible = generation != current_generation
      || !profile.enabled
      || profile.trigger_mode != TriggerMode::HistoryCapture
      || profile.sync_direction == SyncDirection::GitToMyoxus;
    if permanently_ineligible {
      sqlx::query(
        "UPDATE git_sync_history_capture_receipts SET discarded_at = now()
         WHERE profile_id = $1 AND history_id = $2 AND assigned_run_id IS NULL",
      )
      .bind(profile_id)
      .bind(history_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(None);
    }
    if lifecycle_policy.validate_profile(&profile).is_err()
      || !lifecycle_policy
        .allowed_directions
        .contains(&SyncDirection::MyoxusToGit)
    {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(None);
    }
    let rotation_in_progress = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(SELECT 1 FROM git_token_rotation rotation
         JOIN git_sync_credentials credential ON credential.profile_id = rotation.profile_id
         JOIN git_sync_profiles consumer ON consumer.credential_id = credential.id
         WHERE consumer.id = $1 AND rotation.state = 'Rotating')",
    )
    .bind(profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if rotation_in_progress {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(None);
    }

    let unfinished = sqlx::query(
      "SELECT id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
              commit_before, commit_after, observed_remote_oid, reconciliation_required, reconciliation_reason,
              docs_created, docs_updated, docs_deleted, conflicts_found, error_message, error_class, job_id
       FROM git_sync_runs WHERE profile_id = $1 AND status IN ('Pending', 'Running')
       ORDER BY CASE status WHEN 'Running' THEN 0 ELSE 1 END, started_at, id LIMIT 1",
    )
    .bind(profile_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let run = if let Some(row) = unfinished {
      let existing = Self::map_run_row(row)?;
      if existing.status != RunStatus::Pending
        || existing.trigger_source != GitSyncRunSource::HistoryCapture
        || existing.direction != SyncDirection::MyoxusToGit
      {
        tx.commit().await.map_err(Self::map_db_err)?;
        return Ok(None);
      }
      existing
    } else {
      let row = sqlx::query(
        "INSERT INTO git_sync_runs
           (id, profile_id, direction, trigger_source, status, started_at,
            docs_created, docs_updated, docs_deleted, conflicts_found)
         VALUES (gen_random_uuid(), $1, 'MyoxusToGit', 'HistoryCapture', 'Pending', now(), 0, 0, 0, 0)
         RETURNING id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
                   commit_before, commit_after, observed_remote_oid, reconciliation_required, reconciliation_reason,
                   docs_created, docs_updated, docs_deleted, conflicts_found, error_message, error_class, job_id",
      )
      .bind(profile_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      Self::map_run_row(row)?
    };

    // Coalesce all receipts that were committed before this run is claimed.
    sqlx::query(
      "UPDATE git_sync_history_capture_receipts
       SET assigned_run_id = $3, assigned_at = now()
       WHERE profile_id = $1 AND activation_generation = $2
         AND assigned_run_id IS NULL AND discarded_at IS NULL",
    )
    .bind(profile_id)
    .bind(current_generation)
    .bind(run.id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(Some(run))
  }

  /// Recover durable capture receipts independently of outbox/Redis delivery.
  pub async fn drain_history_capture_intents(
    &self,
    lifecycle_policy: &GitSyncLifecyclePolicy,
    limit: i64,
  ) -> GitSyncResult<Vec<GitSyncRun>> {
    let candidates: Vec<(Uuid, i64, i64)> = sqlx::query_as(
      "SELECT profile_id, history_id, activation_generation
       FROM git_sync_history_capture_receipts
       WHERE assigned_run_id IS NULL AND discarded_at IS NULL
       ORDER BY created_at, profile_id, history_id LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let mut runs = Vec::new();
    for (profile_id, history_id, generation) in candidates {
      if let Some(run) = self
        .admit_history_capture(profile_id, history_id, generation, lifecycle_policy)
        .await?
        && !runs.iter().any(|existing: &GitSyncRun| existing.id == run.id)
      {
        runs.push(run);
      }
    }
    Ok(runs)
  }

  /// Atomically advance one shared due cursor and admit its native Cron Run.
  ///
  /// The profile row is the durable scheduling lock. Callers may invoke this
  /// concurrently from shared scheduling replicas. Lock the profile before its
  /// shared schedule so native lifecycle/credential writers keep their order.
  #[instrument(skip(self, lifecycle_policy), fields(%now))]
  pub async fn admit_cron_slot(
    &self,
    profile_id: Uuid,
    generation: i64,
    revision: i64,
    now: chrono::DateTime<chrono::Utc>,
    lifecycle_policy: &GitSyncLifecyclePolicy,
  ) -> GitSyncResult<Option<GitSyncCronAdmission>> {
    if !lifecycle_policy.enabled || !lifecycle_policy.auto_sync_allowed {
      return Ok(None);
    }

    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query(
      r#"
      SELECT id
      FROM git_sync_profiles
      WHERE id=$1 AND enabled = true
        AND trigger_mode = 'Cron'
      FOR UPDATE SKIP LOCKED
      "#,
    )
    .bind(profile_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let Some(_row) = row else {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(None);
    };
    let profile = Self::profile_in(&mut tx, profile_id).await?;
    let timing=sqlx::query("SELECT next_due_at,pending_due_at FROM scheduling_schedules WHERE id=$1 AND generation=$2 AND revision=$3 AND lifecycle='active' AND next_admission_at<=$4 AND target_json->>'kind'='git_cron' AND target_json->>'profile_id'=$1::text FOR UPDATE")
      .bind(profile_id).bind(generation).bind(revision).bind(now).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    let Some(timing) = timing else { return Ok(None) };
    let expression = profile
      .cron_expression
      .as_deref()
      .ok_or_else(|| GitSyncStoreError::Validation("Cron profile has no expression".into()))?;
    let timezone = profile
      .cron_timezone
      .as_deref()
      .ok_or_else(|| GitSyncStoreError::Validation("Cron profile has no timezone".into()))?;
    let policy = profile
      .cron_misfire_policy
      .ok_or_else(|| GitSyncStoreError::Validation("Cron profile has no misfire policy".into()))?;
    let next = timing
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("next_due_at")
      .ok_or_else(|| GitSyncStoreError::Validation("enabled Cron profile has no next occurrence".into()))?;
    let schedule =
      CronSchedule::parse(expression, timezone).map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
    let policy_denial = lifecycle_policy
      .validate_profile(&profile)
      .err()
      .map(|error| error.message);
    let policy_allowed = policy_denial.is_none();
    let unfinished = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(
         SELECT 1 FROM git_sync_runs
         WHERE profile_id = $1 AND status IN ('Pending', 'Running')
        ) OR EXISTS(
          SELECT 1 FROM git_token_rotation rotation
          JOIN git_sync_credentials credential ON credential.profile_id = rotation.profile_id
          JOIN git_sync_profiles consumer ON consumer.credential_id = credential.id
          WHERE consumer.id = $1 AND rotation.state = 'Rotating'
        )",
    )
    .bind(profile.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let decision = schedule
      .decide_due(
        now,
        next,
        timing.get("pending_due_at"),
        if policy_allowed {
          policy
        } else {
          CronMisfirePolicy::Skip
        },
        unfinished,
      )
      .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;

    // Retain an overdue RunOnce slot without letting a busy native Run pin the
    // oldest shared batch. This is admission backoff, not a rewritten UTC slot.
    let next_admission = if unfinished && decision.pending_misfire_scheduled_for.is_some_and(|slot| slot <= now) {
      decision.next_scheduled_at.min(now + chrono::Duration::seconds(30))
    } else {
      decision
        .pending_misfire_scheduled_for
        .map_or(decision.next_scheduled_at, |pending| {
          pending.min(decision.next_scheduled_at)
        })
    };
    sqlx::query(
      "UPDATE scheduling_schedules
       SET next_due_at=$2,pending_due_at=$3,next_nominal=$4,next_admission_at=$5,
           revision=revision+1,blocked_reason=NULL,updated_at=clock_timestamp()
       WHERE id = $1",
    )
    .bind(profile.id)
    .bind(decision.next_scheduled_at)
    .bind(decision.pending_misfire_scheduled_for)
    .bind(
      serde_json::to_value(myoxus_domain::scheduling::ScheduleValue::LocalDateTime(
        decision.next_scheduled_at.naive_utc(),
      ))
      .map_err(|_| GitSyncStoreError::Validation("invalid Cron cursor".into()))?,
    )
    .bind(next_admission)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let run = if policy_allowed && let Some(scheduled_for) = decision.run_scheduled_for {
      sqlx::query(
        r#"
        INSERT INTO git_sync_runs
          (id, profile_id, direction, trigger_source, scheduled_for, status,
           started_at, docs_created, docs_updated, docs_deleted, conflicts_found)
        VALUES
          (gen_random_uuid(), $1, $2, 'Cron', $3, 'Pending', $4, 0, 0, 0, 0)
        ON CONFLICT (profile_id, trigger_source, scheduled_for)
          WHERE scheduled_for IS NOT NULL
        DO NOTHING
        RETURNING id, profile_id, direction, trigger_source, scheduled_for,
                  status, started_at, finished_at, commit_before, commit_after,
                  observed_remote_oid, reconciliation_required,
                  reconciliation_reason, docs_created, docs_updated,
                  docs_deleted, conflicts_found, error_message, error_class,
                  job_id
        "#,
      )
      .bind(profile.id)
      .bind(profile.sync_direction.to_string())
      .bind(scheduled_for)
      .bind(now)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .map(Self::map_run_row)
      .transpose()?
    } else {
      None
    };

    if let Some(run) = &run {
      crate::scheduling::git_cron::record_run_in(
        &mut tx,
        profile_id,
        generation,
        run
          .scheduled_for
          .ok_or_else(|| GitSyncStoreError::Validation("Cron slot missing".into()))?,
        run,
      )
      .await
      .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(Some(GitSyncCronAdmission {
      profile_id: profile.id,
      run,
      skipped_occurrences: decision.skipped_occurrences,
      pending_misfire_scheduled_for: decision.pending_misfire_scheduled_for,
      policy_denial,
    }))
  }

  /// Shared interval admission keeps native unfinished-Run and rotation
  /// exclusion. The Run activity hook reanchors timing in this transaction;
  /// receiver retries never create a second automatic Run.
  #[instrument(skip_all,fields(%profile_id,%schedule_id))]
  pub async fn admit_polling_slot(
    &self,
    schedule_id: Uuid,
    profile_id: Uuid,
    generation: i64,
    revision: i64,
    now: chrono::DateTime<chrono::Utc>,
    policy: &GitSyncLifecyclePolicy,
  ) -> GitSyncResult<Option<usize>> {
    if !policy.enabled || !policy.auto_sync_allowed {
      return Ok(None);
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let locked = sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM git_sync_profiles WHERE id=$1 AND enabled AND trigger_mode='Polling' FOR UPDATE SKIP LOCKED",
    )
    .bind(profile_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if locked.is_none() {
      return Ok(None);
    }
    let profile = Self::profile_in(&mut tx, profile_id).await?;
    policy
      .validate_profile(&profile)
      .map_err(|_| GitSyncStoreError::Validation("Polling policy denied".into()))?;
    let due:Option<chrono::DateTime<chrono::Utc>>=sqlx::query_scalar("SELECT next_due_at FROM scheduling_schedules WHERE id=$1 AND target_json->>'kind'='git_polling' AND target_json->>'profile_id'=$2 AND generation=$3 AND revision=$4 AND lifecycle='active' AND next_admission_at<=$5 AND interval_seconds=$6 FOR UPDATE")
      .bind(schedule_id).bind(profile_id.to_string()).bind(generation).bind(revision).bind(now).bind(profile.polling_interval_secs).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    let Some(due) = due else { return Ok(None) };
    let busy:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id=$1 AND status IN('Pending','Running')) OR EXISTS(SELECT 1 FROM git_token_rotation rotation JOIN git_sync_credentials credential ON credential.profile_id=rotation.profile_id JOIN git_sync_profiles consumer ON consumer.credential_id=credential.id WHERE consumer.id=$1 AND rotation.state='Rotating')")
      .bind(profile_id).fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
    if busy {
      sqlx::query("UPDATE scheduling_schedules SET next_admission_at=$2,revision=revision+1 WHERE id=$1")
        .bind(schedule_id)
        .bind(now + chrono::Duration::seconds(30))
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(Some(0));
    }
    let row=sqlx::query("INSERT INTO git_sync_runs(id,profile_id,direction,trigger_source,status,started_at) VALUES(gen_random_uuid(),$1,$2,'Polling','Pending',$3) RETURNING *")
      .bind(profile_id).bind(profile.sync_direction.to_string()).bind(now).fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
    let run = Self::map_run_row(row)?;
    crate::scheduling::git_cron::record_run_in(&mut tx, schedule_id, generation, due, &run)
      .await
      .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(Some(1))
  }

  #[instrument(skip(self), fields(run_id = %run_id, job_id))]
  pub async fn persist_dispatch_job_id(&self, run_id: Uuid, job_id: &str) -> GitSyncResult<GitSyncRun> {
    let row = sqlx::query(
      r#"
      UPDATE git_sync_runs
      SET job_id = $2
      WHERE id = $1
        AND status = 'Pending'
        AND (job_id IS NULL OR job_id = $2)
      RETURNING id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
                commit_before, commit_after, observed_remote_oid,
                reconciliation_required, reconciliation_reason,
                docs_created, docs_updated, docs_deleted, conflicts_found,
                error_message, error_class, job_id
      "#,
    )
    .bind(run_id)
    .bind(job_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;
    Self::map_run_row(row)
  }

  #[instrument(skip(self))]
  pub async fn list_pending_dispatches(&self, limit: i64) -> GitSyncResult<Vec<PendingGitSyncDispatch>> {
    let rows = sqlx::query(
      r#"
      SELECT id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
             commit_before, commit_after, observed_remote_oid,
             reconciliation_required, reconciliation_reason,
             docs_created, docs_updated, docs_deleted, conflicts_found,
             error_message, error_class, job_id,
             trigger_source
      FROM git_sync_runs
      WHERE status = 'Pending'
      ORDER BY started_at, id
      LIMIT $1
      "#,
    )
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    rows
      .into_iter()
      .map(|row| {
        Ok(PendingGitSyncDispatch {
          run: Self::map_run_row(row)?,
        })
      })
      .collect()
  }

  #[instrument(skip(self), fields(%run_id, %profile_id, %direction, %trigger_source, job_id))]
  pub async fn claim_pending_run(
    &self,
    run_id: Uuid,
    profile_id: Uuid,
    direction: SyncDirection,
    trigger_source: GitSyncRunSource,
    job_id: &str,
  ) -> GitSyncResult<Option<GitSyncRun>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Serialize claim with profile updates and credential rotation. Once this
    // row lock is released as Running, lifecycle mutation will refuse to
    // proceed until the run reaches a terminal state.
    let profile_exists =
      sqlx::query_scalar::<_, bool>("SELECT enabled FROM git_sync_profiles WHERE id = $1 FOR UPDATE")
        .bind(profile_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    if profile_exists.is_none() {
      tx.rollback().await.map_err(Self::map_db_err)?;
      return Ok(None);
    }

    let row = sqlx::query(
      r#"
      UPDATE git_sync_runs r
      SET status = 'Running',
          started_at = now(),
          finished_at = NULL,
          error_message = NULL,
          error_class = NULL
      FROM git_sync_profiles p
      WHERE r.id = $1
        AND r.profile_id = $2
        AND r.direction = $3
        AND r.trigger_source = $4
        AND r.job_id = $5
        AND r.status = 'Pending'
        AND p.id = r.profile_id
        AND p.enabled = true
        AND (
          (r.trigger_source = 'HistoryCapture'
            AND r.direction = 'MyoxusToGit'
            AND p.sync_direction IN ('MyoxusToGit', 'Bidirectional'))
          OR (r.trigger_source <> 'HistoryCapture' AND p.sync_direction = r.direction)
        )
        AND (
          r.trigger_source = 'Manual'
          OR p.trigger_mode = r.trigger_source
        )
        AND (r.trigger_source <> 'Polling' OR p.polling_interval_secs > 0)
        AND (r.trigger_source <> 'Cron' OR (r.scheduled_for IS NOT NULL
          AND EXISTS(SELECT 1 FROM scheduling_occurrences slot
            WHERE slot.schedule_id=r.profile_id AND slot.dispatch_id=r.id
              AND slot.nominal_due_at=r.scheduled_for)))
      RETURNING r.id, r.profile_id, r.direction, r.trigger_source, r.status, r.started_at,
                r.scheduled_for, r.finished_at, r.commit_before, r.commit_after,
                r.observed_remote_oid, r.reconciliation_required,
                r.reconciliation_reason, r.docs_created, r.docs_updated,
                r.docs_deleted, r.conflicts_found, r.error_message,
                r.error_class, r.job_id
      "#,
    )
    .bind(run_id)
    .bind(profile_id)
    .bind(direction.to_string())
    .bind(trigger_source.to_string())
    .bind(job_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let run = row.map(Self::map_run_row).transpose()?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(run)
  }

  #[instrument(skip(self), fields(%run_id, job_id))]
  pub async fn release_run_for_retry(
    &self,
    run_id: Uuid,
    job_id: &str,
    error_message: &str,
    error_class: ErrorClass,
  ) -> GitSyncResult<bool> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let result = sqlx::query(
      r#"
      UPDATE git_sync_runs
      SET status = 'Pending',
          finished_at = NULL,
          error_message = $3,
          error_class = $4
      WHERE id = $1
        AND job_id = $2
        AND status = 'Running'
      "#,
    )
    .bind(run_id)
    .bind(job_id)
    .bind(error_message)
    .bind(error_class.to_string())
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 1 {
      sqlx::query(
        "UPDATE git_sync_partial_items
         SET status = 'Pending', error_class = NULL, error_message = NULL,
             updated_at = now()
         WHERE last_run_id = $1 AND status = 'Running'",
      )
      .bind(run_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(result.rows_affected() == 1)
  }

  /// Correlate a claimed run with the authenticated remote revision observed
  /// before any working-tree mutation. This is the recovery baseline for a
  /// process that dies between a verified push and SQL finalization.
  #[instrument(skip(self), fields(%run_id, job_id, source_oid))]
  pub async fn record_running_source_oid(&self, run_id: Uuid, job_id: &str, source_oid: &str) -> GitSyncResult<bool> {
    let result = sqlx::query(
      "UPDATE git_sync_runs
       SET commit_before = $3
       WHERE id = $1 AND job_id = $2 AND status = 'Running'",
    )
    .bind(run_id)
    .bind(job_id)
    .bind(source_oid)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(result.rows_affected() == 1)
  }

  /// List old in-flight runs for startup/operations reconciliation. The caller
  /// must still inspect the authenticated remote before choosing the terminal
  /// state.
  #[instrument(skip(self))]
  pub async fn list_stale_running_runs(
    &self,
    older_than: chrono::DateTime<chrono::Utc>,
    limit: i64,
  ) -> GitSyncResult<Vec<GitSyncRun>> {
    let rows = sqlx::query(
      "SELECT id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
              commit_before, commit_after, observed_remote_oid,
              reconciliation_required, reconciliation_reason,
              docs_created, docs_updated, docs_deleted, conflicts_found,
              error_message, error_class, job_id
       FROM git_sync_runs
       WHERE status = 'Running' AND started_at < $1
       ORDER BY started_at, id
       LIMIT $2",
    )
    .bind(older_than)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    rows.into_iter().map(Self::map_run_row).collect()
  }

  /// Terminalize a stale run only when the authenticated remote still equals
  /// its recorded source revision. A moved remote must use
  /// `mark_reconciliation_required` instead.
  #[instrument(skip(self, reason), fields(%run_id, %profile_id, job_id, observed_remote_oid))]
  pub async fn fail_stale_running_run_without_remote_change(
    &self,
    run_id: Uuid,
    profile_id: Uuid,
    job_id: &str,
    observed_remote_oid: &str,
    reason: &str,
  ) -> GitSyncResult<bool> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let result = sqlx::query(
      "UPDATE git_sync_runs
       SET status = 'Failed', finished_at = now(), commit_after = NULL,
           observed_remote_oid = $4, reconciliation_required = false,
           reconciliation_reason = NULL, error_message = $5,
           error_class = 'InternalError'
       WHERE id = $1 AND profile_id = $2 AND status = 'Running'
         AND job_id = $3 AND commit_before = $4",
    )
    .bind(run_id)
    .bind(profile_id)
    .bind(job_id)
    .bind(observed_remote_oid)
    .bind(reason)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 1 {
      sqlx::query(
        "UPDATE git_sync_partial_items
         SET status = 'Pending', error_class = NULL, error_message = NULL,
             updated_at = now()
         WHERE last_run_id = $1 AND status = 'Running'",
      )
      .bind(run_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(result.rows_affected() == 1)
  }

  #[instrument(skip(self), fields(%run_id, job_id))]
  pub async fn fail_pending_run_after_retry_exhaustion(
    &self,
    run_id: Uuid,
    job_id: &str,
    error_message: &str,
  ) -> GitSyncResult<bool> {
    let result = sqlx::query(
      r#"
      UPDATE git_sync_runs
      SET status = 'Failed',
          finished_at = now(),
          error_message = $3,
          error_class = 'InternalError'
      WHERE id = $1
        AND job_id = $2
        AND status = 'Pending'
      "#,
    )
    .bind(run_id)
    .bind(job_id)
    .bind(error_message)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(result.rows_affected() == 1)
  }

  /// Commit every normal Myoxus-side result after remote Git truth has been
  /// verified. No network, blob or conversion I/O belongs in this transaction.
  #[instrument(skip(self, plan), fields(run_id = %plan.run.id, profile_id = %plan.run.profile_id))]
  pub async fn commit_post_push(&self, plan: &GitSyncPostPushPlan) -> GitSyncResult<GitSyncPostPushCommit> {
    plan.validate().map_err(GitSyncStoreError::Validation)?;
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let admitted = sqlx::query_scalar::<_, Uuid>(
      "SELECT r.id FROM git_sync_runs r
       JOIN git_sync_profiles p ON p.id = r.profile_id
       WHERE r.id = $1 AND r.profile_id = $2 AND r.status = 'Running'
         AND r.job_id = $3 AND p.workspace_id = $4
       FOR UPDATE",
    )
    .bind(plan.run.id)
    .bind(plan.run.profile_id)
    .bind(&plan.expected_job_id)
    .bind(plan.workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if admitted.is_none() {
      return Err(GitSyncStoreError::NotFound);
    }

    // Native creates publish their root directory entry and registration in this
    // same final transaction. Reuse the sync writer's first-create → sorted
    // root/leaf lock order before acquiring individual SQL document rows.
    let ids = plan
      .document_upserts
      .iter()
      .map(|document| document.doc_id)
      .collect::<std::collections::BTreeSet<_>>();
    for id in &ids {
      sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(workspace_document_first_create_lock_key(
          plan.workspace_id,
          &id.to_string(),
        ))
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    if !ids.is_empty() {
      let mut locked = ids.into_iter().collect::<Vec<_>>();
      locked.push(plan.workspace_id);
      crate::doc::SqlxDocStore::lock_page_lifecycle_document_set(&mut tx, plan.workspace_id, &locked)
        .await
        .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
    }

    let mut docs_created = plan.run.docs_created;
    let mut docs_updated = plan.run.docs_updated;
    let mut docs_deleted = plan.run.docs_deleted;
    let mut document_conflicts_created = 0;
    let mut file_conflicts_created = 0;
    for document in &plan.document_upserts {
      let existing_workspace = sqlx::query_scalar::<_, Uuid>("SELECT workspace_id FROM docs WHERE id = $1 FOR UPDATE")
        .bind(document.doc_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      if existing_workspace.is_some_and(|workspace_id| workspace_id != plan.workspace_id) {
        return Err(GitSyncStoreError::Validation(format!(
          "document {} already belongs to another workspace",
          document.doc_id
        )));
      }
      let document_result = ensure_imported_workspace_document_at(
        &mut tx,
        ImportedWorkspaceDocumentCreate {
          doc_id: document.doc_id,
          workspace_id: document.workspace_id,
          title: &document.title,
          actor_user_id: document.actor_user_id,
          client_format: "myoxus-git-sync-import",
          provenance: &document.provenance,
          update_existing_title: true,
        },
        Some(document.observed_at),
      )
      .await
      .map_err(Self::map_db_err)?;
      match (document.expected_create, document_result.created) {
        (true, false) => {
          docs_created = docs_created.saturating_sub(1);
          docs_updated = docs_updated.saturating_add(1);
        }
        (false, true) => {
          docs_updated = docs_updated.saturating_sub(1);
          docs_created = docs_created.saturating_add(1);
        }
        _ => {}
      }
      crate::document_metadata::reject_guide_content_write(&mut tx, document.doc_id)
        .await
        .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
      let snapshot_result = sqlx::query(
        "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT (doc_id) DO UPDATE
           SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
         WHERE doc_snapshots.workspace_id = EXCLUDED.workspace_id",
      )
      .bind(document.doc_id)
      .bind(document.workspace_id)
      .bind(&document.payload)
      .bind(document.observed_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if snapshot_result.rows_affected() != 1 {
        return Err(GitSyncStoreError::Validation(format!(
          "snapshot {} conflicts with existing workspace ownership",
          document.doc_id
        )));
      }
      if document_result.created {
        let root_state = crate::doc::SqlxDocStore::load_full_doc_in_tx(&mut tx, plan.workspace_id, plan.workspace_id)
          .await
          .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
        let root = crate::doc::SqlxDocStore::register_created_page_in_tx(
          &mut tx,
          plan.workspace_id,
          document.doc_id,
          &document.doc_id.to_string(),
          &document.title,
          document.observed_at,
          &root_state,
        )
        .await
        .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
        crate::doc::SqlxDocStore::append_workspace_doc_broadcast_outbox(
          &mut tx,
          document.doc_id,
          plan.workspace_id,
          Some(document.actor_user_id),
          "page_registration",
          std::slice::from_ref(&root),
        )
        .await
        .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
      }
    }
    for doc_id in &plan.document_deletes {
      let deleted = sqlx::query(
        "UPDATE docs SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
      )
      .bind(doc_id)
      .bind(plan.workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if deleted.rows_affected() == 0 {
        docs_deleted = docs_deleted.saturating_sub(1);
      }
    }

    for binding in &plan.document_bindings {
      let result = sqlx::query(
        "INSERT INTO git_sync_bindings
           (id, profile_id, workspace_id, doc_id, sync_id, repo_path,
            last_commit_oid, content_hash, structure_hash, tombstone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           repo_path = EXCLUDED.repo_path,
           last_commit_oid = EXCLUDED.last_commit_oid,
           content_hash = EXCLUDED.content_hash,
           structure_hash = EXCLUDED.structure_hash,
           tombstone = EXCLUDED.tombstone,
           updated_at = now()
         WHERE git_sync_bindings.profile_id = EXCLUDED.profile_id
           AND git_sync_bindings.workspace_id = EXCLUDED.workspace_id
           AND git_sync_bindings.doc_id = EXCLUDED.doc_id",
      )
      .bind(binding.id)
      .bind(binding.profile_id)
      .bind(binding.workspace_id)
      .bind(binding.doc_id)
      .bind(binding.sync_id)
      .bind(&binding.repo_path)
      .bind(&binding.last_commit_oid)
      .bind(&binding.content_hash)
      .bind(&binding.structure_hash)
      .bind(binding.tombstone)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if result.rows_affected() != 1 {
        return Err(GitSyncStoreError::Validation(format!(
          "document binding {} conflicts with existing ownership",
          binding.id
        )));
      }
    }
    for binding_id in &plan.document_tombstone_ids {
      let result = sqlx::query(
        "UPDATE git_sync_bindings SET tombstone = true, updated_at = now()
         WHERE id = $1 AND profile_id = $2",
      )
      .bind(binding_id)
      .bind(plan.run.profile_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if result.rows_affected() != 1 {
        return Err(GitSyncStoreError::NotFound);
      }
    }
    for baseline in &plan.document_baselines {
      let owns_binding: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM git_sync_bindings WHERE id = $1 AND profile_id = $2
         )",
      )
      .bind(baseline.binding_id)
      .bind(plan.run.profile_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if !owns_binding {
        return Err(GitSyncStoreError::Validation(format!(
          "document baseline binding {} does not belong to profile {}",
          baseline.binding_id, plan.run.profile_id
        )));
      }
      sqlx::query(
        "INSERT INTO git_sync_baselines
           (binding_id, content_hash, commit_oid, myoxus_updated_at, captured_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (binding_id) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           commit_oid = EXCLUDED.commit_oid,
           myoxus_updated_at = EXCLUDED.myoxus_updated_at,
           captured_at = now()",
      )
      .bind(baseline.binding_id)
      .bind(&baseline.content_hash)
      .bind(&baseline.commit_oid)
      .bind(baseline.myoxus_updated_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    for conflict in &plan.document_conflicts {
      let owns_objects: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM docs d
           WHERE d.id = $1 AND d.workspace_id = $2
             AND ($3::uuid IS NULL OR EXISTS(
               SELECT 1 FROM git_sync_bindings b
               WHERE b.id = $3 AND b.profile_id = $4
             ))
         )",
      )
      .bind(conflict.doc_id)
      .bind(plan.workspace_id)
      .bind(conflict.binding_id)
      .bind(plan.run.profile_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if !owns_objects {
        return Err(GitSyncStoreError::Validation(format!(
          "document conflict {} crosses workspace or binding ownership",
          conflict.id
        )));
      }
      document_conflicts_created += usize::from(conflict_observation::document(&mut tx, conflict).await?.1);
    }

    let promoted_keys: Vec<String> = sqlx::query_scalar(
      "SELECT final_key FROM git_sync_blob_promotions WHERE id=ANY($1) AND workspace_id=$2 AND run_id=$3",
    )
    .bind(&plan.blob_promotion_ids)
    .bind(plan.workspace_id)
    .bind(plan.run.id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let normal_assets = plan
      .file_bindings
      .iter()
      .filter(|binding| promoted_keys.contains(&format!("{}/{}", plan.workspace_id, binding.blob_key)))
      .map(|binding| {
        Ok(myoxus_application::markdown::PreparedMarkdownAssetWrite {
          metadata: myoxus_application::markdown::MaterializedMarkdownAsset {
            original_source: binding.repo_path.clone(),
            blob_key: binding.blob_key.clone(),
            mime: binding.mime_type.clone(),
            size: usize::try_from(binding.file_size)
              .map_err(|_| GitSyncStoreError::Validation("Git asset size out of range".into()))?,
            checksum: binding.content_hash.clone(),
          },
          bytes: bytes::Bytes::new(),
        })
      })
      .collect::<GitSyncResult<Vec<_>>>()?;
    if !normal_assets.is_empty() {
      crate::blob::SqlxBlobStore::new(self.pool.clone())
        .reserve_markdown_import_assets_in_tx(&mut tx, plan.workspace_id, &normal_assets)
        .await
        .map_err(|error| GitSyncStoreError::Validation(error.to_string()))?;
    }

    for binding in &plan.file_bindings {
      let result = sqlx::query(
        "INSERT INTO git_sync_file_bindings
           (id, profile_id, workspace_id, blob_key, repo_path,
            content_hash, mime_type, file_size, tombstoned)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (profile_id, repo_path) DO UPDATE SET
           blob_key = EXCLUDED.blob_key,
           content_hash = EXCLUDED.content_hash,
           mime_type = EXCLUDED.mime_type,
           file_size = EXCLUDED.file_size,
           tombstoned = EXCLUDED.tombstoned,
           updated_at = now()
         WHERE git_sync_file_bindings.workspace_id = EXCLUDED.workspace_id",
      )
      .bind(binding.id)
      .bind(binding.profile_id)
      .bind(binding.workspace_id)
      .bind(&binding.blob_key)
      .bind(&binding.repo_path)
      .bind(&binding.content_hash)
      .bind(&binding.mime_type)
      .bind(binding.file_size)
      .bind(binding.tombstoned)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if result.rows_affected() != 1 {
        return Err(GitSyncStoreError::Validation(format!(
          "file binding {} conflicts with existing workspace ownership",
          binding.id
        )));
      }
    }
    for repo_path in &plan.file_tombstone_paths {
      sqlx::query(
        "UPDATE git_sync_file_bindings
         SET tombstoned = true, updated_at = now()
         WHERE profile_id = $1 AND repo_path = $2 AND tombstoned = false",
      )
      .bind(plan.run.profile_id)
      .bind(repo_path)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    for baseline in &plan.file_baselines {
      sqlx::query(
        "INSERT INTO git_sync_file_baselines
           (id, profile_id, blob_key, content_hash, commit_oid, synced_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (profile_id, blob_key) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           commit_oid = EXCLUDED.commit_oid,
           synced_at = now()",
      )
      .bind(baseline.id)
      .bind(baseline.profile_id)
      .bind(&baseline.blob_key)
      .bind(&baseline.content_hash)
      .bind(&baseline.commit_oid)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    for blob_key in &plan.file_baseline_deletes {
      sqlx::query("DELETE FROM git_sync_file_baselines WHERE profile_id = $1 AND blob_key = $2")
        .bind(plan.run.profile_id)
        .bind(blob_key)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    for conflict in &plan.file_conflicts {
      if let Some(binding_id) = conflict.binding_id {
        let owns_binding: bool = sqlx::query_scalar(
          "SELECT EXISTS(
             SELECT 1 FROM git_sync_file_bindings
             WHERE id = $1 AND profile_id = $2 AND workspace_id = $3
           )",
        )
        .bind(binding_id)
        .bind(plan.run.profile_id)
        .bind(plan.workspace_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        if !owns_binding {
          return Err(GitSyncStoreError::Validation(format!(
            "file conflict {} crosses binding ownership",
            conflict.id
          )));
        }
      }
      file_conflicts_created += usize::from(conflict_observation::file(&mut tx, conflict).await?.1);
    }
    for link in &plan.version_links {
      sqlx::query(
        "INSERT INTO git_sync_version_links
           (id, profile_id, run_id, sync_object_kind, sync_object_id,
            direction, git_commit_oid, myoxus_history_id, repo_path, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      )
      .bind(link.id)
      .bind(link.profile_id)
      .bind(link.run_id)
      .bind(&link.sync_object_kind)
      .bind(&link.sync_object_id)
      .bind(&link.direction)
      .bind(&link.git_commit_oid)
      .bind(link.myoxus_history_id)
      .bind(&link.repo_path)
      .bind(&link.content_hash)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    if !plan.blob_promotion_ids.is_empty() {
      let promoted = sqlx::query(
        "UPDATE git_sync_blob_promotions
         SET db_committed = true
         WHERE id = ANY($1) AND run_id = $2 AND profile_id = $3
           AND newly_promoted IS NOT NULL AND db_committed = false",
      )
      .bind(&plan.blob_promotion_ids)
      .bind(plan.run.id)
      .bind(plan.run.profile_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if promoted.rows_affected() != plan.blob_promotion_ids.len() as u64 {
        return Err(GitSyncStoreError::Validation(format!(
          "expected {} prepared blob promotion(s), updated {}",
          plan.blob_promotion_ids.len(),
          promoted.rows_affected()
        )));
      }
    }

    if let Some(partial) = &plan.partial {
      let owns_session: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM git_sync_partial_sessions
           WHERE id = $1 AND profile_id = $2
         )",
      )
      .bind(partial.session_id)
      .bind(plan.run.profile_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if !owns_session {
        return Err(GitSyncStoreError::Validation(
          "partial finalization crosses session ownership".to_string(),
        ));
      }
      for (item_ids, status, error_class, error_message) in [
        (&partial.completed_item_ids, "Completed", None, None),
        (
          &partial.failed_item_ids,
          "Failed",
          Some("InternalError"),
          Some("action failed during sync run"),
        ),
        (
          &partial.conflicted_item_ids,
          "Conflicted",
          Some("GitConflict"),
          Some("conflict detected during sync planning"),
        ),
      ] {
        if item_ids.is_empty() {
          continue;
        }
        let updated = sqlx::query(
          "UPDATE git_sync_partial_items
           SET status = $2, last_run_id = $3, error_class = $4,
               error_message = $5, updated_at = now()
           WHERE id = ANY($1) AND status = 'Running' AND last_run_id = $3",
        )
        .bind(item_ids)
        .bind(status)
        .bind(partial.run_id)
        .bind(error_class)
        .bind(error_message)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        if updated.rows_affected() != item_ids.len() as u64 {
          return Err(GitSyncStoreError::Validation(format!(
            "partial finalization expected {} {status} item(s), updated {}",
            item_ids.len(),
            updated.rows_affected()
          )));
        }
      }
      sqlx::query(
        "WITH counts AS (
           SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status IN ('Completed','Failed','Conflicted'))::int AS processed,
                  COUNT(*) FILTER (WHERE status IN ('Failed','Conflicted'))::int AS failed,
                  COUNT(*) FILTER (WHERE status IN ('Pending','Running'))::int AS remaining
           FROM git_sync_partial_items WHERE session_id = $1
         )
         UPDATE git_sync_partial_sessions s
         SET total_items = counts.total, processed_items = counts.processed,
             failed_items = counts.failed, last_run_id = $2,
             status = CASE WHEN counts.remaining = 0 AND counts.failed = 0 THEN 'Completed'
                           WHEN counts.remaining = 0 THEN 'CompletedWithFailures'
                           ELSE 'Open' END,
             completed_at = CASE WHEN counts.remaining = 0
                                 THEN COALESCE(s.completed_at, now()) ELSE NULL END,
             updated_at = now()
         FROM counts WHERE s.id = $1",
      )
      .bind(partial.session_id)
      .bind(partial.run_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    let error_class = plan.run.error_class.map(|value| value.to_string());
    let row = sqlx::query(
      "UPDATE git_sync_runs
       SET status = $4, finished_at = $5, commit_after = $6,
           observed_remote_oid = $7, reconciliation_required = false,
           reconciliation_reason = NULL,
           docs_created = $8, docs_updated = $9, docs_deleted = $10,
           conflicts_found = $11, error_message = $12, error_class = $13
       WHERE id = $1 AND profile_id = $2 AND status = 'Running' AND job_id = $3
       RETURNING id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
                 commit_before, commit_after, observed_remote_oid,
                 reconciliation_required, reconciliation_reason,
                 docs_created, docs_updated, docs_deleted, conflicts_found,
                 error_message, error_class, job_id",
    )
    .bind(plan.run.id)
    .bind(plan.run.profile_id)
    .bind(&plan.expected_job_id)
    .bind(plan.run.status.to_string())
    .bind(plan.run.finished_at)
    .bind(&plan.run.commit_after)
    .bind(&plan.run.observed_remote_oid)
    .bind(docs_created)
    .bind(docs_updated)
    .bind(docs_deleted)
    .bind(plan.run.conflicts_found)
    .bind(&plan.run.error_message)
    .bind(&error_class)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;
    let finalized = Self::map_run_row(row)?;
    tx.commit()
      .await
      .map_err(|error| GitSyncStoreError::CommitOutcomeUnknown {
        run_id: plan.run.id,
        message: error.to_string(),
        document_conflicts_created,
        file_conflicts_created,
      })?;
    Ok(GitSyncPostPushCommit {
      run: finalized,
      document_conflicts_created,
      file_conflicts_created,
    })
  }

  pub async fn create_blob_promotion(
    &self,
    id: Uuid,
    run_id: Uuid,
    profile_id: Uuid,
    workspace_id: Uuid,
    stage_key: &str,
    final_key: &str,
  ) -> GitSyncResult<()> {
    sqlx::query(
      "INSERT INTO git_sync_blob_promotions
         (id, run_id, profile_id, workspace_id, stage_key, final_key)
       SELECT $1, r.id, r.profile_id, p.workspace_id, $5, $6
       FROM git_sync_runs r
       JOIN git_sync_profiles p ON p.id = r.profile_id
       WHERE r.id = $2 AND r.profile_id = $3 AND r.status = 'Running'
         AND p.workspace_id = $4",
    )
    .bind(id)
    .bind(run_id)
    .bind(profile_id)
    .bind(workspace_id)
    .bind(stage_key)
    .bind(final_key)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)
    .and_then(|result| {
      if result.rows_affected() == 1 {
        Ok(())
      } else {
        Err(GitSyncStoreError::NotFound)
      }
    })
  }

  pub async fn mark_blob_promotion_prepared(&self, id: Uuid, newly_promoted: bool) -> GitSyncResult<()> {
    let result = sqlx::query(
      "UPDATE git_sync_blob_promotions
       SET newly_promoted = $2
       WHERE id = $1 AND newly_promoted IS NULL AND db_committed = false",
    )
    .bind(id)
    .bind(newly_promoted)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 1 {
      Ok(())
    } else {
      Err(GitSyncStoreError::NotFound)
    }
  }

  pub async fn delete_blob_promotion_records(&self, ids: &[Uuid]) -> GitSyncResult<u64> {
    if ids.is_empty() {
      return Ok(0);
    }
    sqlx::query("DELETE FROM git_sync_blob_promotions WHERE id = ANY($1)")
      .bind(ids)
      .execute(&self.pool)
      .await
      .map(|result| result.rows_affected())
      .map_err(Self::map_db_err)
  }

  pub async fn list_recoverable_blob_promotions(
    &self,
    older_than: chrono::DateTime<chrono::Utc>,
    limit: i64,
  ) -> GitSyncResult<Vec<GitSyncBlobPromotion>> {
    let rows = sqlx::query(
      "SELECT p.id, p.run_id, p.profile_id, p.workspace_id, p.stage_key,
              p.final_key, p.newly_promoted, p.db_committed, r.status
       FROM git_sync_blob_promotions p
       JOIN git_sync_runs r ON r.id = p.run_id
       WHERE p.created_at < $1
         AND (p.db_committed = true OR r.status <> 'Running')
       ORDER BY p.created_at, p.id
       LIMIT $2",
    )
    .bind(older_than)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    rows
      .into_iter()
      .map(|row| {
        Ok(GitSyncBlobPromotion {
          id: row.try_get("id").map_err(Self::map_db_err)?,
          run_id: row.try_get("run_id").map_err(Self::map_db_err)?,
          profile_id: row.try_get("profile_id").map_err(Self::map_db_err)?,
          workspace_id: row.try_get("workspace_id").map_err(Self::map_db_err)?,
          stage_key: row.try_get("stage_key").map_err(Self::map_db_err)?,
          final_key: row.try_get("final_key").map_err(Self::map_db_err)?,
          newly_promoted: row.try_get("newly_promoted").map_err(Self::map_db_err)?,
          db_committed: row.try_get("db_committed").map_err(Self::map_db_err)?,
          run_status: parse_run_status(&row.try_get::<String, _>("status").map_err(Self::map_db_err)?)?,
        })
      })
      .collect()
  }

  pub async fn blob_key_is_referenced(&self, _profile_id: Uuid, storage_key: &str) -> GitSyncResult<bool> {
    sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM git_sync_file_bindings WHERE tombstoned=false AND (blob_key=$1 OR workspace_id::text || '/' || blob_key=$1)) OR EXISTS(SELECT 1 FROM blobs WHERE workspace_id::text || '/' || key=$1)",
    ).bind(storage_key).fetch_one(&self.pool).await.map_err(Self::map_db_err)
  }

  /// Only an attempt-owned newly promoted object may reach this method. Keep
  /// normal blob publication behind the workspace accounting row while checking
  /// references and deleting external bytes; a concurrent upload cannot commit
  /// its metadata between the check and deletion. Recovery uses the same fence.
  pub async fn cleanup_unreferenced_blob_object(
    &self,
    storage: &dyn myoxus_application::ports::BlobStoragePort,
    storage_key: &str,
  ) -> GitSyncResult<bool> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let unreferenced = crate::blob::SqlxBlobStore::lock_unreferenced_import_object_cleanup_in_tx(&mut tx, storage_key)
      .await
      .map_err(|error| GitSyncStoreError::Validation(format!("uncommitted blob reference fence: {error}")))?;
    if unreferenced {
      storage
        .delete_blob(storage_key)
        .await
        .map_err(|error| GitSyncStoreError::Validation(format!("uncommitted blob cleanup: {error}")))?;
    }
    // A missing accounting row was only a temporary lock anchor. Failed import
    // compensation must not leave a newly created normal statistics row behind.
    tx.rollback().await.map_err(Self::map_db_err)?;
    Ok(unreferenced)
  }

  /// Emergency saga marker used only after the remote branch was verified but
  /// the normal post-push transaction rolled back.
  #[instrument(skip(self, run, reason), fields(run_id = %run.id, profile_id = %run.profile_id, job_id))]
  pub async fn mark_reconciliation_required(
    &self,
    run: &GitSyncRun,
    job_id: &str,
    observed_remote_oid: &str,
    reason: &str,
  ) -> GitSyncResult<bool> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let result = sqlx::query(
      "UPDATE git_sync_runs
       SET status = 'Failed', finished_at = now(), commit_after = NULL,
           observed_remote_oid = $4, reconciliation_required = true,
           reconciliation_reason = $5, error_message = $5,
           error_class = 'InternalError', docs_created = $6,
           docs_updated = $7, docs_deleted = $8, conflicts_found = $9
       WHERE id = $1 AND profile_id = $2 AND status = 'Running' AND job_id = $3",
    )
    .bind(run.id)
    .bind(run.profile_id)
    .bind(job_id)
    .bind(observed_remote_oid)
    .bind(reason)
    .bind(run.docs_created)
    .bind(run.docs_updated)
    .bind(run.docs_deleted)
    .bind(run.conflicts_found)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 1 {
      sqlx::query(
        "UPDATE git_sync_partial_items
         SET status = 'Failed', error_class = 'InternalError',
             error_message = $2, updated_at = now()
         WHERE last_run_id = $1 AND status = 'Running'",
      )
      .bind(run.id)
      .bind(reason)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      sqlx::query(
        "WITH affected AS (
           SELECT DISTINCT session_id FROM git_sync_partial_items WHERE last_run_id = $1
         ), counts AS (
           SELECT i.session_id, COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE i.status IN ('Completed','Failed','Conflicted'))::int AS processed,
                  COUNT(*) FILTER (WHERE i.status IN ('Failed','Conflicted'))::int AS failed,
                  COUNT(*) FILTER (WHERE i.status IN ('Pending','Running'))::int AS remaining
           FROM git_sync_partial_items i
           JOIN affected a ON a.session_id = i.session_id
           GROUP BY i.session_id
         )
         UPDATE git_sync_partial_sessions s
         SET total_items = counts.total, processed_items = counts.processed,
             failed_items = counts.failed, last_run_id = $1,
             status = CASE WHEN counts.remaining = 0 THEN 'CompletedWithFailures' ELSE 'Open' END,
             completed_at = CASE WHEN counts.remaining = 0 THEN COALESCE(s.completed_at, now()) ELSE NULL END,
             updated_at = now()
         FROM counts WHERE s.id = counts.session_id",
      )
      .bind(run.id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(result.rows_affected() == 1)
  }

  /// Update a run's mutable fields (status, counters, error info, timestamps).
  #[instrument(skip(self), fields(run_id = %run.id, status = %run.status))]
  pub async fn update_run(&self, run: &GitSyncRun) -> GitSyncResult<GitSyncRun> {
    let error_class_str = run.error_class.map(|ec| ec.to_string());
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;

    let row = sqlx::query(
      r#"
            UPDATE git_sync_runs
            SET status = $2, finished_at = $3, commit_after = $4,
                docs_created = $5, docs_updated = $6, docs_deleted = $7,
                conflicts_found = $8, error_message = $9, error_class = $10,
                observed_remote_oid = $11, reconciliation_required = $12,
                reconciliation_reason = $13
            WHERE id = $1 AND profile_id = $14 AND status = 'Running'
              AND job_id = $15
            RETURNING id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
                      commit_before, commit_after, observed_remote_oid,
                      reconciliation_required, reconciliation_reason,
                      docs_created, docs_updated, docs_deleted, conflicts_found,
                      error_message, error_class, job_id
            "#,
    )
    .bind(run.id)
    .bind(run.status.to_string())
    .bind(run.finished_at)
    .bind(&run.commit_after)
    .bind(run.docs_created)
    .bind(run.docs_updated)
    .bind(run.docs_deleted)
    .bind(run.conflicts_found)
    .bind(&run.error_message)
    .bind(&error_class_str)
    .bind(&run.observed_remote_oid)
    .bind(run.reconciliation_required)
    .bind(&run.reconciliation_reason)
    .bind(run.profile_id)
    .bind(run.job_id.as_deref().unwrap_or(""))
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    let result = Self::map_run_row(row)?;
    if matches!(run.status, RunStatus::Failed | RunStatus::Cancelled) {
      sqlx::query(
        "UPDATE git_sync_partial_items
         SET status = 'Pending', error_class = NULL, error_message = NULL,
             updated_at = now()
         WHERE last_run_id = $1 AND status = 'Running'",
      )
      .bind(run.id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    debug!(run_id = %result.id, status = %result.status, "sync run updated");
    Ok(result)
  }

  /// Fetch a single run by its ID (P38-E-02).
  #[instrument(skip(self))]
  pub async fn get_run(&self, run_id: Uuid) -> GitSyncResult<GitSyncRun> {
    let row = sqlx::query(
      r#"
            SELECT id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
                   commit_before, commit_after, observed_remote_oid,
                   reconciliation_required, reconciliation_reason,
                   docs_created, docs_updated, docs_deleted, conflicts_found,
                   error_message, error_class, job_id
            FROM git_sync_runs
            WHERE id = $1
            "#,
    )
    .bind(run_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    let result = Self::map_run_row(row)?;
    trace!(run_id = %result.id, "run fetched by id");
    Ok(result)
  }

  /// Fetch recent runs for a profile, ordered by start time descending.
  #[instrument(skip(self))]
  pub async fn get_runs_by_profile(&self, profile_id: Uuid, limit: i64) -> GitSyncResult<Vec<GitSyncRun>> {
    let rows = sqlx::query(
      r#"
            SELECT id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
                   commit_before, commit_after, observed_remote_oid,
                   reconciliation_required, reconciliation_reason,
                   docs_created, docs_updated, docs_deleted, conflicts_found,
                   error_message, error_class, job_id
            FROM git_sync_runs
            WHERE profile_id = $1
            ORDER BY started_at DESC
            LIMIT $2
            "#,
    )
    .bind(profile_id)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result: GitSyncResult<Vec<GitSyncRun>> = rows.into_iter().map(Self::map_run_row).collect();
    let runs = result?;
    trace!(count = runs.len(), "runs fetched by profile");
    Ok(runs)
  }

  // ── Conflict Operations ──────────────────────────────────────────────

  /// Reuse identical open input, or supersede it with a fresh decision ID.
  #[instrument(skip(self,conflict), fields(conflict_id = %conflict.id, conflict_type = %conflict.conflict_type))]
  pub async fn create_conflict(&self, conflict: &GitSyncConflict) -> GitSyncResult<GitSyncConflict> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let (result, created) = conflict_observation::document(&mut tx, conflict).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    debug!(conflict_id = %result.id,created, "conflict observed");
    Ok(result)
  }

  /// Fetch conflicts for a profile, optionally including resolved ones.
  #[instrument(skip(self))]
  pub async fn get_conflicts_by_profile(
    &self,
    profile_id: Uuid,
    include_resolved: bool,
  ) -> GitSyncResult<Vec<GitSyncConflict>> {
    let sql = if include_resolved {
      r#"
            SELECT id, profile_id, binding_id, doc_id, repo_path, conflict_type,
                   resolution, base_content, myoxus_content, git_content,
                   created_at, resolved_at, resolved_by
            FROM git_sync_conflicts
            WHERE profile_id = $1
            ORDER BY created_at DESC
            "#
    } else {
      r#"
            SELECT id, profile_id, binding_id, doc_id, repo_path, conflict_type,
                   resolution, base_content, myoxus_content, git_content,
                   created_at, resolved_at, resolved_by
            FROM git_sync_conflicts
            WHERE profile_id = $1 AND resolution = 'Open'
            ORDER BY created_at DESC
            "#
    };

    let rows = sqlx::query(sql)
      .bind(profile_id)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;

    let result: GitSyncResult<Vec<GitSyncConflict>> = rows.into_iter().map(Self::map_conflict_row).collect();
    let conflicts = result?;
    trace!(count = conflicts.len(), "conflicts fetched by profile");
    Ok(conflicts)
  }

  /// Fetch a single conflict by its ID.
  #[instrument(skip(self))]
  pub async fn get_conflict(&self, conflict_id: Uuid) -> GitSyncResult<GitSyncConflict> {
    let row = sqlx::query(
      r#"
            SELECT id, profile_id, binding_id, doc_id, repo_path, conflict_type,
                   resolution, base_content, myoxus_content, git_content,
                   created_at, resolved_at, resolved_by
            FROM git_sync_conflicts
            WHERE id = $1
            "#,
    )
    .bind(conflict_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    let result = Self::map_conflict_row(row)?;
    trace!(conflict_id = %result.id, "conflict fetched by id");
    Ok(result)
  }

  /// Resolve a conflict by updating its resolution, resolver, and timestamp.
  #[instrument(skip(self))]
  pub async fn resolve_conflict(
    &self,
    conflict_id: Uuid,
    resolution: ConflictResolution,
    resolved_by: Uuid,
  ) -> GitSyncResult<GitSyncConflict> {
    let row = sqlx::query(
      r#"
            UPDATE git_sync_conflicts
            SET resolution = $2, resolved_by = $3, resolved_at = now()
            WHERE id = $1 AND resolution = 'Open'
            RETURNING id, profile_id, binding_id, doc_id, repo_path, conflict_type,
                      resolution, base_content, myoxus_content, git_content,
                      created_at, resolved_at, resolved_by
            "#,
    )
    .bind(conflict_id)
    .bind(resolution.to_string())
    .bind(resolved_by)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    let result = Self::map_conflict_row(row)?;
    debug!(conflict_id = %result.id, resolution = %result.resolution, "conflict resolved");
    Ok(result)
  }

  // ── File Conflict Operations ────────────────────────────────────────

  /// Reuse identical open input; changed hashes/ownership supersede its ID.
  #[instrument(skip(self,conflict), fields(conflict_id = %conflict.id))]
  pub async fn create_file_conflict(&self, conflict: &GitSyncFileConflict) -> GitSyncResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let (observed, created) = conflict_observation::file(&mut tx, conflict).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    debug!(conflict_id = %observed.id,created, "file conflict observed");
    Ok(())
  }

  /// Immutable conflict IDs may have been superseded since an API read. Check
  /// durable decision state before any content/baseline or remote side effect.
  pub async fn conflict_is_open(&self, id: Uuid, file: bool) -> GitSyncResult<bool> {
    let sql = if file {
      "SELECT EXISTS(SELECT 1 FROM git_sync_file_conflicts WHERE id=$1 AND resolution='Open')"
    } else {
      "SELECT EXISTS(SELECT 1 FROM git_sync_conflicts WHERE id=$1 AND resolution='Open')"
    };
    sqlx::query_scalar(sql)
      .bind(id)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  /// A completed run's workspace watermark does not acknowledge conflicted
  /// local content. Those documents still need an actual current projection.
  pub async fn open_conflict_document_ids(&self, profile_id: Uuid) -> GitSyncResult<Vec<Uuid>> {
    sqlx::query_scalar("SELECT doc_id FROM git_sync_conflicts WHERE profile_id=$1 AND resolution='Open'")
      .bind(profile_id)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  /// Fetch file conflicts for a profile.
  ///
  /// File conflicts are intentionally separate from document conflicts because
  /// they identify blob/binding state and do not expose mergeable text bodies.
  #[instrument(skip(self))]
  pub async fn get_file_conflicts_by_profile(
    &self,
    profile_id: Uuid,
    resolved: bool,
  ) -> GitSyncResult<Vec<GitSyncFileConflict>> {
    let sql = if resolved {
      r#"
            SELECT id, profile_id, run_id, binding_id, blob_key, repo_path,
                   conflict_type, resolution, git_hash, myoxus_hash,
                   baseline_hash, created_at, resolved_at, resolved_by
            FROM git_sync_file_conflicts
            WHERE profile_id = $1 AND resolution <> 'Open'
            ORDER BY created_at DESC
            "#
    } else {
      r#"
            SELECT id, profile_id, run_id, binding_id, blob_key, repo_path,
                   conflict_type, resolution, git_hash, myoxus_hash,
                   baseline_hash, created_at, resolved_at, resolved_by
            FROM git_sync_file_conflicts
            WHERE profile_id = $1 AND resolution = 'Open'
            ORDER BY created_at DESC
            "#
    };

    let rows = sqlx::query(sql)
      .bind(profile_id)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;

    rows.into_iter().map(Self::map_file_conflict_row).collect()
  }

  /// Fetch a single file conflict by its ID.
  #[instrument(skip(self))]
  pub async fn get_file_conflict(&self, conflict_id: Uuid) -> GitSyncResult<GitSyncFileConflict> {
    let row = sqlx::query(
      r#"
            SELECT id, profile_id, run_id, binding_id, blob_key, repo_path,
                   conflict_type, resolution, git_hash, myoxus_hash,
                   baseline_hash, created_at, resolved_at, resolved_by
            FROM git_sync_file_conflicts
            WHERE id = $1
            "#,
    )
    .bind(conflict_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    Self::map_file_conflict_row(row)
  }

  /// Resolve a file conflict by updating its marker.
  ///
  /// The `resolution = 'Open'` guard keeps conflict resolution idempotent and
  /// prevents late GraphQL/Admin retries from overwriting the first resolver.
  #[instrument(skip(self))]
  pub async fn resolve_file_conflict(
    &self,
    conflict_id: Uuid,
    resolution: ConflictResolution,
    resolved_by: Uuid,
  ) -> GitSyncResult<GitSyncFileConflict> {
    let row = sqlx::query(
      r#"
            UPDATE git_sync_file_conflicts
            SET resolution = $2, resolved_by = $3, resolved_at = now()
            WHERE id = $1 AND resolution = 'Open'
            RETURNING id, profile_id, run_id, binding_id, blob_key, repo_path,
                      conflict_type, resolution, git_hash, myoxus_hash,
                      baseline_hash, created_at, resolved_at, resolved_by
            "#,
    )
    .bind(conflict_id)
    .bind(resolution.to_string())
    .bind(resolved_by)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    let result = Self::map_file_conflict_row(row)?;
    debug!(conflict_id = %result.id, resolution = %result.resolution, "file conflict resolved");
    Ok(result)
  }

  // ── Baseline Operations ──────────────────────────────────────────────

  /// Insert or update a baseline for a binding.
  #[instrument(skip(self))]
  pub async fn upsert_baseline(&self, baseline: &GitSyncBaseline) -> GitSyncResult<()> {
    sqlx::query(
      r#"
            INSERT INTO git_sync_baselines
                (binding_id, content_hash, commit_oid, myoxus_updated_at, captured_at)
            VALUES ($1, $2, $3, $4, now())
            ON CONFLICT (binding_id) DO UPDATE SET
                content_hash = EXCLUDED.content_hash,
                commit_oid = EXCLUDED.commit_oid,
                myoxus_updated_at = EXCLUDED.myoxus_updated_at,
                captured_at = now()
            "#,
    )
    .bind(baseline.binding_id)
    .bind(&baseline.content_hash)
    .bind(&baseline.commit_oid)
    .bind(baseline.myoxus_updated_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(binding_id = %baseline.binding_id, "baseline upserted");
    Ok(())
  }

  /// Fetch the baseline for a binding.
  #[instrument(skip(self))]
  pub async fn get_baseline(&self, binding_id: Uuid) -> GitSyncResult<Option<GitSyncBaseline>> {
    let row = sqlx::query(
      r#"
            SELECT binding_id, content_hash, commit_oid, myoxus_updated_at, captured_at
            FROM git_sync_baselines
            WHERE binding_id = $1
            "#,
    )
    .bind(binding_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(|r| GitSyncBaseline {
      binding_id: r.get("binding_id"),
      content_hash: r.get("content_hash"),
      commit_oid: r.get("commit_oid"),
      myoxus_updated_at: r.get("myoxus_updated_at"),
      captured_at: r.get("captured_at"),
    });
    trace!(found = result.is_some(), "baseline lookup");
    Ok(result)
  }

  /// Fetch baselines for all bindings of a profile (bulk load).
  ///
  /// Returns a Vec of `(binding_id, GitSyncBaseline)` for use in reconciliation.
  #[instrument(skip(self))]
  pub async fn get_baselines_by_profile(&self, profile_id: Uuid) -> GitSyncResult<Vec<GitSyncBaseline>> {
    let rows = sqlx::query(
      r#"
      SELECT bl.binding_id, bl.content_hash, bl.commit_oid, bl.myoxus_updated_at, bl.captured_at
      FROM git_sync_baselines bl
      JOIN git_sync_bindings bi ON bi.id = bl.binding_id
      WHERE bi.profile_id = $1 AND bi.tombstone = false
      "#,
    )
    .bind(profile_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let baselines: Vec<GitSyncBaseline> = rows
      .iter()
      .map(|r| GitSyncBaseline {
        binding_id: r.get("binding_id"),
        content_hash: r.get("content_hash"),
        commit_oid: r.get("commit_oid"),
        myoxus_updated_at: r.get("myoxus_updated_at"),
        captured_at: r.get("captured_at"),
      })
      .collect();

    debug!(count = baselines.len(), %profile_id, "loaded baselines for profile");
    Ok(baselines)
  }

  // ── File Binding Operations ──────────────────────────────────────────

  /// Fetch all non-tombstoned file bindings for a profile.
  #[instrument(skip(self))]
  pub async fn get_file_bindings_by_profile(&self, profile_id: Uuid) -> GitSyncResult<Vec<GitSyncFileBinding>> {
    let rows = sqlx::query(
      r#"
            SELECT id, profile_id, workspace_id, blob_key, repo_path,
                   content_hash, mime_type, file_size, tombstoned,
                   created_at, updated_at
            FROM git_sync_file_bindings
            WHERE profile_id = $1 AND tombstoned = false
            ORDER BY created_at ASC
            "#,
    )
    .bind(profile_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result: GitSyncResult<Vec<GitSyncFileBinding>> = rows.into_iter().map(Self::map_file_binding_row).collect();
    let bindings = result?;
    trace!(count = bindings.len(), %profile_id, "file bindings fetched by profile");
    Ok(bindings)
  }

  /// Fetch file bindings for API/admin views with optional tombstoned rows.
  #[instrument(skip(self))]
  pub async fn get_file_bindings_by_profile_for_view(
    &self,
    profile_id: Uuid,
    include_tombstoned: bool,
  ) -> GitSyncResult<Vec<GitSyncFileBinding>> {
    let rows = sqlx::query(
      r#"
            SELECT id, profile_id, workspace_id, blob_key, repo_path,
                   content_hash, mime_type, file_size, tombstoned,
                   created_at, updated_at
            FROM git_sync_file_bindings
            WHERE profile_id = $1 AND ($2 OR tombstoned = false)
            ORDER BY created_at ASC
            "#,
    )
    .bind(profile_id)
    .bind(include_tombstoned)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    rows.into_iter().map(Self::map_file_binding_row).collect()
  }

  /// Fetch a single file binding by ID.
  #[instrument(skip(self))]
  pub async fn get_file_binding(&self, binding_id: Uuid) -> GitSyncResult<GitSyncFileBinding> {
    let row = sqlx::query(
      r#"
            SELECT id, profile_id, workspace_id, blob_key, repo_path,
                   content_hash, mime_type, file_size, tombstoned,
                   created_at, updated_at
            FROM git_sync_file_bindings
            WHERE id = $1
            "#,
    )
    .bind(binding_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    Self::map_file_binding_row(row)
  }

  /// Fetch a file binding by profile and repo path, including tombstoned rows.
  #[instrument(skip(self))]
  pub async fn get_file_binding_by_profile_path(
    &self,
    profile_id: Uuid,
    repo_path: &str,
  ) -> GitSyncResult<Option<GitSyncFileBinding>> {
    let row = sqlx::query(
      r#"
            SELECT id, profile_id, workspace_id, blob_key, repo_path,
                   content_hash, mime_type, file_size, tombstoned,
                   created_at, updated_at
            FROM git_sync_file_bindings
            WHERE profile_id = $1 AND repo_path = $2
            "#,
    )
    .bind(profile_id)
    .bind(repo_path)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(Self::map_file_binding_row).transpose()
  }

  /// Insert or update a file binding (keyed on `profile_id + repo_path`).
  #[instrument(skip(self), fields(profile_id = %binding.profile_id, repo_path = %binding.repo_path))]
  pub async fn upsert_file_binding(&self, binding: &GitSyncFileBinding) -> GitSyncResult<()> {
    sqlx::query(
      r#"
            INSERT INTO git_sync_file_bindings
                (id, profile_id, workspace_id, blob_key, repo_path,
                 content_hash, mime_type, file_size, tombstoned)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (profile_id, repo_path) DO UPDATE SET
                blob_key = EXCLUDED.blob_key,
                content_hash = EXCLUDED.content_hash,
                mime_type = EXCLUDED.mime_type,
                file_size = EXCLUDED.file_size,
                tombstoned = EXCLUDED.tombstoned,
                updated_at = now()
            "#,
    )
    .bind(binding.id)
    .bind(binding.profile_id)
    .bind(binding.workspace_id)
    .bind(&binding.blob_key)
    .bind(&binding.repo_path)
    .bind(&binding.content_hash)
    .bind(&binding.mime_type)
    .bind(binding.file_size)
    .bind(binding.tombstoned)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(profile_id = %binding.profile_id, repo_path = %binding.repo_path, "file binding upserted");
    Ok(())
  }

  /// Mark a file binding as tombstoned (soft-delete) by profile and repo path.
  #[instrument(skip(self))]
  pub async fn tombstone_file_binding(&self, profile_id: Uuid, repo_path: &str) -> GitSyncResult<()> {
    let result = sqlx::query(
      r#"
            UPDATE git_sync_file_bindings
            SET tombstoned = true, updated_at = now()
            WHERE profile_id = $1 AND repo_path = $2 AND tombstoned = false
            "#,
    )
    .bind(profile_id)
    .bind(repo_path)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    if result.rows_affected() == 0 {
      return Err(GitSyncStoreError::NotFound);
    }
    debug!(%profile_id, %repo_path, "file binding tombstoned");
    Ok(())
  }

  // ── File Baseline Operations ────────────────────────────────────────

  /// Fetch all file baselines for a profile.
  #[instrument(skip(self))]
  pub async fn get_file_baselines_by_profile(&self, profile_id: Uuid) -> GitSyncResult<Vec<GitSyncFileBaseline>> {
    let rows = sqlx::query(
      r#"
            SELECT id, profile_id, blob_key, content_hash, commit_oid, synced_at
            FROM git_sync_file_baselines
            WHERE profile_id = $1
            "#,
    )
    .bind(profile_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result: GitSyncResult<Vec<GitSyncFileBaseline>> = rows.into_iter().map(Self::map_file_baseline_row).collect();
    let baselines = result?;
    debug!(count = baselines.len(), %profile_id, "loaded file baselines for profile");
    Ok(baselines)
  }

  /// Insert or update a file baseline (keyed on `profile_id + blob_key`).
  #[instrument(skip(self), fields(profile_id = %baseline.profile_id, blob_key = %baseline.blob_key))]
  pub async fn upsert_file_baseline(&self, baseline: &GitSyncFileBaseline) -> GitSyncResult<()> {
    sqlx::query(
      r#"
            INSERT INTO git_sync_file_baselines
                (id, profile_id, blob_key, content_hash, commit_oid, synced_at)
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT (profile_id, blob_key) DO UPDATE SET
                content_hash = EXCLUDED.content_hash,
                commit_oid = EXCLUDED.commit_oid,
                synced_at = now()
            "#,
    )
    .bind(baseline.id)
    .bind(baseline.profile_id)
    .bind(&baseline.blob_key)
    .bind(&baseline.content_hash)
    .bind(&baseline.commit_oid)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(profile_id = %baseline.profile_id, blob_key = %baseline.blob_key, "file baseline upserted");
    Ok(())
  }

  /// Delete a file baseline by profile and blob key.
  #[instrument(skip(self))]
  pub async fn delete_file_baseline(&self, profile_id: Uuid, blob_key: &str) -> GitSyncResult<()> {
    let result = sqlx::query(
      r#"
            DELETE FROM git_sync_file_baselines
            WHERE profile_id = $1 AND blob_key = $2
            "#,
    )
    .bind(profile_id)
    .bind(blob_key)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    if result.rows_affected() == 0 {
      return Err(GitSyncStoreError::NotFound);
    }
    debug!(%profile_id, %blob_key, "file baseline deleted");
    Ok(())
  }

  // ── Partial Sync Session Operations ─────────────────────────────────

  /// Fetch the active partial session for a profile, if one exists.
  #[instrument(skip(self), fields(profile_id = %profile_id))]
  pub async fn get_open_partial_session(&self, profile_id: Uuid) -> GitSyncResult<Option<GitSyncPartialSession>> {
    let row = sqlx::query(
      r#"
      SELECT id, profile_id, direction, source_workspace_watermark, source_git_commit_oid,
             status, total_items, processed_items, failed_items, created_run_id,
             last_run_id, created_at, updated_at, completed_at
      FROM git_sync_partial_sessions
      WHERE profile_id = $1 AND status = 'Open'
      ORDER BY created_at ASC
      LIMIT 1
      "#,
    )
    .bind(profile_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(Self::map_partial_session_row).transpose()
  }

  /// Fetch the latest partial session for status surfaces.
  #[instrument(skip(self), fields(profile_id = %profile_id))]
  pub async fn get_latest_partial_session(&self, profile_id: Uuid) -> GitSyncResult<Option<GitSyncPartialSession>> {
    let row = sqlx::query(
      r#"
      SELECT id, profile_id, direction, source_workspace_watermark, source_git_commit_oid,
             status, total_items, processed_items, failed_items, created_run_id,
             last_run_id, created_at, updated_at, completed_at
      FROM git_sync_partial_sessions
      WHERE profile_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      "#,
    )
    .bind(profile_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(Self::map_partial_session_row).transpose()
  }

  /// Preview the same deterministic pending document slice that the next run
  /// will claim. The runner uses this only to admit body payloads before the
  /// reconciliation plan reaches the existing claiming boundary.
  pub async fn peek_next_pending_partial_doc_ids(&self, session_id: Uuid, limit: usize) -> GitSyncResult<Vec<Uuid>> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let rows = sqlx::query_scalar::<_, Uuid>(
      r#"
      SELECT doc_id
      FROM git_sync_partial_items
      WHERE session_id = $1 AND status = 'Pending' AND doc_id IS NOT NULL
      ORDER BY sort_key ASC
      LIMIT $2
      "#,
    )
    .bind(session_id)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows)
  }

  /// Create a partial session and all deterministic items in one transaction.
  #[instrument(skip(self, session, items), fields(session_id = %session.id, profile_id = %session.profile_id, items = items.len()))]
  pub async fn create_partial_session_with_items(
    &self,
    session: &GitSyncPartialSession,
    items: &[GitSyncPartialItem],
  ) -> GitSyncResult<GitSyncPartialSession> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;

    let row = sqlx::query(
      r#"
      INSERT INTO git_sync_partial_sessions
        (id, profile_id, direction, source_workspace_watermark, source_git_commit_oid,
         status, total_items, processed_items, failed_items, created_run_id, last_run_id,
         created_at, updated_at, completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, profile_id, direction, source_workspace_watermark, source_git_commit_oid,
                status, total_items, processed_items, failed_items, created_run_id,
                last_run_id, created_at, updated_at, completed_at
      "#,
    )
    .bind(session.id)
    .bind(session.profile_id)
    .bind(session.direction.to_string())
    .bind(session.source_workspace_watermark)
    .bind(&session.source_git_commit_oid)
    .bind(session.status.to_string())
    .bind(session.total_items)
    .bind(session.processed_items)
    .bind(session.failed_items)
    .bind(session.created_run_id)
    .bind(session.last_run_id)
    .bind(session.created_at)
    .bind(session.updated_at)
    .bind(session.completed_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    for item in items {
      let error_class_str = item.error_class.map(|ec| ec.to_string());
      sqlx::query(
        r#"
        INSERT INTO git_sync_partial_items
          (id, session_id, profile_id, item_kind, item_key, doc_id, repo_path, sort_key,
           status, attempts, last_run_id, error_class, error_message, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        "#,
      )
      .bind(item.id)
      .bind(item.session_id)
      .bind(item.profile_id)
      .bind(item.item_kind.to_string())
      .bind(&item.item_key)
      .bind(item.doc_id)
      .bind(&item.repo_path)
      .bind(&item.sort_key)
      .bind(item.status.to_string())
      .bind(item.attempts)
      .bind(item.last_run_id)
      .bind(&error_class_str)
      .bind(&item.error_message)
      .bind(item.created_at)
      .bind(item.updated_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    tx.commit().await.map_err(Self::map_db_err)?;
    let created = Self::map_partial_session_row(row)?;
    debug!(session_id = %created.id, total_items = created.total_items, "partial sync session created");
    Ok(created)
  }

  /// Mark and return the next pending items for a run.
  #[instrument(skip(self), fields(session_id = %session_id, run_id = %run_id, limit = limit))]
  pub async fn claim_next_partial_items(
    &self,
    session_id: Uuid,
    run_id: Uuid,
    limit: usize,
  ) -> GitSyncResult<Vec<GitSyncPartialItem>> {
    let rows = sqlx::query(
      r#"
      WITH selected AS (
        SELECT id
        FROM git_sync_partial_items
        WHERE session_id = $1 AND status = 'Pending'
        ORDER BY sort_key ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE git_sync_partial_items i
      SET status = 'Running',
          attempts = attempts + 1,
          last_run_id = $3,
          updated_at = now(),
          error_class = NULL,
          error_message = NULL
      FROM selected
      WHERE i.id = selected.id
      RETURNING i.id, i.session_id, i.profile_id, i.item_kind, i.item_key,
                i.doc_id, i.repo_path, i.sort_key, i.status, i.attempts,
                i.last_run_id, i.error_class, i.error_message, i.created_at, i.updated_at
      "#,
    )
    .bind(session_id)
    .bind(limit as i64)
    .bind(run_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    rows.into_iter().map(Self::map_partial_item_row).collect()
  }

  #[instrument(skip(self, item_ids, error_message), fields(count = item_ids.len(), status = %status))]
  pub async fn mark_partial_items(
    &self,
    item_ids: &[Uuid],
    status: PartialItemStatus,
    run_id: Uuid,
    error_class: Option<ErrorClass>,
    error_message: Option<&str>,
  ) -> GitSyncResult<()> {
    if item_ids.is_empty() {
      return Ok(());
    }
    let error_class_str = error_class.map(|ec| ec.to_string());
    sqlx::query(
      r#"
      UPDATE git_sync_partial_items
      SET status = $2,
          last_run_id = $3,
          error_class = $4,
          error_message = $5,
          updated_at = now()
      WHERE id = ANY($1)
      "#,
    )
    .bind(item_ids)
    .bind(status.to_string())
    .bind(run_id)
    .bind(&error_class_str)
    .bind(error_message)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Recompute session counters and close the session when no work remains.
  #[instrument(skip(self), fields(session_id = %session_id, run_id = %run_id))]
  pub async fn refresh_partial_session_counters(
    &self,
    session_id: Uuid,
    run_id: Uuid,
  ) -> GitSyncResult<GitSyncPartialSession> {
    let row = sqlx::query(
      r#"
      WITH counts AS (
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status IN ('Completed', 'Failed', 'Conflicted'))::int AS processed,
          COUNT(*) FILTER (WHERE status IN ('Failed', 'Conflicted'))::int AS failed,
          COUNT(*) FILTER (WHERE status IN ('Pending', 'Running'))::int AS remaining
        FROM git_sync_partial_items
        WHERE session_id = $1
      )
      UPDATE git_sync_partial_sessions s
      SET total_items = counts.total,
          processed_items = counts.processed,
          failed_items = counts.failed,
          last_run_id = $2,
          status = CASE
            WHEN counts.remaining = 0 AND counts.failed = 0 THEN 'Completed'
            WHEN counts.remaining = 0 THEN 'CompletedWithFailures'
            ELSE 'Open'
          END,
          completed_at = CASE
            WHEN counts.remaining = 0 THEN COALESCE(s.completed_at, now())
            ELSE NULL
          END,
          updated_at = now()
      FROM counts
      WHERE s.id = $1
      RETURNING s.id, s.profile_id, s.direction, s.source_workspace_watermark, s.source_git_commit_oid,
                s.status, s.total_items, s.processed_items, s.failed_items, s.created_run_id,
                s.last_run_id, s.created_at, s.updated_at, s.completed_at
      "#,
    )
    .bind(session_id)
    .bind(run_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    Self::map_partial_session_row(row)
  }

  // ── Credential Operations ────────────────────────────────────────────

  /// Store encrypted credential material and return the reference.
  #[instrument(skip(self, encrypted_data))]
  pub async fn create_credential(
    &self,
    profile_id: Uuid,
    auth_method: AuthMethod,
    label: &str,
    encrypted_data: &[u8],
  ) -> GitSyncResult<GitCredentialRef> {
    self
      .create_credential_with_expiry(profile_id, auth_method, label, encrypted_data, None)
      .await
  }

  /// Store encrypted credential material with an optional expiry timestamp.
  #[instrument(skip(self, encrypted_data))]
  pub async fn create_credential_with_expiry(
    &self,
    profile_id: Uuid,
    auth_method: AuthMethod,
    label: &str,
    encrypted_data: &[u8],
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
  ) -> GitSyncResult<GitCredentialRef> {
    let row = sqlx::query(
      r#"
            INSERT INTO git_sync_credentials
                (profile_id, auth_method, label, encrypted_data, expires_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, profile_id, auth_method, label, created_at, expires_at
            "#,
    )
    .bind(profile_id)
    .bind(auth_method.to_string())
    .bind(label)
    .bind(encrypted_data)
    .bind(expires_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let cred = GitCredentialRef {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      auth_method: parse_auth_method(&row.get::<String, _>("auth_method"))?,
      label: row.get("label"),
      created_at: row.get("created_at"),
      expires_at: row.get("expires_at"),
    };
    debug!(credential_id = %cred.id, expires_at = ?cred.expires_at, "credential created");
    Ok(cred)
  }

  /// Fetch a credential reference (without the encrypted data).
  #[instrument(skip(self))]
  pub async fn get_credential(&self, credential_id: Uuid) -> GitSyncResult<GitCredentialRef> {
    let row = sqlx::query(
      r#"
            SELECT id, profile_id, auth_method, label, created_at, expires_at
            FROM git_sync_credentials
            WHERE id = $1
            "#,
    )
    .bind(credential_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;

    let cred = GitCredentialRef {
      id: row.get("id"),
      profile_id: row.get("profile_id"),
      auth_method: parse_auth_method(&row.get::<String, _>("auth_method"))?,
      label: row.get("label"),
      created_at: row.get("created_at"),
      expires_at: row.get("expires_at"),
    };
    trace!(credential_id = %cred.id, "credential fetched");
    Ok(cred)
  }

  /// Fetch the raw encrypted credential data for decryption.
  #[instrument(skip(self))]
  pub async fn get_credential_encrypted_data(&self, credential_id: Uuid) -> GitSyncResult<Vec<u8>> {
    let row = sqlx::query("SELECT encrypted_data FROM git_sync_credentials WHERE id = $1")
      .bind(credential_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(GitSyncStoreError::NotFound)?;

    let data: Vec<u8> = row.get("encrypted_data");
    trace!(data_len = data.len(), "encrypted credential data fetched");
    Ok(data)
  }

  /// Delete a credential.
  #[instrument(skip(self))]
  pub async fn delete_credential(&self, credential_id: Uuid) -> GitSyncResult<()> {
    let result = sqlx::query("DELETE FROM git_sync_credentials WHERE id = $1")
      .bind(credential_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;

    if result.rows_affected() == 0 {
      return Err(GitSyncStoreError::NotFound);
    }
    debug!("credential deleted");
    Ok(())
  }

  // ── Version Link Operations ─────────────────────────────────────────

  /// Insert multiple version links in a single batch for efficiency.
  ///
  /// Uses a multi-row INSERT to minimise round-trips. An empty slice is a no-op.
  #[instrument(skip(self, links), fields(count = links.len()))]
  pub async fn insert_version_links_batch(&self, links: &[GitSyncVersionLink]) -> GitSyncResult<()> {
    if links.is_empty() {
      trace!("insert_version_links_batch called with empty slice, no-op");
      return Ok(());
    }

    // MED-05: Chunk into batches of 1000 to avoid unbounded INSERT statements.
    const BATCH_SIZE: usize = 1000;
    for chunk in links.chunks(BATCH_SIZE) {
      self.insert_version_links_chunk(chunk).await?;
    }

    debug!(count = links.len(), "version links batch inserted");
    Ok(())
  }

  /// Insert a single chunk of version links (internal helper).
  async fn insert_version_links_chunk(&self, chunk: &[GitSyncVersionLink]) -> GitSyncResult<()> {
    // Build a multi-row VALUES clause.  Each row has 10 parameters.
    // SQLx positional parameters: $1..$10 for row 0, $11..$20 for row 1, etc.
    let mut sql = String::from(
      "INSERT INTO git_sync_version_links \
       (id, profile_id, run_id, sync_object_kind, sync_object_id, \
        direction, git_commit_oid, myoxus_history_id, repo_path, content_hash) VALUES ",
    );

    for (i, _) in chunk.iter().enumerate() {
      if i > 0 {
        sql.push_str(", ");
      }
      let base = i * 10;
      sql.push_str(&format!(
        "(${}, ${}, ${}, ${}, ${}, ${}, ${}, ${}, ${}, ${})",
        base + 1,
        base + 2,
        base + 3,
        base + 4,
        base + 5,
        base + 6,
        base + 7,
        base + 8,
        base + 9,
        base + 10,
      ));
    }

    let mut query = sqlx::query(&sql);
    for link in chunk {
      query = query
        .bind(link.id)
        .bind(link.profile_id)
        .bind(link.run_id)
        .bind(&link.sync_object_kind)
        .bind(&link.sync_object_id)
        .bind(&link.direction)
        .bind(&link.git_commit_oid)
        .bind(link.myoxus_history_id)
        .bind(&link.repo_path)
        .bind(&link.content_hash);
    }

    query.execute(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Fetch all version links for a given run, ordered by creation time.
  #[instrument(skip(self))]
  pub async fn get_version_links_by_run(&self, run_id: Uuid) -> GitSyncResult<Vec<GitSyncVersionLink>> {
    let rows = sqlx::query(
      r#"
            SELECT id, profile_id, run_id, sync_object_kind, sync_object_id,
                   direction, git_commit_oid, myoxus_history_id, repo_path,
                   content_hash, created_at
            FROM git_sync_version_links
            WHERE run_id = $1
            ORDER BY created_at ASC
            "#,
    )
    .bind(run_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let links: Vec<GitSyncVersionLink> = rows
      .into_iter()
      .map(|row| GitSyncVersionLink {
        id: row.get("id"),
        profile_id: row.get("profile_id"),
        run_id: row.get("run_id"),
        sync_object_kind: row.get("sync_object_kind"),
        sync_object_id: row.get("sync_object_id"),
        direction: row.get("direction"),
        git_commit_oid: row.get("git_commit_oid"),
        myoxus_history_id: row.get("myoxus_history_id"),
        repo_path: row.get("repo_path"),
        content_hash: row.get("content_hash"),
        created_at: row.get("created_at"),
      })
      .collect();

    trace!(count = links.len(), %run_id, "version links fetched by run");
    Ok(links)
  }

  /// Load enabled SSH host-key pins for one endpoint.
  #[instrument(skip(self), fields(host = %host, port = port))]
  pub async fn list_enabled_ssh_host_keys_for_endpoint(
    &self,
    host: &str,
    port: i32,
  ) -> GitSyncResult<Vec<GitSyncSshHostKey>> {
    let rows = sqlx::query(
      r#"
      SELECT host, port, key_type, fingerprint_sha256, first_seen_at, last_seen_at,
             source, created_by, enabled
      FROM git_sync_ssh_host_keys
      WHERE host = $1 AND port = $2 AND enabled = TRUE
      ORDER BY key_type
      "#,
    )
    .bind(host)
    .bind(port)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_ssh_host_key_row).collect())
  }

  #[instrument(skip(self))]
  pub async fn list_ssh_host_keys(&self) -> GitSyncResult<Vec<GitSyncSshHostKey>> {
    let rows = sqlx::query(
      r#"
      SELECT host, port, key_type, fingerprint_sha256, first_seen_at, last_seen_at,
             source, created_by, enabled
      FROM git_sync_ssh_host_keys
      ORDER BY host, port, key_type
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_ssh_host_key_row).collect())
  }

  /// Persist a newly accepted SSH host key or refresh the last-seen timestamp.
  ///
  /// The upsert intentionally refuses to overwrite an existing fingerprint.
  /// Fingerprint changes must be handled by an explicit disable/delete and a
  /// new first-contact, otherwise `accept_new` would silently become
  /// accept-changed.
  #[instrument(skip(self, key), fields(host = %key.host, port = key.port, key_type = %key.key_type))]
  pub async fn record_ssh_host_key_seen(&self, key: &ObservedSshHostKey) -> GitSyncResult<()> {
    let result = sqlx::query(
      r#"
      INSERT INTO git_sync_ssh_host_keys
        (host, port, key_type, fingerprint_sha256, source, created_by, enabled)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      ON CONFLICT (host, port, key_type)
      DO UPDATE SET last_seen_at = now()
      WHERE git_sync_ssh_host_keys.fingerprint_sha256 = EXCLUDED.fingerprint_sha256
        AND git_sync_ssh_host_keys.enabled = TRUE
      "#,
    )
    .bind(&key.host)
    .bind(key.port)
    .bind(&key.key_type)
    .bind(&key.fingerprint_sha256)
    .bind(&key.source)
    .bind(key.created_by)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    if result.rows_affected() == 0 {
      return Err(GitSyncStoreError::SshHostKeyConflict(format!(
        "fingerprint mismatch or disabled pin for {}:{} {}",
        key.host, key.port, key.key_type
      )));
    }
    Ok(())
  }

  #[instrument(skip(self), fields(host = %host, port = port, key_type = %key_type))]
  pub async fn disable_ssh_host_key(&self, host: &str, port: i32, key_type: &str) -> GitSyncResult<bool> {
    let result = sqlx::query(
      r#"
      UPDATE git_sync_ssh_host_keys
      SET enabled = FALSE, last_seen_at = now()
      WHERE host = $1 AND port = $2 AND key_type = $3 AND enabled = TRUE
      "#,
    )
    .bind(host)
    .bind(port)
    .bind(key_type)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(result.rows_affected() > 0)
  }

  #[instrument(skip(self), fields(host = %host, port = port, key_type = %key_type))]
  pub async fn delete_ssh_host_key(&self, host: &str, port: i32, key_type: &str) -> GitSyncResult<bool> {
    let result = sqlx::query(
      r#"
      DELETE FROM git_sync_ssh_host_keys
      WHERE host = $1 AND port = $2 AND key_type = $3
      "#,
    )
    .bind(host)
    .bind(port)
    .bind(key_type)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(result.rows_affected() > 0)
  }
}

fn map_lifecycle_store_error(error: GitSyncStoreError) -> GitSyncLifecycleStoreError {
  match error {
    GitSyncStoreError::NotFound => GitSyncLifecycleStoreError::NotFound,
    GitSyncStoreError::UnfinishedRunConflict { .. }
    | GitSyncStoreError::SshHostKeyConflict(_)
    | GitSyncStoreError::Validation(_) => GitSyncLifecycleStoreError::Conflict(error.to_string()),
    GitSyncStoreError::Database(error) => GitSyncLifecycleStoreError::Storage(error.to_string()),
    GitSyncStoreError::InvalidEnum { .. } | GitSyncStoreError::CommitOutcomeUnknown { .. } => {
      GitSyncLifecycleStoreError::Storage(error.to_string())
    }
  }
}

#[async_trait::async_trait]
impl GitSyncWebhookStore for SqlxGitSyncStore {
  async fn record_delivery(
    &self,
    profile_id: Uuid,
    delivery: &GitSyncWebhookDelivery,
    accepted: bool,
    run_id: Option<Uuid>,
    rejection_reason: Option<&str>,
  ) -> Result<GitSyncWebhookDeliveryAdmission, GitSyncWebhookStoreError> {
    let inserted_id = sqlx::query_scalar::<_, Uuid>(
      r#"
      INSERT INTO git_sync_webhook_deliveries
        (profile_id, dedupe_key, delivery_id, payload_hash, provider, event_name,
         ref_name, accepted, run_id, rejection_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (profile_id, dedupe_key) DO NOTHING
      RETURNING id
      "#,
    )
    .bind(profile_id)
    .bind(&delivery.dedupe_key)
    .bind(&delivery.delivery_id)
    .bind(&delivery.payload_hash)
    .bind(&delivery.provider)
    .bind(&delivery.event_name)
    .bind(&delivery.ref_name)
    .bind(accepted)
    .bind(run_id)
    .bind(rejection_reason)
    .fetch_optional(&self.pool)
    .await
    .map_err(|error| GitSyncWebhookStoreError::Storage(error.to_string()))?;
    if inserted_id.is_some() {
      return Ok(GitSyncWebhookDeliveryAdmission::Inserted);
    }

    let row = sqlx::query(
      r#"
      SELECT accepted, run_id, rejection_reason
      FROM git_sync_webhook_deliveries
      WHERE profile_id = $1 AND dedupe_key = $2
      "#,
    )
    .bind(profile_id)
    .bind(&delivery.dedupe_key)
    .fetch_one(&self.pool)
    .await
    .map_err(|error| GitSyncWebhookStoreError::Storage(error.to_string()))?;
    Ok(GitSyncWebhookDeliveryAdmission::Duplicate {
      accepted: row.get("accepted"),
      run_id: row.get("run_id"),
      rejection_reason: row.get("rejection_reason"),
    })
  }

  async fn resolve_delivery(
    &self,
    profile_id: Uuid,
    dedupe_key: &str,
    accepted: bool,
    run_id: Option<Uuid>,
    rejection_reason: Option<&str>,
  ) -> Result<(), GitSyncWebhookStoreError> {
    sqlx::query(
      r#"
      UPDATE git_sync_webhook_deliveries
      SET accepted = $3,
          run_id = $4,
          rejection_reason = $5
      WHERE profile_id = $1 AND dedupe_key = $2
      "#,
    )
    .bind(profile_id)
    .bind(dedupe_key)
    .bind(accepted)
    .bind(run_id)
    .bind(rejection_reason)
    .execute(&self.pool)
    .await
    .map_err(|error| GitSyncWebhookStoreError::Storage(error.to_string()))?;
    Ok(())
  }
}

fn scrubbed_rotation_diagnosis(value: &str) -> String {
  value.chars().take(256).collect()
}

fn map_token_rotation_row(row: sqlx::postgres::PgRow) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
  let renew_before_days = row.get::<i32, _>("renew_before_days");
  let requested_lifetime_days = row.get::<i32, _>("requested_lifetime_days");
  Ok(GitTokenRotationStatus {
    profile_id: row.get("profile_id"),
    provider: parse_token_rotation_provider(row.get("provider"))?,
    enabled: row.get("enabled"),
    renew_before_days: u16::try_from(renew_before_days)
      .map_err(|_| GitTokenRotationStoreError::Storage("invalid persisted renew-before interval".into()))?,
    requested_lifetime_days: u16::try_from(requested_lifetime_days)
      .map_err(|_| GitTokenRotationStoreError::Storage("invalid persisted requested lifetime".into()))?,
    state: parse_token_rotation_state(row.get("state"))?,
    latest_attempt_id: row.get("latest_attempt_id"),
    admitted_credential_id: row.get("admitted_credential_id"),
    current_credential_expires_at: row.get("current_credential_expires_at"),
    last_attempt_at: row.get("last_attempt_at"),
    last_success_at: row.get("last_success_at"),
    diagnosis: row.get("diagnosis"),
    created_at: row.get("created_at"),
    updated_at: row.get("updated_at"),
  })
}

const TOKEN_ROTATION_STATUS_COLUMNS: &str = r#"
  rotation.profile_id, rotation.provider, rotation.enabled,
  rotation.renew_before_days, rotation.requested_lifetime_days,
  rotation.state, rotation.latest_attempt_id,
  rotation.admitted_credential_id, rotation.last_attempt_at,
  rotation.last_success_at, rotation.diagnosis,
  rotation.created_at, rotation.updated_at,
  credential.expires_at AS current_credential_expires_at
"#;

fn map_token_rotation_db_error(error: sqlx::Error) -> GitTokenRotationStoreError {
  error!(error = %error, "token rotation persistence failed");
  GitTokenRotationStoreError::Storage(error.to_string())
}

/// Select one eligible consumer without moving an admitted attempt. The active
/// credential owns the rotation row; profile enabled/access state only chooses
/// which dependent can steward its next attempt. Caller locks the full lineage.
async fn rotation_steward_in_transaction(
  tx: &mut PgConnection,
  credential_id: Uuid,
) -> Result<Option<Uuid>, GitTokenRotationStoreError> {
  let old_owner: Uuid = sqlx::query_scalar("SELECT profile_id FROM git_sync_credentials WHERE id = $1 FOR UPDATE")
    .bind(credential_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_token_rotation_db_error)?
    .ok_or(GitTokenRotationStoreError::IncompatibleProfile)?;
  let state = sqlx::query_scalar::<_, String>("SELECT state FROM git_token_rotation WHERE profile_id = $1 FOR UPDATE")
    .bind(old_owner)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_token_rotation_db_error)?;
  if state.as_deref() == Some("Rotating") {
    return Ok(Some(old_owner));
  }
  let eligible: Option<Uuid> = sqlx::query_scalar(
    "SELECT p.id FROM git_sync_profiles p
     JOIN workspaces w ON w.id = p.workspace_id AND w.lifecycle_state = 'active' AND w.deleted_at IS NULL
     JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = p.owner_id AND m.status = 'Accepted'
     WHERE p.credential_id = $1 AND p.enabled AND p.auth_method = 'HttpsToken'
       AND p.repo_url ~* '^https://'
     ORDER BY CASE WHEN p.id = $2 THEN 0 ELSE 1 END, p.id LIMIT 1",
  )
  .bind(credential_id)
  .bind(old_owner)
  .fetch_optional(&mut *tx)
  .await
  .map_err(map_token_rotation_db_error)?;
  if let Some(next_owner) = eligible
    && next_owner != old_owner
  {
    sqlx::query("UPDATE git_token_rotation SET profile_id = $2, updated_at = now() WHERE profile_id = $1")
      .bind(old_owner)
      .bind(next_owner)
      .execute(&mut *tx)
      .await
      .map_err(map_token_rotation_db_error)?;
    sqlx::query("UPDATE git_sync_credentials SET profile_id = $2 WHERE id = $1 AND profile_id = $3")
      .bind(credential_id)
      .bind(next_owner)
      .bind(old_owner)
      .execute(&mut *tx)
      .await
      .map_err(map_token_rotation_db_error)?;
  }
  Ok(eligible)
}

#[async_trait::async_trait]
impl GitTokenRotationStore for SqlxGitSyncStore {
  async fn configure(
    &self,
    requested_profile_id: Uuid,
    configuration: GitTokenRotationConfiguration,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
    configuration
      .validate()
      .map_err(|error| GitTokenRotationStoreError::Storage(error.to_string()))?;
    let mut tx = self.pool.begin().await.map_err(map_token_rotation_db_error)?;
    if !lock_credential_dependents(&mut tx, requested_profile_id)
      .await
      .map_err(map_token_rotation_db_error)?
    {
      return Err(GitTokenRotationStoreError::Conflict);
    }
    let active: Option<Uuid> = sqlx::query_scalar("SELECT credential_id FROM git_sync_profiles WHERE id = $1")
      .bind(requested_profile_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(map_token_rotation_db_error)?
      .ok_or(GitTokenRotationStoreError::NotFound)?;
    let profile_id = if let Some(credential_id) = active {
      if configuration.enabled {
        rotation_steward_in_transaction(&mut tx, credential_id)
          .await?
          .ok_or(GitTokenRotationStoreError::IncompatibleProfile)?
      } else {
        sqlx::query_scalar("SELECT profile_id FROM git_sync_credentials WHERE id = $1")
          .bind(credential_id)
          .fetch_optional(&mut *tx)
          .await
          .map_err(map_token_rotation_db_error)?
          .ok_or(GitTokenRotationStoreError::IncompatibleProfile)?
      }
    } else {
      requested_profile_id
    };
    let profile = sqlx::query(
      "SELECT enabled, repo_url, auth_method, credential_id
       FROM git_sync_profiles WHERE id = $1 FOR UPDATE",
    )
    .bind(profile_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_token_rotation_db_error)?
    .ok_or(GitTokenRotationStoreError::NotFound)?;

    let current_state =
      sqlx::query_scalar::<_, String>("SELECT state FROM git_token_rotation WHERE profile_id = $1 FOR UPDATE")
        .bind(profile_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_token_rotation_db_error)?;
    if current_state.as_deref() == Some("Rotating") {
      return Err(GitTokenRotationStoreError::RotationInProgress);
    }

    if configuration.enabled {
      let credential_id = profile
        .get::<Option<Uuid>, _>("credential_id")
        .ok_or(GitTokenRotationStoreError::IncompatibleProfile)?;
      let compatible = profile.get::<bool, _>("enabled")
        && profile.get::<String, _>("auth_method") == "HttpsToken"
        && is_https_repository(&profile.get::<String, _>("repo_url"));
      let expires = sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
        "SELECT expires_at FROM git_sync_credentials WHERE id = $1",
      )
      .bind(credential_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(map_token_rotation_db_error)?
      .flatten();
      if !compatible || expires.is_none() {
        return Err(GitTokenRotationStoreError::IncompatibleProfile);
      }
    }

    sqlx::query(
      r#"
      INSERT INTO git_token_rotation
        (profile_id, provider, enabled, renew_before_days,
         requested_lifetime_days, state)
      VALUES ($1, $2, $3, $4, $5, 'Configured')
      ON CONFLICT (profile_id) DO UPDATE
      SET provider = EXCLUDED.provider,
          enabled = EXCLUDED.enabled,
          renew_before_days = EXCLUDED.renew_before_days,
          requested_lifetime_days = EXCLUDED.requested_lifetime_days,
          state = CASE
            WHEN git_token_rotation.state = 'ManualIntervention'
              THEN 'ManualIntervention'
            ELSE 'Configured'
          END,
          diagnosis = CASE
            WHEN git_token_rotation.state = 'ManualIntervention'
              THEN git_token_rotation.diagnosis
            ELSE NULL
          END,
          updated_at = now()
      "#,
    )
    .bind(profile_id)
    .bind(configuration.provider.to_string())
    .bind(configuration.enabled)
    .bind(i32::from(configuration.renew_before_days))
    .bind(i32::from(configuration.requested_lifetime_days))
    .execute(&mut *tx)
    .await
    .map_err(map_token_rotation_db_error)?;
    tx.commit().await.map_err(map_token_rotation_db_error)?;
    self
      .status(profile_id)
      .await?
      .ok_or(GitTokenRotationStoreError::NotFound)
  }

  async fn status(&self, profile_id: Uuid) -> Result<Option<GitTokenRotationStatus>, GitTokenRotationStoreError> {
    let query = format!(
      "SELECT {TOKEN_ROTATION_STATUS_COLUMNS}
       FROM git_token_rotation rotation
       JOIN git_sync_profiles profile ON profile.id = rotation.profile_id
       LEFT JOIN git_sync_credentials credential ON credential.id = profile.credential_id
       WHERE rotation.profile_id = COALESCE((
         SELECT c.profile_id FROM git_sync_profiles consumer
         JOIN git_sync_credentials c ON c.id = consumer.credential_id
         WHERE consumer.id = $1
       ), $1)"
    );
    sqlx::query(&query)
      .bind(profile_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(map_token_rotation_db_error)?
      .map(map_token_rotation_row)
      .transpose()
  }

  async fn admit(
    &self,
    requested_profile_id: Uuid,
    now: chrono::DateTime<chrono::Utc>,
    force: bool,
  ) -> Result<Option<GitTokenRotationAdmission>, GitTokenRotationStoreError> {
    self
      .admit_rotation_owned(requested_profile_id, now, force, None, None)
      .await
  }

  async fn admitted(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
  ) -> Result<GitTokenRotationAdmission, GitTokenRotationStoreError> {
    let row = sqlx::query(
      "SELECT profile.workspace_id, profile.repo_url, profile.credential_id,
              rotation.provider, rotation.state, rotation.latest_attempt_id,
              rotation.admitted_credential_id, rotation.requested_lifetime_days,
              rotation.last_attempt_at, credential.label,
              credential.encrypted_data
       FROM git_sync_profiles profile
       JOIN git_token_rotation rotation ON rotation.profile_id = profile.id
        JOIN git_sync_credentials credential
          ON credential.id = rotation.admitted_credential_id
         AND credential.profile_id = profile.id
        JOIN workspaces workspace ON workspace.id = profile.workspace_id
          AND workspace.lifecycle_state = 'active' AND workspace.deleted_at IS NULL
        JOIN workspace_memberships membership ON membership.workspace_id = workspace.id
          AND membership.user_id = profile.owner_id AND membership.status = 'Accepted'
        WHERE profile.id = $1",
    )
    .bind(profile_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(map_token_rotation_db_error)?
    .ok_or(GitTokenRotationStoreError::NotFound)?;
    let credential_id = row
      .get::<Option<Uuid>, _>("credential_id")
      .ok_or(GitTokenRotationStoreError::Conflict)?;
    let admitted_credential_id = row
      .get::<Option<Uuid>, _>("admitted_credential_id")
      .ok_or(GitTokenRotationStoreError::Conflict)?;
    if row.get::<String, _>("state") != "Rotating"
      || row.get::<Option<Uuid>, _>("latest_attempt_id") != Some(attempt_id)
      || credential_id != admitted_credential_id
    {
      return Err(GitTokenRotationStoreError::Conflict);
    }
    let admitted_at = row
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_attempt_at")
      .ok_or(GitTokenRotationStoreError::Conflict)?;
    let requested_lifetime_days = u16::try_from(row.get::<i32, _>("requested_lifetime_days"))
      .map_err(|_| GitTokenRotationStoreError::Storage("invalid persisted requested lifetime".into()))?;
    Ok(GitTokenRotationAdmission {
      profile_id,
      workspace_id: row.get("workspace_id"),
      repository_url: row.get("repo_url"),
      provider: parse_token_rotation_provider(row.get("provider"))?,
      attempt_id,
      credential_id,
      credential_label: row.get("label"),
      encrypted_credential: row.get("encrypted_data"),
      requested_expires_at: requested_expiry(admitted_at, requested_lifetime_days)?,
    })
  }

  async fn record_pre_request_failure(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
    diagnosis: &str,
    now: chrono::DateTime<chrono::Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
    transition_rotating_attempt(
      &self.pool,
      profile_id,
      attempt_id,
      GitTokenRotationState::Failed,
      diagnosis,
      now,
    )
    .await
  }

  async fn record_manual_intervention(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
    diagnosis: &str,
    now: chrono::DateTime<chrono::Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
    transition_rotating_attempt(
      &self.pool,
      profile_id,
      attempt_id,
      GitTokenRotationState::ManualIntervention,
      diagnosis,
      now,
    )
    .await
  }

  async fn install_replacement(
    &self,
    admission: &GitTokenRotationAdmission,
    replacement: &EncryptedGitCredential,
    now: chrono::DateTime<chrono::Utc>,
  ) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
    let mut tx = self.pool.begin().await.map_err(map_token_rotation_db_error)?;
    if !lock_credential_dependents(&mut tx, admission.profile_id)
      .await
      .map_err(map_token_rotation_db_error)?
    {
      return Err(GitTokenRotationStoreError::Conflict);
    }
    let active_credential =
      sqlx::query_scalar::<_, Option<Uuid>>("SELECT credential_id FROM git_sync_profiles WHERE id = $1 FOR UPDATE")
        .bind(admission.profile_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_token_rotation_db_error)?
        .flatten()
        .ok_or(GitTokenRotationStoreError::NotFound)?;
    let admitted = sqlx::query(
      "SELECT state, latest_attempt_id, admitted_credential_id
       FROM git_token_rotation WHERE profile_id = $1 FOR UPDATE",
    )
    .bind(admission.profile_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_token_rotation_db_error)?
    .ok_or(GitTokenRotationStoreError::NotFound)?;
    if admitted.get::<String, _>("state") != "Rotating"
      || admitted.get::<Option<Uuid>, _>("latest_attempt_id") != Some(admission.attempt_id)
      || admitted.get::<Option<Uuid>, _>("admitted_credential_id") != Some(admission.credential_id)
      || active_credential != admission.credential_id
    {
      return Err(GitTokenRotationStoreError::Conflict);
    }

    let replacement_id: Uuid = sqlx::query_scalar(
      "INSERT INTO git_sync_credentials
         (profile_id, auth_method, label, encrypted_data, expires_at)
       VALUES ($1, 'HttpsToken', $2, $3, $4)
       RETURNING id",
    )
    .bind(admission.profile_id)
    .bind(&replacement.label)
    .bind(&replacement.ciphertext)
    .bind(replacement.expires_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_token_rotation_db_error)?;
    let switched =
      sqlx::query("UPDATE git_sync_profiles SET credential_id = $2, updated_at = $3 WHERE credential_id = $1")
        .bind(admission.credential_id)
        .bind(replacement_id)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(map_token_rotation_db_error)?
        .rows_affected();
    if switched == 0 {
      return Err(GitTokenRotationStoreError::Conflict);
    }
    sqlx::query(
      "UPDATE git_token_rotation
       SET state = 'Completed', last_success_at = $3,
           diagnosis = NULL, updated_at = $3
       WHERE profile_id = $1 AND latest_attempt_id = $2",
    )
    .bind(admission.profile_id)
    .bind(admission.attempt_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(map_token_rotation_db_error)?;
    sqlx::query("DELETE FROM git_sync_credentials WHERE id = $1 AND profile_id = $2")
      .bind(admission.credential_id)
      .bind(admission.profile_id)
      .execute(&mut *tx)
      .await
      .map_err(map_token_rotation_db_error)?;
    tx.commit().await.map_err(map_token_rotation_db_error)?;
    self
      .status(admission.profile_id)
      .await?
      .ok_or(GitTokenRotationStoreError::NotFound)
  }

  async fn completion_by_attempt(
    &self,
    profile_id: Uuid,
    attempt_id: Uuid,
  ) -> Result<Option<GitTokenRotationStatus>, GitTokenRotationStoreError> {
    if let Some(status) = self.status(profile_id).await?
      && status.latest_attempt_id == Some(attempt_id)
    {
      return Ok(Some(status));
    }
    let query = format!(
      "SELECT {TOKEN_ROTATION_STATUS_COLUMNS}
       FROM git_token_rotation rotation
       JOIN git_sync_profiles profile ON profile.id = rotation.profile_id
       LEFT JOIN git_sync_credentials credential ON credential.id = profile.credential_id
       WHERE rotation.latest_attempt_id = $1 AND rotation.state = 'Completed'"
    );
    sqlx::query(&query)
      .bind(attempt_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(map_token_rotation_db_error)?
      .map(map_token_rotation_row)
      .transpose()
  }
}

async fn transition_rotating_attempt(
  pool: &PgPool,
  profile_id: Uuid,
  attempt_id: Uuid,
  state: GitTokenRotationState,
  diagnosis: &str,
  now: chrono::DateTime<chrono::Utc>,
) -> Result<GitTokenRotationStatus, GitTokenRotationStoreError> {
  debug_assert!(matches!(
    state,
    GitTokenRotationState::Failed | GitTokenRotationState::ManualIntervention
  ));
  let result = sqlx::query(
    "UPDATE git_token_rotation
     SET state = $3, diagnosis = $4, updated_at = $5
     WHERE profile_id = $1 AND latest_attempt_id = $2 AND state = 'Rotating'",
  )
  .bind(profile_id)
  .bind(attempt_id)
  .bind(state.to_string())
  .bind(scrubbed_rotation_diagnosis(diagnosis))
  .bind(now)
  .execute(pool)
  .await
  .map_err(map_token_rotation_db_error)?;
  if result.rows_affected() != 1 {
    return Err(GitTokenRotationStoreError::Conflict);
  }
  let store = SqlxGitSyncStore::new(pool.clone());
  store
    .status(profile_id)
    .await?
    .ok_or(GitTokenRotationStoreError::NotFound)
}

#[async_trait::async_trait]
impl GitSyncLifecycleStore for SqlxGitSyncStore {
  async fn profile(&self, profile_id: Uuid) -> Result<GitSyncProfile, GitSyncLifecycleStoreError> {
    self.get_profile(profile_id).await.map_err(map_lifecycle_store_error)
  }

  async fn create_profile(
    &self,
    profile: GitSyncProfile,
    credential: EncryptedGitCredential,
  ) -> Result<GitSyncProfile, GitSyncLifecycleStoreError> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
      .bind(profile.workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;

    let existing = sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM git_sync_profiles WHERE workspace_id = $1 ORDER BY created_at LIMIT 1 FOR UPDATE",
    )
    .bind(profile.workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    if existing.is_some() {
      return Err(GitSyncLifecycleStoreError::Conflict(
        "workspace already has a Git-Sync profile; use update".to_string(),
      ));
    }
    Self::admit_profile_scope(&mut tx, &profile)
      .await
      .map_err(map_lifecycle_store_error)?;

    sqlx::query(
      r#"
      INSERT INTO git_sync_profiles
        (id, workspace_id, owner_id, repo_url, branch, root_path,
         sync_direction, trigger_mode, polling_interval_secs, auth_method,
         cron_expression, cron_timezone, cron_misfire_policy,
           credential_id, enabled, max_mirror_storage_mb, manifest_path)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,$15,$16)
      "#,
    )
    .bind(profile.id)
    .bind(profile.workspace_id)
    .bind(profile.owner_id)
    .bind(&profile.repo_url)
    .bind(&profile.branch)
    .bind(&profile.root_path)
    .bind(profile.sync_direction.to_string())
    .bind(profile.trigger_mode.to_string())
    .bind(profile.polling_interval_secs)
    .bind(profile.auth_method.to_string())
    .bind(&profile.cron_expression)
    .bind(&profile.cron_timezone)
    .bind(profile.cron_misfire_policy.map(|value| value.to_string()))
    .bind(profile.enabled)
    .bind(profile.max_mirror_storage_mb)
    .bind(&profile.manifest_path)
    .execute(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;

    let credential_id: Uuid = sqlx::query_scalar(
      r#"
      INSERT INTO git_sync_credentials
        (profile_id, auth_method, label, encrypted_data, expires_at)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id
      "#,
    )
    .bind(profile.id)
    .bind(profile.auth_method.to_string())
    .bind(&credential.label)
    .bind(&credential.ciphertext)
    .bind(credential.expires_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;

    sqlx::query(
      r#"
      UPDATE git_sync_profiles SET credential_id = $2, updated_at = now()
      WHERE id = $1
      "#,
    )
    .bind(profile.id)
    .bind(credential_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    Self::write_schedules_in(&mut tx, None, &profile)
      .await
      .map_err(map_lifecycle_store_error)?;
    let stored = Self::profile_in(&mut tx, profile.id)
      .await
      .map_err(map_lifecycle_store_error)?;
    tx.commit()
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    Ok(stored)
  }

  async fn update_profile(
    &self,
    profile: GitSyncProfile,
    credential: Option<EncryptedGitCredential>,
  ) -> Result<GitSyncProfile, GitSyncLifecycleStoreError> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    let stable = lock_credential_dependents(&mut tx, profile.id)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    if !stable {
      return Err(GitSyncLifecycleStoreError::Conflict(
        "credential changed while locking dependents; retry".into(),
      ));
    }
    let current = Self::locked_profile_in(&mut tx, profile.id)
      .await
      .map_err(map_lifecycle_store_error)?;
    if current.updated_at != profile.updated_at {
      return Err(GitSyncLifecycleStoreError::Conflict(
        "profile changed while the remote probe was running; retry with current values".to_string(),
      ));
    }
    if current.manifest_path != profile.manifest_path {
      return Err(GitSyncLifecycleStoreError::Conflict(
        "Git-Sync manifest address is immutable".to_string(),
      ));
    }
    if current.credential_id != profile.credential_id {
      return Err(GitSyncLifecycleStoreError::Conflict(
        "profile update cannot attach a credential".into(),
      ));
    }
    if current.repo_url != profile.repo_url
      || current.branch != profile.branch
      || current.root_path != profile.root_path
    {
      Self::admit_profile_scope(&mut tx, &profile)
        .await
        .map_err(map_lifecycle_store_error)?;
    }

    let rotation_state = sqlx::query_scalar::<_, String>(
      "SELECT state FROM git_token_rotation WHERE profile_id = COALESCE(
           (SELECT c.profile_id FROM git_sync_credentials c WHERE c.id = $1), $2) FOR UPDATE",
    )
    .bind(current.credential_id)
    .bind(profile.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    if rotation_state.as_deref() == Some("Rotating") {
      return Err(GitSyncLifecycleStoreError::Conflict(
        "profile cannot change while token rotation is active".to_string(),
      ));
    }

    let running = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id = $1 AND status = 'Running')",
    )
    .bind(profile.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    if running {
      return Err(GitSyncLifecycleStoreError::RunningSync);
    }

    let history_capture_was_active = current.enabled && current.trigger_mode == TriggerMode::HistoryCapture;
    let history_capture_will_be_active = profile.enabled && profile.trigger_mode == TriggerMode::HistoryCapture;
    let history_activation_changed = history_capture_was_active != history_capture_will_be_active;

    let cancelled_pending_run_ids: Vec<Uuid> = sqlx::query_scalar(
      r#"
      UPDATE git_sync_runs
      SET status = 'Cancelled', finished_at = now(), commit_after = NULL,
          error_message = 'profile configuration changed before dispatch',
          error_class = NULL, job_id = NULL
      WHERE profile_id = $1 AND status = 'Pending'
      RETURNING id
      "#,
    )
    .bind(profile.id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;

    if history_capture_will_be_active && !cancelled_pending_run_ids.is_empty() {
      sqlx::query(
        "UPDATE git_sync_history_capture_receipts
         SET assigned_run_id = NULL, assigned_at = NULL
         WHERE profile_id = $1 AND discarded_at IS NULL
           AND assigned_run_id = ANY($2)",
      )
      .bind(profile.id)
      .bind(&cancelled_pending_run_ids)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    } else if history_capture_was_active {
      sqlx::query(
        "UPDATE git_sync_history_capture_receipts
         SET discarded_at = now()
         WHERE profile_id = $1 AND discarded_at IS NULL
           AND (assigned_run_id IS NULL OR assigned_run_id = ANY($2))",
      )
      .bind(profile.id)
      .bind(&cancelled_pending_run_ids)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    }

    let replaces_credential = credential.is_some();
    let replacement_has_expiry = credential
      .as_ref()
      .is_some_and(|credential| credential.expires_at.is_some());
    let mut credential_id = current.credential_id;
    if let Some(credential) = credential {
      let new_credential_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO git_sync_credentials
          (profile_id, auth_method, label, encrypted_data, expires_at)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id
        "#,
      )
      .bind(profile.id)
      .bind(profile.auth_method.to_string())
      .bind(&credential.label)
      .bind(&credential.ciphertext)
      .bind(credential.expires_at)
      .fetch_one(&mut *tx)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
      credential_id = Some(new_credential_id);
      if current.credential_id.is_some() {
        rehome_credentials_before_profile_deletion(&mut tx, &[profile.id])
          .await
          .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
      }
    }

    sqlx::query(
      r#"
      UPDATE git_sync_profiles
      SET repo_url = $2, branch = $3, root_path = $4,
          sync_direction = $5, trigger_mode = $6,
          polling_interval_secs = $7, cron_expression = $8,
          cron_timezone = $9, cron_misfire_policy = $10,
          auth_method = $11, credential_id = $12, enabled = $13,
          max_mirror_storage_mb = $14,
          activation_generation = activation_generation + CASE WHEN $15 THEN 1 ELSE 0 END,
          updated_at = now()
      WHERE id = $1
      "#,
    )
    .bind(profile.id)
    .bind(&profile.repo_url)
    .bind(&profile.branch)
    .bind(&profile.root_path)
    .bind(profile.sync_direction.to_string())
    .bind(profile.trigger_mode.to_string())
    .bind(profile.polling_interval_secs)
    .bind(&profile.cron_expression)
    .bind(&profile.cron_timezone)
    .bind(profile.cron_misfire_policy.map(|value| value.to_string()))
    .bind(profile.auth_method.to_string())
    .bind(credential_id)
    .bind(profile.enabled)
    .bind(profile.max_mirror_storage_mb)
    .bind(history_activation_changed)
    .execute(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;

    if let Some(previous_credential_id) = current.credential_id
      && Some(previous_credential_id) != credential_id
    {
      sqlx::query("DELETE FROM git_sync_credentials WHERE id = $1 AND profile_id = $2")
        .bind(previous_credential_id)
        .bind(profile.id)
        .execute(&mut *tx)
        .await
        .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    }
    let active_credential_has_expiry = if replaces_credential {
      replacement_has_expiry
    } else if let Some(credential_id) = credential_id {
      sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM git_sync_credentials WHERE id = $1 AND expires_at IS NOT NULL)",
      )
      .bind(credential_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?
    } else {
      false
    };
    let rotation_compatible = profile.enabled
      && profile.auth_method == AuthMethod::HttpsToken
      && is_https_repository(&profile.repo_url)
      && active_credential_has_expiry;
    let shared_credential: bool = if let Some(credential_id) = current.credential_id {
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_profiles WHERE credential_id = $1 AND id <> $2)")
        .bind(credential_id)
        .bind(profile.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?
    } else {
      false
    };
    if !replaces_credential
      && shared_credential
      && let Some(credential_id) = current.credential_id
    {
      rotation_steward_in_transaction(&mut tx, credential_id)
        .await
        .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    }
    sqlx::query(
      "UPDATE git_token_rotation
       SET enabled = CASE WHEN $2 THEN enabled ELSE false END,
           state = CASE
             WHEN $3 AND state = 'ManualIntervention' THEN 'Configured'
             ELSE state
           END,
           diagnosis = CASE
             WHEN $3 AND state = 'ManualIntervention' THEN NULL
             ELSE diagnosis
           END,
           updated_at = now()
        WHERE profile_id = $1 AND NOT $4",
    )
    .bind(profile.id)
    .bind(rotation_compatible)
    .bind(replaces_credential)
    .bind(shared_credential && !replaces_credential)
    .execute(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    Self::write_schedules_in(&mut tx, Some(&current), &profile)
      .await
      .map_err(map_lifecycle_store_error)?;
    let stored = Self::profile_in(&mut tx, profile.id)
      .await
      .map_err(map_lifecycle_store_error)?;
    tx.commit()
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    Ok(stored)
  }

  async fn delete_impact(&self, profile_id: Uuid) -> Result<GitSyncDeleteImpact, GitSyncLifecycleStoreError> {
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM git_sync_profiles WHERE id = $1)")
      .bind(profile_id)
      .fetch_one(&self.pool)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    if !exists {
      return Err(GitSyncLifecycleStoreError::NotFound);
    }
    let row = sqlx::query(
      r#"
      SELECT
        (SELECT COUNT(*) FROM git_sync_runs WHERE profile_id = $1) AS runs,
        (SELECT COUNT(*) FROM git_sync_bindings WHERE profile_id = $1) AS document_bindings,
        (SELECT COUNT(*) FROM git_sync_file_bindings WHERE profile_id = $1) AS file_bindings,
        (
          (SELECT COUNT(*) FROM git_sync_conflicts WHERE profile_id = $1 AND resolution = 'Open')
          + (SELECT COUNT(*) FROM git_sync_file_conflicts WHERE profile_id = $1 AND resolution = 'Open')
        ) AS open_conflicts,
        (SELECT COUNT(*) FROM git_sync_credentials WHERE profile_id = $1) AS credentials
      "#,
    )
    .bind(profile_id)
    .fetch_one(&self.pool)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    Ok(GitSyncDeleteImpact {
      profile_id,
      runs: row.get("runs"),
      document_bindings: row.get("document_bindings"),
      file_bindings: row.get("file_bindings"),
      open_conflicts: row.get("open_conflicts"),
      credentials: row.get("credentials"),
    })
  }

  async fn delete_profile(&self, profile_id: Uuid) -> Result<(), GitSyncLifecycleStoreError> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    let stable = lock_credential_dependents(&mut tx, profile_id)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    if !stable {
      return Err(GitSyncLifecycleStoreError::Conflict(
        "credential changed while locking dependents; retry".into(),
      ));
    }
    let found = sqlx::query_scalar::<_, Uuid>("SELECT id FROM git_sync_profiles WHERE id = $1 FOR UPDATE")
      .bind(profile_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    if found.is_none() {
      return Err(GitSyncLifecycleStoreError::NotFound);
    }
    let rotating = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(
         SELECT 1 FROM git_token_rotation
         WHERE profile_id = $1 AND state = 'Rotating'
       )",
    )
    .bind(profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    if rotating {
      return Err(GitSyncLifecycleStoreError::Conflict(
        "profile cannot be deleted while token rotation is active".to_string(),
      ));
    }
    let running = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id = $1 AND status = 'Running')",
    )
    .bind(profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    if running {
      return Err(GitSyncLifecycleStoreError::RunningSync);
    }
    rehome_credentials_before_profile_deletion(&mut tx, &[profile_id])
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
      .bind(profile_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    tx.commit()
      .await
      .map_err(|error| GitSyncLifecycleStoreError::Storage(error.to_string()))?;
    Ok(())
  }
}

#[async_trait::async_trait]
impl GitSyncReconciliationStore for SqlxGitSyncStore {
  async fn inventory(
    &self,
    profile_id: Uuid,
  ) -> Result<GitSyncReconciliationInventory, GitSyncReconciliationStoreError> {
    let profile = self
      .get_profile(profile_id)
      .await
      .map_err(map_reconciliation_store_error)?;
    self
      .assert_bound_documents_in_workspace(&profile)
      .await
      .map_err(map_reconciliation_store_error)?;
    self
      .assert_bound_files_in_workspace(&profile)
      .await
      .map_err(map_reconciliation_store_error)?;
    let scope = self
      .writer_scope(&profile)
      .await
      .map_err(map_reconciliation_store_error)?;
    let running = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id = $1 AND status = 'Running')",
    )
    .bind(profile_id)
    .fetch_one(&self.pool)
    .await
    .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
    if running {
      return Err(GitSyncReconciliationStoreError::RunningSync);
    }
    let document_rows = sqlx::query(
      "SELECT id, title, updated_at FROM docs
       WHERE workspace_id = $1 AND deleted_at IS NULL AND is_workspace_root = false
       ORDER BY id",
    )
    .bind(profile.workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
    let documents = document_rows
      .into_iter()
      .map(|row| ReconciliationDocument {
        id: row.get("id"),
        title: row.get("title"),
        updated_at: row.get("updated_at"),
      })
      .collect();
    let bindings = self
      .get_bindings_by_profile(profile_id)
      .await
      .map_err(map_reconciliation_store_error)?;
    for binding in &bindings {
      if scope
        .excludes(&binding.repo_path)
        .map_err(|error| GitSyncReconciliationStoreError::Conflict(error.to_string()))?
      {
        return Err(GitSyncReconciliationStoreError::Conflict(
          "active document binding enters a delegated scope".into(),
        ));
      }
    }
    let tombstoned_binding_rows = sqlx::query(
      r#"
      SELECT id, profile_id, workspace_id, doc_id, sync_id, repo_path,
             last_commit_oid, content_hash, structure_hash, tombstone,
             created_at, updated_at
      FROM git_sync_bindings
      WHERE profile_id = $1 AND tombstone = true
      ORDER BY created_at, id
      "#,
    )
    .bind(profile_id)
    .fetch_all(&self.pool)
    .await
    .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
    let tombstoned_bindings = tombstoned_binding_rows
      .into_iter()
      .map(Self::map_binding_row)
      .collect::<GitSyncResult<Vec<_>>>()
      .map_err(map_reconciliation_store_error)?;
    let tombstoned_bindings = tombstoned_bindings
      .into_iter()
      .filter_map(|binding| match scope.excludes(&binding.repo_path) {
        Ok(false) => Some(Ok(binding)),
        Ok(true) => None,
        Err(error) => Some(Err(GitSyncReconciliationStoreError::Conflict(error.to_string()))),
      })
      .collect::<Result<Vec<_>, _>>()?;
    let baselines = self
      .get_baselines_by_profile(profile_id)
      .await
      .map_err(map_reconciliation_store_error)?;
    let file_bindings = self
      .get_file_bindings_by_profile(profile_id)
      .await
      .map_err(map_reconciliation_store_error)?;
    for binding in &file_bindings {
      if !binding.tombstoned
        && scope
          .excludes(&binding.repo_path)
          .map_err(|error| GitSyncReconciliationStoreError::Conflict(error.to_string()))?
      {
        return Err(GitSyncReconciliationStoreError::Conflict(
          "active file binding enters a delegated scope".into(),
        ));
      }
    }
    let file_bindings = file_bindings
      .into_iter()
      .filter_map(|binding| match scope.excludes(&binding.repo_path) {
        Ok(false) => Some(Ok(binding)),
        Ok(true) => None,
        Err(error) => Some(Err(GitSyncReconciliationStoreError::Conflict(error.to_string()))),
      })
      .collect::<Result<Vec<_>, _>>()?;
    let file_baselines = self
      .get_file_baselines_by_profile(profile_id)
      .await
      .map_err(map_reconciliation_store_error)?;
    let run_rows = sqlx::query(
      r#"
      SELECT id, profile_id, direction, trigger_source, scheduled_for, status, started_at, finished_at,
             commit_before, commit_after, observed_remote_oid,
             reconciliation_required, reconciliation_reason,
             docs_created, docs_updated, docs_deleted, conflicts_found,
             error_message, error_class, job_id
      FROM git_sync_runs WHERE profile_id = $1 ORDER BY started_at, id
      "#,
    )
    .bind(profile_id)
    .fetch_all(&self.pool)
    .await
    .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
    let runs = run_rows
      .into_iter()
      .map(Self::map_run_row)
      .collect::<GitSyncResult<Vec<_>>>()
      .map_err(map_reconciliation_store_error)?;
    let link_rows = sqlx::query(
      r#"
      SELECT id, profile_id, run_id, sync_object_kind, sync_object_id,
             direction, git_commit_oid, myoxus_history_id, repo_path,
             content_hash, created_at
      FROM git_sync_version_links WHERE profile_id = $1 ORDER BY created_at, id
      "#,
    )
    .bind(profile_id)
    .fetch_all(&self.pool)
    .await
    .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
    let version_links = link_rows
      .into_iter()
      .map(|row| GitSyncVersionLink {
        id: row.get("id"),
        profile_id: row.get("profile_id"),
        run_id: row.get("run_id"),
        sync_object_kind: row.get("sync_object_kind"),
        sync_object_id: row.get("sync_object_id"),
        direction: row.get("direction"),
        git_commit_oid: row.get("git_commit_oid"),
        myoxus_history_id: row.get("myoxus_history_id"),
        repo_path: row.get("repo_path"),
        content_hash: row.get("content_hash"),
        created_at: row.get("created_at"),
      })
      .collect::<Vec<_>>();
    let version_links = version_links
      .into_iter()
      .filter_map(|link| match scope.excludes(&link.repo_path) {
        Ok(true) => None,
        Ok(false) => Some(Ok(link)),
        Err(error) => Some(Err(GitSyncReconciliationStoreError::Conflict(error.to_string()))),
      })
      .collect::<Result<Vec<_>, _>>()?;
    Ok(GitSyncReconciliationInventory {
      profile,
      scope,
      documents,
      bindings,
      tombstoned_bindings,
      baselines,
      file_bindings,
      file_baselines,
      runs,
      version_links,
    })
  }

  async fn apply(&self, plan: GitSyncReconciliationPlan) -> Result<(), GitSyncReconciliationStoreError> {
    if !plan.unresolved_remote_documents.is_empty() {
      return Err(GitSyncReconciliationStoreError::Conflict(format!(
        "reconciliation has {} unresolved remote document(s)",
        plan.unresolved_remote_documents.len()
      )));
    }
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
    let profile =
      sqlx::query("SELECT workspace_id, enabled, updated_at FROM git_sync_profiles WHERE id = $1 FOR UPDATE")
        .bind(plan.profile_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?
        .ok_or(GitSyncReconciliationStoreError::NotFound)?;
    if profile.get::<bool, _>("enabled") {
      return Err(GitSyncReconciliationStoreError::ProfileEnabled);
    }
    if profile.get::<chrono::DateTime<chrono::Utc>, _>("updated_at") != plan.profile_updated_at {
      return Err(GitSyncReconciliationStoreError::Conflict(
        "profile changed after the reconciliation inventory was captured".to_string(),
      ));
    }
    let workspace_id = profile.get::<Uuid, _>("workspace_id");
    if plan.report.profile_id != plan.profile_id
      || plan.report.workspace_id != workspace_id
      || plan.report.remote_oid != plan.expected_remote_oid
    {
      return Err(GitSyncReconciliationStoreError::Conflict(
        "reconciliation report does not match the locked profile or remote revision".to_string(),
      ));
    }
    let running = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id = $1 AND status = 'Running')",
    )
    .bind(plan.profile_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
    if running {
      return Err(GitSyncReconciliationStoreError::RunningSync);
    }

    let mut actual_changes = 0_u64;
    for adoption in &plan.binding_adoptions {
      let binding = &adoption.binding;
      if binding.profile_id != plan.profile_id
        || binding.workspace_id != workspace_id
        || binding.tombstone
        || adoption.baseline.binding_id != binding.id
        || binding.last_commit_oid.as_deref() != Some(plan.expected_remote_oid.as_str())
        || adoption.baseline.commit_oid != plan.expected_remote_oid
        || binding.content_hash.as_deref() != Some(adoption.baseline.content_hash.as_str())
      {
        return Err(GitSyncReconciliationStoreError::Conflict(format!(
          "binding adoption {} has inconsistent ownership or revision",
          binding.doc_id
        )));
      }
      let existing = sqlx::query(
        r#"
        SELECT id, workspace_id, doc_id, sync_id, repo_path, last_commit_oid,
               content_hash, structure_hash, tombstone
        FROM git_sync_bindings
        WHERE profile_id = $1
          AND (id = $2 OR doc_id = $3 OR sync_id = $4 OR repo_path = $5)
        ORDER BY id
        "#,
      )
      .bind(plan.profile_id)
      .bind(binding.id)
      .bind(binding.doc_id)
      .bind(binding.sync_id)
      .bind(&binding.repo_path)
      .fetch_all(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      if existing.is_empty() {
        let inserted = sqlx::query(
          r#"
          INSERT INTO git_sync_bindings
            (id, profile_id, workspace_id, doc_id, sync_id, repo_path,
             last_commit_oid, content_hash, structure_hash, tombstone)
          SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, false
          WHERE EXISTS (
            SELECT 1 FROM docs
            WHERE id = $4 AND workspace_id = $3 AND deleted_at IS NULL
              AND is_workspace_root = false
          )
          "#,
        )
        .bind(binding.id)
        .bind(plan.profile_id)
        .bind(binding.workspace_id)
        .bind(binding.doc_id)
        .bind(binding.sync_id)
        .bind(&binding.repo_path)
        .bind(&binding.last_commit_oid)
        .bind(&binding.content_hash)
        .bind(&binding.structure_hash)
        .execute(&mut *tx)
        .await
        .map_err(|error| {
          GitSyncReconciliationStoreError::Conflict(format!("binding adoption {} failed: {error}", binding.doc_id))
        })?;
        if inserted.rows_affected() != 1 {
          return Err(GitSyncReconciliationStoreError::Conflict(format!(
            "document {} is no longer an active workspace document",
            binding.doc_id
          )));
        }
        actual_changes += 1;
      } else if existing.len() != 1
        || existing[0].get::<Uuid, _>("id") != binding.id
        || existing[0].get::<Uuid, _>("workspace_id") != binding.workspace_id
        || existing[0].get::<Uuid, _>("doc_id") != binding.doc_id
        || existing[0].get::<Uuid, _>("sync_id") != binding.sync_id
        || existing[0].get::<String, _>("repo_path") != binding.repo_path
        || existing[0].get::<Option<String>, _>("last_commit_oid") != binding.last_commit_oid
        || existing[0].get::<Option<String>, _>("content_hash") != binding.content_hash
        || existing[0].get::<Option<String>, _>("structure_hash") != binding.structure_hash
        || existing[0].get::<bool, _>("tombstone")
      {
        return Err(GitSyncReconciliationStoreError::Conflict(format!(
          "binding adoption {} conflicts with current binding identity",
          binding.doc_id
        )));
      }

      let baseline = &adoption.baseline;
      let changed = sqlx::query(
        r#"
        INSERT INTO git_sync_baselines
          (binding_id, content_hash, commit_oid, myoxus_updated_at, captured_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (binding_id) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          commit_oid = EXCLUDED.commit_oid,
          myoxus_updated_at = EXCLUDED.myoxus_updated_at,
          captured_at = EXCLUDED.captured_at
        WHERE (git_sync_baselines.content_hash, git_sync_baselines.commit_oid,
               git_sync_baselines.myoxus_updated_at)
          IS DISTINCT FROM
              (EXCLUDED.content_hash, EXCLUDED.commit_oid,
               EXCLUDED.myoxus_updated_at)
        "#,
      )
      .bind(baseline.binding_id)
      .bind(&baseline.content_hash)
      .bind(&baseline.commit_oid)
      .bind(baseline.myoxus_updated_at)
      .bind(baseline.captured_at)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      actual_changes += changed.rows_affected();
    }
    let mut effective_binding_updates = Vec::new();
    for binding in &plan.binding_updates {
      let current = sqlx::query(
        "SELECT repo_path, last_commit_oid, content_hash, structure_hash
         FROM git_sync_bindings WHERE id = $1 AND profile_id = $2",
      )
      .bind(binding.id)
      .bind(plan.profile_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?
      .ok_or_else(|| {
        GitSyncReconciliationStoreError::Conflict(format!("binding {} disappeared during reconciliation", binding.id))
      })?;
      if current.get::<String, _>("repo_path") != binding.repo_path
        || current.get::<Option<String>, _>("last_commit_oid") != binding.last_commit_oid
        || current.get::<Option<String>, _>("content_hash") != binding.content_hash
        || current.get::<Option<String>, _>("structure_hash") != binding.structure_hash
      {
        effective_binding_updates.push(binding);
      }
    }

    // Move every changing binding through a transaction-local unique path.
    // This permits safe path swaps while the cross-kind ownership trigger
    // continues to enforce uniqueness after every row update.
    for binding in &effective_binding_updates {
      let temporary_path = format!(".myoxus-reconcile/{}.pending", binding.id);
      let changed = sqlx::query(
        "UPDATE git_sync_bindings SET repo_path = $3, updated_at = now()
         WHERE id = $1 AND profile_id = $2",
      )
      .bind(binding.id)
      .bind(plan.profile_id)
      .bind(temporary_path)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      if changed.rows_affected() != 1 {
        return Err(GitSyncReconciliationStoreError::Conflict(format!(
          "binding {} disappeared during reconciliation",
          binding.id
        )));
      }
    }
    for binding in &effective_binding_updates {
      let changed = sqlx::query(
        "UPDATE git_sync_bindings
         SET repo_path = $3, last_commit_oid = $4, content_hash = $5,
             structure_hash = $6, updated_at = now()
         WHERE id = $1 AND profile_id = $2",
      )
      .bind(binding.id)
      .bind(plan.profile_id)
      .bind(&binding.repo_path)
      .bind(&binding.last_commit_oid)
      .bind(&binding.content_hash)
      .bind(&binding.structure_hash)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      actual_changes += changed.rows_affected();
    }
    for binding_id in &plan.baseline_deletes {
      let changed = sqlx::query(
        "DELETE FROM git_sync_baselines
         WHERE binding_id = $1
           AND EXISTS (
             SELECT 1 FROM git_sync_bindings b
             WHERE b.id = git_sync_baselines.binding_id AND b.profile_id = $2
           )",
      )
      .bind(binding_id)
      .bind(plan.profile_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      actual_changes += changed.rows_affected();
    }
    for baseline in &plan.baseline_upserts {
      let changed = sqlx::query(
        r#"
        INSERT INTO git_sync_baselines
          (binding_id, content_hash, commit_oid, myoxus_updated_at, captured_at)
        SELECT $1, $2, $3, $4, $5
        WHERE EXISTS (
          SELECT 1 FROM git_sync_bindings WHERE id = $1 AND profile_id = $6
        )
        ON CONFLICT (binding_id) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          commit_oid = EXCLUDED.commit_oid,
          myoxus_updated_at = EXCLUDED.myoxus_updated_at,
          captured_at = EXCLUDED.captured_at
        WHERE (git_sync_baselines.content_hash, git_sync_baselines.commit_oid,
               git_sync_baselines.myoxus_updated_at)
          IS DISTINCT FROM
              (EXCLUDED.content_hash, EXCLUDED.commit_oid,
               EXCLUDED.myoxus_updated_at)
        "#,
      )
      .bind(baseline.binding_id)
      .bind(&baseline.content_hash)
      .bind(&baseline.commit_oid)
      .bind(baseline.myoxus_updated_at)
      .bind(baseline.captured_at)
      .bind(plan.profile_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      actual_changes += changed.rows_affected();
    }
    for baseline in &plan.file_baseline_updates {
      let changed = sqlx::query(
        "UPDATE git_sync_file_baselines SET commit_oid = NULL, synced_at = now()
         WHERE id = $1 AND profile_id = $2 AND commit_oid IS NOT NULL",
      )
      .bind(baseline.id)
      .bind(plan.profile_id)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      actual_changes += changed.rows_affected();
    }
    if !plan.version_link_clear_commits.is_empty() {
      let changed = sqlx::query(
        "UPDATE git_sync_version_links SET git_commit_oid = NULL
         WHERE profile_id = $1 AND id = ANY($2) AND git_commit_oid IS NOT NULL",
      )
      .bind(plan.profile_id)
      .bind(&plan.version_link_clear_commits)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      actual_changes += changed.rows_affected();
    }
    if !plan.completed_reconciliation_runs.is_empty() {
      let valid = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*) FROM git_sync_runs
        WHERE profile_id = $1 AND id = ANY($2)
          AND (
            (
              status = 'Failed' AND reconciliation_required = true
              AND observed_remote_oid = $3
            )
            OR (
              status = 'Completed' AND reconciliation_required = false
              AND observed_remote_oid = $3 AND commit_after = $3
            )
          )
        "#,
      )
      .bind(plan.profile_id)
      .bind(&plan.completed_reconciliation_runs)
      .bind(&plan.expected_remote_oid)
      .fetch_one(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      if valid != plan.completed_reconciliation_runs.len() as i64 {
        return Err(GitSyncReconciliationStoreError::Conflict(
          "reconciliation-required run changed after inventory".to_string(),
        ));
      }
      let changed = sqlx::query(
        r#"
        UPDATE git_sync_runs
        SET status = 'Completed', finished_at = COALESCE(finished_at, now()),
            commit_after = $3, reconciliation_required = false,
            reconciliation_reason = NULL, error_message = NULL, error_class = NULL
        WHERE profile_id = $1 AND id = ANY($2)
          AND status = 'Failed' AND reconciliation_required = true
          AND observed_remote_oid = $3
        "#,
      )
      .bind(plan.profile_id)
      .bind(&plan.completed_reconciliation_runs)
      .bind(&plan.expected_remote_oid)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      actual_changes += changed.rows_affected();
    }
    if actual_changes > 0 {
      let report = serde_json::to_value(&plan.report)
        .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
      sqlx::query(
        r#"
        INSERT INTO admin_audit_log
          (event_key, category, target_type, target_id, target_label,
           new_value, actor_user_id, actor_label, metadata, actor_kind)
        VALUES
          ('git_sync.reconcile.apply', 'workspace', 'git_sync_profile',
           $1, 'Git-Sync profile', $2, NULL, 'myoxus-cli',
           jsonb_build_object('remoteOid', $3, 'changedRows', $4), 'system')
        "#,
      )
      .bind(plan.profile_id.to_string())
      .bind(report)
      .bind(&plan.expected_remote_oid)
      .bind(actual_changes as i64)
      .execute(&mut *tx)
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
    }
    tx.commit()
      .await
      .map_err(|error| GitSyncReconciliationStoreError::Storage(error.to_string()))?;
    Ok(())
  }
}

fn map_reconciliation_store_error(error: GitSyncStoreError) -> GitSyncReconciliationStoreError {
  match error {
    GitSyncStoreError::NotFound => GitSyncReconciliationStoreError::NotFound,
    GitSyncStoreError::Validation(message) => GitSyncReconciliationStoreError::Conflict(message),
    GitSyncStoreError::Database(error) => GitSyncReconciliationStoreError::Storage(error.to_string()),
    other => GitSyncReconciliationStoreError::Storage(other.to_string()),
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_all_sync_directions() {
    assert_eq!(
      parse_sync_direction("Bidirectional").unwrap(),
      SyncDirection::Bidirectional
    );
    assert_eq!(parse_sync_direction("MyoxusToGit").unwrap(), SyncDirection::MyoxusToGit);
    assert_eq!(parse_sync_direction("GitToMyoxus").unwrap(), SyncDirection::GitToMyoxus);
    assert!(parse_sync_direction("Invalid").is_err());
  }

  #[test]
  fn parse_all_trigger_modes() {
    assert_eq!(parse_trigger_mode("Manual").unwrap(), TriggerMode::Manual);
    assert_eq!(parse_trigger_mode("Polling").unwrap(), TriggerMode::Polling);
    assert_eq!(parse_trigger_mode("Webhook").unwrap(), TriggerMode::Webhook);
    assert!(parse_trigger_mode("Invalid").is_err());
  }

  #[test]
  fn parse_all_auth_methods() {
    assert_eq!(parse_auth_method("HttpsToken").unwrap(), AuthMethod::HttpsToken);
    assert_eq!(parse_auth_method("HttpsPassword").unwrap(), AuthMethod::HttpsPassword);
    assert_eq!(parse_auth_method("SshKey").unwrap(), AuthMethod::SshKey);
    assert!(parse_auth_method("Invalid").is_err());
  }

  #[test]
  fn parse_all_run_statuses() {
    assert_eq!(parse_run_status("Pending").unwrap(), RunStatus::Pending);
    assert_eq!(parse_run_status("Running").unwrap(), RunStatus::Running);
    assert_eq!(parse_run_status("Completed").unwrap(), RunStatus::Completed);
    assert_eq!(parse_run_status("Failed").unwrap(), RunStatus::Failed);
    assert_eq!(parse_run_status("Cancelled").unwrap(), RunStatus::Cancelled);
    assert!(parse_run_status("Invalid").is_err());
  }

  #[test]
  fn parse_partial_session_statuses() {
    assert_eq!(
      parse_partial_session_status("Open").unwrap(),
      PartialSessionStatus::Open
    );
    assert_eq!(
      parse_partial_session_status("Completed").unwrap(),
      PartialSessionStatus::Completed
    );
    assert_eq!(
      parse_partial_session_status("CompletedWithFailures").unwrap(),
      PartialSessionStatus::CompletedWithFailures
    );
    assert_eq!(
      parse_partial_session_status("Cancelled").unwrap(),
      PartialSessionStatus::Cancelled
    );
    assert!(parse_partial_session_status("Done").is_err());
  }

  #[test]
  fn parse_partial_item_enums() {
    assert_eq!(parse_partial_item_kind("Doc").unwrap(), PartialItemKind::Doc);
    assert_eq!(
      parse_partial_item_kind("GitMarkdown").unwrap(),
      PartialItemKind::GitMarkdown
    );
    assert!(parse_partial_item_kind("File").is_err());

    assert_eq!(
      parse_partial_item_status("Pending").unwrap(),
      PartialItemStatus::Pending
    );
    assert_eq!(
      parse_partial_item_status("Running").unwrap(),
      PartialItemStatus::Running
    );
    assert_eq!(
      parse_partial_item_status("Completed").unwrap(),
      PartialItemStatus::Completed
    );
    assert_eq!(parse_partial_item_status("Failed").unwrap(), PartialItemStatus::Failed);
    assert_eq!(
      parse_partial_item_status("Conflicted").unwrap(),
      PartialItemStatus::Conflicted
    );
    assert!(parse_partial_item_status("Skipped").is_err());
  }

  #[test]
  fn parse_all_error_classes() {
    assert_eq!(parse_error_class("GitAuth").unwrap(), ErrorClass::GitAuth);
    assert_eq!(parse_error_class("GitNetwork").unwrap(), ErrorClass::GitNetwork);
    assert_eq!(parse_error_class("GitConflict").unwrap(), ErrorClass::GitConflict);
    assert_eq!(parse_error_class("ImportError").unwrap(), ErrorClass::ImportError);
    assert_eq!(parse_error_class("ExportError").unwrap(), ErrorClass::ExportError);
    assert_eq!(parse_error_class("InternalError").unwrap(), ErrorClass::InternalError);
    assert!(parse_error_class("Invalid").is_err());
  }

  #[test]
  fn parse_all_conflict_types() {
    assert_eq!(parse_conflict_type("BothModified").unwrap(), ConflictType::BothModified);
    assert_eq!(
      parse_conflict_type("DeleteVsModify").unwrap(),
      ConflictType::DeleteVsModify
    );
    assert_eq!(
      parse_conflict_type("ModifyVsDelete").unwrap(),
      ConflictType::ModifyVsDelete
    );
    assert_eq!(
      parse_conflict_type("RenameVsRename").unwrap(),
      ConflictType::RenameVsRename
    );
    assert_eq!(
      parse_conflict_type("RenameVsModify").unwrap(),
      ConflictType::RenameVsModify
    );
    assert!(parse_conflict_type("Invalid").is_err());
  }

  #[test]
  fn parse_all_conflict_resolutions() {
    assert_eq!(parse_conflict_resolution("Open").unwrap(), ConflictResolution::Open);
    assert_eq!(
      parse_conflict_resolution("MyoxusWins").unwrap(),
      ConflictResolution::MyoxusWins
    );
    assert_eq!(
      parse_conflict_resolution("GitWins").unwrap(),
      ConflictResolution::GitWins
    );
    assert_eq!(
      parse_conflict_resolution("ManualMerge").unwrap(),
      ConflictResolution::ManualMerge
    );
    assert_eq!(
      parse_conflict_resolution("Dismissed").unwrap(),
      ConflictResolution::Dismissed
    );
    assert!(parse_conflict_resolution("Invalid").is_err());
  }

  #[test]
  fn store_error_display() {
    let err = GitSyncStoreError::NotFound;
    assert_eq!(err.to_string(), "not found");

    let err = GitSyncStoreError::InvalidEnum {
      field: "status".into(),
      value: "Bad".into(),
    };
    assert_eq!(err.to_string(), "invalid enum value: status = Bad");
  }
}
