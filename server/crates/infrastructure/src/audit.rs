// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed operator-visible audit log store.
//!
//! Implements [`myoxus_domain::audit::AuditLogStore`] against the
//! canonical `admin_audit_log` table.
//!
//! ## Query strategy
//!
//! Listing uses a dynamic WHERE clause: predicates are appended to a base
//! `SELECT` query based on which `AuditFilter` fields are set.  SQLx's
//! `query_as` / `query` macros do not support truly dynamic SQL, so we build
//! the SQL string at runtime and use positional parameters ($1, $2, …) to
//! bind values safely — no risk of SQL injection because values are always
//! bound, never interpolated.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::audit::{DocumentAuditEntry, DocumentAuditFilter, DocumentAuditProjectionStore};
use myoxus_domain::audit::{
  AuditActorKind, AuditCategory, AuditEntry, AuditError, AuditEvent, AuditFilter, AuditLogStore,
};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use tracing::{debug, instrument, warn};
use uuid::Uuid;

/// PostgreSQL-backed implementation of [`AuditLogStore`].
#[derive(Debug, Clone)]
pub struct PgAuditLogStore {
  pool: PgPool,
}

impl PgAuditLogStore {
  /// Join audit persistence to the owning business transaction. A committed
  /// mutation must not lose its audit record to a later best-effort write.
  pub(crate) async fn record_in_tx(conn: &mut sqlx::PgConnection, event: &AuditEvent) -> Result<(), AuditError> {
    let target_type = event.target.as_ref().map(|t| t.target_type.as_str());
    let target_id = event.target.as_ref().map(|t| t.target_id.as_str());
    let target_label = event.target.as_ref().and_then(|t| t.target_label.as_deref());

    sqlx::query(
      r#"
      INSERT INTO admin_audit_log
          (event_key, category, target_type, target_id, target_label,
           old_value, new_value, actor_user_id, actor_label, metadata,
           target_unit_id, actor_kind, credential_type, credential_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      "#,
    )
    .bind(&event.event_key)
    .bind(event.category.as_str())
    .bind(target_type)
    .bind(target_id)
    .bind(target_label)
    .bind(event.old_value.as_ref())
    .bind(event.new_value.as_ref())
    .bind(event.actor.user_id)
    .bind(event.actor.label.as_deref())
    .bind(event.metadata.as_ref())
    .bind(event.target_unit_id)
    .bind(event.actor.kind.as_str())
    .bind(event.actor.credential_type.as_deref())
    .bind(event.actor.credential_id.as_deref())
    .execute(conn)
    .await
    .map_err(Self::map_db_err)?;

    Ok(())
  }
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> AuditError {
    AuditError::Storage(err.to_string())
  }
}

#[async_trait]
impl AuditLogStore for PgAuditLogStore {
  /// Persist a single audit event to the historical `admin_audit_log` table.
  #[instrument(skip(self), level = "debug")]
  async fn record(&self, event: AuditEvent) -> Result<(), AuditError> {
    let mut conn = self.pool.acquire().await.map_err(Self::map_db_err)?;
    Self::record_in_tx(&mut conn, &event).await?;
    debug!(
      event_key = %event.event_key,
      category = %event.category,
      actor_user_id = ?event.actor.user_id,
      "audit event recorded"
    );
    Ok(())
  }

  /// List audit entries matching the given filter, ordered newest-first.
  #[instrument(skip(self), level = "debug")]
  async fn list(&self, filter: AuditFilter, skip: i64, take: i64) -> Result<Vec<AuditEntry>, AuditError> {
    let (sql, params) = build_list_query(&filter, skip, take);
    let mut q = sqlx::query(&sql);
    for p in &params {
      q = bind_param(q, p);
    }
    let rows = q.fetch_all(&self.pool).await.map_err(Self::map_db_err)?;

    debug!(
      filter = ?filter.category,
      skip, take,
      count = rows.len(),
      "audit list query returned"
    );

    rows.into_iter().map(map_row).collect::<Result<Vec<_>, _>>()
  }

  /// Count matching audit entries.
  #[instrument(skip(self), level = "debug")]
  async fn count(&self, filter: AuditFilter) -> Result<i64, AuditError> {
    let (sql, params) = build_count_query(&filter);
    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for p in &params {
      q = bind_scalar_param(q, p);
    }
    q.fetch_one(&self.pool).await.map_err(Self::map_db_err)
  }

  #[instrument(skip(self), level = "debug")]
  async fn get_by_id(&self, id: Uuid) -> Result<Option<AuditEntry>, AuditError> {
    let row = sqlx::query("SELECT * FROM admin_audit_log WHERE id = $1")
      .bind(id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    row.map(map_row).transpose()
  }
}

#[async_trait]
impl DocumentAuditProjectionStore for PgAuditLogStore {
  #[instrument(skip(self, filter), level = "debug")]
  async fn list_document_audit(
    &self,
    filter: &DocumentAuditFilter,
    skip: i64,
    take: i64,
  ) -> Result<Vec<DocumentAuditEntry>, AuditError> {
    let mut query = document_audit_base_query(false);
    append_document_audit_filters(&mut query, filter);
    query
      .push(" ORDER BY created_at DESC, id DESC LIMIT ")
      .push_bind(take.clamp(1, 500))
      .push(" OFFSET ")
      .push_bind(skip.max(0));
    let rows = query.build().fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    rows.into_iter().map(map_document_audit_row).collect()
  }

  #[instrument(skip(self, filter), level = "debug")]
  async fn count_document_audit(&self, filter: &DocumentAuditFilter) -> Result<i64, AuditError> {
    let mut query = document_audit_base_query(true);
    append_document_audit_filters(&mut query, filter);
    query
      .build_query_scalar::<i64>()
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }
}

fn document_audit_base_query(count_only: bool) -> QueryBuilder<'static, Postgres> {
  let select = if count_only {
    "SELECT COUNT(*)::BIGINT"
  } else {
    "SELECT id, source, group_key, event_key, source_category, target_type, target_id, target_label, \
     old_value, new_value, actor_user_id, actor_label, actor_kind, credential_type, credential_id, metadata, \
     created_at, target_unit_id, workspace_id, doc_id"
  };
  let mut query = QueryBuilder::new(
    r#"
WITH document_audit AS (
  SELECT audit.id::text AS id, 'admin_audit_log'::text AS source,
    CASE
      WHEN audit.event_key LIKE 'document_metadata.policy.%' THEN 'metadata_policy'
      WHEN audit.event_key LIKE 'document_metadata.value.%' THEN 'metadata_policy'
      WHEN audit.event_key LIKE 'document_metadata.status_schema.%' THEN 'status_schema'
      WHEN audit.event_key LIKE 'document_metadata.status_value.%' THEN 'status_schema'
      WHEN audit.event_key LIKE 'document_metadata.status_transition.%' THEN 'status_transition'
      WHEN audit.event_key LIKE 'document_metadata.document_type.%' THEN 'document_type'
      WHEN audit.event_key LIKE 'document_metadata.version_policy.%' THEN 'version_policy'
      WHEN audit.event_key LIKE 'document_metadata.workspace_settings.%' THEN 'workspace_settings'
      WHEN audit.event_key LIKE 'document_versioning.workspace_settings.%' THEN 'workspace_settings'
      WHEN audit.event_key LIKE 'document.%' THEN 'document_lifecycle'
      WHEN audit.event_key LIKE 'document_metadata.%' THEN 'document_metadata'
      WHEN audit.event_key LIKE 'document_version.%' THEN 'document_version'
      ELSE 'metadata_policy'
    END AS group_key,
    audit.event_key, audit.category AS source_category, audit.target_type, audit.target_id,
    COALESCE(NULLIF(audit.target_label, ''), NULLIF(target_workspace.name, ''), NULLIF(target_doc.title, '')) AS target_label,
    audit.old_value, audit.new_value, audit.actor_user_id, audit.actor_label, audit.actor_kind,
    audit.credential_type, audit.credential_id, audit.metadata, audit.created_at, audit.target_unit_id,
    CASE
      WHEN audit.target_type = 'workspace' THEN audit.target_id
      WHEN COALESCE(audit.new_value, '{}'::jsonb) ? 'workspaceId' THEN audit.new_value->>'workspaceId'
      WHEN COALESCE(audit.old_value, '{}'::jsonb) ? 'workspaceId' THEN audit.old_value->>'workspaceId'
      ELSE NULL
    END AS workspace_id,
    CASE
      WHEN audit.target_type = 'document' THEN audit.target_id
      WHEN COALESCE(audit.new_value, '{}'::jsonb) ? 'docId' THEN audit.new_value->>'docId'
      WHEN COALESCE(audit.old_value, '{}'::jsonb) ? 'docId' THEN audit.old_value->>'docId'
      ELSE NULL
    END AS doc_id
  FROM admin_audit_log audit
  LEFT JOIN workspaces target_workspace ON audit.target_type = 'workspace'
   AND target_workspace.id = (CASE WHEN audit.target_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN audit.target_id ELSE NULL END)::uuid
  LEFT JOIN docs target_doc ON audit.target_type IN ('document', 'document_versioning_settings')
   AND target_doc.id = (CASE WHEN audit.target_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN audit.target_id ELSE NULL END)::uuid
  WHERE (audit.category = 'document_version' AND (
      audit.event_key LIKE 'document_version.%' OR audit.event_key LIKE 'document_versioning.%' OR audit.event_key LIKE 'document_metadata.%'
    )) OR (audit.category = 'config' AND audit.event_key LIKE 'document_metadata.%')
       OR (audit.category = 'document' AND audit.event_key LIKE 'document.%')
  UNION ALL
  SELECT audit.id::text, 'document_initial_sync_audit'::text, 'document_lifecycle'::text,
    ('document.initial_sync.' || audit.resolution_kind)::text, 'document_initial_sync_audit'::text,
    'document'::text, audit.doc_id::text, NULLIF(doc.title, ''), NULL::jsonb,
    jsonb_build_object(
      'docId', audit.doc_id::text, 'workspaceId', audit.workspace_id::text,
      'idempotencyKey', audit.idempotency_key, 'provenanceMode', audit.provenance_mode,
      'resolutionKind', audit.resolution_kind, 'decisionCode', audit.decision_code,
      'appliedCreatedAt', audit.applied_created_at, 'appliedUpdatedAt', audit.applied_updated_at,
      'appliedCreatedBy', audit.applied_created_by, 'appliedUpdatedBy', audit.applied_updated_by,
      'rejectedFields', audit.rejected_fields
    ),
    audit.actor_user_id, COALESCE(NULLIF(users.email, ''), audit.actor_user_id::text), 'user'::text,
    NULL::text, NULL::text,
    jsonb_build_object(
      'rawProvenance', audit.raw_provenance, 'normalizedProvenance', audit.normalized_provenance,
      'clientInstanceId', audit.client_instance_id, 'sourcePropertyDocRevision', audit.source_property_doc_revision,
      'receivedAtServer', audit.received_at_server
    ),
    audit.created_at, NULL::uuid, audit.workspace_id::text, audit.doc_id::text
  FROM document_initial_sync_audit audit
  LEFT JOIN docs doc ON doc.id = audit.doc_id
  LEFT JOIN users ON users.id = audit.actor_user_id
  UNION ALL
  SELECT audit.id::text, 'pdf_export_render_audit'::text, 'pdf_export'::text,
    'pdf_export.render'::text, 'pdf_export_render_audit'::text, 'pdf_export_job'::text,
    audit.job_id::text, audit.doc_version_label, NULL::jsonb,
    jsonb_build_object(
      'jobId', audit.job_id::text, 'workspaceId', audit.workspace_id::text, 'docId', audit.doc_id::text,
      'documentVersionId', audit.document_version_id::text, 'docVersionLabel', audit.doc_version_label,
      'templateId', audit.template_id::text, 'templateVersion', audit.template_version,
      'renderAppearanceHash', audit.render_appearance_hash, 'locale', audit.locale,
      'classification', audit.classification, 'documentMetadataSnapshot', audit.document_metadata_snapshot,
      'attributeValidation', audit.metadata_validation
    ),
    audit.actor_id, COALESCE(NULLIF(users.email, ''), audit.actor_id::text), 'user'::text,
    NULL::text, NULL::text, audit.l3_inputs, audit.created_at, NULL::uuid,
    audit.workspace_id::text, audit.doc_id::text
  FROM pdf_export_render_audit audit
  LEFT JOIN users ON users.id = audit.actor_id
)
"#,
  );
  query.push(select).push(" FROM document_audit");
  query
}

fn append_document_audit_filters(query: &mut QueryBuilder<'_, Postgres>, filter: &DocumentAuditFilter) {
  query.push(" WHERE true");
  if let Some(groups) = filter.groups.as_ref().filter(|groups| !groups.is_empty()) {
    query.push(" AND group_key = ANY(").push_bind(groups.clone()).push(")");
  }
  if let Some(actor_user_id) = filter.actor_user_id {
    query.push(" AND actor_user_id = ").push_bind(actor_user_id);
  }
  if let Some(target_type) = filter.target_type.as_ref() {
    query.push(" AND target_type = ").push_bind(target_type.clone());
  }
  if let Some(target_id) = filter.target_id.as_ref() {
    query.push(" AND target_id = ").push_bind(target_id.clone());
  }
  if let Some(workspace_id) = filter.workspace_id {
    query.push(" AND workspace_id = ").push_bind(workspace_id.to_string());
  }
  if let Some(doc_id) = filter.doc_id {
    query.push(" AND doc_id = ").push_bind(doc_id.to_string());
  }
  if let Some(prefix) = filter.event_key_prefix.as_ref() {
    query.push(" AND event_key LIKE ").push_bind(format!("{prefix}%"));
  }
  if let Some(from) = filter.from {
    query.push(" AND created_at >= ").push_bind(from);
  }
  if let Some(to) = filter.to {
    query.push(" AND created_at <= ").push_bind(to);
  }
}

fn map_document_audit_row(row: sqlx::postgres::PgRow) -> Result<DocumentAuditEntry, AuditError> {
  let read = |error: sqlx::Error| AuditError::Storage(error.to_string());
  Ok(DocumentAuditEntry {
    id: row.try_get("id").map_err(read)?,
    source: row.try_get("source").map_err(read)?,
    group_key: row.try_get("group_key").map_err(read)?,
    event_key: row.try_get("event_key").map_err(read)?,
    source_category: row.try_get("source_category").map_err(read)?,
    target_type: row.try_get("target_type").map_err(read)?,
    target_id: row.try_get("target_id").map_err(read)?,
    target_label: row.try_get("target_label").map_err(read)?,
    old_value: row.try_get("old_value").map_err(read)?,
    new_value: row.try_get("new_value").map_err(read)?,
    actor_user_id: row.try_get("actor_user_id").map_err(read)?,
    actor_label: row.try_get("actor_label").map_err(read)?,
    actor_kind: row.try_get("actor_kind").map_err(read)?,
    credential_type: row.try_get("credential_type").map_err(read)?,
    credential_id: row.try_get("credential_id").map_err(read)?,
    metadata: row.try_get("metadata").map_err(read)?,
    created_at: row.try_get("created_at").map_err(read)?,
    target_unit_id: row.try_get("target_unit_id").map_err(read)?,
    workspace_id: row.try_get("workspace_id").map_err(read)?,
    doc_id: row.try_get("doc_id").map_err(read)?,
  })
}

// ─── Dynamic query builder ────────────────────────────────────────────────────

/// Bind parameter — a type-erased value for our dynamic WHERE builder.
enum Param {
  Text(String),
  Uuid(Uuid),
  Timestamp(DateTime<Utc>),
  I64(i64),
}

fn bind_param<'q>(
  q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
  p: &Param,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
  match p {
    Param::Text(s) => q.bind(s.clone()),
    Param::Uuid(u) => q.bind(*u),
    Param::Timestamp(t) => q.bind(*t),
    Param::I64(n) => q.bind(*n),
  }
}

fn bind_scalar_param<'q>(
  q: sqlx::query::QueryScalar<'q, sqlx::Postgres, i64, sqlx::postgres::PgArguments>,
  p: &Param,
) -> sqlx::query::QueryScalar<'q, sqlx::Postgres, i64, sqlx::postgres::PgArguments> {
  match p {
    Param::Text(s) => q.bind(s.clone()),
    Param::Uuid(u) => q.bind(*u),
    Param::Timestamp(t) => q.bind(*t),
    Param::I64(n) => q.bind(*n),
  }
}

/// Build the WHERE clause for both LIST and COUNT queries.
/// Returns `(conditions_fragment, params)` where `params` are 1-indexed ($1 …).
/// Caller is responsible for the leading base SQL.
fn build_where(filter: &AuditFilter, start_idx: usize) -> (String, Vec<Param>) {
  let mut conditions: Vec<String> = Vec::new();
  let mut params: Vec<Param> = Vec::new();
  let mut idx = start_idx;

  if let Some(cat) = filter.category {
    conditions.push(format!("category = ${idx}"));
    params.push(Param::Text(cat.as_str().to_string()));
    idx += 1;
  }
  if let Some(uid) = filter.actor_user_id {
    conditions.push(format!("actor_user_id = ${idx}"));
    params.push(Param::Uuid(uid));
    idx += 1;
  }
  if let Some(kind) = filter.actor_kind {
    conditions.push(format!("actor_kind = ${idx}"));
    params.push(Param::Text(kind.as_str().to_string()));
    idx += 1;
  }
  if let Some(ref credential_type) = filter.credential_type {
    conditions.push(format!("credential_type = ${idx}"));
    params.push(Param::Text(credential_type.clone()));
    idx += 1;
  }
  if let Some(ref credential_id) = filter.credential_id {
    conditions.push(format!("credential_id = ${idx}"));
    params.push(Param::Text(credential_id.clone()));
    idx += 1;
  }
  if let Some(ref tt) = filter.target_type {
    conditions.push(format!("target_type = ${idx}"));
    params.push(Param::Text(tt.clone()));
    idx += 1;
  }
  if let Some(ref tid) = filter.target_id {
    conditions.push(format!("target_id = ${idx}"));
    params.push(Param::Text(tid.clone()));
    idx += 1;
  }
  if let Some(ref prefix) = filter.event_key_prefix {
    conditions.push(format!("event_key LIKE ${idx}"));
    params.push(Param::Text(format!("{prefix}%")));
    idx += 1;
  }
  if let Some(from) = filter.from {
    conditions.push(format!("created_at >= ${idx}"));
    params.push(Param::Timestamp(from));
    idx += 1;
  }
  if let Some(to) = filter.to {
    conditions.push(format!("created_at <= ${idx}"));
    params.push(Param::Timestamp(to));
    idx += 1;
  }
  if let Some(uid) = filter.target_unit_id {
    conditions.push(format!("target_unit_id = ${idx}"));
    params.push(Param::Uuid(uid));
    idx += 1; // silence unused warning
    let _ = idx;
  }

  let where_clause = if conditions.is_empty() {
    String::new()
  } else {
    format!(" WHERE {}", conditions.join(" AND "))
  };

  (where_clause, params)
}

fn build_list_query(filter: &AuditFilter, skip: i64, take: i64) -> (String, Vec<Param>) {
  let (where_clause, mut params) = build_where(filter, 1);
  let limit_idx = params.len() + 1;
  let offset_idx = params.len() + 2;

  let sql = format!(
    r#"
    SELECT id, event_key, category, target_type, target_id, target_label,
           old_value, new_value, actor_user_id, actor_label, metadata,
           created_at, target_unit_id, actor_kind, credential_type, credential_id
    FROM admin_audit_log
    {where_clause}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit_idx} OFFSET ${offset_idx}
    "#
  );

  params.push(Param::I64(take.clamp(1, 500)));
  params.push(Param::I64(skip.max(0)));
  (sql, params)
}

fn build_count_query(filter: &AuditFilter) -> (String, Vec<Param>) {
  let (where_clause, params) = build_where(filter, 1);
  let sql = format!("SELECT COUNT(*) FROM admin_audit_log{where_clause}");
  (sql, params)
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

fn map_row(row: sqlx::postgres::PgRow) -> Result<AuditEntry, AuditError> {
  let id: Uuid = row.try_get("id").map_err(|e| AuditError::Storage(e.to_string()))?;
  let event_key: String = row
    .try_get("event_key")
    .map_err(|e| AuditError::Storage(e.to_string()))?;
  let category_str: String = row
    .try_get("category")
    .map_err(|e| AuditError::Storage(e.to_string()))?;
  let category = category_str.parse::<AuditCategory>().unwrap_or_else(|_| {
    warn!(category = %category_str, "unknown audit category in DB — defaulting to Config");
    AuditCategory::Config
  });
  let target_type: Option<String> = row.try_get("target_type").ok().flatten();
  let target_id: Option<String> = row.try_get("target_id").ok().flatten();
  let target_label: Option<String> = row.try_get("target_label").ok().flatten();
  let old_value: Option<serde_json::Value> = row.try_get("old_value").ok().flatten();
  let new_value: Option<serde_json::Value> = row.try_get("new_value").ok().flatten();
  let actor_user_id: Option<Uuid> = row.try_get("actor_user_id").ok().flatten();
  let actor_label: Option<String> = row.try_get("actor_label").ok().flatten();
  let actor_kind_str: Option<String> = row.try_get("actor_kind").ok().flatten();
  let actor_kind = actor_kind_str
    .as_deref()
    .and_then(|raw| raw.parse::<AuditActorKind>().ok())
    .unwrap_or_else(|| {
      if actor_user_id.is_some() {
        AuditActorKind::User
      } else {
        AuditActorKind::System
      }
    });
  let credential_type: Option<String> = row.try_get("credential_type").ok().flatten();
  let credential_id: Option<String> = row.try_get("credential_id").ok().flatten();
  let metadata: Option<serde_json::Value> = row.try_get("metadata").ok().flatten();
  let created_at: DateTime<Utc> = row
    .try_get("created_at")
    .map_err(|e| AuditError::Storage(e.to_string()))?;
  let target_unit_id: Option<Uuid> = row.try_get("target_unit_id").ok().flatten();

  Ok(AuditEntry {
    id,
    event_key,
    category,
    target_type,
    target_id,
    target_label,
    old_value,
    new_value,
    actor_user_id,
    actor_label,
    actor_kind,
    credential_type,
    credential_id,
    metadata,
    created_at,
    target_unit_id,
  })
}
