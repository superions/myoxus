// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed [`OrganizationUnitMemberRepository`].

use async_trait::async_trait;
use sqlx::{PgPool, Postgres, Row, Transaction};
use tracing::{error, instrument};

use myoxus_domain::entities::{OrganizationUnitMember, OrganizationUnitMemberSource, OrganizationUnitRole};
use myoxus_domain::ids::{OrganizationUnitId, UserId};
use myoxus_domain::repositories::{OrganizationUnitMemberRepository, RepoResult, RepositoryError};

#[derive(Debug, Clone)]
pub struct PgOrganizationUnitMemberRepository {
  pool: PgPool,
}

impl PgOrganizationUnitMemberRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    if crate::auth::is_terminal_account_error(&err) {
      return RepositoryError::NotFound("user");
    }
    error!(error = %err, "database error in organization_unit_member repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("organization_unit_member"),
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  pub(crate) fn map_row(row: sqlx::postgres::PgRow) -> OrganizationUnitMember {
    OrganizationUnitMember {
      unit_id: row.get("unit_id"),
      user_id: row.get("user_id"),
      role: OrganizationUnitRole::parse_or_member(&row.get::<String, _>("role_text")),
      source: OrganizationUnitMemberSource::parse_or_manual(&row.get::<String, _>("source_text")),
      metadata: row.get("metadata"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }

  /// Apply the established active-unit and member-limit invariant on a caller-
  /// owned transaction. Aggregate writers use this instead of escaping to the
  /// pool or reimplementing membership rules.
  pub(crate) async fn upsert_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    member: &OrganizationUnitMember,
  ) -> RepoResult<OrganizationUnitMember> {
    let max_members = sqlx::query_scalar::<_, i32>(
      "SELECT max_members FROM organization_unit WHERE id = $1 AND status = 'active' FOR UPDATE",
    )
    .bind(member.unit_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    let Some(max_members) = max_members else {
      return Err(RepositoryError::Conflict("organization_unit is not active"));
    };
    super::PgManagerCapabilityWriter::lock_users(&mut **tx, &[member.user_id])
      .await
      .map_err(Self::map_db_err)?;
    let exists = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(SELECT 1 FROM organization_unit_member WHERE unit_id = $1 AND user_id = $2)",
    )
    .bind(member.unit_id)
    .bind(member.user_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    if !exists {
      let member_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM organization_unit_member WHERE unit_id = $1")
          .bind(member.unit_id)
          .fetch_one(&mut **tx)
          .await
          .map_err(Self::map_db_err)?;
      if member_count >= i64::from(max_members) {
        return Err(RepositoryError::Conflict("organization_unit member limit reached"));
      }
    }
    let row = sqlx::query(
      r#"INSERT INTO organization_unit_member
           (unit_id, user_id, role, source, metadata)
         VALUES ($1, $2, $3::organization_unit_role,
                 $4::organization_unit_member_source, $5)
         ON CONFLICT (unit_id, user_id) DO UPDATE SET
           role = EXCLUDED.role,
           source = EXCLUDED.source,
           metadata = EXCLUDED.metadata,
           updated_at = now()
         RETURNING unit_id, user_id, role::text AS role_text, source::text AS source_text,
                   metadata, created_at, updated_at"#,
    )
    .bind(member.unit_id)
    .bind(member.user_id)
    .bind(member.role.as_str())
    .bind(member.source.as_str())
    .bind(&member.metadata)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_row(row))
  }
  pub(crate) async fn remove_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    unit: OrganizationUnitId,
    user: UserId,
  ) -> RepoResult<()> {
    sqlx::query("DELETE FROM organization_unit_member WHERE unit_id=$1 AND user_id=$2")
      .bind(unit)
      .bind(user)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }
}

#[async_trait]
impl OrganizationUnitMemberRepository for PgOrganizationUnitMemberRepository {
  #[instrument(skip(self), err)]
  async fn list_members(
    &self,
    unit: OrganizationUnitId,
    role: Option<OrganizationUnitRole>,
  ) -> RepoResult<Vec<OrganizationUnitMember>> {
    let rows = if let Some(r) = role {
      sqlx::query(
        r#"SELECT unit_id, user_id, role::text AS role_text, source::text AS source_text, metadata, created_at, updated_at FROM organization_unit_member
           WHERE unit_id = $1 AND role = $2::organization_unit_role
           ORDER BY created_at"#,
      )
      .bind(unit)
      .bind(r.as_str())
      .fetch_all(&self.pool)
      .await
    } else {
      sqlx::query(
        r#"SELECT unit_id, user_id, role::text AS role_text, source::text AS source_text, metadata, created_at, updated_at FROM organization_unit_member
           WHERE unit_id = $1
           ORDER BY created_at"#,
      )
      .bind(unit)
      .fetch_all(&self.pool)
      .await
    }
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn list_for_user(&self, user: UserId) -> RepoResult<Vec<OrganizationUnitMember>> {
    let rows = sqlx::query(
      r#"SELECT unit_id, user_id, role::text AS role_text, source::text AS source_text, metadata, created_at, updated_at FROM organization_unit_member
         WHERE user_id = $1
         ORDER BY created_at"#,
    )
    .bind(user)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn list_members_page(
    &self,
    unit: OrganizationUnitId,
    role: Option<OrganizationUnitRole>,
    offset: i64,
    limit: i64,
  ) -> RepoResult<Vec<OrganizationUnitMember>> {
    let rows = sqlx::query("SELECT unit_id,user_id,role::text AS role_text,source::text AS source_text,metadata,created_at,updated_at FROM organization_unit_member WHERE unit_id=$1 AND ($2::text IS NULL OR role::text=$2) ORDER BY created_at,user_id OFFSET $3 LIMIT $4")
      .bind(unit).bind(role.map(|r| r.as_str())).bind(offset).bind(limit)
      .fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn list_for_user_page(
    &self,
    user: UserId,
    include_inactive: bool,
    offset: i64,
    limit: i64,
  ) -> RepoResult<Vec<OrganizationUnitMember>> {
    let rows = sqlx::query("SELECT m.unit_id,m.user_id,m.role::text AS role_text,m.source::text AS source_text,m.metadata,m.created_at,m.updated_at FROM organization_unit_member m JOIN organization_unit u ON u.id=m.unit_id WHERE m.user_id=$1 AND ($2 OR u.status='active') ORDER BY u.name,u.id OFFSET $3 LIMIT $4")
      .bind(user).bind(include_inactive).bind(offset).bind(limit)
      .fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn get(&self, unit: OrganizationUnitId, user: UserId) -> RepoResult<Option<OrganizationUnitMember>> {
    let row = sqlx::query(
      r#"SELECT unit_id, user_id, role::text AS role_text, source::text AS source_text, metadata, created_at, updated_at FROM organization_unit_member
         WHERE unit_id = $1 AND user_id = $2"#,
    )
    .bind(unit)
    .bind(user)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self, member), err)]
  async fn upsert(&self, member: &OrganizationUnitMember) -> RepoResult<OrganizationUnitMember> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let saved = Self::upsert_in_transaction(&mut tx, member).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }

  #[instrument(skip(self), err)]
  async fn remove(&self, unit: OrganizationUnitId, user: UserId) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SELECT id FROM organization_unit WHERE id=$1 FOR UPDATE")
      .bind(unit)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    super::PgManagerCapabilityWriter::lock_users(&mut tx, &[user])
      .await
      .map_err(Self::map_db_err)?;
    Self::remove_in_transaction(&mut tx, unit, user).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }
}
