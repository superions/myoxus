//! Integration coverage for `myoxus-cli doc metadata`.
//!
//! The test drives the compiled CLI binary against PostgreSQL and removes every
//! row it creates. CLI paths intentionally use the same application services as
//! GraphQL/Web, so this acts as a contract test for operator automation.

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
  let output = cli_command(args).output().expect("run myoxus-cli");
  assert!(
    output.status.success(),
    "CLI failed\nstatus: {}\nstdout: {}\nstderr: {}",
    output.status,
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  serde_json::from_slice(&output.stdout).expect("CLI stdout must be JSON")
}

fn run_cli_failure(args: &[&str]) -> Value {
  let output = cli_command(args).output().expect("run myoxus-cli");
  assert!(
    !output.status.success(),
    "CLI unexpectedly succeeded\nstdout: {}\nstderr: {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  serde_json::from_slice(&output.stdout).expect("failed CLI stdout must still expose structured JSON")
}

fn cli_command(args: &[&str]) -> support::CliCommand {
  let mut command = support::cli_command();
  command
    .env("MYOXUS__DATABASE__URL", database_url())
    .arg("--json")
    .args(args);
  command
}

fn metadata_field<'a>(metadata: &'a Value, key: &str) -> &'a Value {
  metadata
    .pointer("/fields")
    .and_then(Value::as_array)
    .and_then(|fields| fields.iter().find(|field| field["key"] == key))
    .unwrap_or_else(|| panic!("metadata field {key} missing: {metadata}"))
}

async fn seed_user_workspace_docs(pool: &PgPool, suffix: &str) -> (Uuid, Uuid, Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, $3, now())")
    .bind(user_id)
    .bind(format!("{suffix}-{user_id}@test.local"))
    .bind(format!("cli doc metadata {suffix}"))
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

  let doc_id = insert_doc(pool, workspace_id, user_id, "good").await;
  let blocked_doc_id = insert_doc(pool, workspace_id, user_id, "blocked").await;
  (user_id, workspace_id, doc_id, blocked_doc_id)
}

async fn insert_doc(pool: &PgPool, workspace_id: Uuid, user_id: Uuid, label: &str) -> Uuid {
  let doc_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by) \
     VALUES ($1, $2, $3, 'viewer', false, $4, $4)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(format!("doc-{label}-{doc_id}"))
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert doc");
  doc_id
}

async fn create_required_transition_schema(
  pool: &PgPool,
  workspace_id: Uuid,
  user_id: Uuid,
  blocked_doc_id: Uuid,
) -> Uuid {
  let suffix = Uuid::new_v4().simple().to_string();
  let schema_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_status_schema (key, label, complexity, is_preset, is_active) \
     VALUES ($1, $2, 'custom', false, true) RETURNING id",
  )
  .bind(format!("cli_required_{suffix}"))
  .bind(format!("CLI required {suffix}"))
  .fetch_one(pool)
  .await
  .expect("insert custom status schema");
  let from_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_status_value (schema_id, key, label, sort_order) VALUES ($1, 'from', 'From', 10) RETURNING id",
  )
  .bind(schema_id)
  .fetch_one(pool)
  .await
  .expect("insert source status");
  let to_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_status_value (schema_id, key, label, sort_order) VALUES ($1, 'to', 'To', 20) RETURNING id",
  )
  .bind(schema_id)
  .fetch_one(pool)
  .await
  .expect("insert target status");
  sqlx::query(
    "INSERT INTO document_status_transition (from_status_id, to_status_id, required_metadata_fields) \
     VALUES ($1, $2, ARRAY['documentNumber']::text[])",
  )
  .bind(from_id)
  .bind(to_id)
  .execute(pool)
  .await
  .expect("insert required transition");
  sqlx::query(
    "INSERT INTO document_workspace_settings (workspace_id, status_schema_id, updated_by) \
     VALUES ($1, $2, $3) \
     ON CONFLICT (workspace_id) DO UPDATE SET status_schema_id = EXCLUDED.status_schema_id, updated_by = EXCLUDED.updated_by, updated_at = now()",
  )
  .bind(workspace_id)
  .bind(schema_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("set workspace status schema");
  sqlx::query(
    "UPDATE docs \
     SET status_id = $2, status_source = 'document', metadata_updated_by = $3 \
     WHERE id = $1",
  )
  .bind(blocked_doc_id)
  .bind(from_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("set blocked doc status");
  schema_id
}

async fn cleanup(pool: &PgPool, user_id: Uuid, workspace_id: Uuid, schema_id: Option<Uuid>) {
  sqlx::query("DELETE FROM document_workspace_settings WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  if let Some(schema_id) = schema_id {
    sqlx::query("DELETE FROM document_status_schema WHERE id = $1")
      .bind(schema_id)
      .execute(pool)
      .await
      .ok();
  }
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
async fn inv_cli_docmeta01_show_set_validate_and_transition_use_server_rules() {
  let pool = setup_pool().await;
  let (user_id, workspace_id, doc_id, blocked_doc_id) = seed_user_workspace_docs(&pool, "inv-cli-docmeta01").await;
  let mut schema_id = None;

  let result = async {
    let shown = run_cli(&["doc", "metadata", "show", "--doc", &doc_id.to_string()]);
    assert_eq!(
      shown.pointer("/doc_id").and_then(Value::as_str).map(str::to_string),
      Some(doc_id.to_string())
    );
    assert!(
      metadata_field(&shown, "status")
        .pointer("/reference/id")
        .and_then(Value::as_str)
        .is_some(),
      "show must expose canonical status: {shown}"
    );
    assert!(
      metadata_field(&shown, "version")
        .pointer("/text_value")
        .and_then(Value::as_str)
        .is_some(),
      "show must expose canonical version metadata field: {shown}"
    );

    let patched = run_cli(&[
      "doc",
      "metadata",
      "set",
      "--doc",
      &doc_id.to_string(),
      "--classification",
      "internal",
      "--type",
      "concept",
      "--review-due-at",
      "2026-07-01T00:00:00Z",
      "--document-number",
      "DOC-CLI-1",
      "--language",
      "de",
    ]);
    let patched_metadata = patched
      .pointer("/metadata")
      .expect("set must return native metadata projection");
    assert!(
      metadata_field(patched_metadata, "classification")
        .pointer("/reference/id")
        .and_then(Value::as_str)
        .is_some(),
      "set must persist classification via service: {patched}"
    );
    assert_eq!(
      metadata_field(patched_metadata, "documentNumber")
        .pointer("/text_value")
        .and_then(Value::as_str),
      Some("DOC-CLI-1")
    );
    assert_eq!(
      metadata_field(patched_metadata, "reviewDueAt")
        .pointer("/timestamp_value")
        .and_then(Value::as_str),
      Some("2026-07-01T00:00:00Z")
    );
    assert_eq!(
      patched_metadata.pointer("/metadata_revision").and_then(Value::as_i64),
      Some(1),
      "set must bump the native metadata revision exactly once: {patched}"
    );

    let validation = run_cli(&["doc", "metadata", "validate", "--doc", &doc_id.to_string()]);
    assert_eq!(
      validation.pointer("/errors").and_then(Value::as_array).map(Vec::len),
      Some(0)
    );

    schema_id = Some(create_required_transition_schema(&pool, workspace_id, user_id, blocked_doc_id).await);
    let blocked = run_cli_failure(&[
      "doc",
      "metadata",
      "transition",
      "--doc",
      &blocked_doc_id.to_string(),
      "--to",
      "to",
    ]);
    assert_eq!(
      blocked
        .pointer("/missing_required_metadata_fields")
        .and_then(Value::as_array)
        .and_then(|values| values.first())
        .and_then(Value::as_str),
      Some("documentNumber")
    );
    Ok::<(), anyhow::Error>(())
  }
  .await;

  cleanup(&pool, user_id, workspace_id, schema_id).await;
  result.expect("CLI document metadata invariant");
}
