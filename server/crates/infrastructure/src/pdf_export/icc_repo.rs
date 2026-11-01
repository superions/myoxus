// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed implementation of [`PdfIccProfileRepository`].
//!
//! Profiles are deduplicated by SHA-256 and by name at the DB level (UNIQUE
//! constraints). Both violations surface as [`RepositoryError::Conflict`].

use crate::audit::PgAuditLogStore;
use async_trait::async_trait;
use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use serde_json::json;
use sqlx::{PgPool, Row};
use tracing::{error, instrument};
use uuid::Uuid;

use myoxus_domain::entities::{PdfIccProfile, PdfIccProfileType};
use myoxus_domain::repositories::{PdfIccProfileRepository, RepoResult, RepositoryError};

/// PostgreSQL-backed implementation of [`PdfIccProfileRepository`].
#[derive(Debug, Clone)]
pub struct PgPdfIccProfileRepository {
  pool: PgPool,
}

impl PgPdfIccProfileRepository {
  /// Construct from an existing connection pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in pdf icc profile repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("pdf_icc_profile"),
      sqlx::Error::Database(ref dbe) if dbe.code().as_deref() == Some("23505") => {
        RepositoryError::Conflict("icc profile with this name or sha256 already exists")
      }
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> RepoResult<PdfIccProfile> {
    let profile_type_str: String = row.get("profile_type");
    Ok(PdfIccProfile {
      id: row.get("id"),
      name: row.get("name"),
      profile_type: PdfIccProfileType::from(profile_type_str.as_str()),
      blob_key: row.get("blob_key"),
      sha256: row.get("sha256"),
      uploaded_by: row.get("uploaded_by"),
      uploaded_at: row.get("uploaded_at"),
    })
  }
}

#[async_trait]
impl PdfIccProfileRepository for PgPdfIccProfileRepository {
  #[instrument(skip(self), err)]
  async fn list(&self) -> RepoResult<Vec<PdfIccProfile>> {
    let rows = sqlx::query(
      r#"
      SELECT id, name, profile_type, blob_key, sha256, uploaded_by, uploaded_at
      FROM pdf_icc_profiles
      ORDER BY name ASC
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    rows.into_iter().map(Self::map_row).collect()
  }

  #[instrument(skip(self), err)]
  async fn get(&self, id: Uuid) -> RepoResult<Option<PdfIccProfile>> {
    let row = sqlx::query(
      r#"
      SELECT id, name, profile_type, blob_key, sha256, uploaded_by, uploaded_at
      FROM pdf_icc_profiles
      WHERE id = $1
      "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(Self::map_row).transpose()
  }

  #[instrument(skip(self, name), err)]
  async fn get_by_name(&self, name: &str) -> RepoResult<Option<PdfIccProfile>> {
    let row = sqlx::query(
      r#"
      SELECT id, name, profile_type, blob_key, sha256, uploaded_by, uploaded_at
      FROM pdf_icc_profiles
      WHERE name = $1
      "#,
    )
    .bind(name)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(Self::map_row).transpose()
  }

  #[instrument(skip_all, fields(sha256), err)]
  async fn create(
    &self,
    name: &str,
    profile_type: PdfIccProfileType,
    blob_key: &str,
    sha256: &str,
    uploaded_by: Option<Uuid>,
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<PdfIccProfile> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query(
      r#"
      INSERT INTO pdf_icc_profiles (name, profile_type, blob_key, sha256, uploaded_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, profile_type, blob_key, sha256, uploaded_by, uploaded_at
      "#,
    )
    .bind(name)
    .bind(profile_type.as_str())
    .bind(blob_key)
    .bind(sha256)
    .bind(uploaded_by)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let row = Self::map_row(row)?;
    if let Some(actor) = audit_actor {
      record_icc_audit(&mut tx, &row, "pdf_icc.upload", actor, false).await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(row)
  }

  #[instrument(skip_all, fields(profile_id = %id), err)]
  async fn delete(&self, id: Uuid, audit_actor: Option<AuditActor>) -> RepoResult<Option<PdfIccProfile>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query("SELECT * FROM pdf_icc_profiles WHERE id=$1 FOR UPDATE")
      .bind(id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .map(Self::map_row)
      .transpose()?;
    let Some(row) = row else { return Ok(None) };
    // Keep the deployed FK policy: global/workspace defaults become NULL.
    sqlx::query("DELETE FROM pdf_icc_profiles WHERE id=$1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if let Some(actor) = audit_actor {
      record_icc_audit(&mut tx, &row, "pdf_icc.delete", actor, true).await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(Some(row))
  }
}

async fn record_icc_audit(
  conn: &mut sqlx::PgConnection,
  row: &PdfIccProfile,
  key: &str,
  actor: AuditActor,
  deleted: bool,
) -> RepoResult<()> {
  let value = json!({"name":row.name,"profileType":row.profile_type.as_str(),"sha256":row.sha256});
  let (old, new) = if deleted {
    (Some(value), None)
  } else {
    (None, Some(value))
  };
  PgAuditLogStore::record_in_tx(
    conn,
    &AuditEvent::mutation(
      key,
      AuditCategory::PdfExportConfig,
      Some(AuditTarget::entity("pdf_icc_profile", row.id, Some(row.name.clone()))),
      actor,
      old,
      new,
    ),
  )
  .await
  .map_err(|err| RepositoryError::Storage(err.to_string()))?;
  Ok(())
}
