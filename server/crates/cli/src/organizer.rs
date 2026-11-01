// SPDX-License-Identifier: AGPL-3.0-or-later
//! Explicit Organizer order-key maintenance commands.

use anyhow::Context;
use clap::{Args, Subcommand};
use myoxus_application::organizer::{OrganizerError, OrganizerReindexPlan, OrganizerService};
use serde::Serialize;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_output};
use crate::services::Services;

#[derive(Subcommand)]
pub enum OrganizerCommand {
  /// Preview or explicitly apply an order-preserving fractional-key repair.
  ReindexOrder(ReindexOrderArgs),
}

#[derive(Args, Debug)]
pub struct ReindexOrderArgs {
  /// Workspace UUID whose Organizer system document is inspected.
  #[arg(long)]
  workspace_id: String,
  /// Append the planned index-only Yjs repair. Omit for dry-run.
  #[arg(long, default_value_t = false)]
  apply: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReindexResult<'a> {
  status: &'static str,
  revision: &'a str,
  affected_parent_groups: usize,
  row_count: usize,
  sequence: Option<i64>,
  groups: &'a [myoxus_application::organizer::OrganizerReindexGroup],
}

#[derive(Debug, Serialize, Tabled)]
struct ReindexRow {
  parent_id: String,
  row_id: String,
  before_index: String,
  after_index: String,
}

pub async fn run(command: OrganizerCommand, services: &Services, json: bool) -> anyhow::Result<()> {
  match command {
    OrganizerCommand::ReindexOrder(args) => reindex_order(args, services, json).await,
  }
}

async fn reindex_order(args: ReindexOrderArgs, services: &Services, json: bool) -> anyhow::Result<()> {
  let workspace_id = Uuid::parse_str(&args.workspace_id).context("invalid workspace-id UUID")?;
  let organizer = OrganizerService::new(services.doc.clone());
  let plan = organizer
    .plan_reindex(workspace_id)
    .await
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;

  if !args.apply {
    print_plan("dry_run", &plan, None, json);
    return Ok(());
  }
  if plan.is_empty() {
    print_plan("unchanged", &plan, None, json);
    return Ok(());
  }

  match organizer.apply_reindex(&plan).await {
    Ok(sequence) => {
      print_plan("applied", &plan, sequence, json);
      Ok(())
    }
    Err(OrganizerError::StaleRevision {
      expected_revision,
      current_revision,
    }) => {
      if json {
        print_json(&serde_json::json!({
          "status": "stale",
          "expectedRevision": expected_revision,
          "currentRevision": current_revision,
        }));
      }
      anyhow::bail!("MIX_ORGANIZER_REINDEX_STALE: Organizer changed after planning; no update was written")
    }
    Err(error) => Err(anyhow::anyhow!(error.to_string())),
  }
}

fn print_plan(status: &'static str, plan: &OrganizerReindexPlan, sequence: Option<i64>, json: bool) {
  if json {
    print_json(&ReindexResult {
      status,
      revision: &plan.revision,
      affected_parent_groups: plan.groups.len(),
      row_count: plan.row_count,
      sequence,
      groups: &plan.groups,
    });
    return;
  }
  println!(
    "status={status} revision={} affected_parent_groups={} row_count={}{}",
    plan.revision,
    plan.groups.len(),
    plan.row_count,
    sequence.map(|value| format!(" sequence={value}")).unwrap_or_default()
  );
  let rows = plan
    .groups
    .iter()
    .flat_map(|group| {
      group.rows.iter().map(|row| ReindexRow {
        parent_id: group.parent_id.clone().unwrap_or_else(|| "(root)".to_string()),
        row_id: row.id.clone(),
        before_index: row.before_index.clone(),
        after_index: row.after_index.clone(),
      })
    })
    .collect::<Vec<_>>();
  print_output(&rows, false);
}
