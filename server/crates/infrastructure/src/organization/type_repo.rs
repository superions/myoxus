// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed [`OrganizationUnitTypeRepository`].

use async_trait::async_trait;
use sqlx::{PgConnection, PgPool, Row};
use tracing::{error, instrument};

use myoxus_domain::entities::OrganizationUnitType;
use myoxus_domain::ids::{OrganizationId, OrganizationUnitTypeId};
use myoxus_domain::repositories::{OrganizationUnitTypeRepository, RepoResult, RepositoryError};

#[derive(Debug, Clone)]
pub struct PgOrganizationUnitTypeRepository {
  pool: PgPool,
}

impl PgOrganizationUnitTypeRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in organization_unit_type repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("organization_unit_type"),
      sqlx::Error::Database(ref dbe) if dbe.code().as_deref() == Some("23505") => {
        RepositoryError::Conflict("organization_unit_type key already exists in organization")
      }
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> OrganizationUnitType {
    OrganizationUnitType {
      id: row.get("id"),
      organization_id: row.get("organization_id"),
      key: row.get("key"),
      label: row.get("label"),
      description: row.get("description"),
      icon: row.get("icon"),
      color: row.get("color"),
      is_preset: row.get("is_preset"),
      is_active: row.get("is_active"),
      is_structural: row.get("is_structural"),
      can_have_children: row.get("can_have_children"),
      can_be_root_level: row.get("can_be_root_level"),
      can_be_manager_created: row.get("can_be_manager_created"),
      can_have_cross_unit_members: row.get("can_have_cross_unit_members"),
      can_own_workspaces: row.get("can_own_workspaces"),
      can_manage_workspaces: row.get("can_manage_workspaces"),
      is_staff_unit: row.get("is_staff_unit"),
      requires_admin_approval: row.get("requires_admin_approval"),
      metadata: row.get("metadata"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }

  /// Upsert one type inside a caller-owned aggregate transaction.
  pub(crate) async fn upsert_in_transaction(
    tx: &mut PgConnection,
    ty: &OrganizationUnitType,
  ) -> RepoResult<OrganizationUnitType> {
    let row = sqlx::query(
      r#"INSERT INTO organization_unit_type
           (id, organization_id, key, label, description, icon, color,
            is_preset, is_active, is_structural, can_have_children,
            can_be_root_level, can_be_manager_created,
            can_have_cross_unit_members, can_own_workspaces,
            can_manage_workspaces, is_staff_unit, requires_admin_approval,
            metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (organization_id, key) DO UPDATE SET
           label = EXCLUDED.label,
           description = EXCLUDED.description,
           icon = EXCLUDED.icon,
           color = EXCLUDED.color,
           is_active = EXCLUDED.is_active,
           is_structural = EXCLUDED.is_structural,
           can_have_children = EXCLUDED.can_have_children,
           can_be_root_level = EXCLUDED.can_be_root_level,
           can_be_manager_created = EXCLUDED.can_be_manager_created,
           can_have_cross_unit_members = EXCLUDED.can_have_cross_unit_members,
           can_own_workspaces = EXCLUDED.can_own_workspaces,
           can_manage_workspaces = EXCLUDED.can_manage_workspaces,
           is_staff_unit = EXCLUDED.is_staff_unit,
           requires_admin_approval = EXCLUDED.requires_admin_approval,
           metadata = EXCLUDED.metadata,
           updated_at = now()
         RETURNING *"#,
    )
    .bind(ty.id)
    .bind(ty.organization_id)
    .bind(&ty.key)
    .bind(&ty.label)
    .bind(&ty.description)
    .bind(&ty.icon)
    .bind(&ty.color)
    .bind(ty.is_preset)
    .bind(ty.is_active)
    .bind(ty.is_structural)
    .bind(ty.can_have_children)
    .bind(ty.can_be_root_level)
    .bind(ty.can_be_manager_created)
    .bind(ty.can_have_cross_unit_members)
    .bind(ty.can_own_workspaces)
    .bind(ty.can_manage_workspaces)
    .bind(ty.is_staff_unit)
    .bind(ty.requires_admin_approval)
    .bind(&ty.metadata)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_row(row))
  }
}

#[async_trait]
impl OrganizationUnitTypeRepository for PgOrganizationUnitTypeRepository {
  #[instrument(skip(self), err)]
  async fn list(&self, org: OrganizationId, include_inactive: bool) -> RepoResult<Vec<OrganizationUnitType>> {
    let rows = if include_inactive {
      sqlx::query(
        r#"SELECT * FROM organization_unit_type
           WHERE organization_id = $1
           ORDER BY is_preset DESC, key"#,
      )
      .bind(org)
      .fetch_all(&self.pool)
      .await
    } else {
      sqlx::query(
        r#"SELECT * FROM organization_unit_type
           WHERE organization_id = $1 AND is_active = true
           ORDER BY is_preset DESC, key"#,
      )
      .bind(org)
      .fetch_all(&self.pool)
      .await
    }
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn list_page(
    &self,
    org: OrganizationId,
    include_inactive: bool,
    offset: i64,
    limit: i64,
  ) -> RepoResult<Vec<OrganizationUnitType>> {
    let rows = sqlx::query("SELECT * FROM organization_unit_type WHERE organization_id=$1 AND ($2 OR is_active) ORDER BY is_preset DESC,key,id OFFSET $3 LIMIT $4")
      .bind(org).bind(include_inactive).bind(offset).bind(limit)
      .fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn get_by_id(&self, id: OrganizationUnitTypeId) -> RepoResult<Option<OrganizationUnitType>> {
    let row = sqlx::query(r#"SELECT * FROM organization_unit_type WHERE id = $1"#)
      .bind(id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self), err)]
  async fn get_by_key(&self, org: OrganizationId, key: &str) -> RepoResult<Option<OrganizationUnitType>> {
    let row = sqlx::query(r#"SELECT * FROM organization_unit_type WHERE organization_id = $1 AND key = $2"#)
      .bind(org)
      .bind(key)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self, ty), err)]
  async fn upsert(&self, ty: &OrganizationUnitType) -> RepoResult<OrganizationUnitType> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let saved = Self::upsert_in_transaction(&mut tx, ty).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }

  #[instrument(skip(self), err)]
  async fn deactivate(&self, id: OrganizationUnitTypeId) -> RepoResult<()> {
    sqlx::query(
      r#"UPDATE organization_unit_type
         SET is_active = false, updated_at = now()
         WHERE id = $1"#,
    )
    .bind(id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }
}
