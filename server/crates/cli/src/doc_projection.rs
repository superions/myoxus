// SPDX-License-Identifier: AGPL-3.0-or-later
//! Trusted local CLI for bounded page-projection inspection and exact repair.

use anyhow::{Context, bail};
use clap::{Args, Subcommand};
use myoxus_application::doc::{DocLoadCancellation, PageLifecycleRepairMode};
use serde::Serialize;
use tabled::Tabled;
use uuid::Uuid;

use crate::{
  output::{print_output, print_single},
  services::Services,
};

#[derive(Subcommand)]
pub enum ProjectionCommand {
  /// Scan one bounded projection page without decoding leaf content.
  Scan(ScanArgs),
  /// Inspect exactly one workspace-local external document key.
  Inspect(InspectArgs),
  /// Preview one fingerprinted target; add --apply for an atomic repair.
  Repair(RepairArgs),
}

#[derive(Args, Debug)]
pub struct ScanArgs {
  #[arg(long)]
  workspace: String,
  #[arg(long)]
  cursor: Option<String>,
  #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=200))]
  limit: u16,
}

#[derive(Args, Debug)]
pub struct InspectArgs {
  #[arg(long)]
  workspace: String,
  /// Opaque workspace-local external document key.
  #[arg(long)]
  external_doc_id: String,
}

#[derive(Args, Debug)]
pub struct RepairArgs {
  #[arg(long)]
  workspace: String,
  /// Opaque workspace-local external document key.
  #[arg(long)]
  external_doc_id: String,
  /// Fingerprint returned by exact inspection.
  #[arg(long)]
  fingerprint: String,
  /// Actor UUID recorded on a persisted repair. Required with --apply.
  #[arg(long)]
  actor: Option<String>,
  /// Persist the repair. Omit for the default dry-run.
  #[arg(long, default_value_t = false)]
  apply: bool,
}

#[derive(Tabled, Serialize)]
struct ScanRow {
  source_id: String,
  external_doc_id: String,
  internal_source_id: String,
  sql_present: bool,
  root_present: bool,
  leaf_present: bool,
  findings: usize,
}

#[derive(Tabled, Serialize)]
struct InspectRow {
  external_doc_id: String,
  sql_present: bool,
  root_present: bool,
  leaf_present: bool,
  normalized_title: String,
  is_trashed: String,
  findings: usize,
  fingerprint: String,
}

#[derive(Tabled, Serialize)]
struct RepairRow {
  external_doc_id: String,
  fingerprint: String,
  mode: String,
  changed: bool,
  findings: usize,
}

pub async fn run(command: ProjectionCommand, services: &Services, json: bool) -> anyhow::Result<()> {
  match command {
    ProjectionCommand::Scan(args) => scan(args, services, json).await,
    ProjectionCommand::Inspect(args) => inspect(args, services, json).await,
    ProjectionCommand::Repair(args) => repair(args, services, json).await,
  }
}

async fn scan(args: ScanArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = parse_uuid(&args.workspace, "workspace")?;
  let result = services
    .doc
    .page_lifecycle_repair
    .scan(
      workspace_id,
      args.cursor.as_deref(),
      Some(args.limit),
      DocLoadCancellation::default(),
    )
    .await
    .map_err(|error| anyhow::anyhow!("scan page projection: {error}"))?;
  if json {
    println!(
      "{}",
      serde_json::to_string_pretty(&result).context("serialize projection scan")?
    );
  } else {
    let rows = result
      .items
      .iter()
      .map(|item| ScanRow {
        source_id: item.source_id.clone(),
        external_doc_id: item.external_doc_id.clone().unwrap_or_default(),
        internal_source_id: item.internal_source_id.map(|id| id.to_string()).unwrap_or_default(),
        sql_present: item.sql_present,
        root_present: item.root_present,
        leaf_present: item.leaf_present,
        findings: item.findings.len(),
      })
      .collect::<Vec<_>>();
    print_output(&rows, false);
    if let Some(cursor) = result.next_cursor {
      println!("next cursor: {cursor}");
    }
  }
  Ok(())
}

async fn inspect(args: InspectArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  validate_external_key(&args.external_doc_id)?;
  let workspace_id = parse_uuid(&args.workspace, "workspace")?;
  let result = services
    .doc
    .page_lifecycle_repair
    .inspect(workspace_id, &args.external_doc_id, DocLoadCancellation::default())
    .await
    .map_err(|error| anyhow::anyhow!("inspect page projection: {error}"))?;
  if json {
    println!(
      "{}",
      serde_json::to_string_pretty(&result).context("serialize projection inspection")?
    );
  } else {
    print_single(
      &InspectRow {
        external_doc_id: result.external_doc_id,
        sql_present: result.sql_present,
        root_present: result.root_present,
        leaf_present: result.leaf_present,
        normalized_title: result.normalized_title.unwrap_or_default(),
        is_trashed: result.is_trashed.map(|value| value.to_string()).unwrap_or_default(),
        findings: result.findings.len(),
        fingerprint: result.fingerprint,
      },
      false,
    );
  }
  Ok(())
}

async fn repair(args: RepairArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  validate_external_key(&args.external_doc_id)?;
  if args.fingerprint.trim().is_empty() {
    bail!("--fingerprint must not be empty");
  }
  let workspace_id = parse_uuid(&args.workspace, "workspace")?;
  let actor_user_id = match args.actor.as_deref() {
    Some(actor) => parse_uuid(actor, "actor")?,
    None if args.apply => bail!("--actor is required with --apply"),
    None => Uuid::nil(),
  };
  let mode = if args.apply {
    PageLifecycleRepairMode::Apply
  } else {
    PageLifecycleRepairMode::DryRun
  };
  let result = services
    .doc
    .page_lifecycle_repair
    .repair_exact(
      workspace_id,
      &args.external_doc_id,
      actor_user_id,
      &args.fingerprint,
      mode,
      DocLoadCancellation::default(),
    )
    .await
    .map_err(|error| anyhow::anyhow!("repair page projection: {error}"))?;
  if json {
    println!(
      "{}",
      serde_json::to_string_pretty(&result).context("serialize projection repair")?
    );
  } else {
    print_single(
      &RepairRow {
        external_doc_id: result.external_doc_id,
        fingerprint: result.fingerprint,
        mode: result.mode.as_str().to_string(),
        changed: result.changed,
        findings: result.findings.len(),
      },
      false,
    );
  }
  Ok(())
}

fn validate_external_key(value: &str) -> anyhow::Result<()> {
  myoxus_domain::document_key::DocumentKey::parse(value.to_string())
    .map(|_| ())
    .map_err(anyhow::Error::msg)
}

fn parse_uuid(value: &str, field: &str) -> anyhow::Result<Uuid> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    bail!("--{field} must not be empty");
  }
  Uuid::parse_str(trimmed).with_context(|| format!("invalid --{field} UUID: {trimmed}"))
}
