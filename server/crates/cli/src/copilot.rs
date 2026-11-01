//! `copilot` subcommand — provider status, embedding stats, and reindex jobs.

use clap::{Args, Subcommand};
use serde::Serialize;
use sqlx::PgPool;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_output, print_table};

/// Subcommands for `copilot`.
#[derive(Subcommand)]
pub enum CopilotCommand {
  /// Show provider config status and per-workspace embedding counts.
  Status,
  /// Queue an embedding reindex job for one or all workspaces.
  Reindex(ReindexArgs),
  /// Check what copilot provider config is present (masks API key).
  TestProvider,
}

/// Arguments for `copilot reindex`.
#[derive(Args)]
pub struct ReindexArgs {
  /// UUID of the workspace to reindex; if omitted all workspaces are queued.
  #[arg(long)]
  pub workspace: Option<String>,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// Per-workspace embedding statistics row.
#[derive(Tabled, Serialize)]
pub struct EmbeddingStatsRow {
  /// Workspace UUID.
  pub workspace_id: String,
  /// Number of stored embedding vectors.
  pub embedding_count: i64,
  /// Whether a copilot provider appears to be configured.
  pub provider_configured: String,
}

/// Queued reindex job confirmation row.
#[derive(Tabled, Serialize)]
pub struct ReindexRow {
  /// Workspace UUID that was queued.
  pub workspace_id: String,
  /// Confirmation message.
  pub message: String,
}

/// Provider configuration row (API key is masked).
#[derive(Tabled, Serialize)]
pub struct ProviderConfigRow {
  /// Config key from `app_configs`.
  pub key: String,
  /// Config value; API-key-like values are masked.
  pub value: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `copilot` subcommand.
pub async fn run(cmd: CopilotCommand, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  match cmd {
    CopilotCommand::Status => status(pool, json).await,
    CopilotCommand::Reindex(args) => reindex(args, pool, json).await,
    CopilotCommand::TestProvider => test_provider(pool, json).await,
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async fn status(pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let config = myoxus_infrastructure::app_config::load_validated_app_config_values(pool).await?;
  let provider_configured = config
    .get("copilot.providers")
    .and_then(serde_json::Value::as_object)
    .is_some_and(|providers| !providers.is_empty());

  let provider_label = if provider_configured {
    "yes"
  } else {
    "no (missing copilot.providers config)"
  };

  // Per-workspace embedding counts.
  let stats: Vec<(String, i64)> = sqlx::query_as(
    r#"SELECT workspace_id::text, COUNT(*) AS embedding_count
       FROM copilot_embeddings
       GROUP BY workspace_id
       ORDER BY embedding_count DESC"#,
  )
  .fetch_all(pool)
  .await
  .unwrap_or_default();

  if stats.is_empty() {
    // Emit a single summary row so the user still gets useful output.
    let rows = vec![EmbeddingStatsRow {
      workspace_id: "(none)".to_string(),
      embedding_count: 0,
      provider_configured: provider_label.to_string(),
    }];
    print_output(&rows, json);
    return Ok(());
  }

  let rows: Vec<EmbeddingStatsRow> = stats
    .into_iter()
    .map(|(workspace_id, embedding_count)| EmbeddingStatsRow {
      workspace_id,
      embedding_count,
      provider_configured: provider_label.to_string(),
    })
    .collect();

  print_output(&rows, json);
  Ok(())
}

async fn reindex(args: ReindexArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let workspace_ids: Vec<String> = if let Some(ref ws) = args.workspace {
    // Validate UUID format.
    let _: Uuid = ws
      .parse()
      .map_err(|_| anyhow::anyhow!("'{}' is not a valid UUID", ws))?;
    vec![ws.clone()]
  } else {
    // Collect all distinct workspace IDs from the workspaces table.
    sqlx::query_scalar::<_, String>("SELECT id::text FROM workspaces ORDER BY id")
      .fetch_all(pool)
      .await?
  };

  if workspace_ids.is_empty() {
    eprintln!("No workspaces found — nothing to queue.");
    return Ok(());
  }

  let mut rows: Vec<ReindexRow> = Vec::new();

  for ws_id in &workspace_ids {
    let payload = serde_json::json!({ "workspaceId": ws_id });
    sqlx::query(
      r#"INSERT INTO worker_jobs (queue_name, job_name, payload, status, created_at)
         VALUES ('indexer', 'autoIndexWorkspace', $1, 'pending', NOW())"#,
    )
    .bind(&payload)
    .execute(pool)
    .await?;

    rows.push(ReindexRow {
      workspace_id: ws_id.clone(),
      message: format!("Reindex job queued for workspace {ws_id}"),
    });
  }

  if json {
    print_json(&rows);
  } else {
    print_table(&rows);
  }
  Ok(())
}

async fn test_provider(pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let raw = myoxus_infrastructure::app_config::load_validated_app_config_values(pool)
    .await?
    .into_iter()
    .filter(|(path, _)| path.starts_with("copilot."))
    .map(|(path, value)| (path, value.to_string()))
    .collect::<Vec<_>>();

  if raw.is_empty() {
    eprintln!("No Copilot configuration override found in app_configs.");
    let rows: Vec<ProviderConfigRow> = vec![];
    print_output(&rows, json);
    return Ok(());
  }

  let rows: Vec<ProviderConfigRow> = raw
    .into_iter()
    .map(|(key, value)| {
      let masked = mask_sensitive(&key, &value);
      ProviderConfigRow { key, value: masked }
    })
    .collect();

  print_output(&rows, json);
  Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Mask the value if the key looks like it contains an API key or secret.
fn mask_sensitive(key: &str, value: &str) -> String {
  let lower = key.to_lowercase();
  if lower.contains("key") || lower.contains("secret") || lower.contains("token") || lower.contains("password") {
    if value.len() > 8 {
      let visible: String = value.chars().take(4).collect();
      format!("{visible}****<masked>")
    } else {
      "<masked>".to_string()
    }
  } else {
    value.to_string()
  }
}
