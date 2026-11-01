// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL implementation of [`DocumentVersioningSettingsRepository`].
//!
//! Each public method carries `#[instrument(skip(self), err)]` so that every
//! call site emits a tracing span with its arguments and any returned error.
//!
//! Uses `sqlx::query()` (runtime-checked) rather than `sqlx::query!()` because
//! the compile-time macro requires a live database connection.
//!
//! Design rule (D7): The `get` method returns defaults when no row exists for a
//! `doc_id`.  It does **not** insert a row on read.  All setters use
//! `INSERT … ON CONFLICT (doc_id) DO UPDATE SET …` (upsert).
//!
//! Mikropaket: P-DOC-VER-01

use async_trait::async_trait;
use sqlx::{PgPool, Row};
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};
use tracing::instrument;

use myoxus_domain::entities::{
  AutoVersionTrigger, DocumentAutoVersionTarget, DocumentEditCaptureRuntimeStatus, DocumentVersionRetentionTarget,
  DocumentVersioningSettings, WorkspaceDocumentVersioningSettings, WorkspaceEditCaptureSettingsPatch,
};
use myoxus_domain::repositories::{DocumentVersioningSettingsRepository, RepoResult, RepositoryError};

/// PostgreSQL-backed implementation of [`DocumentVersioningSettingsRepository`].
///
/// Uses the canonical `document_versioning_settings` table.
pub struct PgDocumentVersioningSettingsRepository {
  pool: PgPool,
  config_values: Option<ConfigValuesReader>,
}

/// Async view into the process-wide `ConfigOverrides` snapshot.
///
/// The repository receives a reader instead of a pool-backed config loader so
/// document-version defaults follow the same coherent refresh as every other
/// live setting without owning another cache or polling loop.
pub type ConfigValuesReader =
  Arc<dyn Fn() -> Pin<Box<dyn Future<Output = HashMap<String, serde_json::Value>> + Send>> + Send + Sync>;

impl PgDocumentVersioningSettingsRepository {
  /// Construct a new repository from an existing connection pool.
  pub fn new(pool: PgPool) -> Self {
    Self {
      pool,
      config_values: None,
    }
  }

  pub fn with_config_values_reader(mut self, reader: ConfigValuesReader) -> Self {
    self.config_values = Some(reader);
    self
  }

  async fn global_defaults(&self) -> RepoResult<EffectiveDocumentVersioningDefaults> {
    let values = match &self.config_values {
      Some(read) => read().await,
      None => HashMap::new(),
    };

    let mut defaults = EffectiveDocumentVersioningDefaults::default();
    for (id, value) in values {
      match id.as_str() {
        "document_versioning.default_enabled" => {
          defaults.enabled = value.as_bool().unwrap_or(defaults.enabled);
        }
        "document_versioning.default_auto_version_on_pdf_export" => {
          defaults.auto_version_on_pdf_export = value.as_bool().unwrap_or(defaults.auto_version_on_pdf_export);
        }
        "document_versioning.default_retention_count" => {
          defaults.retention_count = value
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .filter(|n| (1..=50).contains(n))
            .unwrap_or(defaults.retention_count);
        }
        _ => {}
      }
    }
    Ok(defaults)
  }
}

struct EffectiveDocumentVersioningDefaults {
  enabled: bool,
  auto_version_on_pdf_export: bool,
  retention_count: i32,
}

impl Default for EffectiveDocumentVersioningDefaults {
  fn default() -> Self {
    Self {
      enabled: true,
      auto_version_on_pdf_export: true,
      retention_count: 10,
    }
  }
}

impl EffectiveDocumentVersioningDefaults {
  fn triggers(&self) -> Vec<String> {
    if self.auto_version_on_pdf_export {
      vec![AutoVersionTrigger::OnPdfExport.as_str().to_string()]
    } else {
      Vec::new()
    }
  }
}

/// Convert a `Vec<String>` from the DB TEXT[] column into `Vec<AutoVersionTrigger>`.
fn parse_triggers(raw: Vec<String>) -> Vec<AutoVersionTrigger> {
  raw.into_iter().map(|s| AutoVersionTrigger::from(s.as_str())).collect()
}

/// Convert `&[AutoVersionTrigger]` to `Vec<String>` for binding in SQL.
fn triggers_to_strings(triggers: &[AutoVersionTrigger]) -> Vec<String> {
  triggers.iter().map(|t| t.as_str().to_owned()).collect()
}

fn settings_from_effective(
  doc_id: uuid::Uuid,
  auto_version_on: Vec<AutoVersionTrigger>,
  retention_count: i32,
  enabled: bool,
) -> DocumentVersioningSettings {
  DocumentVersioningSettings {
    doc_id,
    policy_id: None,
    auto_version_on,
    retention_count,
    enabled,
    auto_version_on_override: None,
    retention_count_override: None,
    enabled_override: None,
    created_at: None,
    updated_at: None,
  }
}

fn map_workspace_override(row: sqlx::postgres::PgRow) -> WorkspaceDocumentVersioningSettings {
  let triggers = row.get::<Option<Vec<String>>, _>("auto_version_on").map(parse_triggers);
  WorkspaceDocumentVersioningSettings {
    workspace_id: row.get("workspace_id"),
    workspace_name: row.get("workspace_name"),
    enabled: row.get("enabled"),
    auto_version_on: triggers,
    retention_count: row.get("retention_count"),
    edit_capture_enabled: row.get("edit_capture_enabled"),
    edit_capture_interval_ms: row.get("edit_capture_interval_ms"),
    updated_at: row.get("updated_at"),
  }
}

#[async_trait]
impl DocumentVersioningSettingsRepository for PgDocumentVersioningSettingsRepository {
  #[instrument(skip(self), err)]
  async fn edit_capture_runtime_status(
    &self,
    workspace_id: uuid::Uuid,
  ) -> RepoResult<DocumentEditCaptureRuntimeStatus> {
    let row = sqlx::query(
      "SELECT COALESCE(
          (SELECT last_poll_at >= NOW() - INTERVAL '90 seconds'
           FROM document_edit_capture_runtime WHERE singleton), false
        ) AS available,
        (SELECT MAX(last_capture_at) FROM document_edit_capture_state WHERE workspace_id = $1)
          AS last_success_at",
    )
    .bind(workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(DocumentEditCaptureRuntimeStatus {
      available: row.get("available"),
      last_success_at: row.get("last_success_at"),
    })
  }

  #[instrument(skip(self), err)]
  async fn get(&self, doc_id: uuid::Uuid) -> RepoResult<DocumentVersioningSettings> {
    // Document-level settings keep the old, strongest override semantics. If
    // no row exists, fall through to workspace/global defaults without writing.
    let maybe_doc = sqlx::query(
      r#"
      SELECT policy_id, auto_version_on, retention_count, enabled,
             auto_version_on_override, retention_count_override,
             enabled_override, created_at, updated_at
      FROM document_versioning_settings
      WHERE doc_id = $1
      "#,
    )
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;

    match maybe_doc {
      Some(r) => {
        let raw_triggers: Vec<String> = r.get("auto_version_on");
        let raw_override: Option<Vec<String>> = r.get("auto_version_on_override");
        Ok(DocumentVersioningSettings {
          doc_id,
          policy_id: r.get("policy_id"),
          auto_version_on: parse_triggers(raw_triggers),
          retention_count: r.get("retention_count"),
          enabled: r.get("enabled"),
          auto_version_on_override: raw_override.map(parse_triggers),
          retention_count_override: r.get("retention_count_override"),
          enabled_override: r.get("enabled_override"),
          created_at: r.get("created_at"),
          updated_at: r.get("updated_at"),
        })
      }
      None => {
        let defaults = self.global_defaults().await?;
        let default_triggers = defaults.triggers();
        let maybe_inherited = sqlx::query(
          r#"
          SELECT
            COALESCE(ws.auto_version_on, $2::text[]) AS auto_version_on,
            COALESCE(ws.retention_count, $3) AS retention_count,
            COALESCE(ws.enabled, $4) AS enabled
          FROM docs d
          LEFT JOIN document_versioning_workspace_settings ws
            ON ws.workspace_id = d.workspace_id
          WHERE d.id = $1
          "#,
        )
        .bind(doc_id)
        .bind(&default_triggers)
        .bind(defaults.retention_count)
        .bind(defaults.enabled)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| RepositoryError::Storage(e.to_string()))?;

        if let Some(r) = maybe_inherited {
          let raw_triggers: Vec<String> = r.get("auto_version_on");
          Ok(settings_from_effective(
            doc_id,
            parse_triggers(raw_triggers),
            r.get("retention_count"),
            r.get("enabled"),
          ))
        } else {
          Ok(settings_from_effective(doc_id, vec![], 10, false))
        }
      }
    }
  }

  #[instrument(skip(self), err)]
  async fn list_enabled_for_trigger(&self, trigger: AutoVersionTrigger) -> RepoResult<Vec<DocumentAutoVersionTarget>> {
    let trigger_value = trigger.as_str();
    let defaults = self.global_defaults().await?;
    let default_triggers = defaults.triggers();
    let rows = sqlx::query(
      r#"
      SELECT
        d.id AS doc_id,
        d.workspace_id,
        COALESCE(d.updated_by, d.created_by) AS actor_id
      FROM docs d
      LEFT JOIN document_versioning_settings s ON s.doc_id = d.id
      LEFT JOIN document_versioning_workspace_settings ws ON ws.workspace_id = d.workspace_id
      WHERE (
          (s.doc_id IS NOT NULL AND s.enabled = true AND $1 = ANY(s.auto_version_on))
          OR
          (s.doc_id IS NULL
            AND COALESCE(ws.enabled, $2) = true
            AND $1 = ANY(COALESCE(ws.auto_version_on, $3::text[])))
        )
        AND d.deleted_at IS NULL
        AND d.workspace_id IS NOT NULL
        AND COALESCE(d.updated_by, d.created_by) IS NOT NULL
      "#,
    )
    .bind(trigger_value)
    .bind(defaults.enabled)
    .bind(&default_triggers)
    .fetch_all(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;

    Ok(
      rows
        .iter()
        .map(|row| DocumentAutoVersionTarget {
          doc_id: row.get("doc_id"),
          workspace_id: row.get("workspace_id"),
          actor_id: row.get("actor_id"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self), err)]
  async fn list_retention_targets(&self) -> RepoResult<Vec<DocumentVersionRetentionTarget>> {
    let defaults = self.global_defaults().await?;
    let rows = sqlx::query(
      r#"
      SELECT
        d.id AS doc_id,
        d.workspace_id,
        COALESCE(s.retention_count, ws.retention_count, $1) AS retention_count
      FROM docs d
      LEFT JOIN document_versioning_settings s ON s.doc_id = d.id
      LEFT JOIN document_versioning_workspace_settings ws ON ws.workspace_id = d.workspace_id
      WHERE d.deleted_at IS NULL
        AND d.workspace_id IS NOT NULL
        AND (
          s.doc_id IS NOT NULL
          OR ws.workspace_id IS NOT NULL
          OR $2 = true
        )
      "#,
    )
    .bind(defaults.retention_count)
    .bind(defaults.enabled)
    .fetch_all(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;

    Ok(
      rows
        .iter()
        .map(|row| DocumentVersionRetentionTarget {
          doc_id: row.get("doc_id"),
          workspace_id: row.get("workspace_id"),
          retention_count: row.get("retention_count"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self), err)]
  async fn set_triggers(&self, doc_id: uuid::Uuid, triggers: &[AutoVersionTrigger]) -> RepoResult<()> {
    let values = triggers_to_strings(triggers);
    sqlx::query(
      r#"
      INSERT INTO document_versioning_settings (doc_id, auto_version_on, auto_version_on_override, updated_at)
      VALUES ($1, $2, $2, now())
      ON CONFLICT (doc_id) DO UPDATE
          SET auto_version_on = EXCLUDED.auto_version_on,
              auto_version_on_override = EXCLUDED.auto_version_on_override,
              updated_at = now()
      "#,
    )
    .bind(doc_id)
    .bind(&values)
    .execute(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn set_retention_count(&self, doc_id: uuid::Uuid, n: i32) -> RepoResult<()> {
    sqlx::query(
      r#"
      INSERT INTO document_versioning_settings (doc_id, retention_count, retention_count_override, updated_at)
      VALUES ($1, $2, $2, now())
      ON CONFLICT (doc_id) DO UPDATE
          SET retention_count = EXCLUDED.retention_count,
              retention_count_override = EXCLUDED.retention_count_override,
              updated_at = now()
      "#,
    )
    .bind(doc_id)
    .bind(n)
    .execute(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn set_enabled(&self, doc_id: uuid::Uuid, enabled: bool) -> RepoResult<()> {
    sqlx::query(
      r#"
      INSERT INTO document_versioning_settings (doc_id, enabled, enabled_override, updated_at)
      VALUES ($1, $2, $2, now())
      ON CONFLICT (doc_id) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              enabled_override = EXCLUDED.enabled_override,
              updated_at = now()
      "#,
    )
    .bind(doc_id)
    .bind(enabled)
    .execute(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn list_workspace_overrides(&self) -> RepoResult<Vec<WorkspaceDocumentVersioningSettings>> {
    let rows = sqlx::query(
      r#"
      SELECT
        w.id AS workspace_id,
        w.name AS workspace_name,
        settings.enabled,
        settings.auto_version_on,
        settings.retention_count,
        settings.edit_capture_enabled,
        settings.edit_capture_interval_ms,
        settings.updated_at
      FROM workspaces w
      LEFT JOIN document_versioning_workspace_settings settings
        ON settings.workspace_id = w.id
      WHERE w.lifecycle_state = 'active'
      ORDER BY lower(COALESCE(w.name, w.id::text)), w.id
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    Ok(rows.into_iter().map(map_workspace_override).collect())
  }

  #[instrument(skip(self), err)]
  async fn get_workspace_override(
    &self,
    workspace_id: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceDocumentVersioningSettings>> {
    let row = sqlx::query(
      r#"
      SELECT
        w.id AS workspace_id,
        w.name AS workspace_name,
        settings.enabled,
        settings.auto_version_on,
        settings.retention_count,
        settings.edit_capture_enabled,
        settings.edit_capture_interval_ms,
        settings.updated_at
      FROM workspaces w
      LEFT JOIN document_versioning_workspace_settings settings
        ON settings.workspace_id = w.id
      WHERE w.id = $1 AND w.lifecycle_state = 'active'
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    Ok(row.map(map_workspace_override))
  }

  #[instrument(skip(self, patch, expected_revision), err)]
  async fn patch_workspace_edit_capture(
    &self,
    workspace_id: uuid::Uuid,
    patch: WorkspaceEditCaptureSettingsPatch,
    expected_revision: &str,
    updated_by: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceDocumentVersioningSettings>> {
    let mut transaction = self
      .pool
      .begin()
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let workspace =
      sqlx::query("SELECT id, name FROM workspaces WHERE id = $1 AND lifecycle_state = 'active' FOR UPDATE")
        .bind(workspace_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let Some(workspace) = workspace else {
      transaction
        .rollback()
        .await
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
      return Ok(None);
    };
    let current = sqlx::query(
      r#"
      SELECT enabled, auto_version_on, retention_count,
             edit_capture_enabled, edit_capture_interval_ms, updated_at
      FROM document_versioning_workspace_settings
      WHERE workspace_id = $1
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let current_projection = WorkspaceDocumentVersioningSettings {
      workspace_id,
      workspace_name: workspace.get("name"),
      enabled: current.as_ref().and_then(|row| row.get("enabled")),
      auto_version_on: current
        .as_ref()
        .and_then(|row| row.get::<Option<Vec<String>>, _>("auto_version_on"))
        .map(parse_triggers),
      retention_count: current.as_ref().and_then(|row| row.get("retention_count")),
      edit_capture_enabled: current.as_ref().and_then(|row| row.get("edit_capture_enabled")),
      edit_capture_interval_ms: current.as_ref().and_then(|row| row.get("edit_capture_interval_ms")),
      updated_at: current.as_ref().and_then(|row| row.get("updated_at")),
    };
    if !current_projection.patch_matches_revision(&patch, expected_revision) {
      transaction
        .rollback()
        .await
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
      return Err(RepositoryError::Conflict("workspace history settings changed"));
    }

    let enabled_submitted = patch.enabled.is_some();
    let enabled = patch.enabled.flatten();
    let triggers_submitted = patch.auto_version_on.is_some();
    let triggers = patch.auto_version_on.flatten().as_deref().map(triggers_to_strings);
    let retention_submitted = patch.retention_count.is_some();
    let retention_count = patch.retention_count.flatten();
    let capture_enabled_submitted = patch.edit_capture_enabled.is_some();
    let capture_enabled = patch.edit_capture_enabled.flatten();
    let interval_submitted = patch.edit_capture_interval_ms.is_some();
    let interval_ms = patch.edit_capture_interval_ms.flatten();
    sqlx::query(
      r#"
      INSERT INTO document_versioning_workspace_settings
        (workspace_id, enabled, auto_version_on, retention_count,
         edit_capture_enabled, edit_capture_interval_ms, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (workspace_id) DO UPDATE SET
        enabled = CASE WHEN $8 THEN EXCLUDED.enabled ELSE document_versioning_workspace_settings.enabled END,
        auto_version_on = CASE WHEN $9 THEN EXCLUDED.auto_version_on ELSE document_versioning_workspace_settings.auto_version_on END,
        retention_count = CASE WHEN $10 THEN EXCLUDED.retention_count ELSE document_versioning_workspace_settings.retention_count END,
        edit_capture_enabled = CASE WHEN $11 THEN EXCLUDED.edit_capture_enabled ELSE document_versioning_workspace_settings.edit_capture_enabled END,
        edit_capture_interval_ms = CASE WHEN $12 THEN EXCLUDED.edit_capture_interval_ms ELSE document_versioning_workspace_settings.edit_capture_interval_ms END,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      "#,
    )
    .bind(workspace_id)
    .bind(enabled)
    .bind(triggers)
    .bind(retention_count)
    .bind(capture_enabled)
    .bind(interval_ms)
    .bind(updated_by)
    .bind(enabled_submitted)
    .bind(triggers_submitted)
    .bind(retention_submitted)
    .bind(capture_enabled_submitted)
    .bind(interval_submitted)
    .execute(&mut *transaction)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    sqlx::query(
      r#"
      DELETE FROM document_versioning_workspace_settings
      WHERE workspace_id = $1
        AND enabled IS NULL
        AND auto_version_on IS NULL
        AND retention_count IS NULL
        AND edit_capture_enabled IS NULL
        AND edit_capture_interval_ms IS NULL
      "#,
    )
    .bind(workspace_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;

    let row = sqlx::query(
      r#"
      SELECT
        w.id AS workspace_id,
        w.name AS workspace_name,
        settings.enabled,
        settings.auto_version_on,
        settings.retention_count,
        settings.edit_capture_enabled,
        settings.edit_capture_interval_ms,
        settings.updated_at
      FROM workspaces w
      LEFT JOIN document_versioning_workspace_settings settings
        ON settings.workspace_id = w.id
      WHERE w.id = $1 AND w.lifecycle_state = 'active'
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    transaction
      .commit()
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    Ok(row.map(map_workspace_override))
  }

  #[instrument(skip(self, auto_version_on), err)]
  async fn set_workspace_override(
    &self,
    workspace_id: uuid::Uuid,
    enabled: Option<bool>,
    auto_version_on: Option<Vec<AutoVersionTrigger>>,
    retention_count: Option<i32>,
    updated_by: uuid::Uuid,
  ) -> RepoResult<Option<WorkspaceDocumentVersioningSettings>> {
    let mut transaction = self
      .pool
      .begin()
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let workspace_exists = sqlx::query_scalar::<_, uuid::Uuid>(
      "SELECT id FROM workspaces WHERE id = $1 AND lifecycle_state = 'active' FOR UPDATE",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    if workspace_exists.is_none() {
      transaction
        .rollback()
        .await
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
      return Ok(None);
    }

    let triggers = auto_version_on.as_deref().map(triggers_to_strings);
    sqlx::query(
      r#"
        INSERT INTO document_versioning_workspace_settings
          (workspace_id, enabled, auto_version_on, retention_count, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (workspace_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          auto_version_on = EXCLUDED.auto_version_on,
          retention_count = EXCLUDED.retention_count,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        "#,
    )
    .bind(workspace_id)
    .bind(enabled)
    .bind(triggers)
    .bind(retention_count)
    .bind(updated_by)
    .execute(&mut *transaction)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    sqlx::query(
      r#"
      DELETE FROM document_versioning_workspace_settings
      WHERE workspace_id = $1
        AND enabled IS NULL
        AND auto_version_on IS NULL
        AND retention_count IS NULL
        AND edit_capture_enabled IS NULL
        AND edit_capture_interval_ms IS NULL
      "#,
    )
    .bind(workspace_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;

    let row = sqlx::query(
      r#"
      SELECT
        w.id AS workspace_id,
        w.name AS workspace_name,
        settings.enabled,
        settings.auto_version_on,
        settings.retention_count,
        settings.edit_capture_enabled,
        settings.edit_capture_interval_ms,
        settings.updated_at
      FROM workspaces w
      LEFT JOIN document_versioning_workspace_settings settings
        ON settings.workspace_id = w.id
      WHERE w.id = $1 AND w.lifecycle_state = 'active'
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    transaction
      .commit()
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    Ok(row.map(map_workspace_override))
  }
}
