// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL implementation of [`DocumentVersionRepository`].
//!
//! Each public method carries `#[instrument(skip(self), err)]` so that every
//! call site emits a tracing span with its arguments and any returned error.
//!
//! Uses `sqlx::query()` (runtime-checked) rather than `sqlx::query!()` because
//! the compile-time macro requires a live database connection. The existing
//! infrastructure crate follows this pattern throughout (see e.g. `doc/mod.rs`).
//!
//! Mikropaket: P-DOC-VER-01

use async_trait::async_trait;
use sqlx::{PgConnection, PgPool, Row};
use tracing::instrument;
use uuid::Uuid;

use myoxus_domain::entities::{
  AutoVersionTrigger, DocumentVersion, DocumentVersionEvent, DocumentVersionKind, DocumentVersionPolicy,
  DocumentVersionRelation,
};
use myoxus_domain::repositories::{DocumentVersionRepository, RepoResult, RepositoryError};

/// PostgreSQL-backed implementation of [`DocumentVersionRepository`].
///
/// Uses the canonical `document_version` table.
pub struct PgDocumentVersionRepository {
  pool: PgPool,
}

impl PgDocumentVersionRepository {
  pub(crate) async fn create_relation_in_tx(
    conn: &mut PgConnection,
    relation: &DocumentVersionRelation,
  ) -> RepoResult<()> {
    sqlx::query(
      r#"
      INSERT INTO document_version_relation
        (id, from_version_id, to_version_id, relation, created_by, created_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      "#,
    )
    .bind(relation.id)
    .bind(relation.from_version_id)
    .bind(relation.to_version_id)
    .bind(&relation.relation)
    .bind(relation.created_by)
    .bind(relation.created_at)
    .bind(&relation.metadata)
    .execute(conn)
    .await
    .map_err(|e| {
      if let sqlx::Error::Database(ref dbe) = e
        && dbe.code().as_deref() == Some("23505")
      {
        return RepositoryError::Conflict("document version relation already exists");
      }
      RepositoryError::Storage(e.to_string())
    })?;
    Ok(())
  }
  /// Construct a new repository from an existing connection pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  /// Shares the existing row mapping and constraints with atomic history capture.
  pub(crate) async fn create_in_tx(conn: &mut PgConnection, version: &DocumentVersion) -> RepoResult<DocumentVersion> {
    let row = sqlx::query(
      r#"
      INSERT INTO document_version
        (id, doc_id, workspace_id, doc_history_id, version_no, label,
         description, event, kind, created_by, created_at, updated_by,
         updated_at, is_pinned, is_protected, policy_id, policy_snapshot,
         content_hash, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING *
      "#,
    )
    .bind(version.id)
    .bind(version.doc_id)
    .bind(version.workspace_id)
    .bind(version.doc_history_id)
    .bind(version.version_no)
    .bind(&version.label)
    .bind(&version.description)
    .bind(version.event.as_str())
    .bind(version.kind.as_str())
    .bind(version.created_by)
    .bind(version.created_at)
    .bind(version.updated_by)
    .bind(version.updated_at)
    .bind(version.is_pinned)
    .bind(version.is_protected)
    .bind(version.policy_id)
    .bind(&version.policy_snapshot)
    .bind(&version.content_hash)
    .bind(&version.metadata)
    .fetch_one(conn)
    .await
    .map_err(|e| {
      if let sqlx::Error::Database(ref dbe) = e
        && dbe.code().as_deref() == Some("23505")
      {
        return RepositoryError::Conflict("document_version label already exists for this doc");
      }
      RepositoryError::Storage(e.to_string())
    })?;
    Ok(row_to_version(&row))
  }

  pub(crate) async fn next_counter_in_tx(
    conn: &mut PgConnection,
    doc_id: uuid::Uuid,
    counter_key: &str,
  ) -> RepoResult<i64> {
    sqlx::query_scalar(
      r#"
      INSERT INTO document_version_label_counter (doc_id, counter_key, next_value)
      VALUES ($1, $2, 2)
      ON CONFLICT (doc_id, counter_key) DO UPDATE
        SET next_value = document_version_label_counter.next_value + 1,
            updated_at = now()
      RETURNING next_value - 1
      "#,
    )
    .bind(doc_id)
    .bind(counter_key)
    .fetch_one(conn)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))
  }

  pub(crate) async fn get_in_tx(conn: &mut PgConnection, id: Uuid) -> RepoResult<Option<DocumentVersion>> {
    let row = sqlx::query(
      "SELECT id, doc_id, workspace_id, doc_history_id, version_no, label,
              description, event, kind, created_by, created_at, updated_by,
              updated_at, is_pinned, is_protected, policy_id, policy_snapshot,
              content_hash, metadata
       FROM document_version WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    Ok(row.as_ref().map(row_to_version))
  }
}

/// Map a raw `sqlx::Row` from `document_version` into a [`DocumentVersion`].
fn row_to_version(row: &sqlx::postgres::PgRow) -> DocumentVersion {
  let event: String = row.get("event");
  let kind: String = row.get("kind");
  DocumentVersion {
    id: row.get("id"),
    doc_id: row.get("doc_id"),
    workspace_id: row.get("workspace_id"),
    doc_history_id: row.get("doc_history_id"),
    version_no: row.get("version_no"),
    label: row.get("label"),
    description: row.get("description"),
    event: DocumentVersionEvent::from(event.as_str()),
    kind: DocumentVersionKind::from(kind.as_str()),
    created_by: row.get("created_by"),
    created_at: row.get("created_at"),
    updated_by: row.get("updated_by"),
    updated_at: row.get("updated_at"),
    is_pinned: row.get("is_pinned"),
    is_protected: row.get("is_protected"),
    policy_id: row.get("policy_id"),
    policy_snapshot: row.get("policy_snapshot"),
    content_hash: row.get("content_hash"),
    metadata: row.get("metadata"),
  }
}

fn row_to_policy(row: &sqlx::postgres::PgRow) -> DocumentVersionPolicy {
  let raw_triggers: Vec<String> = row.get("auto_version_on");
  DocumentVersionPolicy {
    id: row.get("id"),
    scope: row.get("scope"),
    workspace_id: row.get("workspace_id"),
    name: row.get("name"),
    is_default: row.get("is_default"),
    enabled_by_default: row.get("enabled_by_default"),
    scheme_preset: row.get("scheme_preset"),
    custom_pattern: row.get("custom_pattern"),
    timezone_mode: row.get("timezone_mode"),
    auto_version_on: raw_triggers
      .iter()
      .map(|value| AutoVersionTrigger::from(value.as_str()))
      .collect(),
    retention_count: row.get("retention_count"),
    pin_manual_versions: row.get("pin_manual_versions"),
    pin_publish_versions: row.get("pin_publish_versions"),
    published_versions_protected: row.get("published_versions_protected"),
    export_versions_protected: row.get("export_versions_protected"),
    metadata_schema: row.get("metadata_schema"),
    created_by: row.get("created_by"),
    created_at: row.get("created_at"),
    updated_by: row.get("updated_by"),
    updated_at: row.get("updated_at"),
  }
}

fn row_to_relation(row: &sqlx::postgres::PgRow) -> DocumentVersionRelation {
  DocumentVersionRelation {
    id: row.get("id"),
    from_version_id: row.get("from_version_id"),
    to_version_id: row.get("to_version_id"),
    relation: row.get("relation"),
    created_by: row.get("created_by"),
    created_at: row.get("created_at"),
    metadata: row.get("metadata"),
  }
}

#[async_trait]
impl DocumentVersionRepository for PgDocumentVersionRepository {
  #[instrument(skip(self), err)]
  async fn list_for_doc(&self, doc_id: uuid::Uuid) -> RepoResult<Vec<DocumentVersion>> {
    let rows = sqlx::query(
      r#"
      SELECT id, doc_id, workspace_id, doc_history_id, version_no, label,
             description, event, kind, created_by, created_at, updated_by,
             updated_at, is_pinned, is_protected, policy_id, policy_snapshot,
             content_hash, metadata
      FROM document_version
      WHERE doc_id = $1
      ORDER BY created_at ASC
      "#,
    )
    .bind(doc_id)
    .fetch_all(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;

    Ok(rows.iter().map(row_to_version).collect())
  }

  #[instrument(skip(self), err)]
  async fn get(&self, id: uuid::Uuid) -> RepoResult<Option<DocumentVersion>> {
    let maybe = sqlx::query(
      r#"
      SELECT id, doc_id, workspace_id, doc_history_id, version_no, label,
             description, event, kind, created_by, created_at, updated_by,
             updated_at, is_pinned, is_protected, policy_id, policy_snapshot,
             content_hash, metadata
      FROM document_version
      WHERE id = $1
      "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;

    Ok(maybe.as_ref().map(row_to_version))
  }

  #[instrument(skip(self), err)]
  async fn latest_snapshot_for_doc(&self, doc_id: uuid::Uuid) -> RepoResult<Option<Vec<u8>>> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    let row = sqlx::query(
      "SELECT v.doc_id, v.workspace_id, v.doc_history_id, h.snapshot
       FROM document_version v JOIN doc_histories h ON h.id = v.doc_history_id
       WHERE v.doc_id = $1 ORDER BY v.created_at DESC, h.id DESC LIMIT 1",
    )
    .bind(doc_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    let snapshot = match row {
      Some(row) => Some(
        crate::doc::reference_lineage::project_snapshot_in_tx(
          &mut tx,
          row.get("doc_history_id"),
          row.get("doc_id"),
          row.get("workspace_id"),
          &row.get::<Vec<u8>, _>("snapshot"),
        )
        .await
        .map_err(|e| RepositoryError::Storage(e.to_string()))?,
      ),
      None => None,
    };
    tx.commit().await.map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(snapshot)
  }

  #[instrument(skip(self), err)]
  async fn snapshot_for_version(&self, id: uuid::Uuid) -> RepoResult<Option<(DocumentVersion, Vec<u8>)>> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    let maybe = sqlx::query(
      r#"
      SELECT v.id, v.doc_id, v.workspace_id, v.doc_history_id, v.version_no,
             v.label, v.description, v.event, v.kind, v.created_by,
             v.created_at, v.updated_by, v.updated_at, v.is_pinned,
             v.is_protected, v.policy_id, v.policy_snapshot, v.content_hash,
             v.metadata, h.snapshot
      FROM document_version v
      JOIN doc_histories h ON h.id = v.doc_history_id
      WHERE v.id = $1
      "#,
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    let result = match maybe {
      Some(row) => {
        let version = row_to_version(&row);
        // Version hashes describe the immutable capture, while every reader
        // consumes the same current-workspace reference projection as history.
        let snapshot = crate::doc::reference_lineage::project_snapshot_in_tx(
          &mut tx,
          version.doc_history_id,
          version.doc_id,
          version.workspace_id,
          &row.get::<Vec<u8>, _>("snapshot"),
        )
        .await
        .map_err(|e| RepositoryError::Storage(e.to_string()))?;
        Some((version, snapshot))
      }
      None => None,
    };
    tx.commit().await.map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(result)
  }

  #[instrument(skip(self), err)]
  async fn create(&self, version: &DocumentVersion) -> RepoResult<()> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    let history_owner: Option<(uuid::Uuid, uuid::Uuid)> =
      sqlx::query_as("SELECT doc_id, workspace_id FROM doc_histories WHERE id = $1 FOR UPDATE")
        .bind(version.doc_history_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    let Some((doc_id, workspace_id)) = history_owner else {
      return Err(RepositoryError::NotFound("document history"));
    };
    if doc_id != version.doc_id || workspace_id != version.workspace_id {
      return Err(RepositoryError::Validation(
        "document history does not belong to the requested document".to_string(),
      ));
    }
    Self::create_in_tx(&mut tx, version).await?;
    tx.commit().await.map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(())
  }

  #[instrument(skip(self, relation), fields(from = %relation.from_version_id, to = %relation.to_version_id, relation = %relation.relation), err)]
  async fn create_relation(&self, relation: &DocumentVersionRelation) -> RepoResult<()> {
    let mut conn = self
      .pool
      .acquire()
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Self::create_relation_in_tx(&mut conn, relation).await
  }

  #[instrument(skip(self), err)]
  async fn list_relations_for_version(&self, version_id: uuid::Uuid) -> RepoResult<Vec<DocumentVersionRelation>> {
    let rows = sqlx::query(
      r#"
      SELECT id, from_version_id, to_version_id, relation, created_by, created_at, metadata
      FROM document_version_relation
      WHERE from_version_id = $1 OR to_version_id = $1
      ORDER BY created_at ASC, id ASC
      "#,
    )
    .bind(version_id)
    .fetch_all(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(rows.iter().map(row_to_relation).collect())
  }

  #[instrument(skip(self), err)]
  async fn next_counter_value(&self, doc_id: uuid::Uuid, counter_key: &str) -> RepoResult<i64> {
    let mut conn = self
      .pool
      .acquire()
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Self::next_counter_in_tx(&mut conn, doc_id, counter_key).await
  }

  #[instrument(skip(self), err)]
  async fn default_policy(&self, workspace_id: Option<uuid::Uuid>) -> RepoResult<Option<DocumentVersionPolicy>> {
    let row = if let Some(workspace_id) = workspace_id {
      sqlx::query(
        r#"
        SELECT id, scope, workspace_id, name, is_default, enabled_by_default,
               scheme_preset, custom_pattern, timezone_mode, auto_version_on,
               retention_count, pin_manual_versions, pin_publish_versions,
               published_versions_protected, export_versions_protected,
               metadata_schema, created_by, created_at, updated_by, updated_at
        FROM document_version_policy
        WHERE (scope = 'workspace' AND workspace_id = $1 AND is_default = true)
           OR (scope = 'global' AND is_default = true)
        ORDER BY CASE WHEN scope = 'workspace' THEN 0 ELSE 1 END
        LIMIT 1
        "#,
      )
      .bind(workspace_id)
      .fetch_optional(&self.pool)
      .await
    } else {
      sqlx::query(
        r#"
        SELECT id, scope, workspace_id, name, is_default, enabled_by_default,
               scheme_preset, custom_pattern, timezone_mode, auto_version_on,
               retention_count, pin_manual_versions, pin_publish_versions,
               published_versions_protected, export_versions_protected,
               metadata_schema, created_by, created_at, updated_by, updated_at
        FROM document_version_policy
        WHERE scope = 'global' AND is_default = true
        LIMIT 1
        "#,
      )
      .fetch_optional(&self.pool)
      .await
    }
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(row.as_ref().map(row_to_policy))
  }

  #[instrument(skip(self), err)]
  async fn list_policies(&self) -> RepoResult<Vec<DocumentVersionPolicy>> {
    let rows = sqlx::query(
      r#"
      SELECT id, scope, workspace_id, name, is_default, enabled_by_default,
             scheme_preset, custom_pattern, timezone_mode, auto_version_on,
             retention_count, pin_manual_versions, pin_publish_versions,
             published_versions_protected, export_versions_protected,
             metadata_schema, created_by, created_at, updated_by, updated_at
      FROM document_version_policy
      ORDER BY scope, workspace_id NULLS FIRST, is_default DESC, lower(name), id
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(rows.iter().map(row_to_policy).collect())
  }

  #[instrument(skip(self, policy), fields(policy_id = %policy.id, scope = %policy.scope), err)]
  async fn upsert_policy(&self, policy: &DocumentVersionPolicy) -> RepoResult<DocumentVersionPolicy> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;

    if policy.is_default {
      sqlx::query(
        r#"
        UPDATE document_version_policy
        SET is_default = false, updated_by = $4, updated_at = now()
        WHERE id <> $1
          AND scope = $2
          AND (
            ($2 = 'global' AND workspace_id IS NULL)
            OR ($2 <> 'global' AND workspace_id IS NOT DISTINCT FROM $3)
          )
        "#,
      )
      .bind(policy.id)
      .bind(&policy.scope)
      .bind(policy.workspace_id)
      .bind(policy.updated_by)
      .execute(&mut *tx)
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    }

    let auto_version_on: Vec<String> = policy
      .auto_version_on
      .iter()
      .map(|trigger| trigger.as_str().to_string())
      .collect();
    let row = sqlx::query(
      r#"
      INSERT INTO document_version_policy
        (id, scope, workspace_id, name, is_default, enabled_by_default,
         scheme_preset, custom_pattern, timezone_mode, auto_version_on,
         retention_count, pin_manual_versions, pin_publish_versions,
         published_versions_protected, export_versions_protected,
         metadata_schema, created_by, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
      ON CONFLICT (id) DO UPDATE SET
        scope = EXCLUDED.scope,
        workspace_id = EXCLUDED.workspace_id,
        name = EXCLUDED.name,
        is_default = EXCLUDED.is_default,
        enabled_by_default = EXCLUDED.enabled_by_default,
        scheme_preset = EXCLUDED.scheme_preset,
        custom_pattern = EXCLUDED.custom_pattern,
        timezone_mode = EXCLUDED.timezone_mode,
        auto_version_on = EXCLUDED.auto_version_on,
        retention_count = EXCLUDED.retention_count,
        pin_manual_versions = EXCLUDED.pin_manual_versions,
        pin_publish_versions = EXCLUDED.pin_publish_versions,
        published_versions_protected = EXCLUDED.published_versions_protected,
        export_versions_protected = EXCLUDED.export_versions_protected,
        metadata_schema = EXCLUDED.metadata_schema,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING id, scope, workspace_id, name, is_default, enabled_by_default,
                scheme_preset, custom_pattern, timezone_mode, auto_version_on,
                retention_count, pin_manual_versions, pin_publish_versions,
                published_versions_protected, export_versions_protected,
                metadata_schema, created_by, created_at, updated_by, updated_at
      "#,
    )
    .bind(policy.id)
    .bind(&policy.scope)
    .bind(policy.workspace_id)
    .bind(&policy.name)
    .bind(policy.is_default)
    .bind(policy.enabled_by_default)
    .bind(&policy.scheme_preset)
    .bind(&policy.custom_pattern)
    .bind(&policy.timezone_mode)
    .bind(&auto_version_on)
    .bind(policy.retention_count)
    .bind(policy.pin_manual_versions)
    .bind(policy.pin_publish_versions)
    .bind(policy.published_versions_protected)
    .bind(policy.export_versions_protected)
    .bind(&policy.metadata_schema)
    .bind(policy.created_by)
    .bind(policy.updated_by)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;

    tx.commit().await.map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(row_to_policy(&row))
  }

  #[instrument(skip(self), err)]
  async fn pin(&self, id: uuid::Uuid) -> RepoResult<()> {
    sqlx::query("UPDATE document_version SET is_pinned = true WHERE id = $1")
      .bind(id)
      .execute(&self.pool)
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn unpin(&self, id: uuid::Uuid) -> RepoResult<()> {
    sqlx::query("UPDATE document_version SET is_pinned = false WHERE id = $1")
      .bind(id)
      .execute(&self.pool)
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(())
  }

  #[instrument(skip(self, label, description), fields(id = %id), err)]
  async fn update_metadata(&self, id: uuid::Uuid, label: &str, description: Option<&str>) -> RepoResult<()> {
    let result = sqlx::query(
      r#"
      UPDATE document_version
      SET label = $2, description = $3, updated_at = now()
      WHERE id = $1
      "#,
    )
    .bind(id)
    .bind(label)
    .bind(description)
    .execute(&self.pool)
    .await
    .map_err(|e| {
      if let sqlx::Error::Database(ref dbe) = e
        && dbe.code().as_deref() == Some("23505")
      {
        return RepositoryError::Conflict("document_version label already exists for this doc");
      }
      RepositoryError::Storage(e.to_string())
    })?;

    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("document version not found"));
    }
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn delete(&self, id: uuid::Uuid) -> RepoResult<()> {
    // Attempt to delete only if the version is not pinned.
    let result = sqlx::query("DELETE FROM document_version WHERE id = $1 AND is_pinned = false AND is_protected = false AND kind <> 'published'")
      .bind(id)
      .execute(&self.pool)
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;

    if result.rows_affected() == 0 {
      // Either it doesn't exist or it's pinned. Distinguish by checking.
      let protected: Option<(bool, bool, String)> =
        sqlx::query_as("SELECT is_pinned, is_protected, kind FROM document_version WHERE id = $1")
          .bind(id)
          .fetch_optional(&self.pool)
          .await
          .map_err(|e| RepositoryError::Storage(e.to_string()))?;

      if let Some((is_pinned, is_protected, kind)) = protected
        && (is_pinned || is_protected || kind == "published")
      {
        return Err(RepositoryError::Conflict("version is protected"));
      }
      // Row doesn't exist — treat as no-op (already deleted).
    }
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn gc_unpinned_older_than_count(
    &self,
    doc_id: uuid::Uuid,
    retention_count: i32,
  ) -> RepoResult<Vec<DocumentVersion>> {
    // Delete all unpinned versions beyond the retention_count most recent ones.
    // We use a subquery with ROW_NUMBER ordered by created_at DESC so that
    // only the newest `retention_count` unpinned versions survive.
    let rows = sqlx::query(
      r#"
      DELETE FROM document_version
      WHERE id IN (
          SELECT id FROM (
              SELECT id,
                     ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
              FROM document_version
              WHERE doc_id = $1
                AND is_pinned = false
                AND is_protected = false
                AND kind <> 'published'
          ) ranked
          WHERE rn > $2
      )
      RETURNING id, doc_id, workspace_id, doc_history_id, version_no, label,
                description, event, kind, created_by, created_at, updated_by,
                updated_at, is_pinned, is_protected, policy_id,
                policy_snapshot, content_hash, metadata
      "#,
    )
    .bind(doc_id)
    .bind(retention_count as i64)
    .fetch_all(&self.pool)
    .await
    .map_err(|e| RepositoryError::Storage(e.to_string()))?;

    Ok(rows.iter().map(row_to_version).collect())
  }
}
