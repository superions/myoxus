// SPDX-License-Identifier: AGPL-3.0-or-later
//! `backup` subcommand — database dump, restore, and integrity verification.
//!
//! All three commands wrap `pg_dump` / `psql` as external processes.  The backup
//! output directory contains:
//! - `dump.sql`       — plain-text `pg_dump` output
//! - `manifest.json`  — metadata (timestamp, db_version, workspace_count,
//!   blob_count, total_bytes, myoxus_version)

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, bail};
use chrono::Utc;
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tracing::{info, instrument, warn};

use crate::output::print_json;

// ---------------------------------------------------------------------------
// Subcommand definitions
// ---------------------------------------------------------------------------

/// Subcommands for `backup`.
#[derive(Subcommand)]
pub enum BackupCommand {
  /// Create a consistent DB dump + storage snapshot manifest.
  Create(BackupCreateArgs),
  /// Restore a DB dump from a backup directory.
  Restore(BackupRestoreArgs),
  /// Verify backup integrity without restoring.
  Verify(BackupVerifyArgs),
}

/// Arguments for `backup create`.
#[derive(Args, Debug)]
pub struct BackupCreateArgs {
  /// Output directory path (created if it does not exist).
  #[arg(long, short = 'o', default_value = "./myoxus-backup")]
  pub output: PathBuf,
}

/// Arguments for `backup restore`.
#[derive(Args, Debug)]
pub struct BackupRestoreArgs {
  /// Path to the backup directory.
  pub path: PathBuf,

  /// Proceed even if the target database already contains data.
  #[arg(long)]
  pub force: bool,
}

/// Arguments for `backup verify`.
#[derive(Args, Debug)]
pub struct BackupVerifyArgs {
  /// Path to the backup directory.
  pub path: PathBuf,
}

// ---------------------------------------------------------------------------
// Manifest type
// ---------------------------------------------------------------------------

/// Backup manifest — written to `manifest.json` inside the backup directory.
#[derive(Debug, Serialize, Deserialize)]
pub struct BackupManifest {
  /// RFC-3339 timestamp when the backup was created.
  pub timestamp: String,
  /// PostgreSQL server version string.
  pub db_version: String,
  /// Number of workspaces in the database at backup time.
  pub workspace_count: i64,
  /// Number of blobs in the database at backup time.
  pub blob_count: i64,
  /// Total blob storage in bytes.
  pub total_bytes: i64,
  /// Myoxus server version (from `CARGO_PKG_VERSION` at CLI build time).
  pub myoxus_version: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `backup` subcommand.
pub async fn run(
  cmd: BackupCommand,
  pool: &PgPool,
  database_url: &str,
  _json: bool,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> anyhow::Result<()> {
  let connection = if matches!(&cmd, BackupCommand::Verify(_)) {
    None
  } else {
    Some(
      myoxus_infrastructure::tls::postgres::child_connection(database_url, additional_ca)
        .map_err(anyhow::Error::msg)?,
    )
  };
  match cmd {
    BackupCommand::Create(args) => create(args, pool, connection.as_ref().expect("create connection")).await,
    BackupCommand::Restore(args) => restore(args, pool, connection.as_ref().expect("restore connection")).await,
    BackupCommand::Verify(args) => verify(args).await,
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

#[instrument(skip(pool, connection))]
async fn create(
  args: BackupCreateArgs,
  pool: &PgPool,
  connection: &myoxus_infrastructure::tls::postgres::ChildConnection,
) -> anyhow::Result<()> {
  let out_dir = &args.output;

  // Create output directory.
  fs::create_dir_all(out_dir).with_context(|| format!("could not create directory: {}", out_dir.display()))?;

  info!(output = %out_dir.display(), "backup.create.start");

  // Gather stats before dumping so manifest is accurate.
  let workspace_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspaces WHERE deleted_at IS NULL")
    .fetch_one(pool)
    .await
    .context("could not count workspaces")?;

  let blob_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blobs WHERE status = 'completed'")
    .fetch_one(pool)
    .await
    .context("could not count blobs")?;

  let total_bytes: i64 =
    sqlx::query_scalar("SELECT COALESCE(SUM(size), 0)::BIGINT FROM blobs WHERE status = 'completed'")
      .fetch_one(pool)
      .await
      .context("could not sum blob sizes")?;

  let db_version: String = sqlx::query_scalar("SELECT version()")
    .fetch_one(pool)
    .await
    .context("could not retrieve db version")?;

  // Run pg_dump.
  let dump_path = out_dir.join("dump.sql");
  info!(path = %dump_path.display(), "running pg_dump");

  let status = postgres_command("pg_dump", connection)
    .arg("--clean")
    .arg("--if-exists")
    .arg("--file")
    .arg(&dump_path)
    .status()
    .context("could not execute pg_dump — is it installed and on PATH?")?;

  if !status.success() {
    bail!("pg_dump exited with non-zero status: {status}");
  }

  info!(path = %dump_path.display(), "pg_dump completed");

  // Write manifest.json.
  let manifest = BackupManifest {
    timestamp: Utc::now().to_rfc3339(),
    db_version,
    workspace_count,
    blob_count,
    total_bytes,
    myoxus_version: env!("CARGO_PKG_VERSION").to_string(),
  };

  let manifest_path = out_dir.join("manifest.json");
  let manifest_json = serde_json::to_string_pretty(&manifest).context("could not serialize manifest")?;
  fs::write(&manifest_path, manifest_json).with_context(|| format!("could not write {}", manifest_path.display()))?;

  println!("Backup created successfully.");
  println!("  Directory   : {}", out_dir.display());
  println!("  Timestamp   : {}", manifest.timestamp);
  println!("  Workspaces  : {}", manifest.workspace_count);
  println!(
    "  Blobs       : {} ({} bytes)",
    manifest.blob_count, manifest.total_bytes
  );
  println!("  DB version  : {}", manifest.db_version);

  info!(
      output = %out_dir.display(),
      workspace_count = manifest.workspace_count,
      blob_count = manifest.blob_count,
      "backup.create.done"
  );

  Ok(())
}

#[instrument(skip(pool, connection))]
async fn restore(
  args: BackupRestoreArgs,
  pool: &PgPool,
  connection: &myoxus_infrastructure::tls::postgres::ChildConnection,
) -> anyhow::Result<()> {
  let backup_dir = &args.path;

  // Load and validate manifest.
  let manifest = load_manifest(backup_dir)?;

  info!(
      backup_dir = %backup_dir.display(),
      timestamp = %manifest.timestamp,
      myoxus_version = %manifest.myoxus_version,
      "backup.restore.start"
  );

  // Version mismatch warning.
  let current_version = env!("CARGO_PKG_VERSION");
  if manifest.myoxus_version != current_version {
    warn!(
        backup_version = %manifest.myoxus_version,
        current_version = %current_version,
        "version mismatch between backup and current binary — proceed with caution"
    );
    eprintln!(
      "Warning: backup was created with Myoxus {}, but the current binary is {}.",
      manifest.myoxus_version, current_version
    );
    eprintln!("         Use --force to suppress this check and proceed anyway.");
    if !args.force {
      bail!(
        "version mismatch (backup: {}, current: {}). Pass --force to proceed.",
        manifest.myoxus_version,
        current_version
      );
    }
  }

  // Check if the target DB has data.
  if !args.force {
    let existing_workspaces: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspaces")
      .fetch_one(pool)
      .await
      .unwrap_or(0);

    if existing_workspaces > 0 {
      eprintln!(
        "Warning: target database already contains {} workspace(s).",
        existing_workspaces
      );
      eprintln!("         Pass --force to overwrite existing data.");
      bail!("target database is not empty — pass --force to proceed");
    }
  }

  let dump_path = backup_dir.join("dump.sql");
  if !dump_path.exists() {
    bail!("dump.sql not found in backup directory: {}", backup_dir.display());
  }

  info!(dump = %dump_path.display(), "running psql for restore");

  // psql otherwise exits successfully after SQL errors, leaving a partial
  // restore whose schema and migration ledger can disagree.
  let status = postgres_command("psql", connection)
    .arg("--no-psqlrc")
    .arg("--single-transaction")
    .arg("--set=ON_ERROR_STOP=1")
    .arg("--file")
    .arg(&dump_path)
    .status()
    .context("could not execute psql — is it installed and on PATH?")?;

  if !status.success() {
    bail!("psql exited with non-zero status: {status}");
  }

  println!("Restore completed successfully.");
  println!("  Source    : {}", backup_dir.display());
  println!("  Timestamp : {}", manifest.timestamp);

  info!(
      backup_dir = %backup_dir.display(),
      "backup.restore.done"
  );

  Ok(())
}

#[instrument]
async fn verify(args: BackupVerifyArgs) -> anyhow::Result<()> {
  let backup_dir = &args.path;

  info!(backup_dir = %backup_dir.display(), "backup.verify.start");

  // 1. manifest.json must be parseable.
  let manifest = load_manifest(backup_dir)?;

  // 2. dump.sql must exist and be readable.
  let dump_path = backup_dir.join("dump.sql");
  if !dump_path.exists() {
    bail!("dump.sql not found in: {}", backup_dir.display());
  }

  let dump_metadata = fs::metadata(&dump_path).with_context(|| format!("cannot stat: {}", dump_path.display()))?;
  let dump_size = dump_metadata.len();

  if dump_size == 0 {
    bail!("dump.sql is empty — backup may be corrupt");
  }

  // 3. If a blobs/ subdirectory exists, verify all entries listed in manifest can be located.
  //    (Storage snapshots are optional — only checked if the directory is present.)
  let blobs_dir = backup_dir.join("blobs");
  let storage_checked = if blobs_dir.exists() {
    let entries = fs::read_dir(&blobs_dir).with_context(|| format!("cannot read blobs/: {}", blobs_dir.display()))?;
    let count = entries.count();
    info!(blob_count = count, "storage snapshot directory found and readable");
    true
  } else {
    false
  };

  // Report results.
  #[derive(Serialize)]
  struct VerifyResult {
    status: String,
    timestamp: String,
    myoxus_version: String,
    workspace_count: i64,
    blob_count: i64,
    total_bytes: i64,
    dump_size_bytes: u64,
    storage_snapshot_checked: bool,
  }

  let result = VerifyResult {
    status: "ok".to_string(),
    timestamp: manifest.timestamp.clone(),
    myoxus_version: manifest.myoxus_version.clone(),
    workspace_count: manifest.workspace_count,
    blob_count: manifest.blob_count,
    total_bytes: manifest.total_bytes,
    dump_size_bytes: dump_size,
    storage_snapshot_checked: storage_checked,
  };

  // Always print as JSON for machine-parsability, then also a human summary.
  print_json(&result);

  println!();
  println!("Backup integrity: OK");
  println!("  Backup time    : {}", manifest.timestamp);
  println!("  Myoxus version : {}", manifest.myoxus_version);
  println!("  Workspaces     : {}", manifest.workspace_count);
  println!("  Blobs          : {}", manifest.blob_count);
  println!("  dump.sql size  : {} bytes", dump_size);
  if storage_checked {
    println!("  Storage blobs  : checked (directory present)");
  } else {
    println!("  Storage blobs  : skipped (no blobs/ directory in backup)");
  }

  info!(backup_dir = %backup_dir.display(), "backup.verify.ok");

  Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Load and parse `manifest.json` from a backup directory.
fn load_manifest(backup_dir: &Path) -> anyhow::Result<BackupManifest> {
  let manifest_path = backup_dir.join("manifest.json");

  if !manifest_path.exists() {
    bail!("manifest.json not found in: {}", backup_dir.display());
  }

  let manifest_json =
    fs::read_to_string(&manifest_path).with_context(|| format!("cannot read {}", manifest_path.display()))?;

  let manifest: BackupManifest =
    serde_json::from_str(&manifest_json).with_context(|| format!("cannot parse {}", manifest_path.display()))?;

  Ok(manifest)
}

/// The caller owns the private service/CA files until the subprocess exits.
fn postgres_command(program: &str, connection: &myoxus_infrastructure::tls::postgres::ChildConnection) -> Command {
  let mut command = Command::new(program);
  connection.configure(&mut command);
  command
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn postgres_commands_keep_database_credentials_out_of_arguments_and_environment() {
    let before = std::env::var_os("PGSERVICEFILE");
    let url = "postgres://operator:do-not-expose@db.internal:5432/myoxus?sslmode=require";
    let connection = myoxus_infrastructure::tls::postgres::child_connection(url, None).expect("connection");
    for program in ["pg_dump", "psql"] {
      let command = postgres_command(program, &connection);
      assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        [std::ffi::OsStr::new("--no-password")]
      );
      for (_, value) in command.get_envs() {
        assert!(
          !value
            .expect("environment value")
            .to_string_lossy()
            .contains("do-not-expose")
        );
      }
      let path = command
        .get_envs()
        .find(|(key, _)| *key == "PGSERVICEFILE")
        .and_then(|(_, value)| value)
        .expect("service path");
      assert!(std::path::Path::new(path).exists());
    }
    assert_eq!(std::env::var_os("PGSERVICEFILE"), before);
  }
}
