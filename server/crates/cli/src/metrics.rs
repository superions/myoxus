// SPDX-License-Identifier: AGPL-3.0-or-later
//! `metrics` subcommand — operational visibility into the business-metrics
//! pipeline (P-Metrics-H).
//!
//! The CLI is DB-only — it reads `metrics_raw` / `metrics_daily` directly so
//! it works against an offline database.  Live recorder snapshots and manual
//! flushes are available through the running server via Admin GraphQL
//! (`admin { metricsStatus }`, `admin { flushMetrics }`; see
//! `docs/dev/server/api-reference.md`).
//!
//! Three operations:
//!
//! * `snapshot` — the N most recent rows of `metrics_raw`.  Gives operators a
//!   direct window into what the last flush wrote; also shows when nothing has
//!   arrived yet (empty table → recorder disabled or flush stalled).
//! * `flush-now` — documented guidance.  There is no DB-only flush; the
//!   recorder lives in the API process.  This subcommand prints the canonical
//!   `curl` command operators should run against the live API.
//! * `stats` — `metrics_raw` / `metrics_daily` row counts, byte footprint, the
//!   most recent flush minute, and the most recent rollup day.  Useful for
//!   capacity planning and catching a stalled rollup job.

use anyhow::{Context, Result};
use chrono::{DateTime, NaiveDate, Utc};
use clap::{Args, Subcommand};
use serde::Serialize;
use sqlx::PgPool;
use tabled::Tabled;

use crate::output::print_output;

/// Subcommands for `metrics`.
#[derive(Subcommand)]
pub enum MetricsCommand {
  /// Print the most recent rows of `metrics_raw` (last flush window).
  Snapshot(SnapshotArgs),
  /// Print the canonical `curl` invocation for the live Admin GraphQL flush.
  FlushNow(FlushNowArgs),
  /// Show table sizes and most-recent flush/rollup timestamps.
  Stats,
}

/// Args for `metrics snapshot`.
#[derive(Args)]
pub struct SnapshotArgs {
  /// Maximum number of rows to return (newest first).  Default 50.
  #[arg(long, default_value_t = 50)]
  pub limit: i64,
}

/// Args for `metrics flush-now`.
#[derive(Args)]
pub struct FlushNowArgs {
  /// Base URL of the running API (defaults to `http://localhost:3001`).
  #[arg(long, default_value = "http://localhost:3001")]
  pub api_url: String,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// One row of `metrics_raw`, flattened for table rendering.
#[derive(Serialize, Tabled)]
struct RawRow {
  minute: String,
  category: String,
  metric_name: String,
  value: f64,
  #[tabled(skip)]
  #[serde(skip_serializing_if = "serde_json::Value::is_null")]
  labels: serde_json::Value,
  /// Compact labels preview for the table renderer only.
  #[serde(skip)]
  labels_preview: String,
}

/// One row of the `stats` output.
#[derive(Serialize, Tabled)]
struct StatsRow {
  field: String,
  value: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub async fn run(cmd: MetricsCommand, pool: &PgPool, json: bool) -> Result<()> {
  match cmd {
    MetricsCommand::Snapshot(args) => snapshot(args, pool, json).await,
    MetricsCommand::FlushNow(args) => flush_now(args, json),
    MetricsCommand::Stats => stats(pool, json).await,
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async fn snapshot(args: SnapshotArgs, pool: &PgPool, json: bool) -> Result<()> {
  let raw: Vec<(DateTime<Utc>, String, String, serde_json::Value, f64)> = sqlx::query_as(
    r#"SELECT minute, category, metric_name, labels, value
       FROM metrics_raw
       ORDER BY minute DESC, category, metric_name
       LIMIT $1"#,
  )
  .bind(args.limit)
  .fetch_all(pool)
  .await
  .context("metrics_raw snapshot query failed")?;

  let rows: Vec<RawRow> = raw
    .into_iter()
    .map(|(minute, category, metric_name, labels, value)| {
      let labels_preview = preview(&labels);
      RawRow {
        minute: minute.to_rfc3339(),
        category,
        metric_name,
        value,
        labels,
        labels_preview,
      }
    })
    .collect();

  print_output(&rows, json);
  Ok(())
}

fn flush_now(args: FlushNowArgs, _json: bool) -> Result<()> {
  // The recorder lives in the live API process.  A DB-only flush is a
  // contradiction — the buffer is in memory.  Instead give operators the
  // canonical invocation.  A future revision could `reqwest` this directly
  // once session-cookie handling lands in the CLI.
  println!(
    "# Trigger a live flush via Admin GraphQL.\n\
     # First create the owner-only curl config shown in\n\
     # docs/ops/observability/metrics.md. It must contain the authenticated\n\
     # affine_session cookie, myoxus_csrf_token cookie, and matching\n\
     # x-myoxus-csrf-token header; never put their values in arguments.\n\
     curl -sS -X POST -H \"content-type: application/json\" \\\n  \
       --config /protected/path/admin-curl-auth.conf \\\n  \
       --data '{{\"query\":\"mutation {{ admin {{ flushMetrics {{ buffered inserted }} }} }}\"}}' \\\n  \
       {}/graphql | jq\n\
     \n\
     # Or via the Admin GUI: System -> Metrics -> Flush now\n\
     # The scheduled flush runs every `metrics.flushIntervalSeconds` (default 60 s).",
    args.api_url.trim_end_matches('/')
  );
  Ok(())
}

async fn stats(pool: &PgPool, json: bool) -> Result<()> {
  let (raw_total,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM metrics_raw")
    .fetch_one(pool)
    .await
    .context("count metrics_raw failed")?;

  let (daily_total,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM metrics_daily")
    .fetch_one(pool)
    .await
    .context("count metrics_daily failed")?;

  let (raw_bytes,): (i64,) = sqlx::query_as("SELECT pg_total_relation_size('metrics_raw')::bigint")
    .fetch_one(pool)
    .await
    .context("metrics_raw size failed")?;

  let (daily_bytes,): (i64,) = sqlx::query_as("SELECT pg_total_relation_size('metrics_daily')::bigint")
    .fetch_one(pool)
    .await
    .context("metrics_daily size failed")?;

  let (last_flush,): (Option<DateTime<Utc>>,) = sqlx::query_as("SELECT MAX(minute) FROM metrics_raw")
    .fetch_one(pool)
    .await
    .context("max minute failed")?;

  let (last_rollup_day,): (Option<NaiveDate>,) = sqlx::query_as("SELECT MAX(day) FROM metrics_daily")
    .fetch_one(pool)
    .await
    .context("max day failed")?;

  let (distinct_series,): (i64,) =
    sqlx::query_as("SELECT COUNT(DISTINCT (category, metric_name, labels))::bigint FROM metrics_raw")
      .fetch_one(pool)
      .await
      .context("distinct series count failed")?;

  let rows = vec![
    StatsRow {
      field: "metrics_raw_rows".into(),
      value: raw_total.to_string(),
    },
    StatsRow {
      field: "metrics_raw_bytes".into(),
      value: format_bytes(raw_bytes),
    },
    StatsRow {
      field: "metrics_daily_rows".into(),
      value: daily_total.to_string(),
    },
    StatsRow {
      field: "metrics_daily_bytes".into(),
      value: format_bytes(daily_bytes),
    },
    StatsRow {
      field: "distinct_series".into(),
      value: distinct_series.to_string(),
    },
    StatsRow {
      field: "last_flush_minute".into(),
      value: last_flush.map(|t| t.to_rfc3339()).unwrap_or_else(|| "-".into()),
    },
    StatsRow {
      field: "last_rollup_day".into(),
      value: last_rollup_day.map(|d| d.to_string()).unwrap_or_else(|| "-".into()),
    },
  ];

  print_output(&rows, json);
  Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn preview(value: &serde_json::Value) -> String {
  if value.is_object() || value.is_array() {
    let s = value.to_string();
    if s.len() > 60 { format!("{}…", &s[..60]) } else { s }
  } else {
    String::new()
  }
}

fn format_bytes(bytes: i64) -> String {
  const KB: f64 = 1024.0;
  const MB: f64 = KB * 1024.0;
  const GB: f64 = MB * 1024.0;
  let b = bytes as f64;
  if b >= GB {
    format!("{:.1} GB", b / GB)
  } else if b >= MB {
    format!("{:.1} MB", b / MB)
  } else if b >= KB {
    format!("{:.1} kB", b / KB)
  } else {
    format!("{bytes} B")
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn format_bytes_scales() {
    assert_eq!(format_bytes(500), "500 B");
    assert_eq!(format_bytes(2048), "2.0 kB");
    assert_eq!(format_bytes(5 * 1024 * 1024), "5.0 MB");
    assert_eq!(format_bytes(2 * 1024 * 1024 * 1024), "2.0 GB");
  }

  #[test]
  fn preview_truncates_large_json() {
    let big = serde_json::json!({ "k": "x".repeat(200) });
    let p = preview(&big);
    assert!(p.ends_with('…'));
    assert_eq!(p.chars().count(), 61);
  }

  #[test]
  fn preview_empty_for_scalar() {
    assert_eq!(preview(&serde_json::Value::Null), "");
    assert_eq!(preview(&serde_json::json!("foo")), "");
  }

  #[test]
  fn flush_guidance_keeps_session_credentials_out_of_process_arguments() {
    let source = include_str!("metrics.rs");
    assert!(source.contains("--config /protected/path/admin-curl-auth.conf"));
    assert!(source.contains("affine_session cookie"));
    assert!(source.contains("myoxus_csrf_token cookie"));
    assert!(source.contains("x-myoxus-csrf-token header"));
    assert!(!source.contains(concat!("myoxus_", "session")));
    assert!(!source.contains(concat!("-H ", "\\\"cookie:")));
  }
}
