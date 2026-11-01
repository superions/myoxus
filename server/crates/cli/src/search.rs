//! `search` subcommand — FTS index management and diagnostics.
//!
//! Provides three sub-commands:
//! - `reindex` — enqueue a full reindex run via `search_reindex_runs`
//! - `stats`   — show per-workspace document counts and last-indexed timestamps
//! - `query`   — execute a raw FTS query against `search_content` for debugging

use clap::{Args, Subcommand};
use serde::Serialize;
use sqlx::{PgPool, Row};
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_output, print_table};

/// Subcommands for `search`.
#[derive(Subcommand)]
pub enum SearchCommand {
  /// Enqueue a full-text search reindex run (for one workspace or all).
  Reindex(ReindexArgs),
  /// Show FTS index stats: doc count, last indexed timestamp, per workspace.
  Stats,
  /// Execute a raw FTS query against search_content for debugging.
  Query(QueryArgs),
}

/// Arguments for `search reindex`.
#[derive(Args)]
pub struct ReindexArgs {
  /// UUID of a specific workspace to reindex; if omitted all workspaces are reindexed.
  #[arg(long)]
  pub workspace: Option<String>,
}

/// Arguments for `search query`.
#[derive(Args)]
pub struct QueryArgs {
  /// Search term (passed to plainto_tsquery).
  pub term: String,
  /// Limit results to a specific workspace UUID.
  #[arg(long)]
  pub workspace: Option<String>,
  /// Maximum number of results to return.
  #[arg(long, default_value = "20")]
  pub limit: i32,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// Reindex run summary row.
#[derive(Tabled, Serialize)]
pub struct ReindexRow {
  /// UUID of the new reindex run.
  pub run_id: String,
  /// Workspace this run is scoped to, or "(all)" for a global reindex.
  pub workspace: String,
  /// Initial status of the run.
  pub status: String,
  /// When the run was started.
  pub started_at: String,
}

/// Per-workspace FTS index statistics row.
#[derive(Tabled, Serialize)]
pub struct StatsRow {
  /// Workspace UUID.
  pub workspace_id: String,
  /// Number of documents in `search_content` for this workspace.
  pub doc_count: i64,
  /// Timestamp of the most recently indexed document.
  pub last_indexed_at: String,
}

/// Single FTS query result row.
#[derive(Tabled, Serialize)]
pub struct QueryResultRow {
  /// Workspace UUID.
  pub workspace_id: String,
  /// Document ID string.
  pub doc_id: String,
  /// Document title.
  pub title: String,
  /// FTS relevance rank (higher = more relevant).
  pub rank: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `search` subcommand.
pub async fn run(cmd: SearchCommand, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  match cmd {
    SearchCommand::Reindex(args) => reindex(args, pool, json).await,
    SearchCommand::Stats => stats(pool, json).await,
    SearchCommand::Query(args) => query(args, pool, json).await,
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async fn reindex(args: ReindexArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  // Parse optional workspace UUID.
  let workspace_id: Option<Uuid> = args
    .workspace
    .as_deref()
    .map(|s| {
      s.parse::<Uuid>()
        .map_err(|e| anyhow::anyhow!("invalid workspace UUID '{}': {}", s, e))
    })
    .transpose()?;

  // Insert a new reindex run record with status = 'running'.
  // The server's indexer worker polls this table and processes queued runs.
  let row = sqlx::query(
    r#"
    INSERT INTO search_reindex_runs (
        mode,
        workspace_id,
        status,
        cursor_updated_at,
        cursor_doc_id,
        processed_count,
        indexed_count,
        started_at,
        updated_at,
        finished_at,
        error_message
    )
    VALUES ('full', $1, 'running', NULL, NULL, 0, 0, now(), now(), NULL, NULL)
    RETURNING id, workspace_id, status, started_at
    "#,
  )
  .bind(workspace_id)
  .fetch_one(pool)
  .await?;

  let run_id: Uuid = row.get("id");
  let ws_display = workspace_id
    .map(|id| id.to_string())
    .unwrap_or_else(|| "(all)".to_string());
  let status: String = row.get("status");
  let started_at: chrono::DateTime<chrono::Utc> = row.get("started_at");

  let result = vec![ReindexRow {
    run_id: run_id.to_string(),
    workspace: ws_display,
    status,
    started_at: started_at.to_rfc3339(),
  }];

  print_output(&result, json);
  Ok(())
}

async fn stats(pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let rows = sqlx::query(
    r#"
    SELECT
        workspace_id::text,
        COUNT(*)::bigint AS doc_count,
        MAX(updated_at) AS last_indexed_at
    FROM search_content
    GROUP BY workspace_id
    ORDER BY doc_count DESC
    "#,
  )
  .fetch_all(pool)
  .await?;

  let display: Vec<StatsRow> = rows
    .into_iter()
    .map(|row| {
      let last_indexed_at: Option<chrono::DateTime<chrono::Utc>> = row.get("last_indexed_at");
      StatsRow {
        workspace_id: row.get("workspace_id"),
        doc_count: row.get("doc_count"),
        last_indexed_at: last_indexed_at
          .map(|t| t.to_rfc3339())
          .unwrap_or_else(|| "never".to_string()),
      }
    })
    .collect();

  if display.is_empty() {
    eprintln!("(no indexed documents found in search_content)");
    if json {
      print_json(&display);
    } else {
      print_table(&display);
    }
    return Ok(());
  }

  print_output(&display, json);
  Ok(())
}

async fn query(args: QueryArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  // Parse optional workspace UUID.
  let workspace_id: Option<Uuid> = args
    .workspace
    .as_deref()
    .map(|s| {
      s.parse::<Uuid>()
        .map_err(|e| anyhow::anyhow!("invalid workspace UUID '{}': {}", s, e))
    })
    .transpose()?;

  let rows = sqlx::query(
    r#"
    SELECT
        workspace_id::text,
        doc_id::text AS doc_id,
        title,
        ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
    FROM search_content
    WHERE search_vector @@ plainto_tsquery('english', $1)
      AND ($2::uuid IS NULL OR workspace_id = $2)
    ORDER BY rank DESC
    LIMIT $3
    "#,
  )
  .bind(&args.term)
  .bind(workspace_id)
  .bind(args.limit)
  .fetch_all(pool)
  .await?;

  let display: Vec<QueryResultRow> = rows
    .into_iter()
    .map(|row| QueryResultRow {
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      title: row.get::<Option<String>, _>("title").unwrap_or_default(),
      rank: format!("{:.4}", row.get::<f32, _>("rank")),
    })
    .collect();

  if display.is_empty() {
    eprintln!("(no results for query '{}')", args.term);
    if json {
      print_json(&display);
    } else {
      print_table(&display);
    }
    return Ok(());
  }

  print_output(&display, json);
  Ok(())
}
