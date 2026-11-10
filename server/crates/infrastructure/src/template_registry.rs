//! SQLx-backed Template Registry store implementation.
//!
//! [`SqlxTemplateRegistryStore`] implements
//! [`TemplateRegistryStore`]
//! against PostgreSQL via the `sqlx` crate.

use async_trait::async_trait;
use sqlx::{PgPool, Postgres, QueryBuilder, Row, Transaction, types::Json};
use tracing::{debug, error, instrument, trace};
use uuid::Uuid;

mod contextual;
mod library;

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::template_registry::{
  ReleasedBuiltinInstance, RetiringTemplateSource, ShippedTemplateSelection, ShippedTemplateSelectionReport,
  TemplateRegistryAuditEventFilter, TemplateRegistryStore, shipped_default_provisioning_mode,
};
use myoxus_domain::entities::DocumentMetadataPatch;
use myoxus_domain::ids::{DocId, UserId, WorkspaceId};
use myoxus_domain::repositories::DocumentMetadataRepository;
use myoxus_domain::template_registry::*;

// ─── DB ↔ Rust Enum Helpers ──────────────────────────────────────────────────
//
// The database stores enum values as lowercase snake_case strings (see migration
// 0048), while the Rust `Display` impls use PascalCase.  These helpers convert
// in both directions so the store layer is the only place that needs to know.
macro_rules! db_enum_mapping {
  ($to_fn:ident, $from_fn:ident, $ty:ty, $name:literal, { $($variant:path => $db:literal),+ $(,)? }) => {
    fn $to_fn(value: $ty) -> &'static str {
      match value {
        $($variant => $db),+
      }
    }

    fn $from_fn(raw: &str) -> AuthResult<$ty> {
      match raw {
        $($db => Ok($variant),)+
        _ => Err(AuthError::Storage(format!("invalid {} value: {}", $name, raw))),
      }
    }
  };
  ($to_fn:ident, $from_fn:ident, $ty:ty, $name:literal, { $($variant:path => $db:literal),+ $(,)? }, aliases { $($alias:literal => $alias_variant:path),+ $(,)? }) => {
    fn $to_fn(value: $ty) -> &'static str {
      match value {
        $($variant => $db),+
      }
    }

    fn $from_fn(raw: &str) -> AuthResult<$ty> {
      match raw {
        $($db => Ok($variant),)+
        $($alias => Ok($alias_variant),)+
        _ => Err(AuthError::Storage(format!("invalid {} value: {}", $name, raw))),
      }
    }
  };
}

db_enum_mapping!(
  template_source_to_db,
  template_source_from_db,
  TemplateSource,
  "template_source",
  {
    TemplateSource::Bundle => "bundle",
    TemplateSource::Builtin => "builtin",
  }
);

db_enum_mapping!(
  template_status_to_db,
  template_status_from_db,
  TemplateStatus,
  "template_status",
  {
    TemplateStatus::Active => "active",
    TemplateStatus::Disabled => "disabled",
    TemplateStatus::Archived => "archived",
  }
);

db_enum_mapping!(
  revision_state_to_db,
  revision_state_from_db,
  RevisionState,
  "revision_state",
  {
    RevisionState::Draft => "draft",
    RevisionState::Validated => "validated",
    RevisionState::Published => "published",
    RevisionState::Deprecated => "deprecated",
    RevisionState::Archived => "archived",
  }
);

db_enum_mapping!(
  selection_mode_to_db,
  selection_mode_from_db,
  SelectionMode,
  "selection_mode",
  {
    SelectionMode::Published => "published",
    SelectionMode::PinnedRevision => "pinned_revision",
  }
);

db_enum_mapping!(
  provisioning_mode_to_db,
  provisioning_mode_from_db,
  ProvisioningMode,
  "provisioning_mode",
  {
    ProvisioningMode::SeedOnce => "seed_once",
    ProvisioningMode::ManagedUntilLocalEdit => "managed_until_local_edit",
    ProvisioningMode::ManualUpdate => "manual_update",
  }
);

db_enum_mapping!(
  instance_state_to_db,
  instance_state_from_db,
  InstanceState,
  "instance_state",
  {
    InstanceState::Ok => "ok",
    InstanceState::UpdateAvailable => "update_available",
    InstanceState::Detached => "detached",
    InstanceState::Retired => "retired",
    InstanceState::Error => "error",
  }
);

db_enum_mapping!(
  reconcile_scope_to_db,
  reconcile_scope_from_db,
  ReconcileScope,
  "reconcile_scope",
  {
    ReconcileScope::Workspace => "workspace",
    ReconcileScope::Template => "template",
    ReconcileScope::Global => "global",
  }
);

db_enum_mapping!(
  job_state_to_db,
  job_state_from_db,
  JobState,
  "job_state",
  {
    JobState::Pending => "pending",
    JobState::Running => "running",
    JobState::Completed => "completed",
    JobState::Failed => "failed",
    JobState::Cancelled => "cancelled",
  },
  aliases {
    "validating" => JobState::Running,
    "importing" => JobState::Running,
  }
);

db_enum_mapping!(
  audit_action_to_db,
  audit_action_from_db,
  TemplateRegistryAuditAction,
  "audit_action",
  {
    TemplateRegistryAuditAction::Created => "created",
    TemplateRegistryAuditAction::Updated => "updated",
    TemplateRegistryAuditAction::Deleted => "deleted",
    TemplateRegistryAuditAction::Imported => "imported",
    TemplateRegistryAuditAction::Validated => "validated",
    TemplateRegistryAuditAction::Published => "published",
    TemplateRegistryAuditAction::Assigned => "assigned",
    TemplateRegistryAuditAction::Reconciled => "reconciled",
    TemplateRegistryAuditAction::Scanned => "scanned",
    TemplateRegistryAuditAction::Detached => "detached",
    TemplateRegistryAuditAction::Exported => "exported",
    TemplateRegistryAuditAction::Failed => "failed",
  }
);

// ─── Store ───────────────────────────────────────────────────────────────────

/// PostgreSQL-backed implementation of [`TemplateRegistryStore`].
pub struct SqlxTemplateRegistryStore {
  pool: PgPool,
}

/// Lock and reject an ordinary destructive write against a currently managed
/// Registry source. The document row must already be locked by the caller.
/// Registry instance writers lock that same row before publishing a binding,
/// so an assignment cannot race between this lookup and the protected write.
pub(crate) async fn reject_managed_source_write(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: uuid::Uuid,
  doc_id: uuid::Uuid,
) -> AuthResult<()> {
  let assignment = sqlx::query_scalar::<_, uuid::Uuid>(
    r#"
    SELECT i.id
    FROM workspace_template_instances i
    LEFT JOIN template_revisions r ON r.id = i.revision_id
    JOIN workspace_template_policies p
      ON p.workspace_id = i.workspace_id
     AND p.template_id = i.template_id
    WHERE i.workspace_id = $1
      AND i.workspace_doc_id = $2
      AND i.state <> 'retired'
      AND i.retired_at IS NULL
      AND p.is_enabled = TRUE
      AND p.provisioning_mode <> 'seed_once'
      AND COALESCE(r.manifest_json->>'purpose', 'template') <> 'guide'
    LIMIT 1
    FOR UPDATE OF i, p
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(SqlxTemplateRegistryStore::map_db_err)?;
  if assignment.is_some() {
    return Err(AuthError::InvalidInput(
      myoxus_application::doc::ASSIGNED_TEMPLATE_SOURCE_PROTECTED.to_string(),
    ));
  }
  Ok(())
}

async fn lock_instance_document(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: WorkspaceId,
  doc_id: Option<DocId>,
) -> AuthResult<()> {
  let Some(doc_id) = doc_id else {
    return Ok(());
  };
  let exists = sqlx::query_scalar::<_, i32>(
    "SELECT 1 FROM docs WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(SqlxTemplateRegistryStore::map_db_err)?;
  if exists.is_none() {
    return Err(AuthError::NotFound("template source document".to_string()));
  }
  Ok(())
}

impl SqlxTemplateRegistryStore {
  /// Share the native bounded projection with pre-migration read-only CLI
  /// snapshots; all queried Workspace columns already exist at baseline 1000.
  pub async fn release_workspace_ids_in(
    connection: &mut sqlx::PgConnection,
    after: Option<WorkspaceId>,
    limit: usize,
  ) -> AuthResult<Vec<WorkspaceId>> {
    sqlx::query_scalar("SELECT id FROM workspaces WHERE deleted_at IS NULL AND lifecycle_state='active' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2")
      .bind(after).bind(limit.clamp(1,100) as i64).fetch_all(connection).await.map_err(Self::map_db_err)
  }

  async fn released_builtin_rows(
    connection: &mut sqlx::PgConnection,
    template_id: Uuid,
    selected: Option<&[Uuid]>,
  ) -> AuthResult<Vec<ReleasedBuiltinInstance>> {
    let query =
      "SELECT i.id, i.workspace_id, i.workspace_doc_id, i.workspace_doc_key,
      i.state, i.revision_id, i.last_applied_hash, i.expected_hash, i.locale_hash,
      d.id AS resolved_doc_id, COALESCE(d.external_id,d.id::text) AS resolved_doc_key,
      (d.id IS NOT NULL AND d.deleted_at IS NULL) AS source_available,
       n.state AS native_state, n.template_id AS native_template_id, n.instance_id AS native_instance_id,
       p.selection_mode,p.selected_revision_id
       FROM workspace_template_instances i
       LEFT JOIN workspace_template_policies p ON p.workspace_id=i.workspace_id AND p.template_id=i.template_id
      LEFT JOIN LATERAL (
        SELECT candidate.* FROM docs candidate
        WHERE candidate.workspace_id=i.workspace_id AND NOT candidate.is_workspace_root
          AND ((i.workspace_doc_id IS NOT NULL AND candidate.id=i.workspace_doc_id)
            OR (i.workspace_doc_id IS NULL AND (candidate.external_id=i.workspace_doc_key OR candidate.id::text=i.workspace_doc_key)))
        ORDER BY (candidate.external_id=i.workspace_doc_key) DESC NULLS LAST LIMIT 1
      ) d ON TRUE
      LEFT JOIN document_template_state n ON n.doc_id=d.id
        WHERE i.template_id=$1 AND ($2::uuid[] IS NULL OR i.id=ANY($2)) ORDER BY i.id";
    sqlx::query(query)
      .bind(template_id)
      .bind(selected)
      .fetch_all(connection)
      .await
      .map_err(Self::map_db_err)?
      .into_iter()
      .map(|row| {
        Ok(ReleasedBuiltinInstance {
          id: row.get("id"),
          workspace_id: row.get("workspace_id"),
          workspace_doc_id: row.get("workspace_doc_id"),
          workspace_doc_key: row.get("workspace_doc_key"),
          resolved_doc_id: row.get("resolved_doc_id"),
          resolved_doc_key: row.get("resolved_doc_key"),
          state: instance_state_from_db(row.get("state"))?,
          revision_id: row.get("revision_id"),
          last_applied_hash: row.get("last_applied_hash"),
          expected_hash: row.get("expected_hash"),
          locale: row.get("locale_hash"),
          source_available: row.get("source_available"),
          native_template_state: row.get("native_state"),
          native_template_id: row.get("native_template_id"),
          native_instance_id: row.get("native_instance_id"),
          selection_mode: row
            .get::<Option<String>, _>("selection_mode")
            .map(|mode| selection_mode_from_db(&mode))
            .transpose()?,
          selected_revision_id: row.get("selected_revision_id"),
        })
      })
      .collect()
  }

  /// Retain the Registry's own catalog/revision lock order through opt-in,
  /// admission and native publication. A source cannot change after validation.
  pub(crate) async fn lock_automation_source_in_tx(
    tx: &mut sqlx::PgConnection,
    source: &myoxus_domain::workspace_automation::AutomationDocumentSourceSetup,
    client_version: u32,
    fresh: bool,
  ) -> AuthResult<()> {
    let catalog: Uuid = sqlx::query_scalar("SELECT template_id FROM template_revisions WHERE id=$1")
      .bind(source.source_revision_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or_else(|| AuthError::NotFound("automation document source".into()))?;
    let entry = sqlx::query("SELECT * FROM template_catalog_entries WHERE id=$1 FOR SHARE")
      .bind(catalog)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let revision = sqlx::query("SELECT * FROM template_revisions WHERE id=$1 AND template_id=$2 FOR SHARE")
      .bind(source.source_revision_id)
      .bind(catalog)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let entry = Self::map_catalog_entry_row(entry)?;
    let revision = Self::map_revision_row(revision)?;
    myoxus_application::template_registry::validate_accepted_document_source(
      &entry,
      &revision,
      &source.source,
      &source.source_revision_digest,
      client_version,
    )?;
    if fresh && revision.state != RevisionState::Published {
      return Err(AuthError::InvalidInput(
        "new automation requires a published source".into(),
      ));
    }
    Ok(())
  }

  /// Construct a `SqlxTemplateRegistryStore` from an existing connection pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> AuthError {
    error!(error = %err, "database error in template registry store");
    AuthError::Storage(err.to_string())
  }

  // ── Row Mappers ──────────────────────────────────────────────────────

  fn map_catalog_entry_row(row: sqlx::postgres::PgRow) -> AuthResult<TemplateCatalogEntry> {
    Ok(TemplateCatalogEntry {
      id: row.get("id"),
      slug: row.get("slug"),
      title: row.get("title"),
      description: {
        let v: String = row.get("description");
        if v.is_empty() { None } else { Some(v) }
      },
      category: {
        let v: String = row.get("category");
        if v == "general" { None } else { Some(v) }
      },
      tags: row.get("tags"),
      status: template_status_from_db(&row.get::<String, _>("status"))?,
      source: template_source_from_db(&row.get::<String, _>("source"))?,
      builder_version: row.get::<Option<i32>, _>("builder_version").map(|v| v as u32),
      min_client_version: row.get::<i32, _>("min_client_version") as u32,
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
      archived_at: row.get("archived_at"),
    })
  }

  fn map_audit_event_row(row: sqlx::postgres::PgRow) -> AuthResult<TemplateRegistryAuditEvent> {
    Ok(TemplateRegistryAuditEvent {
      id: row.get("id"),
      action: audit_action_from_db(&row.get::<String, _>("action"))?,
      event_type: row.get("event_type"),
      actor_user_id: row.get("actor_user_id"),
      template_id: row.get("template_id"),
      revision_id: row.get("revision_id"),
      workspace_id: row.get("workspace_id"),
      policy_id: row.get("policy_id"),
      instance_id: row.get("instance_id"),
      import_job_id: row.get("import_job_id"),
      source_format: row.get("source_format"),
      detected_format: row.get("detected_format"),
      normalizer_version: row.get("normalizer_version"),
      ignored_entries_count: row
        .get::<Option<i32>, _>("ignored_entries_count")
        .map(|value| value as u32),
      error_catalog_version: row.get("error_catalog_version"),
      error_code: row.get("error_code"),
      payload_json: row
        .get::<Option<Json<serde_json::Value>>, _>("payload_json")
        .map(|json| json.0),
      created_at: row.get("created_at"),
    })
  }

  fn map_revision_row(row: sqlx::postgres::PgRow) -> AuthResult<TemplateRevision> {
    Ok(TemplateRevision {
      id: row.get("id"),
      template_id: row.get("template_id"),
      version: row.get("version"),
      state: revision_state_from_db(&row.get::<String, _>("state"))?,
      bundle_blob_id: row.get("bundle_blob_id"),
      preview_blob_id: row.get("preview_blob_id"),
      checksum: row.get("checksum"),
      manifest: {
        let v: serde_json::Value = row.get("manifest_json");
        if v.is_null() || v == serde_json::Value::Object(Default::default()) {
          None
        } else {
          Some(v)
        }
      },
      release_notes: {
        let v: String = row.get("release_notes");
        if v.is_empty() { None } else { Some(v) }
      },
      created_by: row.get("created_by"),
      created_at: row.get("created_at"),
      published_at: row.get("published_at"),
      source_format: row.get("source_format"),
      normalizer_version: row.get("normalizer_version"),
      detected_format: row.get("detected_format"),
      ignored_entries_count: row.get::<i32, _>("ignored_entries_count") as u32,
      error_catalog_version: row.get("error_catalog_version"),
      normalization_warnings: row
        .get::<Json<Vec<NormalizationWarning>>, _>("normalization_warnings_json")
        .0,
    })
  }

  fn map_policy_row(row: sqlx::postgres::PgRow) -> AuthResult<WorkspaceTemplatePolicy> {
    Ok(WorkspaceTemplatePolicy {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      template_id: row.get("template_id"),
      selection_mode: selection_mode_from_db(&row.get::<String, _>("selection_mode"))?,
      selected_revision_id: row.get("selected_revision_id"),
      provisioning_mode: provisioning_mode_from_db(&row.get::<String, _>("provisioning_mode"))?,
      is_enabled: row.get("is_enabled"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    })
  }

  fn map_instance_row(row: sqlx::postgres::PgRow) -> AuthResult<WorkspaceTemplateInstance> {
    let revision_id = row
      .get::<Option<_>, _>("revision_id")
      .ok_or_else(|| AuthError::Storage("revision-backed template instance has NULL revision_id".to_string()))?;

    Ok(WorkspaceTemplateInstance {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      template_id: row.get("template_id"),
      revision_id,
      workspace_doc_id: row.get("workspace_doc_id"),
      workspace_doc_key: row.get("workspace_doc_key"),
      state: instance_state_from_db(&row.get::<String, _>("state"))?,
      last_applied_hash: row.get("last_applied_hash"),
      current_hash: row.get("current_hash"),
      last_synced_at: row.get("last_synced_at"),
      detached_at: row.get("detached_at"),
      retired_at: row.get("retired_at"),
      last_error_code: row.get("last_error_code"),
      last_error_message: row.get("last_error_message"),
      expected_hash: row.get("expected_hash"),
      locale_hash: row.get("locale_hash"),
    })
  }

  fn map_default_policy_row(row: sqlx::postgres::PgRow) -> AuthResult<TemplateDefaultPolicy> {
    Ok(TemplateDefaultPolicy {
      template_id: row.get("template_id"),
      apply_to_new_workspaces: row.get("apply_to_new_workspaces"),
      selection_mode: selection_mode_from_db(&row.get::<String, _>("selection_mode"))?,
      provisioning_mode: provisioning_mode_from_db(&row.get::<String, _>("provisioning_mode"))?,
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    })
  }

  fn map_import_job_row(row: sqlx::postgres::PgRow) -> AuthResult<TemplateImportJob> {
    Ok(TemplateImportJob {
      id: row.get("id"),
      uploaded_blob_id: row.get("uploaded_blob_id"),
      result_revision_id: row.get("result_revision_id"),
      state: job_state_from_db(&row.get::<String, _>("state"))?,
      validation_report: row.get("validation_report_json"),
      created_by: row.get("created_by"),
      started_at: row.get("started_at"),
      finished_at: row.get("finished_at"),
    })
  }

  fn map_reconcile_job_row(row: sqlx::postgres::PgRow) -> AuthResult<TemplateReconcileJob> {
    Ok(TemplateReconcileJob {
      id: row.get("id"),
      scope: reconcile_scope_from_db(&row.get::<String, _>("scope"))?,
      workspace_id: row.get("workspace_id"),
      template_id: row.get("template_id"),
      state: job_state_from_db(&row.get::<String, _>("state"))?,
      summary: row.get("summary_json"),
      started_at: row.get("started_at"),
      finished_at: row.get("finished_at"),
    })
  }

  fn append_audit_event_filters<'a>(
    query: &mut QueryBuilder<'a, Postgres>,
    filter: &'a TemplateRegistryAuditEventFilter,
  ) {
    if let Some(action) = filter.action {
      query.push(" AND a.action = ");
      query.push_bind(audit_action_to_db(action));
    }
    if let Some(event_type) = filter.event_type.as_ref() {
      query.push(" AND a.event_type = ");
      query.push_bind(event_type);
    }
    if let Some(actor_user_id) = filter.actor_user_id {
      query.push(" AND a.actor_user_id = ");
      query.push_bind(actor_user_id);
    }
    if let Some(template_id) = filter.template_id {
      query.push(" AND a.template_id = ");
      query.push_bind(template_id);
    }
    if let Some(revision_id) = filter.revision_id {
      query.push(" AND a.revision_id = ");
      query.push_bind(revision_id);
    }
    if let Some(workspace_id) = filter.workspace_id {
      query.push(" AND a.workspace_id = ");
      query.push_bind(workspace_id);
    }
    if let Some(policy_id) = filter.policy_id {
      query.push(" AND a.policy_id = ");
      query.push_bind(policy_id);
    }
    if let Some(instance_id) = filter.instance_id {
      query.push(" AND a.instance_id = ");
      query.push_bind(instance_id);
    }
    if let Some(import_job_id) = filter.import_job_id {
      query.push(" AND a.import_job_id = ");
      query.push_bind(import_job_id);
    }
    if let Some(source_format) = filter.source_format.as_ref() {
      query.push(" AND a.source_format = ");
      query.push_bind(source_format);
    }
    if let Some(detected_format) = filter.detected_format.as_ref() {
      query.push(" AND a.detected_format = ");
      query.push_bind(detected_format);
    }
    if let Some(normalizer_version) = filter.normalizer_version.as_ref() {
      query.push(" AND a.normalizer_version = ");
      query.push_bind(normalizer_version);
    }
    if let Some(ignored_entries_count) = filter.ignored_entries_count {
      query.push(" AND a.ignored_entries_count = ");
      query.push_bind(ignored_entries_count as i32);
    }
    if let Some(error_catalog_version) = filter.error_catalog_version.as_ref() {
      query.push(" AND a.error_catalog_version = ");
      query.push_bind(error_catalog_version);
    }
    if let Some(error_code) = filter.error_code.as_ref() {
      query.push(" AND a.error_code = ");
      query.push_bind(error_code);
    }
    if let Some(created_after) = filter.created_after {
      query.push(" AND a.created_at >= ");
      query.push_bind(created_after);
    }
    if let Some(created_before) = filter.created_before {
      query.push(" AND a.created_at <= ");
      query.push_bind(created_before);
    }
  }
}

// ─── TemplateRegistryStore impl ──────────────────────────────────────────────

#[async_trait]
impl TemplateRegistryStore for SqlxTemplateRegistryStore {
  async fn contextual_template_page(
    &self,
    query: &myoxus_application::template_registry::suggestions::ContextualTemplateQuery,
  ) -> AuthResult<myoxus_application::template_registry::suggestions::ContextualTemplatePage> {
    self.read_contextual_template_page(query).await
  }
  async fn contextual_guide_deliveries(
    &self,
    workspace: WorkspaceId,
  ) -> AuthResult<Vec<myoxus_application::template_registry::suggestions::ContextualGuideDelivery>> {
    self.read_contextual_guide_deliveries(workspace).await
  }
  async fn contextual_page_default_replacements(
    &self,
    workspace: WorkspaceId,
  ) -> AuthResult<Vec<myoxus_application::template_registry::TemplatePageDefaultReplacement>> {
    self.read_contextual_page_default_replacements(workspace).await
  }
  async fn library_sources(
    &self,
    query: &myoxus_application::template_registry::suggestions::TemplateLibraryQuery,
  ) -> AuthResult<Vec<myoxus_application::template_registry::suggestions::TemplateLibrarySource>> {
    self.read_library_sources(query).await
  }
  async fn commit_revision_publication(&self, revision_id: TemplateRevisionId) -> AuthResult<TemplateRevision> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let template_id: Option<Uuid> = sqlx::query_scalar("SELECT template_id FROM template_revisions WHERE id=$1")
      .bind(revision_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let template_id = template_id.ok_or_else(|| AuthError::NotFound("revision".into()))?;
    sqlx::query("SELECT id FROM template_catalog_entries WHERE id=$1 FOR NO KEY UPDATE")
      .bind(template_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let row = sqlx::query("SELECT * FROM template_revisions WHERE id=$1 FOR UPDATE")
      .bind(revision_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let mut revision = Self::map_revision_row(row)?;
    revision
      .publish()
      .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
    sqlx::query("UPDATE template_revisions SET state='deprecated' WHERE template_id=$1 AND state='published'")
      .bind(template_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query(
      "UPDATE template_revisions SET state='published',published_at=$2,release_managed_publication=false WHERE id=$1",
    )
    .bind(revision_id)
    .bind(revision.published_at)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(revision)
  }

  #[instrument(skip_all)]
  async fn commit_shipped_catalog_selection(
    &self,
    selection: &[ShippedTemplateSelection],
  ) -> AuthResult<ShippedTemplateSelectionReport> {
    use myoxus_application::database::definition::templates::compare_template_versions;
    use std::collections::BTreeSet;
    if selection.len() > 256 {
      return Err(AuthError::InvalidInput("too many document catalog selections".into()));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Complete release selection also owns identities omitted from the archive.
    // Retain their genuine revisions; only standalone publication is withdrawn.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('template-feature-release',0))")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let mut selection = selection.to_vec();
    let selected: Vec<_> = selection.iter().map(|item| item.template_id).collect();
    let omitted: Vec<(Uuid, Vec<Uuid>)> = sqlx::query_as(
      "SELECT c.id,array_agg(r.id ORDER BY r.id) FROM template_catalog_entries c
       JOIN template_revisions r ON r.template_id=c.id AND r.release_managed_publication
         AND r.published_at IS NOT NULL AND r.state IN ('published','deprecated')
       WHERE c.source='bundle' AND NOT(c.id=ANY($1)) GROUP BY c.id ORDER BY c.id",
    )
    .bind(&selected)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    selection.extend(
      omitted
        .into_iter()
        .map(|(template_id, history_revision_ids)| ShippedTemplateSelection {
          template_id,
          current_revision_id: None,
          history_revision_ids,
          new_workspace_default: false,
        }),
    );
    let mut ordered: Vec<_> = selection.iter().collect();
    ordered.sort_by_key(|entry| entry.template_id);
    if ordered
      .windows(2)
      .any(|pair| pair[0].template_id == pair[1].template_id)
    {
      return Err(AuthError::InvalidInput("duplicate document catalog selection".into()));
    }
    // All publication and instance binding owners acquire catalog roots first.
    // Lock the complete batch before revisions so different releases cannot interleave.
    for entry in &ordered {
      sqlx::query("SELECT id FROM template_catalog_entries WHERE id=$1 FOR NO KEY UPDATE")
        .bind(entry.template_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    let mut report = ShippedTemplateSelectionReport::default();
    for entry in ordered {
      let catalog_row = sqlx::query("SELECT * FROM template_catalog_entries WHERE id=$1")
        .bind(entry.template_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      let catalog = Self::map_catalog_entry_row(catalog_row)?;
      let revision_rows = sqlx::query("SELECT * FROM template_revisions WHERE template_id=$1 ORDER BY id FOR UPDATE")
        .bind(entry.template_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      // Publication authority is native SQL metadata, not immutable authorship
      // or a postcommit audit event. Unknown prior publications remain protected.
      let release_publications: BTreeSet<Uuid> = revision_rows
        .iter()
        .filter(|row| row.get::<bool, _>("release_managed_publication"))
        .map(|row| row.get("id"))
        .collect();
      let revisions = revision_rows
        .into_iter()
        .map(Self::map_revision_row)
        .collect::<AuthResult<Vec<_>>>()?;
      let ids: BTreeSet<_> = entry
        .history_revision_ids
        .iter()
        .copied()
        .chain(entry.current_revision_id)
        .collect();
      if ids.len() > 256
        || ids.len() != entry.history_revision_ids.len() + usize::from(entry.current_revision_id.is_some())
      {
        return Err(AuthError::InvalidInput(
          "duplicate or excessive document revision selection".into(),
        ));
      }
      for id in &ids {
        let revision = revisions
          .iter()
          .find(|revision| revision.id == *id)
          .ok_or_else(|| AuthError::InvalidInput("release revision changed owner".into()))?;
        if revision.created_by.is_some()
          || revision.bundle_blob_id.is_none()
          || revision.checksum.is_none()
          || !matches!(
            revision.state,
            RevisionState::Validated | RevisionState::Published | RevisionState::Deprecated
          )
        {
          return Err(AuthError::InvalidInput(
            "release requires genuine validated content revisions".into(),
          ));
        }
      }
      if catalog.source == TemplateSource::Builtin {
        let bound: bool = sqlx::query_scalar(
          "SELECT EXISTS(SELECT 1 FROM workspace_template_instances WHERE template_id=$1 AND revision_id IS NULL)",
        )
        .bind(entry.template_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        if bound {
          return Err(AuthError::InvalidInput(
            "unsupported unmigrated NULL-revision source binding; current selection cannot adopt legacy identities"
              .into(),
          ));
        }
        sqlx::query(
          "UPDATE template_catalog_entries SET source='bundle',builder_version=NULL,updated_at=now() WHERE id=$1",
        )
        .bind(entry.template_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      }
      let published: Vec<_> = revisions
        .iter()
        .filter(|revision| revision.state == RevisionState::Published)
        .collect();
      let operator_current = published
        .iter()
        .any(|revision| !release_publications.contains(&revision.id));
      if let Some(target_id) = entry.current_revision_id {
        let target = revisions
          .iter()
          .find(|revision| revision.id == target_id)
          .expect("validated selection");
        // Only release-owned publications remain downgrade evidence after
        // retirement. Neither staged history nor operator versions define it.
        for previous in revisions
          .iter()
          .filter(|revision| release_publications.contains(&revision.id) && revision.published_at.is_some())
        {
          if compare_template_versions(&target.version, &previous.version).map_err(AuthError::InvalidInput)?
            == std::cmp::Ordering::Less
          {
            return Err(AuthError::InvalidInput(
              "document release current cannot downgrade".into(),
            ));
          }
        }
        if operator_current {
          sqlx::query("UPDATE template_revisions SET state='deprecated' WHERE template_id=$1 AND release_managed_publication AND state='published'")
            .bind(entry.template_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
          sqlx::query(
            "UPDATE template_revisions SET state='deprecated' WHERE id=$1 AND created_by IS NULL AND state='validated'",
          )
          .bind(target_id)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
          report.operator_current_preserved.push(entry.template_id);
        } else {
          sqlx::query("UPDATE template_revisions SET state='deprecated' WHERE template_id=$1 AND state='published' AND id<>$2 AND release_managed_publication")
            .bind(entry.template_id).bind(target_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
          sqlx::query(
            "UPDATE template_revisions SET state='published',published_at=COALESCE(published_at,now()),release_managed_publication=true WHERE id=$1",
          )
          .bind(target_id)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
          report.current.push(entry.template_id);
        }
      } else {
        // An older node cannot retire a newer server current by presenting only
        // its old retained history. Compare against every captured version.
        for previous in revisions
          .iter()
          .filter(|revision| release_publications.contains(&revision.id) && revision.published_at.is_some())
        {
          let mut covered = false;
          for historical in revisions.iter().filter(|revision| ids.contains(&revision.id)) {
            if compare_template_versions(&historical.version, &previous.version).map_err(AuthError::InvalidInput)?
              != std::cmp::Ordering::Less
            {
              covered = true;
            }
          }
          if !covered {
            return Err(AuthError::InvalidInput(
              "document retirement cannot discard newer current".into(),
            ));
          }
        }
        sqlx::query("UPDATE template_revisions SET state='deprecated' WHERE template_id=$1 AND state='published' AND release_managed_publication")
          .bind(entry.template_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
        if operator_current {
          report.operator_current_preserved.push(entry.template_id);
        }
      }
      if entry.current_revision_id.is_some() && entry.new_workspace_default {
        if catalog.status == TemplateStatus::Active && !operator_current {
          let revision = revisions
            .iter()
            .find(|revision| Some(revision.id) == entry.current_revision_id)
            .expect("validated current selection");
          sqlx::query("INSERT INTO template_default_policies(template_id,apply_to_new_workspaces,selection_mode,provisioning_mode,release_managed,created_at,updated_at) VALUES($1,true,'published',$2,true,now(),now()) ON CONFLICT(template_id) DO UPDATE SET apply_to_new_workspaces=true,updated_at=CASE WHEN NOT template_default_policies.apply_to_new_workspaces THEN now() ELSE template_default_policies.updated_at END WHERE template_default_policies.release_managed")
            .bind(entry.template_id).bind(provisioning_mode_to_db(shipped_default_provisioning_mode(revision)))
            .execute(&mut *tx).await.map_err(Self::map_db_err)?;
        }
      } else {
        // Only rows explicitly created by release publication follow authored
        // default changes. Existing/edited operator rows are never adopted.
        sqlx::query("UPDATE template_default_policies SET apply_to_new_workspaces=false,updated_at=CASE WHEN apply_to_new_workspaces THEN now() ELSE updated_at END WHERE template_id=$1 AND release_managed")
          .bind(entry.template_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      }
      if catalog.status == TemplateStatus::Active
        && !operator_current
        && let Some(revision) = revisions
          .iter()
          .find(|revision| Some(revision.id) == entry.current_revision_id)
      {
        let mode = provisioning_mode_to_db(shipped_default_provisioning_mode(revision));
        // Only positive release ownership authorizes correcting old defaults.
        // Turning the authored new-workspace flag off does not freeze an active
        // export's existing source assignments.
        sqlx::query("UPDATE template_default_policies SET provisioning_mode=$2,updated_at=now() WHERE template_id=$1 AND release_managed AND selection_mode='published' AND provisioning_mode IN ('seed_once','managed_until_local_edit') AND provisioning_mode<>$2")
          .bind(entry.template_id).bind(mode).execute(&mut *tx).await.map_err(Self::map_db_err)?;
        // Metadata/lifecycle writes lock the document before inspecting policy.
        // Take that same lock before reading native attribution below, so a
        // concurrent unmark cannot be reclaimed from a stale metadata snapshot.
        sqlx::query_scalar::<_, Uuid>(
          r#"
          SELECT d.id FROM workspace_template_policies p
          JOIN template_default_policies dp ON dp.template_id=p.template_id AND dp.release_managed
          JOIN workspace_template_instances i ON i.workspace_id=p.workspace_id AND i.template_id=p.template_id
          JOIN docs d ON d.id=i.workspace_doc_id AND d.workspace_id=i.workspace_id
          WHERE p.template_id=$1 AND p.is_enabled AND p.selection_mode='published'
            AND p.selected_revision_id IS NULL AND p.provisioning_mode='seed_once'
            AND $2='managed_until_local_edit'
          ORDER BY d.id FOR UPDATE OF d
        "#,
        )
        .bind(entry.template_id)
        .bind(mode)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        sqlx::query(r#"
          UPDATE workspace_template_policies p SET provisioning_mode=$2,updated_at=now()
          FROM template_default_policies dp
          WHERE p.template_id=$1 AND dp.template_id=p.template_id AND dp.release_managed
            AND p.is_enabled AND p.selection_mode='published' AND p.selected_revision_id IS NULL
            AND p.provisioning_mode='seed_once' AND $2='managed_until_local_edit'
            AND (
              NOT EXISTS (SELECT 1 FROM workspace_template_instances i WHERE i.workspace_id=p.workspace_id AND i.template_id=p.template_id)
              OR EXISTS (
                SELECT 1 FROM workspace_template_instances i
                JOIN template_revisions applied ON applied.id=i.revision_id AND applied.template_id=i.template_id
                  AND applied.release_managed_publication
                LEFT JOIN docs d ON d.id=i.workspace_doc_id AND d.workspace_id=i.workspace_id
                  AND d.deleted_at IS NULL AND NOT d.blocked AND NOT d.is_workspace_root
                LEFT JOIN document_template_state native ON native.doc_id=d.id
                WHERE i.workspace_id=p.workspace_id AND i.template_id=p.template_id
                  AND i.retired_at IS NULL AND i.state NOT IN ('retired','detached')
                  AND COALESCE(applied.manifest_json->>'purpose','template')<>'guide'
                  AND (
                    (i.workspace_doc_id IS NULL AND i.workspace_doc_key IS NULL)
                    OR (d.id IS NOT NULL AND native.state IN ('seeded','managed')
                      AND i.last_applied_hash IS NOT NULL
                      AND (i.workspace_doc_key IS NULL OR i.workspace_doc_key=d.external_id OR i.workspace_doc_key=d.id::text)
                      AND (native.template_id IS NULL OR native.template_id=i.template_id)
                      AND (native.instance_id IS NULL OR native.instance_id=i.id)
                      AND (native.revision_id IS NULL OR native.revision_id=i.revision_id))
                  )
              )
            )
        "#).bind(entry.template_id).bind(mode).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      }
      for id in &entry.history_revision_ids {
        // An operator's current revision is never changed by release history.
        sqlx::query(
          "UPDATE template_revisions SET state='deprecated' WHERE id=$1 AND created_by IS NULL AND state='validated'",
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        report.history_revisions += 1;
      }
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(report)
  }

  async fn list_released_builtin_instances(
    &self,
    id: TemplateCatalogEntryId,
  ) -> AuthResult<Vec<ReleasedBuiltinInstance>> {
    Self::released_builtin_rows(&mut *self.pool.acquire().await.map_err(Self::map_db_err)?, id, None).await
  }

  async fn source_attribution(
    &self,
    workspace: WorkspaceId,
    template: TemplateCatalogEntryId,
  ) -> AuthResult<Option<ReleasedBuiltinInstance>> {
    let mut connection = self.pool.acquire().await.map_err(Self::map_db_err)?;
    let id: Option<Uuid> =
      sqlx::query_scalar("SELECT id FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2")
        .bind(workspace)
        .bind(template)
        .fetch_optional(&mut *connection)
        .await
        .map_err(Self::map_db_err)?;
    let Some(id) = id else {
      return Ok(None);
    };
    Ok(
      Self::released_builtin_rows(&mut connection, template, Some(&[id]))
        .await?
        .into_iter()
        .next(),
    )
  }

  async fn release_workspace_ids(&self, after: Option<WorkspaceId>, limit: usize) -> AuthResult<Vec<WorkspaceId>> {
    Self::release_workspace_ids_in(&mut *self.pool.acquire().await.map_err(Self::map_db_err)?, after, limit).await
  }

  async fn release_workspaces_needing_reconcile(
    &self,
    after: Option<WorkspaceId>,
    limit: usize,
  ) -> AuthResult<Vec<WorkspaceId>> {
    sqlx::query_scalar(r#"
      WITH current_release AS (
        SELECT r.template_id,r.id FROM template_revisions r JOIN template_catalog_entries c ON c.id=r.template_id
        WHERE r.state='published' AND r.release_managed_publication AND c.source='bundle' AND c.status='active'
      ), withdrawn AS (
        SELECT c.id FROM template_catalog_entries c WHERE c.source='bundle' AND c.status='active'
          AND EXISTS(SELECT 1 FROM template_revisions r WHERE r.template_id=c.id AND r.release_managed_publication
            AND r.published_at IS NOT NULL AND r.state='deprecated')
          AND NOT EXISTS(SELECT 1 FROM template_revisions r WHERE r.template_id=c.id AND r.state='published')
      ), affected AS (
        SELECT p.workspace_id FROM workspace_template_policies p JOIN current_release r ON r.template_id=p.template_id
        LEFT JOIN workspace_template_instances i ON i.workspace_id=p.workspace_id AND i.template_id=p.template_id
        LEFT JOIN docs d ON d.id=i.workspace_doc_id AND d.workspace_id=i.workspace_id
        WHERE p.is_enabled AND p.selection_mode='published' AND p.selected_revision_id IS NULL
          AND p.provisioning_mode='managed_until_local_edit' AND COALESCE(i.state,'ok') NOT IN ('detached','retired')
          AND (i.id IS NULL OR i.revision_id IS DISTINCT FROM r.id OR d.id IS NULL OR d.deleted_at IS NOT NULL)
        UNION
        SELECT w.id FROM workspaces w JOIN template_default_policies dp ON dp.release_managed AND dp.apply_to_new_workspaces
        JOIN current_release r ON r.template_id=dp.template_id
        WHERE w.initial_content_policy='legacy_defaults' AND dp.selection_mode='published'
          AND dp.provisioning_mode IN ('seed_once','managed_until_local_edit')
          AND NOT EXISTS(SELECT 1 FROM workspace_template_policies p WHERE p.workspace_id=w.id AND p.template_id=dp.template_id)
          AND NOT EXISTS(SELECT 1 FROM workspace_template_instances i WHERE i.workspace_id=w.id AND i.template_id=dp.template_id)
        UNION
        SELECT p.workspace_id FROM workspace_template_policies p JOIN withdrawn c ON c.id=p.template_id
        WHERE p.is_enabled AND p.selection_mode='published' AND p.selected_revision_id IS NULL
          AND (p.provisioning_mode='managed_until_local_edit' OR (p.provisioning_mode='seed_once' AND EXISTS(
            SELECT 1 FROM template_revisions r WHERE r.template_id=p.template_id AND r.release_managed_publication
              AND r.manifest_json->>'purpose'='guide')))
      ) SELECT w.id FROM workspaces w WHERE w.deleted_at IS NULL AND w.lifecycle_state='active'
        AND ($1::uuid IS NULL OR w.id>$1) AND w.id IN (SELECT workspace_id FROM affected)
        AND NOT EXISTS(SELECT 1 FROM template_reconcile_jobs j WHERE j.workspace_id=w.id AND j.scope='workspace'
          AND j.state IN ('pending','running')) ORDER BY w.id LIMIT $2
    "#).bind(after).bind(limit.clamp(1,100) as i64).fetch_all(&self.pool).await.map_err(Self::map_db_err)
  }

  async fn pending_release_default_ids(&self, workspace: WorkspaceId) -> AuthResult<Vec<TemplateCatalogEntryId>> {
    sqlx::query_scalar(r#"
      SELECT dp.template_id FROM template_default_policies dp JOIN template_catalog_entries c ON c.id=dp.template_id
      JOIN workspaces w ON w.id=$1 AND w.initial_content_policy='legacy_defaults' AND w.deleted_at IS NULL AND w.lifecycle_state='active'
      WHERE dp.release_managed AND dp.apply_to_new_workspaces AND dp.selection_mode='published'
        AND dp.provisioning_mode IN ('seed_once','managed_until_local_edit') AND c.source='bundle' AND c.status='active'
        AND EXISTS(SELECT 1 FROM template_revisions r WHERE r.template_id=c.id AND r.state='published' AND r.release_managed_publication)
        AND NOT EXISTS(SELECT 1 FROM workspace_template_policies p WHERE p.workspace_id=w.id AND p.template_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM workspace_template_instances i WHERE i.workspace_id=w.id AND i.template_id=c.id)
      ORDER BY dp.template_id
    "#).bind(workspace).fetch_all(&self.pool).await.map_err(Self::map_db_err)
  }

  async fn withdrawn_release_policy_ids(&self, workspace: WorkspaceId) -> AuthResult<Vec<WorkspaceTemplatePolicyId>> {
    sqlx::query_scalar(
      r#"
      SELECT p.id FROM workspace_template_policies p JOIN template_catalog_entries c ON c.id=p.template_id
      WHERE p.workspace_id=$1 AND p.is_enabled AND p.selection_mode='published' AND p.selected_revision_id IS NULL
        AND c.source='bundle' AND c.status='active'
        AND EXISTS(SELECT 1 FROM template_revisions r WHERE r.template_id=c.id AND r.release_managed_publication
          AND r.published_at IS NOT NULL AND r.state='deprecated')
        AND NOT EXISTS(SELECT 1 FROM template_revisions r WHERE r.template_id=c.id AND r.state='published')
        AND (p.provisioning_mode='managed_until_local_edit' OR (p.provisioning_mode='seed_once' AND EXISTS(
          SELECT 1 FROM template_revisions r WHERE r.template_id=c.id AND r.release_managed_publication
            AND r.manifest_json->>'purpose'='guide')))
      ORDER BY p.id
    "#,
    )
    .bind(workspace)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  // ── Catalog Entries ──────────────────────────────────────────────────

  #[instrument(skip(self, entry), fields(entry_id = %entry.id, slug = %entry.slug))]
  async fn create_catalog_entry(&self, entry: &TemplateCatalogEntry) -> AuthResult<()> {
    sqlx::query(
      r#"
            INSERT INTO template_catalog_entries
                (id, slug, title, description, category, tags, status,
                 source, builder_version, min_client_version,
                 created_at, updated_at, archived_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            "#,
    )
    .bind(entry.id)
    .bind(&entry.slug)
    .bind(&entry.title)
    .bind(entry.description.as_deref().unwrap_or(""))
    .bind(entry.category.as_deref().unwrap_or("general"))
    .bind(&entry.tags)
    .bind(template_status_to_db(entry.status))
    .bind(template_source_to_db(entry.source))
    .bind(entry.builder_version.map(|v| v as i32))
    .bind(entry.min_client_version as i32)
    .bind(entry.created_at)
    .bind(entry.updated_at)
    .bind(entry.archived_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(entry_id = %entry.id, "template catalog entry created");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn delete_catalog_entry(&self, id: TemplateCatalogEntryId) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Acceptance takes the same catalog/revision locks before committing its
    // references. Read pins only after these locks; never lock receipt rows in
    // this reverse direction against acceptance/publication.
    sqlx::query("SELECT id FROM template_catalog_entries WHERE id=$1 FOR UPDATE")
      .bind(id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let revision_ids: Vec<Uuid> =
      sqlx::query_scalar("SELECT id FROM template_revisions WHERE template_id=$1 ORDER BY id FOR UPDATE")
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    for revision in revision_ids {
      if accepted_document_revision_pin(&mut tx, revision).await? {
        return Err(AuthError::InvalidInput(
          "accepted setup or automation retains this document source".into(),
        ));
      }
    }
    // `workspace_template_instances.revision_id` uses ON DELETE RESTRICT.
    // Delete the import-owned instance first so compensation cannot depend on
    // PostgreSQL's cascade scheduling between the instance and its revision.
    sqlx::query("DELETE FROM workspace_template_instances WHERE template_id = $1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query("DELETE FROM template_catalog_entries WHERE id = $1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn get_catalog_entry(&self, id: TemplateCatalogEntryId) -> AuthResult<Option<TemplateCatalogEntry>> {
    let row = sqlx::query(
      r#"
            SELECT id, slug, title, description, category, tags, status,
                   source, builder_version, min_client_version,
                   created_at, updated_at, archived_at
            FROM template_catalog_entries
            WHERE id = $1
            "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_catalog_entry_row).transpose()?;
    trace!(found = result.is_some(), "catalog entry lookup by id");
    Ok(result)
  }

  #[instrument(skip(self))]
  async fn get_catalog_entry_by_slug(&self, slug: &str) -> AuthResult<Option<TemplateCatalogEntry>> {
    let row = sqlx::query(
      r#"
            SELECT id, slug, title, description, category, tags, status,
                   source, builder_version, min_client_version,
                   created_at, updated_at, archived_at
            FROM template_catalog_entries
            WHERE slug = $1
            "#,
    )
    .bind(slug)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_catalog_entry_row).transpose()?;
    trace!(found = result.is_some(), "catalog entry lookup by slug");
    Ok(result)
  }

  #[instrument(skip(self))]
  async fn list_catalog_entries(
    &self,
    status_filter: Option<TemplateStatus>,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<TemplateCatalogEntry>> {
    let rows = match status_filter {
      Some(status) => sqlx::query(
        r#"
                    SELECT id, slug, title, description, category, tags, status,
                           source, builder_version, min_client_version,
                           created_at, updated_at, archived_at
                    FROM template_catalog_entries
                    WHERE status = $1
                    ORDER BY created_at DESC
                    OFFSET $2 LIMIT $3
                    "#,
      )
      .bind(template_status_to_db(status))
      .bind(skip)
      .bind(take)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?,
      None => sqlx::query(
        r#"
                    SELECT id, slug, title, description, category, tags, status,
                           source, builder_version, min_client_version,
                           created_at, updated_at, archived_at
                    FROM template_catalog_entries
                    ORDER BY created_at DESC
                    OFFSET $1 LIMIT $2
                    "#,
      )
      .bind(skip)
      .bind(take)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?,
    };

    let entries: AuthResult<Vec<TemplateCatalogEntry>> = rows.into_iter().map(Self::map_catalog_entry_row).collect();
    let entries = entries?;
    trace!(count = entries.len(), "catalog entries listed");
    Ok(entries)
  }

  #[instrument(skip(self))]
  async fn count_catalog_entries(&self, status_filter: Option<TemplateStatus>) -> AuthResult<i64> {
    let count: i64 = match status_filter {
      Some(status) => sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries WHERE status = $1")
        .bind(template_status_to_db(status))
        .fetch_one(&self.pool)
        .await
        .map_err(Self::map_db_err)?,
      None => sqlx::query_scalar("SELECT COUNT(*) FROM template_catalog_entries")
        .fetch_one(&self.pool)
        .await
        .map_err(Self::map_db_err)?,
    };

    trace!(count, "catalog entries counted");
    Ok(count)
  }

  #[instrument(skip_all, fields(template_id = %id, status = ?status))]
  async fn commit_catalog_transition(
    &self,
    id: TemplateCatalogEntryId,
    status: TemplateStatus,
    allow_already_active: bool,
  ) -> AuthResult<TemplateCatalogEntry> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query("SELECT * FROM template_catalog_entries WHERE id=$1 FOR UPDATE")
      .bind(id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::NotFound("template".into()))?;
    let mut entry = Self::map_catalog_entry_row(row)?;
    myoxus_application::template_registry::apply_catalog_transition(
      &mut entry,
      status,
      allow_already_active,
      chrono::Utc::now(),
    )?;
    let row =
      sqlx::query("UPDATE template_catalog_entries SET status=$2,updated_at=$3,archived_at=$4 WHERE id=$1 RETURNING *")
        .bind(id)
        .bind(template_status_to_db(status))
        .bind(entry.updated_at)
        .bind(entry.archived_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    let entry = Self::map_catalog_entry_row(row)?;
    if status == TemplateStatus::Archived {
      // One policy write belongs to the catalog transaction. Defaults and
      // bindings remain unchanged; enable must not resurrect these policies.
      sqlx::query(
        "UPDATE workspace_template_policies SET is_enabled=false,updated_at=$2 WHERE template_id=$1 AND is_enabled",
      )
      .bind(id)
      .bind(entry.updated_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(entry)
  }

  #[instrument(skip(self, entry), fields(entry_id = %entry.id))]
  async fn update_catalog_entry(&self, entry: &TemplateCatalogEntry) -> AuthResult<()> {
    sqlx::query(
      r#"
            UPDATE template_catalog_entries
            SET slug = $2, title = $3, description = $4, category = $5,
                tags = $6, status = $7,
                builder_version = $8, min_client_version = $9,
                updated_at = $10, archived_at = $11
            WHERE id = $1
            "#,
    )
    .bind(entry.id)
    .bind(&entry.slug)
    .bind(&entry.title)
    .bind(entry.description.as_deref().unwrap_or(""))
    .bind(entry.category.as_deref().unwrap_or("general"))
    .bind(&entry.tags)
    .bind(template_status_to_db(entry.status))
    .bind(entry.builder_version.map(|v| v as i32))
    .bind(entry.min_client_version as i32)
    .bind(entry.updated_at)
    .bind(entry.archived_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(entry_id = %entry.id, "template catalog entry updated");
    Ok(())
  }

  // ── Audit Events ────────────────────────────────────────────────────

  #[instrument(skip(self, event), fields(event_id = %event.id, action = %event.action, event_type = %event.event_type))]
  async fn create_audit_event(&self, event: &TemplateRegistryAuditEvent) -> AuthResult<()> {
    sqlx::query(
      r#"
            INSERT INTO template_registry_audit_events
                (id, action, event_type, actor_user_id, template_id, revision_id,
                 workspace_id, policy_id, instance_id, import_job_id,
                 source_format, detected_format, normalizer_version,
                 ignored_entries_count, error_catalog_version, error_code,
                 payload_json, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            "#,
    )
    .bind(event.id)
    .bind(audit_action_to_db(event.action))
    .bind(&event.event_type)
    .bind(event.actor_user_id)
    .bind(event.template_id)
    .bind(event.revision_id)
    .bind(event.workspace_id)
    .bind(event.policy_id)
    .bind(event.instance_id)
    .bind(event.import_job_id)
    .bind(&event.source_format)
    .bind(&event.detected_format)
    .bind(&event.normalizer_version)
    .bind(event.ignored_entries_count.map(|value| value as i32))
    .bind(&event.error_catalog_version)
    .bind(&event.error_code)
    .bind(event.payload_json.as_ref().map(|value| Json(value.clone())))
    .bind(event.created_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(event_id = %event.id, "template registry audit event created");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn list_audit_events(
    &self,
    filter: Option<TemplateRegistryAuditEventFilter>,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<TemplateRegistryAuditEvent>> {
    let mut query = QueryBuilder::<Postgres>::new(
      "SELECT id, action, event_type, actor_user_id, template_id, revision_id, \
       workspace_id, policy_id, instance_id, import_job_id, source_format, \
       detected_format, normalizer_version, ignored_entries_count, \
       error_catalog_version, error_code, payload_json, created_at \
       FROM template_registry_audit_events a",
    );

    if let Some(filter) = filter.as_ref() {
      query.push(" WHERE 1 = 1");
      Self::append_audit_event_filters(&mut query, filter);
    }

    query.push(" ORDER BY a.created_at DESC, a.id DESC LIMIT ");
    query.push_bind(take.clamp(1, 200));
    query.push(" OFFSET ");
    query.push_bind(skip.max(0));

    let rows = query.build().fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    let events: AuthResult<Vec<TemplateRegistryAuditEvent>> = rows.into_iter().map(Self::map_audit_event_row).collect();
    let events = events?;
    trace!(count = events.len(), "audit events listed");
    Ok(events)
  }

  // ── Revisions ────────────────────────────────────────────────────────

  #[instrument(skip(self, revision), fields(revision_id = %revision.id, template_id = %revision.template_id))]
  async fn create_revision(&self, revision: &TemplateRevision) -> AuthResult<()> {
    sqlx::query(
      r#"
            INSERT INTO template_revisions
                (id, template_id, version, state, bundle_blob_id, preview_blob_id,
                 checksum, manifest_json, release_notes, created_by, created_at, published_at,
                 source_format, normalizer_version, detected_format, ignored_entries_count,
                 error_catalog_version, normalization_warnings_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            "#,
    )
    .bind(revision.id)
    .bind(revision.template_id)
    .bind(&revision.version)
    .bind(revision_state_to_db(revision.state))
    .bind(&revision.bundle_blob_id)
    .bind(&revision.preview_blob_id)
    .bind(&revision.checksum)
    .bind(
      revision
        .manifest
        .as_ref()
        .unwrap_or(&serde_json::Value::Object(Default::default())),
    )
    .bind(revision.release_notes.as_deref().unwrap_or(""))
    .bind(revision.created_by)
    .bind(revision.created_at)
    .bind(revision.published_at)
    .bind(&revision.source_format)
    .bind(&revision.normalizer_version)
    .bind(&revision.detected_format)
    .bind(revision.ignored_entries_count as i32)
    .bind(&revision.error_catalog_version)
    .bind(Json(&revision.normalization_warnings))
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(revision_id = %revision.id, "template revision created");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn get_revision(&self, id: TemplateRevisionId) -> AuthResult<Option<TemplateRevision>> {
    let row = sqlx::query(
      r#"
            SELECT id, template_id, version, state, bundle_blob_id, preview_blob_id,
                   checksum, manifest_json, release_notes, created_by, created_at, published_at,
                   source_format, normalizer_version, detected_format, ignored_entries_count,
                   error_catalog_version, normalization_warnings_json
            FROM template_revisions
            WHERE id = $1
            "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_revision_row).transpose()?;
    trace!(found = result.is_some(), "revision lookup by id");
    Ok(result)
  }

  #[instrument(skip(self))]
  async fn list_revisions(
    &self,
    template_id: TemplateCatalogEntryId,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<TemplateRevision>> {
    let rows = sqlx::query(
      r#"
            SELECT id, template_id, version, state, bundle_blob_id, preview_blob_id,
                   checksum, manifest_json, release_notes, created_by, created_at, published_at,
                   source_format, normalizer_version, detected_format, ignored_entries_count,
                   error_catalog_version, normalization_warnings_json
            FROM template_revisions
            WHERE template_id = $1
            ORDER BY created_at DESC
            OFFSET $2 LIMIT $3
            "#,
    )
    .bind(template_id)
    .bind(skip)
    .bind(take)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let revisions: AuthResult<Vec<TemplateRevision>> = rows.into_iter().map(Self::map_revision_row).collect();
    let revisions = revisions?;
    trace!(count = revisions.len(), "revisions listed for template");
    Ok(revisions)
  }

  #[instrument(skip(self))]
  async fn get_latest_published_revision(
    &self,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Option<TemplateRevision>> {
    let row = sqlx::query(
      r#"
            SELECT id, template_id, version, state, bundle_blob_id, preview_blob_id,
                   checksum, manifest_json, release_notes, created_by, created_at, published_at,
                   source_format, normalizer_version, detected_format, ignored_entries_count,
                   error_catalog_version, normalization_warnings_json
            FROM template_revisions
            WHERE template_id = $1 AND state = 'published'
            ORDER BY published_at DESC NULLS LAST
            LIMIT 1
            "#,
    )
    .bind(template_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_revision_row).transpose()?;
    trace!(found = result.is_some(), "latest published revision lookup");
    Ok(result)
  }

  #[instrument(skip(self, revision), fields(revision_id = %revision.id))]
  async fn update_revision(&self, revision: &TemplateRevision) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let catalog: Uuid = sqlx::query_scalar("SELECT template_id FROM template_revisions WHERE id=$1")
      .bind(revision.id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query("SELECT id FROM template_catalog_entries WHERE id=$1 FOR NO KEY UPDATE")
      .bind(catalog)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let current = sqlx::query("SELECT * FROM template_revisions WHERE id=$1 FOR UPDATE")
      .bind(revision.id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let current = Self::map_revision_row(current)?;
    if (current.version != revision.version
      || current.bundle_blob_id != revision.bundle_blob_id
      || current.checksum != revision.checksum
      || current.manifest != revision.manifest)
      && accepted_document_revision_pin(&mut tx, revision.id).await?
    {
      return Err(AuthError::InvalidInput("accepted document source is immutable".into()));
    }
    // Validation may race another API's publication of the same immutable
    // release bundle. Reject the stale write rather than regress its lifecycle.
    let result = sqlx::query(
      r#"
            UPDATE template_revisions
            SET version = $2, state = $3, bundle_blob_id = $4, preview_blob_id = $5,
                checksum = $6, manifest_json = $7, release_notes = $8,
                created_by = $9, published_at = $10,
                source_format = $11, normalizer_version = $12, detected_format = $13,
                ignored_entries_count = $14, error_catalog_version = $15,
                normalization_warnings_json = $16
            WHERE id = $1
              AND ($3 <> 'validated' OR state = 'draft')
            "#,
    )
    .bind(revision.id)
    .bind(&revision.version)
    .bind(revision_state_to_db(revision.state))
    .bind(&revision.bundle_blob_id)
    .bind(&revision.preview_blob_id)
    .bind(&revision.checksum)
    .bind(
      revision
        .manifest
        .as_ref()
        .unwrap_or(&serde_json::Value::Object(Default::default())),
    )
    .bind(revision.release_notes.as_deref().unwrap_or(""))
    .bind(revision.created_by)
    .bind(revision.published_at)
    .bind(&revision.source_format)
    .bind(&revision.normalizer_version)
    .bind(&revision.detected_format)
    .bind(revision.ignored_entries_count as i32)
    .bind(&revision.error_catalog_version)
    .bind(Json(&revision.normalization_warnings))
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    if result.rows_affected() != 1 {
      return Err(AuthError::InvalidInput(
        "template revision changed before update".to_string(),
      ));
    }

    tx.commit().await.map_err(Self::map_db_err)?;
    debug!(revision_id = %revision.id, "template revision updated");
    Ok(())
  }

  // ── Workspace Policies ───────────────────────────────────────────────

  #[instrument(skip(self, policy), fields(policy_id = %policy.id, workspace_id = %policy.workspace_id))]
  async fn create_policy(&self, policy: &WorkspaceTemplatePolicy) -> AuthResult<()> {
    sqlx::query(
      r#"
            INSERT INTO workspace_template_policies
                (id, workspace_id, template_id, selection_mode, selected_revision_id,
                 provisioning_mode, is_enabled, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
    )
    .bind(policy.id)
    .bind(policy.workspace_id)
    .bind(policy.template_id)
    .bind(selection_mode_to_db(policy.selection_mode))
    .bind(policy.selected_revision_id)
    .bind(provisioning_mode_to_db(policy.provisioning_mode))
    .bind(policy.is_enabled)
    .bind(policy.created_at)
    .bind(policy.updated_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(policy_id = %policy.id, "workspace template policy created");
    Ok(())
  }

  async fn create_policy_for_explicit_assignment(
    &self,
    policy: &WorkspaceTemplatePolicy,
    revision_id: Option<TemplateRevisionId>,
  ) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let historical: Option<(String, bool, bool)> = sqlx::query_as(
      r#"
      SELECT i.state,
             EXISTS (
               SELECT 1 FROM docs d
               WHERE d.id = i.workspace_doc_id AND d.workspace_id = i.workspace_id
             ) AS source_exists,
             COALESCE(r.manifest_json->>'purpose', 'template') = 'guide' AS reader_owned_guide
      FROM workspace_template_instances i
      LEFT JOIN template_revisions r ON r.id = i.revision_id
      WHERE i.workspace_id = $1 AND i.template_id = $2
      FOR UPDATE OF i
      "#,
    )
    .bind(policy.workspace_id)
    .bind(policy.template_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if historical.as_ref().is_some_and(|(state, _, _)| state != "retired") {
      return Err(AuthError::InvalidInput(
        "Template is already assigned to this workspace".to_string(),
      ));
    }
    if historical
      .as_ref()
      .is_some_and(|(_, source_exists, guide)| *source_exists && !guide)
    {
      return Err(AuthError::InvalidInput(
        "template retirement cleanup is still pending".to_string(),
      ));
    }

    sqlx::query(
      r#"
      INSERT INTO workspace_template_policies
        (id, workspace_id, template_id, selection_mode, selected_revision_id,
         provisioning_mode, is_enabled, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      "#,
    )
    .bind(policy.id)
    .bind(policy.workspace_id)
    .bind(policy.template_id)
    .bind(selection_mode_to_db(policy.selection_mode))
    .bind(policy.selected_revision_id)
    .bind(provisioning_mode_to_db(policy.provisioning_mode))
    .bind(policy.is_enabled)
    .bind(policy.created_at)
    .bind(policy.updated_at)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    if historical.as_ref().is_some_and(|(state, _, _)| state == "retired") {
      sqlx::query(
        r#"
        UPDATE workspace_template_instances
        SET revision_id = COALESCE($3, revision_id), workspace_doc_id = NULL,
            workspace_doc_key = NULL, state = 'ok', last_applied_hash = NULL,
            current_hash = NULL, last_synced_at = NULL, detached_at = NULL,
            retired_at = NULL, last_error_code = NULL, last_error_message = NULL,
            expected_hash = NULL, locale_hash = NULL, updated_at = now()
        WHERE workspace_id = $1 AND template_id = $2 AND state = 'retired'
        "#,
      )
      .bind(policy.workspace_id)
      .bind(policy.template_id)
      .bind(revision_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn get_policy(&self, id: WorkspaceTemplatePolicyId) -> AuthResult<Option<WorkspaceTemplatePolicy>> {
    let row = sqlx::query(
      r#"
            SELECT id, workspace_id, template_id, selection_mode, selected_revision_id,
                   provisioning_mode, is_enabled, created_at, updated_at
            FROM workspace_template_policies
            WHERE id = $1
            "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_policy_row).transpose()?;
    trace!(found = result.is_some(), "policy lookup by id");
    Ok(result)
  }

  #[instrument(skip(self))]
  async fn list_policies_for_workspace(
    &self,
    workspace_id: myoxus_domain::ids::WorkspaceId,
  ) -> AuthResult<Vec<WorkspaceTemplatePolicy>> {
    let rows = sqlx::query(
      r#"
            SELECT id, workspace_id, template_id, selection_mode, selected_revision_id,
                   provisioning_mode, is_enabled, created_at, updated_at
            FROM workspace_template_policies
            WHERE workspace_id = $1
            ORDER BY created_at ASC, id ASC
            "#,
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let policies: AuthResult<Vec<WorkspaceTemplatePolicy>> = rows.into_iter().map(Self::map_policy_row).collect();
    let policies = policies?;
    trace!(count = policies.len(), "policies listed for workspace");
    Ok(policies)
  }

  #[instrument(skip(self))]
  async fn list_policies_for_template(
    &self,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Vec<WorkspaceTemplatePolicy>> {
    let rows = sqlx::query(
      r#"
            SELECT id, workspace_id, template_id, selection_mode, selected_revision_id,
                   provisioning_mode, is_enabled, created_at, updated_at
            FROM workspace_template_policies
            WHERE template_id = $1
            ORDER BY created_at ASC, id ASC
            "#,
    )
    .bind(template_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let policies: AuthResult<Vec<WorkspaceTemplatePolicy>> = rows.into_iter().map(Self::map_policy_row).collect();
    let policies = policies?;
    trace!(count = policies.len(), "policies listed for template");
    Ok(policies)
  }

  #[instrument(skip(self, policy), fields(policy_id = %policy.id))]
  async fn update_policy(&self, policy: &WorkspaceTemplatePolicy) -> AuthResult<()> {
    sqlx::query(
      r#"
            UPDATE workspace_template_policies
            SET workspace_id = $2, template_id = $3, selection_mode = $4,
                selected_revision_id = $5, provisioning_mode = $6,
                is_enabled = $7, updated_at = $8
            WHERE id = $1
            "#,
    )
    .bind(policy.id)
    .bind(policy.workspace_id)
    .bind(policy.template_id)
    .bind(selection_mode_to_db(policy.selection_mode))
    .bind(policy.selected_revision_id)
    .bind(provisioning_mode_to_db(policy.provisioning_mode))
    .bind(policy.is_enabled)
    .bind(policy.updated_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(policy_id = %policy.id, "workspace template policy updated");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn delete_policy(&self, id: WorkspaceTemplatePolicyId) -> AuthResult<()> {
    sqlx::query("DELETE FROM workspace_template_policies WHERE id = $1")
      .bind(id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;

    debug!(%id, "workspace template policy deleted");
    Ok(())
  }

  // ── Workspace Instances ──────────────────────────────────────────────

  #[instrument(skip(self, instance), fields(instance_id = %instance.id, workspace_id = %instance.workspace_id))]
  async fn create_instance(&self, instance: &WorkspaceTemplateInstance) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    if instance.workspace_doc_id.is_some() {
      // A stale worker may have selected this release before its catalog was
      // archived. Never bind a newly delivered legacy source after retirement.
      let active: Option<Uuid> = sqlx::query_scalar("SELECT id FROM template_catalog_entries WHERE id=$1 AND (slug <> 'meeting-notes' OR status <> 'archived') FOR SHARE")
        .bind(instance.template_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
      if active.is_none() {
        return Err(AuthError::InvalidInput(
          "retired Meeting Notes cannot acquire a source binding".into(),
        ));
      }
    }
    lock_instance_document(&mut tx, instance.workspace_id, instance.workspace_doc_id).await?;
    sqlx::query(
      r#"
            INSERT INTO workspace_template_instances
                (id, workspace_id, template_id, revision_id, workspace_doc_id, workspace_doc_key,
                 state, last_applied_hash, current_hash, last_synced_at,
                 detached_at, retired_at, last_error_code, last_error_message,
                 expected_hash, locale_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            "#,
    )
    .bind(instance.id)
    .bind(instance.workspace_id)
    .bind(instance.template_id)
    .bind(instance.revision_id)
    .bind(instance.workspace_doc_id)
    .bind(&instance.workspace_doc_key)
    .bind(instance_state_to_db(instance.state))
    .bind(&instance.last_applied_hash)
    .bind(&instance.current_hash)
    .bind(instance.last_synced_at)
    .bind(instance.detached_at)
    .bind(instance.retired_at)
    .bind(&instance.last_error_code)
    .bind(&instance.last_error_message)
    .bind(&instance.expected_hash)
    .bind(&instance.locale_hash)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;

    debug!(instance_id = %instance.id, "workspace template instance created");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn get_instance(&self, id: WorkspaceTemplateInstanceId) -> AuthResult<Option<WorkspaceTemplateInstance>> {
    let row = sqlx::query(
      r#"
            SELECT i.id, i.workspace_id, i.template_id, i.revision_id, i.workspace_doc_id, i.workspace_doc_key,
                   i.state, i.last_applied_hash, i.current_hash, i.last_synced_at,
                   i.detached_at, i.retired_at, i.last_error_code, i.last_error_message,
                   i.expected_hash, i.locale_hash
            FROM workspace_template_instances i
            JOIN template_catalog_entries c ON c.id = i.template_id
            WHERE i.id = $1
              AND c.source <> 'builtin'
            "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_instance_row).transpose()?;
    trace!(found = result.is_some(), "instance lookup by id");
    Ok(result)
  }

  #[instrument(skip(self))]
  async fn list_instances_for_workspace(
    &self,
    workspace_id: myoxus_domain::ids::WorkspaceId,
  ) -> AuthResult<Vec<WorkspaceTemplateInstance>> {
    let rows = sqlx::query(
      r#"
            SELECT i.id, i.workspace_id, i.template_id, i.revision_id, i.workspace_doc_id, i.workspace_doc_key,
                   i.state, i.last_applied_hash, i.current_hash, i.last_synced_at,
                   i.detached_at, i.retired_at, i.last_error_code, i.last_error_message,
                   i.expected_hash, i.locale_hash
            FROM workspace_template_instances i
            JOIN template_catalog_entries c ON c.id = i.template_id
            WHERE i.workspace_id = $1
              AND c.source <> 'builtin'
            ORDER BY i.created_at ASC
            "#,
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let instances: AuthResult<Vec<WorkspaceTemplateInstance>> = rows.into_iter().map(Self::map_instance_row).collect();
    let instances = instances?;
    trace!(count = instances.len(), "instances listed for workspace");
    Ok(instances)
  }

  #[instrument(skip(self))]
  async fn list_instances_for_template(
    &self,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Vec<WorkspaceTemplateInstance>> {
    let rows = sqlx::query(
      r#"
            SELECT i.id, i.workspace_id, i.template_id, i.revision_id, i.workspace_doc_id, i.workspace_doc_key,
                   i.state, i.last_applied_hash, i.current_hash, i.last_synced_at,
                   i.detached_at, i.retired_at, i.last_error_code, i.last_error_message,
                   i.expected_hash, i.locale_hash
            FROM workspace_template_instances i
            JOIN template_catalog_entries c ON c.id = i.template_id
            WHERE i.template_id = $1
              AND c.source <> 'builtin'
            ORDER BY i.created_at ASC
            "#,
    )
    .bind(template_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let instances: AuthResult<Vec<WorkspaceTemplateInstance>> = rows.into_iter().map(Self::map_instance_row).collect();
    let instances = instances?;
    trace!(count = instances.len(), "instances listed for template");
    Ok(instances)
  }

  #[instrument(skip(self))]
  async fn find_instance(
    &self,
    workspace_id: myoxus_domain::ids::WorkspaceId,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Option<WorkspaceTemplateInstance>> {
    let row = sqlx::query(
      r#"
            SELECT i.id, i.workspace_id, i.template_id, i.revision_id, i.workspace_doc_id, i.workspace_doc_key,
                   i.state, i.last_applied_hash, i.current_hash, i.last_synced_at,
                   i.detached_at, i.retired_at, i.last_error_code, i.last_error_message,
                   i.expected_hash, i.locale_hash
            FROM workspace_template_instances i
            JOIN template_catalog_entries c ON c.id = i.template_id
            WHERE i.workspace_id = $1
              AND i.template_id = $2
              AND c.source <> 'builtin'
            "#,
    )
    .bind(workspace_id)
    .bind(template_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_instance_row).transpose()?;
    trace!(found = result.is_some(), "instance lookup by workspace+template");
    Ok(result)
  }

  async fn is_managed_source(&self, workspace_id: WorkspaceId, doc_id: DocId) -> AuthResult<bool> {
    sqlx::query_scalar(
      r#"
      SELECT EXISTS(
        SELECT 1
        FROM workspace_template_instances i
        JOIN workspace_template_policies p
          ON p.workspace_id = i.workspace_id
         AND p.template_id = i.template_id
        WHERE i.workspace_id = $1
          AND i.workspace_doc_id = $2
          AND i.state <> 'retired'
          AND i.retired_at IS NULL
          AND p.is_enabled = TRUE
          AND p.provisioning_mode <> 'seed_once'
          AND NOT EXISTS (
            SELECT 1 FROM template_revisions r
            WHERE r.id = i.revision_id AND r.manifest_json->>'purpose' = 'guide'
          )
      )
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  #[instrument(skip(self, instance), fields(instance_id = %instance.id))]
  async fn update_instance(&self, instance: &WorkspaceTemplateInstance) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    if instance.workspace_doc_id.is_some() {
      // A stale worker may have selected this release before its catalog was
      // archived. Never bind a newly delivered legacy source after retirement.
      let active: Option<Uuid> = sqlx::query_scalar("SELECT id FROM template_catalog_entries WHERE id=$1 AND (slug <> 'meeting-notes' OR status <> 'archived') FOR SHARE")
        .bind(instance.template_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
      if active.is_none() {
        return Err(AuthError::InvalidInput(
          "retired Meeting Notes cannot acquire a source binding".into(),
        ));
      }
    }
    lock_instance_document(&mut tx, instance.workspace_id, instance.workspace_doc_id).await?;
    let current = sqlx::query_as::<_, (Option<Uuid>, bool, bool)>(
      r#"
      SELECT i.workspace_doc_id,
             EXISTS (
               SELECT 1 FROM docs d
               WHERE d.id = i.workspace_doc_id
                 AND d.workspace_id = i.workspace_id
                 AND d.deleted_at IS NULL
             ) AS source_available,
             EXISTS (
               SELECT 1 FROM template_revisions old_revision
               JOIN template_revisions new_revision ON new_revision.id = $2
               WHERE old_revision.id = i.revision_id
                 AND old_revision.template_id = i.template_id
                 AND new_revision.template_id = i.template_id
                 AND old_revision.manifest_json->>'purpose' = 'guide'
                 AND new_revision.manifest_json->>'purpose' = 'guide'
             ) AS reader_guide_binding
      FROM workspace_template_instances i
      WHERE i.id = $1
      FOR UPDATE
      "#,
    )
    .bind(instance.id)
    .bind(instance.revision_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    // A guide binding points to the most recently installed ordinary copy;
    // rebinding it never replaces or mutates the previous reader document.
    // Reusable templates retain their single-live-source invariant.
    if current.is_some_and(|(doc_id, source_available, guide)| {
      source_available && doc_id != instance.workspace_doc_id && !guide
    }) {
      return Err(AuthError::InvalidInput(
        "template instance already has a live canonical source".to_string(),
      ));
    }
    sqlx::query(
      r#"
            UPDATE workspace_template_instances
            SET revision_id = $2, workspace_doc_id = $3, workspace_doc_key = $4, state = $5,
                last_applied_hash = $6, current_hash = $7, last_synced_at = $8,
                detached_at = $9, retired_at = $10, last_error_code = $11,
                last_error_message = $12, expected_hash = $13, locale_hash = $14,
                updated_at = now()
            WHERE id = $1
            "#,
    )
    .bind(instance.id)
    .bind(instance.revision_id)
    .bind(instance.workspace_doc_id)
    .bind(&instance.workspace_doc_key)
    .bind(instance_state_to_db(instance.state))
    .bind(&instance.last_applied_hash)
    .bind(&instance.current_hash)
    .bind(instance.last_synced_at)
    .bind(instance.detached_at)
    .bind(instance.retired_at)
    .bind(&instance.last_error_code)
    .bind(&instance.last_error_message)
    .bind(&instance.expected_hash)
    .bind(&instance.locale_hash)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;

    debug!(instance_id = %instance.id, "workspace template instance updated");
    Ok(())
  }

  async fn preserve_source_as_custom(
    &self,
    workspace: WorkspaceId,
    template: TemplateCatalogEntryId,
  ) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Keep the normal metadata write lock order: document, then binding.
    let doc: Option<Uuid> = sqlx::query_scalar(
      "SELECT workspace_doc_id FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2",
    )
    .bind(workspace)
    .bind(template)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .flatten();
    if let Some(doc) = doc {
      sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(crate::document_version::edit_capture_state::lock_key(workspace, doc))
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      sqlx::query("SELECT id FROM docs WHERE workspace_id=$1 AND id=$2 FOR UPDATE")
        .bind(workspace)
        .bind(doc)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    let current: Option<(Uuid, Option<Uuid>)> = sqlx::query_as("SELECT id,workspace_doc_id FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2 FOR UPDATE")
      .bind(workspace).bind(template).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    if let Some((instance, current_doc)) = current {
      if current_doc != doc {
        return Err(AuthError::InvalidInput(
          "source binding changed; retry preservation".into(),
        ));
      }
      if let Some(doc) = doc {
        // Positive template attribution survives, but no other owner's flags
        // are acquired and a user-cleared template flag is never resurrected.
        sqlx::query("UPDATE document_template_state SET state='seeded',template_id=NULL,instance_id=NULL,revision_id=NULL,source='document',updated_at=now() WHERE doc_id=$1 AND (template_id IS NULL OR template_id=$2) AND (instance_id IS NULL OR instance_id=$3)")
          .bind(doc).bind(template).bind(instance).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      }
      sqlx::query("UPDATE workspace_template_instances SET state='detached',detached_at=COALESCE(detached_at,now()),retired_at=NULL,workspace_doc_id=NULL,workspace_doc_key=NULL,updated_at=now() WHERE id=$1")
        .bind(instance).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      if doc.is_some() {
        sqlx::query("INSERT INTO template_registry_audit_events(action,event_type,workspace_id,template_id,instance_id,payload_json) VALUES('detached','template.instance.detached',$1,$2,$3,$4)")
          .bind(workspace).bind(template).bind(instance)
          .bind(serde_json::json!({"source_binding_relinquished":true,"document_id":doc}))
          .execute(&mut *tx).await.map_err(Self::map_db_err)?;
      }
    }
    tx.commit().await.map_err(Self::map_db_err)
  }

  async fn begin_eligible_source_retirement(
    &self,
    policy: &WorkspaceTemplatePolicy,
  ) -> AuthResult<Option<RetiringTemplateSource>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let instance: Option<(String, Option<Uuid>, Option<String>)> = sqlx::query_as(
      "SELECT state,workspace_doc_id,workspace_doc_key FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=$2 FOR UPDATE",
    )
    .bind(policy.workspace_id)
    .bind(policy.template_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    // Preservation deliberately leaves a detached instance without a binding.
    // It is safe to retire that ownership, but never a newly linked custom body.
    if instance
      .as_ref()
      .is_some_and(|(state, doc, key)| state == "detached" && (doc.is_some() || key.is_some()))
    {
      return Err(AuthError::InvalidInput("source detached before replacement".into()));
    }
    let eligible: Option<Uuid> = sqlx::query_scalar("SELECT id FROM workspace_template_policies WHERE id=$1 AND workspace_id=$2 AND template_id=$3 AND is_enabled=true AND selection_mode='published' AND provisioning_mode='managed_until_local_edit' AND selected_revision_id IS NULL FOR UPDATE")
      .bind(policy.id).bind(policy.workspace_id).bind(policy.template_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    if eligible.is_none() {
      return Err(AuthError::InvalidInput("source replacement eligibility changed".into()));
    }
    let row = sqlx::query_as::<_, (Uuid, String, Option<Uuid>, Option<String>)>("UPDATE workspace_template_instances i SET state='retired',retired_at=COALESCE(retired_at,now()),detached_at=NULL,updated_at=now() FROM template_catalog_entries c WHERE i.workspace_id=$1 AND i.template_id=$2 AND c.id=i.template_id RETURNING i.id,c.source,i.workspace_doc_id,i.workspace_doc_key")
      .bind(policy.workspace_id).bind(policy.template_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    row
      .map(|(instance_id, source, workspace_doc_id, workspace_doc_key)| {
        Ok(RetiringTemplateSource {
          instance_id,
          source: template_source_from_db(&source)?,
          workspace_doc_id,
          workspace_doc_key,
        })
      })
      .transpose()
  }

  async fn begin_central_source_retirement(
    &self,
    workspace_id: WorkspaceId,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<Option<RetiringTemplateSource>> {
    let row = sqlx::query_as::<_, (Uuid, String, Option<Uuid>, Option<String>)>(
      r#"
      UPDATE workspace_template_instances i
      SET state = 'retired', retired_at = COALESCE(i.retired_at, now()),
          detached_at = NULL, updated_at = now()
      FROM template_catalog_entries c
      WHERE i.workspace_id = $1
        AND i.template_id = $2
        AND c.id = i.template_id
      RETURNING i.id, c.source, i.workspace_doc_id, i.workspace_doc_key
      "#,
    )
    .bind(workspace_id)
    .bind(template_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    row
      .map(|(instance_id, source, workspace_doc_id, workspace_doc_key)| {
        Ok(RetiringTemplateSource {
          instance_id,
          source: template_source_from_db(&source)?,
          workspace_doc_id,
          workspace_doc_key,
        })
      })
      .transpose()
  }

  async fn complete_central_source_retirement(
    &self,
    workspace_id: WorkspaceId,
    template_id: TemplateCatalogEntryId,
  ) -> AuthResult<()> {
    let result = sqlx::query(
      r#"
      UPDATE workspace_template_instances i
      SET workspace_doc_id = NULL, workspace_doc_key = NULL, updated_at = now()
      WHERE i.workspace_id = $1
        AND i.template_id = $2
        AND i.state = 'retired'
        AND (NOT EXISTS (
          SELECT 1 FROM docs d
          WHERE d.id = i.workspace_doc_id
            AND d.workspace_id = i.workspace_id
        ) OR EXISTS (
          SELECT 1 FROM template_revisions r
          WHERE r.id = i.revision_id AND r.manifest_json->>'purpose' = 'guide'
        ))
      "#,
    )
    .bind(workspace_id)
    .bind(template_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      let live_source: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
          SELECT 1
          FROM workspace_template_instances i
          JOIN docs d ON d.id = i.workspace_doc_id AND d.workspace_id = i.workspace_id
          WHERE i.workspace_id = $1 AND i.template_id = $2 AND i.state = 'retired'
        )
        "#,
      )
      .bind(workspace_id)
      .bind(template_id)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
      if live_source {
        return Err(AuthError::Storage(
          "retired template source document still exists".to_string(),
        ));
      }
    }
    Ok(())
  }

  // ── Import Jobs ──────────────────────────────────────────────────────

  #[instrument(skip(self, job), fields(job_id = %job.id))]
  async fn create_import_job(&self, job: &TemplateImportJob) -> AuthResult<()> {
    sqlx::query(
      r#"
            INSERT INTO template_import_jobs
                (id, uploaded_blob_id, result_revision_id, state,
                 validation_report_json, created_by, started_at, finished_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
    )
    .bind(job.id)
    .bind(&job.uploaded_blob_id)
    .bind(job.result_revision_id)
    .bind(job_state_to_db(job.state))
    .bind(&job.validation_report)
    .bind(job.created_by)
    .bind(job.started_at)
    .bind(job.finished_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(job_id = %job.id, "template import job created");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn get_import_job(&self, id: TemplateImportJobId) -> AuthResult<Option<TemplateImportJob>> {
    let row = sqlx::query(
      r#"
            SELECT id, uploaded_blob_id, result_revision_id, state,
                   validation_report_json, created_by, started_at, finished_at
            FROM template_import_jobs
            WHERE id = $1
            "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_import_job_row).transpose()?;
    trace!(found = result.is_some(), "import job lookup by id");
    Ok(result)
  }

  #[instrument(skip(self, job), fields(job_id = %job.id))]
  async fn update_import_job(&self, job: &TemplateImportJob) -> AuthResult<()> {
    sqlx::query(
      r#"
            UPDATE template_import_jobs
            SET uploaded_blob_id = $2, result_revision_id = $3, state = $4,
                validation_report_json = $5, created_by = $6,
                started_at = $7, finished_at = $8
            WHERE id = $1
            "#,
    )
    .bind(job.id)
    .bind(&job.uploaded_blob_id)
    .bind(job.result_revision_id)
    .bind(job_state_to_db(job.state))
    .bind(&job.validation_report)
    .bind(job.created_by)
    .bind(job.started_at)
    .bind(job.finished_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(job_id = %job.id, "template import job updated");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn list_import_jobs(&self, skip: i64, take: i64) -> AuthResult<Vec<TemplateImportJob>> {
    let rows = sqlx::query(
      r#"
            SELECT id, uploaded_blob_id, result_revision_id, state,
                   validation_report_json, created_by, started_at, finished_at
            FROM template_import_jobs
            ORDER BY started_at DESC
            OFFSET $1 LIMIT $2
            "#,
    )
    .bind(skip.max(0))
    .bind(take.clamp(1, 200))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let jobs: Vec<TemplateImportJob> = rows
      .into_iter()
      .map(Self::map_import_job_row)
      .collect::<AuthResult<Vec<_>>>()?;

    trace!(count = jobs.len(), "import jobs listed");
    Ok(jobs)
  }

  // ── Reconcile Jobs ───────────────────────────────────────────────────

  #[instrument(skip(self, job), fields(job_id = %job.id))]
  async fn create_reconcile_job(&self, job: &TemplateReconcileJob) -> AuthResult<()> {
    sqlx::query(
      r#"
            INSERT INTO template_reconcile_jobs
                (id, scope, workspace_id, template_id, state,
                 summary_json, started_at, finished_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            "#,
    )
    .bind(job.id)
    .bind(reconcile_scope_to_db(job.scope))
    .bind(job.workspace_id)
    .bind(job.template_id)
    .bind(job_state_to_db(job.state))
    .bind(&job.summary)
    .bind(job.started_at)
    .bind(job.finished_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(job_id = %job.id, "template reconcile job created");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn get_reconcile_job(&self, id: TemplateReconcileJobId) -> AuthResult<Option<TemplateReconcileJob>> {
    let row = sqlx::query(
      r#"
            SELECT id, scope, workspace_id, template_id, state,
                   summary_json, started_at, finished_at
            FROM template_reconcile_jobs
            WHERE id = $1
            "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let result = row.map(Self::map_reconcile_job_row).transpose()?;
    trace!(found = result.is_some(), "reconcile job lookup by id");
    Ok(result)
  }

  #[instrument(skip(self, job), fields(job_id = %job.id))]
  async fn update_reconcile_job(&self, job: &TemplateReconcileJob) -> AuthResult<()> {
    sqlx::query(
      r#"
            UPDATE template_reconcile_jobs
            SET scope = $2, workspace_id = $3, template_id = $4, state = $5,
                summary_json = $6, started_at = $7, finished_at = $8
            WHERE id = $1
            "#,
    )
    .bind(job.id)
    .bind(reconcile_scope_to_db(job.scope))
    .bind(job.workspace_id)
    .bind(job.template_id)
    .bind(job_state_to_db(job.state))
    .bind(&job.summary)
    .bind(job.started_at)
    .bind(job.finished_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(job_id = %job.id, "template reconcile job updated");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn list_reconcile_jobs(&self, skip: i64, take: i64) -> AuthResult<Vec<TemplateReconcileJob>> {
    let rows = sqlx::query(
      r#"
            SELECT id, scope, workspace_id, template_id, state,
                   summary_json, started_at, finished_at
            FROM template_reconcile_jobs
            ORDER BY started_at DESC
            OFFSET $1 LIMIT $2
            "#,
    )
    .bind(skip.max(0))
    .bind(take.clamp(1, 200))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let jobs: Vec<TemplateReconcileJob> = rows
      .into_iter()
      .map(Self::map_reconcile_job_row)
      .collect::<AuthResult<Vec<_>>>()?;

    trace!(count = jobs.len(), "reconcile jobs listed");
    Ok(jobs)
  }

  #[instrument(skip(self))]
  async fn list_recoverable_workspace_reconcile_jobs(&self, take: i64) -> AuthResult<Vec<TemplateReconcileJob>> {
    let rows = sqlx::query(
      r#"
      SELECT id, scope, workspace_id, template_id, state,
             summary_json, started_at, finished_at
      FROM template_reconcile_jobs
      WHERE scope = 'workspace'
        AND workspace_id IS NOT NULL
        AND state IN ('pending', 'running')
      ORDER BY started_at ASC
      LIMIT $1
      "#,
    )
    .bind(take.clamp(1, 200))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    rows.into_iter().map(Self::map_reconcile_job_row).collect()
  }

  // ── Default Policies ─────────────────────────────────────────────────

  /// List all template default policies.
  #[instrument(skip(self))]
  async fn list_default_policies(&self) -> AuthResult<Vec<TemplateDefaultPolicy>> {
    let rows = sqlx::query(
      r#"
            SELECT template_id, apply_to_new_workspaces, selection_mode, provisioning_mode,
                   created_at, updated_at
            FROM template_default_policies
            ORDER BY created_at ASC
            "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let policies: AuthResult<Vec<TemplateDefaultPolicy>> = rows.into_iter().map(Self::map_default_policy_row).collect();
    let policies = policies?;
    trace!(count = policies.len(), "default policies listed");
    Ok(policies)
  }

  /// Upsert a template default policy.
  #[instrument(skip(self, policy), fields(template_id = %policy.template_id))]
  async fn upsert_default_policy(&self, policy: &TemplateDefaultPolicy) -> AuthResult<()> {
    sqlx::query(
      r#"
            INSERT INTO template_default_policies
                (template_id, apply_to_new_workspaces, selection_mode, provisioning_mode,
                 created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (template_id) DO UPDATE
            SET apply_to_new_workspaces = EXCLUDED.apply_to_new_workspaces,
                selection_mode = EXCLUDED.selection_mode,
                provisioning_mode = EXCLUDED.provisioning_mode,
                updated_at = EXCLUDED.updated_at,
                release_managed = false
            "#,
    )
    .bind(policy.template_id)
    .bind(policy.apply_to_new_workspaces)
    .bind(selection_mode_to_db(policy.selection_mode))
    .bind(provisioning_mode_to_db(policy.provisioning_mode))
    .bind(policy.created_at)
    .bind(policy.updated_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(template_id = %policy.template_id, "default policy upserted");
    Ok(())
  }

  #[instrument(skip(self, policy), fields(template_id = %policy.template_id))]
  async fn insert_default_policy_if_absent(&self, policy: &TemplateDefaultPolicy) -> AuthResult<bool> {
    let result = sqlx::query(
      r#"
            INSERT INTO template_default_policies
                 (template_id, apply_to_new_workspaces, selection_mode, provisioning_mode,
                  created_at, updated_at, release_managed)
            VALUES ($1, $2, $3, $4, $5, $6, true)
            ON CONFLICT (template_id) DO NOTHING
            "#,
    )
    .bind(policy.template_id)
    .bind(policy.apply_to_new_workspaces)
    .bind(selection_mode_to_db(policy.selection_mode))
    .bind(provisioning_mode_to_db(policy.provisioning_mode))
    .bind(policy.created_at)
    .bind(policy.updated_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(result.rows_affected() == 1)
  }

  /// Flip `apply_to_new_workspaces` on a default policy.
  #[instrument(skip(self))]
  async fn set_default_policy_apply_flag(&self, template_id: TemplateCatalogEntryId, apply: bool) -> AuthResult<()> {
    sqlx::query(
      "UPDATE template_default_policies SET apply_to_new_workspaces = $1, release_managed = false, updated_at = now() WHERE template_id = $2",
    )
    .bind(apply)
    .bind(template_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(%template_id, apply, "default policy apply flag updated");
    Ok(())
  }

  #[instrument(skip_all)]
  async fn workspace_initial_content_policy(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<myoxus_domain::entities::WorkspaceInitialContentPolicy> {
    let policy: String = sqlx::query_scalar(
      "SELECT initial_content_policy FROM workspaces WHERE id=$1 AND deleted_at IS NULL AND lifecycle_state='active'",
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("workspace".into()))?;
    serde_json::from_value(serde_json::Value::String(policy))
      .map_err(|_| AuthError::Storage("invalid Workspace initial-content policy".into()))
  }

  /// Seed workspace_template_policies for a newly created workspace from the
  /// active default policies in a single SQL statement (no N+1).
  ///
  /// Idempotent: `ON CONFLICT DO NOTHING` ensures duplicate calls are safe.
  /// Both published bundle and builtin catalog defaults use this owner.
  #[instrument(skip(self), fields(%workspace_id))]
  async fn apply_default_policies_to_new_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<usize> {
    let result = sqlx::query(
      r#"
            INSERT INTO workspace_template_policies
                (id, workspace_id, template_id, selection_mode, provisioning_mode, is_enabled,
                 created_at, updated_at)
            SELECT gen_random_uuid(), $1, dp.template_id, dp.selection_mode,
                   CASE WHEN dp.release_managed AND dp.selection_mode='published'
                     AND dp.provisioning_mode IN ('seed_once','managed_until_local_edit')
                     AND published.release_managed_publication
                     THEN CASE WHEN published.manifest_json->>'purpose'='guide'
                       THEN 'seed_once' ELSE 'managed_until_local_edit' END
                     ELSE dp.provisioning_mode END,
                   TRUE, now(), now()
            FROM template_default_policies dp
            JOIN template_catalog_entries c ON c.id = dp.template_id
            LEFT JOIN LATERAL (
              SELECT revision.id,revision.manifest_json,revision.release_managed_publication
              FROM template_revisions revision WHERE revision.template_id=c.id AND revision.state='published'
              ORDER BY revision.published_at DESC NULLS LAST,revision.id LIMIT 1
            ) published ON c.source='bundle'
            WHERE dp.apply_to_new_workspaces = TRUE
              AND EXISTS(SELECT 1 FROM workspaces WHERE id=$1 AND initial_content_policy='legacy_defaults' AND deleted_at IS NULL AND lifecycle_state='active')
              AND c.status = 'active'
              AND (c.source = 'builtin' OR published.id IS NOT NULL)
            ON CONFLICT (workspace_id, template_id) DO NOTHING
            "#,
    )
    .bind(workspace_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let seeded = result.rows_affected() as usize;
    debug!(%workspace_id, seeded, "default policies applied to new workspace");
    Ok(seeded)
  }

  /// Bump the `builder_version` for a builtin template by 1 and return the new version.
  ///
  /// Used by `bumpBuilderVersion` admin mutation and `myoxus-cli template bump-builder-version`.
  #[instrument(skip(self))]
  async fn bump_builder_version(&self, slug: &str) -> AuthResult<u32> {
    let row = sqlx::query(
      r#"
            UPDATE template_catalog_entries
            SET builder_version = builder_version + 1, updated_at = now()
            WHERE slug = $1 AND source = 'builtin' AND status = 'active'
            RETURNING builder_version
            "#,
    )
    .bind(slug)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    match row {
      Some(r) => {
        let new_version: i32 = r.get("builder_version");
        debug!(slug, new_version, "builder_version bumped");
        Ok(new_version as u32)
      }
      None => Err(AuthError::Storage(format!(
        "builtin template not found or not active: {slug}"
      ))),
    }
  }

  /// List distinct workspace IDs that have an active policy for a given builtin slug.
  ///
  /// Used by the reconcile-push fanout after a `bump_builder_version` call.
  #[instrument(skip(self))]
  async fn list_workspaces_with_builtin_slug(&self, slug: &str) -> AuthResult<Vec<WorkspaceId>> {
    let rows: Vec<(uuid::Uuid,)> = sqlx::query_as(
      r#"
            SELECT DISTINCT p.workspace_id
            FROM workspace_template_policies p
            JOIN template_catalog_entries c ON c.id = p.template_id
            WHERE c.slug = $1 AND c.source = 'builtin' AND p.is_enabled = TRUE
            "#,
    )
    .bind(slug)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let ids: Vec<WorkspaceId> = rows.into_iter().map(|(id,)| id).collect();
    trace!(count = ids.len(), %slug, "workspaces with builtin slug listed");
    Ok(ids)
  }

  /// List active builtin entries for the reconcile query.
  ///
  /// Returns all builtin templates that are enabled for the given workspace,
  /// together with their expected hashes and current instance state.
  /// Used by `workspaceTemplateReconcileSlugs` GQL query.
  /// See myoxus-template-registry-builtin-bridge.md §5+§6.
  #[instrument(skip(self), fields(%workspace_id))]
  async fn list_builtin_reconcile_entries(
    &self,
    workspace_id: WorkspaceId,
    locale: &str,
  ) -> AuthResult<Vec<BuiltinReconcileEntry>> {
    if self.workspace_initial_content_policy(workspace_id).await?
      == myoxus_domain::entities::WorkspaceInitialContentPolicy::Empty
    {
      return Ok(Vec::new());
    }
    let rows = sqlx::query(
      r#"
            SELECT
                c.slug,
                c.builder_version,
                p.provisioning_mode,
                i.state AS instance_state,
                i.last_applied_hash,
                i.expected_hash,
                i.locale_hash,
                i.workspace_doc_id,
                COALESCE(i.workspace_doc_key, d.external_id, i.workspace_doc_id::text) AS workspace_doc_key,
                CASE
                  WHEN d.id IS NULL THEN FALSE
                  WHEN c.category = 'onboarding' THEN TRUE
                  ELSE COALESCE(native_template.state IN ('seeded', 'managed'), FALSE)
                END AS source_available
            FROM workspace_template_policies p
            JOIN template_catalog_entries c ON c.id = p.template_id
            LEFT JOIN workspace_template_instances i
                ON i.workspace_id = p.workspace_id AND i.template_id = p.template_id
            LEFT JOIN docs d ON d.id = i.workspace_doc_id
                AND d.workspace_id = p.workspace_id
                AND d.deleted_at IS NULL
            LEFT JOIN document_template_state native_template
                ON native_template.doc_id = d.id
            WHERE p.workspace_id = $1
              AND c.source = 'builtin'
              AND c.status = 'active'
              AND p.is_enabled = TRUE
            ORDER BY c.slug ASC
            "#,
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
      let slug: String = row.get("slug");
      let builder_version: i32 = row.get("builder_version");
      let builder_version = builder_version as u32;
      let expected_hash =
        myoxus_domain::template_registry::compute_builtin_expected_hash(&slug, builder_version, locale);
      let provisioning_mode = provisioning_mode_from_db(&row.get::<String, _>("provisioning_mode"))?;

      let instance_state_raw: Option<String> = row.get("instance_state");
      let current_instance = if let Some(state_str) = instance_state_raw {
        let state = instance_state_from_db(&state_str)?;
        Some(BuiltinInstanceState {
          state,
          applied_hash: row.get("last_applied_hash"),
          locale_hash: row.get("locale_hash"),
          source_available: row.get("source_available"),
          workspace_doc_key: row.get("workspace_doc_key"),
          workspace_doc_id: row.get("workspace_doc_id"),
        })
      } else {
        None
      };

      entries.push(BuiltinReconcileEntry {
        slug,
        builder_version,
        expected_hash,
        provisioning_mode,
        current_instance,
      });
    }

    trace!(count = entries.len(), %workspace_id, locale, "builtin reconcile entries listed");
    Ok(entries)
  }

  /// Upsert a builtin template instance after the client has applied a builder.
  ///
  /// Called by `reportTemplateBuilderApplied` mutation.
  /// Idempotent: ON CONFLICT (workspace_id, template_id) DO UPDATE.
  #[instrument(skip(self), fields(%workspace_id, %slug))]
  async fn upsert_builtin_instance_applied(
    &self,
    workspace_id: WorkspaceId,
    slug: &str,
    applied_hash: &str,
    locale: &str,
    doc_id: Option<&str>,
  ) -> AuthResult<()> {
    if self.workspace_initial_content_policy(workspace_id).await?
      == myoxus_domain::entities::WorkspaceInitialContentPolicy::Empty
    {
      return Err(AuthError::InvalidInput(
        "implicit template provisioning is disabled for Empty Workspaces".into(),
      ));
    }
    let workspace_doc_key = doc_id.ok_or_else(|| {
      AuthError::InvalidInput(format!("document id is required for completed builtin template {slug}"))
    })?;
    let workspace_doc_key =
      myoxus_domain::document_key::DocumentKey::parse(workspace_doc_key).map_err(AuthError::InvalidInput)?;
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Serialize legacy completions with the release ownership fence before
    // locking a document. The catalog FK's KEY SHARE alone permits a concurrent
    // NO KEY UPDATE cutover and could otherwise admit a nullable legacy row.
    let owner: Option<Uuid> = sqlx::query_scalar(
      "SELECT id FROM template_catalog_entries WHERE slug=$1 AND source='builtin' AND status='active' FOR SHARE",
    )
    .bind(slug)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if owner.is_none() {
      return Err(AuthError::NotFound("active builtin template owner".into()));
    }
    let candidate = sqlx::query_as::<_, (Uuid, Uuid, String)>(
      r#"
      SELECT c.id, d.id, d.external_id
      FROM template_catalog_entries c
      JOIN workspace_template_policies p
        ON p.workspace_id = $1
       AND p.template_id = c.id
       AND p.is_enabled = TRUE
      JOIN docs d
        ON d.workspace_id = $1
       AND d.external_id = $3
       AND d.deleted_at IS NULL
      LEFT JOIN document_template_state native_template
        ON native_template.doc_id = d.id
      WHERE c.slug = $2
        AND c.source = 'builtin'
        AND c.status = 'active'
        AND (c.category = 'onboarding' OR native_template.state IN ('seeded', 'managed'))
      FOR UPDATE OF d
      "#,
    )
    .bind(workspace_id)
    .bind(slug)
    .bind(workspace_doc_key.as_str())
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("template source document".to_string()))?;
    let (template_id, candidate_doc_id, candidate_doc_key) = candidate;
    let current = sqlx::query_as::<_, (Uuid, String, Option<Uuid>, bool, bool)>(
      r#"
      SELECT i.id,
             i.state,
             i.workspace_doc_id,
             EXISTS (
               SELECT 1 FROM docs current_source
               WHERE current_source.id = i.workspace_doc_id
                 AND current_source.workspace_id = i.workspace_id
                 AND current_source.deleted_at IS NULL
             ) AS source_available,
             EXISTS (
               SELECT 1 FROM template_registry_audit_events retirement
               WHERE retirement.instance_id = i.id
                 AND retirement.event_type = 'template.assignment.retired'
                 AND retirement.action = 'deleted'
             ) AS centrally_retired
      FROM workspace_template_instances i
      WHERE i.workspace_id = $1 AND i.template_id = $2
      FOR UPDATE OF i
      "#,
    )
    .bind(workspace_id)
    .bind(template_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let result = if let Some((instance_id, state, current_doc_id, source_available, centrally_retired)) = current {
      let same_source = current_doc_id == Some(candidate_doc_id);
      let repairable_missing_source = !source_available && state != "detached";
      if (!same_source && !repairable_missing_source) || (state == "retired" && centrally_retired) {
        return Err(AuthError::InvalidInput(format!(
          "builtin template {slug} already has a canonical or explicitly retired source"
        )));
      }
      sqlx::query(
        r#"
        UPDATE workspace_template_instances
        SET state = 'ok', last_applied_hash = $2, workspace_doc_id = $3,
            workspace_doc_key = $4, locale_hash = $5, expected_hash = $2,
            detached_at = NULL, retired_at = NULL, last_error_code = NULL,
            last_error_message = NULL, last_synced_at = now(), updated_at = now()
        WHERE id = $1
        "#,
      )
      .bind(instance_id)
      .bind(applied_hash)
      .bind(candidate_doc_id)
      .bind(&candidate_doc_key)
      .bind(locale)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
    } else {
      sqlx::query(
        r#"
        INSERT INTO workspace_template_instances
          (id, workspace_id, template_id, workspace_doc_id, workspace_doc_key,
           state, last_applied_hash, last_synced_at, expected_hash, locale_hash)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'ok', $5, now(), $5, $6)
        ON CONFLICT (workspace_id, template_id) DO NOTHING
        "#,
      )
      .bind(workspace_id)
      .bind(template_id)
      .bind(candidate_doc_id)
      .bind(&candidate_doc_key)
      .bind(applied_hash)
      .bind(locale)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
    };

    if result.rows_affected() == 0 {
      return Err(AuthError::InvalidInput(format!(
        "no active builtin template policy for workspace {workspace_id} and slug {slug}"
      )));
    }
    tx.commit().await.map_err(Self::map_db_err)?;

    debug!(
      %workspace_id,
      %slug,
      workspace_doc_key = %workspace_doc_key,
      "builtin instance upserted as applied"
    );
    Ok(())
  }

  async fn attribute_materialized_document(
    &self,
    doc_id: DocId,
    actor_id: UserId,
    locale: &str,
    purpose: myoxus_application::template_registry::bundle::TemplatePurpose,
  ) -> AuthResult<()> {
    let locale = locale.replace('_', "-").to_ascii_lowercase();
    let base = locale.split('-').next().unwrap_or_default();
    let language_id: Option<uuid::Uuid> = sqlx::query_scalar(
      "SELECT id FROM language_definition WHERE is_active AND key IN ($1, $2) ORDER BY (key = $1) DESC LIMIT 1",
    )
    .bind(&locale)
    .bind(base)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if purpose == myoxus_application::template_registry::bundle::TemplatePurpose::Guide {
      // Trusted delivery records the selected language; ordinary metadata
      // patches cannot edit or remove an introduction's native classification.
      let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
      sqlx::query("UPDATE docs SET language_id=COALESCE($2,language_id),language_source=CASE WHEN $2 IS NULL THEN language_source ELSE 'document' END,metadata_updated_by=$3 WHERE id=$1")
        .bind(doc_id).bind(language_id).bind(actor_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      sqlx::query("INSERT INTO document_template_state(doc_id,state,source) VALUES($1,'guide','workspace') ON CONFLICT(doc_id) DO UPDATE SET state='guide'")
        .bind(doc_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(());
    }
    let repository = crate::document_metadata::PgDocumentMetadataRepository::new(self.pool.clone());
    repository
      .apply_patch(
        doc_id,
        actor_id,
        &DocumentMetadataPatch {
          template_state: Some(Some("managed".into())),
          // Legacy bundle locales were hints, not mandatory catalog entries.
          // Keep the normal document default when no canonical language exists;
          // the exact bundle choice remains recorded on its instance.
          language_id: language_id.map(Some),
          ..DocumentMetadataPatch::default()
        },
      )
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  async fn resolve_bundle_source_language(&self, doc_id: Option<DocId>) -> AuthResult<String> {
    sqlx::query_scalar(
      "SELECT key FROM language_definition WHERE id = COALESCE((SELECT language_id FROM docs WHERE id = $1 AND deleted_at IS NULL), document_metadata_default_language_id())"
    ).bind(doc_id).fetch_one(&self.pool).await.map_err(Self::map_db_err)
  }

  async fn resolve_workspace_materialization_actor(&self, workspace_id: WorkspaceId) -> AuthResult<UserId> {
    sqlx::query_scalar(
      r#"
      SELECT COALESCE(w.created_by_user_id, w.owner_user_id)
      FROM workspaces w
      JOIN users u ON u.id = COALESCE(w.created_by_user_id, w.owner_user_id)
      WHERE w.id = $1
        AND w.deleted_at IS NULL
        AND u.status = 'active'
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .flatten()
    .ok_or_else(|| {
      AuthError::InvalidInput(format!(
        "workspace {workspace_id} has no active lifecycle actor for template materialization"
      ))
    })
  }

  /// Apply a server-owned retirement transition for a builtin instance.
  #[instrument(skip(self), fields(%workspace_id, %slug))]
  async fn retire_builtin_instance(&self, workspace_id: WorkspaceId, slug: &str) -> AuthResult<()> {
    sqlx::query(
      r#"
            UPDATE workspace_template_instances i
            SET state = 'retired', retired_at = now(), updated_at = now()
            FROM template_catalog_entries c
            WHERE c.id = i.template_id
              AND c.slug = $2
              AND i.workspace_id = $1
              AND i.retired_at IS NULL
            "#,
    )
    .bind(workspace_id)
    .bind(slug)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    debug!(%workspace_id, %slug, "builtin instance retired");
    Ok(())
  }

  // ── Bulk Discovery ──────────────────────────────────────────────────

  #[instrument(skip(self))]
  async fn list_distinct_policy_workspace_ids(&self) -> AuthResult<Vec<myoxus_domain::ids::WorkspaceId>> {
    let rows: Vec<(uuid::Uuid,)> =
      sqlx::query_as("SELECT DISTINCT workspace_id FROM workspace_template_policies WHERE is_enabled = true")
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    let ids: Vec<uuid::Uuid> = rows.into_iter().map(|(id,)| id).collect();
    trace!(count = ids.len(), "distinct policy workspace IDs listed");
    Ok(ids)
  }

  #[instrument(skip(self))]
  async fn list_distinct_instance_workspace_ids(&self) -> AuthResult<Vec<myoxus_domain::ids::WorkspaceId>> {
    let rows: Vec<(uuid::Uuid,)> =
      sqlx::query_as("SELECT DISTINCT workspace_id FROM workspace_template_instances WHERE state NOT IN ('retired')")
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    let ids: Vec<uuid::Uuid> = rows.into_iter().map(|(id,)| id).collect();
    trace!(count = ids.len(), "distinct instance workspace IDs listed");
    Ok(ids)
  }
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn template_status_roundtrip() {
    for status in [
      TemplateStatus::Active,
      TemplateStatus::Disabled,
      TemplateStatus::Archived,
    ] {
      let db = template_status_to_db(status);
      let back = template_status_from_db(db).unwrap();
      assert_eq!(status, back);
    }
    assert!(template_status_from_db("invalid").is_err());
  }

  #[test]
  fn revision_state_roundtrip() {
    for state in [
      RevisionState::Draft,
      RevisionState::Validated,
      RevisionState::Published,
      RevisionState::Deprecated,
      RevisionState::Archived,
    ] {
      let db = revision_state_to_db(state);
      let back = revision_state_from_db(db).unwrap();
      assert_eq!(state, back);
    }
    assert!(revision_state_from_db("invalid").is_err());
  }

  #[test]
  fn selection_mode_roundtrip() {
    for mode in [SelectionMode::Published, SelectionMode::PinnedRevision] {
      let db = selection_mode_to_db(mode);
      let back = selection_mode_from_db(db).unwrap();
      assert_eq!(mode, back);
    }
    assert!(selection_mode_from_db("invalid").is_err());
  }

  #[test]
  fn provisioning_mode_roundtrip() {
    for mode in [
      ProvisioningMode::SeedOnce,
      ProvisioningMode::ManagedUntilLocalEdit,
      ProvisioningMode::ManualUpdate,
    ] {
      let db = provisioning_mode_to_db(mode);
      let back = provisioning_mode_from_db(db).unwrap();
      assert_eq!(mode, back);
    }
    assert!(provisioning_mode_from_db("invalid").is_err());
  }

  #[test]
  fn instance_state_roundtrip() {
    for state in [
      InstanceState::Ok,
      InstanceState::UpdateAvailable,
      InstanceState::Detached,
      InstanceState::Retired,
      InstanceState::Error,
    ] {
      let db = instance_state_to_db(state);
      let back = instance_state_from_db(db).unwrap();
      assert_eq!(state, back);
    }
    assert!(instance_state_from_db("invalid").is_err());
  }

  #[test]
  fn reconcile_scope_roundtrip() {
    for scope in [
      ReconcileScope::Workspace,
      ReconcileScope::Template,
      ReconcileScope::Global,
    ] {
      let db = reconcile_scope_to_db(scope);
      let back = reconcile_scope_from_db(db).unwrap();
      assert_eq!(scope, back);
    }
    assert!(reconcile_scope_from_db("invalid").is_err());
  }

  #[test]
  fn job_state_roundtrip() {
    for state in [
      JobState::Pending,
      JobState::Running,
      JobState::Completed,
      JobState::Failed,
      JobState::Cancelled,
    ] {
      let db = job_state_to_db(state);
      let back = job_state_from_db(db).unwrap();
      assert_eq!(state, back);
    }
    assert!(job_state_from_db("invalid").is_err());
  }

  #[test]
  fn job_state_legacy_aliases_map_to_running() {
    assert_eq!(job_state_from_db("validating").unwrap(), JobState::Running);
    assert_eq!(job_state_from_db("importing").unwrap(), JobState::Running);
  }

  #[test]
  fn audit_action_roundtrip() {
    for action in [
      TemplateRegistryAuditAction::Created,
      TemplateRegistryAuditAction::Updated,
      TemplateRegistryAuditAction::Deleted,
      TemplateRegistryAuditAction::Imported,
      TemplateRegistryAuditAction::Validated,
      TemplateRegistryAuditAction::Published,
      TemplateRegistryAuditAction::Assigned,
      TemplateRegistryAuditAction::Reconciled,
      TemplateRegistryAuditAction::Scanned,
      TemplateRegistryAuditAction::Detached,
      TemplateRegistryAuditAction::Exported,
      TemplateRegistryAuditAction::Failed,
    ] {
      let db = audit_action_to_db(action);
      let back = audit_action_from_db(db).unwrap();
      assert_eq!(action, back);
    }
    assert!(audit_action_from_db("invalid").is_err());
  }

  #[test]
  fn normalization_warnings_json_roundtrip() {
    let warnings = vec![
      NormalizationWarning {
        code: "TRIMMED_TITLE".to_string(),
        message: "title was trimmed during normalization".to_string(),
        field: Some("title".to_string()),
        path: Some("/manifest/title".to_string()),
      },
      NormalizationWarning {
        code: "REMOVED_NOISE".to_string(),
        message: "ignored non-semantic zip entry".to_string(),
        field: None,
        path: None,
      },
    ];

    let json = serde_json::to_value(sqlx::types::Json(&warnings)).unwrap();
    let back: sqlx::types::Json<Vec<NormalizationWarning>> = serde_json::from_value(json).unwrap();
    assert_eq!(back.0, warnings);
  }
}

/// A receipt is immutable acceptance evidence, not a Registry lifecycle owner.
/// Caller holds catalog then revision locks; this fresh read takes no receipt lock.
async fn accepted_document_revision_pin(tx: &mut sqlx::PgConnection, revision: Uuid) -> AuthResult<bool> {
  sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_starter_applications WHERE operation IN ('create_project','create_workspace','prepare_documents') AND (project_plan->'documents' @> jsonb_build_array(jsonb_build_object('sourceRevisionId',$1::text)) OR workspace_plan->'project'->'documentMetadata' @> jsonb_build_array(jsonb_build_object('sourceRevisionId',$1::text)) OR workspace_plan->'setup'->'documentMetadata' @> jsonb_build_array(jsonb_build_object('sourceRevisionId',$1::text)) OR setup_plan->'documents' @> jsonb_build_array(jsonb_build_object('sourceRevisionId',$1::text)))) OR EXISTS(SELECT 1 FROM workspace_automations a CROSS JOIN LATERAL jsonb_array_elements(a.actions_json) effect WHERE effect->'config'->'source'->>'sourceRevisionId'=$1::text) OR EXISTS(SELECT 1 FROM workspace_automation_runs r CROSS JOIN LATERAL jsonb_array_elements(r.accepted_json->'definition'->'actions') effect WHERE effect->'config'->'source'->>'sourceRevisionId'=$1::text)")
    .bind(revision).fetch_one(tx).await.map_err(SqlxTemplateRegistryStore::map_db_err)
}

/// Caller already holds the native catalog and exact revision locks.
pub(crate) async fn locked_project_source_digest(tx: &mut sqlx::PgConnection, revision: Uuid) -> AuthResult<String> {
  let row = sqlx::query("SELECT * FROM template_revisions WHERE id=$1")
    .bind(revision)
    .fetch_one(tx)
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
  let revision = SqlxTemplateRegistryStore::map_revision_row(row)?;
  Ok(myoxus_application::template_registry::template_revision_source_digest(
    &revision,
  ))
}
