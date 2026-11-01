//! `automation` subcommand — Workspace Automation operations and recovery.
//!
//! Commands go through `WorkspaceAutomationService` instead of reading or
//! updating automation tables directly. That keeps CLI diagnostics aligned with
//! the same ACL, audit, retry and queue contracts used by API, workers and MCP.

use anyhow::Result;
use clap::{Args, Subcommand};
use myoxus_domain::ids::{UserId, WorkspaceAutomationRunId, WorkspaceId};
use myoxus_domain::repositories::PageRequest;
use myoxus_domain::workspace_automation::{
  WorkspaceAutomationRun, WorkspaceAutomationRunOrigin, WorkspaceAutomationRunStatus,
};
use serde::Serialize;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_output, print_single};
use crate::services::{Services, default_redis_prefix};

#[derive(Subcommand)]
pub enum AutomationCommand {
  /// Show one run's safe origin, routing and status metadata.
  RunStatus(RunStatusArgs),
  /// Disable an automation definition without deleting audit context.
  Disable(DisableArgs),
  /// Resume a retryable failure using its retained definition and result identities.
  Retry(RetryArgs),
  /// Stop uncommitted effects of one run; already committed work is retained.
  Stop(StopArgs),
  /// List dead-lettered automation runs in one workspace.
  DeadLetterList(DeadLetterListArgs),
}

#[derive(Args)]
pub struct RunStatusArgs {
  pub run_id: WorkspaceAutomationRunId,
  /// User UUID whose workspace read permission is required.
  #[arg(long)]
  pub actor_user_id: UserId,
}

#[derive(Args)]
pub struct DisableArgs {
  pub automation_id: Uuid,
  /// User UUID whose workspace-manager permission is required for disable.
  #[arg(long)]
  pub actor_user_id: UserId,
}

#[derive(Args)]
pub struct RetryArgs {
  pub run_id: WorkspaceAutomationRunId,
  /// Confirmed-request initiator or current workspace manager.
  #[arg(long)]
  pub actor_user_id: UserId,
  /// Redis queue prefix. API default is `myoxus:queue:bull`.
  #[arg(long, default_value_t = default_redis_prefix().to_string())]
  pub redis_prefix: String,
}

#[derive(Args)]
pub struct StopArgs {
  pub run_id: WorkspaceAutomationRunId,
  /// Initiating person or current workspace manager.
  #[arg(long)]
  pub actor_user_id: UserId,
}

#[derive(Args)]
pub struct DeadLetterListArgs {
  #[arg(long)]
  pub workspace_id: WorkspaceId,
  /// User UUID whose workspace read permission is required.
  #[arg(long)]
  pub actor_user_id: UserId,
  #[arg(long, default_value_t = 50)]
  pub limit: i64,
  #[arg(long, default_value_t = 0)]
  pub offset: i64,
}

#[derive(Serialize, Tabled)]
struct RunRow {
  id: String,
  automation_id: String,
  workspace_id: String,
  origin: String,
  request_id: String,
  trigger_type: String,
  status: String,
  attempt_count: i32,
  dead_letter: bool,
  queued_at: String,
  finished_at: String,
  error_code: String,
  error_message: String,
  job_id: String,
  #[tabled(skip)]
  trigger_event: serde_json::Value,
}

#[derive(Serialize, Tabled)]
struct AutomationRow {
  id: String,
  workspace_id: String,
  name: String,
  status: String,
  updated_at: String,
}

pub async fn run(cmd: AutomationCommand, svc: &Services, json: bool) -> Result<()> {
  match cmd {
    AutomationCommand::RunStatus(args) => run_status(args, svc, json).await,
    AutomationCommand::Disable(args) => disable(args, svc, json).await,
    AutomationCommand::Retry(args) => retry(args, svc, json).await,
    AutomationCommand::Stop(args) => stop(args, svc, json).await,
    AutomationCommand::DeadLetterList(args) => dead_letter_list(args, svc, json).await,
  }
}

async fn run_status(args: RunStatusArgs, svc: &Services, json: bool) -> Result<()> {
  let run = svc
    .workspace_automation
    .get_run(args.actor_user_id, args.run_id)
    .await
    .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
  print_single(&run_row(run, None), json);
  Ok(())
}

async fn disable(args: DisableArgs, svc: &Services, json: bool) -> Result<()> {
  let automation = svc
    .workspace_automation
    .disable_automation(args.actor_user_id, args.automation_id)
    .await
    .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
  print_single(
    &AutomationRow {
      id: automation.id.to_string(),
      workspace_id: automation.workspace_id.to_string(),
      name: automation.name,
      status: automation.status.as_str().to_string(),
      updated_at: automation.updated_at.to_rfc3339(),
    },
    json,
  );
  Ok(())
}

async fn retry(args: RetryArgs, svc: &Services, json: bool) -> Result<()> {
  let automation = svc.workspace_automation_with_queue(args.redis_prefix).await?;
  let outcome = automation
    .retry_run(args.actor_user_id, args.run_id)
    .await
    .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
  print_single(&run_row(outcome.run, outcome.job_id), json);
  Ok(())
}

async fn stop(args: StopArgs, svc: &Services, json: bool) -> Result<()> {
  let run = svc
    .workspace_automation
    .stop_run(args.actor_user_id, args.run_id)
    .await
    .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
  print_single(&run_row(run, None), json);
  Ok(())
}

async fn dead_letter_list(args: DeadLetterListArgs, svc: &Services, json: bool) -> Result<()> {
  let runs = svc
    .workspace_automation
    .list_dead_letter_runs(
      args.actor_user_id,
      args.workspace_id,
      PageRequest {
        limit: args.limit.clamp(1, 500),
        offset: args.offset.max(0),
      },
    )
    .await
    .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
  let rows = runs.into_iter().map(|run| run_row(run, None)).collect::<Vec<_>>();
  print_output(&rows, json);
  Ok(())
}

fn run_row(run: WorkspaceAutomationRun, job_id: Option<String>) -> RunRow {
  let (error_code, error_message) = myoxus_application::workspace_automation::safe_error_projection(&run);
  let trigger_event = run
    .trigger_event
    .as_ref()
    .map(|event| {
      serde_json::json!({
        "workspaceId":run.workspace_id,"databaseId":event.database_id,"rowId":event.row_id,
        "triggerType":event.trigger_type,"fieldId":event.field_id,"occurredAt":event.occurred_at
      })
    })
    .unwrap_or(serde_json::Value::Null);
  let (origin, request_id) = match &run.origin {
    WorkspaceAutomationRunOrigin::Rule => ("rule", String::new()),
    WorkspaceAutomationRunOrigin::WorkspaceSetup { request_id, .. } => ("workspace_setup", request_id.to_string()),
    WorkspaceAutomationRunOrigin::ConfirmedContextDocuments { request_id, .. } => {
      ("confirmed_request", request_id.to_string())
    }
    WorkspaceAutomationRunOrigin::TaskMaintenance { request_id, .. } => ("task_maintenance", request_id.to_string()),
    WorkspaceAutomationRunOrigin::TaskHandover { request_id, .. } => ("task_handover", request_id.to_string()),
    WorkspaceAutomationRunOrigin::DocumentReview { request_id, .. } => ("document_review", request_id.to_string()),
  };
  RunRow {
    id: run.id.to_string(),
    automation_id: run.automation_id.map(|id| id.to_string()).unwrap_or_default(),
    origin: origin.into(),
    request_id,
    workspace_id: run.workspace_id.to_string(),
    trigger_type: run
      .trigger_type
      .map(|kind| kind.as_str().to_string())
      .unwrap_or_default(),
    status: status_label(run.status),
    attempt_count: run.attempt_count,
    dead_letter: run.dead_letter,
    queued_at: run.queued_at.to_rfc3339(),
    finished_at: run.finished_at.map(|value| value.to_rfc3339()).unwrap_or_default(),
    error_code: error_code.unwrap_or_default().to_owned(),
    error_message: error_message.unwrap_or_default().to_owned(),
    job_id: job_id.or(run.job_id).unwrap_or_default(),
    trigger_event,
  }
}

fn status_label(status: WorkspaceAutomationRunStatus) -> String {
  status.as_str().to_string()
}
