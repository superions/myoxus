//! `git-sync` subcommand — manage and inspect Git sync profiles, runs, and conflicts.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::{Args, Subcommand};
use myoxus_application::git_sync::bootstrap::{
  BootstrapAttempt, BootstrapAttemptPhase, BootstrapFile, BootstrapPlan, BootstrapReport, BootstrapResumeAction,
  classify_bootstrap_resume, plan_bootstrap,
};
use myoxus_application::git_sync::remote_commit::{CommitTrailers, commit_and_push};
use myoxus_application::git_sync::{
  CreateGitSyncProfile, EncryptedGitCredential, GitAuth, GitRepositoryPort, GitSyncLifecycleError,
  GitSyncLifecycleService, GitSyncProfilePatch, GitSyncReconciliationError, GitSyncReconciliationService,
  GitSyncRepositoryCoordination, GitSyncRepositoryScope, GitTokenRotationConfiguration, GitTokenRotationProviderKind,
  GitTokenRotationService, GitTokenRotationStatus, UpdateGitSyncProfile,
};
use myoxus_application::scheduling::cron::CronSchedule;
use myoxus_domain::git_sync::{AuthMethod, GitSyncRun, RunStatus, SyncDirection, TriggerMode};
use myoxus_domain::scheduling::CronMisfirePolicy;
use myoxus_infrastructure::git_sync::{
  Git2Adapter, GitLabTokenRotationAdapter, GitSyncNativeOwnership, GitSyncStoreError, GitSyncTokenCredentialCodec,
  PgGitSyncRepositoryCoordination, SqlxGitSyncStore,
};
use serde::Serialize;
use sqlx::PgPool;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_output, print_table};
use crate::services::Services;

/// Subcommands for `git-sync`.
#[derive(Subcommand)]
pub enum GitSyncCommand {
  /// List all git-sync profiles, optionally filtered by workspace.
  Profiles(ProfilesArgs),
  /// Show recent sync runs for a profile.
  Status(StatusArgs),
  /// List open (unresolved) conflicts for a profile.
  Conflicts(ConflictsArgs),
  /// Create a profile after an exact read-only remote branch probe.
  Create(CreateArgs),
  /// Partially update a profile after validating the resulting configuration.
  Update(UpdateArgs),
  /// Rotate the encrypted credential without changing profile identity.
  SetCredential(SetCredentialArgs),
  /// Configure and operate automatic provider token rotation.
  TokenRotation(TokenRotationArgs),
  /// Test an exact repository branch with a supplied credential.
  Test(TestArgs),
  /// Preview or apply profile deletion.
  Delete(DeleteArgs),
  /// Inspect or repair persisted state against a verified remote branch.
  Reconcile(ReconcileArgs),
  /// Rebuild disabled profile state from authoritative Myoxus content.
  Bootstrap(BootstrapArgs),
  /// Show the durable schedule state and next occurrences for a profile.
  Schedule(ScheduleArgs),
  /// Validate a schedule and preview server-calculated UTC occurrences.
  SchedulePreview(SchedulePreviewArgs),
  /// Queue a manual sync run for a profile (creates a durable Pending run; the
  /// server's pending dispatcher publishes it).
  Trigger(TriggerArgs),
}

/// Arguments for `git-sync profiles`.
#[derive(Args)]
pub struct ProfilesArgs {
  /// Filter by workspace UUID; if omitted lists profiles for all workspaces.
  #[arg(long)]
  pub workspace: Option<String>,
}

/// Arguments for `git-sync status`.
#[derive(Args)]
pub struct StatusArgs {
  /// UUID of the git-sync profile to inspect.
  pub profile_id: String,
  /// How many recent runs to show (default: 10).
  #[arg(long, default_value = "10")]
  pub limit: i64,
}

/// Arguments for `git-sync conflicts`.
#[derive(Args)]
pub struct ConflictsArgs {
  /// UUID of the git-sync profile to inspect.
  pub profile_id: String,
  /// Include already-resolved conflicts (default: open only).
  #[arg(long)]
  pub all: bool,
}

/// Arguments for `git-sync trigger`.
#[derive(Args)]
pub struct TriggerArgs {
  /// UUID of the git-sync profile to trigger a sync for.
  pub profile_id: String,
  /// Sync direction: Bidirectional, MyoxusToGit, or GitToMyoxus.
  #[arg(long)]
  pub direction: Option<String>,
  /// Wait until the run reaches a terminal status.
  #[arg(long)]
  pub wait: bool,
  /// Maximum seconds to wait for dispatch or terminal completion.
  #[arg(long, default_value_t = 300)]
  pub timeout: u64,
}

#[derive(Args)]
pub struct ScheduleArgs {
  pub profile_id: String,
  #[arg(long, default_value_t = 5)]
  pub count: usize,
}

#[derive(Args)]
pub struct SchedulePreviewArgs {
  #[arg(long)]
  pub cron: String,
  #[arg(long)]
  pub cron_timezone: String,
  #[arg(long, default_value_t = 5)]
  pub count: usize,
}

#[derive(Args)]
pub struct CreateArgs {
  #[arg(long)]
  pub workspace: String,
  /// Owner user UUID. Defaults to the workspace's user owner/creator.
  #[arg(long)]
  pub owner: Option<String>,
  #[arg(long)]
  pub repo_url: String,
  #[arg(long)]
  pub branch: Option<String>,
  #[arg(long, default_value = "content/")]
  pub root_path: String,
  #[arg(long, default_value = "Bidirectional")]
  pub direction: String,
  #[arg(long, default_value = "Manual")]
  pub trigger: String,
  #[arg(long)]
  pub polling_interval_secs: Option<i64>,
  #[arg(long)]
  pub cron: Option<String>,
  #[arg(long)]
  pub cron_timezone: Option<String>,
  #[arg(long, default_value = "Skip")]
  pub cron_misfire_policy: String,
  #[arg(long)]
  pub auth_method: String,
  #[command(flatten)]
  pub credential: CredentialSourceArgs,
  #[arg(long)]
  pub max_mirror_storage_mb: Option<i64>,
}

#[derive(Args)]
pub struct UpdateArgs {
  pub profile_id: String,
  #[arg(long)]
  pub repo_url: Option<String>,
  #[arg(long)]
  pub branch: Option<String>,
  #[arg(long)]
  pub root_path: Option<String>,
  #[arg(long)]
  pub direction: Option<String>,
  #[arg(long)]
  pub trigger: Option<String>,
  #[arg(long, conflicts_with = "clear_polling_interval")]
  pub polling_interval_secs: Option<i64>,
  #[arg(long)]
  pub clear_polling_interval: bool,
  #[arg(long, conflicts_with = "clear_cron")]
  pub cron: Option<String>,
  #[arg(long, conflicts_with = "clear_cron")]
  pub cron_timezone: Option<String>,
  #[arg(long, conflicts_with = "clear_cron")]
  pub cron_misfire_policy: Option<String>,
  #[arg(long)]
  pub clear_cron: bool,
  #[arg(long)]
  pub enabled: Option<bool>,
  #[arg(long, conflicts_with = "clear_max_mirror_storage")]
  pub max_mirror_storage_mb: Option<i64>,
  #[arg(long)]
  pub clear_max_mirror_storage: bool,
  #[arg(long)]
  pub auth_method: Option<String>,
  #[command(flatten)]
  pub credential: OptionalCredentialSourceArgs,
}

#[derive(Args)]
pub struct SetCredentialArgs {
  pub profile_id: String,
  #[arg(long)]
  pub auth_method: String,
  #[command(flatten)]
  pub credential: CredentialSourceArgs,
}

#[derive(Args)]
pub struct TokenRotationArgs {
  #[command(subcommand)]
  pub command: TokenRotationCommand,
}

#[derive(Subcommand)]
pub enum TokenRotationCommand {
  /// Configure the provider and lifecycle intervals for one profile.
  Configure(TokenRotationConfigureArgs),
  /// Show the durable scrubbed rotation state for one profile.
  Status(TokenRotationProfileArgs),
  /// Execute one due-check-bypassing rotation through the shared service.
  RunNow(TokenRotationProfileArgs),
}

#[derive(Args)]
pub struct TokenRotationConfigureArgs {
  pub profile_id: String,
  #[arg(long)]
  pub provider: String,
  #[arg(long, action = clap::ArgAction::Set, required = true)]
  pub enabled: bool,
  #[arg(long)]
  pub renew_before_days: u16,
  #[arg(long)]
  pub requested_lifetime_days: u16,
}

#[derive(Args)]
pub struct TokenRotationProfileArgs {
  pub profile_id: String,
}

#[derive(Args)]
pub struct TestArgs {
  #[arg(long)]
  pub repo_url: String,
  #[arg(long)]
  pub branch: Option<String>,
  #[arg(long)]
  pub auth_method: String,
  #[command(flatten)]
  pub credential: CredentialSourceArgs,
}

#[derive(Args)]
pub struct DeleteArgs {
  pub profile_id: String,
  /// Explicitly preview the cascade impact. This is also the default.
  #[arg(long, conflicts_with = "apply")]
  pub dry_run: bool,
  /// Apply the deletion after reviewing a dry-run.
  #[arg(long)]
  pub apply: bool,
}

#[derive(Args)]
pub struct BootstrapArgs {
  /// Disabled Git-Sync profile UUID.
  pub profile_id: String,
  /// Apply the reviewed plan. Without this flag the command is read-only.
  #[arg(long)]
  pub apply: bool,
  /// Authenticated branch OID reviewed during dry-run. Required with --apply.
  #[arg(long, requires = "apply", conflicts_with = "resume")]
  pub expected_remote_oid: Option<String>,
  /// Resume a durable attempt. Without --apply this only reports its state.
  #[arg(long, conflicts_with = "expected_remote_oid")]
  pub resume: Option<String>,
}

#[derive(Args)]
pub struct ReconcileArgs {
  pub profile_id: String,
  /// Apply the reported database-only repairs. The remote is never written.
  #[arg(long)]
  pub apply: bool,
  /// Remote branch OID copied from the reviewed dry-run report.
  #[arg(long, requires = "apply")]
  pub expected_remote_oid: Option<String>,
}

#[derive(Args)]
pub struct CredentialSourceArgs {
  /// Read credential JSON from a mode-0600 regular file.
  #[arg(long, value_name = "PATH", conflicts_with = "credential_stdin")]
  pub credential_file: Option<PathBuf>,
  /// Read credential JSON from standard input.
  #[arg(long, conflicts_with = "credential_file")]
  pub credential_stdin: bool,
}

#[derive(Args, Default)]
pub struct OptionalCredentialSourceArgs {
  #[arg(long, value_name = "PATH", conflicts_with = "credential_stdin")]
  pub credential_file: Option<PathBuf>,
  #[arg(long, conflicts_with = "credential_file")]
  pub credential_stdin: bool,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// Row shown by `git-sync profiles`.
#[derive(Tabled, Serialize)]
pub struct ProfileRow {
  /// Profile UUID.
  pub id: String,
  /// Workspace UUID.
  pub workspace_id: String,
  /// Remote repository URL.
  pub remote_url: String,
  /// Branch name.
  pub branch: String,
  /// Whether the profile is enabled.
  pub enabled: String,
  /// Trigger mode (Webhook / Polling / Cron / Manual).
  pub trigger_mode: String,
  /// Profile creation time.
  pub created_at: String,
  /// Last sync run status (or "-" if none).
  pub last_run_status: String,
}

/// Row shown by `git-sync status`.
#[derive(Serialize)]
pub struct RunRow {
  /// Run UUID.
  pub id: String,
  /// Sync direction.
  pub direction: String,
  /// Persisted source that admitted this run.
  pub trigger_source: String,
  pub scheduled_for: Option<String>,
  /// Run status.
  pub status: String,
  /// Run start time.
  pub started_at: String,
  /// Run finish time, or null if the run is not terminal.
  pub finished_at: Option<String>,
  /// Number of docs created.
  pub docs_created: i64,
  /// Number of docs updated.
  pub docs_updated: i64,
  /// Number of docs deleted.
  pub docs_deleted: i64,
  /// Number of conflicts found.
  pub conflicts_found: i64,
  /// Open document conflicts visible through the final server status surface.
  pub open_doc_conflicts: i64,
  /// Open file conflicts visible through the final server status surface.
  pub open_file_conflicts: i64,
  /// Active document bindings for this profile.
  pub total_doc_bindings: i64,
  /// Active file bindings for this profile.
  pub total_file_bindings: i64,
  /// Latest partial-sync session ID, or "-" when no partial session exists.
  pub partial_session_id: String,
  /// Latest partial-sync session status, or "-" when no partial session exists.
  pub partial_status: String,
  /// Whether the latest partial session still has pending work.
  pub partial_has_more: bool,
  /// Total items in the latest partial session.
  pub partial_total_items: i64,
  /// Finished items in the latest partial session.
  pub partial_processed_items: i64,
  /// Failed items in the latest partial session.
  pub partial_failed_items: i64,
  /// Scrubbed error message if the run failed.
  pub error: Option<String>,
  pub error_class: Option<String>,
  pub commit_before: Option<String>,
  pub commit_after: Option<String>,
  pub observed_remote_oid: Option<String>,
  pub reconciliation_required: bool,
  pub reconciliation_reason: Option<String>,
  pub job_id: Option<String>,
}

/// Human-readable status projection. JSON uses [`RunRow`] directly so absent
/// operational evidence remains `null` instead of becoming an ambiguous dash.
#[derive(Tabled)]
struct RunTableRow {
  id: String,
  direction: String,
  trigger_source: String,
  scheduled_for: String,
  status: String,
  started_at: String,
  finished_at: String,
  #[tabled(rename = "materialized_created")]
  docs_created: i64,
  #[tabled(rename = "materialized_updated")]
  docs_updated: i64,
  #[tabled(rename = "materialized_deleted")]
  docs_deleted: i64,
  conflicts_found: i64,
  open_doc_conflicts: i64,
  open_file_conflicts: i64,
  total_doc_bindings: i64,
  total_file_bindings: i64,
  partial_session_id: String,
  partial_status: String,
  partial_has_more: bool,
  partial_total_items: i64,
  partial_processed_items: i64,
  partial_failed_items: i64,
  error: String,
  error_class: String,
  commit_before: String,
  commit_after: String,
  observed_remote_oid: String,
  reconciliation_required: bool,
  reconciliation_reason: String,
  job_id: String,
}

/// Row shown by `git-sync conflicts`.
#[derive(Tabled, Serialize)]
pub struct ConflictRow {
  /// Conflict object kind: document or file.
  pub object_kind: String,
  /// Conflict UUID.
  pub id: String,
  /// Repository path of the conflicting file.
  pub repo_path: String,
  /// Document ID, or "-" for file conflicts.
  pub doc_id: String,
  /// File binding ID when the conflict is tied to a blob binding.
  pub binding_id: String,
  /// Blob key when the conflict is tied to a Myoxus blob.
  pub blob_key: String,
  /// Run ID for file conflicts; document conflicts historically do not store it.
  pub run_id: String,
  /// Conflict type (Content / Delete / Binary etc.).
  pub conflict_type: String,
  /// Resolution status.
  pub resolution: String,
  /// When the conflict was created.
  pub created_at: String,
  /// When the conflict was resolved (empty if open).
  pub resolved_at: String,
}

/// Row shown after `git-sync trigger`.
#[derive(Tabled, Serialize)]
pub struct TriggerRow {
  /// Newly created run UUID.
  pub run_id: String,
  /// Profile UUID.
  pub profile_id: String,
  /// Sync direction.
  pub direction: String,
  /// Status of the queued run.
  pub status: String,
  /// Persisted Redis queue job identifier.
  pub job_id: String,
  /// Human-readable note about next steps.
  pub note: String,
}

#[derive(Tabled, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRotationRow {
  pub profile_id: String,
  pub provider: String,
  pub enabled: bool,
  pub state: String,
  pub renew_before_days: u16,
  pub requested_lifetime_days: u16,
  pub current_credential_expires_at: String,
  pub latest_attempt_id: String,
  pub last_attempt_at: String,
  pub last_success_at: String,
  pub diagnosis: String,
}

#[derive(Tabled, Serialize)]
pub struct LifecycleProfileRow {
  pub id: String,
  pub workspace_id: String,
  pub repo_url: String,
  pub branch: String,
  pub root_path: String,
  pub direction: String,
  pub trigger: String,
  pub enabled: bool,
  pub cron_expression: String,
  pub cron_timezone: String,
  pub cron_misfire_policy: String,
  pub next_scheduled_at: String,
  pub pending_misfire_scheduled_for: String,
}

#[derive(Tabled, Serialize)]
pub struct ScheduleOccurrenceRow {
  pub scheduled_at_utc: String,
  pub local_date_time: String,
  pub utc_offset_seconds: i32,
}

#[derive(Tabled, Serialize)]
pub struct ScheduleStatusRow {
  pub profile_id: String,
  pub cron_expression: String,
  pub cron_timezone: String,
  pub misfire_policy: String,
  pub next_scheduled_at: String,
  pub pending_misfire_scheduled_for: String,
  pub preview_utc: String,
}

#[derive(Tabled, Serialize)]
pub struct ConnectionRow {
  pub class: String,
  pub repository: String,
  pub branch: String,
  pub remote_oid: String,
}

#[derive(Tabled, Serialize)]
pub struct DeleteImpactRow {
  pub profile_id: String,
  pub applied: bool,
  pub runs: i64,
  pub document_bindings: i64,
  pub file_bindings: i64,
  pub open_conflicts: i64,
  pub credentials: i64,
}

#[derive(Tabled, Serialize)]
pub struct ReconcileRow {
  pub profile_id: String,
  pub remote_oid: String,
  pub applied: bool,
  pub changes_required: bool,
  pub manifest_documents: usize,
  pub binding_updates: usize,
  pub baseline_upserts: usize,
  pub baseline_deletes: usize,
  pub file_baseline_commit_clears: usize,
  pub version_link_commit_clears: usize,
  pub completed_reconciliation_runs: usize,
  pub binding_adoptions: usize,
  pub unresolved_remote_documents: usize,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `git-sync` subcommand.
pub async fn run(cmd: GitSyncCommand, services: &Services, json: bool) -> anyhow::Result<()> {
  match cmd {
    GitSyncCommand::Profiles(args) => profiles(args, &services.pool, json).await,
    GitSyncCommand::Status(args) => status(args, &services.pool, json).await,
    GitSyncCommand::Conflicts(args) => conflicts(args, &services.pool, json).await,
    GitSyncCommand::Create(args) => create(args, services, json).await,
    GitSyncCommand::Update(args) => update(args, services, json).await,
    GitSyncCommand::SetCredential(args) => set_credential(args, services, json).await,
    GitSyncCommand::TokenRotation(args) => token_rotation(args, services, json).await,
    GitSyncCommand::Test(args) => test_connection(args, services, json).await,
    GitSyncCommand::Delete(args) => delete(args, services, json).await,
    GitSyncCommand::Reconcile(args) => reconcile(args, services, json).await,
    GitSyncCommand::Bootstrap(args) => bootstrap(args, services, json).await,
    GitSyncCommand::Schedule(args) => schedule(args, services, json).await,
    GitSyncCommand::SchedulePreview(args) => schedule_preview(args, json),
    GitSyncCommand::Trigger(args) => trigger(args, services, json).await,
  }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapOutput {
  attempt: Option<BootstrapAttempt>,
  report: BootstrapReport,
  next_action: String,
  backup_command: String,
}

/// Acquire before any profile-specific lease or SQL write. A preview loaded
/// before acquisition is never authority to mutate the repository afterward.
async fn acquire_cli_repository_ownership(
  services: &Services,
  store: &SqlxGitSyncStore,
  profile: &myoxus_domain::git_sync::GitSyncProfile,
) -> anyhow::Result<Arc<GitSyncNativeOwnership>> {
  let scope = GitSyncRepositoryScope::new(&profile.repo_url, &profile.branch)?;
  let guard = PgGitSyncRepositoryCoordination::new(services.pool.clone())
    .acquire(&scope)
    .await?;
  let ownership = GitSyncNativeOwnership::new(guard);
  let fresh = store
    .get_profile(profile.id)
    .await
    .context("re-read profile under repository ownership")?;
  if !scope.matches(&fresh.repo_url, &fresh.branch) || fresh.scope_revision != profile.scope_revision {
    anyhow::bail!("Git-Sync profile scope changed before repository ownership was established");
  }
  store
    .assert_profile_scope_unambiguous(&fresh)
    .await
    .context("check current repository scope")?;
  store
    .assert_bound_documents_in_workspace(&fresh)
    .await
    .context("check bound document ownership")?;
  store
    .assert_bound_files_in_workspace(&fresh)
    .await
    .context("check bound file ownership")?;
  ownership.ensure_owned().await?;
  Ok(ownership)
}

async fn bootstrap(args: BootstrapArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let profile_id = parse_uuid(&args.profile_id, "profile")?;
  let resume_id = args
    .resume
    .as_deref()
    .map(|value| parse_uuid(value, "resume attempt"))
    .transpose()?;
  if args.apply && resume_id.is_none() && args.expected_remote_oid.is_none() {
    anyhow::bail!("--apply requires --expected-remote-oid from the reviewed dry-run");
  }

  let store = SqlxGitSyncStore::new(services.pool.clone());
  if let Some(attempt_id) = resume_id
    && !args.apply
  {
    let attempt = store.get_bootstrap_attempt(attempt_id).await?;
    if attempt.profile_id != profile_id {
      anyhow::bail!("bootstrap attempt does not belong to the requested profile");
    }
    let next_action = match attempt.phase {
      BootstrapAttemptPhase::Prepared => {
        "Re-run with --resume and --apply; remote truth will be authenticated before any action."
      }
      BootstrapAttemptPhase::RemoteApplied => {
        "Re-run with --resume and --apply to complete the guarded SQL finalization."
      }
      BootstrapAttemptPhase::Completed => "No action required; the attempt is complete.",
      BootstrapAttemptPhase::Failed => "Create a new dry-run after resolving the reported pre-push failure.",
    };
    return print_bootstrap_output(
      BootstrapOutput {
        report: attempt.report.clone(),
        attempt: Some(attempt),
        next_action: next_action.into(),
        backup_command: postgres_backup_instruction(),
      },
      json,
    );
  }

  let initial_profile = store.get_profile(profile_id).await.context("load Git-Sync profile")?;
  let ownership = acquire_cli_repository_ownership(services, &store, &initial_profile).await?;
  let profile = store
    .get_profile(profile_id)
    .await
    .context("re-read profile after ownership")?;
  store
    .assert_profile_scope_unambiguous(&profile)
    .await
    .context("bootstrap scope preflight")?;
  if profile.enabled {
    anyhow::bail!("Git-Sync profile must be disabled before bootstrap");
  }
  let runtime = services.git_sync_runtime().await?;
  // Bootstrap is a trusted local recovery operation for an existing disabled
  // profile. Reapplying create/enable policy here would make recovery depend on
  // later policy changes. The transport adapter still enforces the effective
  // TLS, SSH host-key and certificate-host policies below.
  let auth = load_stored_auth(&store, &runtime.crypto_private_key, &profile).await?;
  let repository = Git2Adapter::with_config(
    runtime.network_timeout_secs,
    runtime.local_timeout_secs,
    runtime.clone_depth,
  )
  .with_ssh_host_key_policy(
    services.pool.clone(),
    runtime.ssh_host_key_policy,
    "cli_git_sync_bootstrap",
    None,
  )
  .with_https_certificate_policy(
    runtime.https_certificate_policy,
    runtime.lifecycle_policy.allowed_hosts.clone(),
  );
  repository
    .retain_operation_guard(ownership.clone())
    .await
    .context("retain branch ownership through native bootstrap work")?;
  let observed_oid = repository
    .probe_remote(&profile.repo_url, Some(&profile.branch), &auth)
    .await
    .context("authenticate and inspect bootstrap branch")?
    .observed_remote_oid
    .context("remote branch probe returned no OID")?;

  let temp = tempfile::tempdir().context("create bootstrap worktree")?;
  repository
    .clone_repo_full(&profile.repo_url, temp.path(), &profile.branch, &auth)
    .await
    .context("clone complete bootstrap worktree")?;
  let cloned_oid = repository.head_oid().await.context("read cloned bootstrap HEAD")?;
  if cloned_oid != observed_oid {
    anyhow::bail!(
      "remote branch moved while the bootstrap snapshot was cloned: probed {}, cloned {}",
      observed_oid,
      cloned_oid
    );
  }
  let remote_files = read_worktree(temp.path())?;
  let plan = build_bootstrap_plan(services, &store, &profile, &observed_oid, remote_files).await?;

  if !args.apply {
    return print_bootstrap_output(
      BootstrapOutput {
        report: plan.report,
        attempt: None,
        next_action: format!(
          "Back up PostgreSQL, review every path, then run with --apply --expected-remote-oid {}.",
          observed_oid
        ),
        backup_command: postgres_backup_instruction(),
      },
      json,
    );
  }

  let (attempt, remote_already_applied) = if let Some(attempt_id) = resume_id {
    let attempt = store.get_bootstrap_attempt(attempt_id).await?;
    if attempt.profile_id != profile_id {
      anyhow::bail!("bootstrap attempt does not belong to the requested profile");
    }
    if attempt.desired_tree_fingerprint != plan.report.desired_tree_fingerprint {
      anyhow::bail!("authoritative Myoxus state changed since the bootstrap attempt was prepared");
    }
    match classify_bootstrap_resume(&attempt, &observed_oid, plan.report.no_op) {
      BootstrapResumeAction::AlreadyCompleted => {
        return print_bootstrap_output(
          BootstrapOutput {
            report: attempt.report.clone(),
            attempt: Some(attempt),
            next_action: "No action required; the attempt is complete.".into(),
            backup_command: postgres_backup_instruction(),
          },
          json,
        );
      }
      BootstrapResumeAction::FailedTerminal => anyhow::bail!("failed bootstrap attempts cannot be resumed"),
      BootstrapResumeAction::FinalizeSql => (attempt, true),
      BootstrapResumeAction::Push => (attempt, false),
      BootstrapResumeAction::AdoptObservedRemote => {
        let attempt = store.mark_bootstrap_remote_applied(attempt.id, &observed_oid).await?;
        (attempt, true)
      }
      BootstrapResumeAction::Diverged => {
        anyhow::bail!("remote branch moved to an unrelated tree; bootstrap cannot resume safely")
      }
    }
  } else {
    let expected = args.expected_remote_oid.as_deref().expect("validated above");
    if observed_oid != expected {
      anyhow::bail!(
        "remote branch moved: expected {}, authenticated observation is {}",
        expected,
        observed_oid
      );
    }
    let attempt = store
      .create_bootstrap_attempt(Uuid::new_v4(), profile_id, expected, &plan.report)
      .await?;
    (attempt, false)
  };

  let attempt = if remote_already_applied {
    attempt
  } else if plan.report.no_op {
    store.mark_bootstrap_remote_applied(attempt.id, &observed_oid).await?
  } else {
    ownership
      .ensure_owned()
      .await
      .context("bootstrap branch ownership before push")?;
    let pre_push_oid = repository
      .remote_branch_oid(&profile.branch, &auth)
      .await
      .context("re-probe bootstrap branch immediately before push")?;
    if pre_push_oid != attempt.expected_remote_oid {
      store
        .record_bootstrap_error(
          attempt.id,
          "RemoteMoved",
          "remote branch moved after bootstrap admission and before push",
        )
        .await?;
      anyhow::bail!(
        "remote branch moved after bootstrap admission: expected {}, observed {}",
        attempt.expected_remote_oid,
        pre_push_oid
      );
    }
    if let Err(error) = apply_bootstrap_tree(&repository, &plan).await {
      store
        .record_bootstrap_error(
          attempt.id,
          "WorktreeWrite",
          "planned worktree mutation failed before commit",
        )
        .await?;
      return Err(error);
    }
    let receipt = match commit_and_push(
      &repository,
      &profile,
      &auth,
      "Myoxus Git Sync",
      "git-sync@myoxus.invalid",
      0,
      &CommitTrailers {
        workspace_id: profile.workspace_id,
        run_id: attempt.id,
        profile_id: profile.id,
        direction: "Bootstrap".into(),
        docs_pushed: plan.report.documents as u32,
        docs_pulled: 0,
        files_pushed: plan.report.files as u32,
        files_pulled: 0,
      },
    )
    .await
    {
      Ok(Some(receipt)) => receipt,
      Ok(None) => {
        store
          .record_bootstrap_error(
            attempt.id,
            "InternalError",
            "planned bootstrap changes produced no commit",
          )
          .await?;
        anyhow::bail!("bootstrap plan changed files but produced no commit");
      }
      Err(error) => {
        let class = if matches!(
          error,
          myoxus_application::git_sync::remote_commit::RemoteCommitError::OutcomeUnknown { .. }
        ) {
          "RemoteOutcomeUnknown"
        } else {
          "RemoteCommit"
        };
        store
          .record_bootstrap_error(
            attempt.id,
            class,
            "guarded bootstrap commit/push did not return authenticated success",
          )
          .await?;
        return Err(error).context("guarded bootstrap commit/push");
      }
    };
    ownership
      .ensure_owned()
      .await
      .context("bootstrap branch ownership after authenticated push")?;
    store
      .mark_bootstrap_remote_applied(attempt.id, &receipt.observed_remote_oid)
      .await?
  };
  let remote_oid = attempt
    .observed_remote_oid
    .as_deref()
    .context("remote-applied bootstrap attempt has no observed OID")?;
  let final_plan = build_bootstrap_plan(services, &store, &profile, remote_oid, read_worktree(temp.path())?).await?;
  ownership
    .ensure_owned()
    .await
    .context("bootstrap branch ownership before SQL finalization")?;
  if final_plan.report.desired_tree_fingerprint != attempt.desired_tree_fingerprint || !final_plan.report.no_op {
    store
      .record_bootstrap_error(
        attempt.id,
        "AuthoritativeStateMoved",
        "Myoxus state changed across the remote mutation; resume requires a fresh exact projection",
      )
      .await?;
    anyhow::bail!(
      "authoritative Myoxus state changed during bootstrap; profile remains disabled \
       (prepared fingerprint {}, reloaded fingerprint {}, writes {:?}, deletes {:?})",
      attempt.desired_tree_fingerprint,
      final_plan.report.desired_tree_fingerprint,
      final_plan.report.writes,
      final_plan.report.deletes
    );
  }
  let completed = match store.complete_bootstrap(attempt.id, remote_oid, &final_plan).await {
    Ok(completed) => completed,
    Err(error) => {
      store
        .record_bootstrap_error(
          attempt.id,
          "SqlFinalization",
          "remote is applied but the guarded SQL finalization failed",
        )
        .await?;
      return Err(error).context("finalize bootstrap normal state");
    }
  };

  let verified_oid = repository.remote_branch_oid(&profile.branch, &auth).await?;
  if verified_oid != remote_oid {
    anyhow::bail!("remote branch moved during bootstrap closeout; profile remains disabled");
  }
  let verify_temp = tempfile::tempdir().context("create bootstrap verification worktree")?;
  let verifier = Git2Adapter::with_config(
    runtime.network_timeout_secs,
    runtime.local_timeout_secs,
    runtime.clone_depth,
  )
  .with_ssh_host_key_policy(
    services.pool.clone(),
    runtime.ssh_host_key_policy,
    "cli_git_sync_bootstrap_verify",
    None,
  )
  .with_https_certificate_policy(runtime.https_certificate_policy, runtime.lifecycle_policy.allowed_hosts);
  verifier.retain_operation_guard(ownership.clone()).await?;
  verifier
    .clone_repo_full(&profile.repo_url, verify_temp.path(), &profile.branch, &auth)
    .await?;
  let verify = build_bootstrap_plan(
    services,
    &store,
    &profile,
    remote_oid,
    read_worktree(verify_temp.path())?,
  )
  .await?;
  if !verify.report.no_op {
    anyhow::bail!("post-bootstrap verification produced a non-empty plan; profile remains disabled");
  }
  ownership
    .ensure_owned()
    .await
    .context("bootstrap repository ownership lost before receipt readback")?;

  print_bootstrap_output(
    BootstrapOutput {
      report: verify.report,
      attempt: Some(completed),
      next_action: "Bootstrap completed and independently reloaded as an exact no-op. Profile remains disabled.".into(),
      backup_command: postgres_backup_instruction(),
    },
    json,
  )
}

async fn build_bootstrap_plan(
  services: &Services,
  store: &SqlxGitSyncStore,
  profile: &myoxus_domain::git_sync::GitSyncProfile,
  remote_oid: &str,
  remote_files: BTreeMap<String, Vec<u8>>,
) -> anyhow::Result<BootstrapPlan> {
  let scope = store.writer_scope(profile).await?;
  let prepared = crate::export_docs::prepare_git_export(
    services,
    profile.workspace_id,
    Some(profile.id),
    &profile.root_path,
    &profile.manifest_path,
    &remote_files,
  )
  .await?;
  prepared.ensure_complete()?;

  let document_bindings = store.get_bindings_by_profile(profile.id).await?;
  let file_bindings = store.get_file_bindings_by_profile(profile.id).await?;
  let storage = services.blob_storage()?;
  let mut files = Vec::with_capacity(file_bindings.len());
  for binding in &file_bindings {
    let key = myoxus_application::ports::blob::BlobKey::parse(&binding.blob_key)
      .map_err(anyhow::Error::msg)?
      .storage_key(profile.workspace_id);
    let blob = match storage.read_blob(&key).await {
      Ok(blob) => blob,
      // Preserve the runner's bounded read of deployed pre-publication bindings.
      Err(myoxus_application::ports::PortError::NotFound(_)) => storage.read_blob(&binding.blob_key).await?,
      Err(error) => return Err(error.into()),
    };
    files.push(BootstrapFile {
      binding: binding.clone(),
      bytes: blob.data.to_vec(),
    });
  }
  plan_bootstrap(
    profile,
    &scope,
    remote_oid,
    prepared.documents,
    prepared.manifest.organizer_revision.clone(),
    prepared.manifest.folders.clone(),
    document_bindings,
    file_bindings,
    files,
    remote_files,
    chrono::Utc::now(),
    move |manifest, files| {
      if manifest.documents.iter().any(|doc| {
        !prepared.manifest.documents.iter().any(|expected| {
          expected.doc_id == doc.doc_id
            && expected.repo_path == doc.repo_path
            && expected.content_hash == doc.content_hash
        })
      }) || manifest.documents.len() != prepared.manifest.documents.len()
      {
        return Err("bootstrap ordinary result differs from its shared projection".into());
      }
      for output in prepared.manifest.overview_outputs() {
        files.insert(
          output.repo_path.clone(),
          prepared
            .files
            .get(&output.repo_path)
            .ok_or("missing prepared overview")?
            .clone(),
        );
      }
      // Referenced assets packaged by normal directory export share the same
      // final destinations as bound files; they are projection bytes, not Docs.
      for (path, bytes) in prepared.files {
        if path != profile.manifest_path {
          if let Some(existing) = files.get(&path) {
            if *existing != bytes {
              return Err("bootstrap file differs from shared projection".into());
            }
          } else {
            files.insert(path, bytes);
          }
        }
      }
      *manifest = prepared.manifest;
      Ok(prepared.retired)
    },
  )
  .map_err(anyhow::Error::new)
}

async fn apply_bootstrap_tree(repository: &dyn GitRepositoryPort, plan: &BootstrapPlan) -> anyhow::Result<()> {
  for path in &plan.deletes {
    repository
      .delete_file(path)
      .await
      .with_context(|| format!("delete planned Git-only Markdown {path}"))?;
  }
  for path in &plan.report.writes {
    let bytes = plan
      .desired_files
      .get(path)
      .context("bootstrap write missing from desired tree")?;
    repository
      .write_file(path, bytes)
      .await
      .with_context(|| format!("write bootstrap path {path}"))?;
  }
  Ok(())
}

pub(crate) fn read_worktree(root: &Path) -> anyhow::Result<BTreeMap<String, Vec<u8>>> {
  fn visit(base: &Path, current: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(current)? {
      let entry = entry?;
      let path = entry.path();
      if path.file_name().is_some_and(|name| name == ".git") {
        continue;
      }
      if entry.file_type()?.is_symlink() {
        anyhow::bail!("output tree contains a symlink: {}", path.display());
      }
      if path.is_dir() {
        visit(base, &path, files)?;
      } else if path.is_file() {
        let relative = path
          .strip_prefix(base)?
          .to_string_lossy()
          .replace(std::path::MAIN_SEPARATOR, "/");
        files.insert(relative, std::fs::read(path)?);
      }
    }
    Ok(())
  }
  anyhow::ensure!(
    !std::fs::symlink_metadata(root)?.file_type().is_symlink(),
    "output root is a symlink"
  );
  let mut files = BTreeMap::new();
  visit(root, root, &mut files)?;
  Ok(files)
}

fn postgres_backup_instruction() -> String {
  "myoxus-cli --database-url-file /etc/myoxus/database-url backup create --output ./myoxus-before-git-sync-bootstrap"
    .into()
}

fn print_bootstrap_output(output: BootstrapOutput, json: bool) -> anyhow::Result<()> {
  if json {
    print_json(&output);
  } else {
    println!("Profile: {}", output.report.profile_id);
    println!("Expected remote OID: {}", output.report.expected_remote_oid);
    println!("Documents: {}", output.report.documents);
    println!("Files: {}", output.report.files);
    println!("Writes: {}", output.report.writes.join(", "));
    println!("Deletes: {}", output.report.deletes.join(", "));
    println!("No-op: {}", output.report.no_op);
    if let Some(attempt) = &output.attempt {
      println!("Attempt: {} ({})", attempt.id, attempt.phase.as_str());
    }
    println!("Next action: {}", output.next_action);
    println!("Backup command: {}", output.backup_command);
  }
  Ok(())
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async fn profiles(args: ProfilesArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let rows = sqlx::query(
    r#"
      SELECT
        p.id::text,
        p.workspace_id::text,
        p.repo_url,
        p.branch,
        p.enabled::text,
        p.trigger_mode,
        p.created_at::text,
        COALESCE(r.status, '-') AS last_run_status
      FROM git_sync_profiles p
      LEFT JOIN LATERAL (
        SELECT status FROM git_sync_runs
        WHERE profile_id = p.id
        ORDER BY started_at DESC
        LIMIT 1
      ) r ON true
      WHERE ($1::uuid IS NULL OR p.workspace_id = $1::uuid)
      ORDER BY p.created_at DESC
    "#,
  )
  .bind(args.workspace.as_deref())
  .fetch_all(pool)
  .await?;

  if rows.is_empty() {
    if json {
      print_json(&Vec::<ProfileRow>::new());
    } else {
      println!("No git-sync profiles found.");
    }
    return Ok(());
  }

  let profiles: Vec<ProfileRow> = rows
    .iter()
    .map(|row| {
      use sqlx::Row;
      ProfileRow {
        id: row.get("id"),
        workspace_id: row.get("workspace_id"),
        remote_url: row.get("repo_url"),
        branch: row.get("branch"),
        enabled: row.get("enabled"),
        trigger_mode: row.get("trigger_mode"),
        created_at: row.get("created_at"),
        last_run_status: row.get("last_run_status"),
      }
    })
    .collect();

  print_output(&profiles, json);
  Ok(())
}

async fn status(args: StatusArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  // Validate UUID
  let profile_id: uuid::Uuid = args
    .profile_id
    .parse()
    .map_err(|_| anyhow::anyhow!("Invalid profile UUID: {}", args.profile_id))?;

  let rows = sqlx::query(
    r#"
      WITH counters AS (
        SELECT
          (SELECT COUNT(*) FROM git_sync_conflicts WHERE profile_id = $1 AND resolution = 'Open') AS open_doc_conflicts,
          (SELECT COUNT(*) FROM git_sync_file_conflicts WHERE profile_id = $1 AND resolution = 'Open') AS open_file_conflicts,
          (SELECT COUNT(*) FROM git_sync_bindings WHERE profile_id = $1 AND tombstone = false) AS total_doc_bindings,
          (SELECT COUNT(*) FROM git_sync_file_bindings WHERE profile_id = $1 AND tombstoned = false) AS total_file_bindings
      ),
      latest_partial AS (
        SELECT
          id::text AS partial_session_id,
          status AS partial_status,
          (status = 'Open') AS partial_has_more,
          total_items::bigint AS partial_total_items,
          processed_items::bigint AS partial_processed_items,
          failed_items::bigint AS partial_failed_items
        FROM git_sync_partial_sessions
        WHERE profile_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      )
      SELECT
        r.id::text,
        r.direction,
        r.trigger_source,
        r.scheduled_for::text AS scheduled_for,
        r.status,
        r.started_at::text AS started_at,
        r.finished_at::text AS finished_at,
        COALESCE(r.docs_created, 0)::bigint AS docs_created,
        COALESCE(r.docs_updated, 0)::bigint AS docs_updated,
        COALESCE(r.docs_deleted, 0)::bigint AS docs_deleted,
        COALESCE(r.conflicts_found, 0)::bigint AS conflicts_found,
        counters.open_doc_conflicts::bigint AS open_doc_conflicts,
        counters.open_file_conflicts::bigint AS open_file_conflicts,
        counters.total_doc_bindings::bigint AS total_doc_bindings,
        counters.total_file_bindings::bigint AS total_file_bindings,
        COALESCE(latest_partial.partial_session_id, '') AS partial_session_id,
        COALESCE(latest_partial.partial_status, '') AS partial_status,
        COALESCE(latest_partial.partial_has_more, false) AS partial_has_more,
        COALESCE(latest_partial.partial_total_items, 0)::bigint AS partial_total_items,
        COALESCE(latest_partial.partial_processed_items, 0)::bigint AS partial_processed_items,
        COALESCE(latest_partial.partial_failed_items, 0)::bigint AS partial_failed_items,
        r.error_message
        ,r.error_class
        ,r.commit_before
        ,r.commit_after
        ,r.observed_remote_oid
        ,r.reconciliation_required
        ,r.reconciliation_reason
        ,r.job_id
      FROM git_sync_runs
      r CROSS JOIN counters
      LEFT JOIN latest_partial ON true
      WHERE r.profile_id = $1
      ORDER BY r.started_at DESC
      LIMIT $2
    "#,
  )
  .bind(profile_id)
  .bind(args.limit)
  .fetch_all(pool)
  .await?;

  if rows.is_empty() {
    if json {
      print_json(&Vec::<RunRow>::new());
    } else {
      println!("No sync runs found for profile {}.", args.profile_id);
    }
    return Ok(());
  }

  let run_rows: Vec<RunRow> = rows
    .iter()
    .map(|row| {
      use sqlx::Row;
      RunRow {
        id: row.get("id"),
        direction: row.get("direction"),
        trigger_source: row.get("trigger_source"),
        scheduled_for: row.get("scheduled_for"),
        status: row.get("status"),
        started_at: row.get("started_at"),
        finished_at: row.get("finished_at"),
        docs_created: row.get("docs_created"),
        docs_updated: row.get("docs_updated"),
        docs_deleted: row.get("docs_deleted"),
        conflicts_found: row.get("conflicts_found"),
        open_doc_conflicts: row.get("open_doc_conflicts"),
        open_file_conflicts: row.get("open_file_conflicts"),
        total_doc_bindings: row.get("total_doc_bindings"),
        total_file_bindings: row.get("total_file_bindings"),
        partial_session_id: dash_if_empty(row.get("partial_session_id")),
        partial_status: dash_if_empty(row.get("partial_status")),
        partial_has_more: row.get("partial_has_more"),
        partial_total_items: row.get("partial_total_items"),
        partial_processed_items: row.get("partial_processed_items"),
        partial_failed_items: row.get("partial_failed_items"),
        error: row.get("error_message"),
        error_class: row.get("error_class"),
        commit_before: row.get("commit_before"),
        commit_after: row.get("commit_after"),
        observed_remote_oid: row.get("observed_remote_oid"),
        reconciliation_required: row.get("reconciliation_required"),
        reconciliation_reason: row.get("reconciliation_reason"),
        job_id: row.get("job_id"),
      }
    })
    .collect();

  if json {
    print_json(&run_rows);
  } else {
    let table_rows = run_rows
      .into_iter()
      .map(|row| RunTableRow {
        id: row.id,
        direction: row.direction,
        trigger_source: row.trigger_source,
        scheduled_for: row.scheduled_for.unwrap_or_else(|| "-".to_string()),
        status: row.status,
        started_at: row.started_at,
        finished_at: row.finished_at.unwrap_or_else(|| "-".to_string()),
        docs_created: row.docs_created,
        docs_updated: row.docs_updated,
        docs_deleted: row.docs_deleted,
        conflicts_found: row.conflicts_found,
        open_doc_conflicts: row.open_doc_conflicts,
        open_file_conflicts: row.open_file_conflicts,
        total_doc_bindings: row.total_doc_bindings,
        total_file_bindings: row.total_file_bindings,
        partial_session_id: row.partial_session_id,
        partial_status: row.partial_status,
        partial_has_more: row.partial_has_more,
        partial_total_items: row.partial_total_items,
        partial_processed_items: row.partial_processed_items,
        partial_failed_items: row.partial_failed_items,
        error: row.error.unwrap_or_else(|| "-".to_string()),
        error_class: row.error_class.unwrap_or_else(|| "-".to_string()),
        commit_before: row.commit_before.unwrap_or_else(|| "-".to_string()),
        commit_after: row.commit_after.unwrap_or_else(|| "-".to_string()),
        observed_remote_oid: row.observed_remote_oid.unwrap_or_else(|| "-".to_string()),
        reconciliation_required: row.reconciliation_required,
        reconciliation_reason: row.reconciliation_reason.unwrap_or_else(|| "-".to_string()),
        job_id: row.job_id.unwrap_or_else(|| "-".to_string()),
      })
      .collect::<Vec<_>>();
    print_table(&table_rows);
  }
  Ok(())
}

async fn conflicts(args: ConflictsArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let profile_id: uuid::Uuid = args
    .profile_id
    .parse()
    .map_err(|_| anyhow::anyhow!("Invalid profile UUID: {}", args.profile_id))?;

  let rows = sqlx::query(
    r#"
      SELECT *
      FROM (
        SELECT
          'document'::text AS object_kind,
          id::text,
          repo_path,
          doc_id::text AS doc_id,
          COALESCE(binding_id::text, '') AS binding_id,
          ''::text AS blob_key,
          ''::text AS run_id,
          conflict_type,
          resolution,
          created_at::text AS created_at,
          COALESCE(resolved_at::text, '') AS resolved_at
        FROM git_sync_conflicts
        WHERE profile_id = $1 AND ($2::bool OR resolution = 'Open')
        UNION ALL
        SELECT
          'file'::text AS object_kind,
          id::text,
          repo_path,
          ''::text AS doc_id,
          COALESCE(binding_id::text, '') AS binding_id,
          COALESCE(blob_key, '') AS blob_key,
          run_id::text AS run_id,
          conflict_type,
          resolution,
          created_at::text AS created_at,
          COALESCE(resolved_at::text, '') AS resolved_at
        FROM git_sync_file_conflicts
        WHERE profile_id = $1 AND ($2::bool OR resolution = 'Open')
      ) conflicts
      ORDER BY created_at DESC
    "#,
  )
  .bind(profile_id)
  .bind(args.all)
  .fetch_all(pool)
  .await?;

  if rows.is_empty() {
    if json {
      print_json(&Vec::<ConflictRow>::new());
    } else {
      println!("No conflicts found for profile {}.", args.profile_id);
    }
    return Ok(());
  }

  let conflict_rows: Vec<ConflictRow> = rows
    .iter()
    .map(|row| {
      use sqlx::Row;
      ConflictRow {
        object_kind: row.get("object_kind"),
        id: row.get("id"),
        repo_path: row.get("repo_path"),
        doc_id: dash_if_empty(row.get("doc_id")),
        binding_id: dash_if_empty(row.get("binding_id")),
        blob_key: dash_if_empty(row.get("blob_key")),
        run_id: dash_if_empty(row.get("run_id")),
        conflict_type: row.get("conflict_type"),
        resolution: row.get("resolution"),
        created_at: row.get("created_at"),
        resolved_at: row.get("resolved_at"),
      }
    })
    .collect();

  print_output(&conflict_rows, json);
  Ok(())
}

struct LifecycleContext {
  runtime: crate::services::CliGitSyncRuntime,
  store: Arc<SqlxGitSyncStore>,
  repository: Arc<Git2Adapter>,
  service: GitSyncLifecycleService,
}

async fn lifecycle_context(services: &Services, source: &'static str) -> anyhow::Result<LifecycleContext> {
  let runtime = services.git_sync_runtime().await?;
  let store = Arc::new(SqlxGitSyncStore::new(services.pool.clone()));
  let repository = Arc::new(
    Git2Adapter::with_config(
      runtime.network_timeout_secs,
      runtime.local_timeout_secs,
      runtime.clone_depth,
    )
    .with_ssh_host_key_policy(services.pool.clone(), runtime.ssh_host_key_policy, source, None)
    .with_https_certificate_policy(
      runtime.https_certificate_policy,
      runtime.lifecycle_policy.allowed_hosts.clone(),
    ),
  );
  let service = GitSyncLifecycleService::new(store.clone(), repository.clone());
  Ok(LifecycleContext {
    runtime,
    store,
    repository,
    service,
  })
}

async fn create(args: CreateArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_uuid(&args.workspace, "workspace")?;
  let owner_id = match args.owner {
    Some(owner) => parse_uuid(&owner, "owner")?,
    None => sqlx::query_scalar::<_, Option<Uuid>>(
      "SELECT COALESCE(owner_user_id, created_by_user_id) FROM workspaces WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .fetch_optional(&services.pool)
    .await
    .context("load workspace owner")?
    .flatten()
    .context("workspace has no user owner; provide --owner")?,
  };
  let direction = parse_direction(&args.direction)?;
  let trigger_mode = parse_trigger(&args.trigger)?;
  let auth_method = parse_auth_method(&args.auth_method)?;
  let credential_json = read_required_credential(&args.credential)?;
  let remote_auth = build_auth(auth_method, &credential_json)?;
  let context = lifecycle_context(services, "cli_profile_create").await?;
  let encrypted = encrypt_credential(&credential_json, &context.runtime.crypto_private_key)?;
  let branch = args.branch.unwrap_or_else(|| context.runtime.default_branch.clone());
  let created = context
    .service
    .create(
      &context.runtime.lifecycle_policy,
      CreateGitSyncProfile {
        workspace_id,
        owner_id,
        repo_url: args.repo_url.trim().to_string(),
        branch,
        root_path: normalize_cli_root_path(&args.root_path),
        sync_direction: direction,
        trigger_mode,
        polling_interval_secs: args.polling_interval_secs,
        cron_expression: args.cron,
        cron_timezone: args.cron_timezone,
        cron_misfire_policy: Some(parse_cron_misfire_policy(&args.cron_misfire_policy)?),
        auth_method,
        enabled: true,
        max_mirror_storage_mb: args.max_mirror_storage_mb,
        credential: EncryptedGitCredential {
          label: "default".to_string(),
          ciphertext: encrypted,
          expires_at: credential_expires_at(&credential_json)?,
        },
        remote_auth,
      },
    )
    .await
    .map_err(lifecycle_error)?;
  print_output(&[lifecycle_profile_row(created)], json);
  Ok(())
}

async fn update(args: UpdateArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let profile_id = parse_uuid(&args.profile_id, "profile")?;
  let context = lifecycle_context(services, "cli_profile_update").await?;
  let current = context
    .store
    .get_profile(profile_id)
    .await
    .context("load Git-Sync profile")?;
  let credential_json = read_optional_credential(&args.credential)?;
  let selected_auth_method = args
    .auth_method
    .as_deref()
    .map(parse_auth_method)
    .transpose()?
    .unwrap_or(current.auth_method);
  let (remote_auth, credential) = match credential_json {
    Some(value) => {
      let auth = build_auth(selected_auth_method, &value)?;
      let encrypted = encrypt_credential(&value, &context.runtime.crypto_private_key)?;
      let expires_at = credential_expires_at(&value)?;
      (
        auth,
        Some(EncryptedGitCredential {
          label: "default".to_string(),
          ciphertext: encrypted,
          expires_at,
        }),
      )
    }
    None => (
      load_stored_auth(context.store.as_ref(), &context.runtime.crypto_private_key, &current).await?,
      None,
    ),
  };
  let polling_interval_secs = if args.clear_polling_interval {
    Some(None)
  } else {
    args.polling_interval_secs.map(Some)
  };
  let max_mirror_storage_mb = if args.clear_max_mirror_storage {
    Some(None)
  } else {
    args.max_mirror_storage_mb.map(Some)
  };
  let cron_expression = if args.clear_cron {
    Some(None)
  } else {
    args.cron.map(Some)
  };
  let cron_timezone = if args.clear_cron {
    Some(None)
  } else {
    args.cron_timezone.map(Some)
  };
  let cron_misfire_policy = if args.clear_cron {
    Some(None)
  } else {
    args
      .cron_misfire_policy
      .as_deref()
      .map(parse_cron_misfire_policy)
      .transpose()?
      .map(Some)
  };
  let updated = context
    .service
    .update(
      &context.runtime.lifecycle_policy,
      UpdateGitSyncProfile {
        profile_id,
        patch: GitSyncProfilePatch {
          repo_url: args.repo_url.map(|value| value.trim().to_string()),
          branch: args.branch.map(|value| value.trim().to_string()),
          root_path: args.root_path.map(|value| normalize_cli_root_path(&value)),
          sync_direction: args.direction.as_deref().map(parse_direction).transpose()?,
          trigger_mode: args.trigger.as_deref().map(parse_trigger).transpose()?,
          polling_interval_secs,
          cron_expression,
          cron_timezone,
          cron_misfire_policy,
          auth_method: args.auth_method.as_ref().map(|_| selected_auth_method),
          enabled: args.enabled,
          max_mirror_storage_mb,
        },
        credential,
        remote_auth,
      },
    )
    .await
    .map_err(lifecycle_error)?;
  print_output(&[lifecycle_profile_row(updated)], json);
  Ok(())
}

async fn set_credential(args: SetCredentialArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let profile_id = parse_uuid(&args.profile_id, "profile")?;
  let auth_method = parse_auth_method(&args.auth_method)?;
  let value = read_required_credential(&args.credential)?;
  let remote_auth = build_auth(auth_method, &value)?;
  let context = lifecycle_context(services, "cli_credential_rotation").await?;
  let encrypted = encrypt_credential(&value, &context.runtime.crypto_private_key)?;
  let updated = context
    .service
    .update(
      &context.runtime.lifecycle_policy,
      UpdateGitSyncProfile {
        profile_id,
        patch: GitSyncProfilePatch {
          auth_method: Some(auth_method),
          ..GitSyncProfilePatch::default()
        },
        credential: Some(EncryptedGitCredential {
          label: "default".to_string(),
          ciphertext: encrypted,
          expires_at: credential_expires_at(&value)?,
        }),
        remote_auth,
      },
    )
    .await
    .map_err(lifecycle_error)?;
  print_output(&[lifecycle_profile_row(updated)], json);
  Ok(())
}

async fn token_rotation(args: TokenRotationArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let service = token_rotation_service(services).await?;
  let status = match args.command {
    TokenRotationCommand::Configure(args) => {
      let profile_id = parse_uuid(&args.profile_id, "profile")?;
      let provider = parse_token_rotation_provider(&args.provider)?;
      service
        .configure(
          profile_id,
          GitTokenRotationConfiguration {
            provider,
            enabled: args.enabled,
            renew_before_days: args.renew_before_days,
            requested_lifetime_days: args.requested_lifetime_days,
          },
        )
        .await?
    }
    TokenRotationCommand::Status(args) => {
      let profile_id = parse_uuid(&args.profile_id, "profile")?;
      service
        .status(profile_id)
        .await?
        .with_context(|| format!("token rotation is not configured for profile {profile_id}"))?
    }
    TokenRotationCommand::RunNow(args) => {
      let profile_id = parse_uuid(&args.profile_id, "profile")?;
      service
        .rotate(profile_id, chrono::Utc::now(), true)
        .await?
        .with_context(|| {
          format!("token rotation is disabled or requires manual intervention for profile {profile_id}")
        })?
    }
  };
  print_output(&[token_rotation_row(status)], json);
  Ok(())
}

async fn token_rotation_service(services: &Services) -> anyhow::Result<GitTokenRotationService> {
  let runtime = services.git_sync_runtime().await?;
  let adapter = GitLabTokenRotationAdapter::new(
    Duration::from_secs(runtime.network_timeout_secs),
    runtime.https_ca_bundle.as_ref(),
  )?;
  Ok(GitTokenRotationService::new(
    Arc::new(SqlxGitSyncStore::new(services.pool.clone())),
    Arc::new(GitSyncTokenCredentialCodec::new(runtime.crypto_private_key)),
    vec![Arc::new(adapter)],
  ))
}

fn parse_token_rotation_provider(raw: &str) -> anyhow::Result<GitTokenRotationProviderKind> {
  match raw.trim() {
    "GitLab" | "gitlab" => Ok(GitTokenRotationProviderKind::GitLab),
    other => anyhow::bail!("Invalid token rotation provider '{other}'. Expected GitLab."),
  }
}

fn token_rotation_row(status: GitTokenRotationStatus) -> TokenRotationRow {
  TokenRotationRow {
    profile_id: status.profile_id.to_string(),
    provider: status.provider.to_string(),
    enabled: status.enabled,
    state: status.state.to_string(),
    renew_before_days: status.renew_before_days,
    requested_lifetime_days: status.requested_lifetime_days,
    current_credential_expires_at: status
      .current_credential_expires_at
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".into()),
    latest_attempt_id: status
      .latest_attempt_id
      .map(|value| value.to_string())
      .unwrap_or_else(|| "-".into()),
    last_attempt_at: status
      .last_attempt_at
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".into()),
    last_success_at: status
      .last_success_at
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".into()),
    diagnosis: status.diagnosis.unwrap_or_else(|| "-".into()),
  }
}

async fn test_connection(args: TestArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let auth_method = parse_auth_method(&args.auth_method)?;
  let credential = read_required_credential(&args.credential)?;
  let auth = build_auth(auth_method, &credential)?;
  let context = lifecycle_context(services, "cli_connection_test").await?;
  let branch = args.branch.unwrap_or_else(|| context.runtime.default_branch.clone());
  let probe = context
    .service
    .test_connection(
      &context.runtime.lifecycle_policy,
      &args.repo_url,
      &branch,
      auth_method,
      &auth,
    )
    .await
    .map_err(lifecycle_error)?;
  print_output(
    &[ConnectionRow {
      class: "Success".to_string(),
      repository: args.repo_url,
      branch,
      remote_oid: probe.observed_remote_oid.unwrap_or_default(),
    }],
    json,
  );
  Ok(())
}

async fn delete(args: DeleteArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let profile_id = parse_uuid(&args.profile_id, "profile")?;
  let context = lifecycle_context(services, "cli_profile_delete").await?;
  let applied = args.apply;
  let impact = if applied {
    context.service.delete(profile_id).await
  } else {
    let _explicit_dry_run = args.dry_run;
    context.service.delete_impact(profile_id).await
  }
  .map_err(lifecycle_error)?;
  print_output(
    &[DeleteImpactRow {
      profile_id: impact.profile_id.to_string(),
      applied,
      runs: impact.runs,
      document_bindings: impact.document_bindings,
      file_bindings: impact.file_bindings,
      open_conflicts: impact.open_conflicts,
      credentials: impact.credentials,
    }],
    json,
  );
  Ok(())
}

async fn reconcile(args: ReconcileArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let profile_id = parse_uuid(&args.profile_id, "profile")?;
  let context = lifecycle_context(services, "cli_reconciliation").await?;
  let initial_profile = context
    .store
    .get_profile(profile_id)
    .await
    .context("load Git-Sync profile")?;
  let ownership = acquire_cli_repository_ownership(services, &context.store, &initial_profile).await?;
  context.repository.retain_operation_guard(ownership.clone()).await?;
  let profile = context
    .store
    .get_profile(profile_id)
    .await
    .context("re-read profile after ownership")?;
  context
    .store
    .assert_profile_scope_unambiguous(&profile)
    .await
    .context("reconciliation scope preflight")?;
  let auth = load_stored_auth(context.store.as_ref(), &context.runtime.crypto_private_key, &profile).await?;
  let service = GitSyncReconciliationService::new(context.store.clone(), context.repository.clone());
  let plan = service.inspect(profile_id, &auth).await?;
  ownership
    .ensure_owned()
    .await
    .context("reconciliation branch ownership after inspection")?;
  let report = if args.apply {
    let expected = args
      .expected_remote_oid
      .as_deref()
      .context("--expected-remote-oid is required with --apply")?;
    let unresolved_report = (!plan.unresolved_remote_documents.is_empty()).then(|| plan.report.clone());
    match service.apply(plan, expected, &auth).await {
      Ok(report) => report,
      Err(error @ GitSyncReconciliationError::UnresolvedRemoteDocuments { .. }) => {
        if json {
          print_json(&unresolved_report.expect("unresolved plan must retain its report"));
        }
        return Err(error.into());
      }
      Err(error) => return Err(error.into()),
    }
  } else {
    plan.report
  };
  ownership
    .ensure_owned()
    .await
    .context("reconciliation branch ownership before receipt readback")?;
  if json {
    print_json(&report);
  } else {
    print_table(&[ReconcileRow {
      profile_id: report.profile_id.to_string(),
      remote_oid: report.remote_oid,
      applied: args.apply,
      changes_required: report.changes_required,
      manifest_documents: report.manifest_documents,
      binding_updates: report.binding_updates,
      baseline_upserts: report.baseline_upserts,
      baseline_deletes: report.baseline_deletes,
      file_baseline_commit_clears: report.file_baseline_commit_clears,
      version_link_commit_clears: report.version_link_commit_clears,
      completed_reconciliation_runs: report.completed_reconciliation_runs,
      binding_adoptions: report.binding_adoptions.len(),
      unresolved_remote_documents: report.unresolved_remote_documents.len(),
    }]);
  }
  Ok(())
}

async fn trigger(args: TriggerArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let profile_id: Uuid = args
    .profile_id
    .parse()
    .map_err(|_| anyhow::anyhow!("Invalid profile UUID: {}", args.profile_id))?;

  let store = SqlxGitSyncStore::new(services.pool.clone());
  let profile = store.get_profile(profile_id).await.map_err(|err| match err {
    GitSyncStoreError::NotFound => anyhow::anyhow!("No git-sync profile found with ID: {}", args.profile_id),
    other => anyhow::anyhow!("failed to load git-sync profile: {other}"),
  })?;
  if !profile.enabled {
    anyhow::bail!("Git Sync profile is disabled");
  }

  let direction = args
    .direction
    .as_deref()
    .map(parse_direction)
    .transpose()?
    .unwrap_or(profile.sync_direction);
  if direction != profile.sync_direction {
    anyhow::bail!("manual trigger direction must equal the configured profile direction");
  }
  let runtime = services.git_sync_runtime().await?;
  runtime
    .lifecycle_policy
    .validate_profile(&profile)
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;

  let (run, inserted) = store
    .create_pending_run_if_absent(profile_id, direction, myoxus_domain::git_sync::GitSyncRunSource::Manual)
    .await
    .context("create or select pending git-sync run")?;
  let wait_started = tokio::time::Instant::now();
  let timeout = Duration::from_secs(args.timeout);
  let run = await_dispatch_ack(&store, run.id, timeout).await?;
  let run = if args.wait {
    await_terminal_run(&store, run.id, timeout.saturating_sub(wait_started.elapsed())).await?
  } else {
    run
  };

  let result = vec![TriggerRow {
    run_id: run.id.to_string(),
    profile_id: profile_id.to_string(),
    direction: run.direction.to_string(),
    status: run.status.to_string(),
    job_id: run.job_id.clone().expect("dispatch acknowledgement requires job_id"),
    note: trigger_note(&run, inserted),
  }];

  if json {
    print_json(&result);
  } else {
    print_table(&result);
  }
  Ok(())
}

async fn schedule(args: ScheduleArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let profile_id = parse_uuid(&args.profile_id, "profile")?;
  let profile = SqlxGitSyncStore::new(services.pool.clone())
    .get_profile(profile_id)
    .await
    .context("load Git-Sync profile")?;
  let expression = profile
    .cron_expression
    .as_deref()
    .context("profile is not configured with a Cron expression")?;
  let timezone = profile
    .cron_timezone
    .as_deref()
    .context("profile is not configured with a Cron timezone")?;
  let cron_schedule = CronSchedule::parse(expression, timezone)?;
  let count = validated_preview_count(args.count)?;
  let first = profile.cron_next_scheduled_at.unwrap_or_else(chrono::Utc::now);
  let rows = occurrence_rows(cron_schedule.occurrences_after(first - chrono::Duration::nanoseconds(1), count)?);
  let output = vec![ScheduleStatusRow {
    profile_id: profile.id.to_string(),
    cron_expression: expression.to_string(),
    cron_timezone: timezone.to_string(),
    misfire_policy: profile
      .cron_misfire_policy
      .map(|value| value.to_string())
      .context("Cron profile has no misfire policy")?,
    next_scheduled_at: profile
      .cron_next_scheduled_at
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".into()),
    pending_misfire_scheduled_for: profile
      .cron_pending_misfire_scheduled_for
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".into()),
    preview_utc: rows
      .iter()
      .map(|value| value.scheduled_at_utc.as_str())
      .collect::<Vec<_>>()
      .join(", "),
  }];
  if json {
    print_json(&output);
  } else {
    print_table(&output);
  }
  Ok(())
}

fn schedule_preview(args: SchedulePreviewArgs, json: bool) -> anyhow::Result<()> {
  let schedule = CronSchedule::parse(&args.cron, &args.cron_timezone)?;
  let rows = occurrence_rows(schedule.occurrences_after(chrono::Utc::now(), validated_preview_count(args.count)?)?);
  if json {
    print_json(&rows);
  } else {
    print_table(&rows);
  }
  Ok(())
}

fn occurrence_rows(values: Vec<myoxus_application::scheduling::cron::CronOccurrence>) -> Vec<ScheduleOccurrenceRow> {
  values
    .into_iter()
    .map(|value| ScheduleOccurrenceRow {
      scheduled_at_utc: value.scheduled_at_utc.to_rfc3339(),
      local_date_time: value.local_date_time,
      utc_offset_seconds: value.utc_offset_seconds,
    })
    .collect()
}

fn validated_preview_count(count: usize) -> anyhow::Result<usize> {
  if (1..=100).contains(&count) {
    Ok(count)
  } else {
    anyhow::bail!("count must be between 1 and 100")
  }
}

async fn await_dispatch_ack(store: &SqlxGitSyncStore, run_id: Uuid, timeout: Duration) -> anyhow::Result<GitSyncRun> {
  let deadline = tokio::time::Instant::now() + timeout;
  loop {
    let run = store
      .get_run(run_id)
      .await
      .context("reload Git-Sync run while waiting for dispatcher")?;
    if run.job_id.is_some() {
      return Ok(run);
    }
    if run.status != RunStatus::Pending {
      anyhow::bail!(
        "Git-Sync run {} reached {} without a persisted queue job id",
        run.id,
        run.status
      );
    }
    if tokio::time::Instant::now() >= deadline {
      anyhow::bail!("Git Sync dispatcher did not acknowledge run {run_id}; the Pending intent remains recoverable");
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
  }
}

async fn await_terminal_run(store: &SqlxGitSyncStore, run_id: Uuid, timeout: Duration) -> anyhow::Result<GitSyncRun> {
  let deadline = tokio::time::Instant::now() + timeout;
  loop {
    let run = store
      .get_run(run_id)
      .await
      .context("reload Git-Sync run while waiting for completion")?;
    if matches!(
      run.status,
      RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled
    ) {
      return Ok(run);
    }
    if tokio::time::Instant::now() >= deadline {
      anyhow::bail!(
        "Git-Sync run {run_id} did not reach a terminal state within {} seconds",
        timeout.as_secs()
      );
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
  }
}

fn dash_if_empty(value: String) -> String {
  if value.is_empty() { "-".to_string() } else { value }
}

fn parse_uuid(raw: &str, label: &str) -> anyhow::Result<Uuid> {
  raw.parse().map_err(|_| anyhow::anyhow!("Invalid {label} UUID: {raw}"))
}

fn parse_direction(raw: &str) -> anyhow::Result<SyncDirection> {
  match raw.trim() {
    "Bidirectional" | "bidirectional" => Ok(SyncDirection::Bidirectional),
    "MyoxusToGit" | "myoxus_to_git" | "PushToGit" | "push_to_git" => Ok(SyncDirection::MyoxusToGit),
    "GitToMyoxus" | "git_to_myoxus" | "PullToMyoxus" | "pull_to_myoxus" => Ok(SyncDirection::GitToMyoxus),
    other => anyhow::bail!("Invalid sync direction '{other}'. Expected Bidirectional, MyoxusToGit, or GitToMyoxus."),
  }
}

fn parse_trigger(raw: &str) -> anyhow::Result<TriggerMode> {
  match raw.trim() {
    "Manual" | "manual" => Ok(TriggerMode::Manual),
    "Polling" | "polling" => Ok(TriggerMode::Polling),
    "Webhook" | "webhook" => Ok(TriggerMode::Webhook),
    "Cron" | "cron" => Ok(TriggerMode::Cron),
    "HistoryCapture" | "history-capture" | "history_capture" => Ok(TriggerMode::HistoryCapture),
    other => anyhow::bail!("Invalid trigger mode '{other}'. Expected Manual, Polling, Webhook, or Cron."),
  }
}

fn parse_cron_misfire_policy(raw: &str) -> anyhow::Result<CronMisfirePolicy> {
  match raw.trim() {
    "Skip" | "skip" => Ok(CronMisfirePolicy::Skip),
    "RunOnce" | "run-once" | "run_once" => Ok(CronMisfirePolicy::RunOnce),
    other => anyhow::bail!("Invalid Cron misfire policy '{other}'. Expected Skip or RunOnce."),
  }
}

fn parse_auth_method(raw: &str) -> anyhow::Result<AuthMethod> {
  match raw.trim() {
    "HttpsToken" | "https_token" => Ok(AuthMethod::HttpsToken),
    "HttpsPassword" | "https_password" => Ok(AuthMethod::HttpsPassword),
    "SshKey" | "ssh_key" => Ok(AuthMethod::SshKey),
    other => anyhow::bail!("Invalid authentication method '{other}'. Expected HttpsToken, HttpsPassword, or SshKey."),
  }
}

fn normalize_cli_root_path(value: &str) -> String {
  let mut value = value.trim().to_string();
  if !value.ends_with('/') {
    value.push('/');
  }
  value
}

fn lifecycle_profile_row(profile: myoxus_domain::git_sync::GitSyncProfile) -> LifecycleProfileRow {
  LifecycleProfileRow {
    id: profile.id.to_string(),
    workspace_id: profile.workspace_id.to_string(),
    repo_url: profile.repo_url,
    branch: profile.branch,
    root_path: profile.root_path,
    direction: profile.sync_direction.to_string(),
    trigger: profile.trigger_mode.to_string(),
    enabled: profile.enabled,
    cron_expression: profile.cron_expression.unwrap_or_else(|| "-".into()),
    cron_timezone: profile.cron_timezone.unwrap_or_else(|| "-".into()),
    cron_misfire_policy: profile
      .cron_misfire_policy
      .map(|value| value.to_string())
      .unwrap_or_else(|| "-".into()),
    next_scheduled_at: profile
      .cron_next_scheduled_at
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".into()),
    pending_misfire_scheduled_for: profile
      .cron_pending_misfire_scheduled_for
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".into()),
  }
}

fn lifecycle_error(error: GitSyncLifecycleError) -> anyhow::Error {
  anyhow::anyhow!(error.to_string())
}

fn read_required_credential(source: &CredentialSourceArgs) -> anyhow::Result<serde_json::Value> {
  read_credential(source.credential_file.as_deref(), source.credential_stdin)?
    .context("provide exactly one of --credential-file or --credential-stdin")
}

fn read_optional_credential(source: &OptionalCredentialSourceArgs) -> anyhow::Result<Option<serde_json::Value>> {
  read_credential(source.credential_file.as_deref(), source.credential_stdin)
}

fn read_credential(path: Option<&Path>, from_stdin: bool) -> anyhow::Result<Option<serde_json::Value>> {
  const MAX_CREDENTIAL_BYTES: u64 = 1_048_576;
  let mut bytes = Vec::new();
  match (path, from_stdin) {
    (None, false) => return Ok(None),
    (Some(_), true) => anyhow::bail!("credential file and stdin are mutually exclusive"),
    (Some(path), false) => {
      let metadata = std::fs::metadata(path).context("inspect credential file")?;
      if !metadata.is_file() {
        anyhow::bail!("credential path must be a regular file");
      }
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
          anyhow::bail!("credential file permissions must not grant group or other access (use mode 0600)");
        }
      }
      std::fs::File::open(path)
        .context("open credential file")?
        .take(MAX_CREDENTIAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("read credential file")?;
    }
    (None, true) => {
      std::io::stdin()
        .lock()
        .take(MAX_CREDENTIAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("read credential from stdin")?;
    }
  }
  if bytes.len() as u64 > MAX_CREDENTIAL_BYTES {
    anyhow::bail!("credential input exceeds 1 MiB");
  }
  let value: serde_json::Value = serde_json::from_slice(&bytes).context("credential input must be valid JSON")?;
  if !value.is_object() {
    anyhow::bail!("credential input must be a JSON object");
  }
  Ok(Some(value))
}

fn required_credential_field<'a>(value: &'a serde_json::Value, field: &str) -> anyhow::Result<&'a str> {
  value
    .get(field)
    .and_then(serde_json::Value::as_str)
    .filter(|value| !value.trim().is_empty())
    .with_context(|| format!("credential JSON requires non-empty '{field}'"))
}

fn required_credential_identity<'a>(value: &'a serde_json::Value, field: &str) -> anyhow::Result<&'a str> {
  required_credential_field(value, field).map(str::trim)
}

fn build_auth(auth_method: AuthMethod, value: &serde_json::Value) -> anyhow::Result<GitAuth> {
  match auth_method {
    AuthMethod::HttpsToken => Ok(GitAuth::HttpsToken {
      username: value
        .get("username")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("x-access-token")
        .to_string(),
      token: required_credential_field(value, "token")?.to_string(),
    }),
    AuthMethod::HttpsPassword => Ok(GitAuth::HttpsPassword {
      username: required_credential_identity(value, "username")?.to_string(),
      password: required_credential_field(value, "password")?.to_string(),
    }),
    AuthMethod::SshKey => Ok(GitAuth::SshKey {
      private_key: required_credential_field(value, "privateKey")?.as_bytes().to_vec(),
      passphrase: value
        .get("passphrase")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string),
    }),
  }
}

fn encrypt_credential(value: &serde_json::Value, key: &str) -> anyhow::Result<Vec<u8>> {
  let plaintext = serde_json::to_vec(value).context("serialize credential input")?;
  myoxus_infrastructure::crypto::encrypt(key, &plaintext).context("encrypt credential")
}

fn credential_expires_at(value: &serde_json::Value) -> anyhow::Result<Option<chrono::DateTime<chrono::Utc>>> {
  value
    .get("expiresAt")
    .and_then(serde_json::Value::as_str)
    .map(|raw| {
      chrono::DateTime::parse_from_rfc3339(raw)
        .map(|date| date.with_timezone(&chrono::Utc))
        .context("credential expiresAt must be RFC 3339")
    })
    .transpose()
}

async fn load_stored_auth(
  store: &SqlxGitSyncStore,
  crypto_key: &str,
  profile: &myoxus_domain::git_sync::GitSyncProfile,
) -> anyhow::Result<GitAuth> {
  let credential_id = profile.credential_id.context("Git-Sync profile has no credential")?;
  let encrypted = store
    .get_credential_encrypted_data(credential_id)
    .await
    .context("load encrypted Git-Sync credential")?;
  let plaintext =
    myoxus_infrastructure::crypto::decrypt(crypto_key, &encrypted).context("decrypt Git-Sync credential")?;
  let value: serde_json::Value = serde_json::from_slice(&plaintext).context("decode stored Git-Sync credential")?;
  build_auth(profile.auth_method, &value)
}

fn trigger_note(run: &GitSyncRun, inserted: bool) -> String {
  match (inserted, run.status) {
    (true, RunStatus::Pending) => "Pending run created and acknowledged by the server dispatcher.".to_string(),
    (false, RunStatus::Pending | RunStatus::Running) => {
      "Existing unfinished run reused; no duplicate Pending run was created.".to_string()
    }
    _ => "Run selected.".to_string(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn credential_mapping_preserves_secret_bytes_and_normalizes_identity() {
    let auth = build_auth(
      AuthMethod::HttpsPassword,
      &serde_json::json!({
        "username": "  operator  ",
        "password": " leading-and-trailing ",
      }),
    )
    .unwrap();

    assert!(matches!(
      auth,
      GitAuth::HttpsPassword { username, password }
        if username == "operator" && password == " leading-and-trailing "
    ));
  }

  #[test]
  fn bootstrap_backup_instruction_uses_the_secret_file_cli_contract() {
    let instruction = postgres_backup_instruction();

    assert!(instruction.contains("myoxus-cli --database-url-file /etc/myoxus/database-url backup create"));
    assert!(!instruction.contains("DATABASE_URL"));
    assert!(!instruction.contains("pg_dump"));
  }
}
