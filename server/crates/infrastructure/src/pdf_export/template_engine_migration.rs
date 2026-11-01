// SPDX-License-Identifier: AGPL-3.0-or-later
//! Atomic compatibility migration for administrator-owned PDF templates.
//!
//! The migration deliberately leaves bundle objects and file rows untouched.
//! It first materialises and compiles every eligible bundle with the target
//! renderer, then repeats that preflight and publishes only the
//! `/engine/version` manifest change in one PostgreSQL transaction. System
//! templates are reconciled separately from the binary-owned bundles.

use std::collections::HashMap;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use tracing::instrument;
use uuid::Uuid;

use myoxus_application::ports::BlobStoragePort;
use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;
use myoxus_pdf_export::template_v2::{TYPST_ENGINE_VERSION, validate_template_compiles};

use super::{SYSTEM_TEMPLATE_SLUGS, system_template_id};

/// One template's immutable compatibility evidence.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateEngineMigrationItem {
  pub template_id: Uuid,
  pub slug: String,
  pub previous_engine: String,
  pub target_engine: String,
  pub previous_manifest_hash: String,
  pub target_manifest_hash: String,
  pub file_hashes: Vec<TemplateEngineMigrationFile>,
  /// `true` only after the complete stored bundle compiled with the embedded
  /// target renderer. Kept explicit so machine-readable operator evidence
  /// does not have to infer validation from the absence of an error.
  pub compiled: bool,
  pub action: TemplateEngineMigrationAction,
}

/// File identity retained by an engine-only migration.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateEngineMigrationFile {
  pub path: String,
  pub content_hash: String,
}

/// Whether a compatible template needs a manifest write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateEngineMigrationAction {
  Migrate,
  AlreadyCurrent,
}

/// Complete dry-run or confirmed migration result.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateEngineMigrationReport {
  pub from: String,
  pub to: String,
  pub dry_run: bool,
  pub migrated: usize,
  pub already_current: usize,
  pub templates: Vec<TemplateEngineMigrationItem>,
}

#[derive(Debug, thiserror::Error)]
pub enum TemplateEngineMigrationError {
  #[error("invalid engine line `{0}`; expected major.minor such as 0.15")]
  InvalidEngineLine(String),
  #[error("target engine {requested}.x does not match the embedded renderer {embedded}")]
  TargetRendererMismatch { requested: String, embedded: &'static str },
  #[error("database operation failed during template engine migration: {0}")]
  Database(#[from] sqlx::Error),
  #[error("object storage read failed for template {template_id}, file `{path}`")]
  Storage { template_id: Uuid, path: String },
  #[error("template {template_id} has an invalid manifest: {reason}")]
  InvalidManifest { template_id: Uuid, reason: String },
  #[error("template {template_id} declares engine `{actual}`, expected {from}.x or {to}.x")]
  IncompatibleEngine {
    template_id: Uuid,
    actual: String,
    from: String,
    to: String,
  },
  #[error("template {template_id} file `{path}` has hash {actual}, expected {expected}")]
  ContentHashMismatch {
    template_id: Uuid,
    path: String,
    expected: String,
    actual: String,
  },
  #[error("template {template_id} failed target-engine compilation")]
  Compile { template_id: Uuid },
  #[error("template set changed between preflight and publication; rerun the dry-run")]
  ConcurrentChange,
}

/// PostgreSQL and configured-object-storage owner for the two-phase migration.
pub struct TemplateEngineMigrationService {
  pool: PgPool,
  blobs: Arc<dyn BlobStoragePort>,
}

impl TemplateEngineMigrationService {
  pub fn new(pool: PgPool, blobs: Arc<dyn BlobStoragePort>) -> Self {
    Self { pool, blobs }
  }

  /// Validate every active administrator template without writing.
  #[instrument(skip_all, fields(from, to))]
  pub async fn preflight(
    &self,
    from: &str,
    to: &str,
  ) -> Result<TemplateEngineMigrationReport, TemplateEngineMigrationError> {
    validate_lines(from, to)?;
    let rows = sqlx::query(
      r#"
      SELECT id, slug, manifest
        FROM pdf_templates
       WHERE deleted_at IS NULL AND created_by IS NOT NULL
       ORDER BY id
      "#,
    )
    .fetch_all(&self.pool)
    .await?;

    let mut templates = Vec::with_capacity(rows.len());
    for row in rows {
      let template_id: Uuid = row.get("id");
      if SYSTEM_TEMPLATE_SLUGS
        .iter()
        .any(|slug| system_template_id(slug) == template_id)
      {
        continue;
      }
      templates.push(
        self
          .inspect_template(template_id, row.get("slug"), row.get("manifest"), from, to)
          .await?,
      );
    }

    Ok(report(from, to, true, templates))
  }

  /// Repeat the complete preflight under row locks and atomically publish all
  /// compatible engine declarations.
  ///
  /// Compilation intentionally runs while the transaction owns the template
  /// and file-row locks. This keeps the validated manifest, stored hashes and
  /// eventual update in one snapshot instead of leaving a race between the
  /// second object-store read and publication.
  #[instrument(skip_all, fields(from, to))]
  pub async fn confirm(
    &self,
    from: &str,
    to: &str,
  ) -> Result<TemplateEngineMigrationReport, TemplateEngineMigrationError> {
    let first = self.preflight(from, to).await?;

    let mut tx = self.pool.begin().await?;
    // Row locks alone cannot protect the set against a concurrent insert. The
    // maintenance command therefore blocks template publications while it
    // revalidates and commits. Reads and exports remain available.
    sqlx::query("LOCK TABLE pdf_templates, pdf_template_files IN SHARE ROW EXCLUSIVE MODE")
      .execute(&mut *tx)
      .await?;
    let locked = sqlx::query(
      r#"
      SELECT id, slug, manifest
        FROM pdf_templates
       WHERE deleted_at IS NULL AND created_by IS NOT NULL
       ORDER BY id
       FOR UPDATE
      "#,
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut locked_evidence = Vec::with_capacity(locked.len());
    for row in locked {
      let template_id: Uuid = row.get("id");
      if SYSTEM_TEMPLATE_SLUGS
        .iter()
        .any(|slug| system_template_id(slug) == template_id)
      {
        continue;
      }
      let files = sqlx::query(
        r#"
        SELECT file_path, blob_key, content_hash
          FROM pdf_template_files
         WHERE template_id = $1
         ORDER BY file_path
         FOR UPDATE
        "#,
      )
      .bind(template_id)
      .fetch_all(&mut *tx)
      .await?
      .into_iter()
      .map(|row| StoredTemplateFile {
        path: row.get("file_path"),
        blob_key: row.get("blob_key"),
        content_hash: row.get("content_hash"),
      })
      .collect::<Vec<_>>();
      locked_evidence.push(
        self
          .inspect_template_files(template_id, row.get("slug"), row.get("manifest"), files, from, to)
          .await?,
      );
    }
    if first.templates != locked_evidence {
      return Err(TemplateEngineMigrationError::ConcurrentChange);
    }

    for item in &locked_evidence {
      if item.action == TemplateEngineMigrationAction::Migrate {
        let result = sqlx::query(
          r#"
          UPDATE pdf_templates
             SET manifest = jsonb_set(manifest, '{engine,version}', to_jsonb($2::text), false)
           WHERE id = $1 AND deleted_at IS NULL
          "#,
        )
        .bind(item.template_id)
        .bind(format!("{to}.x"))
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
          return Err(TemplateEngineMigrationError::ConcurrentChange);
        }
      }
    }
    tx.commit().await?;

    let mut completed = report(from, to, false, locked_evidence);
    completed.dry_run = false;
    Ok(completed)
  }

  async fn inspect_template(
    &self,
    template_id: Uuid,
    slug: String,
    manifest_value: serde_json::Value,
    from: &str,
    to: &str,
  ) -> Result<TemplateEngineMigrationItem, TemplateEngineMigrationError> {
    let files = sqlx::query(
      r#"
      SELECT file_path, blob_key, content_hash
        FROM pdf_template_files
       WHERE template_id = $1
       ORDER BY file_path
      "#,
    )
    .bind(template_id)
    .fetch_all(&self.pool)
    .await?
    .into_iter()
    .map(|row| StoredTemplateFile {
      path: row.get("file_path"),
      blob_key: row.get("blob_key"),
      content_hash: row.get("content_hash"),
    })
    .collect();
    self
      .inspect_template_files(template_id, slug, manifest_value, files, from, to)
      .await
  }

  async fn inspect_template_files(
    &self,
    template_id: Uuid,
    slug: String,
    manifest_value: serde_json::Value,
    files: Vec<StoredTemplateFile>,
    from: &str,
    to: &str,
  ) -> Result<TemplateEngineMigrationItem, TemplateEngineMigrationError> {
    let mut manifest: PdfTemplateManifest = serde_json::from_value(manifest_value.clone()).map_err(|error| {
      TemplateEngineMigrationError::InvalidManifest {
        template_id,
        reason: error.to_string(),
      }
    })?;
    manifest
      .validate_package_metadata()
      .and_then(|_| manifest.validate_locale())
      .map_err(|reason| TemplateEngineMigrationError::InvalidManifest {
        template_id,
        reason: reason.to_owned(),
      })?;

    let previous_engine = manifest.engine.version.clone();
    let Some(action) = classify_action(&previous_engine, from, to) else {
      return Err(TemplateEngineMigrationError::IncompatibleEngine {
        template_id,
        actual: previous_engine,
        from: from.to_owned(),
        to: to.to_owned(),
      });
    };

    let mut bundle = HashMap::with_capacity(files.len());
    let mut file_hashes = Vec::with_capacity(files.len());
    for file in files {
      let path = file.path;
      let expected = file.content_hash;
      let bytes = self
        .blobs
        .read_blob(&file.blob_key)
        .await
        .map_err(|_| TemplateEngineMigrationError::Storage {
          template_id,
          path: path.clone(),
        })?
        .data;
      let actual = sha256(bytes.as_ref());
      if actual != expected {
        return Err(TemplateEngineMigrationError::ContentHashMismatch {
          template_id,
          path,
          expected,
          actual,
        });
      }
      bundle.insert(path.clone(), bytes.to_vec());
      file_hashes.push(TemplateEngineMigrationFile {
        path,
        content_hash: actual,
      });
    }

    manifest.engine.version = format!("{to}.x");
    manifest
      .validate_engine_compatibility(TYPST_ENGINE_VERSION)
      .map_err(|reason| TemplateEngineMigrationError::InvalidManifest {
        template_id,
        reason: reason.to_owned(),
      })?;
    validate_template_compiles(&bundle, &manifest)
      .await
      .map_err(|_| TemplateEngineMigrationError::Compile { template_id })?;
    let mut target_value = manifest_value.clone();
    let Some(engine_version) = target_value.pointer_mut("/engine/version") else {
      return Err(TemplateEngineMigrationError::InvalidManifest {
        template_id,
        reason: "manifest is missing /engine/version".to_owned(),
      });
    };
    *engine_version = serde_json::Value::String(format!("{to}.x"));

    Ok(TemplateEngineMigrationItem {
      template_id,
      slug,
      previous_engine,
      target_engine: format!("{to}.x"),
      previous_manifest_hash: sha256_json(&manifest_value),
      target_manifest_hash: sha256_json(&target_value),
      file_hashes,
      compiled: true,
      action,
    })
  }
}

#[derive(Debug)]
struct StoredTemplateFile {
  path: String,
  blob_key: String,
  content_hash: String,
}

fn validate_lines(from: &str, to: &str) -> Result<(), TemplateEngineMigrationError> {
  if !is_engine_line(from) {
    return Err(TemplateEngineMigrationError::InvalidEngineLine(from.to_owned()));
  }
  if !is_engine_line(to) {
    return Err(TemplateEngineMigrationError::InvalidEngineLine(to.to_owned()));
  }
  if !TYPST_ENGINE_VERSION.starts_with(&format!("{to}.")) {
    return Err(TemplateEngineMigrationError::TargetRendererMismatch {
      requested: to.to_owned(),
      embedded: TYPST_ENGINE_VERSION,
    });
  }
  Ok(())
}

fn is_engine_line(value: &str) -> bool {
  let mut parts = value.split('.');
  matches!((parts.next(), parts.next(), parts.next()), (Some(a), Some(b), None) if a.parse::<u64>().is_ok() && b.parse::<u64>().is_ok())
}

fn engine_matches_line(version: &str, line: &str) -> bool {
  version == format!("{line}.x")
    || version
      .strip_prefix(&format!("{line}."))
      .is_some_and(|patch| patch.parse::<u64>().is_ok())
}

fn classify_action(version: &str, from: &str, to: &str) -> Option<TemplateEngineMigrationAction> {
  if version == format!("{to}.x") {
    Some(TemplateEngineMigrationAction::AlreadyCurrent)
  } else if engine_matches_line(version, from) || engine_matches_line(version, to) {
    Some(TemplateEngineMigrationAction::Migrate)
  } else {
    None
  }
}

fn sha256(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}

fn sha256_json(value: &serde_json::Value) -> String {
  // Serialising `serde_json::Value` is infallible; hashing its canonical
  // stored representation gives the CLI stable before/after evidence.
  sha256(&serde_json::to_vec(value).expect("serialising serde_json::Value cannot fail"))
}

fn report(
  from: &str,
  to: &str,
  dry_run: bool,
  templates: Vec<TemplateEngineMigrationItem>,
) -> TemplateEngineMigrationReport {
  let migrated = templates
    .iter()
    .filter(|item| item.action == TemplateEngineMigrationAction::Migrate)
    .count();
  let already_current = templates.len() - migrated;
  TemplateEngineMigrationReport {
    from: from.to_owned(),
    to: to.to_owned(),
    dry_run,
    migrated,
    already_current,
    templates,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn engine_line_matching_is_exact() {
    assert!(engine_matches_line("0.14.x", "0.14"));
    assert!(engine_matches_line("0.14.2", "0.14"));
    assert!(!engine_matches_line("0.140.2", "0.14"));
    assert!(!engine_matches_line("0.14-beta", "0.14"));
  }

  #[test]
  fn only_target_wildcard_is_write_free() {
    assert_eq!(
      classify_action("0.15.x", "0.14", "0.15"),
      Some(TemplateEngineMigrationAction::AlreadyCurrent)
    );
    assert_eq!(
      classify_action("0.15.1", "0.14", "0.15"),
      Some(TemplateEngineMigrationAction::Migrate)
    );
  }

  #[test]
  fn target_must_match_embedded_renderer() {
    assert!(validate_lines("0.14", "0.15").is_ok());
    assert!(matches!(
      validate_lines("0.14", "0.16"),
      Err(TemplateEngineMigrationError::TargetRendererMismatch { .. })
    ));
  }
}
