//! `sessions` subcommand — list and revoke active user sessions.

use clap::{Args, Subcommand};
use myoxus_application::auth::{AuthService, SessionRevocationTarget};
use serde::Serialize;
use sqlx::PgPool;
use tabled::Tabled;

use crate::output::{print_json, print_output, print_table};

/// Subcommands for `sessions`.
#[derive(Subcommand)]
pub enum SessionsCommand {
  /// List active (non-revoked, non-expired) sessions.
  List(ListArgs),
  /// Revoke one or more sessions by ID, by user, or all at once.
  Revoke(RevokeArgs),
}

/// Arguments for `sessions list`.
#[derive(Args)]
pub struct ListArgs {
  /// Filter by user email or UUID; if omitted lists all active sessions.
  #[arg(long)]
  pub user: Option<String>,
}

/// Arguments for `sessions revoke`.
#[derive(Args)]
pub struct RevokeArgs {
  /// Revoke a single session by its UUID.
  #[arg(conflicts_with_all = ["user", "all"])]
  pub session_id: Option<String>,

  /// Revoke all active sessions for the given user email or UUID.
  #[arg(long, conflicts_with_all = ["session_id", "all"])]
  pub user: Option<String>,

  /// Revoke every active session in the system.
  #[arg(long, conflicts_with_all = ["session_id", "user"])]
  pub all: bool,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// Active session row returned by `sessions list`.
#[derive(Tabled, Serialize)]
pub struct SessionRow {
  /// Session UUID.
  pub session_id: String,
  /// Email address of the owning user.
  pub email: String,
  /// Remote IP address recorded at login (may be empty).
  pub ip_address: String,
  /// User-Agent string recorded at login (may be empty).
  pub user_agent: String,
  /// When the session was created (RFC-3339).
  pub created_at: String,
  /// When the session expires, or "never" if no expiry set.
  pub expires_at: String,
}

/// Result row for a revoke operation.
#[derive(Tabled, Serialize)]
pub struct RevokeResultRow {
  /// Short label for what was targeted.
  pub target: String,
  /// Number of sessions that were revoked.
  pub revoked_count: i64,
  /// Human-readable outcome message.
  pub message: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `sessions` subcommand.
pub async fn run(cmd: SessionsCommand, pool: &PgPool, auth: &AuthService, json: bool) -> anyhow::Result<()> {
  match cmd {
    SessionsCommand::List(args) => list(args, pool, json).await,
    SessionsCommand::Revoke(args) => revoke(args, auth, json).await,
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

type SessionListRow = (String, String, Option<String>, Option<String>, String, Option<String>);

async fn list(args: ListArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let filter = args.user.as_deref();

  let raw: Vec<SessionListRow> = sqlx::query_as(
    r#"SELECT
           s.id::text                        AS session_id,
           u.email                           AS email,
           s.ip_address::text                AS ip_address,
           s.user_agent                      AS user_agent,
           s.created_at::text                AS created_at,
           s.expires_at::text                AS expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.revoked_at IS NULL
           AND (s.expires_at IS NULL OR s.expires_at > NOW())
           AND ($1::text IS NULL OR u.email = $1 OR u.id::text = $1)
         ORDER BY s.created_at DESC
         LIMIT 100"#,
  )
  .bind(filter)
  .fetch_all(pool)
  .await?;

  let rows: Vec<SessionRow> = raw
    .into_iter()
    .map(
      |(session_id, email, ip_address, user_agent, created_at, expires_at)| SessionRow {
        session_id,
        email,
        ip_address: ip_address.unwrap_or_default(),
        user_agent: user_agent.unwrap_or_default(),
        created_at,
        expires_at: expires_at.unwrap_or_else(|| "never".to_string()),
      },
    )
    .collect();

  print_output(&rows, json);
  Ok(())
}

async fn revoke(args: RevokeArgs, auth: &AuthService, json: bool) -> anyhow::Result<()> {
  let rows: Vec<RevokeResultRow> = if let Some(ref sid) = args.session_id {
    let count = auth
      .revoke_sessions(SessionRevocationTarget::Session(sid.parse()?))
      .await?
      .revoked_count as i64;
    let message = if count == 1 {
      format!("Session {sid} revoked.")
    } else {
      format!("Session {sid} not found or already revoked.")
    };

    vec![RevokeResultRow {
      target: sid.clone(),
      revoked_count: count,
      message,
    }]
  } else if let Some(ref user_filter) = args.user {
    let count = auth
      .revoke_sessions(SessionRevocationTarget::User(user_filter.clone()))
      .await?
      .revoked_count as i64;
    vec![RevokeResultRow {
      target: user_filter.clone(),
      revoked_count: count,
      message: format!("{count} session(s) revoked for user '{user_filter}'."),
    }]
  } else if args.all {
    let count = auth.revoke_sessions(SessionRevocationTarget::All).await?.revoked_count as i64;
    vec![RevokeResultRow {
      target: "(all)".to_string(),
      revoked_count: count,
      message: format!("{count} session(s) revoked globally."),
    }]
  } else {
    anyhow::bail!("Provide a session UUID, --user <email|uuid>, or --all to specify what to revoke.");
  };

  if json {
    print_json(&rows);
  } else {
    print_table(&rows);
  }
  Ok(())
}
