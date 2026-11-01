// SPDX-License-Identifier: AGPL-3.0-or-later
//! Persisted contract for conservative template attribution recovery.

use crate::support;

use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;
use uuid::Uuid;

fn run_cli(workspace_id: Uuid, apply: bool) -> Value {
  let mut command = support::cli_command();
  command
    .env("MYOXUS__DATABASE__URL", database_url())
    .args(["--json", "templates", "repair-attribution", "--workspace-id"])
    .arg(workspace_id.to_string())
    .args(["--limit", "100"]);
  if apply {
    command.arg("--apply");
  }
  let output = command.output().expect("run template repair CLI");
  assert!(
    output.status.success(),
    "CLI failed: {}",
    String::from_utf8_lossy(&output.stderr)
  );
  serde_json::from_slice(&output.stdout).expect("JSON output")
}

fn outcome<'a>(rows: &'a Value, instance_id: Uuid) -> &'a str {
  rows
    .as_array()
    .and_then(|rows| rows.iter().find(|row| row["instance_id"] == instance_id.to_string()))
    .and_then(|row| row["outcome"].as_str())
    .expect("instance outcome")
}

#[tokio::test]
async fn inv_template_repair_is_bounded_conservative_and_idempotent() {
  let pool = PgPoolOptions::new()
    .max_connections(3)
    .connect(&database_url())
    .await
    .expect("connect isolated test database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrate isolated test database");
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id,email,name,email_verified_at) VALUES ($1,$2,'template repair',now())")
    .bind(user_id)
    .bind(format!("template-repair-{user_id}@test.local"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("INSERT INTO workspaces (id,owner_user_id,name,public) VALUES ($1,$2,$3,false)")
    .bind(workspace_id)
    .bind(user_id)
    .bind(format!("template-repair-{workspace_id}"))
    .execute(&pool)
    .await
    .unwrap();

  let normal_template = seed_template(&pool, "project").await;
  let onboarding_template = seed_template(&pool, "onboarding").await;
  let unmarked_template = seed_template(&pool, "project").await;
  let conflicted_template = seed_template(&pool, "project").await;
  let trashed_template = seed_template(&pool, "project").await;
  let wrong_template = seed_template(&pool, "project").await;
  let result = async {
    let repair_doc = seed_doc(&pool, workspace_id, user_id, &Uuid::new_v4().to_string(), false).await;
    let unmarked_doc = seed_doc(&pool, workspace_id, user_id, "explicit-unmark", false).await;
    let onboarding_doc = seed_doc(&pool, workspace_id, user_id, "onboarding", false).await;
    let wrong_doc = seed_doc(&pool, workspace_id, user_id, "wrong", false).await;
    let trashed_doc = seed_doc(&pool, workspace_id, user_id, "trashed", true).await;

    let repair_instance = seed_instance(&pool, workspace_id, normal_template, None, Some(repair_doc.1.clone())).await;
    let unmarked_instance = seed_instance(&pool, workspace_id, unmarked_template, Some(unmarked_doc.0), Some(unmarked_doc.1.clone())).await;
    let onboarding_instance = seed_instance(&pool, workspace_id, onboarding_template, Some(onboarding_doc.0), Some(onboarding_doc.1.clone())).await;
    let wrong_instance = seed_instance(&pool, workspace_id, conflicted_template, Some(wrong_doc.0), Some(wrong_doc.1.clone())).await;
    let trashed_instance = seed_instance(&pool, workspace_id, trashed_template, None, Some(trashed_doc.1.clone())).await;
    seed_state(&pool, repair_doc.0, None, None).await;
    seed_state(&pool, onboarding_doc.0, Some(onboarding_template), Some(onboarding_instance)).await;
    seed_state(&pool, wrong_doc.0, Some(wrong_template), Some(wrong_instance)).await;
    seed_state(&pool, trashed_doc.0, None, None).await;

    let dry = run_cli(workspace_id, false);
    assert_eq!(outcome(&dry, repair_instance), "would-repair");
    assert_eq!(outcome(&dry, unmarked_instance), "ambiguous");
    assert_eq!(outcome(&dry, onboarding_instance), "would-repair");
    assert_eq!(outcome(&dry, wrong_instance), "ambiguous");
    assert_eq!(outcome(&dry, trashed_instance), "preserved");
    let still_null: Option<Uuid> = sqlx::query_scalar("SELECT workspace_doc_id FROM workspace_template_instances WHERE id=$1")
      .bind(repair_instance).fetch_one(&pool).await.unwrap();
    assert!(still_null.is_none(), "dry-run must not write");

    let applied = run_cli(workspace_id, true);
    assert_eq!(outcome(&applied, repair_instance), "repaired");
    assert_eq!(outcome(&applied, unmarked_instance), "ambiguous");
    assert_eq!(outcome(&applied, onboarding_instance), "repaired");
    let repaired: (Option<Uuid>, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
      "SELECT i.workspace_doc_id,s.template_id,s.instance_id FROM workspace_template_instances i JOIN document_template_state s ON s.doc_id=i.workspace_doc_id WHERE i.id=$1",
    ).bind(repair_instance).fetch_one(&pool).await.unwrap();
    assert_eq!(repaired, (Some(repair_doc.0), Some(normal_template), Some(repair_instance)));
    let onboarding_state: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_template_state WHERE doc_id=$1")
      .bind(onboarding_doc.0).fetch_one(&pool).await.unwrap();
    assert_eq!(onboarding_state, 0);
    let retained_title: String = sqlx::query_scalar("SELECT title FROM docs WHERE id=$1")
      .bind(repair_doc.0).fetch_one(&pool).await.unwrap();
    assert_eq!(retained_title, format!("sentinel-{}", repair_doc.0));
    let rerun = run_cli(workspace_id, true);
    assert_eq!(outcome(&rerun, repair_instance), "unchanged");
    assert_eq!(outcome(&rerun, unmarked_instance), "ambiguous");
    assert_eq!(outcome(&rerun, trashed_instance), "preserved");
    anyhow::Ok(())
  }.await;

  let workspace_cleanup = sqlx::query("DELETE FROM workspaces WHERE id=$1")
    .bind(workspace_id)
    .execute(&pool)
    .await;
  let template_cleanup = sqlx::query("DELETE FROM template_catalog_entries WHERE id = ANY($1)")
    .bind(&[
      normal_template,
      onboarding_template,
      unmarked_template,
      conflicted_template,
      trashed_template,
      wrong_template,
    ])
    .execute(&pool)
    .await;
  let user_cleanup = sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user_id)
    .execute(&pool)
    .await;
  workspace_cleanup.expect("remove test workspace");
  template_cleanup.expect("remove test templates");
  user_cleanup.expect("remove test user");
  result.unwrap();
}

async fn seed_template(pool: &PgPool, category: &str) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query("INSERT INTO template_catalog_entries(id,slug,title,category,source,builder_version) VALUES($1,$2,$3,$4,'builtin',1)")
    .bind(id).bind(format!("repair-{id}")).bind(format!("Repair {id}")).bind(category)
    .execute(pool).await.unwrap();
  id
}

async fn seed_doc(pool: &PgPool, workspace: Uuid, user: Uuid, key: &str, trashed: bool) -> (Uuid, String) {
  let id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title,created_by,updated_by,deleted_at) VALUES($1,$2,$3,$4,$5,$5,CASE WHEN $6 THEN now() ELSE NULL END)")
    .bind(id).bind(workspace).bind(key).bind(format!("sentinel-{id}")).bind(user).bind(trashed)
    .execute(pool).await.unwrap();
  (id, key.to_string())
}

async fn seed_instance(pool: &PgPool, workspace: Uuid, template: Uuid, doc: Option<Uuid>, key: Option<String>) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspace_template_instances(id,workspace_id,template_id,workspace_doc_id,workspace_doc_key,state) VALUES($1,$2,$3,$4,$5,'ok')")
    .bind(id).bind(workspace).bind(template).bind(doc).bind(key).execute(pool).await.unwrap();
  id
}

async fn seed_state(pool: &PgPool, doc: Uuid, template: Option<Uuid>, instance: Option<Uuid>) {
  sqlx::query("INSERT INTO document_template_state(doc_id,state,template_id,instance_id) VALUES($1,'managed',$2,$3)")
    .bind(doc)
    .bind(template)
    .bind(instance)
    .execute(pool)
    .await
    .unwrap();
}
