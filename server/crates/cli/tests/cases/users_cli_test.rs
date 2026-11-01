// SPDX-License-Identifier: AGPL-3.0-or-later
//! Binary-level regression coverage for secure user credential operations.

use crate::support;

use std::io::Write;
use std::process::{Output, Stdio};

use anyhow::{Context, Result, ensure};
use myoxus_application::auth::verify_password_hash;
use myoxus_application::ports::RedisPort;
use myoxus_infrastructure::redis::RedisAdapter;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;
use uuid::Uuid;

const DEFAULT_REDIS_URL: &str = "redis://localhost:6380";

fn redis_url() -> String {
  std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| DEFAULT_REDIS_URL.to_string())
}

fn cli_command(args: &[&str], redis_namespace: &str) -> support::CliCommand {
  let mut command = support::cli_command();
  command
    .env("RUN_MODE", "development")
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__REDIS__URL", redis_url())
    .env("MYOXUS__REDIS__NAMESPACE", redis_namespace)
    .env("MYOXUS__SERVER__ORIGIN", "https://cli-test.myoxus.invalid")
    .env("RUST_LOG", "warn")
    .args(args);
  command
}

fn run_cli(args: &[&str], redis_namespace: &str) -> Result<Output> {
  cli_command(args, redis_namespace).output().context("run myoxus-cli")
}

fn output_text(output: &Output) -> (String, String) {
  (
    String::from_utf8_lossy(&output.stdout).into_owned(),
    String::from_utf8_lossy(&output.stderr).into_owned(),
  )
}

fn ensure_success(output: &Output) -> Result<()> {
  let (stdout, stderr) = output_text(output);
  ensure!(
    output.status.success(),
    "CLI failed with {}\nstdout: {stdout}\nstderr: {stderr}",
    output.status
  );
  Ok(())
}

fn run_set_password_stdin(identity: &str, password: &str, redis_namespace: &str) -> Result<(Output, Vec<u8>)> {
  let mut command = cli_command(
    &["users", "set-password", identity, "--password-stdin"],
    redis_namespace,
  );
  let mut child = command
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .context("spawn myoxus-cli set-password")?;

  #[cfg(target_os = "linux")]
  let process_args = std::fs::read(format!("/proc/{}/cmdline", child.id())).context("read CLI process argv")?;
  #[cfg(not(target_os = "linux"))]
  let process_args = Vec::new();

  child
    .stdin
    .take()
    .context("CLI password stdin")?
    .write_all(format!("{password}\n").as_bytes())
    .context("write CLI password stdin")?;
  let output = child.wait_with_output().context("wait for myoxus-cli set-password")?;
  Ok((output, process_args))
}

async fn cleanup_user(pool: &PgPool, email: &str, committed_user_id: Option<Uuid>) -> Result<()> {
  let user_id = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email = $1")
    .bind(email)
    .fetch_optional(pool)
    .await?;
  let Some(user_id) = committed_user_id.or(user_id) else {
    return Ok(());
  };
  sqlx::query("DELETE FROM admin_audit_log WHERE target_type = 'user' AND target_id = $1")
    .bind(user_id.to_string())
    .execute(pool)
    .await?;
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await?;
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await?;
  Ok(())
}

#[tokio::test]
async fn user_cli_secure_password_lifecycle_is_binary_and_store_backed() {
  let pool = PgPoolOptions::new()
    .max_connections(4)
    .connect(&database_url())
    .await
    .expect("connect isolated CLI test database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("apply CLI test migrations");

  let suffix = Uuid::new_v4();
  let email = format!("office-cli-{suffix}@test.local");
  let redis_namespace = format!("myoxus:cli-test:{suffix}");
  let session_namespace = format!("{redis_namespace}:session");
  let redis = RedisAdapter::new(redis_url(), session_namespace).expect("test Redis adapter");
  let previous_policy =
    sqlx::query_scalar::<_, Value>("SELECT value FROM app_configs WHERE id = 'auth.password_requirements'")
      .fetch_optional(&pool)
      .await
      .expect("read prior password policy");
  let previous_reset_ttl =
    sqlx::query_scalar::<_, Value>("SELECT value FROM app_configs WHERE id = 'auth.password_reset_ttl_seconds'")
      .fetch_optional(&pool)
      .await
      .expect("read prior password-reset TTL");
  sqlx::query(
    "INSERT INTO app_configs (id, value) VALUES ('auth.password_reset_ttl_seconds', '600'::jsonb) \
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
  )
  .execute(&pool)
  .await
  .expect("set test password-reset TTL");

  let mut fixture_user_id = None;
  let result: Result<()> = async {
    let create = run_cli(
      &[
        "--json",
        "users",
        "create",
        "--email",
        &email,
        "--name",
        "Office CLI Test",
      ],
      &redis_namespace,
    )?;
    ensure_success(&create)?;
    let created: Value = serde_json::from_slice(&create.stdout).context("parse users create JSON")?;
    ensure!(created.get("generated_password").is_none());
    ensure!(created.get("password").is_none());

    let user_id = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email = $1")
      .bind(&email)
      .fetch_one(&pool)
      .await?;
    fixture_user_id = Some(user_id);
    let persisted_created_at = sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>("SELECT created_at FROM users WHERE id = $1")
      .bind(user_id).fetch_one(&pool).await?;
    ensure!(created["user"]["created_at"] == persisted_created_at.to_rfc3339(), "create output must read the persisted timestamp");
    let root_exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM workspaces w JOIN docs d ON d.workspace_id = w.id AND d.is_workspace_root WHERE w.owner_user_id = $1 AND w.is_personal_workspace AND EXISTS (SELECT 1 FROM doc_updates u WHERE u.workspace_id = w.id AND octet_length(u.payload) > 0))")
      .bind(user_id).fetch_one(&pool).await?;
    ensure!(root_exists, "created personal workspace must contain an initialized root");
    let missing_policies: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM workspaces w CROSS JOIN template_default_policies dp \
       JOIN template_catalog_entries c ON c.id = dp.template_id \
       WHERE w.owner_user_id = $1 AND w.is_personal_workspace \
       AND dp.apply_to_new_workspaces AND c.status = 'active' \
       AND NOT EXISTS (SELECT 1 FROM workspace_template_policies p WHERE p.workspace_id = w.id AND p.template_id = dp.template_id)"
    ).bind(user_id).fetch_one(&pool).await?;
    ensure!(missing_policies == 0, "CLI creation must seed active default template policies");
    let password_hash = sqlx::query_scalar::<_, Option<String>>("SELECT password_hash FROM users WHERE id = $1")
      .bind(user_id)
      .fetch_one(&pool)
      .await?;
    ensure!(password_hash.is_none(), "users create must remain passwordless");
    let workspace_count = sqlx::query_scalar::<_, i64>(
      "SELECT COUNT(*) FROM workspaces w JOIN workspace_memberships m ON m.workspace_id = w.id \
       WHERE w.owner_user_id = $1 AND m.user_id = $1 AND m.role = 'Owner' AND m.status = 'Accepted'",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await?;
    ensure!(
      workspace_count == 1,
      "users create must provision one personal workspace"
    );

    sqlx::query(
      "INSERT INTO app_configs (id, value) VALUES ('auth.password_requirements', $1) \
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(json!({ "min": 12, "max": 64 }))
    .execute(&pool)
    .await?;

    let rejected = run_set_password_stdin(&email, "too-short", &redis_namespace)?.0;
    let (rejected_stdout, rejected_stderr) = output_text(&rejected);
    ensure!(
      !rejected.status.success(),
      "password below the persisted policy must fail"
    );
    ensure!(rejected_stdout.is_empty());
    ensure!(rejected_stderr.contains("at least 12 characters"));
    let password_hash = sqlx::query_scalar::<_, Option<String>>("SELECT password_hash FROM users WHERE id = $1")
      .bind(user_id)
      .fetch_one(&pool)
      .await?;
    ensure!(password_hash.is_none(), "policy failure must not mutate the hash");

    let session_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO sessions (id, user_id, expires_at, refresh_after) \
       VALUES ($1, $2, now() + interval '1 day', now() + interval '1 hour')",
    )
    .bind(session_id)
    .bind(user_id)
    .execute(&pool)
    .await?;
    let snapshot_key = format!("auth:session_snapshot:{session_id}");
    redis
      .set_string(&snapshot_key, "stale-session-snapshot", Some(300))
      .await?;

    let password = format!("CLI-PASSWORD-SENTINEL-{suffix}");
    let (updated, process_args) = run_set_password_stdin(&email, &password, &redis_namespace)?;
    ensure_success(&updated)?;
    let (stdout, stderr) = output_text(&updated);
    ensure!(!stdout.contains(&password));
    ensure!(!stderr.contains(&password));
    ensure!(
      !process_args
        .windows(password.len())
        .any(|window| window == password.as_bytes())
    );

    let stored_hash = sqlx::query_scalar::<_, Option<String>>("SELECT password_hash FROM users WHERE id = $1")
      .bind(user_id)
      .fetch_one(&pool)
      .await?
      .context("password hash after set-password")?;
    ensure!(verify_password_hash(&stored_hash, &password));
    let revoked_at =
      sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>("SELECT revoked_at FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_one(&pool)
        .await?;
    ensure!(revoked_at.is_some(), "password update must revoke database sessions");
    ensure!(redis.get_string(&snapshot_key).await?.is_none());

    let file_password = format!("CLI-FILE-PASSWORD-{suffix}");
    let mut password_file = tempfile::NamedTempFile::new()?;
    password_file.write_all(format!("{file_password}\n").as_bytes())?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(password_file.path(), std::fs::Permissions::from_mode(0o600))?;
    }
    let file_update = run_cli(
      &[
        "users",
        "set-password",
        &email,
        "--password-file",
        password_file.path().to_str().context("password file path")?,
      ],
      &redis_namespace,
    )?;
    ensure_success(&file_update)?;
    let (file_stdout, file_stderr) = output_text(&file_update);
    ensure!(!file_stdout.contains(&file_password));
    ensure!(!file_stderr.contains(&file_password));
    let stored_hash = sqlx::query_scalar::<_, Option<String>>("SELECT password_hash FROM users WHERE id = $1")
      .bind(user_id)
      .fetch_one(&pool)
      .await?
      .context("password hash after file update")?;
    ensure!(verify_password_hash(&stored_hash, &file_password));

    let reset_link = run_cli(&["--json", "users", "reset-link", &email], &redis_namespace)?;
    ensure_success(&reset_link)?;
    let reset_link: Value = serde_json::from_slice(&reset_link.stdout)?;
    let reset_link = reset_link["reset_link"].as_str().context("reset_link JSON field")?;
    ensure!(reset_link.starts_with("https://cli-test.myoxus.invalid/"));
    ensure!(!reset_link.contains("callback="));
    let reset_url = reqwest::Url::parse(reset_link)?;
    let reset_token = reset_url.query_pairs().find(|(key, _)| key == "token")
      .map(|(_, value)| value.into_owned()).context("reset token in authorized link")?;
    let reset_audits: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(a) FROM admin_audit_log a WHERE target_id = $1 AND event_key = 'user.reset-link-created'")
      .bind(user_id.to_string()).fetch_all(&pool).await?;
    ensure!(reset_audits.len() == 1, "reset issuance must audit once");
    ensure!(reset_audits[0]["actor_kind"] == "system" && reset_audits[0]["metadata"]["source"] == "cli");
    let reset_audit = serde_json::to_string(&reset_audits)?;
    ensure!(!reset_audit.contains(reset_link) && !reset_audit.contains(&reset_token), "reset audit must contain no credential");
    let reset_expiry = sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
      "SELECT expires_at FROM verification_tokens WHERE user_id = $1 AND kind = 'ChangePassword' \
       ORDER BY created_at DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_one(&pool)
    .await?;
    let remaining_seconds = (reset_expiry - chrono::Utc::now()).num_seconds();
    ensure!(
      (595..=600).contains(&remaining_seconds),
      "reset link must use the persisted 600-second TTL, got {remaining_seconds}"
    );

    let storage_dir = tempfile::tempdir()?;
    let auth = myoxus_application::auth::AuthService::new(
      std::sync::Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
      std::sync::Arc::new(myoxus_infrastructure::mail::LogMailAdapter),
      std::sync::Arc::new(myoxus_infrastructure::storage::StorageAdapter::new_fs(storage_dir.path().to_str().context("temporary auth storage path")?)?),
      86_400, 3_600,
    ).with_session_cache(std::sync::Arc::new(redis.clone()), 300);
    let context = || myoxus_application::auth::SessionContext { user_agent: None, ip_address: None };
    let signed_in = auth.sign_in(&email, Some(&file_password), context()).await?;
    let myoxus_application::auth::SignInResult::PasswordSignIn { session, .. } = signed_in else {
      anyhow::bail!("password sign-in must create a session");
    };
    let active_session = session.id;
    let active_snapshot_key = format!("auth:session_snapshot:{active_session}");
    ensure!(auth.get_session_snapshot(active_session).await?.is_some());
    ensure!(redis.get_string(&active_snapshot_key).await?.is_some(), "warm a valid session snapshot");
    ensure_success(&run_cli(&["users","set-admin",&email,"--admin","true"],&redis_namespace)?)?;
    ensure!(auth.get_session_snapshot(active_session).await?.context("granted snapshot")?.user.is_admin);
    ensure!(redis.get_string(&active_snapshot_key).await?.is_some(),"prime Admin snapshot before CLI demotion");
    ensure_success(&run_cli(&["users","set-admin",&email,"--admin","false"],&redis_namespace)?)?;
    ensure!(!auth.get_session_snapshot(active_session).await?.context("demoted snapshot")?.user.is_admin,"CLI must refresh warm Admin authority");
    let retained: (Option<chrono::DateTime<chrono::Utc>>,chrono::DateTime<chrono::Utc>) = sqlx::query_as("SELECT revoked_at,expires_at FROM sessions WHERE id=$1").bind(active_session).fetch_one(&pool).await?;
    ensure!(retained.0.is_none() && retained.1==session.expires_at,"role changes retain session validity and expiry");
    let role_audits: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(a) FROM admin_audit_log a WHERE target_id=$1 AND event_key='user.admin-role-set'").bind(user_id.to_string()).fetch_all(&pool).await?;
    ensure!(role_audits.len()==2 && role_audits.iter().all(|a|a["actor_kind"]=="system" && a["metadata"]["source"]=="cli"),"shared CLI role audit exactly once per commit");
    let keys = myoxus_application::api_key::ApiKeyService::new(std::sync::Arc::new(
      myoxus_infrastructure::api_key::SqlxApiKeyStore::new(pool.clone())
    ));
    let (_, old_key) = keys.generate(user_id, "CLI suspension fixture".to_string(), vec!["read:docs".to_string()], None).await?;
    ensure!(keys.authenticate(&old_key).await.is_ok());
    let disabled = run_cli(&["users", "disable", &email], &redis_namespace)?;
    ensure_success(&disabled)?;
    let get = run_cli(&["--json", "users", "get", &email], &redis_namespace)?;
    ensure_success(&get)?;
    let get: Value = serde_json::from_slice(&get.stdout)?;
    ensure!(get["status"] == "disabled");
    let revoked: bool = sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM sessions WHERE id = $1")
      .bind(active_session).fetch_one(&pool).await?;
    ensure!(revoked, "CLI suspension must revoke sessions");
    ensure!(redis.get_string(&active_snapshot_key).await?.is_none(), "CLI suspension must evict warm snapshots");
    ensure!(keys.authenticate(&old_key).await.is_err(), "CLI suspension must delete existing MCP credentials");
    ensure!(auth.get_session_snapshot(active_session).await?.is_none(), "warm session must not authenticate after CLI suspension");
    ensure!(matches!(auth.sign_in(&email, Some(&file_password), context()).await,
      Err(myoxus_application::auth::AuthError::WrongSignInCredentials)), "suspended password sign-in must fail");
    let enabled = run_cli(&["users", "enable", &user_id.to_string()], &redis_namespace)?;
    ensure_success(&enabled)?;
    let get = run_cli(&["--json", "users", "get", &email], &redis_namespace)?;
    ensure_success(&get)?;
    let get: Value = serde_json::from_slice(&get.stdout)?;
    ensure!(get["status"] == "active");
    let revoked: bool = sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM sessions WHERE id = $1")
      .bind(active_session).fetch_one(&pool).await?;
    ensure!(revoked && keys.authenticate(&old_key).await.is_err(), "enable must never resurrect credentials");
    let (_, new_key) = keys.generate(user_id, "CLI enabled fixture".to_string(), vec!["read:docs".to_string()], None).await?;
    ensure!(keys.authenticate(&new_key).await.is_ok(), "enabled accounts can acquire fresh credentials");
    ensure!(matches!(auth.sign_in(&email, Some(&file_password), context()).await?,
      myoxus_application::auth::SignInResult::PasswordSignIn { .. }), "enable permits fresh password sign-in");
    ensure!(auth.get_session_snapshot(active_session).await?.is_none(), "enable must not revive the old warm session");
    for event in ["user.disable", "user.enable"] {
      let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admin_audit_log WHERE target_id = $1 AND event_key = $2 AND actor_kind = 'system' AND metadata->>'source' = 'cli'")
        .bind(user_id.to_string()).bind(event).fetch_one(&pool).await?;
      ensure!(events == 1, "shared CLI status audit must occur exactly once");
    }

    let delete_session = auth.create_user_session(user_id, context()).await?;
    ensure!(auth.get_session_snapshot(delete_session.id).await?.is_some(), "prime before CLI account deletion");
    let sole_ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM workspaces WHERE owner_user_id=$1").bind(user_id).fetch_all(&pool).await?;
    ensure!(!sole_ids.is_empty(), "canonical sole-owner workspace exists before deletion");
    let refused=run_cli(&["users","delete",&email],&redis_namespace)?;
    ensure!(!refused.status.success(), "CLI confirmation remains mandatory");
    ensure!(auth.get_session_snapshot(delete_session.id).await?.is_some(), "unconfirmed deletion leaves credentials usable");
    let deleted=run_cli(&["users","delete",&email,"--confirm"],&redis_namespace)?;
    ensure_success(&deleted)?;
    ensure!(output_text(&deleted).0.contains("permanently deleted"), "permanent account deletion output is truthful");
    ensure!(auth.get_session_snapshot(delete_session.id).await?.is_none(), "CLI permanent account deletion evicts warm identity");
    ensure!(keys.authenticate(&new_key).await.is_err(), "CLI permanent account deletion removes MCP credentials");
    ensure!(auth.get_user_by_id(user_id).await?.is_none());
    let retained=sqlx::query_as::<_,(String,String,String,bool,Option<String>,Option<String>)>("SELECT status,email,name,is_admin,password_hash,avatar_key FROM users WHERE id=$1").bind(user_id).fetch_one(&pool).await?;
    ensure!(retained.0=="deleted" && retained.1==format!("deleted:{user_id}") && !retained.3 && retained.4.is_none() && retained.5.is_none());
    let retained_id=user_id.to_string();
    for args in [vec!["users","enable",&retained_id],vec!["users","get",&retained_id]] {
      ensure!(!run_cli(&args,&redis_namespace)?.status.success(), "terminal identity is not an operational account");
    }
    ensure!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspaces WHERE id=ANY($1)").bind(&sole_ids).fetch_one(&pool).await?==0,"sole-owner workspaces cascade");
    ensure!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM docs WHERE workspace_id=ANY($1)").bind(&sole_ids).fetch_one(&pool).await?==0,"sole-owner content cascades");
    let deleted_audits:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(a) FROM admin_audit_log a WHERE target_id=$1 AND event_key='user.delete'").bind(user_id.to_string()).fetch_all(&pool).await?;
    ensure!(deleted_audits.len()==1 && deleted_audits[0]["actor_kind"]=="system" && deleted_audits[0]["metadata"]["source"]=="cli");
    ensure!(deleted_audits[0]["target_label"]==retained.2 && !deleted_audits[0].to_string().contains(&email), "deletion audit retains the name without old email");

    Ok(())
  }
  .await;

  if let Some(policy) = previous_policy {
    sqlx::query("UPDATE app_configs SET value = $1, updated_at = now() WHERE id = 'auth.password_requirements'")
      .bind(policy)
      .execute(&pool)
      .await
      .expect("restore password policy");
  } else {
    sqlx::query("DELETE FROM app_configs WHERE id = 'auth.password_requirements'")
      .execute(&pool)
      .await
      .expect("remove test password policy");
  }
  if let Some(ttl) = previous_reset_ttl {
    sqlx::query("UPDATE app_configs SET value = $1, updated_at = now() WHERE id = 'auth.password_reset_ttl_seconds'")
      .bind(ttl)
      .execute(&pool)
      .await
      .expect("restore password-reset TTL");
  } else {
    sqlx::query("DELETE FROM app_configs WHERE id = 'auth.password_reset_ttl_seconds'")
      .execute(&pool)
      .await
      .expect("remove test password-reset TTL");
  }
  cleanup_user(&pool, &email, fixture_user_id)
    .await
    .expect("clean CLI test user");
  redis
    .delete_by_pattern("*")
    .await
    .expect("clear Redis state after secure CLI user lifecycle");

  result.expect("secure CLI user lifecycle");
}

#[test]
fn removed_secret_arguments_fail_without_echoing_values() {
  let password = "LEGACY-PASSWORD-SENTINEL-never-echo";
  let legacy_database_url_arg = "postgres://LEGACY-DATABASE-SENTINEL@example.invalid/myoxus";
  for args in [
    vec!["users", "set-password", "user@example.test", password],
    vec![
      "users",
      "create",
      "--email",
      "user@example.test",
      "--name",
      "User",
      "--password",
      password,
    ],
    vec!["--database-url", legacy_database_url_arg, "users", "list"],
  ] {
    let output = support::cli_command()
      .args(args)
      .output()
      .expect("run rejected legacy CLI command");
    let (stdout, stderr) = output_text(&output);
    assert!(!output.status.success());
    assert!(!stdout.contains(password));
    assert!(!stderr.contains(password));
    assert!(!stdout.contains(legacy_database_url_arg));
    assert!(!stderr.contains(legacy_database_url_arg));
  }
}

#[tokio::test]
async fn user_cli_exact_discovery_and_unpaged_list_exceed_old_scan_caps() {
  let pool = PgPoolOptions::new()
    .max_connections(4)
    .connect(&database_url())
    .await
    .expect("isolated CLI database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("CLI test migrations");
  let suffix = Uuid::new_v4();
  let marker = format!("discovery-{suffix}");
  let target_email = format!("{marker}@test.local");
  let target_id = Uuid::new_v4();
  let namespace = format!("myoxus:cli-test:{suffix}");
  let result: Result<()> = async {
    // Every decoy contains the target email as a substring. The target is also
    // older than all decoys, so both former capped scans necessarily miss it.
    sqlx::query("INSERT INTO users (id, email, name, status, created_at, updated_at) SELECT gen_random_uuid(), n::text || '-' || $1, $2, 'active', '2020-01-01'::timestamptz, '2020-01-01'::timestamptz FROM generate_series(1, 10101) n")
      .bind(&target_email).bind(&marker).execute(&pool).await?;
    sqlx::query("INSERT INTO users (id, email, name, status, created_at, updated_at) VALUES ($1, $2, $3, 'disabled', '2000-01-01'::timestamptz, '2000-01-02'::timestamptz)")
      .bind(target_id).bind(&target_email).bind(&marker).execute(&pool).await?;
    for identity in [target_id.to_string(), format!("  {}  ", target_email.to_uppercase())] {
      let output = run_cli(&["--json", "users", "get", &identity], &namespace)?;
      ensure_success(&output)?;
      let detail: Value = serde_json::from_slice(&output.stdout)?;
      ensure!(detail["id"] == target_id.to_string());
      ensure!(detail["status"] == "disabled");
      ensure!(detail["created_at"] == "2000-01-01T00:00:00+00:00");
      ensure!(detail["updated_at"] == "2000-01-02T00:00:00+00:00");
      ensure!(detail.get("password_hash").is_none());
    }
    let output = run_cli(&["--json", "users", "list", "--filter", &marker], &namespace)?;
    ensure_success(&output)?;
    let rows: Vec<Value> = serde_json::from_slice(&output.stdout)?;
    ensure!(rows.len() == 10102, "CLI must exhaust every page");
    ensure!(rows.last().context("last account")?["id"] == target_id.to_string());
    let mut ids = Vec::new();
    for row in &rows[..10101] {
      ensure!(row.get("password_hash").is_none());
      ids.push(Uuid::parse_str(row["id"].as_str().context("public ID")?)?);
    }
    ensure!(ids.windows(2).all(|pair| pair[0] < pair[1]), "timestamp ties need stable unique ordering");
    let missing = run_cli(&["--json", "users", "get", &Uuid::new_v4().to_string()], &namespace)?;
    ensure!(!missing.status.success());
    ensure!(output_text(&missing).1.contains("User not found"));
    Ok(())
  }.await;
  sqlx::query("DELETE FROM users WHERE name = $1")
    .bind(&marker)
    .execute(&pool)
    .await
    .expect("remove all discovery fixtures on success or failure");
  let store = myoxus_infrastructure::admin::SqlxAdminStore::new(pool.clone());
  pool.close().await;
  assert!(
    matches!(
      myoxus_application::admin::AdminStore::get_user_by_id(&store, target_id).await,
      Err(myoxus_application::auth::AuthError::Storage(_))
    ),
    "an unavailable store must not become a missing identity"
  );
  result.expect("exact discovery and full list contract");
}
