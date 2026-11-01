//! `graph` subcommand — Document Graph reindex and status diagnostics.
//!
//! The CLI uses the same `DocumentGraphService` as the API/worker runtime.
//! `run-*` commands execute the extraction path directly against PostgreSQL;
//! `enqueue-*` commands require a Redis queue URL so they can create the same
//! BullMQ-compatible jobs as the running API server.

use std::sync::Arc;

use anyhow::{Context, bail};
use clap::{Args, Subcommand};
use myoxus_application::document_graph::{
  DocumentGraphQueue, DocumentGraphReindexOutcome, DocumentGraphService, parse_reindex_reason,
};
use myoxus_application::worker::WorkQueuePort;
use myoxus_domain::document_graph::{DocumentGraphIndexState, DocumentGraphIndexSummary, DocumentGraphReindexReason};
use serde::Serialize;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_output, print_single};
use crate::services::{Services, default_redis_prefix, queue_adapter};

#[derive(Subcommand)]
pub enum GraphCommand {
  /// Enqueue one document for asynchronous Document Graph reindexing.
  EnqueueDoc(GraphDocArgs),
  /// Reindex one document synchronously through the Document Graph service.
  RunDoc(GraphDocArgs),
  /// Enqueue a workspace batch for asynchronous Document Graph reindexing.
  EnqueueWorkspace(GraphWorkspaceArgs),
  /// Reindex a workspace batch synchronously through the Document Graph service.
  RunWorkspaceBatch(GraphWorkspaceArgs),
  /// Show workspace-level and optional document-level Document Graph index status.
  Status(GraphStatusArgs),
}

#[derive(Args, Debug)]
pub struct GraphDocArgs {
  /// Workspace UUID.
  #[arg(long)]
  pub workspace_id: String,
  /// Document UUID.
  #[arg(long)]
  pub doc_id: String,
  /// Reindex reason. Defaults to `manual`.
  #[arg(long, default_value = "manual")]
  pub reason: String,
  /// Redis queue prefix. API default is `myoxus:queue:bull`.
  #[arg(long, default_value_t = default_redis_prefix().to_string())]
  pub redis_prefix: String,
}

#[derive(Args, Debug)]
pub struct GraphWorkspaceArgs {
  /// Workspace UUID.
  #[arg(long)]
  pub workspace_id: String,
  /// Maximum number of source documents to process or enqueue in this batch.
  #[arg(long, default_value_t = 100)]
  pub limit: i64,
  /// Reindex reason. Defaults to `manual`.
  #[arg(long, default_value = "manual")]
  pub reason: String,
  /// Redis queue prefix. API default is `myoxus:queue:bull`.
  #[arg(long, default_value_t = default_redis_prefix().to_string())]
  pub redis_prefix: String,
}

#[derive(Args, Debug)]
pub struct GraphStatusArgs {
  /// Workspace UUID.
  #[arg(long)]
  pub workspace_id: String,
  /// Optional document UUID.
  #[arg(long)]
  pub doc_id: Option<String>,
}

#[derive(Tabled, Serialize)]
pub struct QueueRow {
  pub queue: String,
  pub job_name: String,
  pub job_id: String,
}

#[derive(Tabled, Serialize)]
pub struct OutcomeRow {
  pub workspace_id: String,
  pub requested_count: i64,
  pub reindexed_count: i64,
  pub failed_count: i64,
  pub skipped_count: i64,
}

#[derive(Tabled, Serialize)]
pub struct StatusSummaryRow {
  pub workspace_id: String,
  pub current: i64,
  pub stale: i64,
  pub queued: i64,
  pub extracting: i64,
  pub failed: i64,
  pub deleted: i64,
  pub missing_state: i64,
}

#[derive(Tabled, Serialize)]
pub struct StatusDocRow {
  pub workspace_id: String,
  pub doc_id: String,
  pub stale_state: String,
  pub occurrence_count: i32,
  pub attempt_count: i32,
  pub indexed_at: String,
  pub queued_at: String,
  pub started_at: String,
  pub failed_at: String,
  pub error_code: String,
  pub error_message: String,
}

pub async fn run(cmd: GraphCommand, svc: &Services, json: bool) -> anyhow::Result<()> {
  match cmd {
    GraphCommand::EnqueueDoc(args) => enqueue_doc(args, svc, json).await,
    GraphCommand::RunDoc(args) => run_doc(args, svc, json).await,
    GraphCommand::EnqueueWorkspace(args) => enqueue_workspace(args, svc, json).await,
    GraphCommand::RunWorkspaceBatch(args) => run_workspace_batch(args, svc, json).await,
    GraphCommand::Status(args) => status(args, svc, json).await,
  }
}

async fn enqueue_doc(args: GraphDocArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_uuid(&args.workspace_id, "workspace-id")?;
  let doc_id = parse_uuid(&args.doc_id, "doc-id")?;
  let reason = parse_reason(&args.reason)?;
  let graph = build_graph_service(svc, queue_adapter(args.redis_prefix, svc.additional_ca.as_ref()).await?);
  let queued = graph
    .enqueue_document_reindex(workspace_id, doc_id, reason)
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;
  print_queue(queued, json);
  Ok(())
}

async fn run_doc(args: GraphDocArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_uuid(&args.workspace_id, "workspace-id")?;
  let doc_id = parse_uuid(&args.doc_id, "doc-id")?;
  let outcome = svc
    .document_graph
    .reindex_document_now(workspace_id, doc_id)
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;
  print_outcome(outcome, json);
  Ok(())
}

async fn enqueue_workspace(args: GraphWorkspaceArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_uuid(&args.workspace_id, "workspace-id")?;
  let reason = parse_reason(&args.reason)?;
  let Some(queue) = queue_adapter(args.redis_prefix, svc.additional_ca.as_ref()).await? else {
    bail!("graph enqueue-workspace requires REDIS_URL or MYOXUS__REDIS__URL");
  };
  let graph = build_graph_service(svc, Some(queue));
  let queued = graph
    .enqueue_workspace_reindex(workspace_id, args.limit, reason)
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;
  print_queue(queued, json);
  Ok(())
}

async fn run_workspace_batch(args: GraphWorkspaceArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_uuid(&args.workspace_id, "workspace-id")?;
  let outcome = svc
    .document_graph
    .reindex_workspace_batch_now(workspace_id, args.limit)
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;
  print_outcome(outcome, json);
  Ok(())
}

async fn status(args: GraphStatusArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_uuid(&args.workspace_id, "workspace-id")?;
  let doc_id = args
    .doc_id
    .as_deref()
    .map(|value| parse_uuid(value, "doc-id"))
    .transpose()?;
  let (summary, state) = svc
    .document_graph
    .admin_index_status(workspace_id, doc_id)
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;
  if json {
    print_json(&serde_json::json!({
      "summary": summary,
      "document": state,
    }));
    return Ok(());
  }
  print_single(&summary_row(summary), false);
  if let Some(state) = state {
    print_single(&doc_row(state), false);
  }
  Ok(())
}

fn build_graph_service(svc: &Services, queue: Option<Arc<dyn WorkQueuePort>>) -> DocumentGraphService {
  svc.document_graph.clone().with_queue(queue)
}

fn parse_uuid(value: &str, name: &str) -> anyhow::Result<Uuid> {
  value
    .parse::<Uuid>()
    .with_context(|| format!("invalid {name} UUID '{value}'"))
}

fn parse_reason(value: &str) -> anyhow::Result<DocumentGraphReindexReason> {
  parse_reindex_reason(value).map_err(|error| anyhow::anyhow!("{error}"))
}

fn print_queue(queued: DocumentGraphQueue, json: bool) {
  let rows = [QueueRow {
    queue: queued.queue.to_string(),
    job_name: queued.job_name.to_string(),
    job_id: queued.job_id.unwrap_or_else(|| "(not queued)".to_string()),
  }];
  print_output(&rows, json);
}

fn print_outcome(outcome: DocumentGraphReindexOutcome, json: bool) {
  let rows = [OutcomeRow {
    workspace_id: outcome
      .workspace_id
      .map(|id| id.to_string())
      .unwrap_or_else(|| "(all)".to_string()),
    requested_count: outcome.requested_count,
    reindexed_count: outcome.reindexed_count,
    failed_count: outcome.failed_count,
    skipped_count: outcome.skipped_count,
  }];
  print_output(&rows, json);
}

fn summary_row(summary: DocumentGraphIndexSummary) -> StatusSummaryRow {
  StatusSummaryRow {
    workspace_id: summary.workspace_id.to_string(),
    current: summary.current_count,
    stale: summary.stale_count,
    queued: summary.queued_count,
    extracting: summary.extracting_count,
    failed: summary.failed_count,
    deleted: summary.deleted_count,
    missing_state: summary.missing_state_count,
  }
}

fn doc_row(state: DocumentGraphIndexState) -> StatusDocRow {
  StatusDocRow {
    workspace_id: state.workspace_id.to_string(),
    doc_id: state.doc_id.to_string(),
    stale_state: state.stale_state.as_str().to_string(),
    occurrence_count: state.occurrence_count,
    attempt_count: state.attempt_count,
    indexed_at: state
      .indexed_at
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".to_string()),
    queued_at: state
      .queued_at
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".to_string()),
    started_at: state
      .started_at
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".to_string()),
    failed_at: state
      .failed_at
      .map(|value| value.to_rfc3339())
      .unwrap_or_else(|| "-".to_string()),
    error_code: state.error_code.unwrap_or_else(|| "-".to_string()),
    error_message: state.error_message.unwrap_or_else(|| "-".to_string()),
  }
}
