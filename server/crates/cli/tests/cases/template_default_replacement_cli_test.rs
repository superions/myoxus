// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded CLI contract for replacing centrally managed template defaults.

use crate::support;

use std::path::Path;

use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use support::database_url;
use uuid::Uuid;

fn run_cli(source: &str, replacement: &str, storage_root: &Path, apply: bool) -> Value {
  let mut command = support::cli_command();
  command
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__STORAGE__ROOT", storage_root)
    .args([
      "--json",
      "templates",
      "replace-default",
      "--source-slug",
      source,
      "--replacement-slug",
      replacement,
      "--limit",
      "100",
    ]);
  if apply {
    command.arg("--apply");
  }
  let output = command.output().expect("run template replacement CLI");
  assert!(
    output.status.success(),
    "CLI failed: {}",
    String::from_utf8_lossy(&output.stderr)
  );
  serde_json::from_slice(&output.stdout).expect("JSON output")
}

#[tokio::test]
async fn inv_template_default_replacement_is_dry_run_bounded_and_idempotent() {
  let pool = PgPoolOptions::new()
    .max_connections(3)
    .connect(&database_url())
    .await
    .expect("connect isolated test database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrate isolated test database");

  let user_id = Uuid::new_v4();
  let eligible_workspace = Uuid::new_v4();
  let opted_out_workspace = Uuid::new_v4();
  let source_id = Uuid::new_v4();
  let replacement_id = Uuid::new_v4();
  let revision_id = Uuid::new_v4();
  let source_slug = format!("replace-source-{source_id}");
  let replacement_slug = format!("replace-target-{replacement_id}");
  let source_policy = Uuid::new_v4();
  let opted_out_policy = Uuid::new_v4();
  let replacement_policy = Uuid::new_v4();
  let storage_root = tempfile::tempdir().expect("temporary template storage");
  std::fs::copy(
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/documents/meeting-focus/1.0.1.zip"),
    storage_root.path().join("test-bundle"),
  )
  .expect("copy materializable template bundle");

  let outcome = tokio::spawn({
    let pool = pool.clone();
    let source_slug = source_slug.clone();
    let replacement_slug = replacement_slug.clone();
    async move {
  sqlx::query("INSERT INTO users(id,email,name,email_verified_at) VALUES($1,$2,'replacement test',now())")
    .bind(user_id)
    .bind(format!("template-replacement-{user_id}@test.local"))
    .execute(&pool)
    .await
    .unwrap();
  for workspace_id in [eligible_workspace, opted_out_workspace] {
    sqlx::query("INSERT INTO workspaces(id,owner_user_id,name,public) VALUES($1,$2,$3,false)")
      .bind(workspace_id)
      .bind(user_id)
      .bind(format!("replacement-{workspace_id}"))
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query(
      "INSERT INTO docs(id,external_id,workspace_id,title,default_role,is_workspace_root,created_by,updated_by) VALUES($1,$1::text,$1,'Workspace root','owner',true,$2,$2)",
    )
    .bind(workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();
  }
  sqlx::query(
    "INSERT INTO template_catalog_entries(id,slug,title,source,builder_version) VALUES($1,$2,'Old source','builtin',1),($3,$4,'Replacement','bundle',NULL)",
  )
  .bind(source_id)
  .bind(&source_slug)
  .bind(replacement_id)
  .bind(&replacement_slug)
  .execute(&pool)
  .await
  .unwrap();
  sqlx::query(
    "INSERT INTO template_revisions(id,template_id,version,state,bundle_blob_id,checksum,published_at) VALUES($1,$2,'1.0.0','published','test-bundle','test-checksum',now())",
  )
  .bind(revision_id)
  .bind(replacement_id)
  .execute(&pool)
  .await
  .unwrap();
  sqlx::query(
    "INSERT INTO workspace_template_policies(id,workspace_id,template_id,selection_mode,provisioning_mode,is_enabled) VALUES($1,$2,$3,'published','managed_until_local_edit',true),($4,$5,$3,'published','managed_until_local_edit',false),($6,$2,$7,'published','managed_until_local_edit',true)",
  )
  .bind(source_policy)
  .bind(eligible_workspace)
  .bind(source_id)
  .bind(opted_out_policy)
  .bind(opted_out_workspace)
  .bind(replacement_policy)
  .bind(replacement_id)
  .execute(&pool)
  .await
  .unwrap();
  let dry_run = run_cli(&source_slug, &replacement_slug, storage_root.path(), false);
  assert_eq!(dry_run.as_array().expect("rows").len(), 2);
  assert!(
    dry_run
      .as_array()
      .unwrap()
      .iter()
      .any(|row| row["outcome"] == "would-replace")
  );
  assert!(
    dry_run
      .as_array()
      .unwrap()
      .iter()
      .any(|row| { row["workspace_id"] == opted_out_workspace.to_string() && row["outcome"] == "preserved" })
  );
  let source_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_policies WHERE id=$1")
    .bind(source_policy)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(source_before, 1, "dry-run must not write");

  let applied = run_cli(&source_slug, &replacement_slug, storage_root.path(), true);
  assert!(
    applied
      .as_array()
      .unwrap()
      .iter()
      .any(|row| { row["workspace_id"] == eligible_workspace.to_string() && row["outcome"] == "replaced" })
  );
  let source_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_template_policies WHERE id=$1")
    .bind(source_policy)
    .fetch_one(&pool)
    .await
    .unwrap();
  let opt_out_after: (bool, i64) = sqlx::query_as(
    "SELECT is_enabled,(SELECT COUNT(*) FROM workspace_template_policies WHERE workspace_id=$1 AND template_id=$2) FROM workspace_template_policies WHERE id=$3",
  )
  .bind(opted_out_workspace)
  .bind(replacement_id)
  .bind(opted_out_policy)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(source_after, 0);
  assert_eq!(opt_out_after, (false, 0));
  let replacement_source: (String, String) = sqlx::query_as(
    "SELECT state,workspace_doc_key FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2",
  )
  .bind(eligible_workspace)
  .bind(replacement_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(replacement_source.0, "ok");
  assert!(!replacement_source.1.is_empty());

  let rerun = run_cli(&source_slug, &replacement_slug, storage_root.path(), true);
  assert_eq!(rerun.as_array().expect("rows").len(), 1);
  assert_eq!(rerun[0]["outcome"], "preserved");
    }
  }).await;

  sqlx::query("DELETE FROM workspaces WHERE id = ANY($1)")
    .bind(&[eligible_workspace, opted_out_workspace])
    .execute(&pool)
    .await
    .expect("remove test workspaces");
  sqlx::query("DELETE FROM template_catalog_entries WHERE id = ANY($1)")
    .bind(&[source_id, replacement_id])
    .execute(&pool)
    .await
    .expect("remove test templates");
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("remove test user");
  if let Err(error) = outcome {
    std::panic::resume_unwind(error.into_panic());
  }
}
