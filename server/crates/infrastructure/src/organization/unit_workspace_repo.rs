// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed [`OrganizationUnitWorkspaceRepository`].
//!
//! Implementiert das Partial-Unique-Index-Constraint
//! (`relationship='owner'` darf pro Workspace nur einmal vorkommen) als
//! `RepositoryError::Conflict` — Postgres' `unique_violation` (`23505`)
//! wird auf den Conflict-Variant gemapped, andere Fehler bleiben Storage.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::workspace::WorkspaceOwnerTarget;
use sqlx::{PgConnection, PgPool, Row};
use tracing::{error, instrument};

use myoxus_domain::entities::{OrganizationUnitWorkspace, OrganizationUnitWorkspaceRelationship};
use myoxus_domain::ids::{OrganizationUnitId, WorkspaceId};
use myoxus_domain::repositories::{OrganizationUnitWorkspaceRepository, RepoResult, RepositoryError};

use crate::workspace::SqlxWorkspaceStore;

#[derive(Debug, Clone)]
pub struct PgOrganizationUnitWorkspaceRepository {
  pool: PgPool,
}

impl PgOrganizationUnitWorkspaceRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in organization_unit_workspace repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("organization_unit_workspace"),
      sqlx::Error::Database(ref dbe) if dbe.code().as_deref() == Some("23505") => {
        RepositoryError::Conflict("owner relationship already exists for workspace")
      }
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> OrganizationUnitWorkspace {
    OrganizationUnitWorkspace {
      unit_id: row.get("unit_id"),
      workspace_id: row.get("workspace_id"),
      relationship: OrganizationUnitWorkspaceRelationship::parse_or_managed(&row.get::<String, _>("relationship_text")),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }

  /// Apply the canonical relationship and effective-owner projection on a
  /// caller-owned transaction. Aggregate writers reuse this exact path.
  pub(crate) async fn set_relationship_in_transaction(
    tx: &mut PgConnection,
    unit: OrganizationUnitId,
    workspace: WorkspaceId,
    relationship: OrganizationUnitWorkspaceRelationship,
  ) -> RepoResult<()> {
    if relationship == OrganizationUnitWorkspaceRelationship::Owner {
      return SqlxWorkspaceStore::transfer_workspace_owner_in_transaction(
        tx,
        workspace,
        WorkspaceOwnerTarget::OrganizationUnit(unit),
        None,
      )
      .await
      .map(|_| ())
      .map_err(|error| RepositoryError::Validation(error.to_string()));
    }

    // The workspace row is the common lock also used by ownership transfers;
    // ordinary relationship writers and aggregate imports therefore serialize.
    let current_owner: Option<(String, Option<OrganizationUnitId>)> = sqlx::query_as(
      r#"SELECT owner_principal_type::text, owner_principal_id
           FROM workspaces
          WHERE id = $1 AND lifecycle_state = 'active' AND deleted_at IS NULL
          FOR UPDATE"#,
    )
    .bind(workspace)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let Some((owner_type, owner_id)) = current_owner else {
      return Err(RepositoryError::NotFound("workspace"));
    };

    let active = sqlx::query_scalar::<_, OrganizationUnitId>(
      "SELECT id FROM organization_unit WHERE id = $1 AND status = 'active' FOR KEY SHARE",
    )
    .bind(unit)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if active.is_none() {
      return Err(RepositoryError::Conflict("organization_unit is not active"));
    }
    if owner_type == "ou" && owner_id == Some(unit) {
      return Err(RepositoryError::Conflict(
        "shared workspace owner must be transferred to another organization unit",
      ));
    }

    let created_at = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
      "SELECT MIN(created_at)
         FROM organization_unit_workspace
        WHERE unit_id = $1 AND workspace_id = $2",
    )
    .bind(unit)
    .bind(workspace)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query("DELETE FROM organization_unit_workspace WHERE unit_id = $1 AND workspace_id = $2")
      .bind(unit)
      .bind(workspace)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query(
      r#"INSERT INTO organization_unit_workspace
           (unit_id, workspace_id, relationship, created_at, updated_at)
         VALUES ($1, $2, $3::organization_unit_workspace_relationship,
                 COALESCE($4, NOW()), NOW())"#,
    )
    .bind(unit)
    .bind(workspace)
    .bind(relationship.as_str())
    .bind(created_at)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }
}

#[async_trait]
impl OrganizationUnitWorkspaceRepository for PgOrganizationUnitWorkspaceRepository {
  #[instrument(skip(self), err)]
  // Ordinary discovery and OU-role elevation must not expose unpublished targets.
  async fn list_for_unit(&self, unit: OrganizationUnitId) -> RepoResult<Vec<OrganizationUnitWorkspace>> {
    let rows = sqlx::query(
      r#"SELECT unit_id, workspace_id, relationship::text AS relationship_text, created_at, updated_at FROM organization_unit_workspace
         WHERE unit_id = $1
           AND EXISTS (SELECT 1 FROM workspaces w
             WHERE w.id = organization_unit_workspace.workspace_id
               AND w.lifecycle_state = 'active' AND w.deleted_at IS NULL)
         ORDER BY relationship, created_at"#,
    )
    .bind(unit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip_all)]
  async fn list_for_workspace(&self, workspace: WorkspaceId) -> RepoResult<Vec<OrganizationUnitWorkspace>> {
    let rows = sqlx::query(
      r#"SELECT unit_id, workspace_id, relationship::text AS relationship_text, created_at, updated_at FROM organization_unit_workspace
         WHERE workspace_id = $1
           AND EXISTS (SELECT 1 FROM workspaces w
             WHERE w.id = organization_unit_workspace.workspace_id
               AND w.lifecycle_state = 'active' AND w.deleted_at IS NULL)
         ORDER BY relationship, created_at"#,
    )
    .bind(workspace)
    .fetch_all(&self.pool)
    .await
    .map_err(|_| RepositoryError::Storage("organization workspace link lookup failed".into()))?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn get(
    &self,
    unit: OrganizationUnitId,
    workspace: WorkspaceId,
    relationship: OrganizationUnitWorkspaceRelationship,
  ) -> RepoResult<Option<OrganizationUnitWorkspace>> {
    let row = sqlx::query(
      r#"SELECT unit_id, workspace_id, relationship::text AS relationship_text, created_at, updated_at FROM organization_unit_workspace
         WHERE unit_id = $1 AND workspace_id = $2
           AND relationship = $3::organization_unit_workspace_relationship"#,
    )
    .bind(unit)
    .bind(workspace)
    .bind(relationship.as_str())
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self), err)]
  async fn set_relationship(
    &self,
    unit: OrganizationUnitId,
    workspace: WorkspaceId,
    relationship: OrganizationUnitWorkspaceRelationship,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::set_relationship_in_transaction(&mut tx, unit, workspace, relationship).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn unassign(
    &self,
    unit: OrganizationUnitId,
    workspace: WorkspaceId,
    relationship: OrganizationUnitWorkspaceRelationship,
  ) -> RepoResult<()> {
    if relationship == OrganizationUnitWorkspaceRelationship::Owner {
      return Err(RepositoryError::Conflict(
        "shared workspace owner must be transferred to another organization unit",
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query_scalar::<_, WorkspaceId>("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE")
      .bind(workspace)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query(
      r#"DELETE FROM organization_unit_workspace
         WHERE unit_id = $1 AND workspace_id = $2
           AND relationship = $3::organization_unit_workspace_relationship"#,
    )
    .bind(unit)
    .bind(workspace)
    .bind(relationship.as_str())
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }
}
