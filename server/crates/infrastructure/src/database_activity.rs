// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed implementation of [`DatabaseActivityStore`].
//!
//! Mirrors the dynamic-query strategy used by [`crate::audit::PgAuditLogStore`]:
//! predicates are appended to a base SELECT based on which filter fields are
//! set; values are always bound, never interpolated.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::database_activity::{
  DatabaseActivityEntry, DatabaseActivityError, DatabaseActivityEvent, DatabaseActivityEventType,
  DatabaseActivityFilter, DatabaseActivityStore,
};
use sqlx::{PgPool, Row};

/// PostgreSQL-backed implementation of [`DatabaseActivityStore`].
#[derive(Debug, Clone)]
pub struct PgDatabaseActivityStore {
  pool: PgPool,
}

impl PgDatabaseActivityStore {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> DatabaseActivityError {
    DatabaseActivityError::Storage(err.to_string())
  }
}

#[async_trait]
impl DatabaseActivityStore for PgDatabaseActivityStore {
  #[tracing::instrument(skip(self), level = "debug")]
  async fn record(&self, event: DatabaseActivityEvent) -> Result<(), DatabaseActivityError> {
    sqlx::query(
      r#"
      INSERT INTO database_activity_events
          (workspace_id, database_id, row_id, event_type, actor_user_id, payload)
      VALUES ($1, $2, $3, $4, $5, $6)
      "#,
    )
    .bind(event.workspace_id)
    .bind(event.database_id)
    .bind(event.row_id)
    .bind(event.event_type.as_str())
    .bind(event.actor_user_id)
    .bind(&event.payload)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  #[tracing::instrument(skip(self), level = "debug")]
  async fn list(
    &self,
    filter: DatabaseActivityFilter,
    skip: i64,
    take: i64,
  ) -> Result<Vec<DatabaseActivityEntry>, DatabaseActivityError> {
    let (sql, params) = build_list_query(&filter, skip, take);
    let mut q = sqlx::query(&sql);
    for p in &params {
      q = bind_param(q, p);
    }
    let rows = q.fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    rows.into_iter().map(map_row).collect()
  }

  #[tracing::instrument(skip(self), level = "debug")]
  async fn count(&self, filter: DatabaseActivityFilter) -> Result<i64, DatabaseActivityError> {
    let (sql, params) = build_count_query(&filter);
    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for p in &params {
      q = bind_scalar_param(q, p);
    }
    q.fetch_one(&self.pool).await.map_err(Self::map_db_err)
  }
}

// ─── Dynamic query builder ────────────────────────────────────────────────────

enum Param {
  Uuid(uuid::Uuid),
  Timestamp(DateTime<Utc>),
  I64(i64),
  TextArray(Vec<String>),
}

fn bind_param<'q>(
  q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
  p: &Param,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
  match p {
    Param::Uuid(u) => q.bind(*u),
    Param::Timestamp(t) => q.bind(*t),
    Param::I64(n) => q.bind(*n),
    Param::TextArray(arr) => q.bind(arr.clone()),
  }
}

fn bind_scalar_param<'q>(
  q: sqlx::query::QueryScalar<'q, sqlx::Postgres, i64, sqlx::postgres::PgArguments>,
  p: &Param,
) -> sqlx::query::QueryScalar<'q, sqlx::Postgres, i64, sqlx::postgres::PgArguments> {
  match p {
    Param::Uuid(u) => q.bind(*u),
    Param::Timestamp(t) => q.bind(*t),
    Param::I64(n) => q.bind(*n),
    Param::TextArray(arr) => q.bind(arr.clone()),
  }
}

fn build_where(filter: &DatabaseActivityFilter, start_idx: usize) -> (String, Vec<Param>) {
  let mut conditions: Vec<String> = Vec::new();
  let mut params: Vec<Param> = Vec::new();
  let mut idx = start_idx;

  // Historical payload ownership remains truthful. A surviving Row must still
  // belong to the authorized workspace before its activity is disclosed.
  conditions.push("(activity.row_id IS NULL OR EXISTS (SELECT 1 FROM workspace_database_rows current_row JOIN workspace_databases current_database ON current_database.id=current_row.database_id WHERE current_row.id=activity.row_id AND current_database.workspace_id=activity.workspace_id))".into());

  // workspace_id is mandatory
  conditions.push(format!("activity.workspace_id = ${idx}"));
  params.push(Param::Uuid(filter.workspace_id));
  idx += 1;

  if let Some(database_id) = filter.database_id {
    conditions.push(format!("activity.database_id = ${idx}"));
    params.push(Param::Uuid(database_id));
    idx += 1;
  }
  if let Some(row_id) = filter.row_id {
    conditions.push(format!("activity.row_id = ${idx}"));
    params.push(Param::Uuid(row_id));
    idx += 1;
  }
  if let Some(actor_user_id) = filter.actor_user_id {
    conditions.push(format!("activity.actor_user_id = ${idx}"));
    params.push(Param::Uuid(actor_user_id));
    idx += 1;
  }
  if !filter.event_types.is_empty() {
    let literals: Vec<String> = filter.event_types.iter().map(|t| t.as_str().to_string()).collect();
    conditions.push(format!("activity.event_type = ANY(${idx})"));
    params.push(Param::TextArray(literals));
    idx += 1;
  }
  if let Some(from) = filter.from {
    conditions.push(format!("activity.created_at >= ${idx}"));
    params.push(Param::Timestamp(from));
    idx += 1;
  }
  if let Some(to) = filter.to {
    conditions.push(format!("activity.created_at <= ${idx}"));
    params.push(Param::Timestamp(to));
    // No further predicates follow `to` in the WHERE clause, so incrementing
    // `idx` is intentionally skipped.
  }

  let where_clause = format!(" WHERE {}", conditions.join(" AND "));
  (where_clause, params)
}

fn build_list_query(filter: &DatabaseActivityFilter, skip: i64, take: i64) -> (String, Vec<Param>) {
  let (where_clause, mut params) = build_where(filter, 1);
  let limit_idx = params.len() + 1;
  let offset_idx = params.len() + 2;

  let sql = format!(
    r#"
    SELECT activity.id, activity.workspace_id, activity.database_id,
           activity.row_id, activity.event_type, activity.actor_user_id,
           NULLIF(BTRIM(actor.name), '') AS actor_display_name,
           activity.payload, activity.created_at
    FROM database_activity_events AS activity
    LEFT JOIN users AS actor ON actor.id = activity.actor_user_id
    {where_clause}
    ORDER BY activity.created_at DESC, activity.id DESC
    LIMIT ${limit_idx} OFFSET ${offset_idx}
    "#
  );

  params.push(Param::I64(take.clamp(1, 500)));
  params.push(Param::I64(skip.max(0)));
  (sql, params)
}

fn build_count_query(filter: &DatabaseActivityFilter) -> (String, Vec<Param>) {
  let (where_clause, params) = build_where(filter, 1);
  let sql = format!("SELECT COUNT(*) FROM database_activity_events AS activity{where_clause}");
  (sql, params)
}

fn map_row(row: sqlx::postgres::PgRow) -> Result<DatabaseActivityEntry, DatabaseActivityError> {
  let id: uuid::Uuid = row
    .try_get("id")
    .map_err(|e| DatabaseActivityError::Storage(e.to_string()))?;
  let workspace_id: uuid::Uuid = row
    .try_get("workspace_id")
    .map_err(|e| DatabaseActivityError::Storage(e.to_string()))?;
  let database_id: uuid::Uuid = row
    .try_get("database_id")
    .map_err(|e| DatabaseActivityError::Storage(e.to_string()))?;
  let row_id: Option<uuid::Uuid> = row.try_get("row_id").ok().flatten();
  let event_type_str: String = row
    .try_get("event_type")
    .map_err(|e| DatabaseActivityError::Storage(e.to_string()))?;
  let event_type = event_type_str
    .parse::<DatabaseActivityEventType>()
    .unwrap_or(DatabaseActivityEventType::RowUpdated);
  let actor_user_id: Option<uuid::Uuid> = row.try_get("actor_user_id").ok().flatten();
  let actor_display_name: Option<String> = row.try_get("actor_display_name").ok().flatten();
  let payload: serde_json::Value = row
    .try_get::<Option<serde_json::Value>, _>("payload")
    .ok()
    .flatten()
    .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
  let created_at: DateTime<Utc> = row
    .try_get("created_at")
    .map_err(|e| DatabaseActivityError::Storage(e.to_string()))?;

  Ok(DatabaseActivityEntry {
    id,
    workspace_id,
    database_id,
    row_id,
    event_type,
    actor_user_id,
    actor_display_name,
    payload,
    created_at,
  })
}
