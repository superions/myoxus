// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL implementation of the organization-manager capability port.
//!
//! Manual memberships and imports call the transaction-aware synchronizer;
//! OIDC retains its existing standalone hooks. All use the same per-user lock
//! and `user_features` transition for the implicit global Manager capability.

use async_trait::async_trait;
use myoxus_application::organization::ManagerCapabilityWriter;
use myoxus_application::organization::permission::UserFeatureLookup;
use myoxus_domain::ids::UserId;
use myoxus_domain::repositories::RepositoryError;
use sqlx::{PgConnection, PgPool, Row};

const MANAGER_FEATURE_NAME: &str = "manager";
const IMPLICIT_MANAGER_REASON: &str = "admin panel";

#[derive(Debug, Clone)]
pub struct PgManagerCapabilityWriter {
  pool: PgPool,
}

/// PostgreSQL reader for global organization capability flags.
#[derive(Debug, Clone)]
pub struct PgUserFeatureLookup {
  pool: PgPool,
}

impl PgUserFeatureLookup {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }
}

#[async_trait]
impl UserFeatureLookup for PgUserFeatureLookup {
  async fn user_has_manager_feature(&self, user_id: UserId) -> bool {
    match sqlx::query_scalar::<_, bool>("SELECT activated FROM user_features WHERE user_id = $1 AND feature_name = $2")
      .bind(user_id)
      .bind(MANAGER_FEATURE_NAME)
      .fetch_optional(&self.pool)
      .await
    {
      Ok(Some(activated)) => activated,
      Ok(None) => false,
      Err(error) => {
        tracing::warn!(%user_id, %error, "user feature lookup failed closed");
        false
      }
    }
  }
}

impl PgManagerCapabilityWriter {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  /// Shared per-user serialization boundary for manual/OIDC/import capability
  /// writes. Call after locking all affected OUs; batches use stable UUID order.
  pub(crate) async fn lock_users(tx: &mut PgConnection, users: &[UserId]) -> Result<Vec<UserId>, sqlx::Error> {
    let rows = sqlx::query("SELECT id,status FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE")
      .bind(users)
      .fetch_all(tx)
      .await?;
    if rows.iter().any(|row| row.get::<String, _>("status") == "deleted") {
      return Err(sqlx::Error::RowNotFound);
    }
    Ok(rows.into_iter().map(|row| row.get("id")).collect())
  }

  /// Synchronize the derived Manager capability on a caller-owned transaction.
  /// Membership and capability writers share this owner so aggregate imports
  /// cannot commit one projection without the other.
  pub(crate) async fn sync_in_transaction(tx: &mut PgConnection, user_id: UserId) -> Result<bool, sqlx::Error> {
    if !Self::lock_users(tx, &[user_id]).await?.contains(&user_id) {
      return Err(sqlx::Error::RowNotFound);
    }
    let should_be_active: bool = sqlx::query_scalar(
      "SELECT EXISTS(
         SELECT 1 FROM organization_unit_member
          WHERE user_id = $1 AND role = 'manager'
       )",
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    let current = sqlx::query_scalar::<_, bool>(
      "SELECT activated FROM user_features
        WHERE user_id = $1 AND feature_name = $2
        FOR UPDATE",
    )
    .bind(user_id)
    .bind(MANAGER_FEATURE_NAME)
    .fetch_optional(&mut *tx)
    .await?;
    if current.unwrap_or(false) == should_be_active {
      return Ok(false);
    }

    sqlx::query(
      r#"
      INSERT INTO user_features (user_id, feature_name, activated, reason)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, feature_name)
      DO UPDATE SET
        activated = EXCLUDED.activated,
        reason = EXCLUDED.reason,
        updated_at = now()
      "#,
    )
    .bind(user_id)
    .bind(MANAGER_FEATURE_NAME)
    .bind(should_be_active)
    .bind(IMPLICIT_MANAGER_REASON)
    .execute(&mut *tx)
    .await?;
    Ok(true)
  }

  fn map_db_err(error: sqlx::Error) -> RepositoryError {
    if matches!(error, sqlx::Error::RowNotFound) || crate::auth::is_terminal_account_error(&error) {
      return RepositoryError::NotFound("user");
    }
    tracing::error!(database_code = ?database_code(&error), "failed to synchronize organization-manager capability");
    RepositoryError::Storage("failed to persist manager capability override".to_string())
  }
}

#[async_trait]
impl ManagerCapabilityWriter for PgManagerCapabilityWriter {
  async fn ensure_manager_capability(&self, user_id: UserId) -> Result<bool, String> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|error| Self::map_db_err(error).to_string())?;
    let transitioned = Self::sync_in_transaction(&mut tx, user_id)
      .await
      .map_err(|error| Self::map_db_err(error).to_string())?;
    tx.commit().await.map_err(|error| Self::map_db_err(error).to_string())?;
    Ok(transitioned)
  }

  async fn revoke_manager_capability_if_no_more(&self, user_id: UserId) -> Result<bool, String> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(|error| Self::map_db_err(error).to_string())?;
    let transitioned = Self::sync_in_transaction(&mut tx, user_id)
      .await
      .map_err(|error| Self::map_db_err(error).to_string())?;
    tx.commit().await.map_err(|error| Self::map_db_err(error).to_string())?;
    Ok(transitioned)
  }
}

fn database_code(error: &sqlx::Error) -> Option<String> {
  match error {
    sqlx::Error::Database(error) => error.code().map(|code| code.into_owned()),
    _ => None,
  }
}
