// SPDX-License-Identifier: AGPL-3.0-or-later
//! Binary-level coverage for organization-unit operator workflows.
//!
//! The journey deliberately crosses the compiled command boundary and then
//! verifies durable repository effects. Existing Infrastructure and GraphQL
//! tests remain the exhaustive lifecycle-invariant suites.

use crate::support;

use std::process::Output;

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;
use uuid::Uuid;

const DEFAULT_REDIS_URL: &str = "redis://localhost:6380";

#[tokio::test]
async fn workspace_cli_publishes_one_default_and_recovery_preserves_native_tasks() -> Result<()> {
  let pool = PgPoolOptions::new().max_connections(4).connect(&database_url()).await?;
  myoxus_infrastructure::migrations::run(&pool).await?;
  let owner = Uuid::new_v4();
  sqlx::query("INSERT INTO users(id,email,name,status) VALUES($1,$2,'CLI Tasks Owner','active')")
    .bind(owner)
    .bind(format!("cli-managed-{owner}@test.local"))
    .execute(&pool)
    .await?;
  let namespace = format!("cli-managed-{owner}");
  let body:Result<()> = async {
    let created=run_json(&["workspaces","create","--owner-user",&owner.to_string(),"--name","CLI protected tasks"],&namespace)?;
    let workspace=json_id(&created)?;
    let first=run_json(&["workspaces","ensure-tasks",&workspace.to_string()],&namespace)?;
    ensure!(first["managedSchema"]["readiness"]=="ready","canonical CLI initializer must project actual readiness: {first}");
    let default:Uuid=first["databaseId"].as_str().context("default identity")?.parse()?;
    let record=myoxus_domain::database::DatabaseDefinitionRepository::get_database(
      &myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(),support::database_starter_catalog()),default).await?.context("default aggregate")?;
    ensure!(record.database.created_by==Some(owner),"normal user creation keeps real provenance");
    // Recovery is an initializer, never a reseed or replacement. The same
    // canonical identity must survive a real native content write.
    let row=Uuid::new_v4();
    let mut tx=pool.begin().await?;
    let source=support::database_starter_catalog();
    let (version,digest)=source.current_source("myoxus.project.simple_project").context("current source")?;
    sqlx::query("SELECT set_config('myoxus.admitted_database_sources',$1,true)")
      .bind(serde_json::json!([["myoxus.project.simple_project",version,digest]]).to_string()).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO workspace_database_rows(id,database_id,title,row_kind,position,created_by,updated_by) VALUES($1,$2,'Retain original Task','task',0,$3,$3)")
      .bind(row).bind(default).bind(owner).execute(&mut *tx).await?;
    tx.commit().await?;
    let again=run_json(&["workspaces","ensure-tasks",&workspace.to_string()],&namespace)?;
    ensure!(again["databaseId"]==default.to_string());
    let counts:(i64,i64)=sqlx::query_as("SELECT count(*),(SELECT count(*) FROM workspace_database_rows WHERE id=$2 AND title='Retain original Task') FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
      .bind(workspace).bind(row).fetch_one(&pool).await?;
    ensure!(counts==(1,1),"CLI retry must keep exactly the original default and contents");
    Ok(())
  }.await;
  // Cleanup executes before propagating command/assertion failures.
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id=$1")
    .bind(owner)
    .execute(&pool)
    .await?;
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(owner)
    .execute(&pool)
    .await?;
  body
}

fn redis_url() -> String {
  std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| DEFAULT_REDIS_URL.to_string())
}

fn cli_command(args: &[&str], redis_namespace: &str, json: bool) -> support::CliCommand {
  let mut command = support::cli_command();
  command
    .env("RUN_MODE", "development")
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__REDIS__URL", redis_url())
    .env("MYOXUS__REDIS__NAMESPACE", redis_namespace)
    .env("MYOXUS__SERVER__ORIGIN", "https://cli-test.myoxus.invalid")
    .env("RUST_LOG", "warn");
  if json {
    command.arg("--json");
  }
  command.args(args);
  command
}

fn run_cli(args: &[&str], redis_namespace: &str, json: bool) -> Result<Output> {
  cli_command(args, redis_namespace, json)
    .output()
    .context("run myoxus-cli")
}

fn ensure_success(output: &Output) -> Result<()> {
  ensure!(
    output.status.success(),
    "CLI failed with {}\nstdout: {}\nstderr: {}",
    output.status,
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  Ok(())
}

fn run_json(args: &[&str], redis_namespace: &str) -> Result<Value> {
  let output = run_cli(args, redis_namespace, true)?;
  ensure_success(&output)?;
  serde_json::from_slice(&output.stdout).context("parse CLI JSON output")
}

fn json_id(value: &Value) -> Result<Uuid> {
  value
    .get("id")
    .and_then(Value::as_str)
    .context("CLI output id")?
    .parse()
    .context("parse CLI output UUID")
}

async fn cleanup(pool: &PgPool, organization_id: Uuid, user_id: Uuid, unit_slugs_child_first: &[&str]) -> Result<()> {
  sqlx::query("DELETE FROM organization_unit_member WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await?;
  sqlx::query("DELETE FROM user_features WHERE user_id = $1")
    .bind(user_id)
    .execute(pool)
    .await?;
  for slug in unit_slugs_child_first {
    sqlx::query("DELETE FROM admin_audit_log WHERE target_id = (SELECT id::text FROM organization_unit WHERE organization_id=$1 AND slug=$2)")
      .bind(organization_id).bind(slug).execute(pool).await?;
    sqlx::query("DELETE FROM organization_unit WHERE organization_id = $1 AND slug = $2")
      .bind(organization_id)
      .bind(slug)
      .execute(pool)
      .await?;
  }
  sqlx::query("DELETE FROM admin_audit_log WHERE target_id=$1")
    .bind(user_id.to_string())
    .execute(pool)
    .await?;
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await?;
  Ok(())
}

#[tokio::test]
async fn organization_cli_drives_complete_unit_and_membership_workflow() -> Result<()> {
  let pool = PgPoolOptions::new()
    .max_connections(4)
    .connect(&database_url())
    .await
    .context("connect isolated CLI test database")?;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .context("apply CLI test migrations")?;

  let organization_id: Uuid = sqlx::query_scalar("SELECT id FROM organization WHERE key = 'myoxus'")
    .fetch_one(&pool)
    .await?;
  let unit_type_id: Uuid = sqlx::query_scalar(
    "SELECT id FROM organization_unit_type \
     WHERE organization_id = $1 AND is_active = true AND can_be_root_level = true AND can_have_children = true \
     ORDER BY key LIMIT 1",
  )
  .bind(organization_id)
  .fetch_one(&pool)
  .await?;

  let suffix = Uuid::new_v4();
  let email = format!("office-org-cli-{suffix}@test.local");
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(&email)
    .bind("Office Organization CLI")
    .execute(&pool)
    .await?;

  let redis_namespace = format!("myoxus:cli-org-test:{suffix}");
  let organization = organization_id.to_string();
  let unit_type = unit_type_id.to_string();
  let root_slug = format!("cli-root-{suffix}");
  let child_slug = format!("cli-child-{suffix}");
  let second_slug = format!("cli-second-{suffix}");
  let inactive_type = Uuid::new_v4();
  let child_only_type = Uuid::new_v4();
  for (id, active, root) in [(inactive_type, false, true), (child_only_type, true, false)] {
    sqlx::query("INSERT INTO organization_unit_type (id, organization_id, key, label, is_active, is_structural, can_have_children, can_be_root_level, can_be_manager_created, can_have_cross_unit_members, can_own_workspaces, can_manage_workspaces) VALUES ($1,$2,$3,'CLI lifecycle fixture',$4,true,true,$5,false,false,false,false)")
      .bind(id).bind(organization_id).bind(format!("cli-type-{id}"))
      .bind(active).bind(root).execute(&pool).await?;
  }
  // Keep the API's real SQL feature loader and cache subscriber alive while
  // the compiled CLI mutates the same isolated database/cache role.
  use myoxus_application::ports::RedisPort;
  use std::sync::Arc;
  let cache_redis = Arc::new(myoxus_infrastructure::redis::RedisAdapter::new(
    redis_url(),
    format!("{redis_namespace}:cache"),
  )?);
  let cache_storage = tempfile::tempdir()?;
  let storage = Arc::new(myoxus_infrastructure::storage::StorageAdapter::new_fs(
    cache_storage.path().to_str().context("cache fixture storage path")?,
  )?);
  let cache_state = myoxus_api::state::ApiState::with_services(
    myoxus_api::config::AppConfig::load()?,
    myoxus_application::auth::AuthService::new(
      Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone())),
      Arc::new(myoxus_infrastructure::mail::LogMailAdapter),
      storage.clone(),
      86_400,
      3_600,
    ),
    myoxus_application::workspace::WorkspaceService::new(Arc::new(
      myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(), support::database_starter_catalog()),
    )),
    myoxus_application::admin::AdminService::new(Arc::new(myoxus_infrastructure::admin::SqlxAdminStore::new(
      pool.clone(),
    ))),
    myoxus_application::doc::DocService::new(Arc::new(myoxus_application::doc::PanicDocStore)),
    Arc::new(myoxus_application::ports::blob_service::BlobService::new(
      Arc::new(myoxus_application::ports::blob::NullBlobStore),
      storage.clone(),
      "test-key".to_string(),
    )),
    storage,
  )
  .with_cache_redis(cache_redis.clone());
  let (subscriber, ready) = myoxus_api::cache_bus::CacheInvalidationBus::start_subscriber(
    cache_state.query_cache.clone(),
    cache_redis.clone(),
    Uuid::new_v4(),
    None,
  );
  let result: Result<()> = async {
    tokio::time::timeout(std::time::Duration::from_secs(5), ready)
      .await
      .context("API cache subscriber ready timeout")??;
    for (typ, expected) in [
      (inactive_type, "ORGANIZATION_UNIT_TYPE_INACTIVE"),
      (child_only_type, "ORGANIZATION_UNIT_ROOT_NOT_ALLOWED"),
    ] {
      let rejected = run_cli(
        &[
          "organization",
          "units",
          "create",
          "--organization",
          &organization,
          "--unit-type",
          &typ.to_string(),
          "--name",
          "Rejected",
          "--slug",
          &root_slug,
          "--root",
        ],
        &redis_namespace,
        true,
      )?;
      ensure!(
        !rejected.status.success(),
        "lifecycle type/root guard must reject creation"
      );
      ensure!(String::from_utf8_lossy(&rejected.stderr).contains(expected));
      let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM organization_unit WHERE organization_id=$1 AND slug=$2")
          .bind(organization_id)
          .bind(&root_slug)
          .fetch_one(&pool)
          .await?;
      ensure!(count == 0, "rejected create must not persist a unit");
    }
    let root = run_json(
      &[
        "organization",
        "units",
        "create",
        "--organization",
        &organization,
        "--unit-type",
        &unit_type,
        "--name",
        "CLI Root",
        "--slug",
        &root_slug,
        "--root",
      ],
      &redis_namespace,
    )?;
    let root_id = json_id(&root)?;
    ensure!(root["status"] == "active");
    ensure!(root["parent_unit_id"] == "");

    let root_id_text = root_id.to_string();
    let fetched = run_json(
      &[
        "organization",
        "units",
        "get",
        "--organization",
        &organization,
        "--unit",
        &root_id_text,
      ],
      &redis_namespace,
    )?;
    ensure!(fetched["slug"] == root_slug);

    let updated = run_json(
      &[
        "organization",
        "units",
        "update",
        "--organization",
        &organization,
        "--unit",
        &root_id_text,
        "--unit-type",
        &unit_type,
        "--name",
        "CLI Root Updated",
        "--description",
        "Managed by the operator CLI",
      ],
      &redis_namespace,
    )?;
    ensure!(updated["name"] == "CLI Root Updated");
    ensure!(updated["description"] == "Managed by the operator CLI");

    let child = run_json(
      &[
        "organization",
        "units",
        "create",
        "--organization",
        &organization,
        "--unit-type",
        &unit_type,
        "--name",
        "CLI Child",
        "--slug",
        &child_slug,
        "--parent",
        &root_id_text,
      ],
      &redis_namespace,
    )?;
    let child_id = json_id(&child)?;
    let child_id_text = child_id.to_string();
    ensure!(child["parent_unit_id"] == root_id_text);
    let child_updated = run_json(
      &[
        "organization",
        "units",
        "update",
        "--organization",
        &organization,
        "--unit",
        &child_id_text,
        "--unit-type",
        &unit_type,
        "--description",
        "Nested description",
      ],
      &redis_namespace,
    )?;
    ensure!(child_updated["parent_unit_id"] == root_id_text && child_updated["status"] == "active");
    ensure!(child_updated["name"] == "CLI Child" && child_updated["slug"] == child_slug);
    let audited: i64 = sqlx::query_scalar(
      "SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='organization.unit.create'",
    )
    .bind(child_id_text.clone())
    .fetch_one(&pool)
    .await?;
    ensure!(audited == 1, "CLI create must emit one shared domain event");

    let in_use = run_cli(
      &[
        "organization",
        "units",
        "archive",
        "--organization",
        &organization,
        "--unit",
        &root_id_text,
      ],
      &redis_namespace,
      true,
    )?;
    ensure!(!in_use.status.success());
    ensure!(String::from_utf8_lossy(&in_use.stderr).contains("ORGANIZATION_UNIT_IN_USE"));
    let persisted_status: String = sqlx::query_scalar("SELECT status::text FROM organization_unit WHERE id=$1")
      .bind(root_id)
      .fetch_one(&pool)
      .await?;
    ensure!(persisted_status == "active", "refused archive must preserve state");

    let cycle = run_cli(
      &[
        "organization",
        "units",
        "move",
        "--organization",
        &organization,
        "--unit",
        &root_id_text,
        "--parent",
        &child_id_text,
      ],
      &redis_namespace,
      true,
    )?;
    ensure!(
      !cycle.status.success(),
      "shared lifecycle cycle guard must reject the CLI move"
    );
    ensure!(
      String::from_utf8_lossy(&cycle.stderr).contains("ORGANIZATION_UNIT_CYCLE"),
      "cycle failure must retain the repository reason: {}",
      String::from_utf8_lossy(&cycle.stderr)
    );

    let moved = run_json(
      &[
        "organization",
        "units",
        "move",
        "--organization",
        &organization,
        "--unit",
        &child_id_text,
        "--root",
      ],
      &redis_namespace,
    )?;
    ensure!(moved["parent_unit_id"] == "");

    let archived = run_json(
      &[
        "organization",
        "units",
        "archive",
        "--organization",
        &organization,
        "--unit",
        &child_id_text,
      ],
      &redis_namespace,
    )?;
    ensure!(archived["status"] == "archived");
    let inactive_parent = run_cli(
      &[
        "organization",
        "units",
        "create",
        "--organization",
        &organization,
        "--unit-type",
        &unit_type,
        "--name",
        "Rejected child",
        "--slug",
        &second_slug,
        "--parent",
        &child_id_text,
      ],
      &redis_namespace,
      true,
    )?;
    ensure!(!inactive_parent.status.success());
    ensure!(String::from_utf8_lossy(&inactive_parent.stderr).contains("ORGANIZATION_UNIT_PARENT_INACTIVE"));
    sqlx::query(
      "UPDATE organization_unit SET metadata=$2,max_members=41,description='Retained description' WHERE id=$1",
    )
    .bind(child_id)
    .bind(serde_json::json!({"preserved":true}))
    .execute(&pool)
    .await?;
    let retained = run_json(
      &[
        "organization",
        "units",
        "update",
        "--organization",
        &organization,
        "--unit",
        &child_id_text,
        "--unit-type",
        &unit_type,
        "--name",
        "CLI archived renamed",
      ],
      &redis_namespace,
    )?;
    ensure!(retained["status"] == "archived" && retained["parent_unit_id"] == "");
    ensure!(retained["max_members"] == 41 && retained["description"] == "Retained description");
    ensure!(retained["metadata"] == "{\"preserved\":true}");
    let cleared = run_json(
      &[
        "organization",
        "units",
        "update",
        "--organization",
        &organization,
        "--unit",
        &child_id_text,
        "--unit-type",
        &unit_type,
        "--clear-description",
      ],
      &redis_namespace,
    )?;
    ensure!(cleared["description"] == "" && cleared["status"] == "archived");

    let second = run_json(
      &[
        "organization",
        "units",
        "create",
        "--organization",
        &organization,
        "--unit-type",
        &unit_type,
        "--name",
        "CLI Second",
        "--slug",
        &second_slug,
        "--root",
      ],
      &redis_namespace,
    )?;
    let second_id = json_id(&second)?;
    let second_id_text = second_id.to_string();

    let listed = run_json(
      &[
        "organization",
        "units",
        "list",
        "--organization",
        &organization,
        "--status",
        "active",
      ],
      &redis_namespace,
    )?;
    ensure!(
      listed
        .as_array()
        .context("unit list array")?
        .iter()
        .any(|unit| unit["id"] == root_id_text)
    );
    let human_list = run_cli(
      &["organization", "units", "list", "--organization", &organization],
      &redis_namespace,
      false,
    )?;
    ensure_success(&human_list)?;
    ensure!(String::from_utf8_lossy(&human_list.stdout).contains("CLI Root Updated"));

    let email_upper = email.to_ascii_uppercase();
    let added = run_json(
      &[
        "organization",
        "members",
        "add",
        "--organization",
        &organization,
        "--unit",
        &root_id_text,
        "--user",
        &email_upper,
        "--role",
        "reader",
      ],
      &redis_namespace,
    )?;
    ensure!(added["role"] == "reader");
    ensure!(added["manager_capability_changed"] == false);

    let warmed = cache_state
      .user_feature_flags_cached_l2(user_id)
      .await
      .context("warm API feature cache")?;
    ensure!(!warmed.iter().any(|flag| flag == "manager"));
    let before_grant = cache_state.query_cache.user_features_key(user_id);
    let promoted = run_json(
      &[
        "organization",
        "members",
        "set-role",
        "--organization",
        &organization,
        "--unit",
        &root_id_text,
        "--user",
        &user_id.to_string(),
        "--role",
        "manager",
      ],
      &redis_namespace,
    )?;
    ensure!(promoted["manager_capability_changed"] == true);
    let manager_active: bool =
      sqlx::query_scalar("SELECT activated FROM user_features WHERE user_id = $1 AND feature_name = 'manager'")
        .bind(user_id)
        .fetch_one(&pool)
        .await?;
    ensure!(manager_active);

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
      while cache_state.query_cache.user_features_key(user_id) == before_grant {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
      }
    })
    .await
    .context("CLI grant did not publish API cache invalidation")?;
    let readback = cache_state
      .user_feature_flags_cached_l2(user_id)
      .await
      .context("read API cache after CLI grant")?;
    ensure!(
      readback.iter().any(|flag| flag == "manager"),
      "warm API cache must expose CLI grant"
    );
    let second_manager = run_json(
      &[
        "organization",
        "members",
        "add",
        "--organization",
        &organization,
        "--unit",
        &second_id_text,
        "--user",
        &email,
        "--role",
        "manager",
      ],
      &redis_namespace,
    )?;
    ensure!(second_manager["manager_capability_changed"] == false);

    let member_list = run_json(
      &[
        "organization",
        "members",
        "list",
        "--organization",
        &organization,
        "--unit",
        &second_id_text,
        "--role",
        "manager",
      ],
      &redis_namespace,
    )?;
    ensure!(member_list[0]["email"] == email);
    ensure!(member_list[0]["name"] == "Office Organization CLI");
    ensure!(member_list[0]["user_id"] == user_id.to_string());
    ensure!(member_list[0]["unit_id"] == second_id_text);
    ensure!(member_list[0]["source"] == "manual");
    ensure!(member_list[0]["created_at"].is_string() && member_list[0]["updated_at"].is_string());
    ensure!(member_list[0].get("password_hash").is_none());

    let removed = run_json(
      &[
        "organization",
        "members",
        "remove",
        "--organization",
        &organization,
        "--unit",
        &root_id_text,
        "--user",
        &email,
      ],
      &redis_namespace,
    )?;
    ensure!(removed["manager_capability_changed"] == false);
    let still_active: bool =
      sqlx::query_scalar("SELECT activated FROM user_features WHERE user_id = $1 AND feature_name = 'manager'")
        .bind(user_id)
        .fetch_one(&pool)
        .await?;
    ensure!(still_active, "another manager membership must retain the capability");

    let before_revoke = cache_state.query_cache.user_features_key(user_id);
    ensure!(
      cache_state
        .user_feature_flags_cached_l2(user_id)
        .await
        .context("warm Manager cache before downgrade")?
        .iter()
        .any(|flag| flag == "manager")
    );
    let downgraded = run_json(
      &[
        "organization",
        "members",
        "set-role",
        "--organization",
        &organization,
        "--unit",
        &second_id_text,
        "--user",
        &email,
        "--role",
        "member",
      ],
      &redis_namespace,
    )?;
    ensure!(downgraded["manager_capability_changed"] == true);
    let inactive: bool =
      sqlx::query_scalar("SELECT activated FROM user_features WHERE user_id = $1 AND feature_name = 'manager'")
        .bind(user_id)
        .fetch_one(&pool)
        .await?;
    ensure!(!inactive, "last manager-role downgrade must revoke the capability");

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
      while cache_state.query_cache.user_features_key(user_id) == before_revoke {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
      }
    })
    .await
    .context("CLI revocation did not publish API cache invalidation")?;
    let readback = cache_state
      .user_feature_flags_cached_l2(user_id)
      .await
      .context("read API cache after CLI downgrade")?;
    ensure!(
      !readback.iter().any(|flag| flag == "manager"),
      "warm API cache must drop CLI's last Manager grant"
    );
    let final_remove = run_json(
      &[
        "organization",
        "members",
        "remove",
        "--organization",
        &organization,
        "--unit",
        &second_id_text,
        "--user",
        &email,
      ],
      &redis_namespace,
    )?;
    ensure!(final_remove["role"] == "member");
    Ok(())
  }
  .await;

  subscriber.abort();
  let subscriber_stopped = subscriber.await.is_err_and(|error| error.is_cancelled());
  let cache_cleanup = cache_redis.delete_key(&format!("cache:features:{user_id}")).await;
  let cleanup_result = cleanup(
    &pool,
    organization_id,
    user_id,
    &[&child_slug, &second_slug, &root_slug],
  )
  .await;
  let types_cleanup = sqlx::query("DELETE FROM organization_unit_type WHERE id=ANY($1)")
    .bind(vec![inactive_type, child_only_type])
    .execute(&pool)
    .await;
  result?;
  cleanup_result?;
  types_cleanup?;
  cache_cleanup?;
  ensure!(subscriber_stopped, "cache subscriber must stop");
  Ok(())
}
