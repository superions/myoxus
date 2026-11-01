//! SQLx repository for the server-authoritative workspace tag catalog.

use std::str::FromStr;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::ids::{UserId, WorkspaceId};
use myoxus_domain::repositories::{PageRequest, RepoResult, RepositoryError};
use myoxus_domain::workspace_tags::{
  WORKSPACE_TAG_DOCUMENT_BATCH_LIMIT, WorkspaceTag, WorkspaceTagAssignmentError, WorkspaceTagCatalogEntry,
  WorkspaceTagColorRole, WorkspaceTagDatabaseRowUsage, WorkspaceTagDeletionResult, WorkspaceTagDocumentAssignment,
  WorkspaceTagDocumentUsage, WorkspaceTagRepository, WorkspaceTagSearchRefreshScope, validate_tag_reference_update,
};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};
use tracing::{debug, instrument};
use uuid::Uuid;

use crate::doc::SqlxDocStore;
use crate::workspace_database::PgDatabaseRepository;
use myoxus_application::workspace_tags::migration::{
  LabelInspection, LabelMigrationRepository, LabelMigrationSnapshot, LabelRepairDecision, LabelRepairResult,
};
use myoxus_workspace_import::WorkspaceImportLimits;

pub struct PgWorkspaceTagRepository {
  pool: PgPool,
  database_templates: std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
}

impl PgWorkspaceTagRepository {
  pub fn new(
    pool: PgPool,
    database_templates: std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  ) -> Self {
    Self {
      pool,
      database_templates,
    }
  }

  async fn label_migration_snapshot_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    limits: WorkspaceImportLimits,
  ) -> RepoResult<LabelMigrationSnapshot> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = $1)")
      .bind(workspace_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    if !exists {
      return Err(RepositoryError::NotFound("workspace"));
    }
    let payload: Option<String> = sqlx::query_scalar(
      "WITH assignments AS (
         SELECT d.id AS doc_id, d.external_id,
           COALESCE(array_agg(a.tag_id ORDER BY a.position)
             FILTER (WHERE a.tag_id IS NOT NULL), '{}'::uuid[]) AS tag_ids
         FROM docs d LEFT JOIN workspace_tag_document_assignments a
           ON a.workspace_id = d.workspace_id AND a.doc_id = d.id
         WHERE d.workspace_id = $1 AND NOT d.is_workspace_root
         GROUP BY d.id, d.external_id
       ), projection AS (
         SELECT jsonb_build_array(
           COALESCE((SELECT jsonb_agg(t ORDER BY t.id) FROM workspace_tags t WHERE t.workspace_id = $1), '[]'),
           COALESCE((SELECT jsonb_agg(a ORDER BY a.external_id) FROM assignments a), '[]'),
           COALESCE((SELECT jsonb_object_agg(legacy_id, tag_id) FROM workspace_tag_legacy_ids WHERE workspace_id = $1), '{}'),
           COALESCE((SELECT jsonb_agg(retired_tag_id ORDER BY retired_tag_id) FROM workspace_tag_retired_ids WHERE workspace_id = $1), '[]')
         )::text AS payload
       ) SELECT CASE WHEN octet_length(payload) <= $2 AND (SELECT count(*) FROM assignments) <= $3
         THEN payload ELSE NULL END FROM projection",
    ).bind(workspace_id).bind(i64::try_from(limits.max_document_bytes).unwrap_or(i64::MAX))
      .bind(i64::try_from(limits.max_documents).unwrap_or(i64::MAX))
      .fetch_one(&mut **tx).await.map_err(Self::map_sqlx_error)?;
    let payload =
      payload.ok_or_else(|| RepositoryError::Validation("label inspection exceeds metadata/document limits".into()))?;
    let (catalog, documents, legacy_ids, retired_ids) = serde_json::from_str(&payload)
      .map_err(|_| RepositoryError::Validation("stored label inspection metadata is invalid".into()))?;
    // Check the persisted stream before allocating/merging it. Inspection and
    // apply use one transaction snapshot; compaction cannot swap the checked tail.
    let within_bounds: bool = sqlx::query_scalar(
      "WITH snapshot AS (
         SELECT payload, last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $1
       ), sizes AS (
         SELECT octet_length(payload)::bigint AS bytes FROM snapshot
         UNION ALL SELECT octet_length(payload)::bigint FROM doc_updates
         WHERE workspace_id = $1 AND doc_id = $1
           AND sequence > COALESCE((SELECT last_sequence FROM snapshot), -1)
       ) SELECT COALESCE(sum(bytes), 0) <= $2 AND count(*) <= $3 FROM sizes",
    )
    .bind(workspace_id)
    .bind(i64::try_from(limits.max_document_bytes).unwrap_or(i64::MAX))
    .bind(i64::try_from(limits.max_archive_entries).unwrap_or(i64::MAX))
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if !within_bounds {
      return Err(RepositoryError::Validation(
        "workspace root exceeds inspection limits".into(),
      ));
    }
    let (root, root_revision) = SqlxDocStore::load_label_reconciliation_root_in_tx(tx, workspace_id)
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    Ok(LabelMigrationSnapshot {
      workspace_id,
      catalog,
      documents,
      legacy_ids,
      retired_ids,
      root,
      root_revision,
    })
  }

  /// Explicit transfer only: validated archived source references are portable.
  /// The workspace lock serializes catalog reuse; document locks serialize sets.
  pub(crate) async fn import_tags_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    actor: Uuid,
    tags: &[WorkspaceTag],
    assignments: &[(Uuid, Vec<Uuid>)],
  ) -> RepoResult<Vec<WorkspaceTag>> {
    sqlx::query("SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE")
      .bind(workspace_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut confirmed = Vec::with_capacity(tags.len());
    for tag in tags {
      if tag.workspace_id != workspace_id || Self::is_retired_id_in_tx(tx, workspace_id, &tag.id.to_string()).await? {
        return Err(RepositoryError::Validation(
          "invalid or retired imported label identity".into(),
        ));
      }
      let existing = sqlx::query(&format!("{} WHERE id = $1 FOR SHARE", Self::SELECT_TAG))
        .bind(tag.id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      if let Some(existing) = existing {
        if existing.get::<Uuid, _>("workspace_id") != workspace_id {
          return Err(RepositoryError::Validation(
            "imported label belongs to another workspace".into(),
          ));
        }
        confirmed.push(Self::row_to_tag(&existing)?);
      } else {
        // A concurrent deletion may have completed while the catalog lock was
        // awaited. Its retirement ledger must be checked in that new snapshot.
        if Self::is_retired_id_in_tx(tx, workspace_id, &tag.id.to_string()).await? {
          return Err(RepositoryError::Validation("imported label identity is retired".into()));
        }
        let mut tag = tag.clone();
        tag.slug = Self::available_slug_in_tx(tx, workspace_id, &tag.slug).await?;
        let row = Self::insert_tag_in_tx(tx, &tag).await.map_err(Self::map_sqlx_error)?;
        confirmed.push(Self::row_to_tag(&row)?);
      }
    }
    let mut assignments = assignments.iter().collect::<Vec<_>>();
    assignments.sort_by_key(|(doc, _)| *doc);
    for (doc_id, ids) in assignments {
      sqlx::query("SELECT id FROM docs WHERE workspace_id = $1 AND id = $2 AND NOT is_workspace_root FOR UPDATE")
        .bind(workspace_id)
        .bind(doc_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      // Passing validated portable IDs as previous retains archived references
      // without weakening ordinary live replacement's archived-write rule.
      Self::validate_references_in_tx(tx, workspace_id, ids, ids)
        .await
        .map_err(|error| RepositoryError::Validation(error.to_string()))?;
      sqlx::query("DELETE FROM workspace_tag_document_assignments WHERE workspace_id = $1 AND doc_id = $2")
        .bind(workspace_id)
        .bind(doc_id)
        .execute(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?;
      for (position, id) in ids.iter().enumerate() {
        Self::insert_document_assignment_in_tx(
          tx,
          workspace_id,
          *doc_id,
          *id,
          i32::try_from(position).map_err(|_| RepositoryError::Validation("too many imported labels".into()))?,
          Some(actor),
        )
        .await
        .map_err(Self::map_sqlx_error)?;
      }
    }
    Ok(confirmed)
  }

  /// Inserts a prepared catalog record in the caller's content/import transaction.
  /// Identity mapping and validation remain with the caller; this never commits.
  pub(crate) async fn insert_tag_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tag: &WorkspaceTag,
  ) -> Result<PgRow, sqlx::Error> {
    Self::insert_tag_with_conflict_policy_in_tx(tx, tag, false)
      .await?
      .ok_or(sqlx::Error::RowNotFound)
  }

  /// Transfer can resolve ordinary namespace races. Under SERIALIZABLE,
  /// ON CONFLICT turns a concurrent invisible winner into a serialization
  /// retry instead of a terminal uniqueness failure. Ordinary writes keep
  /// their explicit duplicate contract through insert_tag_in_tx above.
  pub(crate) async fn insert_transfer_tag_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tag: &WorkspaceTag,
  ) -> Result<Option<PgRow>, sqlx::Error> {
    Self::insert_tag_with_conflict_policy_in_tx(tx, tag, true).await
  }

  async fn insert_tag_with_conflict_policy_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    tag: &WorkspaceTag,
    ignore_conflicts: bool,
  ) -> Result<Option<PgRow>, sqlx::Error> {
    let conflict_clause = if ignore_conflicts { "ON CONFLICT DO NOTHING" } else { "" };
    sqlx::query(&format!(
      r#"
      INSERT INTO workspace_tags
        (id, workspace_id, name, slug, color_role, description, archived_at,
         created_at, updated_at, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      {conflict_clause}
      RETURNING id, workspace_id, name, slug, color_role, description,
                archived_at, created_at, updated_at, created_by, updated_by
      "#,
    ))
    .bind(tag.id)
    .bind(tag.workspace_id)
    .bind(&tag.name)
    .bind(&tag.slug)
    .bind(tag.color_role.as_str())
    .bind(&tag.description)
    .bind(tag.archived_at)
    .bind(tag.created_at)
    .bind(tag.updated_at)
    .bind(tag.created_by)
    .bind(tag.updated_by)
    .fetch_optional(&mut **tx)
    .await
  }

  /// Inserts one ordered assignment without replacing or committing sibling content.
  /// The caller owns document/tag validation and the position conversion.
  pub(crate) async fn insert_document_assignment_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: WorkspaceId,
    doc_id: Uuid,
    tag_id: Uuid,
    position: i32,
    actor: Option<UserId>,
  ) -> Result<(), sqlx::Error> {
    sqlx::query(
      "INSERT INTO workspace_tag_document_assignments
        (workspace_id, doc_id, tag_id, position, created_by)
       VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(tag_id)
    .bind(position)
    .bind(actor)
    .execute(&mut **tx)
    .await?;
    Ok(())
  }

  /// Lock catalog rows in stable UUID order until the caller commits, preventing
  /// archive/delete from racing validation. Callers lock their document/row first.
  pub(crate) async fn validate_references_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: WorkspaceId,
    previous_ids: &[Uuid],
    next_ids: &[Uuid],
  ) -> Result<Vec<WorkspaceTag>, WorkspaceTagAssignmentError> {
    let sql = format!(
      "{} WHERE workspace_id = $1 AND id = ANY($2) ORDER BY id FOR SHARE",
      Self::SELECT_TAG
    );
    let rows = sqlx::query(&sql)
      .bind(workspace_id)
      .bind(next_ids)
      .fetch_all(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut tags = rows.iter().map(Self::row_to_tag).collect::<RepoResult<Vec<_>>>()?;
    validate_tag_reference_update(previous_ids, next_ids, &tags)?;
    tags.sort_by_key(|tag| next_ids.iter().position(|id| *id == tag.id));
    Ok(tags)
  }

  /// Serializes complete replacement on the document, including empty assignments.
  /// Validation and all inserts share the caller's transaction and catalog locks.
  pub(crate) async fn replace_document_tags_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: WorkspaceId,
    doc_id: Uuid,
    tag_ids: &[Uuid],
    actor: Option<UserId>,
  ) -> Result<Vec<WorkspaceTag>, WorkspaceTagAssignmentError> {
    let found = sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM docs WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
       AND NOT is_workspace_root FOR UPDATE",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    if found.is_none() {
      return Err(RepositoryError::NotFound("workspace document").into());
    }
    let previous_ids = sqlx::query_scalar::<_, Uuid>(
      "SELECT tag_id FROM workspace_tag_document_assignments WHERE workspace_id = $1 AND doc_id = $2 ORDER BY position",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let tags = Self::validate_references_in_tx(tx, workspace_id, &previous_ids, tag_ids).await?;
    sqlx::query("DELETE FROM workspace_tag_document_assignments WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    for (position, tag_id) in tag_ids.iter().enumerate() {
      let position = i32::try_from(position).map_err(|_| WorkspaceTagAssignmentError::InvalidReferences)?;
      Self::insert_document_assignment_in_tx(tx, workspace_id, doc_id, *tag_id, position, actor)
        .await
        .map_err(Self::map_sqlx_error)?;
    }
    Ok(tags)
  }

  fn map_sqlx_error(error: sqlx::Error) -> RepositoryError {
    if let sqlx::Error::Database(database) = &error
      && database
        .code()
        .is_some_and(|code| matches!(code.as_ref(), "23503" | "23505" | "23514"))
    {
      debug!(constraint = ?database.constraint(), "workspace tag constraint violation");
      return RepositoryError::Conflict("workspace tag constraint violation");
    }
    RepositoryError::Storage(error.to_string())
  }

  pub(crate) fn row_to_tag(row: &PgRow) -> RepoResult<WorkspaceTag> {
    let color_role = WorkspaceTagColorRole::from_str(row.get::<&str, _>("color_role"))
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Ok(WorkspaceTag {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      name: row.get("name"),
      slug: row.get("slug"),
      color_role,
      description: row.get("description"),
      archived_at: row.get("archived_at"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
      created_by: row.get("created_by"),
      updated_by: row.get("updated_by"),
    })
  }

  fn row_to_catalog_entry(row: &PgRow) -> RepoResult<WorkspaceTagCatalogEntry> {
    Ok(WorkspaceTagCatalogEntry {
      tag: Self::row_to_tag(row)?,
      document_count: row.get("document_count"),
      database_row_count: row.get("database_row_count"),
    })
  }

  pub(crate) const SELECT_TAG: &'static str = r#"
    SELECT id, workspace_id, name, slug, color_role, description,
           archived_at, created_at, updated_at, created_by, updated_by
      FROM workspace_tags
  "#;

  pub(crate) async fn available_slug_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: WorkspaceId,
    base: &str,
  ) -> RepoResult<String> {
    for suffix in 1..=10_000_u32 {
      let candidate = if suffix == 1 {
        base.to_string()
      } else {
        format!("{base}-{suffix}")
      };
      let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_tags WHERE workspace_id = $1 AND slug = $2 AND archived_at IS NULL)",
      )
      .bind(workspace_id)
      .bind(&candidate)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      if !exists {
        return Ok(candidate);
      }
    }
    Err(RepositoryError::Conflict("workspace tag slug space exhausted"))
  }

  pub(crate) async fn is_retired_id_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: WorkspaceId,
    candidate: &str,
  ) -> RepoResult<bool> {
    sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_tag_retired_ids WHERE workspace_id = $1 AND retired_tag_id = $2)",
    )
    .bind(workspace_id)
    .bind(candidate)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)
  }
}

#[async_trait]
impl LabelMigrationRepository for PgWorkspaceTagRepository {
  #[instrument(skip_all, fields(%workspace_id))]
  async fn inspect_labels(&self, workspace_id: Uuid, limits: WorkspaceImportLimits) -> RepoResult<LabelInspection> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let snapshot = Self::label_migration_snapshot_in_tx(&mut tx, workspace_id, limits).await?;
    let inspection = myoxus_application::workspace_tags::migration::inspect(&snapshot, limits)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(inspection)
  }

  #[instrument(skip_all, fields(workspace_id = %decision.workspace_id, documents = decision.documents.len()))]
  async fn apply_label_repair(
    &self,
    actor: Uuid,
    decision: &LabelRepairDecision,
    cutover_acknowledged: bool,
    limits: WorkspaceImportLimits,
  ) -> RepoResult<LabelRepairResult> {
    use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
    let size = serde_json::to_vec(decision)
      .map_err(|_| RepositoryError::Validation("invalid repair decision".into()))?
      .len();
    if decision.documents.len() > limits.max_documents || size as u64 > limits.max_document_bytes {
      return Err(RepositoryError::Validation(
        "repair decision exceeds metadata/document limits".into(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    // Serializable validation also covers catalog/assignment changes outside
    // the selected rows. Conflicts fail closed; the operator must inspect again.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    SqlxDocStore::lock_workspace_root_in_tx(&mut tx, decision.workspace_id)
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let snapshot = Self::label_migration_snapshot_in_tx(&mut tx, decision.workspace_id, limits).await?;
    let plan = myoxus_application::workspace_tags::migration::plan_repair(
      &snapshot,
      actor,
      decision,
      cutover_acknowledged,
      limits,
    )?;
    if !plan.result.changed {
      tx.rollback().await.map_err(Self::map_sqlx_error)?;
      return Ok(plan.result);
    }
    // Explicit, inspected operator decisions may retain archived references
    // represented by either source. The live assignment rule is unchanged.
    Self::import_tags_in_tx(&mut tx, decision.workspace_id, actor, &plan.tags, &plan.assignments).await?;
    for (legacy_id, tag_id) in &plan.mappings {
      sqlx::query(
        "INSERT INTO workspace_tag_legacy_ids (workspace_id, legacy_id, tag_id)
                   VALUES ($1, $2, $3) ON CONFLICT (workspace_id, legacy_id) DO NOTHING",
      )
      .bind(decision.workspace_id)
      .bind(legacy_id)
      .bind(tag_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    SqlxDocStore::append_label_reconciliation_in_tx(&mut tx, decision.workspace_id, actor, plan.root_delta)
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let event = AuditEvent::mutation(
      "workspace.labels_reconcile",
      AuditCategory::Workspace,
      Some(AuditTarget::entity("workspace", decision.workspace_id, None)),
      AuditActor::user(actor, None),
      Some(serde_json::json!({"sqlRevision": decision.sql_revision, "rootRevision": decision.root_revision})),
      Some(
        serde_json::json!({"documents": plan.result.documents, "importedTags": plan.result.imported_tags,
        "rootCatalogRemoved": plan.result.root_catalog_removed}),
      ),
    );
    crate::audit::PgAuditLogStore::record_in_tx(&mut tx, &event)
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(plan.result)
  }
}

#[async_trait]
impl WorkspaceTagRepository for PgWorkspaceTagRepository {
  #[instrument(skip_all, fields(%workspace_id, count = keys.len()))]
  async fn export_tags(
    &self,
    workspace_id: WorkspaceId,
    keys: &[DocumentKey],
    max_bytes: u64,
  ) -> RepoResult<(Vec<WorkspaceTag>, Vec<WorkspaceTagDocumentAssignment>)> {
    // A single statement gives catalog and assignments the same MVCC snapshot;
    // concurrent replacement/deletion cannot produce dangling portable IDs.
    let payload: Option<String> = sqlx::query_scalar(
      "WITH assignments AS (
         SELECT d.id AS doc_id, d.external_id,
           COALESCE(array_agg(a.tag_id ORDER BY a.position)
             FILTER (WHERE a.tag_id IS NOT NULL), '{}'::uuid[]) AS tag_ids
         FROM docs d LEFT JOIN workspace_tag_document_assignments a
           ON a.workspace_id = d.workspace_id AND a.doc_id = d.id
         WHERE d.workspace_id = $1 AND d.external_id = ANY($2) AND NOT d.is_workspace_root
         GROUP BY d.id, d.external_id
       ), projection AS (
         SELECT jsonb_build_array(
           COALESCE((SELECT jsonb_agg(t ORDER BY t.id) FROM workspace_tags t WHERE t.workspace_id = $1), '[]'),
           COALESCE((SELECT jsonb_agg(a ORDER BY a.external_id) FROM assignments a), '[]')
         )::text AS payload
       ) SELECT CASE WHEN octet_length(payload) <= $3 THEN payload ELSE NULL END FROM projection",
    )
    .bind(workspace_id)
    .bind(keys.iter().map(DocumentKey::as_str).collect::<Vec<_>>())
    .bind(i64::try_from(max_bytes).unwrap_or(i64::MAX))
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    let payload =
      payload.ok_or_else(|| RepositoryError::Validation("portable label export exceeds metadata limits".into()))?;
    serde_json::from_str(&payload).map_err(|_| RepositoryError::Validation("invalid stored label projection".into()))
  }

  async fn import_tags(
    &self,
    workspace_id: WorkspaceId,
    actor: UserId,
    tags: &[WorkspaceTag],
    assignments: &[(Uuid, Vec<Uuid>)],
  ) -> RepoResult<Vec<WorkspaceTag>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    let confirmed = Self::import_tags_in_tx(&mut tx, workspace_id, actor, tags, assignments).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(confirmed)
  }

  #[instrument(skip_all, fields(workspace_id = %tag.workspace_id, tag_id = %tag.id))]
  async fn create_tag(&self, tag: &WorkspaceTag) -> RepoResult<WorkspaceTag> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    let row = Self::insert_tag_in_tx(&mut tx, tag)
      .await
      .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Self::row_to_tag(&row)
  }

  #[instrument(skip_all, fields(%workspace_id, %tag_id, actor_id = %actor))]
  async fn update_tag_name(
    &self,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    name: &str,
    slug: &str,
    actor: UserId,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag> {
    let row = sqlx::query(
      r#"
      UPDATE workspace_tags
         SET name = $3, slug = $4, updated_by = $5, updated_at = $6
       WHERE workspace_id = $1 AND id = $2
      RETURNING id, workspace_id, name, slug, color_role, description,
                archived_at, created_at, updated_at, created_by, updated_by
      "#,
    )
    .bind(workspace_id)
    .bind(tag_id)
    .bind(name)
    .bind(slug)
    .bind(actor)
    .bind(updated_at)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("workspace tag"))?;
    Self::row_to_tag(&row)
  }

  #[instrument(skip_all, fields(%workspace_id, %tag_id, actor_id = %actor))]
  async fn update_tag_color(
    &self,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    color_role: WorkspaceTagColorRole,
    actor: UserId,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag> {
    let row = sqlx::query(
      r#"
      UPDATE workspace_tags
         SET color_role = $3, updated_by = $4, updated_at = $5
       WHERE workspace_id = $1 AND id = $2
      RETURNING id, workspace_id, name, slug, color_role, description,
                archived_at, created_at, updated_at, created_by, updated_by
      "#,
    )
    .bind(workspace_id)
    .bind(tag_id)
    .bind(color_role.as_str())
    .bind(actor)
    .bind(updated_at)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("workspace tag"))?;
    Self::row_to_tag(&row)
  }

  #[instrument(skip_all, fields(%workspace_id, %tag_id, actor_id = %actor))]
  async fn update_tag_description(
    &self,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    description: Option<&str>,
    actor: UserId,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag> {
    let row = sqlx::query(
      r#"
      UPDATE workspace_tags
         SET description = $3, updated_by = $4, updated_at = $5
       WHERE workspace_id = $1 AND id = $2
      RETURNING id, workspace_id, name, slug, color_role, description,
                archived_at, created_at, updated_at, created_by, updated_by
      "#,
    )
    .bind(workspace_id)
    .bind(tag_id)
    .bind(description)
    .bind(actor)
    .bind(updated_at)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("workspace tag"))?;
    Self::row_to_tag(&row)
  }

  #[instrument(skip_all, fields(%workspace_id, %tag_id, actor_id = %actor))]
  async fn archive_tag(
    &self,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    actor: UserId,
    archived_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag> {
    let row = sqlx::query(
      r#"
      UPDATE workspace_tags
         SET archived_at = COALESCE(archived_at, $3), updated_by = $4, updated_at = $3
       WHERE workspace_id = $1 AND id = $2
      RETURNING id, workspace_id, name, slug, color_role, description,
                archived_at, created_at, updated_at, created_by, updated_by
      "#,
    )
    .bind(workspace_id)
    .bind(tag_id)
    .bind(archived_at)
    .bind(actor)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("workspace tag"))?;
    Self::row_to_tag(&row)
  }

  #[instrument(skip_all, fields(%workspace_id, %tag_id, actor_id = %actor))]
  async fn restore_tag(
    &self,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    slug: &str,
    actor: UserId,
    updated_at: DateTime<Utc>,
  ) -> RepoResult<WorkspaceTag> {
    let row = sqlx::query(
      r#"
      UPDATE workspace_tags
         SET archived_at = NULL, slug = $3, updated_by = $4, updated_at = $5
       WHERE workspace_id = $1 AND id = $2
      RETURNING id, workspace_id, name, slug, color_role, description,
                archived_at, created_at, updated_at, created_by, updated_by
      "#,
    )
    .bind(workspace_id)
    .bind(tag_id)
    .bind(slug)
    .bind(actor)
    .bind(updated_at)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("workspace tag"))?;
    Self::row_to_tag(&row)
  }

  #[instrument(skip_all, fields(%workspace_id, %tag_id, actor_id = %actor))]
  async fn delete_archived_tag(
    &self,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    actor: UserId,
  ) -> RepoResult<Option<WorkspaceTagDeletionResult>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    let databases = PgDatabaseRepository::new(self.pool.clone(), self.database_templates.clone());
    databases.capture_managed_admission(&mut tx).await?;
    // Acquire current container authority before the Tag/Cell locks. A move or
    // schema update cannot then commit behind this cleanup's owner decision.
    let owners = sqlx::query("SELECT d.id,COALESCE(p.profile_kind,'generic') AS profile_kind,myoxus_database_source_admitted(d.managed_installation) AS admitted FROM workspace_databases d LEFT JOIN database_profiles p ON p.database_id=d.id WHERE d.workspace_id=$1 AND EXISTS(SELECT 1 FROM workspace_database_cell_values cell JOIN workspace_database_fields field ON field.id=cell.field_id AND field.field_type='tags' WHERE cell.database_id=d.id AND cell.value_json @> jsonb_build_array($2::text)) ORDER BY d.id FOR KEY SHARE OF d")
      .bind(workspace_id).bind(tag_id.to_string()).fetch_all(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    for owner in owners {
      if owner.get::<String, _>("profile_kind") == "project" && !owner.get::<bool, _>("admitted") {
        return Err(RepositoryError::Validation(
          "managed schema unavailable during tag cleanup".into(),
        ));
      }
    }
    let archived_at = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
      "SELECT archived_at FROM workspace_tags WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(tag_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let Some(Some(_)) = archived_at else {
      tx.rollback().await.map_err(Self::map_sqlx_error)?;
      return Ok(None);
    };

    let mut retired_ids = vec![tag_id.to_string()];
    retired_ids.extend(
      sqlx::query_scalar::<_, String>(
        "SELECT legacy_id FROM workspace_tag_legacy_ids WHERE workspace_id = $1 AND tag_id = $2 ORDER BY legacy_id",
      )
      .bind(workspace_id)
      .bind(tag_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?,
    );
    retired_ids.sort();
    retired_ids.dedup();
    for retired_id in &retired_ids {
      sqlx::query(
        r#"
          INSERT INTO workspace_tag_retired_ids (workspace_id, retired_tag_id, retired_at)
          VALUES ($1, $2, now())
          ON CONFLICT (workspace_id, retired_tag_id) DO NOTHING
        "#,
      )
      .bind(workspace_id)
      .bind(retired_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }

    sqlx::query("DELETE FROM workspace_tag_document_assignments WHERE workspace_id = $1 AND tag_id = $2")
      .bind(workspace_id)
      .bind(tag_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let affected_database_ids =
      PgDatabaseRepository::remove_workspace_tag_from_cells_in_tx(&mut tx, workspace_id, tag_id, actor).await?;
    SqlxDocStore::remove_workspace_tags_from_root_in_tx(&mut tx, workspace_id, tag_id, actor, &retired_ids)
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let deleted = sqlx::query("DELETE FROM workspace_tags WHERE workspace_id = $1 AND id = $2")
      .bind(workspace_id)
      .bind(tag_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    if deleted.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("workspace tag"));
    }
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(Some(WorkspaceTagDeletionResult {
      tag_id,
      affected_database_ids,
    }))
  }

  #[instrument(skip_all, fields(%workspace_id, %tag_id))]
  async fn get_tag(&self, workspace_id: WorkspaceId, tag_id: Uuid) -> RepoResult<Option<WorkspaceTag>> {
    let sql = format!("{} WHERE workspace_id = $1 AND id = $2", Self::SELECT_TAG);
    sqlx::query(&sql)
      .bind(workspace_id)
      .bind(tag_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)?
      .map(|row| Self::row_to_tag(&row))
      .transpose()
  }

  #[instrument(skip_all, fields(%workspace_id, slug))]
  async fn get_tag_by_slug(&self, workspace_id: WorkspaceId, slug: &str) -> RepoResult<Option<WorkspaceTag>> {
    let sql = format!(
      "{} WHERE workspace_id = $1 AND slug = $2 AND archived_at IS NULL",
      Self::SELECT_TAG
    );
    sqlx::query(&sql)
      .bind(workspace_id)
      .bind(slug)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)?
      .map(|row| Self::row_to_tag(&row))
      .transpose()
  }

  #[instrument(skip_all, fields(%workspace_id, include_archived))]
  async fn list_tags(&self, workspace_id: WorkspaceId, include_archived: bool) -> RepoResult<Vec<WorkspaceTag>> {
    let sql = format!(
      "{} WHERE workspace_id = $1 AND ($2 OR archived_at IS NULL) ORDER BY archived_at NULLS FIRST, lower(name), id",
      Self::SELECT_TAG
    );
    sqlx::query(&sql)
      .bind(workspace_id)
      .bind(include_archived)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)?
      .iter()
      .map(Self::row_to_tag)
      .collect()
  }

  #[instrument(skip_all, fields(%workspace_id, include_archived))]
  async fn list_tag_catalog(
    &self,
    workspace_id: WorkspaceId,
    include_archived: bool,
  ) -> RepoResult<Vec<WorkspaceTagCatalogEntry>> {
    let rows = sqlx::query(
      r#"
      WITH document_usage AS (
        SELECT assignment.tag_id,
               COUNT(DISTINCT assignment.doc_id)::bigint AS document_count
          FROM workspace_tag_document_assignments assignment
          JOIN docs document
            ON document.id = assignment.doc_id
           AND document.workspace_id = assignment.workspace_id
           AND document.deleted_at IS NULL
         WHERE assignment.workspace_id = $1
         GROUP BY assignment.tag_id
      ), database_row_usage AS (
        SELECT reference.tag_id,
               COUNT(DISTINCT (reference.database_id, reference.row_id))::bigint
                 AS database_row_count
          FROM database_row_tag_references reference
          JOIN workspace_databases database
            ON database.id = reference.database_id
           AND database.workspace_id = reference.workspace_id
           AND database.deleted_at IS NULL
          JOIN workspace_database_rows row
            ON row.id = reference.row_id
           AND row.database_id = reference.database_id
           AND row.deleted_at IS NULL
         WHERE reference.workspace_id = $1
         GROUP BY reference.tag_id
      )
      SELECT tag.id, tag.workspace_id, tag.name, tag.slug, tag.color_role,
             tag.description, tag.archived_at, tag.created_at, tag.updated_at,
             tag.created_by, tag.updated_by,
             COALESCE(document_usage.document_count, 0)::bigint AS document_count,
             COALESCE(database_row_usage.database_row_count, 0)::bigint AS database_row_count
        FROM workspace_tags tag
        LEFT JOIN document_usage ON document_usage.tag_id = tag.id
        LEFT JOIN database_row_usage ON database_row_usage.tag_id = tag.id
       WHERE tag.workspace_id = $1 AND ($2 OR tag.archived_at IS NULL)
       ORDER BY tag.archived_at NULLS FIRST, lower(tag.name), tag.id
      "#,
    )
    .bind(workspace_id)
    .bind(include_archived)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows.iter().map(Self::row_to_catalog_entry).collect()
  }

  #[instrument(skip_all, fields(%workspace_id, include_archived, limit = page.limit, offset = page.offset))]
  async fn list_tags_page(
    &self,
    workspace_id: WorkspaceId,
    include_archived: bool,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceTag>> {
    let sql = format!(
      "{} WHERE workspace_id = $1 AND ($2 OR archived_at IS NULL) ORDER BY archived_at NULLS FIRST, lower(name), id LIMIT $3 OFFSET $4",
      Self::SELECT_TAG
    );
    sqlx::query(&sql)
      .bind(workspace_id)
      .bind(include_archived)
      .bind(page.limit.clamp(1, 201))
      .bind(page.offset.max(0))
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)?
      .iter()
      .map(Self::row_to_tag)
      .collect()
  }

  #[instrument(skip_all, fields(%workspace_id, count = tag_ids.len()))]
  async fn list_tags_by_ids(&self, workspace_id: WorkspaceId, tag_ids: &[Uuid]) -> RepoResult<Vec<WorkspaceTag>> {
    if tag_ids.is_empty() {
      return Ok(Vec::new());
    }
    let sql = format!(
      "{} WHERE workspace_id = $1 AND id = ANY($2) ORDER BY array_position($2, id)",
      Self::SELECT_TAG
    );
    sqlx::query(&sql)
      .bind(workspace_id)
      .bind(tag_ids)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_sqlx_error)?
      .iter()
      .map(Self::row_to_tag)
      .collect()
  }

  #[instrument(skip_all, fields(%workspace_id, count = keys.len()))]
  async fn list_document_assignments(
    &self,
    workspace_id: WorkspaceId,
    keys: &[DocumentKey],
  ) -> RepoResult<Vec<WorkspaceTagDocumentAssignment>> {
    if keys.len() > WORKSPACE_TAG_DOCUMENT_BATCH_LIMIT {
      return Err(RepositoryError::Validation(
        "document tag batch exceeds 200 keys".into(),
      ));
    }
    let keys = keys.iter().map(DocumentKey::as_str).collect::<Vec<_>>();
    let rows = sqlx::query(
      "SELECT document.id, document.external_id,
              COALESCE(array_agg(assignment.tag_id ORDER BY assignment.position)
                FILTER (WHERE assignment.tag_id IS NOT NULL), '{}'::uuid[]) AS tag_ids
       FROM docs document LEFT JOIN workspace_tag_document_assignments assignment
         ON assignment.workspace_id = document.workspace_id AND assignment.doc_id = document.id
       WHERE document.workspace_id = $1 AND document.external_id = ANY($2)
         AND document.deleted_at IS NULL AND NOT document.is_workspace_root
       GROUP BY document.id, document.external_id",
    )
    .bind(workspace_id)
    .bind(keys)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(
      rows
        .iter()
        .map(|row| WorkspaceTagDocumentAssignment {
          doc_id: row.get("id"),
          external_id: row.get("external_id"),
          tag_ids: row.get("tag_ids"),
        })
        .collect(),
    )
  }

  #[instrument(skip_all, fields(%workspace_id, %tag_id))]
  async fn list_document_tag_usages(
    &self,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceTagDocumentUsage>> {
    let rows = sqlx::query(
      "SELECT document.id, document.external_id, document.title
       FROM workspace_tag_document_assignments assignment
       JOIN docs document ON document.workspace_id = assignment.workspace_id AND document.id = assignment.doc_id
       WHERE assignment.workspace_id = $1 AND assignment.tag_id = $2
         AND document.deleted_at IS NULL AND NOT document.is_workspace_root
       ORDER BY document.id LIMIT $3 OFFSET $4",
    )
    .bind(workspace_id)
    .bind(tag_id)
    .bind(page.limit.clamp(1, 201))
    .bind(page.offset.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    Ok(
      rows
        .iter()
        .map(|row| WorkspaceTagDocumentUsage {
          doc_id: row.get("id"),
          external_id: row.get("external_id"),
          title: row.get("title"),
        })
        .collect(),
    )
  }

  #[instrument(skip_all, fields(%workspace_id, %doc_id))]
  async fn list_document_tag_ids(&self, workspace_id: WorkspaceId, doc_id: Uuid) -> RepoResult<Vec<Uuid>> {
    sqlx::query_scalar(
      "SELECT COALESCE(array_agg(assignment.tag_id ORDER BY assignment.position)
               FILTER (WHERE assignment.tag_id IS NOT NULL), '{}'::uuid[])
       FROM docs document LEFT JOIN workspace_tag_document_assignments assignment
         ON assignment.workspace_id = document.workspace_id AND assignment.doc_id = document.id
       WHERE document.workspace_id = $1 AND document.id = $2
         AND document.deleted_at IS NULL AND NOT document.is_workspace_root GROUP BY document.id",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?
    .ok_or(RepositoryError::NotFound("workspace document"))
  }

  #[instrument(skip_all, fields(%workspace_id, %tag_id, limit = page.limit, offset = page.offset))]
  async fn list_database_row_tag_usages(
    &self,
    workspace_id: WorkspaceId,
    tag_id: Uuid,
    page: PageRequest,
  ) -> RepoResult<Vec<WorkspaceTagDatabaseRowUsage>> {
    let rows = sqlx::query(
      r#"
        SELECT usage.database_id, usage.database_title, usage.row_id,
               usage.row_title, usage.updated_at
        FROM (
          SELECT DISTINCT ON (reference.database_id, reference.row_id)
            reference.database_id,
            database.title AS database_title,
            reference.row_id,
            row.title AS row_title,
            row.updated_at
          FROM database_row_tag_references reference
          JOIN workspace_databases database
            ON database.id = reference.database_id
           AND database.deleted_at IS NULL
          JOIN workspace_database_rows row
            ON row.id = reference.row_id
           AND row.deleted_at IS NULL
          WHERE reference.workspace_id = $1 AND reference.tag_id = $2
          ORDER BY reference.database_id, reference.row_id, reference.position
        ) usage
        ORDER BY usage.updated_at DESC, usage.database_title ASC,
                 usage.row_title ASC, usage.database_id ASC, usage.row_id ASC
        LIMIT $3 OFFSET $4
      "#,
    )
    .bind(workspace_id)
    .bind(tag_id)
    .bind(page.limit.clamp(1, 500))
    .bind(page.offset.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_sqlx_error)?;
    rows
      .into_iter()
      .map(|row| {
        Ok(WorkspaceTagDatabaseRowUsage {
          database_id: row.try_get("database_id").map_err(Self::map_sqlx_error)?,
          database_title: row.try_get("database_title").map_err(Self::map_sqlx_error)?,
          row_id: row.try_get("row_id").map_err(Self::map_sqlx_error)?,
          row_title: row.try_get("row_title").map_err(Self::map_sqlx_error)?,
          updated_at: row.try_get("updated_at").map_err(Self::map_sqlx_error)?,
        })
      })
      .collect()
  }

  #[instrument(skip_all, fields(%workspace_id, %doc_id, actor_id = %actor, count = tag_ids.len()))]
  async fn replace_document_tag_ids(
    &self,
    workspace_id: WorkspaceId,
    doc_id: Uuid,
    tag_ids: &[Uuid],
    actor: UserId,
  ) -> Result<Vec<WorkspaceTag>, WorkspaceTagAssignmentError> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    let tags = Self::replace_document_tags_in_tx(&mut tx, workspace_id, doc_id, tag_ids, Some(actor)).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(tags)
  }

  #[instrument(skip_all, fields(%workspace_id, %source_doc_id, %target_doc_id))]
  async fn copy_document_tag_ids(
    &self,
    workspace_id: WorkspaceId,
    source_doc_id: Uuid,
    target_doc_id: Uuid,
    expected_ids: &[Uuid],
    actor: UserId,
  ) -> RepoResult<Vec<WorkspaceTag>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    sqlx::query("SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE")
      .bind(workspace_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut docs = vec![source_doc_id, target_doc_id];
    docs.sort();
    docs.dedup();
    for id in docs {
      sqlx::query("SELECT id FROM docs WHERE workspace_id = $1 AND id = $2 AND NOT is_workspace_root AND deleted_at IS NULL FOR UPDATE")
        .bind(workspace_id).bind(id).fetch_one(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    }
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT tag_id FROM workspace_tag_document_assignments WHERE workspace_id = $1 AND doc_id = $2 ORDER BY position, tag_id")
      .bind(workspace_id).bind(source_doc_id).fetch_all(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    if ids != expected_ids {
      return Err(RepositoryError::Conflict(
        "source document label assignment changed; read again before copying",
      ));
    }
    let tags = Self::validate_references_in_tx(&mut tx, workspace_id, &ids, &ids)
      .await
      .map_err(|error| RepositoryError::Validation(error.to_string()))?;
    Self::import_tags_in_tx(&mut tx, workspace_id, actor, &[], &[(target_doc_id, ids)]).await?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(tags)
  }

  #[instrument(skip_all, fields(%workspace_id, ?scope))]
  async fn refresh_search_projections(
    &self,
    workspace_id: WorkspaceId,
    scope: WorkspaceTagSearchRefreshScope,
  ) -> RepoResult<()> {
    let (document_id, tag_id, whole_workspace) = match scope {
      WorkspaceTagSearchRefreshScope::Document(document_id) => (Some(document_id), None, false),
      WorkspaceTagSearchRefreshScope::CatalogTag(tag_id) => (None, Some(tag_id), false),
      WorkspaceTagSearchRefreshScope::Workspace => (None, None, true),
    };
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;

    // Serialize projection rebuilds for one Workspace. Authoritative changes
    // commit before this method is called, so a later waiter always rebuilds
    // from canonical state and cannot leave an older payload behind.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('workspace-tag-search:' || $1::text, 0))")
      .bind(workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;

    sqlx::query(
      r#"
      WITH targets AS (
        SELECT search.doc_id
          FROM search_content search
         WHERE search.workspace_id = $1
           AND (
             $4::boolean
             OR ($2::uuid IS NOT NULL AND search.doc_id = $2)
             OR ($3::uuid IS NOT NULL AND (
               EXISTS (
                 SELECT 1
                   FROM workspace_tag_document_assignments assignment
                  WHERE assignment.workspace_id = $1
                    AND assignment.doc_id = search.doc_id
                    AND assignment.tag_id = $3
               )
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(search.workspace_tags) projected
                  WHERE projected->>'id' = $3::text
               )
             ))
           )
      ), projections AS (
        SELECT search.doc_id,
               COALESCE(
                 jsonb_agg(
                   jsonb_build_object(
                     'id', tag.id,
                     'name', tag.name,
                     'slug', tag.slug,
                     'colorRole', tag.color_role
                   ) ORDER BY assignment.position
                 ) FILTER (WHERE tag.id IS NOT NULL),
                 '[]'::jsonb
               ) AS tags
          FROM targets
          JOIN search_content search
            ON search.workspace_id = $1
           AND search.doc_id = targets.doc_id
          LEFT JOIN workspace_tag_document_assignments assignment
            ON assignment.workspace_id = search.workspace_id
           AND assignment.doc_id = search.doc_id
          LEFT JOIN workspace_tags tag
            ON tag.workspace_id = assignment.workspace_id
           AND tag.id = assignment.tag_id
         GROUP BY search.doc_id
      )
      UPDATE search_content search
         SET workspace_tags = projections.tags,
             search_vector = to_tsvector(
               'simple',
               coalesce(search.title, '') || ' ' ||
               coalesce(search.plain_text, '') || ' ' || projections.tags::text
             ),
             updated_at = now()
        FROM projections
       WHERE search.workspace_id = $1
         AND search.doc_id = projections.doc_id
      "#,
    )
    .bind(workspace_id)
    .bind(document_id)
    .bind(tag_id)
    .bind(whole_workspace)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;

    if !matches!(scope, WorkspaceTagSearchRefreshScope::Document(_)) {
      sqlx::query(
        r#"
        WITH targets AS (
          SELECT search.row_id
            FROM workspace_database_row_search search
           WHERE search.workspace_id = $1
             AND (
               $3::boolean
               OR ($2::uuid IS NOT NULL AND (
                 EXISTS (
                   SELECT 1
                     FROM workspace_database_cell_values value
                     JOIN workspace_database_fields field
                       ON field.id = value.field_id
                      AND field.field_type = 'tags'
                     JOIN workspace_databases database
                       ON database.id = field.database_id
                      AND database.workspace_id = $1
                     CROSS JOIN LATERAL jsonb_array_elements_text(
                       CASE
                         WHEN jsonb_typeof(value.value_json) = 'array' THEN value.value_json
                         ELSE '[]'::jsonb
                       END
                     ) AS reference(tag_id)
                    WHERE value.row_id = search.row_id
                      AND reference.tag_id = $2::text
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(search.workspace_tags) projected
                    WHERE projected->>'id' = $2::text
                 )
               ))
             )
        ), tag_references AS (
          SELECT DISTINCT ON (search.row_id, tag.id)
                 search.row_id,
                 tag.id,
                 tag.name,
                 tag.slug,
                 tag.color_role,
                 field.position AS field_position,
                 reference.position AS tag_position
            FROM targets
            JOIN workspace_database_row_search search
              ON search.workspace_id = $1
             AND search.row_id = targets.row_id
            JOIN workspace_database_cell_values value ON value.row_id = search.row_id
            JOIN workspace_database_fields field
              ON field.id = value.field_id
             AND field.field_type = 'tags'
            JOIN workspace_databases database
              ON database.id = field.database_id
             AND database.workspace_id = $1
           CROSS JOIN LATERAL jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(value.value_json) = 'array' THEN value.value_json
               ELSE '[]'::jsonb
             END
           ) WITH ORDINALITY AS reference(tag_id, position)
            JOIN workspace_tags tag
              ON tag.workspace_id = $1
             AND tag.id::text = reference.tag_id
           ORDER BY search.row_id, tag.id, field.position, reference.position
        ), projections AS (
          SELECT search.row_id,
                 COALESCE(
                   jsonb_agg(
                     jsonb_build_object(
                       'id', reference.id,
                       'name', reference.name,
                       'slug', reference.slug,
                       'colorRole', reference.color_role
                     ) ORDER BY reference.field_position, reference.tag_position
                   ) FILTER (WHERE reference.id IS NOT NULL),
                   '[]'::jsonb
                 ) AS tags
            FROM targets
            JOIN workspace_database_row_search search
              ON search.workspace_id = $1
             AND search.row_id = targets.row_id
            LEFT JOIN tag_references reference ON reference.row_id = search.row_id
           GROUP BY search.row_id
        )
        UPDATE workspace_database_row_search search
           SET workspace_tags = projections.tags,
               updated_at = now()
          FROM projections
         WHERE search.workspace_id = $1
           AND search.row_id = projections.row_id
        "#,
      )
      .bind(workspace_id)
      .bind(tag_id)
      .bind(whole_workspace)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }

    tx.commit().await.map_err(Self::map_sqlx_error)
  }
}
