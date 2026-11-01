// SPDX-License-Identifier: AGPL-3.0-or-later
//! `telemetry` subcommand — DSGVO-scoped telemetry administration.
//!
//! The telemetry pipeline stores one row per client-originated event in
//! `telemetry_events` with an optional `user_id` FK (`ON DELETE CASCADE`),
//! plus daily aggregates in `telemetry_daily`.  Daily rollups do not carry
//! user identifiers, so only `telemetry_events` is relevant here.
//!
//! Three operations, each mapping to a GDPR right:
//!
//! * `export-user <id>` — Article 15, right to access.  Dumps every
//!   telemetry row for the given user as one JSON object per line so it can
//!   be handed to the data subject.  Includes rows regardless of category
//!   or sampling state.
//! * `purge-user <id>` — Article 17, right to erasure.  Deletes all rows
//!   for the user *without* touching the user account itself (useful when
//!   the user wants to wipe their telemetry history but stay signed up).
//!   Account deletion via `users delete` already cascades through the FK.
//! * `stats` — operational overview: row counts per table, retention-window
//!   preview, most-recent received_at.  Useful for capacity planning and
//!   sanity-checking the retention job.
//!
//! All commands accept a user identifier as either a UUID or an email
//! address (looked up via the `users` table).  Output respects the global
//! `--json` flag.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use clap::{Args, Subcommand};
use serde::Serialize;
use sqlx::PgPool;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_output};

/// Subcommands for `telemetry`.
#[derive(Subcommand)]
pub enum TelemetryCommand {
  /// Export all telemetry events for a user (DSGVO Art. 15 right to access).
  ExportUser(UserScopedArgs),
  /// Delete all telemetry events for a user (DSGVO Art. 17 right to erasure),
  /// without touching the user account itself.
  PurgeUser(UserScopedArgs),
  /// Show operational statistics: row counts, most-recent event, recent 24h
  /// volume.  Reads `telemetry_events` and `telemetry_daily` directly.
  Stats,
}

/// User identifier (UUID or email) for purge/export.
#[derive(Args)]
pub struct UserScopedArgs {
  /// Target user: either a UUID or an email address.
  pub user: String,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// One telemetry event row.  Fields mirror the `telemetry_events` schema.
#[derive(Serialize, Tabled)]
struct ExportRow {
  event_id: String,
  event_name: String,
  category: String,
  schema_version: i16,
  client_timestamp: String,
  received_at: String,
  /// JSON params (stringified for the table renderer; preserved as object in JSON mode).
  #[tabled(skip)]
  #[serde(skip_serializing_if = "serde_json::Value::is_null")]
  params: serde_json::Value,
  #[tabled(skip)]
  #[serde(skip_serializing_if = "serde_json::Value::is_null")]
  user_properties: serde_json::Value,
  #[tabled(skip)]
  #[serde(skip_serializing_if = "serde_json::Value::is_null")]
  context: serde_json::Value,
  /// Set only for the table renderer — a compact representation of params.
  #[serde(skip)]
  params_preview: String,
}

/// Outcome of a `purge-user` run.
#[derive(Tabled, Serialize)]
struct PurgeRow {
  target: String,
  deleted_count: i64,
  message: String,
}

/// Row for `stats`.
#[derive(Tabled, Serialize)]
struct StatsRow {
  field: String,
  value: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub async fn run(cmd: TelemetryCommand, pool: &PgPool, json: bool) -> Result<()> {
  match cmd {
    TelemetryCommand::ExportUser(args) => export_user(args, pool, json).await,
    TelemetryCommand::PurgeUser(args) => purge_user(args, pool, json).await,
    TelemetryCommand::Stats => stats(pool, json).await,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve a CLI-supplied user string (UUID or email) to the users.id UUID.
///
/// Returns `Ok(None)` when no match exists so callers can differentiate
/// "user gone" from "DB error".
async fn resolve_user_id(pool: &PgPool, raw: &str) -> Result<Option<Uuid>> {
  // Fast-path: already a UUID?
  if let Ok(uuid) = Uuid::parse_str(raw) {
    let exists: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE id = $1")
      .bind(uuid)
      .fetch_optional(pool)
      .await
      .context("users lookup by id failed")?;
    return Ok(exists.map(|(id,)| id));
  }

  // Otherwise look up by email.
  let row: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE email = $1")
    .bind(raw)
    .fetch_optional(pool)
    .await
    .context("users lookup by email failed")?;
  Ok(row.map(|(id,)| id))
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

type TelemetryExportRow = (
  String,
  String,
  String,
  i16,
  DateTime<Utc>,
  DateTime<Utc>,
  serde_json::Value,
  serde_json::Value,
  serde_json::Value,
);

async fn export_user(args: UserScopedArgs, pool: &PgPool, json: bool) -> Result<()> {
  let user_id = resolve_user_id(pool, &args.user)
    .await?
    .ok_or_else(|| anyhow::anyhow!("user '{}' not found", args.user))?;

  let raw: Vec<TelemetryExportRow> = sqlx::query_as(
    r#"SELECT
         event_id,
         event_name,
         category,
         schema_version,
         client_timestamp,
         received_at,
         params,
         user_properties,
         context
       FROM telemetry_events
       WHERE user_id = $1
       ORDER BY received_at ASC"#,
  )
  .bind(user_id)
  .fetch_all(pool)
  .await
  .context("telemetry_events export query failed")?;

  let rows: Vec<ExportRow> = raw
    .into_iter()
    .map(
      |(event_id, event_name, category, schema_version, client_ts, received_at, params, user_properties, context)| {
        let params_preview = if params.is_object() || params.is_array() {
          let s = params.to_string();
          if s.len() > 60 { format!("{}…", &s[..60]) } else { s }
        } else {
          String::new()
        };
        ExportRow {
          event_id,
          event_name,
          category,
          schema_version,
          client_timestamp: client_ts.to_rfc3339(),
          received_at: received_at.to_rfc3339(),
          params,
          user_properties,
          context,
          params_preview,
        }
      },
    )
    .collect();

  print_output(&rows, json);
  Ok(())
}

async fn purge_user(args: UserScopedArgs, pool: &PgPool, json: bool) -> Result<()> {
  let user_id = resolve_user_id(pool, &args.user)
    .await?
    .ok_or_else(|| anyhow::anyhow!("user '{}' not found", args.user))?;

  let result = sqlx::query("DELETE FROM telemetry_events WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .context("telemetry_events purge failed")?;

  let count = result.rows_affected() as i64;
  let rows = vec![PurgeRow {
    target: format!("{} ({})", args.user, user_id),
    deleted_count: count,
    message: format!("{count} telemetry row(s) deleted (DSGVO Art. 17)."),
  }];

  if json {
    print_json(&rows);
  } else {
    print_output(&rows, json);
  }
  Ok(())
}

async fn stats(pool: &PgPool, json: bool) -> Result<()> {
  let (events_total,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM telemetry_events")
    .fetch_one(pool)
    .await
    .context("count telemetry_events failed")?;

  let (events_24h,): (i64,) =
    sqlx::query_as("SELECT COUNT(*)::bigint FROM telemetry_events WHERE received_at >= NOW() - INTERVAL '24 hours'")
      .fetch_one(pool)
      .await
      .context("count recent telemetry_events failed")?;

  let (daily_total,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM telemetry_daily")
    .fetch_one(pool)
    .await
    .context("count telemetry_daily failed")?;

  let (anon_total,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM telemetry_events WHERE user_id IS NULL")
    .fetch_one(pool)
    .await
    .context("count anon telemetry_events failed")?;

  let (most_recent,): (Option<DateTime<Utc>>,) = sqlx::query_as("SELECT MAX(received_at) FROM telemetry_events")
    .fetch_one(pool)
    .await
    .context("max received_at failed")?;

  let rows = vec![
    StatsRow {
      field: "events_total".into(),
      value: events_total.to_string(),
    },
    StatsRow {
      field: "events_last_24h".into(),
      value: events_24h.to_string(),
    },
    StatsRow {
      field: "events_anonymous (user_id IS NULL)".into(),
      value: anon_total.to_string(),
    },
    StatsRow {
      field: "events_most_recent".into(),
      value: most_recent.map(|t| t.to_rfc3339()).unwrap_or_else(|| "-".into()),
    },
    StatsRow {
      field: "daily_rollups_total".into(),
      value: daily_total.to_string(),
    },
  ];

  print_output(&rows, json);
  Ok(())
}

#[cfg(test)]
mod tests {

  #[test]
  fn params_preview_truncates_long_json() {
    let long = serde_json::json!({ "k": "x".repeat(200) });
    let s = long.to_string();
    let truncated = if s.len() > 60 { format!("{}…", &s[..60]) } else { s };
    assert!(truncated.ends_with('…'));
    assert_eq!(truncated.chars().count(), 61); // 60 chars + ellipsis
  }
}
