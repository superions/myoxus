// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only operator access to the existing audit store.

use chrono::{DateTime, Utc};
use clap::{Args, Subcommand};
use myoxus_domain::audit::{AuditActorKind, AuditCategory, AuditEntry, AuditFilter, AuditLogStore};
use myoxus_infrastructure::audit::PgAuditLogStore;
use serde::Serialize;
use sqlx::PgPool;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_table};

#[derive(Subcommand)]
pub enum AuditCommand {
  /// List matching events, newest first (inclusive time bounds).
  List(AuditListArgs),
  /// Read one event by its UUID; missing events exit unsuccessfully.
  Get { id: Uuid },
}

#[derive(Args)]
pub struct AuditListArgs {
  /// Inclusive lower timestamp bound (RFC 3339).
  #[arg(long)]
  from: Option<DateTime<Utc>>,
  /// Inclusive upper timestamp bound (RFC 3339).
  #[arg(long)]
  to: Option<DateTime<Utc>>,
  #[arg(long, value_parser = clap::builder::NonEmptyStringValueParser::new())]
  event_key_prefix: Option<String>,
  #[arg(long)]
  actor_user_id: Option<Uuid>,
  /// Actor origin: user, system or api_key.
  #[arg(long, value_parser = parse_actor_kind)]
  actor_kind: Option<AuditActorKind>,
  #[arg(long, value_parser = clap::builder::NonEmptyStringValueParser::new())]
  credential_type: Option<String>,
  #[arg(long, value_parser = clap::builder::NonEmptyStringValueParser::new())]
  credential_id: Option<String>,
  #[arg(long, value_parser = clap::builder::NonEmptyStringValueParser::new())]
  target_type: Option<String>,
  #[arg(long, requires = "target_type", value_parser = clap::builder::NonEmptyStringValueParser::new())]
  target_id: Option<String>,
  /// Stored audit category, e.g. auth, organization or database.
  #[arg(long, value_parser = parse_category)]
  category: Option<AuditCategory>,
  #[arg(long)]
  target_unit_id: Option<Uuid>,
  /// Maximum number of events (1–500).
  #[arg(long, default_value = "100", value_parser = clap::value_parser!(u16).range(1..=500))]
  limit: u16,
}

impl AuditCommand {
  /// Cross-argument validation runs before loading configuration or connecting.
  pub fn validate(&self) -> Result<(), clap::Error> {
    if let Self::List(args) = self {
      if matches!((args.from, args.to), (Some(from), Some(to)) if from > to) {
        return Err(clap::Error::raw(
          clap::error::ErrorKind::ValueValidation,
          "--from must be earlier than or equal to --to",
        ));
      }
    }
    Ok(())
  }
}

fn parse_actor_kind(value: &str) -> Result<AuditActorKind, String> {
  value
    .parse()
    .map_err(|_| "expected user, system or api_key".to_string())
}

fn parse_category(value: &str) -> Result<AuditCategory, String> {
  value
    .parse()
    .map_err(|_| "expected a stored audit category".to_string())
}

// The trusted local CLI returns the complete persisted audit record, including
// historical payloads and labels. Keep diagnostics in tracing payload-free.
#[derive(Serialize)]
struct EntryOutput {
  id: Uuid,
  created_at: DateTime<Utc>,
  event_key: String,
  category: String,
  actor_user_id: Option<Uuid>,
  actor_label: Option<String>,
  actor_kind: AuditActorKind,
  credential_type: Option<String>,
  credential_id: Option<String>,
  target_type: Option<String>,
  target_id: Option<String>,
  target_label: Option<String>,
  target_unit_id: Option<Uuid>,
  old_value: Option<serde_json::Value>,
  new_value: Option<serde_json::Value>,
  metadata: Option<serde_json::Value>,
}

impl From<AuditEntry> for EntryOutput {
  fn from(entry: AuditEntry) -> Self {
    // Exhaustive destructuring makes a new stored field a compiler error here
    // until the complete CLI output has been extended too.
    let AuditEntry {
      id,
      created_at,
      event_key,
      category,
      actor_user_id,
      actor_label,
      actor_kind,
      credential_type,
      credential_id,
      target_type,
      target_id,
      target_label,
      target_unit_id,
      old_value,
      new_value,
      metadata,
    } = entry;
    Self {
      id,
      created_at,
      event_key,
      category: category.to_string(),
      actor_user_id,
      actor_label,
      actor_kind,
      credential_type,
      credential_id,
      target_type,
      target_id,
      target_label,
      target_unit_id,
      old_value,
      new_value,
      metadata,
    }
  }
}

#[derive(Tabled)]
struct DetailRow {
  field: String,
  value: String,
}

#[tracing::instrument(skip_all)]
pub async fn run(command: AuditCommand, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let store = PgAuditLogStore::new(pool.clone());
  match command {
    AuditCommand::List(args) => {
      let filter = AuditFilter {
        from: args.from,
        to: args.to,
        // The store uses SQL LIKE. A CLI prefix is literal, including the
        // underscores found in existing event names; it is not a wildcard query.
        event_key_prefix: args
          .event_key_prefix
          .map(|value| value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")),
        actor_user_id: args.actor_user_id,
        actor_kind: args.actor_kind,
        credential_type: args.credential_type,
        credential_id: args.credential_id,
        target_type: args.target_type,
        target_id: args.target_id,
        category: args.category,
        target_unit_id: args.target_unit_id,
      };
      let entries: Vec<EntryOutput> = store
        .list(filter, 0, i64::from(args.limit))
        .await
        .map_err(|_| anyhow::anyhow!("could not read audit log"))?
        .into_iter()
        .map(EntryOutput::from)
        .collect();
      if json {
        print_json(&entries);
      } else {
        if entries.is_empty() {
          print_table::<DetailRow>(&[]);
        }
        for entry in &entries {
          print_entry(entry)?;
        }
      }
    }
    AuditCommand::Get { id } => {
      let entry = store
        .get_by_id(id)
        .await
        .map_err(|_| anyhow::anyhow!("could not read audit log"))?
        .ok_or_else(|| anyhow::anyhow!("audit entry not found: {id}"))?;
      let entry = EntryOutput::from(entry);
      if json {
        print_json(&entry);
      } else {
        print_entry(&entry)?;
      }
    }
  }
  Ok(())
}

fn print_entry(entry: &EntryOutput) -> anyhow::Result<()> {
  let value = serde_json::to_value(entry)?;
  let fields = value.as_object().expect("audit entry serializes as an object");
  let rows = fields
    .iter()
    .map(|(field, value)| {
      let value = match value {
        serde_json::Value::String(text) => text.clone(),
        value => serde_json::to_string_pretty(value)?,
      };
      Ok(DetailRow {
        field: field.clone(),
        value,
      })
    })
    .collect::<anyhow::Result<Vec<_>>>()?;
  print_table(&rows);
  Ok(())
}
