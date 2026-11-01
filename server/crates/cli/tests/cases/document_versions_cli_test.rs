//! Integration coverage for `myoxus-cli doc versions`.
//!
//! The test drives the compiled CLI binary against the test PostgreSQL
//! database and cleans all rows it creates in FK-safe order.

use crate::support;

use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;
use uuid::Uuid;

async fn setup_pool() -> PgPool {
  PgPoolOptions::new()
    .max_connections(3)
    .connect(&database_url())
    .await
    .expect("connect test database")
}

fn run_cli(args: &[&str]) -> Value {
  let output = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .arg("--json")
    .args(args)
    .output()
    .expect("run myoxus-cli");
  assert!(
    output.status.success(),
    "CLI failed\nstatus: {}\nstdout: {}\nstderr: {}",
    output.status,
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  serde_json::from_slice(&output.stdout).expect("CLI stdout must be JSON")
}

async fn seed_user_workspace_doc(pool: &PgPool, suffix: &str) -> (Uuid, Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, $3, now())")
    .bind(user_id)
    .bind(format!("{suffix}-{user_id}@test.local"))
    .bind(format!("cli doc versions {suffix}"))
    .execute(pool)
    .await
    .expect("insert user");

  let workspace_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO workspaces (id, owner_user_id, name, public, enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding) \
     VALUES ($1, $2, $3, false, true, true, true, true)",
  )
  .bind(workspace_id)
  .bind(user_id)
  .bind(format!("ws-{workspace_id}"))
  .execute(pool)
  .await
  .expect("insert workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Owner', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert workspace membership");

  let doc_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by) \
     VALUES ($1, $2, $3, 'viewer', false, $4, $4)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(format!("doc-{doc_id}"))
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert doc");

  (user_id, workspace_id, doc_id)
}

async fn cleanup(pool: &PgPool, user_id: Uuid, workspace_id: Uuid) {
  sqlx::query("DELETE FROM document_version WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM document_versioning_settings WHERE doc_id IN (SELECT id FROM docs WHERE workspace_id = $1)")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM doc_histories WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .ok();
}

#[tokio::test]
async fn inv_cli_docver01_lifecycle_and_settings_are_db_backed() {
  let pool = setup_pool().await;
  let (user_id, workspace_id, doc_id) = seed_user_workspace_doc(&pool, "inv-cli-docver01").await;

  let default_settings = run_cli(&["doc", "versions", "settings", "show", "--doc", &doc_id.to_string()]);
  assert_eq!(
    default_settings.pointer("/enabled").and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    default_settings.pointer("/retention_count").and_then(Value::as_i64),
    Some(10)
  );
  assert_eq!(
    default_settings.pointer("/auto_version_on").and_then(Value::as_str),
    Some("on-pdf-export")
  );

  let updated_settings = run_cli(&[
    "doc",
    "versions",
    "settings",
    "set",
    "--doc",
    &doc_id.to_string(),
    "--enabled",
    "true",
    "--retention-count",
    "7",
    "--triggers",
    "on_publish,on_pdf_export",
  ]);
  assert_eq!(
    updated_settings.pointer("/enabled").and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    updated_settings.pointer("/retention_count").and_then(Value::as_i64),
    Some(7)
  );
  assert_eq!(
    updated_settings.pointer("/auto_version_on").and_then(Value::as_str),
    Some("on-publish,on-pdf-export")
  );

  let created = run_cli(&[
    "doc",
    "versions",
    "create",
    "--doc",
    &doc_id.to_string(),
    "--label",
    "cli-v1",
    "--description",
    "created by CLI invariant",
  ]);
  let version_id = created
    .pointer("/id")
    .and_then(Value::as_str)
    .and_then(|raw| Uuid::parse_str(raw).ok())
    .expect("created version id");
  let created_label = created
    .pointer("/label")
    .and_then(Value::as_str)
    .expect("server-authoritative version label");
  assert!(
    !created_label.is_empty(),
    "CLI create must return the server-authoritative label: {created}"
  );
  assert_eq!(created.pointer("/pinned").and_then(Value::as_bool), Some(false));
  assert_eq!(created.pointer("/event").and_then(Value::as_str), Some("manual"));
  assert_eq!(created.pointer("/kind").and_then(Value::as_str), Some("checkpoint"));
  assert_eq!(
    created.pointer("/is_current_document_version").and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    created
      .pointer("/current_version_id")
      .and_then(Value::as_str)
      .map(str::to_string),
    Some(version_id.to_string())
  );

  let listed = run_cli(&["doc", "versions", "list", "--doc", &doc_id.to_string()]);
  assert_eq!(listed.as_array().map(Vec::len), Some(1));
  assert_eq!(
    listed
      .pointer("/0/is_current_document_version")
      .and_then(Value::as_bool),
    Some(true)
  );

  let pinned = run_cli(&["doc", "versions", "pin", "--id", &version_id.to_string()]);
  assert_eq!(pinned.pointer("/pinned").and_then(Value::as_bool), Some(true));
  let unpinned = run_cli(&["doc", "versions", "unpin", "--id", &version_id.to_string()]);
  assert_eq!(unpinned.pointer("/pinned").and_then(Value::as_bool), Some(false));

  let restored = run_cli(&["doc", "versions", "restore", "--id", &version_id.to_string()]);
  assert!(
    restored
      .pointer("/label")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .starts_with(&format!("restore-from-{created_label}-")),
    "restore command must create a new restore-* label: {restored}"
  );
  assert_eq!(restored.pointer("/event").and_then(Value::as_str), Some("restore"));
  assert_eq!(restored.pointer("/kind").and_then(Value::as_str), Some("restored"));
  assert_eq!(
    restored
      .pointer("/is_current_document_version")
      .and_then(Value::as_bool),
    Some(true)
  );

  let version_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("count versions");
  let history_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("count histories");
  let recovery_history_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM doc_histories h
     LEFT JOIN document_version v ON v.doc_history_id = h.id
     WHERE h.workspace_id = $1 AND v.id IS NULL",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("count unnamed recovery histories");
  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("count doc updates");
  assert_eq!(version_count, 2, "create + restore must leave two version labels");
  assert_eq!(
    history_count, 3,
    "create + restore must retain the atomic recovery snapshot"
  );
  assert_eq!(
    recovery_history_count, 1,
    "restore must leave exactly one unnamed pre-restore recovery snapshot"
  );
  assert_eq!(update_count, 1, "restore must append exactly one doc update");

  cleanup(&pool, user_id, workspace_id).await;
}
