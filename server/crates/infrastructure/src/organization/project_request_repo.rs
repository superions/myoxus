// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed [`OrganizationProjectRequestRepository`].

use async_trait::async_trait;
use chrono::Utc;
use sqlx::{PgPool, Row};
use tracing::{error, instrument};

use myoxus_domain::entities::{OrganizationProjectRequest, ProjectRequestScope, ProjectRequestStatus};
use myoxus_domain::ids::{OrganizationId, OrganizationProjectRequestId, UserId};
use myoxus_domain::repositories::{OrganizationProjectRequestRepository, RepoResult, RepositoryError};

#[derive(Debug, Clone)]
pub struct PgOrganizationProjectRequestRepository {
  pool: PgPool,
}

impl PgOrganizationProjectRequestRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in organization_project_request repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("organization_project_request"),
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> OrganizationProjectRequest {
    OrganizationProjectRequest {
      id: row.get("id"),
      organization_id: row.get("organization_id"),
      requested_by: row.get("requested_by"),
      requested_scope: ProjectRequestScope::parse(&row.get::<String, _>("requested_scope_text"))
        .unwrap_or(ProjectRequestScope::OrganizationRoot),
      parent_unit_id: row.get("parent_unit_id"),
      proposed_name: row.get("proposed_name"),
      proposed_type_id: row.get("proposed_type_id"),
      proposed_members: row.get("proposed_members"),
      proposed_workspace: row.get("proposed_workspace"),
      status: ProjectRequestStatus::parse_or_pending(&row.get::<String, _>("status_text")),
      decided_by: row.get("decided_by"),
      decided_at: row.get("decided_at"),
      metadata: row.get("metadata"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }
}

#[async_trait]
impl OrganizationProjectRequestRepository for PgOrganizationProjectRequestRepository {
  #[instrument(skip(self), err)]
  async fn list(
    &self,
    org: OrganizationId,
    status: Option<ProjectRequestStatus>,
  ) -> RepoResult<Vec<OrganizationProjectRequest>> {
    let rows = if let Some(s) = status {
      sqlx::query(
        r#"SELECT id, organization_id, requested_by,
              requested_scope::text AS requested_scope_text,
              parent_unit_id, proposed_name, proposed_type_id,
              proposed_members, proposed_workspace,
              status::text AS status_text,
              decided_by, decided_at, metadata, created_at, updated_at
       FROM organization_project_request
           WHERE organization_id = $1
             AND status = $2::organization_project_request_status
           ORDER BY created_at DESC"#,
      )
      .bind(org)
      .bind(s.as_str())
      .fetch_all(&self.pool)
      .await
    } else {
      sqlx::query(
        r#"SELECT id, organization_id, requested_by,
              requested_scope::text AS requested_scope_text,
              parent_unit_id, proposed_name, proposed_type_id,
              proposed_members, proposed_workspace,
              status::text AS status_text,
              decided_by, decided_at, metadata, created_at, updated_at
       FROM organization_project_request
           WHERE organization_id = $1
           ORDER BY created_at DESC"#,
      )
      .bind(org)
      .fetch_all(&self.pool)
      .await
    }
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn get(&self, id: OrganizationProjectRequestId) -> RepoResult<Option<OrganizationProjectRequest>> {
    let row = sqlx::query(
      "SELECT id, organization_id, requested_by,
              requested_scope::text AS requested_scope_text,
              parent_unit_id, proposed_name, proposed_type_id,
              proposed_members, proposed_workspace,
              status::text AS status_text,
              decided_by, decided_at, metadata, created_at, updated_at
       FROM organization_project_request WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self, request), err)]
  async fn create(&self, request: &OrganizationProjectRequest) -> RepoResult<OrganizationProjectRequest> {
    let row = sqlx::query(
      r#"INSERT INTO organization_project_request
           (id, organization_id, requested_by, requested_scope, parent_unit_id,
            proposed_name, proposed_type_id, proposed_members,
            proposed_workspace, status, decided_by, decided_at, metadata)
         VALUES ($1, $2, $3, $4::organization_project_request_scope, $5,
                 $6, $7, $8, $9,
                 $10::organization_project_request_status, $11, $12, $13)
         RETURNING id, organization_id, requested_by,
                   requested_scope::text AS requested_scope_text,
                   parent_unit_id, proposed_name, proposed_type_id,
                   proposed_members, proposed_workspace,
                   status::text AS status_text,
                   decided_by, decided_at, metadata, created_at, updated_at"#,
    )
    .bind(request.id)
    .bind(request.organization_id)
    .bind(request.requested_by)
    .bind(request.requested_scope.as_str())
    .bind(request.parent_unit_id)
    .bind(&request.proposed_name)
    .bind(request.proposed_type_id)
    .bind(&request.proposed_members)
    .bind(request.proposed_workspace)
    .bind(request.status.as_str())
    .bind(request.decided_by)
    .bind(request.decided_at)
    .bind(&request.metadata)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_row(row))
  }

  #[instrument(skip(self), err)]
  async fn decide(
    &self,
    id: OrganizationProjectRequestId,
    new_status: ProjectRequestStatus,
    decider: UserId,
  ) -> RepoResult<()> {
    // Only `pending` rows may transition; the WHERE clause enforces that.
    let now = Utc::now();
    let result = sqlx::query(
      r#"UPDATE organization_project_request
         SET status = $2::organization_project_request_status,
             decided_by = $3,
             decided_at = $4,
             updated_at = $4
         WHERE id = $1 AND status = 'pending'"#,
    )
    .bind(id)
    .bind(new_status.as_str())
    .bind(decider)
    .bind(now)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      return Err(RepositoryError::Conflict(
        "organization_project_request not in pending state",
      ));
    }
    Ok(())
  }
}
