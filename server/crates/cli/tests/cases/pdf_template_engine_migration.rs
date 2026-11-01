// SPDX-License-Identifier: AGPL-3.0-or-later
//! Binary contract for the persisted Typst engine migration command.
//!
//! Atomicity and concurrency live in the Infrastructure integration owner.
//! This test only proves CLI parsing, output modes, nonzero failure semantics
//! and use of the server-configured object-storage root.

use crate::support;

use anyhow::{Context, Result, ensure};
use bytes::Bytes;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tempfile::TempDir;
use uuid::Uuid;

use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest};
use myoxus_infrastructure::storage::StorageAdapter;

use support::database_url;

const FILES: &[(&str, &[u8])] = &[
  ("main.typ", include_bytes!("../../../../templates/pdf/default/main.typ")),
  (
    "preamble.typ",
    include_bytes!("../../../../templates/pdf/default/preamble.typ"),
  ),
  (
    "theme.typ",
    include_bytes!("../../../../templates/pdf/default/theme.typ"),
  ),
  (
    "i18n/en.json",
    include_bytes!("../../../../templates/pdf/default/i18n/en.json"),
  ),
  (
    "i18n/de.json",
    include_bytes!("../../../../templates/pdf/default/i18n/de.json"),
  ),
];

fn manifest(slug: &str, engine: &str) -> Value {
  let mut value: Value = serde_json::from_slice(include_bytes!("../../../../templates/pdf/default/manifest.json"))
    .expect("bundled default manifest");
  value["id"] = Value::String(slug.to_owned());
  value["name"] = Value::String("CLI engine migration fixture".to_owned());
  value["engine"]["version"] = Value::String(engine.to_owned());
  value
}

fn command(storage: &TempDir, json: bool) -> support::CliCommand {
  let mut command = support::cli_command_with_pdf_compiler();
  command
    .env("RUN_MODE", "development")
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__REDIS__URL", "redis://localhost:6380")
    .env(
      "MYOXUS__REDIS__NAMESPACE",
      format!("myoxus:cli-pdf-migration:{}", Uuid::new_v4()),
    )
    .env("MYOXUS__STORAGE__BACKEND", "local")
    .env("MYOXUS__STORAGE__ROOT", storage.path())
    .env("RUST_LOG", "warn");
  if json {
    command.arg("--json");
  }
  command.args(["pdf", "templates", "migrate-engine", "--from", "0.14", "--to", "0.15"]);
  command
}

async fn seed(pool: &PgPool, storage: &TempDir) -> Result<(Uuid, Uuid, String)> {
  sqlx::query(
    "DELETE FROM pdf_workspace_template_assignments WHERE template_id IN \
     (SELECT id FROM pdf_templates WHERE created_by IS NOT NULL)",
  )
  .execute(pool)
  .await?;
  sqlx::query("DELETE FROM pdf_templates WHERE created_by IS NOT NULL")
    .execute(pool)
    .await?;

  let owner_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'CLI PDF owner', 'active')")
    .bind(owner_id)
    .bind(format!("cli-pdf-migration-{owner_id}@example.test"))
    .execute(pool)
    .await?;
  let template_id = Uuid::new_v4();
  let slug = format!("cli-engine-{}", template_id.simple());
  sqlx::query(
    "INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by) \
     VALUES ($1, $2, 'CLI engine migration fixture', '1.3.0', '2.0', $3, $4)",
  )
  .bind(template_id)
  .bind(&slug)
  .bind(manifest(&slug, "0.14.x"))
  .bind(owner_id)
  .execute(pool)
  .await?;

  let blobs = StorageAdapter::new_fs(storage.path().to_str().context("UTF-8 storage path")?)?;
  for (path, body) in FILES {
    let key = format!("pdf-templates/{template_id}/{path}");
    blobs
      .write_blob(BlobWriteRequest {
        key: key.clone(),
        content_type: None,
        body: Bytes::copy_from_slice(body),
      })
      .await?;
    sqlx::query(
      "INSERT INTO pdf_template_files (template_id, file_path, blob_key, content_hash) VALUES ($1, $2, $3, $4)",
    )
    .bind(template_id)
    .bind(path)
    .bind(key)
    .bind(format!("{:x}", Sha256::digest(body)))
    .execute(pool)
    .await?;
  }
  Ok((owner_id, template_id, slug))
}

#[tokio::test]
async fn cli_reports_dry_run_confirm_and_incompatible_failure() -> Result<()> {
  let pool = PgPoolOptions::new().max_connections(4).connect(&database_url()).await?;
  myoxus_infrastructure::migrations::run(&pool).await?;
  let storage = TempDir::new()?;
  let (owner_id, template_id, slug) = seed(&pool, &storage).await?;
  // Recovery must remain possible before a candidate server has canonicalized
  // historical runtime-config keys. The ordinary full CLI service graph
  // rejects this row; the engine migration intentionally does not consume it.
  sqlx::query(
    "INSERT INTO app_configs (id, value) VALUES ('i18n.defaultLocale', '\"en\"'::jsonb) \
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value",
  )
  .execute(&pool)
  .await?;

  let dry = command(&storage, true).output().context("run JSON dry-run")?;
  ensure!(
    dry.status.success(),
    "dry-run failed: {}",
    String::from_utf8_lossy(&dry.stderr)
  );
  let report: Value = serde_json::from_slice(&dry.stdout).context("parse migration JSON")?;
  ensure!(report["dryRun"] == true);
  ensure!(report["migrated"] == 1);
  ensure!(report["templates"][0]["slug"] == slug);
  ensure!(report["templates"][0]["compiled"] == true);
  let engine: String = sqlx::query_scalar("SELECT manifest #>> '{engine,version}' FROM pdf_templates WHERE id = $1")
    .bind(template_id)
    .fetch_one(&pool)
    .await?;
  ensure!(engine == "0.14.x", "dry-run changed the manifest");

  let mut confirm = command(&storage, false);
  confirm.arg("--confirm");
  let confirmed = confirm.output().context("run human confirm")?;
  ensure!(
    confirmed.status.success(),
    "confirm failed: {}",
    String::from_utf8_lossy(&confirmed.stderr)
  );
  let human = String::from_utf8(confirmed.stdout)?;
  ensure!(human.contains("CONFIRMED"));
  ensure!(human.contains(&slug));
  ensure!(human.contains("manifest"));
  ensure!(human.contains("compile passed: true"));

  sqlx::query(
    "UPDATE pdf_templates SET manifest = jsonb_set(manifest, '{engine,version}', '\"0.13.x\"') WHERE id = $1",
  )
  .bind(template_id)
  .execute(&pool)
  .await?;
  let incompatible = command(&storage, false)
    .output()
    .context("run incompatible migration")?;
  ensure!(
    !incompatible.status.success(),
    "incompatible engine must return nonzero"
  );
  ensure!(String::from_utf8_lossy(&incompatible.stderr).contains("expected 0.14.x or 0.15.x"));

  sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
    .bind(template_id)
    .execute(&pool)
    .await?;
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(owner_id)
    .execute(&pool)
    .await?;
  sqlx::query("DELETE FROM app_configs WHERE id = 'i18n.defaultLocale'")
    .execute(&pool)
    .await?;
  Ok(())
}
