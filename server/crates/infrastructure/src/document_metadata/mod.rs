// SPDX-License-Identifier: AGPL-3.0-or-later
//! SQLx repository for the canonical document metadata head on `docs`.

use async_trait::async_trait;
use sqlx::{PgConnection, PgPool, Row};
use tracing::instrument;
use uuid::Uuid;

use myoxus_application::document_template::{
  DocumentTemplateCandidate, DocumentTemplateRepository, DocumentTemplateSourceState,
};
use myoxus_domain::entities::{
  DocumentMetadataAudience, DocumentMetadataFieldLock, DocumentMetadataFieldValue, DocumentMetadataInheritanceMode,
  DocumentMetadataIntegration, DocumentMetadataJournal, DocumentMetadataMaterializationSummary, DocumentMetadataPatch,
  DocumentMetadataPolicy, DocumentMetadataPresentation, DocumentMetadataProjection, DocumentMetadataReferenceValue,
  DocumentMetadataSource, DocumentMetadataSystemFacts, DocumentMetadataTemplateState,
};
use myoxus_domain::repositories::{DocumentMetadataRepository, RepoResult, RepositoryError};

pub mod initial_sync_audit;

/// Shared positive predicate for native source discovery and Library inventory.
/// Both queries bind `d` to workspace documents and `template` to their native marker.
pub(crate) const NATIVE_TEMPLATE_SOURCE_PREDICATE: &str = "d.deleted_at IS NULL AND d.blocked = FALSE AND d.is_workspace_root = FALSE AND template.state IN ('seeded', 'managed', 'detached')";

#[derive(Clone)]
pub struct PgDocumentMetadataRepository {
  pool: PgPool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentDefaultLanguageSyncStats {
  pub configured_locale: String,
  pub resolved_language_key: String,
  pub organization_defaults_updated: u64,
}

impl PgDocumentMetadataRepository {
  /// Ordinary template copies carry no canonical template attribution. Native
  /// lifecycle writers join this exact metadata operation before their ACK.
  pub(crate) async fn clear_template_state_in_tx(conn: &mut PgConnection, doc_id: Uuid) -> RepoResult<()> {
    sqlx::query("DELETE FROM document_template_state WHERE doc_id = $1")
      .bind(doc_id)
      .execute(conn)
      .await
      .map_err(db_error)?;
    Ok(())
  }
  /// Content writers join this transition to their existing document transaction.
  /// Replays must be rejected before reaching it. Unversioned documents have no
  /// named head to diverge from; already-dirty heads need no revision churn.
  pub(crate) async fn mark_named_version_dirty_in_tx(conn: &mut PgConnection, doc_id: Uuid) -> RepoResult<()> {
    sqlx::query(
      "UPDATE docs SET dirty_since_current_version = true, metadata_updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
         AND current_version_id IS NOT NULL AND NOT dirty_since_current_version",
    )
    .bind(doc_id)
    .execute(conn)
    .await
    .map_err(db_error)?;
    Ok(())
  }

  /// Content-only restores retain the last named version and all business
  /// attributes, but make the draft divergence explicit in its native head.
  pub(crate) async fn mark_content_restored_in_tx(
    conn: &mut PgConnection,
    doc_id: Uuid,
    actor_id: Option<Uuid>,
  ) -> RepoResult<()> {
    sqlx::query("UPDATE docs SET dirty_since_current_version = true, metadata_updated_at = CASE WHEN NOT dirty_since_current_version THEN now() ELSE metadata_updated_at END, metadata_updated_by = COALESCE($2, metadata_updated_by) WHERE id = $1 AND deleted_at IS NULL")
      .bind(doc_id).bind(actor_id).execute(conn).await.map_err(db_error)?;
    Ok(())
  }
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  /// The metadata owner validates the snapshot relation even when a document
  /// capture joins this write to a larger transaction. Business metadata fields
  /// are deliberately not part of this version-head update.
  pub(crate) async fn mark_current_version_in_tx(
    conn: &mut PgConnection,
    doc_id: Uuid,
    version_id: Uuid,
    versioned_at: chrono::DateTime<chrono::Utc>,
    actor_id: Uuid,
  ) -> RepoResult<()> {
    let result = sqlx::query(
      r#"
      UPDATE docs d
      SET current_version_id = $2,
          dirty_since_current_version = false,
          last_versioned_at = $3,
          metadata_updated_at = CASE WHEN current_version_id IS DISTINCT FROM $2
            OR dirty_since_current_version OR last_versioned_at IS DISTINCT FROM $3
            THEN now() ELSE metadata_updated_at END,
          metadata_updated_by = $4
      WHERE d.id = $1 AND d.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM document_version v
                    WHERE v.id = $2 AND v.doc_id = d.id AND v.workspace_id = d.workspace_id)
      "#,
    )
    .bind(doc_id)
    .bind(version_id)
    .bind(versioned_at)
    .bind(actor_id)
    .execute(conn)
    .await
    .map_err(db_error)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("document metadata version"));
    }
    Ok(())
  }
}

#[async_trait]
impl DocumentTemplateRepository for PgDocumentMetadataRepository {
  #[instrument(skip_all)]
  async fn capture_sources(
    &self,
    workspace_id: Uuid,
    external_ids: &[String],
  ) -> RepoResult<Option<Vec<DocumentTemplateSourceState>>> {
    let mut tx = self.pool.begin().await.map_err(db_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(db_error)?;
    let mut sources = Vec::with_capacity(external_ids.len());
    for external_id in external_ids {
      let row = sqlx::query(
        "SELECT d.id, d.external_id, d.title, d.metadata_revision, p.primary_mode,
          GREATEST(COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id=$1 AND doc_id=d.id),0),
                   COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id=$1 AND doc_id=d.id),0)) AS document_revision
         FROM docs d
         JOIN document_template_state t ON t.doc_id=d.id
         LEFT JOIN document_presentation_state p ON p.doc_id=d.id
         WHERE d.workspace_id=$1 AND d.external_id=$2 AND d.deleted_at IS NULL
           AND d.blocked=FALSE AND d.is_workspace_root=FALSE
           AND t.state IN ('seeded','managed','detached')"
      ).bind(workspace_id).bind(external_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
      let Some(row) = row else {
        return Ok(None);
      };
      let doc_id = row.get("id");
      let update = crate::doc::SqlxDocStore::load_full_doc_in_tx(&mut tx, workspace_id, doc_id)
        .await
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
      sources.push(DocumentTemplateSourceState {
        doc_id,
        external_id: row.get("external_id"),
        title: row.get("title"),
        document_revision: row.get("document_revision"),
        metadata_revision: row.get("metadata_revision"),
        primary_mode: row.get("primary_mode"),
        update,
      });
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Some(sources))
  }

  #[instrument(skip(self), fields(%workspace_id, limit, offset), err)]
  async fn list_candidates(
    &self,
    workspace_id: Uuid,
    limit: usize,
    offset: usize,
  ) -> RepoResult<Vec<DocumentTemplateCandidate>> {
    let limit = i64::try_from(limit).map_err(|_| RepositoryError::Validation("template limit is too large".into()))?;
    let offset =
      i64::try_from(offset).map_err(|_| RepositoryError::Validation("template offset is too large".into()))?;
    let sql = format!(
      r#"
      SELECT d.id, d.external_id, d.title
      FROM docs d
      INNER JOIN document_template_state template ON template.doc_id = d.id
      WHERE d.workspace_id = $1
        AND {NATIVE_TEMPLATE_SOURCE_PREDICATE}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $2 OFFSET $3
      "#
    );
    let rows = sqlx::query(&sql)
      .bind(workspace_id)
      .bind(limit)
      .bind(offset)
      .fetch_all(&self.pool)
      .await
      .map_err(db_error)?;
    Ok(
      rows
        .into_iter()
        .map(|row| DocumentTemplateCandidate {
          doc_id: row.get("id"),
          external_id: row.get("external_id"),
          title: row.get("title"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self), fields(%workspace_id, %doc_id), err)]
  async fn get_candidate(&self, workspace_id: Uuid, doc_id: Uuid) -> RepoResult<Option<DocumentTemplateCandidate>> {
    let sql = format!(
      r#"
      SELECT d.id, d.external_id, d.title
      FROM docs d
      INNER JOIN document_template_state template ON template.doc_id = d.id
      WHERE d.workspace_id = $1
        AND d.id = $2
        AND {NATIVE_TEMPLATE_SOURCE_PREDICATE}
      "#
    );
    let row = sqlx::query(&sql)
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(db_error)?;
    Ok(row.map(|row| DocumentTemplateCandidate {
      doc_id: row.get("id"),
      external_id: row.get("external_id"),
      title: row.get("title"),
    }))
  }
}

#[instrument(skip(pool, validator), fields(configured_locale = %default_locale), err)]
pub async fn sync_document_default_language_from_locale(
  pool: &PgPool,
  default_locale: &str,
  validator: &dyn myoxus_application::config_validation::StartupConfigValidator,
) -> anyhow::Result<DocumentDefaultLanguageSyncStats> {
  let configured_locale = default_locale.trim();
  let configured_locale = if configured_locale.is_empty() {
    "en"
  } else {
    configured_locale
  };

  crate::app_config::write_config_batch(
    pool,
    &[crate::app_config::ConfigMutation::Set {
      path: "i18n.default_locale".to_string(),
      value: serde_json::Value::String(configured_locale.to_string()),
    }],
    crate::app_config::ConfigBatchMode::Partial,
    None,
    validator,
  )
  .await?;

  let resolved_language_key: String =
    sqlx::query_scalar("SELECT key FROM language_definition WHERE id = document_metadata_default_language_id()")
      .fetch_one(pool)
      .await?;

  let updated = sqlx::query(
    r#"
    UPDATE organization_document_settings
    SET default_language_id = document_metadata_default_language_id(),
        updated_at = now()
    WHERE updated_by IS NULL
      AND default_language_id IS DISTINCT FROM document_metadata_default_language_id()
    "#,
  )
  .execute(pool)
  .await?;

  Ok(DocumentDefaultLanguageSyncStats {
    configured_locale: configured_locale.to_string(),
    resolved_language_key,
    organization_defaults_updated: updated.rows_affected(),
  })
}

fn db_error(error: sqlx::Error) -> RepositoryError {
  if let sqlx::Error::Database(ref dbe) = error {
    match dbe.code().as_deref() {
      Some("23503") => {
        return RepositoryError::Validation("document metadata reference not found".to_string());
      }
      Some("23505") => return RepositoryError::Conflict("document metadata uniqueness violation"),
      Some("23514") | Some("P0001") => return RepositoryError::Validation(dbe.message().to_string()),
      _ => {}
    }
  }
  RepositoryError::Storage(error.to_string())
}

fn reference_from_row(row: &sqlx::postgres::PgRow, prefix: &str) -> Option<DocumentMetadataReferenceValue> {
  let id: Option<Uuid> = row.get(format!("{prefix}_id").as_str());
  Some(DocumentMetadataReferenceValue {
    id: id?,
    key: row.get(format!("{prefix}_key").as_str()),
    label: row.get(format!("{prefix}_label").as_str()),
    is_active: row.get(format!("{prefix}_active").as_str()),
  })
}

fn push_reference_attribute(
  attributes: &mut Vec<DocumentMetadataFieldValue>,
  key: &str,
  source: String,
  reference: Option<DocumentMetadataReferenceValue>,
) {
  attributes.push(DocumentMetadataFieldValue {
    key: key.to_string(),
    source: DocumentMetadataSource::from_storage(source.as_str()),
    reference,
    text_value: None,
    timestamp_value: None,
    date_value: None,
    user_id: None,
  });
}

fn route_accepts_set_document_metadata(route: &str) -> bool {
  matches!(
    route,
    "document_metadata" | "template_state" | "presentation_setting" | "integration_subsystem"
  )
}

async fn load_policy(conn: &mut PgConnection, workspace_id: Uuid) -> RepoResult<DocumentMetadataPolicy> {
  // Effective metadata policy is resolved from the workspace's organization
  // context. It does not grant document access and it is not a Git-Sync policy:
  // callers must still enforce workspace/doc permissions before applying it.
  let rows = sqlx::query(
    r#"
    SELECT f.key,
           f.inheritance_mode,
           f.document_edit_role,
           f.mutation_route,
           COALESCE(p.enabled, true) AS enabled
    FROM document_metadata_field_definition f
    LEFT JOIN organization_document_metadata_policy p
      ON p.organization_id = document_metadata_effective_organization_id($1)
     AND p.field_key = f.key
    WHERE COALESCE(p.visible_in_properties, f.visible_in_properties)
    ORDER BY f.key
    "#,
  )
  .bind(workspace_id)
  .fetch_all(conn)
  .await
  .map_err(db_error)?;

  Ok(DocumentMetadataPolicy {
    locks: rows
      .into_iter()
      .map(|row| {
        let key: String = row.get("key");
        let inheritance_mode =
          DocumentMetadataInheritanceMode::from_storage(row.get::<String, _>("inheritance_mode").as_str());
        let role: Option<String> = row.get("document_edit_role");
        let route: String = row.get("mutation_route");
        let enabled: bool = row.get("enabled");
        let editable = enabled
          && role.as_deref().is_some_and(|value| value != "system_only")
          && route_accepts_set_document_metadata(&route);
        let reason = if editable {
          None
        } else if !enabled {
          Some("field is disabled by organization policy".to_string())
        } else if route == "status_transition" {
          Some("status requires transitionDocumentStatus".to_string())
        } else if route == "readonly" {
          Some("field is read-only system metadata".to_string())
        } else {
          Some(format!("field is edited through {route}"))
        };
        DocumentMetadataFieldLock {
          key,
          inheritance_mode,
          editable,
          reason,
        }
      })
      .collect(),
  })
}

fn patch_field_keys(patch: &DocumentMetadataPatch) -> Vec<&'static str> {
  let mut keys = Vec::new();
  if patch.document_type_id.is_some() {
    keys.push("documentType");
  }
  if patch.classification_id.is_some() {
    keys.push("classification");
  }
  if patch.retention_policy_id.is_some() {
    keys.push("retentionPolicy");
  }
  if patch.language_id.is_some() {
    keys.push("language");
  }
  if patch.responsible_user_id.is_some() {
    keys.push("responsible");
  }
  if patch.document_number.is_some() {
    keys.push("documentNumber");
  }
  if patch.review_due_at.is_some() {
    keys.push("reviewDueAt");
  }
  if patch.valid_from.is_some() {
    keys.push("validFrom");
  }
  if patch.valid_until.is_some() {
    keys.push("validUntil");
  }
  if patch.journal_date.is_some() {
    keys.push("journalDate");
  }
  if patch.audience_ids.is_some() {
    keys.push("audience");
  }
  if patch.template_state.is_some()
    || patch.template_origin.is_some()
    || patch.template_category.is_some()
    || patch.template_tags.is_some()
    || patch.template_id.is_some()
    || patch.template_revision_id.is_some()
    || patch.template_instance_id.is_some()
  {
    keys.push("templateState");
  }
  if patch.primary_mode.is_some() {
    keys.push("primaryMode");
  }
  if patch.page_width.is_some() {
    keys.push("pageWidth");
  }
  if patch.edgeless_color_theme.is_some() {
    keys.push("edgelessColorTheme");
  }
  if patch.integration_type.is_some() {
    keys.push("integrationType");
  }
  keys
}

async fn assert_patch_fields_editable(
  pool: &PgPool,
  doc_id: Uuid,
  workspace_id: Uuid,
  actor_id: Uuid,
  patch: &DocumentMetadataPatch,
) -> RepoResult<()> {
  for key in patch_field_keys(patch) {
    let gate: Option<(bool, Option<String>, String, bool)> = sqlx::query_as(
      r#"
      WITH actor_context AS (
        SELECT
          COALESCE(u.is_admin, false) AS is_global_admin,
          CASE
            WHEN w.owner_user_id = $3 THEN 'Owner'
            WHEN EXISTS (
              SELECT 1
              FROM organization_unit_workspace ouw
              JOIN organization_unit ou
                ON ou.id = ouw.unit_id
               AND ou.status = 'active'
              JOIN organization_unit_member oum
                ON oum.unit_id = ouw.unit_id
               AND oum.user_id = $3
               AND oum.role = 'manager'
              JOIN user_features uf
                ON uf.user_id = $3
               AND uf.feature_name = 'manager'
               AND uf.activated = true
              WHERE ouw.workspace_id = d.workspace_id
            ) THEN 'Admin'
            ELSE wm.role
          END AS workspace_role,
          dup.role AS doc_role,
          d.responsible_user_id
        FROM docs d
        JOIN workspaces w ON w.id = d.workspace_id
        JOIN users u ON u.id = $3
        LEFT JOIN workspace_memberships wm
          ON wm.workspace_id = d.workspace_id
         AND wm.user_id = $3
         AND wm.status = 'Accepted'
        LEFT JOIN doc_user_permissions dup
          ON dup.doc_id = d.id
         AND dup.user_id = $3
        WHERE d.id = $1
          AND d.workspace_id = $2
          AND d.deleted_at IS NULL
          AND w.lifecycle_state = 'active'
          AND w.deleted_at IS NULL
      )
      SELECT COALESCE(p.enabled, true) AS enabled,
             f.document_edit_role,
             f.mutation_route,
             COALESCE(CASE
               WHEN COALESCE(p.enabled, true) = false THEN false
               WHEN f.mutation_route NOT IN ('document_metadata', 'template_state', 'presentation_setting', 'integration_subsystem', 'journal_calendar') THEN false
               -- Journal assignment is a native calendar subsystem write.
               -- It remains outside editable business metadata, but it must
               -- be writable by actors who may update the document itself so
               -- daily-journal creation and the Journal property control can
               -- persist the canonical `docs.journal_date` value.
               WHEN f.mutation_route = 'journal_calendar'
                 THEN ac.is_global_admin
                   OR ac.workspace_role IN ('Owner', 'Admin', 'Manager', 'Collaborator')
                   OR ac.doc_role IN ('Owner', 'Manager', 'Editor')
               WHEN f.document_edit_role IS NULL OR f.document_edit_role = 'system_only' THEN false
               WHEN f.document_edit_role = 'organization_admin' THEN ac.is_global_admin
               WHEN f.document_edit_role = 'workspace_admin'
                 THEN ac.is_global_admin OR ac.workspace_role IN ('Owner', 'Admin')
               WHEN f.document_edit_role = 'document_manager'
                 THEN ac.is_global_admin
                   OR ac.workspace_role IN ('Owner', 'Admin', 'Manager')
                   OR ac.doc_role IN ('Owner', 'Manager')
               WHEN f.document_edit_role = 'document_editor'
                 THEN ac.is_global_admin
                   OR ac.workspace_role IN ('Owner', 'Admin', 'Manager', 'Collaborator')
                   OR ac.doc_role IN ('Owner', 'Manager', 'Editor')
               WHEN f.document_edit_role = 'responsible_user'
                 THEN ac.is_global_admin
                   OR ac.workspace_role IN ('Owner', 'Admin', 'Manager')
                   OR ac.doc_role IN ('Owner', 'Manager')
                   OR ac.responsible_user_id = $3
               ELSE false
             END, false) AS allowed
      FROM document_metadata_field_definition f
      CROSS JOIN actor_context ac
      LEFT JOIN organization_document_metadata_policy p
        ON p.organization_id = document_metadata_effective_organization_id($2)
       AND p.field_key = f.key
      WHERE f.key = $4
      "#,
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(actor_id)
    .bind(key)
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;
    match gate {
      Some((true, _, _, true)) => {}
      Some((false, _, _, _)) => {
        return Err(RepositoryError::Validation(format!(
          "document metadata field disabled by organization policy: {key}"
        )));
      }
      Some((true, role, route, false)) => {
        let role = role.unwrap_or_else(|| "none".to_string());
        if route == "status_transition" {
          return Err(RepositoryError::Validation(format!(
            "document metadata status requires transition: {key}"
          )));
        }
        if role == "system_only" || route == "readonly" || route == "journal_calendar" {
          return Err(RepositoryError::Validation(format!(
            "document metadata system field read only: {key} ({role}/{route})"
          )));
        }
        return Err(RepositoryError::Validation(format!(
          "document metadata field locked for actor: {key} ({role}/{route})"
        )));
      }
      None => {
        return Err(RepositoryError::Validation(format!(
          "document metadata field unknown: {key}"
        )));
      }
    }
  }

  Ok(())
}

async fn load_audience(conn: &mut PgConnection, doc_id: Uuid) -> RepoResult<Vec<DocumentMetadataAudience>> {
  let rows = sqlx::query(
    r#"
    SELECT a.source, d.id, d.key, d.label, d.is_active
    FROM doc_audience_assignment a
    JOIN document_audience_definition d ON d.id = a.audience_id
    WHERE a.doc_id = $1
    ORDER BY d.sort_order, d.key
    "#,
  )
  .bind(doc_id)
  .fetch_all(conn)
  .await
  .map_err(db_error)?;

  Ok(
    rows
      .into_iter()
      .map(|row| DocumentMetadataAudience {
        source: DocumentMetadataSource::from_storage(row.get::<String, _>("source").as_str()),
        value: DocumentMetadataReferenceValue {
          id: row.get("id"),
          key: row.get("key"),
          label: row.get("label"),
          is_active: row.get("is_active"),
        },
      })
      .collect(),
  )
}

async fn load_projection_version(
  conn: &mut PgConnection,
  doc_id: Uuid,
  workspace_id: Uuid,
) -> RepoResult<Option<String>> {
  let row = sqlx::query(
    r#"
    SELECT d.metadata_revision,
           COALESCE(effective_org.organization_id::text, 'none') AS effective_organization_id,
           COALESCE(global_field_definition.revision, 0) AS global_field_definition_revision,
           COALESCE(global_reference_values.revision, 0) AS global_reference_values_revision,
           COALESCE(org_policy.revision, 0) AS organization_policy_revision,
           COALESCE(org_defaults.revision, 0) AS organization_defaults_revision,
           COALESCE(workspace_defaults.revision, 0) AS workspace_defaults_revision
    FROM docs d
    LEFT JOIN LATERAL (
      SELECT COALESCE(linked_owner.organization_id, owner_unit.organization_id, managed_unit.organization_id, default_org.id) AS organization_id
      FROM workspaces w
      LEFT JOIN organization_unit owner_unit
        ON owner_unit.id = w.owner_principal_id
       AND w.owner_principal_type::text = 'ou'
      LEFT JOIN organization_unit managed_unit
        ON managed_unit.id = w.management_unit_id
      LEFT JOIN LATERAL (
        SELECT ou.organization_id
        FROM organization_unit_workspace ouw
        JOIN organization_unit ou ON ou.id = ouw.unit_id
        WHERE ouw.workspace_id = w.id
        ORDER BY CASE lower(ouw.relationship::text)
          WHEN 'owner' THEN 0
          WHEN 'managed' THEN 1
          ELSE 2
        END, ouw.updated_at DESC
        LIMIT 1
      ) linked_owner ON true
      LEFT JOIN LATERAL (
        SELECT id
        FROM organization
        WHERE key = 'myoxus'
        ORDER BY created_at, id
        LIMIT 1
      ) default_org ON true
      WHERE w.id = d.workspace_id
        AND w.lifecycle_state = 'active'
        AND w.deleted_at IS NULL
    ) effective_org ON true
    LEFT JOIN document_metadata_global_epoch global_field_definition
      ON global_field_definition.epoch_name = 'field_definition'
    LEFT JOIN document_metadata_global_epoch global_reference_values
      ON global_reference_values.epoch_name = 'reference_values'
    LEFT JOIN organization_document_metadata_epoch org_policy
      ON org_policy.organization_id = effective_org.organization_id
     AND org_policy.epoch_name = 'policy'
    LEFT JOIN organization_document_metadata_epoch org_defaults
      ON org_defaults.organization_id = effective_org.organization_id
     AND org_defaults.epoch_name = 'defaults'
    LEFT JOIN workspace_document_metadata_epoch workspace_defaults
      ON workspace_defaults.workspace_id = d.workspace_id
     AND workspace_defaults.epoch_name = 'defaults'
    WHERE d.id = $1 AND d.workspace_id = $2 AND d.deleted_at IS NULL
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .fetch_optional(conn)
  .await
  .map_err(db_error)?;

  Ok(row.map(|row| {
    format!(
      "contract-v3:doc:{}:global:field_definition={};reference_values={}:org:{}:policy={};defaults={}:workspace:defaults={}",
      row.get::<i64, _>("metadata_revision"),
      row.get::<i64, _>("global_field_definition_revision"),
      row.get::<i64, _>("global_reference_values_revision"),
      row.get::<String, _>("effective_organization_id"),
      row.get::<i64, _>("organization_policy_revision"),
      row.get::<i64, _>("organization_defaults_revision"),
      row.get::<i64, _>("workspace_defaults_revision")
    )
  }))
}

#[async_trait]
impl DocumentMetadataRepository for PgDocumentMetadataRepository {
  #[instrument(skip(self), fields(%doc_id), err)]
  async fn workspace_id_for_document(&self, doc_id: Uuid) -> RepoResult<Option<Uuid>> {
    let row = sqlx::query("SELECT workspace_id FROM docs WHERE id = $1 AND deleted_at IS NULL")
      .bind(doc_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(db_error)?;
    Ok(row.and_then(|row| row.get::<Option<Uuid>, _>("workspace_id")))
  }

  #[instrument(skip(self), fields(%doc_id, %workspace_id), err)]
  async fn get_projection_versioned(
    &self,
    doc_id: Uuid,
    workspace_id: Uuid,
  ) -> RepoResult<Option<(String, DocumentMetadataProjection)>> {
    let mut tx = self.pool.begin().await.map_err(db_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(db_error)?;
    let row = sqlx::query(
      r#"
      SELECT d.id, d.workspace_id, d.created_at, d.updated_at, d.created_by, d.updated_by,
             d.metadata_revision, d.metadata_updated_at, d.metadata_updated_by,
             d.status_source,
             d.current_version_id, d.dirty_since_current_version, d.version_display_mode, d.last_versioned_at,
             d.document_number, d.review_due_at, d.valid_from, d.valid_until, d.journal_date,
             d.responsible_user_id, d.responsible_source,
             d.document_type_source, d.classification_source, d.retention_policy_source, d.language_source,
             sv.id AS status_id, sv.key AS status_key, sv.label AS status_label, sv.is_active AS status_active, sv.okf_status AS status_okf_status,
             dv.id AS current_version_ref_id, COALESCE(dv.version_no::TEXT, dv.id::TEXT) AS current_version_ref_key,
             dv.label AS current_version_ref_label, (dv.id IS NOT NULL) AS current_version_ref_active,
             dt.id AS document_type_id, dt.key AS document_type_key, dt.label AS document_type_label, dt.is_active AS document_type_active,
             cl.id AS classification_id, cl.key AS classification_key, cl.label AS classification_label, cl.is_active AS classification_active,
             rp.id AS retention_policy_id, rp.key AS retention_policy_key, rp.label AS retention_policy_label, rp.is_active AS retention_policy_active,
             lang.id AS language_id, lang.key AS language_key, lang.label AS language_label, lang.is_active AS language_active,
             tmpl.template_id, tmpl.revision_id, tmpl.instance_id, tmpl.state AS template_state,
             tmpl.metadata ->> 'origin' AS template_origin,
             tmpl.metadata ->> 'category' AS template_category,
             tmpl.metadata -> 'tags' AS template_tags,
             pres.primary_mode, pres.page_width, pres.edgeless_color_theme,
             integ.integration_type
      FROM docs d
      LEFT JOIN document_status_value sv ON sv.id = d.status_id
      LEFT JOIN document_version dv ON dv.id = d.current_version_id
      LEFT JOIN document_type_definition dt ON dt.id = d.document_type_id
      LEFT JOIN document_classification_definition cl ON cl.id = d.classification_id
      LEFT JOIN document_retention_policy_definition rp ON rp.id = d.retention_policy_id
      LEFT JOIN language_definition lang ON lang.id = d.language_id
      LEFT JOIN document_template_state tmpl ON tmpl.doc_id = d.id
      LEFT JOIN document_presentation_state pres ON pres.doc_id = d.id
      LEFT JOIN document_integration_state integ ON integ.doc_id = d.id
      WHERE d.id = $1 AND d.workspace_id = $2 AND d.deleted_at IS NULL
      "#,
    )
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;

    let Some(row) = row else {
      return Ok(None);
    };

    let mut attributes = Vec::new();
    push_reference_attribute(
      &mut attributes,
      "status",
      row.get("status_source"),
      reference_from_row(&row, "status"),
    );
    // The reference-values epoch covers mapping changes without per-document writes.
    // Keep inactive assigned definitions readable; policy choices filter them separately.
    if let Some(status) = attributes.last_mut() {
      status.text_value = row.get("status_okf_status");
    }
    attributes.push(DocumentMetadataFieldValue {
      key: "version".to_string(),
      source: DocumentMetadataSource::Document,
      reference: reference_from_row(&row, "current_version_ref"),
      text_value: if row.get::<bool, _>("dirty_since_current_version") {
        Some("dirty".to_string())
      } else {
        Some(row.get("version_display_mode"))
      },
      timestamp_value: row.get("last_versioned_at"),
      date_value: None,
      user_id: None,
    });
    push_reference_attribute(
      &mut attributes,
      "documentType",
      row.get("document_type_source"),
      reference_from_row(&row, "document_type"),
    );
    push_reference_attribute(
      &mut attributes,
      "classification",
      row.get("classification_source"),
      reference_from_row(&row, "classification"),
    );
    push_reference_attribute(
      &mut attributes,
      "retentionPolicy",
      row.get("retention_policy_source"),
      reference_from_row(&row, "retention_policy"),
    );
    push_reference_attribute(
      &mut attributes,
      "language",
      row.get("language_source"),
      reference_from_row(&row, "language"),
    );
    attributes.push(DocumentMetadataFieldValue {
      key: "responsible".to_string(),
      source: DocumentMetadataSource::from_storage(row.get::<String, _>("responsible_source").as_str()),
      reference: None,
      text_value: None,
      timestamp_value: None,
      date_value: None,
      user_id: row.get("responsible_user_id"),
    });
    attributes.push(DocumentMetadataFieldValue {
      key: "documentNumber".to_string(),
      source: DocumentMetadataSource::Document,
      reference: None,
      text_value: row.get("document_number"),
      timestamp_value: None,
      date_value: None,
      user_id: None,
    });
    for (key, column) in [
      ("reviewDueAt", "review_due_at"),
      ("validFrom", "valid_from"),
      ("validUntil", "valid_until"),
    ] {
      attributes.push(DocumentMetadataFieldValue {
        key: key.to_string(),
        source: DocumentMetadataSource::Document,
        reference: None,
        text_value: None,
        timestamp_value: row.get(column),
        date_value: None,
        user_id: None,
      });
    }

    let template = row
      .get::<Option<String>, _>("template_state")
      .map(|state| DocumentMetadataTemplateState {
        state,
        origin: row.get("template_origin"),
        category: row.get("template_category"),
        tags: row
          .get::<Option<serde_json::Value>, _>("template_tags")
          .and_then(|tags| serde_json::from_value(tags).ok()),
        template_id: row.get("template_id"),
        revision_id: row.get("revision_id"),
        instance_id: row.get("instance_id"),
      });

    let audience = load_audience(&mut *tx, doc_id).await?;
    let policy = load_policy(&mut *tx, workspace_id).await?;
    let Some(projection_version) = load_projection_version(&mut *tx, doc_id, workspace_id).await? else {
      return Ok(None);
    };
    let projection = DocumentMetadataProjection {
      doc_id,
      workspace_id,
      projection_version: String::new(),
      metadata_revision: row.get("metadata_revision"),
      metadata_updated_at: row.get("metadata_updated_at"),
      metadata_updated_by: row.get("metadata_updated_by"),
      system: DocumentMetadataSystemFacts {
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        created_by: row.get("created_by"),
        updated_by: row.get("updated_by"),
        metadata_updated_at: row.get("metadata_updated_at"),
        metadata_updated_by: row.get("metadata_updated_by"),
      },
      fields: attributes,
      audience,
      template,
      journal: DocumentMetadataJournal {
        journal_date: row.get("journal_date"),
      },
      presentation: if row.get::<Option<String>, _>("primary_mode").is_some()
        || row.get::<Option<String>, _>("page_width").is_some()
        || row.get::<Option<String>, _>("edgeless_color_theme").is_some()
      {
        Some(DocumentMetadataPresentation {
          primary_mode: row.get("primary_mode"),
          page_width: row.get("page_width"),
          edgeless_color_theme: row.get("edgeless_color_theme"),
        })
      } else {
        None::<DocumentMetadataPresentation>
      },
      integration: row
        .get::<Option<String>, _>("integration_type")
        .map(|integration_type| DocumentMetadataIntegration {
          integration_type: Some(integration_type),
        }),
      policy,
    };
    tx.commit().await.map_err(db_error)?;
    Ok(Some((projection_version, projection)))
  }

  #[instrument(skip(self), fields(%doc_id, %workspace_id), err)]
  async fn get_projection(&self, doc_id: Uuid, workspace_id: Uuid) -> RepoResult<Option<DocumentMetadataProjection>> {
    Ok(
      self
        .get_projection_versioned(doc_id, workspace_id)
        .await?
        .map(|(_, projection)| projection),
    )
  }

  #[instrument(skip(self), fields(%doc_id, %workspace_id), err)]
  async fn projection_version(&self, doc_id: Uuid, workspace_id: Uuid) -> RepoResult<Option<String>> {
    let mut conn = self.pool.acquire().await.map_err(db_error)?;
    load_projection_version(&mut conn, doc_id, workspace_id).await
  }

  #[instrument(skip(self, patch), fields(%doc_id, %actor_id), err)]
  async fn apply_patch(&self, doc_id: Uuid, actor_id: Uuid, patch: &DocumentMetadataPatch) -> RepoResult<()> {
    let workspace_id: Option<Uuid> = sqlx::query_scalar(
      "SELECT workspace_id FROM docs WHERE id = $1 AND workspace_id IS NOT NULL AND deleted_at IS NULL",
    )
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(db_error)?;
    let Some(workspace_id) = workspace_id else {
      return Err(RepositoryError::NotFound("document metadata"));
    };
    assert_patch_fields_editable(&self.pool, doc_id, workspace_id, actor_id, patch).await?;
    let mut tx = self.pool.begin().await.map_err(db_error)?;
    let current_head: Option<(i64, Uuid)> = sqlx::query_as(
      "SELECT metadata_revision, workspace_id FROM docs WHERE id = $1 AND workspace_id IS NOT NULL AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(doc_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    let Some((current_revision, workspace_id)) = current_head else {
      return Err(RepositoryError::NotFound("document metadata"));
    };
    if let Some(expected_revision) = patch.expected_metadata_revision
      && current_revision != expected_revision
    {
      return Err(RepositoryError::Conflict("document metadata revision conflict"));
    }
    // Field sources are explicit (`document`, `workspace`, `organization`,
    // `fallback`). A document patch only writes the document layer; workspace
    // defaults, organization defaults and Git-Sync provenance stay separate.
    if let Some(Some(responsible_user_id)) = patch.responsible_user_id {
      let is_valid: bool = sqlx::query_scalar("SELECT document_metadata_is_valid_responsible_user($1, $2)")
        .bind(workspace_id)
        .bind(responsible_user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
      if !is_valid {
        return Err(RepositoryError::Validation(
          "document metadata responsible user invalid".to_string(),
        ));
      }
    }
    let has_document_field_patch = patch.document_type_id.is_some()
      || patch.classification_id.is_some()
      || patch.retention_policy_id.is_some()
      || patch.language_id.is_some()
      || patch.responsible_user_id.is_some()
      || patch.document_number.is_some()
      || patch.review_due_at.is_some()
      || patch.valid_from.is_some()
      || patch.valid_until.is_some()
      || patch.journal_date.is_some();
    let has_template_patch = patch.template_state.is_some()
      || patch.template_origin.is_some()
      || patch.template_category.is_some()
      || patch.template_tags.is_some()
      || patch.template_id.is_some()
      || patch.template_revision_id.is_some()
      || patch.template_instance_id.is_some();
    if patch.template_category.is_some() || patch.template_tags.is_some() {
      // Registry binding writers hold the same document lock. Keep this check
      // inside the patch transaction so classification cannot outrun assignment.
      let registry_bound: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
          SELECT 1 FROM workspace_template_instances i
          JOIN workspace_template_policies p
            ON p.workspace_id = i.workspace_id AND p.template_id = i.template_id
          WHERE i.workspace_id = $1 AND i.workspace_doc_id = $2
            AND i.state <> 'retired' AND i.retired_at IS NULL
            AND i.detached_at IS NULL AND p.is_enabled = TRUE
        )
        "#,
      )
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(db_error)?;
      if registry_bound {
        return Err(RepositoryError::Validation(
          "Registry source classification is managed in Admin Templates".to_string(),
        ));
      }
    }
    if matches!(patch.template_state, Some(None)) {
      crate::template_registry::reject_managed_source_write(&mut tx, workspace_id, doc_id)
        .await
        .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    }
    let has_presentation_patch =
      patch.primary_mode.is_some() || patch.page_width.is_some() || patch.edgeless_color_theme.is_some();
    let has_integration_patch = patch.integration_type.is_some();
    if has_document_field_patch {
      let result = sqlx::query(
        r#"
        UPDATE docs
        SET document_type_id = CASE WHEN $2::boolean THEN $3 ELSE document_type_id END,
            document_type_source = CASE WHEN $2::boolean THEN 'document' ELSE document_type_source END,
            classification_id = CASE WHEN $4::boolean THEN $5 ELSE classification_id END,
            classification_source = CASE WHEN $4::boolean THEN 'document' ELSE classification_source END,
            retention_policy_id = CASE WHEN $6::boolean THEN $7 ELSE retention_policy_id END,
            retention_policy_source = CASE WHEN $6::boolean THEN 'document' ELSE retention_policy_source END,
            language_id = CASE WHEN $8::boolean THEN $9 ELSE language_id END,
            language_source = CASE WHEN $8::boolean THEN 'document' ELSE language_source END,
            responsible_user_id = CASE WHEN $10::boolean THEN $11 ELSE responsible_user_id END,
            responsible_source = CASE WHEN $10::boolean THEN 'document' ELSE responsible_source END,
            document_number = CASE WHEN $12::boolean THEN $13 ELSE document_number END,
            review_due_at = CASE WHEN $14::boolean THEN $15 ELSE review_due_at END,
            valid_from = CASE WHEN $16::boolean THEN $17 ELSE valid_from END,
            valid_until = CASE WHEN $18::boolean THEN $19 ELSE valid_until END,
            journal_date = CASE WHEN $20::boolean THEN $21 ELSE journal_date END,
            metadata_updated_by = $22
        WHERE id = $1 AND workspace_id IS NOT NULL AND deleted_at IS NULL
        "#,
      )
      .bind(doc_id)
      .bind(patch.document_type_id.is_some())
      .bind(patch.document_type_id.flatten())
      .bind(patch.classification_id.is_some())
      .bind(patch.classification_id.flatten())
      .bind(patch.retention_policy_id.is_some())
      .bind(patch.retention_policy_id.flatten())
      .bind(patch.language_id.is_some())
      .bind(patch.language_id.flatten())
      .bind(patch.responsible_user_id.is_some())
      .bind(patch.responsible_user_id.flatten())
      .bind(patch.document_number.is_some())
      .bind(patch.document_number.clone().flatten())
      .bind(patch.review_due_at.is_some())
      .bind(patch.review_due_at.flatten())
      .bind(patch.valid_from.is_some())
      .bind(patch.valid_from.flatten())
      .bind(patch.valid_until.is_some())
      .bind(patch.valid_until.flatten())
      .bind(patch.journal_date.is_some())
      .bind(patch.journal_date.flatten())
      .bind(actor_id)
      .execute(&mut *tx)
      .await
      .map_err(db_error)?;
      if result.rows_affected() == 0 {
        return Err(RepositoryError::NotFound("document metadata"));
      }
    }

    if has_template_patch {
      let explicit_delete = matches!(patch.template_state, Some(None));
      if explicit_delete {
        Self::clear_template_state_in_tx(&mut tx, doc_id).await?;
      } else {
        let mut metadata = serde_json::Map::new();
        let mut cleared_metadata_keys = Vec::new();
        if let Some(origin) = &patch.template_origin {
          metadata.insert("origin".to_string(), serde_json::json!(origin));
        }
        if let Some(category) = &patch.template_category {
          metadata.insert("category".to_string(), serde_json::json!(category));
        }
        if let Some(tags) = &patch.template_tags {
          metadata.insert("tags".to_string(), serde_json::json!(tags));
        }
        for (key, value) in &metadata {
          if value.is_null() {
            cleared_metadata_keys.push(key.clone());
          }
        }
        let state = patch
          .template_state
          .clone()
          .flatten()
          .unwrap_or_else(|| "managed".to_string());
        sqlx::query(
          r#"
          INSERT INTO document_template_state
            (doc_id, state, template_id, revision_id, instance_id, source, metadata, updated_by, updated_at)
          VALUES (
            $1, $2, $3, $4, $5, 'document',
            jsonb_strip_nulls($6::jsonb),
            $7, now()
          )
          ON CONFLICT (doc_id) DO UPDATE SET
            state = CASE WHEN $8::boolean THEN EXCLUDED.state ELSE document_template_state.state END,
            template_id = CASE WHEN $9::boolean THEN EXCLUDED.template_id ELSE document_template_state.template_id END,
            revision_id = CASE WHEN $10::boolean THEN EXCLUDED.revision_id ELSE document_template_state.revision_id END,
            instance_id = CASE WHEN $11::boolean THEN EXCLUDED.instance_id ELSE document_template_state.instance_id END,
            metadata = (document_template_state.metadata - $12::text[]) || jsonb_strip_nulls($6::jsonb),
            source = 'document',
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          "#,
        )
        .bind(doc_id)
        .bind(state)
        .bind(patch.template_id.flatten())
        .bind(patch.template_revision_id.flatten())
        .bind(patch.template_instance_id.flatten())
        .bind(serde_json::Value::Object(metadata))
        .bind(actor_id)
        .bind(patch.template_state.is_some())
        .bind(patch.template_id.is_some())
        .bind(patch.template_revision_id.is_some())
        .bind(patch.template_instance_id.is_some())
        .bind(&cleared_metadata_keys)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
      }
      if patch.template_category.is_some() || patch.template_tags.is_some() {
        // The subsystem trigger tracks state/origin. Classification is also
        // a list fact and must invalidate that cache in this same transaction.
        sqlx::query("SELECT bump_workspace_document_metadata_index_revision($1)")
          .bind(workspace_id)
          .execute(&mut *tx)
          .await
          .map_err(db_error)?;
      }
    }

    if has_presentation_patch {
      sqlx::query(
        r#"
        INSERT INTO document_presentation_state
          (doc_id, primary_mode, page_width, edgeless_color_theme, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (doc_id) DO UPDATE SET
          primary_mode = CASE WHEN $6::boolean THEN EXCLUDED.primary_mode ELSE document_presentation_state.primary_mode END,
          page_width = CASE WHEN $7::boolean THEN EXCLUDED.page_width ELSE document_presentation_state.page_width END,
          edgeless_color_theme = CASE WHEN $8::boolean THEN EXCLUDED.edgeless_color_theme ELSE document_presentation_state.edgeless_color_theme END,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        "#,
      )
      .bind(doc_id)
      .bind(patch.primary_mode.clone().flatten())
      .bind(patch.page_width.clone().flatten())
      .bind(patch.edgeless_color_theme.clone().flatten())
      .bind(actor_id)
      .bind(patch.primary_mode.is_some())
      .bind(patch.page_width.is_some())
      .bind(patch.edgeless_color_theme.is_some())
      .execute(&mut *tx)
      .await
      .map_err(db_error)?;
    }

    if has_integration_patch {
      if matches!(patch.integration_type, Some(None)) {
        sqlx::query("DELETE FROM document_integration_state WHERE doc_id = $1")
          .bind(doc_id)
          .execute(&mut *tx)
          .await
          .map_err(db_error)?;
      } else {
        sqlx::query(
          r#"
          INSERT INTO document_integration_state (doc_id, integration_type, updated_by, updated_at)
          VALUES ($1, $2, $3, now())
          ON CONFLICT (doc_id) DO UPDATE SET
            integration_type = EXCLUDED.integration_type,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          "#,
        )
        .bind(doc_id)
        .bind(patch.integration_type.clone().flatten())
        .bind(actor_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
      }
    }

    if let Some(audience_ids) = &patch.audience_ids {
      sqlx::query("DELETE FROM doc_audience_assignment WHERE doc_id = $1")
        .bind(doc_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
      for audience_id in audience_ids {
        sqlx::query(
          "INSERT INTO doc_audience_assignment (doc_id, audience_id, source, assigned_by) VALUES ($1, $2, 'document', $3)",
        )
        .bind(doc_id)
        .bind(audience_id)
        .bind(actor_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
      }
      let result = sqlx::query(
        "UPDATE docs \
         SET audience_source = 'document', \
             metadata_revision = CASE WHEN $3::boolean THEN metadata_revision ELSE metadata_revision + 1 END, \
             metadata_updated_at = now(), metadata_updated_by = $2 \
         WHERE id = $1 AND workspace_id IS NOT NULL AND deleted_at IS NULL",
      )
      .bind(doc_id)
      .bind(actor_id)
      .bind(has_document_field_patch)
      .execute(&mut *tx)
      .await
      .map_err(db_error)?;
      if result.rows_affected() == 0 {
        return Err(RepositoryError::NotFound("document metadata"));
      }
    }

    // The projection revision also includes content-owned system facts. This
    // native metadata transaction stamps only its own real changes, atomically
    // with the revision; repeated/no-op patches must not invent freshness.
    sqlx::query(
      "UPDATE docs SET metadata_updated_at = now(), metadata_updated_by = $2 WHERE id = $1 AND metadata_revision <> $3",
    )
    .bind(doc_id)
    .bind(actor_id)
    .bind(current_revision)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;

    tx.commit().await.map_err(db_error)?;
    Ok(())
  }

  #[instrument(skip(self), fields(%workspace_id, actor_id = ?actor_id), err)]
  async fn rematerialize_workspace_defaults(
    &self,
    workspace_id: Uuid,
    actor_id: Option<Uuid>,
  ) -> RepoResult<DocumentMetadataMaterializationSummary> {
    let row = sqlx::query(
      r#"
      SELECT scanned_count, changed_count, materialized_count
      FROM document_metadata_rematerialize_workspace_defaults($1, $2)
      "#,
    )
    .bind(workspace_id)
    .bind(actor_id)
    .fetch_one(&self.pool)
    .await
    .map_err(db_error)?;

    Ok(DocumentMetadataMaterializationSummary {
      scanned_count: row.get("scanned_count"),
      changed_count: row.get("changed_count"),
      materialized_count: row.get("materialized_count"),
    })
  }

  #[instrument(skip(self), fields(%doc_id, %version_id, %actor_id), err)]
  async fn mark_current_version(
    &self,
    doc_id: Uuid,
    version_id: Uuid,
    versioned_at: chrono::DateTime<chrono::Utc>,
    actor_id: Uuid,
  ) -> RepoResult<()> {
    let mut conn = self.pool.acquire().await.map_err(db_error)?;
    Self::mark_current_version_in_tx(&mut conn, doc_id, version_id, versioned_at, actor_id).await
  }

  #[instrument(skip(self), fields(%doc_id, %status_id, %actor_id), err)]
  async fn transition_status(&self, doc_id: Uuid, status_id: Uuid, actor_id: Uuid) -> RepoResult<()> {
    let result = sqlx::query(
      r#"
      UPDATE docs
      SET status_id = $2,
          status_source = 'document',
          metadata_updated_at = CASE WHEN status_id IS DISTINCT FROM $2
            OR status_source IS DISTINCT FROM 'document' THEN now() ELSE metadata_updated_at END,
          metadata_updated_by = $3
      WHERE id = $1
        AND workspace_id IS NOT NULL
        AND deleted_at IS NULL
      "#,
    )
    .bind(doc_id)
    .bind(status_id)
    .bind(actor_id)
    .execute(&self.pool)
    .await
    .map_err(db_error)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("document metadata"));
    }
    Ok(())
  }
}
