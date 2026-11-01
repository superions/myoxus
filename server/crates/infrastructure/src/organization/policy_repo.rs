// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed [`OrganizationPolicyRepository`].

use async_trait::async_trait;
use sqlx::{PgConnection, PgPool, Row};
use tracing::{error, instrument};

use myoxus_domain::entities::{OrganizationPolicy, PolicyState};
use myoxus_domain::ids::OrganizationId;
use myoxus_domain::repositories::{OrganizationPolicyRepository, RepoResult, RepositoryError};

#[derive(Debug, Clone)]
pub struct PgOrganizationPolicyRepository {
  pool: PgPool,
}

impl PgOrganizationPolicyRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in organization_policy repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("organization_policy"),
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> OrganizationPolicy {
    OrganizationPolicy {
      organization_id: row.get("organization_id"),
      manager_root_project_creation: PolicyState::parse_or_disabled(
        &row.get::<String, _>("manager_root_project_creation_text"),
      ),
      manager_unit_project_creation: PolicyState::parse_or_disabled(
        &row.get::<String, _>("manager_unit_project_creation_text"),
      ),
      manager_can_create_workspaces: row.get("manager_can_create_workspaces"),
      manager_can_manage_ou_members: row.get("manager_can_manage_ou_members"),
      import_export_enabled: row.get("import_export_enabled"),
      metadata: row.get("metadata"),
      updated_by: row.get("updated_by"),
      updated_at: row.get("updated_at"),
    }
  }

  /// Upsert policy state on a caller-owned aggregate transaction.
  pub(crate) async fn upsert_in_transaction(
    tx: &mut PgConnection,
    policy: &OrganizationPolicy,
  ) -> RepoResult<OrganizationPolicy> {
    let row = sqlx::query(
      r#"INSERT INTO organization_policy
           (organization_id, manager_root_project_creation,
            manager_unit_project_creation, manager_can_create_workspaces,
            manager_can_manage_ou_members, import_export_enabled,
            metadata, updated_by)
         VALUES ($1, $2::organization_policy_state,
                 $3::organization_policy_state, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id) DO UPDATE SET
           manager_root_project_creation = EXCLUDED.manager_root_project_creation,
           manager_unit_project_creation = EXCLUDED.manager_unit_project_creation,
           manager_can_create_workspaces = EXCLUDED.manager_can_create_workspaces,
           manager_can_manage_ou_members = EXCLUDED.manager_can_manage_ou_members,
           import_export_enabled = EXCLUDED.import_export_enabled,
           metadata = EXCLUDED.metadata,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING organization_id,
                   manager_root_project_creation::text AS manager_root_project_creation_text,
                   manager_unit_project_creation::text AS manager_unit_project_creation_text,
                   manager_can_create_workspaces, manager_can_manage_ou_members,
                   import_export_enabled, metadata, updated_by, updated_at"#,
    )
    .bind(policy.organization_id)
    .bind(policy.manager_root_project_creation.as_str())
    .bind(policy.manager_unit_project_creation.as_str())
    .bind(policy.manager_can_create_workspaces)
    .bind(policy.manager_can_manage_ou_members)
    .bind(policy.import_export_enabled)
    .bind(&policy.metadata)
    .bind(policy.updated_by)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_row(row))
  }
}

#[async_trait]
impl OrganizationPolicyRepository for PgOrganizationPolicyRepository {
  #[instrument(skip(self), err)]
  async fn get(&self, org: OrganizationId) -> RepoResult<OrganizationPolicy> {
    let row = sqlx::query(
      "SELECT organization_id,
              manager_root_project_creation::text AS manager_root_project_creation_text,
              manager_unit_project_creation::text AS manager_unit_project_creation_text,
              manager_can_create_workspaces, manager_can_manage_ou_members,
              import_export_enabled, metadata, updated_by, updated_at
       FROM organization_policy WHERE organization_id = $1",
    )
    .bind(org)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_row(row))
  }

  #[instrument(skip(self, policy), err)]
  async fn upsert(&self, policy: &OrganizationPolicy) -> RepoResult<OrganizationPolicy> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let saved = Self::upsert_in_transaction(&mut tx, policy).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }
}
