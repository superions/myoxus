// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed implementation of [`OrganizationRepository`].
//!
//! Single-tenant deployments hold exactly one row (`key='myoxus'`); the
//! repository surface is generic enough to scale to multi-tenant later.

use async_trait::async_trait;
use sqlx::{PgConnection, PgPool, Row};
use tracing::{error, instrument};

use myoxus_domain::entities::Organization;
use myoxus_domain::ids::OrganizationId;
use myoxus_domain::repositories::{OrganizationRepository, RepoResult, RepositoryError};

#[derive(Debug, Clone)]
pub struct PgOrganizationRepository {
  pool: PgPool,
}

impl PgOrganizationRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in organization repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("organization"),
      sqlx::Error::Database(ref dbe) if dbe.code().as_deref() == Some("23505") => {
        RepositoryError::Conflict("organization key/slug already exists")
      }
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> Organization {
    Organization {
      id: row.get("id"),
      key: row.get("key"),
      name: row.get("name"),
      slug: row.get("slug"),
      metadata: row.get("metadata"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
    }
  }

  /// Update organization fields on a caller-owned aggregate transaction.
  pub(crate) async fn update_in_transaction(
    tx: &mut PgConnection,
    id: OrganizationId,
    name: &str,
    slug: &str,
    metadata: &serde_json::Value,
  ) -> RepoResult<Organization> {
    let row = sqlx::query(
      r#"UPDATE organization
         SET name = $2, slug = $3, metadata = $4, updated_at = now()
         WHERE id = $1
         RETURNING id, key, name, slug, metadata, created_at, updated_at"#,
    )
    .bind(id)
    .bind(name)
    .bind(slug)
    .bind(metadata)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Self::map_row(row))
  }
}

#[async_trait]
impl OrganizationRepository for PgOrganizationRepository {
  // Also consumed by workspace-readable template context: no names, keys or
  // provider payloads belong in that read's telemetry.
  #[instrument(skip_all)]
  async fn get_by_key(&self, key: &str) -> RepoResult<Option<Organization>> {
    let row = sqlx::query(
      r#"SELECT id, key, name, slug, metadata, created_at, updated_at
         FROM organization WHERE key = $1"#,
    )
    .bind(key)
    .fetch_optional(&self.pool)
    .await
    .map_err(|_| RepositoryError::Storage("organization lookup failed".into()))?;
    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self), err)]
  async fn get_by_id(&self, id: OrganizationId) -> RepoResult<Option<Organization>> {
    let row = sqlx::query(
      r#"SELECT id, key, name, slug, metadata, created_at, updated_at
         FROM organization WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self, metadata), err)]
  async fn update(
    &self,
    id: OrganizationId,
    name: &str,
    slug: &str,
    metadata: &serde_json::Value,
  ) -> RepoResult<Organization> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let saved = Self::update_in_transaction(&mut tx, id, name, slug, metadata).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(saved)
  }
}
