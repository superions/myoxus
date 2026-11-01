// SPDX-License-Identifier: AGPL-3.0-or-later
//! Binary-level configuration import and mirror-recovery journey.

use crate::support;

use std::{
  io::Write,
  path::Path,
  process::{Output, Stdio},
};

use anyhow::{Context, Result, ensure};
use myoxus_contracts::{
  config_document::{ConfigDocumentFormat, decode_config_document, encode_config_yaml},
  effective_config::CONFIG_REGISTRY,
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;

const PROVIDER_PATH: &str = "oauth.providers.oidc";

fn config_import_stdin(input: &Value, writeback_path: &Path, mode: &str) -> Result<Output> {
  let mut command = support::cli_command();
  command
    .env("RUN_MODE", "development")
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__CONFIG__WRITEBACK_PATH", writeback_path)
    .env("MYOXUS__SERVER__ORIGIN", "https://config-cli.test.invalid")
    .env("RUST_LOG", "warn")
    .args(["--json", "config", "import", "-"]);
  if mode != "partial" {
    command.args(["--mode", mode]);
  }
  let mut child = command
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .context("spawn config stdin import")?;
  child
    .stdin
    .take()
    .context("config import stdin")?
    .write_all(encode_config_yaml(input)?.as_bytes())
    .context("write config import stdin")?;
  child.wait_with_output().context("wait for config stdin import")
}

fn successful_json(output: &Output) -> Result<Value> {
  ensure!(
    output.status.success(),
    "config import failed\nstdout: {}\nstderr: {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  serde_json::from_slice(&output.stdout).context("config import JSON stdout")
}

async fn restore_registered_config(pool: &PgPool, previous: Vec<Value>, paths: &[String]) -> Result<()> {
  // Restore the complete pre-test rows atomically, including actor/timestamps;
  // a recovery fixture must not leave metadata changes or a partial restore.
  let mut transaction = pool.begin().await?;
  sqlx::query("DELETE FROM app_configs WHERE id = ANY($1)")
    .bind(paths)
    .execute(&mut *transaction)
    .await?;
  for row in previous {
    // A persisted JSON null must round-trip as JSON, not SQL NULL. Preserve it
    // separately because jsonb_populate_record maps JSON null to SQL NULL.
    sqlx::query("INSERT INTO app_configs SELECT r.id, $1->'value', r.created_at, r.updated_at, r.last_updated_by FROM jsonb_populate_record(NULL::app_configs, $1) r")
      .bind(row)
      .execute(&mut *transaction)
      .await?;
  }
  transaction.commit().await?;
  Ok(())
}

#[tokio::test]
async fn config_stdin_roundtrip_retries_failed_same_value_and_removal_mirrors() -> Result<()> {
  let pool = PgPoolOptions::new()
    .max_connections(2)
    .connect(&database_url())
    .await
    .context("connect isolated test database")?;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .context("apply CLI test migrations")?;
  let registered_paths = CONFIG_REGISTRY
    .iter()
    .filter(|descriptor| descriptor.database_writable())
    .map(|descriptor| descriptor.path.to_string())
    .collect::<Vec<_>>();
  let previous =
    sqlx::query_scalar::<_, Value>("SELECT to_jsonb(app_configs) FROM app_configs WHERE id = ANY($1) ORDER BY id")
      .bind(&registered_paths)
      .fetch_all(&pool)
      .await?;

  let result = async {
    sqlx::query("DELETE FROM app_configs WHERE id = $1")
      .bind(PROVIDER_PATH)
      .execute(&pool)
      .await?;

    let temp = tempfile::tempdir().context("config mirror fixture")?;
    let mirror_dir = temp.path().join("mirror");
    let mirror_path = mirror_dir.join("runtime.yaml");
    let failed_path = temp.path().join("missing-on-first-save").join("runtime.yaml");
    let secret = "roundtrip-secret-must-not-leak";
    let provider = json!({
      "oauth": {
        "providers": {
          "oidc": {
            "client_id": "roundtrip-client",
            "client_secret": secret,
            "issuer_url": "https://idp.test.invalid",
            "auth_url": "https://idp.test.invalid/authorize",
            "token_url": "https://idp.test.invalid/token",
            "userinfo_url": "https://idp.test.invalid/userinfo",
            "claims": {
              "email_verified": "verified",
              "groups_source": "userinfo"
            },
            "group_mapping": {
              "enabled": false,
              "default_role": "reader",
              "remove_missing_oidc_memberships": true,
              "missing_groups_policy": "allow_without_memberships",
              "unknown_groups": "deny_login",
              "mappings": []
            }
          }
        }
      }
    });

    let first = config_import_stdin(&provider, &failed_path, "partial")?;
    let first_json = successful_json(&first)?;
    ensure!(first_json["applied"] == true);
    ensure!(first_json["writeback"] == "failed");
    ensure!(!String::from_utf8_lossy(&first.stdout).contains(secret));
    ensure!(!String::from_utf8_lossy(&first.stderr).contains(secret));

    std::fs::create_dir(&mirror_dir).context("create repaired mirror directory")?;
    let retry = config_import_stdin(&provider, &mirror_path, "partial")?;
    let retry_json = successful_json(&retry)?;
    ensure!(retry_json["changed"] == 0);
    ensure!(retry_json["writeback"] == "written");

    let persisted = sqlx::query_scalar::<_, Value>("SELECT value FROM app_configs WHERE id = $1")
      .bind(PROVIDER_PATH)
      .fetch_one(&pool)
      .await?;
    ensure!(persisted["clientId"] == "roundtrip-client");
    ensure!(persisted["claims"]["emailVerified"] == "verified");
    ensure!(persisted["claims"]["groupsSource"] == "userinfo");
    ensure!(persisted["groupMapping"]["defaultRole"] == "reader");
    ensure!(persisted["groupMapping"]["unknownGroups"] == "deny_login");

    let removal = json!({ "oauth": { "providers": { "oidc": null } } });
    let failed_removal_path = temp.path().join("missing-on-remove").join("runtime.yaml");
    let removed = successful_json(&config_import_stdin(&removal, &failed_removal_path, "partial")?)?;
    ensure!(removed["applied"] == true);
    ensure!(removed["writeback"] == "failed");
    let retry_removal = successful_json(&config_import_stdin(&removal, &mirror_path, "partial")?)?;
    ensure!(retry_removal["changed"] == 0);
    ensure!(retry_removal["writeback"] == "written");
    let mirrored = std::fs::read_to_string(&mirror_path).context("read repaired mirror")?;
    let mirrored: Value =
      decode_config_document(&mirrored, ConfigDocumentFormat::Yaml).context("parse repaired mirror")?;
    ensure!(mirrored.pointer("/oauth/providers/oidc").is_none());

    let full_seed = json!({
      "server": { "name": "Roundtrip full import" },
      "copilot": { "enabled": true }
    });
    let seeded = successful_json(&config_import_stdin(&full_seed, &mirror_path, "partial")?)?;
    ensure!(seeded["applied"] == true);
    let full_input = json!({ "server": { "name": "Roundtrip full import" } });
    let failed_full_path = temp.path().join("missing-on-full").join("runtime.yaml");
    let failed_full = successful_json(&config_import_stdin(&full_input, &failed_full_path, "full")?)?;
    ensure!(failed_full["writeback"] == "failed");

    let retry_full = successful_json(&config_import_stdin(&full_input, &mirror_path, "full")?)?;
    ensure!(retry_full["changed"] == 0);
    ensure!(retry_full["writeback"] == "written");
    let mirrored: Value = decode_config_document(&std::fs::read_to_string(&mirror_path)?, ConfigDocumentFormat::Yaml)?;
    ensure!(mirrored.pointer("/copilot/enabled").is_none());
    Ok::<_, anyhow::Error>(())
  }
  .await;

  let cleanup = async {
    restore_registered_config(&pool, previous.clone(), &registered_paths).await?;
    let restored =
      sqlx::query_scalar::<_, Value>("SELECT to_jsonb(app_configs) FROM app_configs WHERE id = ANY($1) ORDER BY id")
        .bind(&registered_paths)
        .fetch_all(&pool)
        .await?;
    ensure!(
      restored == previous,
      "config fixture must restore every persisted value and metadata"
    );
    Ok::<_, anyhow::Error>(())
  }
  .await;
  result.and(cleanup)
}
