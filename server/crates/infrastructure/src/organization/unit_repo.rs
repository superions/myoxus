// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed [`OrganizationUnitRepository`].
//!
//! Implements parent-cycle detection in `set_parent` / `upsert` by walking
//! the candidate parent chain up to [`super::MAX_HIERARCHY_DEPTH`] levels
//! and refusing the move if it would form a cycle. Postgres alone cannot
//! enforce this with a CHECK constraint without recursive CTEs, so the
//! detection lives in the repository.

use async_trait::async_trait;
use sqlx::{PgConnection, PgPool, Row};
use tracing::{error, instrument};

use myoxus_domain::entities::{OrganizationUnit, OrganizationUnitStatus};
use myoxus_domain::ids::{OrganizationId, OrganizationUnitId, UserId};
use myoxus_domain::repositories::{OrganizationUnitCounts, OrganizationUnitRepository, RepoResult, RepositoryError};

#[derive(Debug, Clone)]
pub struct PgOrganizationUnitRepository {
  pool: PgPool,
}

/// Postgres-Enum-Spalte `status` wird als TEXT projiziert (sqlx kann
/// Postgres-Enums nicht direkt nach `String` dekodieren). Alle Listen-Queries
/// aliasen `organization_unit` als `u`, damit Count-Subqueries eindeutig und
/// ohne N+1-Feldresolver gelesen werden koennen.
const SELECT_FIELDS: &str = "u.id, u.organization_id, u.parent_unit_id, u.unit_type_id, u.name, u.slug, \
  u.description, u.status::text AS status_text, u.max_members, u.metadata, u.created_by, u.created_at, u.updated_at";

const COUNT_FIELDS: &str = "\
  COALESCE((SELECT COUNT(*) FROM organization_unit child WHERE child.parent_unit_id = u.id), 0)::BIGINT AS child_unit_count, \
  COALESCE((SELECT COUNT(*) FROM organization_unit_member member WHERE member.unit_id = u.id), 0)::BIGINT AS member_count, \
  COALESCE((SELECT COUNT(*) FROM organization_unit_workspace link WHERE link.unit_id = u.id), 0)::BIGINT AS workspace_count";

impl PgOrganizationUnitRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in organization_unit repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("organization_unit"),
      sqlx::Error::Database(ref dbe) if dbe.code().as_deref() == Some("23505") => {
        RepositoryError::Conflict("organization_unit slug already exists in scope")
      }
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> OrganizationUnit {
    OrganizationUnit {
      id: row.get("id"),
      organization_id: row.get("organization_id"),
      parent_unit_id: row.get("parent_unit_id"),
      unit_type_id: row.get("unit_type_id"),
      name: row.get("name"),
      slug: row.get("slug"),
      description: row.get("description"),
      status: OrganizationUnitStatus::parse_or_active(&row.get::<String, _>("status_text")),
      max_members: row.get("max_members"),
      metadata: row.get("metadata"),
      created_by: row.get("created_by"),
      child_unit_count: row.try_get("child_unit_count").unwrap_or(0),
      member_count: row.try_get("member_count").unwrap_or(0),
      workspace_count: row.try_get("workspace_count").unwrap_or(0),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }

  /// Walk the candidate parent chain. Returns `Err(Conflict)` if `ancestor`
  /// is reached from `start` (i.e. moving `start` under `ancestor` would
  /// form a cycle).
  async fn assert_no_cycle_in_transaction(
    tx: &mut PgConnection,
    start: OrganizationUnitId,
    ancestor: Option<OrganizationUnitId>,
  ) -> RepoResult<()> {
    let mut current = ancestor;
    let mut depth = 0u32;
    while let Some(uid) = current {
      if uid == start {
        return Err(RepositoryError::Conflict("organization_unit cycle"));
      }
      if depth > super::MAX_HIERARCHY_DEPTH {
        return Err(RepositoryError::Conflict("organization_unit hierarchy depth exceeded"));
      }
      let row = sqlx::query("SELECT parent_unit_id FROM organization_unit WHERE id = $1 FOR UPDATE")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      current = match row {
        Some(r) => r.get::<Option<OrganizationUnitId>, _>("parent_unit_id"),
        None => None,
      };
      depth += 1;
    }
    Ok(())
  }

  /// Upsert one unit inside a caller-owned transaction. Parent validation is
  /// shared with ordinary writes and aggregate imports.
  pub(crate) async fn upsert_in_transaction(
    tx: &mut PgConnection,
    unit: &OrganizationUnit,
  ) -> RepoResult<OrganizationUnit> {
    Self::assert_no_cycle_in_transaction(tx, unit.id, unit.parent_unit_id).await?;
    let sql = "INSERT INTO organization_unit \
         (id, organization_id, parent_unit_id, unit_type_id, name, slug, \
          description, status, max_members, metadata, created_by) \
       VALUES ($1, $2, $3, $4, $5, $6, $7, \
               $8::organization_unit_status, $9, $10, $11) \
       ON CONFLICT (id) DO UPDATE SET \
         parent_unit_id = EXCLUDED.parent_unit_id, \
         unit_type_id = EXCLUDED.unit_type_id, \
         name = EXCLUDED.name, \
         slug = EXCLUDED.slug, \
         description = EXCLUDED.description, \
         status = EXCLUDED.status, \
         max_members = EXCLUDED.max_members, \
         metadata = EXCLUDED.metadata, \
         updated_at = now() \
       RETURNING id, organization_id, parent_unit_id, unit_type_id, name, slug, \
         description, status::text AS status_text, max_members, metadata, created_by, created_at, updated_at";
    let row = sqlx::query(sql)
      .bind(unit.id)
      .bind(unit.organization_id)
      .bind(unit.parent_unit_id)
      .bind(unit.unit_type_id)
      .bind(&unit.name)
      .bind(&unit.slug)
      .bind(&unit.description)
      .bind(unit.status.as_str())
      .bind(unit.max_members)
      .bind(&unit.metadata)
      .bind(unit.created_by)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    Ok(Self::map_row(row))
  }

  /// Assign a parent under the same hierarchy guard used by normal writes.
  pub(crate) async fn set_parent_in_transaction(
    tx: &mut PgConnection,
    unit: OrganizationUnitId,
    new_parent: Option<OrganizationUnitId>,
  ) -> RepoResult<()> {
    Self::assert_no_cycle_in_transaction(tx, unit, new_parent).await?;
    let result = sqlx::query(
      r#"UPDATE organization_unit
         SET parent_unit_id = $2, updated_at = now()
         WHERE id = $1"#,
    )
    .bind(unit)
    .bind(new_parent)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("organization_unit"));
    }
    Ok(())
  }
}

#[async_trait]
impl OrganizationUnitRepository for PgOrganizationUnitRepository {
  #[instrument(skip(self), err)]
  async fn list(
    &self,
    org: OrganizationId,
    status: Option<OrganizationUnitStatus>,
  ) -> RepoResult<Vec<OrganizationUnit>> {
    let rows = if let Some(s) = status {
      let sql = format!(
        "SELECT {SELECT_FIELDS}, {COUNT_FIELDS} FROM organization_unit u \
         WHERE u.organization_id = $1 AND u.status = $2::organization_unit_status \
         ORDER BY u.name"
      );
      sqlx::query(&sql).bind(org).bind(s.as_str()).fetch_all(&self.pool).await
    } else {
      let sql = format!(
        "SELECT {SELECT_FIELDS}, {COUNT_FIELDS} FROM organization_unit u \
         WHERE u.organization_id = $1 \
         ORDER BY u.name"
      );
      sqlx::query(&sql).bind(org).fetch_all(&self.pool).await
    }
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn list_children(
    &self,
    org: OrganizationId,
    parent: Option<OrganizationUnitId>,
  ) -> RepoResult<Vec<OrganizationUnit>> {
    let rows = match parent {
      Some(p) => {
        let sql = format!(
          "SELECT {SELECT_FIELDS}, {COUNT_FIELDS} FROM organization_unit u \
           WHERE u.organization_id = $1 AND u.parent_unit_id = $2 \
           ORDER BY u.name"
        );
        sqlx::query(&sql).bind(org).bind(p).fetch_all(&self.pool).await
      }
      None => {
        let sql = format!(
          "SELECT {SELECT_FIELDS}, {COUNT_FIELDS} FROM organization_unit u \
           WHERE u.organization_id = $1 AND u.parent_unit_id IS NULL \
           ORDER BY u.name"
        );
        sqlx::query(&sql).bind(org).fetch_all(&self.pool).await
      }
    }
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn list_for_user(&self, user: UserId) -> RepoResult<Vec<OrganizationUnit>> {
    // Keep this explicit SELECT in sync with SELECT_FIELDS/COUNT_FIELDS while
    // retaining the membership JOIN alias. The counts are direct aggregates
    // for admin/manager tree rendering, not separate follow-up queries.
    let rows = sqlx::query(
      r#"SELECT u.id, u.organization_id, u.parent_unit_id, u.unit_type_id,
                u.name, u.slug, u.description,
                u.status::text AS status_text,
                u.max_members, u.metadata, u.created_by, u.created_at, u.updated_at,
                COALESCE((SELECT COUNT(*) FROM organization_unit child WHERE child.parent_unit_id = u.id), 0)::BIGINT AS child_unit_count,
                COALESCE((SELECT COUNT(*) FROM organization_unit_member member WHERE member.unit_id = u.id), 0)::BIGINT AS member_count,
                COALESCE((SELECT COUNT(*) FROM organization_unit_workspace link WHERE link.unit_id = u.id), 0)::BIGINT AS workspace_count
         FROM organization_unit u
         INNER JOIN organization_unit_member m ON m.unit_id = u.id
         WHERE m.user_id = $1 AND u.status = 'active'
         ORDER BY u.name"#,
    )
    .bind(user)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  // Shared with template context; keep the owner-unit identity out of spans.
  #[instrument(skip_all)]
  async fn get_by_id(&self, id: OrganizationUnitId) -> RepoResult<Option<OrganizationUnit>> {
    let sql = format!("SELECT {SELECT_FIELDS}, {COUNT_FIELDS} FROM organization_unit u WHERE u.id = $1");
    let row = sqlx::query(&sql)
      .bind(id)
      .fetch_optional(&self.pool)
      .await
      .map_err(|_| RepositoryError::Storage("organization unit lookup failed".into()))?;
    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self, ids), err)]
  async fn get_by_ids(&self, ids: &[OrganizationUnitId]) -> RepoResult<Vec<OrganizationUnit>> {
    let rows = sqlx::query("SELECT u.*, u.status::text AS status_text, (SELECT COUNT(*) FROM organization_unit c WHERE c.parent_unit_id=u.id)::BIGINT AS child_unit_count, (SELECT COUNT(*) FROM organization_unit_member m WHERE m.unit_id=u.id)::BIGINT AS member_count, (SELECT COUNT(*) FROM organization_unit_workspace w WHERE w.unit_id=u.id)::BIGINT AS workspace_count FROM organization_unit u WHERE u.id=ANY($1)")
      .bind(ids).fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self, unit), err)]
  async fn upsert(&self, unit: &OrganizationUnit) -> RepoResult<OrganizationUnit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let saved = Self::upsert_in_transaction(&mut tx, unit).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    self
      .get_by_id(saved.id)
      .await?
      .ok_or(RepositoryError::NotFound("organization_unit"))
  }

  #[instrument(skip(self), err)]
  async fn set_parent(&self, unit: OrganizationUnitId, new_parent: Option<OrganizationUnitId>) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::set_parent_in_transaction(&mut tx, unit, new_parent).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn set_status(&self, unit: OrganizationUnitId, status: OrganizationUnitStatus) -> RepoResult<()> {
    let result = sqlx::query(
      r#"UPDATE organization_unit
         SET status = $2::organization_unit_status, updated_at = now()
         WHERE id = $1"#,
    )
    .bind(unit)
    .bind(status.as_str())
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("organization_unit"));
    }
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn search(&self, query: &str, limit: i64) -> RepoResult<Vec<OrganizationUnit>> {
    // Clamp limit to [1, 50] so callers can't drag the DB into a full-table
    // scan with `limit = i64::MAX`. The resolver layer also clamps, but the
    // repository enforces the upper bound as a defence-in-depth contract.
    let clamped = limit.clamp(1, 50);
    let sql = format!(
      "SELECT {SELECT_FIELDS}, {COUNT_FIELDS} FROM organization_unit u \
       WHERE u.name ILIKE '%' || $1 || '%' OR u.slug ILIKE '%' || $1 || '%' \
       ORDER BY u.name ASC \
       LIMIT $2"
    );
    let rows = sqlx::query(&sql)
      .bind(query)
      .bind(clamped)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn breadcrumb_for_unit(&self, unit: OrganizationUnitId) -> RepoResult<Vec<String>> {
    // Walk parent_unit_id upwards. We collect ancestor names in walk order
    // (direct parent first → topmost ancestor last), then reverse so the
    // returned vec is root-first (matches the GraphQL contract: "from the
    // top of the tree down to the unit's direct parent, exclusive of the
    // unit itself").
    let mut current = sqlx::query("SELECT parent_unit_id FROM organization_unit WHERE id = $1")
      .bind(unit)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)?
      .and_then(|r| r.get::<Option<OrganizationUnitId>, _>("parent_unit_id"));
    let mut walked: Vec<String> = Vec::new();
    let mut depth: u32 = 0;
    while let Some(uid) = current {
      if depth > super::MAX_HIERARCHY_DEPTH {
        // Bound runaway walks — same defensive ceiling as `assert_no_cycle`.
        break;
      }
      let row = sqlx::query("SELECT name, parent_unit_id FROM organization_unit WHERE id = $1")
        .bind(uid)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
      match row {
        Some(r) => {
          walked.push(r.get::<String, _>("name"));
          current = r.get::<Option<OrganizationUnitId>, _>("parent_unit_id");
        }
        None => break,
      }
      depth += 1;
    }
    walked.reverse();
    Ok(walked)
  }

  #[instrument(skip(self), err)]
  async fn counts(&self, unit: OrganizationUnitId) -> RepoResult<OrganizationUnitCounts> {
    let row = sqlx::query(
      r#"SELECT
           (SELECT COUNT(*) FROM organization_unit WHERE parent_unit_id = $1) AS child_unit_count,
           (SELECT COUNT(*) FROM organization_unit_member WHERE unit_id = $1) AS member_count,
           (SELECT COUNT(*) FROM organization_unit_workspace WHERE unit_id = $1) AS workspace_count"#,
    )
    .bind(unit)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(OrganizationUnitCounts {
      child_unit_count: row.get("child_unit_count"),
      member_count: row.get("member_count"),
      workspace_count: row.get("workspace_count"),
    })
  }
}
