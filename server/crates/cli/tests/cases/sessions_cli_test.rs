// SPDX-License-Identifier: AGPL-3.0-or-later
//! Binary-level regression coverage for `sessions list` and PostgreSQL INET.

use crate::support;

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;
use uuid::Uuid;

async fn cleanup_user(pool: &PgPool, user_id: Uuid) -> Result<()> {
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await?;
  Ok(())
}

#[tokio::test]
async fn sessions_list_serializes_present_and_missing_inet_values() -> Result<()> {
  let pool = PgPoolOptions::new()
    .max_connections(2)
    .connect(&database_url())
    .await
    .context("connect isolated CLI test database")?;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .context("apply CLI test migrations")?;

  let suffix = Uuid::new_v4();
  let user_id = Uuid::new_v4();
  let email = format!("sessions-cli-{suffix}@test.local");
  sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Sessions CLI Test')")
    .bind(user_id)
    .bind(&email)
    .execute(&pool)
    .await?;

  let result: Result<()> = async {
    let with_ip = Uuid::new_v4();
    let without_ip = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO sessions (id, user_id, ip_address, user_agent, expires_at, refresh_after) \
       VALUES ($1, $2, '192.0.2.10'::inet, 'with-ip', now() + interval '1 day', now() + interval '1 hour'), \
              ($3, $2, NULL, 'without-ip', now() + interval '1 day', now() + interval '1 hour')",
    )
    .bind(with_ip)
    .bind(user_id)
    .bind(without_ip)
    .execute(&pool)
    .await?;

    let output = support::cli_command()
      .env("RUN_MODE", "development")
      .env("MYOXUS__DATABASE__URL", database_url())
      .env("MYOXUS__REDIS__URL", "redis://localhost:6380")
      .env("MYOXUS__REDIS__NAMESPACE", format!("myoxus:cli-test:{suffix}"))
      .env("RUST_LOG", "warn")
      .args(["--json", "sessions", "list", "--user", &email])
      .output()
      .context("run sessions list")?;
    ensure!(
      output.status.success(),
      "sessions list failed: {}",
      String::from_utf8_lossy(&output.stderr)
    );

    let rows: Vec<Value> = serde_json::from_slice(&output.stdout).context("parse sessions JSON")?;
    ensure!(rows.len() == 2, "expected two active sessions, got {}", rows.len());
    let present = rows
      .iter()
      .find(|row| row["session_id"] == with_ip.to_string())
      .context("session with IP")?;
    let missing = rows
      .iter()
      .find(|row| row["session_id"] == without_ip.to_string())
      .context("session without IP")?;
    // PostgreSQL's canonical text representation preserves the INET prefix.
    ensure!(present["ip_address"] == "192.0.2.10/32");
    ensure!(missing["ip_address"] == "");
    Ok(())
  }
  .await;

  cleanup_user(&pool, user_id).await?;
  result
}

#[tokio::test]
async fn sessions_revoke_uses_shared_auth_cache_fence_and_keeps_output_contract() -> Result<()> {
  use myoxus_application::auth::{AuthService, SessionContext};
  use myoxus_application::ports::RedisPort;
  use std::sync::Arc;
  let pool = PgPoolOptions::new().max_connections(2).connect(&database_url()).await?;
  myoxus_infrastructure::migrations::run(&pool).await?;
  let namespace = format!("myoxus:session-revoke-test:{}", Uuid::new_v4());
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6380".into());
  let redis = Arc::new(myoxus_infrastructure::redis::RedisAdapter::from_client(
    myoxus_infrastructure::tls::redis::client(&redis_url, None).map_err(anyhow::Error::msg)?,
    format!("{namespace}:session"),
  ));
  let storage_dir = tempfile::tempdir()?;
  let auth = AuthService::new(
    Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
    Arc::new(myoxus_infrastructure::mail::LogMailAdapter),
    Arc::new(myoxus_infrastructure::storage::StorageAdapter::new_fs(
      storage_dir.path().to_str().context("storage path")?,
    )?),
    86400,
    3600,
  )
  .with_session_cache(redis.clone(), 300);
  let email = format!("revoke-cli-{}@test.local", Uuid::new_v4());
  let user = auth.store.fulfill_user(&email, None, None).await?;
  let failure_function = format!("session_revoke_failure_{}", user.id.simple());
  let failure_trigger = format!("session_revoke_trigger_{}", user.id.simple());
  let mut sessions = Vec::new();
  let result: Result<()> = async {
    for _ in 0..3 {
      let session = auth.create_user_session(user.id, SessionContext { user_agent: None, ip_address: None }).await?;
      sessions.push(session.id);
      ensure!(auth.get_session_snapshot(session.id).await?.is_some());
      ensure!(redis.get_string(&format!("auth:session_snapshot:{}", session.id)).await?.is_some());
    }
    let run = |arguments: &[&str]| -> Result<Value> {
      let output = support::cli_command()
        .env("RUN_MODE", "development")
        .env("MYOXUS__DATABASE__URL", database_url())
        .env("MYOXUS__REDIS__URL", &redis_url)
        .env("MYOXUS__REDIS__NAMESPACE", &namespace)
        .env("RUST_LOG", "warn")
        .args(["--json", "sessions", "revoke"]).args(arguments).output()?;
      ensure!(output.status.success(), "CLI revoke: {}", String::from_utf8_lossy(&output.stderr));
      Ok(serde_json::from_slice(&output.stdout)?)
    };
    sqlx::query(&format!(
      "CREATE FUNCTION {failure_function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
       IF NEW.user_id = '{}'::uuid THEN RAISE EXCEPTION 'intentional session revoke rollback'; END IF; RETURN NEW; END; $$", user.id
    )).execute(&pool).await?;
    sqlx::query(&format!("CREATE TRIGGER {failure_trigger} BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION {failure_function}()"))
      .execute(&pool).await?;
    ensure!(run(&["--user", &email]).is_err(), "injected DB failure must abort CLI revocation");
    for session in &sessions { ensure!(auth.get_session_snapshot(*session).await?.is_some(), "rolled-back revoke preserves valid credentials"); }
    sqlx::query(&format!("DROP TRIGGER {failure_trigger} ON sessions")).execute(&pool).await?;
    sqlx::query(&format!("DROP FUNCTION {failure_function}()")).execute(&pool).await?;
    let first = sessions[0].to_string();
    let output = run(&[&first])?;
    ensure!(output[0]["revoked_count"] == 1 && output[0]["target"] == first);
    ensure!(auth.get_session_snapshot(sessions[0]).await?.is_none(), "warm snapshot cannot authenticate");
    for session in &sessions[1..] { ensure!(auth.get_session_snapshot(*session).await?.is_some(), "single revoke preserves peers"); }
    ensure!(run(&[&first])?[0]["revoked_count"] == 0);
    ensure!(run(&[&Uuid::new_v4().to_string()])?[0]["revoked_count"] == 0);
    ensure!(run(&["--user", "unknown-session-owner@test.local"])?[0]["revoked_count"] == 0);
    ensure!(run(&["--user", &email])?[0]["revoked_count"] == 2);
    for session in &sessions {
      ensure!(auth.get_session_snapshot(*session).await?.is_none());
      let revoked: bool = sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM sessions WHERE id=$1").bind(session).fetch_one(&pool).await?;
      ensure!(revoked, "persisted session revoke");
    }
    Ok(())
  }.await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {failure_trigger} ON sessions"))
    .execute(&pool)
    .await?;
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {failure_function}()"))
    .execute(&pool)
    .await?;
  cleanup_user(&pool, user.id).await?;
  for session in sessions {
    redis.delete_key(&format!("auth:session_snapshot:{session}")).await?;
  }
  redis
    .delete_key(&format!("auth:user_session_epoch:{}", user.id))
    .await?;
  result
}
