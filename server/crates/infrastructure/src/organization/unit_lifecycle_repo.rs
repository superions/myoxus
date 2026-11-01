// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transactional organization-unit lifecycle persistence.
//!
//! The lifecycle repository deliberately rechecks every delete blocker while
//! holding the target OU row lock. Existing `ON DELETE CASCADE` constraints are
//! therefore defensive schema details, never product deletion semantics.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Row, Transaction};
use tracing::{error, instrument};

use myoxus_contracts::oauth_config::{OAuthProviderConfig, decode_oauth_provider_named};
use myoxus_domain::entities::{
  OrganizationUnit, OrganizationUnitDeletionBlocker, OrganizationUnitDeletionBlockerCode,
  OrganizationUnitDeletionPreview, OrganizationUnitStatus,
};
use myoxus_domain::ids::{OrganizationId, OrganizationUnitId, OrganizationUnitTypeId};
use myoxus_domain::repositories::{OrganizationUnitLifecycleRepository, RepoResult, RepositoryError};

/// Shared serialization key for OU deletion and effective OIDC mapping writes.
pub const ORGANIZATION_LIFECYCLE_LOCK: &str = "myoxus.organization-unit-lifecycle";

#[derive(Debug, Clone)]
pub struct PgOrganizationUnitLifecycleRepository {
  pool: PgPool,
  /// Startup YAML/environment provider projection. Live provider rows from
  /// `app_configs` replace entries while the lifecycle advisory lock is held.
  startup_oidc_providers: serde_json::Value,
}

impl PgOrganizationUnitLifecycleRepository {
  pub fn new(pool: PgPool, startup_oidc_providers: serde_json::Value) -> Self {
    Self {
      pool,
      startup_oidc_providers,
    }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in organization unit lifecycle repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("organization_unit"),
      sqlx::Error::Database(ref error) if error.code().as_deref() == Some("23505") => {
        RepositoryError::Conflict("ORGANIZATION_UNIT_SLUG_CONFLICT")
      }
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  async fn lock_lifecycle(tx: &mut Transaction<'_, Postgres>) -> RepoResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
      .bind(ORGANIZATION_LIFECYCLE_LOCK)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  async fn lock_unit(tx: &mut Transaction<'_, Postgres>, id: OrganizationUnitId) -> RepoResult<OrganizationUnit> {
    let row = sqlx::query(
      r#"SELECT u.id, u.organization_id, u.parent_unit_id, u.unit_type_id,
                u.name, u.slug, u.description, u.status::text AS status_text,
                u.max_members, u.metadata, u.created_by, u.created_at, u.updated_at,
                (SELECT COUNT(*) FROM organization_unit c WHERE c.parent_unit_id = u.id)::BIGINT AS child_unit_count,
                (SELECT COUNT(*) FROM organization_unit_member m WHERE m.unit_id = u.id)::BIGINT AS member_count,
                (SELECT COUNT(*) FROM organization_unit_workspace w WHERE w.unit_id = u.id)::BIGINT AS workspace_count
           FROM organization_unit u
          WHERE u.id = $1
          FOR UPDATE"#,
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(RepositoryError::NotFound("organization_unit"))?;
    Ok(Self::map_row(row))
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

  async fn validate_placement(
    tx: &mut Transaction<'_, Postgres>,
    id: OrganizationUnitId,
    organization_id: OrganizationId,
    parent: Option<OrganizationUnitId>,
    unit_type: OrganizationUnitTypeId,
  ) -> RepoResult<()> {
    // Keep authoring and lifecycle transitions serialized with OU-type
    // deactivation. A plain existence check would allow the type to become
    // inactive between validation and the unit write.
    let type_root_capability = sqlx::query_scalar::<_, bool>(
      r#"SELECT can_be_root_level
            FROM organization_unit_type
           WHERE id = $1 AND organization_id = $2 AND is_active
           FOR KEY SHARE"#,
    )
    .bind(unit_type)
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    let Some(type_can_be_root) = type_root_capability else {
      return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_TYPE_INACTIVE"));
    };

    if let Some(parent) = parent {
      let parent_valid = sqlx::query_scalar::<_, OrganizationUnitId>(
        r#"SELECT p.id
              FROM organization_unit p
              JOIN organization_unit_type pt ON pt.id = p.unit_type_id
             WHERE p.id = $1 AND p.organization_id = $2
               AND p.status = 'active' AND pt.can_have_children
             FOR KEY SHARE"#,
      )
      .bind(parent)
      .bind(organization_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      if parent_valid.is_none() {
        return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_PARENT_INACTIVE"));
      }

      let creates_cycle: bool = sqlx::query_scalar(
        r#"WITH RECURSIVE ancestors(id, parent_unit_id, depth) AS (
             SELECT id, parent_unit_id, 0 FROM organization_unit WHERE id = $1
             UNION ALL
             SELECT p.id, p.parent_unit_id, a.depth + 1
               FROM organization_unit p JOIN ancestors a ON p.id = a.parent_unit_id
              WHERE a.depth < 32
           )
           SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = $2)"#,
      )
      .bind(parent)
      .bind(id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      if creates_cycle {
        return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_CYCLE"));
      }
    } else {
      if !type_can_be_root {
        return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_ROOT_NOT_ALLOWED"));
      }
    }
    Ok(())
  }

  async fn effective_oidc_mapping_count(
    &self,
    tx: &mut Transaction<'_, Postgres>,
    id: OrganizationUnitId,
  ) -> RepoResult<i64> {
    let mut providers = self.startup_oidc_providers.as_object().cloned().unwrap_or_default();
    let rows = sqlx::query_as::<_, (String, serde_json::Value)>(
      "SELECT id, value FROM app_configs WHERE id LIKE 'oauth.providers.%'",
    )
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    for (key, value) in rows {
      if let Some(provider) = key.strip_prefix("oauth.providers.") {
        providers.insert(provider.to_string(), value);
      }
    }
    let target = id.to_string();
    let mut count = 0_i64;
    for (provider_name, value) in providers {
      let provider = decode_oauth_provider_named(&provider_name, value)
        .map_err(|error| RepositoryError::Validation(error.to_string()))?;
      let OAuthProviderConfig::Custom(provider) = provider else {
        continue;
      };
      if provider.group_mapping.enabled {
        count += provider
          .group_mapping
          .mappings
          .iter()
          .filter(|mapping| mapping.target_unit_id == target)
          .count() as i64;
      }
    }
    Ok(count)
  }

  async fn blockers(
    &self,
    tx: &mut Transaction<'_, Postgres>,
    id: OrganizationUnitId,
  ) -> RepoResult<Vec<OrganizationUnitDeletionBlocker>> {
    let effective_oidc_mapping_count = self.effective_oidc_mapping_count(tx, id).await?;
    let row = sqlx::query(
      r#"SELECT
          (SELECT COUNT(*) FROM organization_unit WHERE parent_unit_id = $1)::BIGINT AS child_units,
          (SELECT COUNT(*) FROM organization_unit_member WHERE unit_id = $1)::BIGINT AS members,
          (SELECT COUNT(*) FROM organization_unit_workspace WHERE unit_id = $1)::BIGINT AS workspace_links,
          (SELECT COUNT(*) FROM workspaces WHERE owner_principal_type = 'ou' AND owner_principal_id = $1)::BIGINT AS owner_workspaces,
          (SELECT COUNT(*) FROM workspaces WHERE management_unit_id = $1)::BIGINT AS management_workspaces,
          (SELECT COUNT(*) FROM organization_project_request WHERE parent_unit_id = $1)::BIGINT AS project_requests"#,
    )
    .bind(id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;

    let candidates = [
      (OrganizationUnitDeletionBlockerCode::ChildUnits, row.get("child_units")),
      (OrganizationUnitDeletionBlockerCode::Members, row.get("members")),
      (
        OrganizationUnitDeletionBlockerCode::WorkspaceLinks,
        row.get("workspace_links"),
      ),
      (
        OrganizationUnitDeletionBlockerCode::OwnerPrincipalWorkspaces,
        row.get("owner_workspaces"),
      ),
      (
        OrganizationUnitDeletionBlockerCode::ManagementUnitWorkspaces,
        row.get("management_workspaces"),
      ),
      (
        OrganizationUnitDeletionBlockerCode::ProjectRequests,
        row.get("project_requests"),
      ),
      (
        OrganizationUnitDeletionBlockerCode::OidcGroupMappings,
        effective_oidc_mapping_count.max(0),
      ),
    ];
    Ok(
      candidates
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(code, count)| OrganizationUnitDeletionBlocker { code, count })
        .collect(),
    )
  }

  async fn load_after_write(
    tx: &mut Transaction<'_, Postgres>,
    id: OrganizationUnitId,
  ) -> RepoResult<OrganizationUnit> {
    let row = sqlx::query(
      r#"SELECT u.id, u.organization_id, u.parent_unit_id, u.unit_type_id,
                u.name, u.slug, u.description, u.status::text AS status_text,
                u.max_members, u.metadata, u.created_by, u.created_at, u.updated_at,
                (SELECT COUNT(*) FROM organization_unit c WHERE c.parent_unit_id = u.id)::BIGINT AS child_unit_count,
                (SELECT COUNT(*) FROM organization_unit_member m WHERE m.unit_id = u.id)::BIGINT AS member_count,
                (SELECT COUNT(*) FROM organization_unit_workspace w WHERE w.unit_id = u.id)::BIGINT AS workspace_count
           FROM organization_unit u WHERE u.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(RepositoryError::NotFound("organization_unit"))?;
    Ok(Self::map_row(row))
  }
}

#[async_trait]
impl OrganizationUnitLifecycleRepository for PgOrganizationUnitLifecycleRepository {
  #[instrument(skip(self, unit), fields(unit_id = %unit.id), err)]
  async fn create(&self, unit: &OrganizationUnit) -> RepoResult<OrganizationUnit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::validate_placement(
      &mut tx,
      unit.id,
      unit.organization_id,
      unit.parent_unit_id,
      unit.unit_type_id,
    )
    .await?;
    sqlx::query(
      r#"INSERT INTO organization_unit
           (id, organization_id, parent_unit_id, unit_type_id, name, slug,
            description, status, max_members, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 $8::organization_unit_status, $9, $10, $11)"#,
    )
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
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let saved = Self::load_after_write(&mut tx, unit.id).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }

  #[instrument(skip(self, unit), fields(unit_id = %unit.id), err)]
  async fn update(&self, unit: &OrganizationUnit) -> RepoResult<OrganizationUnit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_lifecycle(&mut tx).await?;
    let current = Self::lock_unit(&mut tx, unit.id).await?;
    if !current.status.can_transition_to(unit.status) {
      return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_INVALID_TRANSITION"));
    }
    Self::validate_placement(
      &mut tx,
      unit.id,
      current.organization_id,
      unit.parent_unit_id,
      unit.unit_type_id,
    )
    .await?;
    if unit.status != OrganizationUnitStatus::Active && current.status != unit.status {
      let blockers = self.blockers(&mut tx, unit.id).await?;
      if blockers.iter().any(|blocker| {
        matches!(
          blocker.code,
          OrganizationUnitDeletionBlockerCode::ChildUnits
            | OrganizationUnitDeletionBlockerCode::OwnerPrincipalWorkspaces
            | OrganizationUnitDeletionBlockerCode::ManagementUnitWorkspaces
            | OrganizationUnitDeletionBlockerCode::OidcGroupMappings
        )
      }) {
        return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_IN_USE"));
      }
    }
    let result = sqlx::query(
      r#"UPDATE organization_unit
            SET parent_unit_id = $2, unit_type_id = $3, name = $4, slug = $5,
                description = $6, status = $7::organization_unit_status,
                max_members = $8, metadata = $9, updated_at = NOW()
          WHERE id = $1"#,
    )
    .bind(unit.id)
    .bind(unit.parent_unit_id)
    .bind(unit.unit_type_id)
    .bind(&unit.name)
    .bind(&unit.slug)
    .bind(&unit.description)
    .bind(unit.status.as_str())
    .bind(unit.max_members)
    .bind(&unit.metadata)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("organization_unit"));
    }
    let saved = Self::load_after_write(&mut tx, unit.id).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }

  #[instrument(skip(self), fields(unit_id = %unit), err)]
  async fn move_unit(
    &self,
    unit: OrganizationUnitId,
    parent: Option<OrganizationUnitId>,
  ) -> RepoResult<OrganizationUnit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let current = Self::lock_unit(&mut tx, unit).await?;
    Self::validate_placement(&mut tx, unit, current.organization_id, parent, current.unit_type_id).await?;
    let result = sqlx::query("UPDATE organization_unit SET parent_unit_id = $2, updated_at = NOW() WHERE id = $1")
      .bind(unit)
      .bind(parent)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if result.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("organization_unit"));
    }
    let saved = Self::load_after_write(&mut tx, unit).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }

  #[instrument(skip(self), fields(unit_id = %unit, target_status = status.as_str()), err)]
  async fn set_lifecycle_status(
    &self,
    unit: OrganizationUnitId,
    status: OrganizationUnitStatus,
  ) -> RepoResult<OrganizationUnit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_lifecycle(&mut tx).await?;
    let current = Self::lock_unit(&mut tx, unit).await?;
    if !current.status.can_transition_to(status) {
      return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_INVALID_TRANSITION"));
    }
    if current.status == status {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(current);
    }
    if status == OrganizationUnitStatus::Active {
      Self::validate_placement(
        &mut tx,
        unit,
        current.organization_id,
        current.parent_unit_id,
        current.unit_type_id,
      )
      .await?;
    } else {
      let blockers = self.blockers(&mut tx, unit).await?;
      let operational_blocker = blockers.iter().any(|blocker| {
        matches!(
          blocker.code,
          OrganizationUnitDeletionBlockerCode::ChildUnits
            | OrganizationUnitDeletionBlockerCode::OwnerPrincipalWorkspaces
            | OrganizationUnitDeletionBlockerCode::ManagementUnitWorkspaces
            | OrganizationUnitDeletionBlockerCode::OidcGroupMappings
        )
      });
      if operational_blocker {
        return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_IN_USE"));
      }
    }
    let result = sqlx::query(
      "UPDATE organization_unit SET status = $2::organization_unit_status, updated_at = NOW() WHERE id = $1",
    )
    .bind(unit)
    .bind(status.as_str())
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("organization_unit"));
    }
    let saved = Self::load_after_write(&mut tx, unit).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }

  #[instrument(skip(self), fields(unit_id = %unit), err)]
  async fn deletion_preview(&self, unit: OrganizationUnitId) -> RepoResult<OrganizationUnitDeletionPreview> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_lifecycle(&mut tx).await?;
    let current = Self::lock_unit(&mut tx, unit).await?;
    let blockers = self.blockers(&mut tx, unit).await?;
    let deletable = current.status != OrganizationUnitStatus::Active && blockers.is_empty();
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(OrganizationUnitDeletionPreview {
      id: current.id,
      name: current.name,
      status: current.status,
      updated_at: current.updated_at,
      deletable,
      blockers,
    })
  }

  #[instrument(skip(self, confirmed_name), fields(unit_id = %unit), err)]
  async fn delete_permanently(
    &self,
    unit: OrganizationUnitId,
    confirmed_name: &str,
    preview_revision: DateTime<Utc>,
  ) -> RepoResult<OrganizationUnit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_lifecycle(&mut tx).await?;
    let current = Self::lock_unit(&mut tx, unit).await?;
    if current.name != confirmed_name {
      return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_CONFIRMATION_MISMATCH"));
    }
    if current.updated_at != preview_revision {
      return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_CONFLICT"));
    }
    if current.status == OrganizationUnitStatus::Active {
      return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_ACTIVE"));
    }
    if !self.blockers(&mut tx, unit).await?.is_empty() {
      return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_IN_USE"));
    }
    let result = sqlx::query("DELETE FROM organization_unit WHERE id = $1")
      .bind(unit)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if result.rows_affected() != 1 {
      return Err(RepositoryError::NotFound("organization_unit"));
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(current)
  }
}
