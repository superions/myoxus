// SPDX-License-Identifier: AGPL-3.0-or-later
//! CLI contract for bounded projection inspection and exact repair.

use crate::support;

use std::sync::Arc;

use myoxus_application::{
  doc::{DocService, DocSpaceKind},
  workspace::WorkspaceService,
};
use myoxus_infrastructure::{doc::SqlxDocStore, workspace::SqlxWorkspaceStore};
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;
use uuid::Uuid;

fn cli_command(args: &[&str]) -> support::CliCommand {
  let mut command = support::cli_command();
  command
    .env("MYOXUS__DATABASE__URL", database_url())
    .arg("--json")
    .args(args);
  command
}

fn run_cli(args: &[&str]) -> Value {
  // Projection commands must not capture the unrelated HTML catalog.
  let root = tempfile::tempdir().expect("non-HTML CLI source root");
  support::copy_feature_templates(root.path());
  let output = cli_command(args)
    .env("MYOXUS__TEMPLATES__ROOT_DIR", root.path())
    .output()
    .expect("run myoxus-cli");
  assert!(
    output.status.success(),
    "CLI failed\nstdout: {}\nstderr: {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  serde_json::from_slice(&output.stdout).expect("CLI stdout must be JSON")
}

async fn append_root_update(pool: &PgPool, workspace_id: Uuid, payload: Vec<u8>) {
  let sequence: i64 = sqlx::query_scalar(
    "SELECT GREATEST(
       COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1), 0),
       COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $1), 0)
     ) + 1",
  )
  .bind(workspace_id)
  .fetch_one(pool)
  .await
  .unwrap();
  sqlx::query("INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence) VALUES ($1, $1, $2, $3)")
    .bind(workspace_id)
    .bind(payload)
    .bind(sequence)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn projection_cli_exposes_only_bounded_external_key_commands() {
  let pool = PgPoolOptions::new()
    .max_connections(3)
    .connect(&database_url())
    .await
    .expect("connect isolated test database");
  let missing_root = std::env::temp_dir().join(format!("myoxus-non-html-missing-{}", std::process::id()));
  assert!(!missing_root.exists(), "non-HTML fixture must have no catalog files");
  let overlays: i64 = sqlx::query_scalar("SELECT count(*) FROM app_configs WHERE id='templates.root_dir'")
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(
    overlays, 0,
    "isolated CLI fixture must not mask the missing root with a DB override"
  );
  let maintenance = cli_command(&["system", "migrations"])
    .env("MYOXUS__TEMPLATES__ROOT_DIR", &missing_root)
    .output()
    .expect("run maintenance without unrelated Feature sources");
  assert!(
    maintenance.status.success(),
    "PostgreSQL maintenance must remain available without Feature sources: {}",
    String::from_utf8_lossy(&maintenance.stderr)
  );
  let migrations: Value = serde_json::from_slice(&maintenance.stdout).expect("maintenance returns native JSON");
  assert!(migrations.as_array().unwrap().iter().any(|row| row["version"] == 1000));
  let guarded = cli_command(&["users", "list"])
    .env("MYOXUS__TEMPLATES__ROOT_DIR", &missing_root)
    .output()
    .expect("run service-backed command without Feature sources");
  assert!(
    !guarded.status.success(),
    "service-backed commands must retain complete Feature admission"
  );
  assert!(String::from_utf8_lossy(&guarded.stderr).contains("could not initialize CLI services"));
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, 'Projection CLI', now())")
    .bind(user_id)
    .bind(format!("projection-cli-{user_id}@test.local"))
    .execute(&pool)
    .await
    .unwrap();
  let workspace_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO workspaces (id, owner_user_id, name, public, enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding)
     VALUES ($1, $2, 'Projection CLI fixture', false, true, true, true, true)",
  )
  .bind(workspace_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .unwrap();
  WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    support::database_starter_catalog(),
  )))
  .seed_root_doc(
    workspace_id,
    user_id,
    yjs::create_initial_workspace_doc("Projection CLI fixture"),
  )
  .await
  .unwrap();
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let created = service
    .create_page_lifecycle(workspace_id, user_id, Some("Projection CLI target".to_string()), None)
    .await
    .unwrap();
  let external_doc_id = created.document.external_id.clone();
  let doc_id = created.document.id;
  let initial_leaf = service.load_full_doc(workspace_id, doc_id).await.unwrap();
  let empty_title = yjs::update_document_title(&initial_leaf, "").unwrap();
  service
    .push_update_raw(workspace_id, doc_id, empty_title, DocSpaceKind::Workspace)
    .await
    .unwrap();
  sqlx::query("UPDATE docs SET title='' WHERE id=$1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .unwrap();
  let leaf_before = service.load_full_doc(workspace_id, doc_id).await.unwrap();
  let root = service.load_full_doc(workspace_id, workspace_id).await.unwrap();
  let removal = yjs::remove_pages_from_root_doc(&root, std::slice::from_ref(&external_doc_id)).unwrap();
  append_root_update(&pool, workspace_id, removal.update).await;

  let workspace = workspace_id.to_string();
  let scan = run_cli(&["doc", "projection", "scan", "--workspace", &workspace, "--limit", "1"]);
  assert!(scan["items"].as_array().is_some_and(|items| items.len() <= 1));
  let inspection = run_cli(&[
    "doc",
    "projection",
    "inspect",
    "--workspace",
    &workspace,
    "--external-doc-id",
    &external_doc_id,
  ]);
  assert_eq!(inspection["externalDocId"], external_doc_id);
  assert_eq!(inspection["normalizedTitle"], "");
  assert_eq!(inspection["findings"][0]["driftClass"], "missing_root_entry");
  let fingerprint = inspection["fingerprint"].as_str().unwrap();

  let preview = run_cli(&[
    "doc",
    "projection",
    "repair",
    "--workspace",
    &workspace,
    "--external-doc-id",
    &external_doc_id,
    "--fingerprint",
    fingerprint,
  ]);
  assert_eq!(preview["changed"], false);
  let actor = user_id.to_string();
  let applied = run_cli(&[
    "doc",
    "projection",
    "repair",
    "--workspace",
    &workspace,
    "--external-doc-id",
    &external_doc_id,
    "--fingerprint",
    fingerprint,
    "--actor",
    &actor,
    "--apply",
  ]);
  assert_eq!(applied["changed"], true);
  assert_eq!(service.load_full_doc(workspace_id, doc_id).await.unwrap(), leaf_before);

  for retired in [
    ["doc", "lifecycle", "audit"].as_slice(),
    ["doc", "projection", "repair", "--doc"].as_slice(),
  ] {
    let output = cli_command(retired).output().expect("run retired CLI probe");
    assert!(
      !output.status.success(),
      "retired or batch CLI contract must stay absent"
    );
  }

  for statement in [
    "DELETE FROM doc_updates WHERE workspace_id = $1",
    "DELETE FROM doc_snapshots WHERE workspace_id = $1",
    "DELETE FROM doc_histories WHERE workspace_id = $1",
    "DELETE FROM docs WHERE workspace_id = $1",
    "DELETE FROM workspace_memberships WHERE workspace_id = $1",
    "DELETE FROM workspaces WHERE id = $1",
  ] {
    sqlx::query(statement)
      .bind(workspace_id)
      .execute(&pool)
      .await
      .expect("projection CLI fixture cleanup");
  }
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("projection CLI user cleanup");
}
