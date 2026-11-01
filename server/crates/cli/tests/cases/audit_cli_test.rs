// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::support;

use std::process::Output;

use anyhow::{Context, Result, ensure};
use myoxus_application::audit::AuditRecorder;
use myoxus_domain::audit::{AuditFilter, AuditLogStore};
use myoxus_infrastructure::audit::PgAuditLogStore;
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

const SECRET: &str = "AUDIT-HISTORICAL-CONTENT-preserve-verbatim";
const TIME: &str = "2026-10-15T00:00:00Z";

fn cli(args: &[&str], json: bool) -> Result<Output> {
  let mut command = support::cli_command();
  command
    .env("RUN_MODE", "development")
    .env("MYOXUS__DATABASE__URL", support::database_url())
    // A read must not construct the unrelated Redis/storage service graph.
    .env("MYOXUS__REDIS__URL", "redis://127.0.0.1:1")
    .env("MYOXUS__STORAGE__BACKEND", "not-a-storage-backend")
    .env("RUST_LOG", "debug");
  if json {
    command.arg("--json");
  }
  let output = command.args(args).output().context("operate audit CLI")?;
  Ok(output)
}

fn success(args: &[&str], json: bool) -> Result<Output> {
  let output = cli(args, json)?;
  ensure!(
    output.status.success(),
    "audit CLI failed: {}",
    String::from_utf8_lossy(&output.stderr)
  );
  Ok(output)
}

fn json(args: &[&str]) -> Result<Value> {
  serde_json::from_slice(&success(args, true)?.stdout).context("decode complete audit record")
}

struct Fixture {
  user: Uuid,
  organization: Uuid,
  unit_type: Uuid,
  unit: Uuid,
  prefix: String,
  ids: Vec<Uuid>,
}

impl Fixture {
  async fn seed(pool: &PgPool) -> Result<Self> {
    let mut fixture = Self {
      user: Uuid::new_v4(),
      organization: Uuid::new_v4(),
      unit_type: Uuid::new_v4(),
      unit: Uuid::new_v4(),
      prefix: format!("cli.audit_{}.", Uuid::new_v4()),
      ids: Vec::new(),
    };
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO users (id,email) VALUES ($1,$2)")
      .bind(fixture.user)
      .bind(format!("{}@audit-cli.test", fixture.user))
      .execute(&mut *tx)
      .await?;
    sqlx::query("INSERT INTO organization (id,key,name,slug) VALUES ($1,$2,'Audit CLI',$2)")
      .bind(fixture.organization)
      .bind(fixture.organization.to_string())
      .execute(&mut *tx)
      .await?;
    sqlx::query("INSERT INTO organization_unit_type (id,organization_id,key,label,is_structural,can_have_children,can_be_root_level,can_be_manager_created,can_have_cross_unit_members,can_own_workspaces,can_manage_workspaces) VALUES ($1,$2,'audit','Audit',true,true,true,false,false,false,false)")
      .bind(fixture.unit_type)
      .bind(fixture.organization)
      .execute(&mut *tx)
      .await?;
    sqlx::query(
      "INSERT INTO organization_unit (id,organization_id,unit_type_id,name,slug) VALUES ($1,$2,$3,'Audit','audit')",
    )
    .bind(fixture.unit)
    .bind(fixture.organization)
    .bind(fixture.unit_type)
    .execute(&mut *tx)
    .await?;

    // Two exact matches plus one decoy for each predicate. Ignoring any filter
    // includes a decoy, rather than accidentally passing on uniform fixtures.
    for variant in [
      "match",
      "match",
      "from",
      "to",
      "prefix",
      "actor",
      "kind",
      "credential_type",
      "credential_id",
      "target_type",
      "target_id",
      "category",
      "unit",
    ] {
      let id = Uuid::new_v4();
      fixture.ids.push(id);
      let timestamp = match variant {
        "from" => "2026-10-14T23:59:59Z",
        "to" => "2026-10-15T00:00:01Z",
        _ => TIME,
      };
      sqlx::query("INSERT INTO admin_audit_log (id,event_key,category,actor_user_id,actor_kind,credential_type,credential_id,target_type,target_id,target_unit_id,created_at,old_value,new_value,metadata,actor_label,target_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::timestamptz,$12,$12,$12,$13,$13)")
        .bind(id)
        .bind(if variant == "prefix" { fixture.prefix.replace('_', "X") + "event" } else { format!("{}event",fixture.prefix) })
        .bind(if variant == "category" { "config" } else { "mcp" })
        .bind(if variant == "actor" { None } else { Some(fixture.user) })
        .bind(if variant == "kind" { "system" } else { "api_key" })
        .bind(if variant == "credential_type" { "other" } else { "mcp_api_key" })
        .bind(if variant == "credential_id" { "other" } else { "audit-key-id" })
        .bind(if variant == "target_type" { "other" } else { "document" })
        .bind(if variant == "target_id" { "other" } else { "audit-document-id" })
        .bind(if variant == "unit" { None } else { Some(fixture.unit) })
        .bind(timestamp).bind(serde_json::json!({"token":SECRET})).bind(SECRET)
        .execute(&mut *tx).await?;
    }
    let extra: Vec<Uuid> = sqlx::query_scalar("INSERT INTO admin_audit_log (event_key,category,actor_kind) SELECT $1,'config','system' FROM generate_series(1,101) RETURNING id")
      .bind(format!("{}bulk",fixture.prefix)).fetch_all(&mut *tx).await?;
    fixture.ids.extend(extra);
    tx.commit().await?;
    Ok(fixture)
  }

  async fn cleanup(&self, pool: &PgPool) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM admin_audit_log WHERE id=ANY($1)")
      .bind(&self.ids)
      .execute(&mut *tx)
      .await?;
    sqlx::query("DELETE FROM organization_unit WHERE id=$1")
      .bind(self.unit)
      .execute(&mut *tx)
      .await?;
    sqlx::query("DELETE FROM organization_unit_type WHERE id=$1")
      .bind(self.unit_type)
      .execute(&mut *tx)
      .await?;
    sqlx::query("DELETE FROM organization WHERE id=$1")
      .bind(self.organization)
      .execute(&mut *tx)
      .await?;
    sqlx::query("DELETE FROM users WHERE id=$1")
      .bind(self.user)
      .execute(&mut *tx)
      .await?;
    tx.commit().await?;
    Ok(())
  }
}

async fn exercise(pool: &PgPool, fixture: &Fixture) -> Result<()> {
  let actor = fixture.user.to_string();
  let unit = fixture.unit.to_string();
  let filters = [
    "audit",
    "list",
    "--event-key-prefix",
    &fixture.prefix,
    "--from",
    TIME,
    "--to",
    TIME,
    "--actor-user-id",
    &actor,
    "--actor-kind",
    "api_key",
    "--credential-type",
    "mcp_api_key",
    "--credential-id",
    "audit-key-id",
    "--target-type",
    "document",
    "--target-id",
    "audit-document-id",
    "--category",
    "mcp",
    "--target-unit-id",
    &unit,
  ];
  let mut ids = fixture.ids[..2].to_vec();
  ids.sort_by(|a, b| b.cmp(a));
  let result = json(&filters)?;
  let expected: Vec<_> = ids.iter().map(Uuid::to_string).collect();
  let actual: Vec<_> = result
    .as_array()
    .context("audit list array")?
    .iter()
    .map(|row| row["id"].as_str().context("row ID").map(String::from))
    .collect::<Result<_>>()?;
  ensure!(actual == expected, "filters or timestamp tie-break changed: {actual:?}");

  let store = PgAuditLogStore::new(pool.clone());
  let filter = AuditFilter {
    event_key_prefix: Some(fixture.prefix.replace('_', "\\_")),
    ..Default::default()
  };
  ensure!(
    store.count(filter.clone()).await? == 113,
    "existing count behavior changed"
  );
  let stored = store.list(filter, 0, 500).await?;
  let listed = json(&["audit", "list", "--event-key-prefix", &fixture.prefix, "--limit", "500"])?;
  ensure!(
    listed.as_array().context("list")?.len() == 113,
    "bounded list omitted events"
  );
  for (raw, projected) in stored.iter().zip(listed.as_array().context("list")?) {
    ensure!(projected["id"] == raw.id.to_string(), "CLI reordered the store result");
  }
  ensure!(
    json(&["audit", "list", "--event-key-prefix", &fixture.prefix])?
      .as_array()
      .context("default list")?
      .len()
      == 100,
    "default limit must be 100"
  );
  let mut bounded = filters.to_vec();
  bounded.extend(["--limit", "1"]);
  ensure!(
    json(&bounded)?.as_array().context("limited list")?.len() == 1,
    "explicit limit ignored"
  );
  success(&filters, false)?;

  let id = ids[0].to_string();
  let entry = json(&["audit", "get", &id])?;
  ensure!(
    entry["id"] == id && entry["event_key"] == format!("{}event", fixture.prefix),
    "get returned wrong entry"
  );
  ensure!(
    entry["actor_user_id"] == actor && entry["target_unit_id"] == unit,
    "get lost attribution"
  );
  for field in ["old_value", "new_value", "metadata"] {
    ensure!(
      entry[field] == serde_json::json!({"token": SECRET}),
      "historical content omitted or masked: {field}"
    );
    ensure!(result[0][field] == entry[field], "list and get differ for {field}");
  }
  for field in ["actor_label", "target_label"] {
    ensure!(
      entry[field] == SECRET && result[0][field] == SECRET,
      "historical label omitted or masked: {field}"
    );
  }
  let listed_text = success(&filters, false)?;
  ensure!(
    String::from_utf8_lossy(&listed_text.stdout).contains(SECRET),
    "table list omitted historical content"
  );
  let text = success(&["audit", "get", &id], false)?;
  ensure!(
    String::from_utf8_lossy(&text.stdout).contains(&id),
    "human-readable get missing identity"
  );
  ensure!(
    String::from_utf8_lossy(&text.stdout).contains(SECRET),
    "table get omitted historical content"
  );
  let recorder = AuditRecorder::new(std::sync::Arc::new(store));
  ensure!(
    recorder.get_by_id(ids[0]).await?.context("stored entry")?.metadata == Some(serde_json::json!({"token":SECRET})),
    "read must not rewrite historical data"
  );
  let missing = Uuid::new_v4();
  ensure!(
    recorder.get_by_id(missing).await?.is_none(),
    "missing store lookup must be None"
  );
  for json_output in [false, true] {
    let output = cli(&["audit", "get", &missing.to_string()], json_output)?;
    ensure!(
      output.status.code() == Some(1) && String::from_utf8_lossy(&output.stderr).contains("not found"),
      "missing entry must fail explicitly"
    );
  }
  ensure!(
    json(&[
      "audit",
      "list",
      "--event-key-prefix",
      &format!("absent.{}", fixture.prefix)
    ])?
      == serde_json::json!([]),
    "empty query must stay empty"
  );
  Ok(())
}

#[tokio::test]
async fn audit_cli_filters_orders_and_reads_complete_historical_records() {
  let pool = PgPoolOptions::new()
    .max_connections(3)
    .connect(&support::database_url())
    .await
    .expect("isolated audit DB");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("test migrations");
  let fixture = std::sync::Arc::new(Fixture::seed(&pool).await.expect("atomic audit fixtures"));
  let journey_pool = pool.clone();
  let journey_fixture = fixture.clone();
  // Join even a panic before cleanup, so assertions cannot leave persistent data.
  let result = tokio::spawn(async move { exercise(&journey_pool, &journey_fixture).await }).await;
  fixture
    .cleanup(&pool)
    .await
    .expect("clean audit fixtures after success or failure");
  result.expect("audit journey did not panic").expect("audit journey");
}
