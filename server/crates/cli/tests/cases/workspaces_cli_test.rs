// SPDX-License-Identifier: AGPL-3.0-or-later
//! Binary-level workspace lifecycle coverage for the packaged operator CLI.
//!
//! This is intentionally one cohesive journey. It proves command wiring and
//! transaction boundaries without duplicating the lower-layer workspace test
//! matrix in a collection of slower process-per-assertion tests.

use crate::support;

use std::process::Output;
use std::sync::{Arc, Barrier};
use std::thread;

use anyhow::{Context, Result, ensure};
use myoxus_application::ports::RedisPort;
use serde_json::Value;
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use support::database_url;
use uuid::Uuid;

const DEFAULT_REDIS_URL: &str = "redis://localhost:6380";

fn redis_url() -> String {
  std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| DEFAULT_REDIS_URL.to_string())
}

fn cli_command(args: &[&str], namespace: &str, json: bool) -> support::CliCommand {
  let mut command = support::cli_command();
  command
    .env("RUN_MODE", "development")
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__REDIS__URL", redis_url())
    .env("MYOXUS__REDIS__NAMESPACE", namespace)
    .env("MYOXUS__SERVER__ORIGIN", "https://workspace-cli-test.myoxus.invalid")
    .env("RUST_LOG", "warn");
  if json {
    command.arg("--json");
  }
  command.args(args);
  command
}

fn run_cli(args: &[&str], namespace: &str, json: bool) -> Result<Output> {
  cli_command(args, namespace, json)
    .output()
    .context("run myoxus-cli workspace lifecycle command")
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

fn run_success(args: &[&str], namespace: &str) -> Result<Output> {
  let output = run_cli(args, namespace, false)?;
  ensure_success(&output)?;
  Ok(output)
}

fn run_json(args: &[&str], namespace: &str) -> Result<Value> {
  let output = run_cli(args, namespace, true)?;
  ensure_success(&output)?;
  serde_json::from_slice(&output.stdout).context("parse workspace CLI JSON")
}

async fn user_id(pool: &PgPool, email: &str) -> Result<Uuid> {
  sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
    .bind(email)
    .fetch_one(pool)
    .await
    .context("resolve test user")
}

async fn cleanup(pool: &PgPool, emails: &[String], unit_ids: &[Uuid]) -> Result<()> {
  let user_ids = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email = ANY($1)")
    .bind(emails)
    .fetch_all(pool)
    .await?;
  sqlx::query(
    "DELETE FROM workspaces WHERE owner_user_id = ANY($1)
       OR created_by_user_id = ANY($1)
       OR id IN (SELECT workspace_id FROM workspace_memberships WHERE user_id = ANY($1))",
  )
  .bind(&user_ids)
  .execute(pool)
  .await?;
  sqlx::query("DELETE FROM organization_unit WHERE id = ANY($1)")
    .bind(unit_ids)
    .execute(pool)
    .await?;
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = ANY($1) OR target_id = ANY($2)")
    .bind(&user_ids)
    .bind(
      user_ids
        .iter()
        .chain(unit_ids.iter())
        .map(ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .execute(pool)
    .await?;
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(&user_ids)
    .execute(pool)
    .await?;
  Ok(())
}

async fn cleanup_redis_namespace(namespace: &str) -> Result<()> {
  // This namespace includes the test's random UUID; never scan or flush another
  // test's keys. CLI session invalidation creates entries outside SQL cleanup.
  let redis = myoxus_infrastructure::redis::RedisAdapter::new(redis_url(), namespace)
    .map_err(|error| anyhow::anyhow!("connect test Redis namespace: {error}"))?;
  redis
    .delete_by_pattern("*")
    .await
    .map_err(|error| anyhow::anyhow!("clean test Redis namespace: {error}"))?;
  let remaining = redis
    .delete_by_pattern("*")
    .await
    .map_err(|error| anyhow::anyhow!("verify test Redis namespace: {error}"))?;
  ensure!(remaining == 0, "test Redis namespace retained keys after cleanup");
  Ok(())
}

#[tokio::test]
async fn workspace_cli_preserves_complete_user_and_ou_lifecycle() -> Result<()> {
  let pool = PgPoolOptions::new()
    .max_connections(6)
    .connect(&database_url())
    .await
    .context("connect isolated CLI test database")?;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .context("apply CLI test migrations")?;

  let suffix = Uuid::new_v4();
  let namespace = format!("myoxus:workspace-cli-test:{suffix}");
  let owner_email = format!("workspace-owner-{suffix}@test.local");
  let next_owner_email = format!("workspace-next-owner-{suffix}@test.local");
  let member_email = format!("workspace-member-{suffix}@test.local");
  let admin_email = format!("workspace-admin-{suffix}@test.local");
  let users = [
    (&owner_email, format!("Workspace Owner {suffix}")),
    (&next_owner_email, format!("Workspace Next Owner {suffix}")),
    (&member_email, format!("Workspace Member {suffix}")),
    (&admin_email, format!("Workspace Admin {suffix}")),
  ];
  let unit_ids = [Uuid::new_v4(), Uuid::new_v4()];
  let result: Result<()> = async {
    for (email, name) in &users {
      run_json(&["users", "create", "--email", email, "--name", name], &namespace)?;
    }
    run_success(&["users", "set-admin", &admin_email, "--admin"], &namespace)?;

    let owner_id = user_id(&pool, &owner_email).await?;
    let next_owner_id = user_id(&pool, &next_owner_email).await?;
    let organization_id: Uuid = sqlx::query_scalar("SELECT id FROM organization WHERE key = 'myoxus'")
      .fetch_one(&pool)
      .await?;
    let unit_type_id: Uuid = sqlx::query_scalar(
      "SELECT id FROM organization_unit_type
        WHERE organization_id = $1 AND is_active = TRUE
          AND can_be_root_level = TRUE AND can_own_workspaces = TRUE
        ORDER BY key LIMIT 1",
    )
    .bind(organization_id)
    .fetch_one(&pool)
    .await?;
    for (index, unit_id) in unit_ids.iter().enumerate() {
      sqlx::query(
        "INSERT INTO organization_unit
          (id, organization_id, unit_type_id, name, slug, status)
         VALUES ($1, $2, $3, $4, $5, 'active')",
      )
      .bind(unit_id)
      .bind(organization_id)
      .bind(unit_type_id)
      .bind(format!("Workspace CLI Unit {} {suffix}", index + 1))
      .bind(format!("workspace-cli-unit-{}-{suffix}", index + 1))
      .execute(&pool)
      .await?;
    }

    let workspace_name = format!("Workspace Lifecycle {suffix}");
    let raw_workspace_name = format!("  Workspace   Lifecycle {suffix}  ");
    let created = run_json(
      &[
        "workspaces",
        "create",
        "--owner-user",
        &owner_email,
        "--name",
        &raw_workspace_name,
      ],
      &namespace,
    )?;
    let workspace_id: Uuid = created["id"].as_str().context("created workspace id")?.parse()?;
    let workspace = workspace_id.to_string();
    ensure!(created["name"] == workspace_name, "persisted normalized Workspace name");
    let root: Vec<u8> =
      sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id=$1 AND doc_id=$1 AND sequence=1")
        .bind(workspace_id)
        .fetch_one(&pool)
        .await?;
    let metadata = yjs::extract_workspace_root_metadata(&root).map_err(anyhow::Error::msg)?;
    ensure!(
      metadata.name.as_deref() == Some(workspace_name.as_str()),
      "root uses the final normalized Workspace name"
    );

    let ownership_rows = sqlx::query(
      "SELECT is_personal_workspace, owner_principal_type::text AS owner_type
         FROM workspaces WHERE owner_user_id = $1 ORDER BY is_personal_workspace DESC",
    )
    .bind(owner_id)
    .fetch_all(&pool)
    .await?;
    ensure!(
      ownership_rows.len() == 2,
      "generic create must add exactly one workspace"
    );
    ensure!(ownership_rows[0].get::<bool, _>("is_personal_workspace"));
    ensure!(!ownership_rows[1].get::<bool, _>("is_personal_workspace"));
    ensure!(ownership_rows[1].get::<String, _>("owner_type") == "user");

    // Deliver one extra immutable package through files, then use the real CLI
    // prepare/confirm path. The fixture changes no compiled offering dispatch.
    let package_root = tempfile::tempdir()?;
    support::copy_feature_templates(package_root.path());
    use myoxus_domain::assistant_package::AssistantPackageContext;
    let captured = support::feature_sources();
    let assistant_sources = captured.bundles[0].assistants.values().next().context("native assistant sources")?;
    let original = assistant_sources.catalog.packages.iter()
      .find(|entry| entry.default_for.contains(&AssistantPackageContext::ProjectCreation))
      .context("native default Project package")?;
    let (original_source, original_digest) = assistant_sources.definitions.iter()
      .find(|(source, _)| source.id == original.id && source.version == original.current)
      .context("native current Project definition")?;
    let original_identity = myoxus_domain::assistant_package::AssistantPackageIdentity {
      id: original_source.id.clone(),
      version: original_source.version.clone(),
      digest: original_digest.clone(),
    };
    let mut extra = original_source.clone();
    // This lifecycle journey delivers only a Project. Keep its native controls
    // and schema link, without the base's optional document controls/components:
    // their retained revisions are intentionally not platform exports.
    extra.components.retain(|component| matches!(
      component.action,
      myoxus_domain::assistant_package::AssistantNativeAction::CreateProject { .. }
    ));
    extra.inputs.retain(|input| input.target != myoxus_domain::assistant_package::AssistantInputTarget::IncludeComponent);
    for step in &mut extra.presentation.steps {
      step.groups.retain(|group| group.id != "documents");
    }
    let extra_id = "myoxus.assistant.fixture.cli_project";
    extra.id = extra_id.into();
    support::add_assistant_feature(package_root.path(), &extra, &original_identity)?;
    let source = serde_json::to_value(&extra)?;
    let package_cli=|args:&[&str]|->Result<Output>{let mut command=cli_command(args,&namespace,true);command.env("MYOXUS__TEMPLATES__ROOT_DIR",package_root.path());command.output().context("run file-authored package CLI")};
    let actor=owner_id.to_string();
    let list=package_cli(&["database","assistants","--actor-user-id",&actor,"--workspace-id",&workspace])?;
    ensure_success(&list)?;
    let list:Value=serde_json::from_slice(&list.stdout)?;
    let descriptor=list.as_array().unwrap().iter().find(|package|package["identity"]["id"]==extra_id).context("extra CLI offering is listed")?;
    let version=descriptor["identity"]["version"].as_str().unwrap();
    let digest=descriptor["identity"]["digest"].as_str().unwrap();
    let mut answers=serde_json::json!({});
    for input in source["inputs"].as_array().unwrap(){
      if input["required"]==true && input["default"].is_null(){
        let value=if input["target"]=="title"{"CLI file-owned Project"}else{"Native CLI prepared description"};
        answers[input["id"].as_str().unwrap()]=serde_json::json!({"kind":"text","value":value});
      }
      if input["target"]=="includeScaffold" {
        answers[input["id"].as_str().unwrap()]=serde_json::json!({"kind":"boolean","value":false});
      }
      if input["target"]=="description" {
        answers[input["id"].as_str().unwrap()]=serde_json::json!({"kind":"text","value":"é".repeat(32768)});
      }
    }
    let answers_path=package_root.path().join("answers.json");
    std::fs::write(&answers_path,serde_json::to_vec(&answers)?)?;
    let args=["database","project","--actor-user-id",&actor,"--workspace-id",&workspace,"--package-id",extra_id,"--package-version",version,"--package-digest",digest,"--answers",answers_path.to_str().unwrap()];
    let before:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 ORDER BY id").bind(workspace_id).fetch_all(&pool).await?;
    let prepared=package_cli(&args)?;ensure_success(&prepared)?;
    let prepared:Value=serde_json::from_slice(&prepared.stdout)?;
    let after:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 ORDER BY id").bind(workspace_id).fetch_all(&pool).await?;
    ensure!(before==after,"CLI package listing/preparation must be read-only");
    let request_id=Uuid::new_v4().to_string();
    let locale=prepared["plan"]["locale"].as_str().context("prepared native locale")?;
    let mut confirmed=args.to_vec();confirmed.extend(["--request-id",&request_id,"--locale",locale,"--confirm-plan","invalid-plan"]);
    ensure!(!package_cli(&confirmed)?.status.success(),"tampered CLI confirmation must fail");
    let after_rejection:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 ORDER BY id").bind(workspace_id).fetch_all(&pool).await?;
    ensure!(before==after_rejection,"invalid confirmation cannot write");
    let plan_digest=prepared["planDigest"].as_str().context("prepared canonical digest")?;
    let mut confirmed=args.to_vec();confirmed.extend(["--request-id",&request_id,"--locale",locale,"--confirm-plan",plan_digest]);
    let applied=package_cli(&confirmed)?;ensure_success(&applied)?;
    let applied:Value=serde_json::from_slice(&applied.stdout)?;
    ensure!(applied["status"]=="ready","all native setup stages acknowledged");
    let repeated=package_cli(&confirmed)?;ensure_success(&repeated)?;
    let repeated:Value=serde_json::from_slice(&repeated.stdout)?;
    ensure!(repeated["database"]["database"]["id"]==applied["database"]["database"]["id"],"same CLI request cannot allocate another Project");
    let status=package_cli(&["database","project-status","--actor-user-id",&actor,"--workspace-id",&workspace,"--request-id",&request_id])?;
    ensure_success(&status)?;
    let status:Value=serde_json::from_slice(&status.stdout)?;
    for output in [&applied,&repeated,&status] {
      ensure!(output["status"]=="ready");
      ensure!(output["accepted"]["requestId"]==request_id);
      ensure!(output["accepted"]["ids"]==applied["accepted"]["ids"],"create, replay and readback preserve native reservations");
      ensure!(output["accepted"]["plan"]==prepared["plan"],"accepted review remains exact");
      for field in ["operation","actorId","workspaceId","fingerprint","state","admission"] {
        ensure!(output["accepted"].get(field).is_some(),"missing accepted metadata: {field}");
      }
      ensure!(output["accepted"].get("progress").is_none(),"historical progress must not bypass current document Open authority");
      ensure!(output["documents"]==serde_json::json!([]),"document results use the explicit native authorized projection even when empty");
      ensure!(output["placementComplete"]==true,"Ready acknowledges native placement");
    }
    let project_id:Uuid=applied["database"]["database"]["id"].as_str().context("ordinary native result")?.parse()?;
    let initial_view:Uuid=applied["initialViewId"].as_str().context("actual selected native View")?.parse()?;
    let created:(Option<String>,String,i64)=sqlx::query_as("SELECT d.system_role,p.profile_kind,(SELECT count(*) FROM workspace_database_rows WHERE database_id=d.id) FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id WHERE d.id=$1 AND d.workspace_id=$2").bind(project_id).bind(workspace_id).fetch_one(&pool).await?;
    ensure!(created==(None,"project".into(),0),"file-only package applies one native managed Project with samples disabled");
    let view_owner:Uuid=sqlx::query_scalar("SELECT database_id FROM workspace_database_views WHERE id=$1").bind(initial_view).fetch_one(&pool).await?;
    ensure!(view_owner==project_id);

    let renamed = format!("Workspace Lifecycle Renamed {suffix}");
    run_json(&["workspaces", "update", &workspace, "--name", &renamed], &namespace)?;
    run_success(
      &[
        "workspaces",
        "add-member",
        &workspace,
        &member_email,
        "--role",
        "Reader",
        "--actor",
        &admin_email,
      ],
      &namespace,
    )?;
    run_success(
      &[
        "workspaces",
        "set-member-role",
        &workspace,
        &member_email,
        "--role",
        "Collaborator",
      ],
      &namespace,
    )?;
    run_success(
      &["workspaces", "set-sharing", &workspace, "--enabled", "true"],
      &namespace,
    )?;
    run_success(
      &["workspaces", "set-public", &workspace, "--enabled", "true"],
      &namespace,
    )?;

    let first_unit = unit_ids[0].to_string();
    let second_unit = unit_ids[1].to_string();
    run_success(
      &["workspaces", "set-management-unit", &workspace, "--unit", &first_unit],
      &namespace,
    )?;
    run_success(
      &["workspaces", "set-management-unit", &workspace, "--clear"],
      &namespace,
    )?;
    run_success(
      &[
        "workspaces",
        "transfer-owner",
        &workspace,
        "--to-user",
        &next_owner_email,
      ],
      &namespace,
    )?;
    let new_owner_role: String =
      sqlx::query_scalar("SELECT role::text FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
        .bind(workspace_id)
        .bind(next_owner_id)
        .fetch_one(&pool)
        .await?;
    ensure!(new_owner_role == "Owner");
    let previous_owner_role: String =
      sqlx::query_scalar("SELECT role::text FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
        .bind(workspace_id)
        .bind(owner_id)
        .fetch_one(&pool)
        .await?;
    ensure!(previous_owner_role == "Admin");

    run_success(
      &["workspaces", "transfer-owner", &workspace, "--to-unit", &first_unit],
      &namespace,
    )?;
    let human_owner_count: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = $1 AND role = 'Owner'")
        .bind(workspace_id)
        .fetch_one(&pool)
        .await?;
    ensure!(
      human_owner_count == 0,
      "OU-owned workspaces must not keep a human Owner"
    );

    // Two concurrent transfers serialize on the workspace row. Both may apply
    // in sequence, but the committed state must contain exactly one owner link.
    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for unit in [first_unit.clone(), second_unit.clone()] {
      let barrier = barrier.clone();
      let namespace = namespace.clone();
      let workspace = workspace.clone();
      handles.push(thread::spawn(move || {
        barrier.wait();
        run_cli(
          &["workspaces", "transfer-owner", &workspace, "--to-unit", &unit],
          &namespace,
          false,
        )
      }));
    }
    barrier.wait();
    for handle in handles {
      ensure_success(&handle.join().expect("owner transfer thread")?)?;
    }
    let owner_links: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM organization_unit_workspace
        WHERE workspace_id = $1 AND relationship = 'owner'",
    )
    .bind(workspace_id)
    .fetch_one(&pool)
    .await?;
    ensure!(owner_links == 1, "concurrent transfers must leave one OU owner");

    run_success(
      &[
        "workspaces",
        "set-member-role",
        &workspace,
        &owner_email,
        "--role",
        "Manager",
      ],
      &namespace,
    )?;
    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for operation in ["demote", "remove"] {
      let barrier = barrier.clone();
      let namespace = namespace.clone();
      let workspace = workspace.clone();
      let next_owner_email = next_owner_email.clone();
      handles.push(thread::spawn(move || {
        barrier.wait();
        if operation == "demote" {
          run_cli(
            &[
              "workspaces",
              "set-member-role",
              &workspace,
              &next_owner_email,
              "--role",
              "Reader",
            ],
            &namespace,
            false,
          )
        } else {
          run_cli(
            &["workspaces", "remove-member", &workspace, &next_owner_email],
            &namespace,
            false,
          )
        }
      }));
    }
    barrier.wait();
    for handle in handles {
      let output = handle.join().expect("last Admin mutation thread")?;
      ensure!(!output.status.success(), "concurrent last Admin mutation must fail");
    }
    let remaining_admins: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM workspace_memberships
        WHERE workspace_id = $1 AND role = 'Admin' AND status = 'Accepted'",
    )
    .bind(workspace_id)
    .fetch_one(&pool)
    .await?;
    ensure!(
      remaining_admins == 1,
      "failed concurrent mutations must preserve the last Admin"
    );

    run_success(
      &[
        "workspaces",
        "transfer-owner",
        &workspace,
        "--to-user",
        &next_owner_email,
      ],
      &namespace,
    )?;
    run_success(&["workspaces", "delete", &workspace, "--confirm"], &namespace)?;
    let deleted = run_json(&["workspaces", "get", &workspace], &namespace)?;
    ensure!(!deleted["deleted_at"].as_str().unwrap_or_default().is_empty());
    let active = run_json(&["workspaces", "list", "--user", &next_owner_email], &namespace)?;
    ensure!(
      active
        .as_array()
        .context("workspace list array")?
        .iter()
        .all(|entry| entry["id"] != workspace),
      "soft-deleted workspace must leave active lists"
    );

    // The specialized shared-workspace command must reject the wrong owner
    // type before restoration; otherwise a failed command would still mutate
    // a user-owned workspace.
    let wrong_undelete = run_cli(&["shared-workspaces", "undelete", &workspace], &namespace, false)?;
    ensure!(!wrong_undelete.status.success());
    let still_deleted: bool = sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM workspaces WHERE id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await?;
    ensure!(still_deleted, "rejected shared undelete must not mutate the workspace");

    run_json(&["workspaces", "undelete", &workspace], &namespace)?;
    let restored_id: Uuid = sqlx::query_scalar("SELECT id FROM workspaces WHERE id = $1 AND deleted_at IS NULL")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await?;
    ensure!(restored_id == workspace_id);

    let shared_name = format!("Shared Lifecycle {suffix}");
    let shared = run_json(
      &[
        "shared-workspaces",
        "create",
        "--name",
        &shared_name,
        "--unit",
        &first_unit,
        "--admin",
        &admin_email,
      ],
      &namespace,
    )?;
    let shared_id: Uuid = shared["id"].as_str().context("shared workspace id")?.parse()?;
    let shared_id_text = shared_id.to_string();
    run_json(
      &[
        "shared-workspaces",
        "update",
        &shared_id_text,
        "--name",
        &format!("Shared Lifecycle Renamed {suffix}"),
      ],
      &namespace,
    )?;
    run_success(
      &[
        "shared-workspaces",
        "add-member",
        &shared_id_text,
        &member_email,
        "--role",
        "Reader",
        "--actor",
        &admin_email,
      ],
      &namespace,
    )?;
    run_success(
      &[
        "shared-workspaces",
        "set-member-role",
        &shared_id_text,
        &member_email,
        "--role",
        "Manager",
      ],
      &namespace,
    )?;
    run_success(
      &["shared-workspaces", "delete", &shared_id_text, "--confirm"],
      &namespace,
    )?;
    run_json(&["shared-workspaces", "undelete", &shared_id_text], &namespace)?;

    Ok(())
  }
  .await;

  let emails = users.into_iter().map(|(email, _)| email.clone()).collect::<Vec<_>>();
  let cleanup_result = cleanup(&pool, &emails, &unit_ids).await;
  let redis_cleanup_result = cleanup_redis_namespace(&namespace).await;
  result.and(cleanup_result).and(redis_cleanup_result)
}

/// Drives the actual CLI wire/file contract. A forced audit failure proves that
/// assignments, legacy mappings, root deltas and outbox delivery share a commit.
#[tokio::test]
async fn workspace_labels_cli_reconciliation_is_explicit_atomic_revision_bound_and_replay_safe() -> Result<()> {
  use myoxus_application::workspace_tags::migration::LabelMigrationRepository;
  use myoxus_infrastructure::doc_cache::{DocCache, RedisDocCacheConfig};
  use myoxus_infrastructure::redis::RedisAdapter;
  use myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository;
  use myoxus_workspace_import::WorkspaceImportLimits;
  use std::collections::HashMap;
  use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

  let pool = PgPoolOptions::new().max_connections(4).connect(&database_url()).await?;
  myoxus_infrastructure::migrations::run(&pool).await?;
  let workspace = Uuid::new_v4();
  let actor = Uuid::new_v4();
  let active = Uuid::new_v4();
  let archived = Uuid::new_v4();
  let docs = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
  // UUID-shaped external key deliberately equals a different internal doc ID.
  let keys = [docs[2].to_string(), "conflict".into(), "legacy".into(), "stale".into()];
  let namespace = format!("myoxus:label-cli-test:{workspace}");
  let cache = DocCache::new(
    Arc::new(RedisAdapter::from_client(
      myoxus_infrastructure::tls::redis::client(&redis_url(), None).map_err(anyhow::Error::msg)?,
      format!("{namespace}:cache"),
    )),
    "myoxus",
    &RedisDocCacheConfig::default(),
  );
  let temporary = tempfile::tempdir()?;
  let decision_file = temporary.path().join("decisions.json");
  let path = decision_file.to_str().context("decision file path")?;
  let workspace_text = workspace.to_string();
  let actor_text = actor.to_string();
  let trigger = format!("label_repair_failure_{}", workspace.simple());
  let result: Result<()> = async {
    sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, 'Label CLI operator', now())")
      .bind(actor).bind(format!("label-cli-{actor}@test.local")).execute(&pool).await?;
    sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'Label CLI fixture')")
      .bind(workspace).bind(actor).execute(&pool).await?;
    for (id, key, is_root) in std::iter::once((workspace, workspace_text.as_str(), true))
      .chain(docs.iter().zip(&keys).map(|(id, key)| (*id, key.as_str(), false))) {
      sqlx::query("INSERT INTO docs (id, workspace_id, external_id, title, is_workspace_root, created_by, updated_by) VALUES ($1,$2,$3,$3,$4,$5,$5)")
        .bind(id).bind(workspace).bind(key).bind(is_root).bind(actor).execute(&pool).await?;
    }
    for (id, name, color, archived_at) in [(active, "Same name", "tag.blue", None), (archived, "Archived", "tag.grey", Some("2024-01-02T03:04:05Z"))] {
      sqlx::query("INSERT INTO workspace_tags (id, workspace_id, name, slug, color_role, archived_at, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6::text::timestamptz,$7,$7)")
        .bind(id).bind(workspace).bind(name).bind(id.to_string()).bind(color).bind(archived_at).bind(actor).execute(&pool).await?;
    }
    sqlx::query("INSERT INTO workspace_tag_document_assignments(workspace_id, doc_id, tag_id, position) VALUES ($1,$2,$3,0)")
      .bind(workspace).bind(docs[0]).bind(active).execute(&pool).await?;
    sqlx::query("INSERT INTO workspace_tag_retired_ids (workspace_id, retired_tag_id, retired_at) VALUES ($1,'retired',now())")
      .bind(workspace).execute(&pool).await?;
    let mut pages = keys.iter().enumerate().map(|(index, key)| yjs::ImportedWorkspacePage {
      id: key.clone(), title: format!("Preserved title {index}"), mode: "page".into(), parent_id: None,
      order: index.to_string(), created_at_ms: 1, updated_at_ms: 2, is_trashed: index == 3,
    }).collect::<Vec<_>>();
    pages.push(yjs::ImportedWorkspacePage {
      id: "missing-document".into(), title: "Unmapped root page".into(), mode: "page".into(),
      parent_id: None, order: "4".into(), created_at_ms: 1, updated_at_ms: 2, is_trashed: false,
    });
    let source = yjs::project_workspace_tags_in_root_doc(
      &yjs::create_imported_workspace_doc("Unrelated workspace name", &pages),
      &serde_json::json!([
        {"id": active, "name": "Same name", "colorRole": "tag.blue"},
        {"id": archived, "name": "Archived", "colorRole": "tag.grey", "archived": true, "archivedAt": "2024-01-02T03:04:05Z"},
        {"id": "legacy-only", "name": "Same name", "colorRole": "tag.green", "description": "Preserved description", "archived": true, "archivedAt": "2024-01-02T03:04:05Z"}
      ]),
      &HashMap::from([(keys[0].clone(), vec![active.to_string()]), (keys[1].clone(), vec![archived.to_string()]),
        (keys[2].clone(), vec!["legacy-only".into()]), (keys[3].clone(), vec!["retired".into()])]),
    ).map_err(anyhow::Error::msg)?;
    sqlx::query("INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence) VALUES ($1,$1,$2,0)")
      .bind(workspace).bind(&source).execute(&pool).await?;
    cache.set_snapshot(workspace, workspace, &source).await;
    ensure!(cache.get_snapshot(workspace, workspace).await.as_ref() == Some(&source));
    let inspect_args = ["workspaces", "labels", "inspect", &workspace_text];
    let before = run_json(&inspect_args, &namespace)?;
    let entry = |report: &Value, key: &str| -> Value {
      report["documents"].as_array().and_then(|docs| docs.iter().find(|doc| doc["external_id"] == key)).cloned().unwrap_or(Value::Null)
    };
    ensure!(entry(&before, &keys[0])["doc_id"] == docs[0].to_string(), "external UUID must not resolve as another internal ID");
    ensure!(entry(&before, "missing-document")["status"] == "unmapped_document");
    ensure!(entry(&before, "missing-document")["sql_tags"].is_null());
    let bounded = PgWorkspaceTagRepository::new(pool.clone(), support::database_starter_catalog()).inspect_labels(workspace,
      WorkspaceImportLimits { max_documents: 4, ..WorkspaceImportLimits::default() }).await;
    ensure!(bounded.is_err(), "root-only identities must count toward inspection limits");
    ensure!(entry(&before, &keys[0])["status"] == "equal");
    ensure!(entry(&before, "conflict")["status"] == "different");
    ensure!(entry(&before, "legacy")["unknown_ids"] == serde_json::json!(["legacy-only"]));
    ensure!(entry(&before, "stale")["retired_ids"] == serde_json::json!(["retired"]));
    ensure!(cache.get_snapshot(workspace, workspace).await.as_ref() == Some(&source), "inspect must be read-only");
    let mut decision = serde_json::json!({"workspace_id":workspace, "sql_revision":before["sql_revision"], "root_revision":before["root_revision"],
      "documents":[{"external_id":keys[0],"tag_ids":[active]},{"external_id":"conflict","tag_ids":[archived,active]},
        {"external_id":"legacy","tag_ids":["legacy-only"]}], "import_legacy_ids":["legacy-only"]});
    std::fs::write(&decision_file, serde_json::to_vec(&decision)?)?;
    let unacknowledged = run_cli(&["workspaces","labels","apply",&workspace_text,"--decisions",path,"--actor",&actor_text], &namespace, true)?;
    ensure!(!unacknowledged.status.success());
    let apply_args = ["workspaces","labels","apply",&workspace_text,"--decisions",path,"--actor",&actor_text,"--cutover-acknowledged"];
    // Change real SQL input after inspection, rather than only fabricating a bad hash.
    sqlx::query("UPDATE workspace_tags SET description='Changed after inspect', updated_at=now() WHERE id=$1")
      .bind(active).execute(&pool).await?;
    ensure!(!run_cli(&apply_args, &namespace, true)?.status.success(), "changed SQL must reject the inspected plan");
    let fresh = run_json(&inspect_args, &namespace)?;
    decision["sql_revision"] = fresh["sql_revision"].clone();
    // A root-only change also invalidates the plan; it must not affect unrelated SQL tags.
    let changed_root = yrs::Doc::new();
    changed_root.transact_mut().apply_update(yrs::Update::decode_v1(&source)?)?;
    let meta = changed_root.get_or_insert_map("meta");
    let vector = changed_root.transact().state_vector();
    meta.insert(&mut changed_root.transact_mut(), "name", "Changed root name");
    let root_delta = changed_root.transact().encode_diff_v1(&vector);
    sqlx::query("INSERT INTO doc_updates(doc_id,workspace_id,payload,sequence) VALUES($1,$1,$2,1)")
      .bind(workspace).bind(root_delta).execute(&pool).await?;
    std::fs::write(&decision_file, serde_json::to_vec(&decision)?)?;
    ensure!(!run_cli(&apply_args, &namespace, true)?.status.success(), "changed root must reject the inspected plan");
    let fresh = run_json(&inspect_args, &namespace)?;
    decision["root_revision"] = fresh["root_revision"].clone();
    let original_file = serde_json::to_vec(&decision)?;
    std::fs::write(&decision_file, &original_file)?;
    // Scope the injected failure to this unique fixture and remove it before continuing.
    sqlx::raw_sql(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_id = '{workspace}' AND NEW.event_key = 'workspace.labels_reconcile' THEN RAISE EXCEPTION 'label fixture audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER {trigger} BEFORE INSERT ON admin_audit_log FOR EACH ROW EXECUTE FUNCTION {trigger}();"))
      .execute(&pool).await?;
    ensure!(!run_cli(&apply_args, &namespace, true)?.status.success());
    let rejected = run_json(&inspect_args, &namespace)?;
    ensure!(rejected["sql_revision"] == fresh["sql_revision"] && rejected["root_revision"] == fresh["root_revision"], "failed audit must roll back SQL and root together");
    let outbox: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE event_type='workspace_doc_broadcast' AND payload->>'workspaceId'=$1")
      .bind(&workspace_text).fetch_one(&pool).await?;
    ensure!(outbox == 0, "failed repair must not publish an outbox entry");
    sqlx::raw_sql(&format!("DROP TRIGGER {trigger} ON admin_audit_log; DROP FUNCTION {trigger}();")).execute(&pool).await?;
    let applied = run_json(&apply_args, &namespace)?;
    ensure!(applied["changed"] == true && applied["root_catalog_removed"] == false);
    let delivered: Value = sqlx::query_scalar("SELECT payload->'updates' FROM outbox_events WHERE event_type='workspace_doc_broadcast' AND payload->>'workspaceId'=$1")
      .bind(&workspace_text).fetch_one(&pool).await?;
    ensure!(delivered == serde_json::json!([{"docId": workspace, "sequence": 2}]), "outbox must reference the committed root delta");

    ensure!(std::fs::read(&decision_file)? == original_file, "apply must not edit its decision input");
    ensure!(cache.get_snapshot(workspace, workspace).await.is_none(), "committed root cleanup must invalidate the real cache key");
    let after = run_json(&inspect_args, &namespace)?;
    let imported = Uuid::new_v5(&workspace, b"tag:legacy-only");
    ensure!(entry(&after, "legacy")["sql_tags"] == serde_json::json!([imported]));
    ensure!(entry(&after, "legacy")["yjs_tags"].is_null());
    ensure!(entry(&after, "conflict")["sql_tags"] == serde_json::json!([archived,active]), "explicit archived ordering must survive");
    ensure!(entry(&after, "stale") == entry(&fresh, "stale"), "unresolved document must remain untouched");
    let imported_tag = after["catalog"].as_array().context("catalog")?.iter().find(|tag| tag["id"] == imported.to_string()).context("imported tag")?;
    ensure!(imported_tag["name"] == "Same name" && imported_tag["description"] == "Preserved description");
    ensure!(imported_tag["archived_at"].as_str().context("archive timestamp")?.starts_with("2024-01-02T03:04:05"));
    let stored_source: Vec<u8> = sqlx::query_scalar("SELECT payload FROM doc_snapshots WHERE doc_id=$1").bind(workspace).fetch_one(&pool).await?;
    ensure!(stored_source == source, "repair must append instead of rewriting the snapshot");
    let before_replay: Value = sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_array(doc_id,tag_id,created_at) ORDER BY doc_id,position) FROM workspace_tag_document_assignments WHERE workspace_id=$1")
      .bind(workspace).fetch_one(&pool).await?;
    let replay = run_json(&apply_args, &namespace)?;
    ensure!(replay["changed"] == false && run_json(&inspect_args, &namespace)?["root_revision"] == after["root_revision"]);
    let after_replay: Value = sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_array(doc_id,tag_id,created_at) ORDER BY doc_id,position) FROM workspace_tag_document_assignments WHERE workspace_id=$1")
      .bind(workspace).fetch_one(&pool).await?;
    ensure!(before_replay == after_replay, "completed retry must not rewrite assignment rows");
    let updates: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id=$1").bind(workspace).fetch_one(&pool).await?;
    ensure!(updates == 2, "one fixture delta plus exactly one repair delta");
    let audit: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='workspace.labels_reconcile'").bind(&workspace_text).fetch_one(&pool).await?;
    ensure!(audit == 1, "completed retry must not produce another audit mutation");
    let mut final_decision = serde_json::json!({"workspace_id":workspace,"sql_revision":after["sql_revision"],"root_revision":after["root_revision"],"documents":[{"external_id":"stale","tag_ids":["retired"]}]});
    std::fs::write(&decision_file, serde_json::to_vec(&final_decision)?)?;
    ensure!(!run_cli(&apply_args, &namespace, true)?.status.success(), "retired identity must not be resurrected");
    final_decision["documents"][0]["tag_ids"] = serde_json::json!([]);
    std::fs::write(&decision_file, serde_json::to_vec(&final_decision)?)?;
    ensure!(run_json(&apply_args, &namespace)?["root_catalog_removed"] == true);
    let final_report = run_json(&inspect_args, &namespace)?;
    ensure!(final_report["legacy_catalog"] == serde_json::json!([]));
    ensure!(entry(&final_report,"stale")["sql_tags"] == serde_json::json!([]));
    let tails = sqlx::query_scalar::<_, Vec<u8>>("SELECT payload FROM doc_updates WHERE doc_id=$1 ORDER BY sequence").bind(workspace).fetch_all(&pool).await?;
    let merged = yjs::merge_updates(std::iter::once(source).chain(tails).collect()).map_err(anyhow::Error::msg)?;
    let metadata = yjs::extract_workspace_root_metadata(&merged).map_err(anyhow::Error::msg)?;
    ensure!(metadata.name.as_deref() == Some("Changed root name"));
    ensure!(metadata.pages.len() == pages.len() && metadata.pages[3].is_trashed);
    ensure!(metadata.pages.iter().zip(&pages).all(|(actual, expected)| actual.title.as_ref() == Some(&expected.title) && !actual.tags_present));
    Ok(())
  }.await;
  // Cleanup is explicit even after a failed assertion; no test-owned global
  // trigger, audit/outbox record, cache key, workspace or user may escape.
  let cleanup: Result<()> = async {
    sqlx::raw_sql(&format!(
      "DROP TRIGGER IF EXISTS {trigger} ON admin_audit_log; DROP FUNCTION IF EXISTS {trigger}();"
    ))
    .execute(&pool)
    .await?;
    sqlx::query("DELETE FROM outbox_events WHERE event_type='workspace_doc_broadcast' AND payload->>'workspaceId'=$1")
      .bind(&workspace_text)
      .execute(&pool)
      .await?;
    sqlx::query("DELETE FROM admin_audit_log WHERE target_id=$1 OR actor_user_id=$2")
      .bind(&workspace_text)
      .bind(actor)
      .execute(&pool)
      .await?;
    sqlx::query("DELETE FROM workspaces WHERE id=$1")
      .bind(workspace)
      .execute(&pool)
      .await?;
    sqlx::query("DELETE FROM users WHERE id=$1")
      .bind(actor)
      .execute(&pool)
      .await?;
    cache.invalidate_snapshot(workspace, workspace).await;
    Ok(())
  }
  .await;
  result.and(cleanup)
}
