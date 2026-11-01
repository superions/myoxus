// SPDX-License-Identifier: AGPL-3.0-or-later
//! Actual CLI catalog transitions preserve lifecycle state and audit attribution.

use crate::support;

use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{panic::resume_unwind, path::Path, process::Output};
use uuid::Uuid;

fn run_cli(operation: &str, id: Uuid, storage_root: &Path) -> Output {
  support::cli_command()
    .env("MYOXUS__DATABASE__URL", support::database_url())
    .env("MYOXUS__STORAGE__ROOT", storage_root)
    .args(["--json", "templates", operation, &id.to_string()])
    .output()
    .expect("run template lifecycle CLI")
}

async fn state(pool: &PgPool, id: Uuid) -> (String, bool) {
  sqlx::query_as("SELECT c.status,p.is_enabled FROM template_catalog_entries c JOIN workspace_template_policies p ON p.template_id=c.id WHERE c.id=$1")
    .bind(id).fetch_one(pool).await.expect("persisted catalog/policy state")
}

#[tokio::test]
async fn cli_archive_is_atomic_and_enable_preserves_disabled_policies() {
  let pool = PgPoolOptions::new()
    .max_connections(3)
    .connect(&support::database_url())
    .await
    .expect("isolated test DB");
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let storage = tempfile::tempdir().expect("temporary lifecycle storage");
  let user = Uuid::new_v4();
  let workspace = Uuid::new_v4();
  let id = Uuid::new_v4();
  let revision = Uuid::new_v4();
  let slug = format!("lifecycle-cli-{id}");
  let trigger = format!("cli_archive_{}", Uuid::new_v4().simple());
  let outcome = tokio::spawn({
    let pool = pool.clone();
    let trigger = trigger.clone();
    let slug = slug.clone();
    let storage_root = storage.path().to_owned();
    async move {
    sqlx::query("INSERT INTO users(id,email,name,email_verified_at) VALUES($1,$2,'Lifecycle fixture',now())")
      .bind(user).bind(format!("lifecycle-{user}@test.local")).execute(&pool).await.expect("user");
    sqlx::query("INSERT INTO workspaces(id,owner_user_id,name) VALUES($1,$2,'Lifecycle fixture')")
      .bind(workspace).bind(user).execute(&pool).await.expect("workspace");
    sqlx::query("INSERT INTO template_catalog_entries(id,slug,title,source,builder_version) VALUES($1,$2,'Lifecycle fixture','builtin',3)")
      .bind(id).bind(&slug).execute(&pool).await.expect("catalog");
    sqlx::query("INSERT INTO template_revisions(id,template_id,version,state,bundle_blob_id,checksum) VALUES($1,$2,'1.0.0','published','owned-fixture-bundle','owned-fixture-checksum')")
      .bind(revision).bind(id).execute(&pool).await.expect("revision");
    sqlx::query("INSERT INTO template_default_policies(template_id,apply_to_new_workspaces) VALUES($1,false)")
      .bind(id).execute(&pool).await.expect("default");
    sqlx::query("INSERT INTO workspace_template_policies(workspace_id,template_id,selection_mode,provisioning_mode,is_enabled) VALUES($1,$2,'published','seed_once',true)")
      .bind(workspace).bind(id).execute(&pool).await.expect("policy");
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned CLI policy rollback probe'; END $$"))
      .execute(&pool).await.expect("failure function");
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE UPDATE ON workspace_template_policies FOR EACH ROW WHEN (OLD.template_id='{id}'::uuid) EXECUTE FUNCTION {trigger}()"))
      .execute(&pool).await.expect("failure trigger");
    assert!(!run_cli("archive", id, storage_root.as_path()).status.success());
    assert_eq!(state(&pool, id).await, ("active".into(), true));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE target_id=$1")
      .bind(id.to_string()).fetch_one(&pool).await.expect("audit count");
    assert_eq!(count, 0, "failed archive must not audit success");
    sqlx::query(&format!("DROP TRIGGER {trigger} ON workspace_template_policies")).execute(&pool).await.expect("remove failure trigger");
    let archived = run_cli("archive", id, storage_root.as_path());
    assert!(archived.status.success(), "{}", String::from_utf8_lossy(&archived.stderr));
    assert_eq!(String::from_utf8(archived.stdout).expect("stdout"), format!("Template archived: {slug} ({id})\n"));
    assert_eq!(state(&pool, id).await, ("archived".into(), false));
    let duplicate = run_cli("archive", id, storage_root.as_path());
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("template is already archived"));
    for _ in 0..2 {
      let enabled = run_cli("enable", id, storage_root.as_path());
      assert!(enabled.status.success(), "{}", String::from_utf8_lossy(&enabled.stderr));
      assert_eq!(String::from_utf8(enabled.stdout).expect("stdout"), format!("Template enabled: {slug} ({id})\n"));
      assert_eq!(state(&pool, id).await, ("active".into(), false));
    }
    let retained: (String, i32, bool) = sqlx::query_as("SELECT c.source,c.builder_version,d.apply_to_new_workspaces FROM template_catalog_entries c JOIN template_default_policies d ON d.template_id=c.id WHERE c.id=$1")
      .bind(id).fetch_one(&pool).await.expect("retained source/default");
    assert_eq!(retained, ("builtin".into(), 3, false));
    let revisions: i64 = sqlx::query_scalar("SELECT count(*) FROM template_revisions WHERE id=$1 AND template_id=$2")
      .bind(revision).bind(id).fetch_one(&pool).await.expect("retained revision");
    assert_eq!(revisions, 1);
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND actor_kind='system' AND actor_user_id IS NULL AND metadata->>'source'='cli' AND event_key IN ('template.archive','template.enable')")
      .bind(id.to_string()).fetch_one(&pool).await.expect("attributed audit count");
    assert_eq!(audits, 3, "one archive and both successful enable commands audit once");
    sqlx::query("UPDATE workspace_template_policies SET is_enabled=true WHERE template_id=$1")
      .bind(id).execute(&pool).await.expect("enabled bump target");
    for (version, socket_url) in [(4, "redis://127.0.0.1:6380"), (5, "redis://127.0.0.1:1")] {
      let output = support::cli_command()
        .env("MYOXUS__DATABASE__URL", support::database_url())
        .env("MYOXUS__STORAGE__ROOT", &storage_root)
        .env("MYOXUS__REDIS__ROLES__SOCKET__URL", socket_url)
        .env("MYOXUS__REDIS__ROLES__SOCKET__NAMESPACE", &slug)
        .args(["--json", "templates", "bump-builder-version", &slug])
        .output().expect("builder CLI");
      assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
      let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("existing JSON shape");
      assert_eq!(value, serde_json::json!({"slug":slug,"newBuilderVersion":version}));
      let committed: i32 = sqlx::query_scalar("SELECT builder_version FROM template_catalog_entries WHERE id=$1")
        .bind(id).fetch_one(&pool).await.expect("committed CLI version");
      assert_eq!(committed, version, "notification failure must not retry the bump");
    }

  }}).await;
  sqlx::query(&format!(
    "DROP TRIGGER IF EXISTS {trigger} ON workspace_template_policies"
  ))
  .execute(&pool)
  .await
  .expect("cleanup trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}()"))
    .execute(&pool)
    .await
    .expect("cleanup function");
  sqlx::query("DELETE FROM admin_audit_log WHERE target_id=$1")
    .bind(id.to_string())
    .execute(&pool)
    .await
    .expect("cleanup audits");
  sqlx::query("DELETE FROM workspace_template_policies WHERE template_id=$1")
    .bind(id)
    .execute(&pool)
    .await
    .expect("cleanup policies");
  sqlx::query("DELETE FROM template_catalog_entries WHERE id=$1")
    .bind(id)
    .execute(&pool)
    .await
    .expect("cleanup catalog and revisions/defaults");
  sqlx::query("DELETE FROM workspaces WHERE id=$1")
    .bind(workspace)
    .execute(&pool)
    .await
    .expect("cleanup workspace");
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user)
    .execute(&pool)
    .await
    .expect("cleanup user");
  if let Err(error) = outcome {
    if error.is_panic() {
      resume_unwind(error.into_panic());
    }
    panic!("lifecycle task cancelled: {error}");
  }
}
