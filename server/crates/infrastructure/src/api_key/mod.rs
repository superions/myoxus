// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed [`ApiKeyStore`] implementation.
//!
//! Uses `sqlx::query` (unverified queries) rather than `sqlx::query!` macros
//! to avoid requiring a live DATABASE_URL at compile time.

use async_trait::async_trait;
use myoxus_application::api_key::{ApiKeyStore, NewApiKey};
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_domain::entities::ApiKey;
use myoxus_domain::ids::{ApiKeyId, UserId};
use sqlx::{PgPool, Row};
use tracing::instrument;
use uuid::Uuid;

/// PostgreSQL-backed implementation of [`ApiKeyStore`].
#[derive(Debug, Clone)]
pub struct SqlxApiKeyStore {
  pool: PgPool,
}

impl SqlxApiKeyStore {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_err(e: sqlx::Error) -> AuthError {
    AuthError::Storage(e.to_string())
  }

  fn row_to_api_key(r: &sqlx::postgres::PgRow) -> ApiKey {
    ApiKey {
      id: r.get::<Uuid, _>("id"),
      user_id: r.get::<Uuid, _>("user_id"),
      name: r.get("name"),
      key_hash: r.get("key_hash"),
      scopes: r.get("scopes"),
      created_at: r.get("created_at"),
      last_used_at: r.get("last_used_at"),
      expires_at: r.get("expires_at"),
    }
  }
}

#[async_trait]
impl ApiKeyStore for SqlxApiKeyStore {
  #[instrument(skip_all)]
  async fn find_active_by_owner(&self, id: ApiKeyId, owner: UserId) -> AuthResult<Option<ApiKey>> {
    let row = sqlx::query("SELECT k.id, k.user_id, k.name, k.key_hash, k.scopes, k.created_at, k.last_used_at, k.expires_at FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.id=$1 AND k.user_id=$2 AND u.status='active' AND (k.expires_at IS NULL OR k.expires_at>now())")
      .bind(id).bind(owner).fetch_optional(&self.pool).await.map_err(Self::map_err)?;
    Ok(row.as_ref().map(Self::row_to_api_key))
  }
  #[instrument(skip(self, input))]
  async fn create(&self, input: NewApiKey) -> AuthResult<ApiKey> {
    let mut transaction = self.pool.begin().await.map_err(Self::map_err)?;
    let active_user =
      sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR SHARE")
        .bind(input.user_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(Self::map_err)?;
    if active_user.is_none() {
      return Err(AuthError::InvalidToken);
    }

    let row = sqlx::query(
      r#"
      INSERT INTO api_keys (user_id, name, key_hash, scopes, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, name, key_hash, scopes, created_at, last_used_at, expires_at
      "#,
    )
    .bind(input.user_id)
    .bind(&input.name)
    .bind(&input.key_hash)
    .bind(&input.scopes)
    .bind(input.expires_at)
    .fetch_one(&mut *transaction)
    .await
    .map_err(Self::map_err)?;

    transaction.commit().await.map_err(Self::map_err)?;

    Ok(Self::row_to_api_key(&row))
  }

  #[instrument(skip(self, hash))]
  async fn find_by_hash(&self, hash: &str) -> AuthResult<Option<ApiKey>> {
    let row = sqlx::query(
      r#"
      SELECT k.id, k.user_id, k.name, k.key_hash, k.scopes, k.created_at, k.last_used_at, k.expires_at
      FROM api_keys k
      JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1
        AND u.status = 'active'
        AND (k.expires_at IS NULL OR k.expires_at > now())
      LIMIT 1
      "#,
    )
    .bind(hash)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_err)?;

    Ok(row.as_ref().map(Self::row_to_api_key))
  }

  #[instrument(skip(self))]
  async fn touch_last_used(&self, id: ApiKeyId) -> AuthResult<()> {
    sqlx::query("UPDATE api_keys SET last_used_at = now() WHERE id = $1")
      .bind(id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_err)?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn delete(&self, id: ApiKeyId) -> AuthResult<()> {
    sqlx::query("DELETE FROM api_keys WHERE id = $1")
      .bind(id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_err)?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn list_by_user(&self, user_id: UserId) -> AuthResult<Vec<ApiKey>> {
    let rows = sqlx::query(
      r#"
      SELECT id, user_id, name, key_hash, scopes, created_at, last_used_at, expires_at
      FROM api_keys
      WHERE user_id = $1
      ORDER BY created_at DESC
      "#,
    )
    .bind(user_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_err)?;

    Ok(rows.iter().map(Self::row_to_api_key).collect())
  }
}
