// SPDX-License-Identifier: AGPL-3.0-or-later
//! Operator commands for the durable server-backed workspace importer.
//!
//! The CLI stages bounded parts and invokes the same application use cases as
//! GraphQL. It never classifies, opens or converts the source file itself.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use bytes::Bytes;
use clap::{Args, Subcommand, ValueEnum};
use myoxus_application::audit::{AuditActor, AuditCategory, AuditEvent, AuditRecorder, AuditTarget};
use myoxus_application::workspace_import::{WORKSPACE_IMPORT_PART_BYTES, WorkspaceImportService};
use myoxus_domain::ids::{UserId, WorkspaceImportId};
use myoxus_domain::workspace_import::{WorkspaceImportRecord, WorkspaceImportStatus};
use myoxus_infrastructure::audit::PgAuditLogStore;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::services::Services;

#[derive(Subcommand)]
pub enum WorkspaceCommand {
  /// Import a legacy workspace into a fresh server-owned workspace.
  #[command(subcommand)]
  Import(WorkspaceImportCommand),
}

#[derive(Subcommand)]
pub enum WorkspaceImportCommand {
  /// Stage, validate and preview a local legacy workspace file.
  Preview(FileImportArgs),
  /// Stage, preview and apply a local legacy workspace file.
  Apply(FileImportArgs),
  /// Show one durable workspace-import status projection.
  Status(ImportIdArgs),
  /// Retry compensation for an import in cleanup-required state.
  Cleanup(ImportIdArgs),
}

#[derive(Args)]
pub struct FileImportArgs {
  /// Local legacy workspace file. Format is detected from content, not suffix.
  #[arg(long)]
  file: PathBuf,
  /// Existing account that will own the fresh imported workspace.
  #[arg(long)]
  actor_id: UserId,
  /// Select Obsidian for a vault ZIP; legacy sources remain content-detected.
  #[arg(long, value_enum, default_value_t = WorkspaceImportSourceFormat::Auto)]
  format: WorkspaceImportSourceFormat,
  /// Maximum time to wait for each worker operation.
  #[arg(long, default_value_t = 7_200)]
  wait_seconds: u64,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum WorkspaceImportSourceFormat {
  Auto,
  Obsidian,
}

#[derive(Args)]
pub struct ImportIdArgs {
  #[arg(long)]
  import_id: WorkspaceImportId,
  /// Maximum time to wait for cleanup completion.
  #[arg(long, default_value_t = 7_200)]
  wait_seconds: u64,
}

pub async fn run(command: WorkspaceCommand, services: &Services, json: bool) -> anyhow::Result<()> {
  let service = services.workspace_import().await?;
  match command {
    WorkspaceCommand::Import(WorkspaceImportCommand::Preview(args)) => {
      let import_id = stage_file(service.as_ref(), args.actor_id, &args.file, args.format).await?;
      service.queue_preview(args.actor_id, import_id).await?;
      let record = wait_for(service.as_ref(), import_id, args.wait_seconds, |status| {
        status == WorkspaceImportStatus::Previewed
      })
      .await?;
      print_record(&record, json)?;
    }
    WorkspaceCommand::Import(WorkspaceImportCommand::Apply(args)) => {
      let import_id = stage_file(service.as_ref(), args.actor_id, &args.file, args.format).await?;
      service.queue_preview(args.actor_id, import_id).await?;
      wait_for(service.as_ref(), import_id, args.wait_seconds, |status| {
        status == WorkspaceImportStatus::Previewed
      })
      .await?;
      service.queue_apply(args.actor_id, import_id).await?;
      let record = wait_for(service.as_ref(), import_id, args.wait_seconds, |status| {
        status == WorkspaceImportStatus::Succeeded
      })
      .await?;
      print_record(&record, json)?;
    }
    WorkspaceCommand::Import(WorkspaceImportCommand::Status(args)) => {
      print_record(&service.operator_status(args.import_id).await?, json)?;
    }
    WorkspaceCommand::Import(WorkspaceImportCommand::Cleanup(args)) => {
      let queued = service.retry_cleanup(args.import_id).await?;
      record_cleanup_audit(services, &queued).await;
      let record = wait_for(service.as_ref(), args.import_id, args.wait_seconds, |status| {
        status == WorkspaceImportStatus::Failed
      })
      .await?;
      print_record(&record, json)?;
    }
  }
  Ok(())
}

async fn stage_file(
  service: &WorkspaceImportService,
  actor_id: UserId,
  path: &Path,
  format: WorkspaceImportSourceFormat,
) -> anyhow::Result<WorkspaceImportId> {
  let mut file = tokio::fs::File::open(path)
    .await
    .with_context(|| format!("open workspace import source {}", path.display()))?;
  let metadata = file.metadata().await.context("read workspace import source metadata")?;
  if !metadata.is_file() || metadata.len() == 0 {
    bail!("workspace import source must be a non-empty regular file");
  }

  let selected_format = match format {
    WorkspaceImportSourceFormat::Auto => None,
    WorkspaceImportSourceFormat::Obsidian => Some(myoxus_workspace_import::WorkspaceImportFormat::ObsidianZip),
  };
  let upload = service.create_upload_as(actor_id, selected_format).await?;
  let mut whole_hash = Sha256::new();
  let mut whole_size = 0_i64;
  let mut part_number = 1_i32;
  loop {
    let mut buffer = vec![0_u8; WORKSPACE_IMPORT_PART_BYTES];
    let read = file.read(&mut buffer).await.context("read workspace import source")?;
    if read == 0 {
      break;
    }
    buffer.truncate(read);
    whole_hash.update(&buffer);
    whole_size = whole_size
      .checked_add(read as i64)
      .context("workspace import source size overflow")?;
    let part_hash = format!("{:x}", Sha256::digest(&buffer));
    service
      .upload_part(actor_id, upload.import_id, part_number, &part_hash, Bytes::from(buffer))
      .await?;
    part_number = part_number
      .checked_add(1)
      .context("workspace import has too many parts")?;
  }
  let source_hash = format!("{:x}", whole_hash.finalize());
  service
    .complete_upload(actor_id, upload.import_id, whole_size, &source_hash)
    .await?;
  Ok(upload.import_id)
}

async fn wait_for(
  service: &WorkspaceImportService,
  import_id: WorkspaceImportId,
  wait_seconds: u64,
  accepted: impl Fn(WorkspaceImportStatus) -> bool,
) -> anyhow::Result<WorkspaceImportRecord> {
  let deadline = tokio::time::Instant::now() + Duration::from_secs(wait_seconds.max(1));
  loop {
    let record = service.operator_status(import_id).await?;
    if accepted(record.status) {
      return Ok(record);
    }
    if matches!(
      record.status,
      WorkspaceImportStatus::Failed
        | WorkspaceImportStatus::Cancelled
        | WorkspaceImportStatus::CleanupRequired
        | WorkspaceImportStatus::Expired
    ) {
      bail!(
        "workspace import {} ended in {} ({})",
        import_id,
        record.status.as_str(),
        record.error_code.as_deref().unwrap_or("no diagnostic")
      );
    }
    if tokio::time::Instant::now() >= deadline {
      bail!("timed out waiting for workspace import {import_id}");
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
  }
}

async fn record_cleanup_audit(services: &Services, record: &WorkspaceImportRecord) {
  AuditRecorder::new(std::sync::Arc::new(PgAuditLogStore::new(services.pool.clone())))
    .record(AuditEvent::mutation(
      "workspace_import.cleanup.retry",
      AuditCategory::Workspace,
      Some(AuditTarget::entity("workspace_import", record.id, None::<String>)),
      AuditActor::system(),
      None,
      Some(serde_json::json!({ "status": record.status.as_str(), "source": "cli" })),
    ))
    .await;
}

fn print_record(record: &WorkspaceImportRecord, json: bool) -> anyhow::Result<()> {
  if json {
    println!("{}", serde_json::to_string(record)?);
  } else {
    println!("{}", serde_json::to_string_pretty(record)?);
  }
  Ok(())
}
