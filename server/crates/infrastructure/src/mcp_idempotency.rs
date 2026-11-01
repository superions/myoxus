// SPDX-License-Identifier: AGPL-3.0-or-later
//! Infrastructure adapters for MCP-owned application capabilities.

use async_trait::async_trait;
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use myoxus_application::{
  auth::{AuthError, AuthResult},
  mcp::{McpIdempotencyAdmission, McpIdempotencyRepository, McpMimePolicyFallback, McpMimePolicyReader},
  mime_policy::MimePolicyConfig,
};

pub struct SqlxMcpIdempotencyRepository {
  pool: PgPool,
}

impl SqlxMcpIdempotencyRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn storage(error: impl std::fmt::Display) -> AuthError {
    AuthError::Storage(error.to_string())
  }
}

#[async_trait]
impl McpIdempotencyRepository for SqlxMcpIdempotencyRepository {
  fn document_transaction_recovery(&self) -> bool {
    true
  }
  async fn begin(
    &self,
    row_id: Uuid,
    api_key_id: Uuid,
    user_id: Uuid,
    tool_name: &str,
    idempotency_key: &str,
    payload_sha256: &str,
    document_payload_format: i16,
  ) -> AuthResult<McpIdempotencyAdmission> {
    let recoverable = myoxus_application::mcp::atomic_document_write_tool(tool_name);
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    // A live transaction may hold this admission row. Bound contention instead
    // of waiting for the writer or incorrectly stealing its admission.
    sqlx::query("SET LOCAL lock_timeout = '100ms'")
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
    let existing: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM mcp_idempotency_keys WHERE api_key_id = $1 AND tool_name = $2 AND idempotency_key = $3)",
    ).bind(api_key_id).bind(tool_name).bind(idempotency_key)
      .fetch_one(&mut *tx).await.map_err(Self::storage)?;
    let inserted = if existing {
      None
    } else {
      sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO mcp_idempotency_keys
         (id, api_key_id, user_id, tool_name, idempotency_key, payload_sha256, recovery_enabled, document_payload_format)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (api_key_id, tool_name, idempotency_key) DO NOTHING
       RETURNING id",
      )
      .bind(row_id)
      .bind(api_key_id)
      .bind(user_id)
      .bind(tool_name)
      .bind(idempotency_key)
      .bind(payload_sha256)
      .bind(recoverable)
      .bind(document_payload_format)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::storage)?
    };
    if inserted.is_some() {
      tx.commit().await.map_err(Self::storage)?;
      return Ok(McpIdempotencyAdmission::Started { row_id });
    }
    // SKIP LOCKED ensures a still-running writer keeps ownership even when its
    // admission lease elapsed. The primary key itself is the fencing token.
    let recovered = sqlx::query_scalar::<_, Uuid>(
      "UPDATE mcp_idempotency_keys SET id = $4, lease_until = now() + interval '60 seconds'
       WHERE id IN (SELECT id FROM mcp_idempotency_keys
         WHERE api_key_id = $1 AND tool_name = $2 AND idempotency_key = $3
           AND user_id = $5 AND payload_sha256 = $6 AND recovery_enabled
           AND response_json IS NULL AND NOT mutation_committed AND lease_until < now()
         FOR UPDATE SKIP LOCKED)
       RETURNING id",
    )
    .bind(api_key_id)
    .bind(tool_name)
    .bind(idempotency_key)
    .bind(row_id)
    .bind(user_id)
    .bind(payload_sha256)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?;
    if recovered.is_some() {
      tx.commit().await.map_err(Self::storage)?;
      return Ok(McpIdempotencyAdmission::Started { row_id });
    }
    let (payload_sha256, document_payload_format, response) = sqlx::query_as::<_, (String, i16, Option<Value>)>(
      "SELECT payload_sha256, document_payload_format, response_json FROM mcp_idempotency_keys
       WHERE api_key_id = $1 AND tool_name = $2 AND idempotency_key = $3",
    )
    .bind(api_key_id)
    .bind(tool_name)
    .bind(idempotency_key)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::storage)?;
    tx.commit().await.map_err(Self::storage)?;
    Ok(McpIdempotencyAdmission::Existing {
      payload_sha256,
      document_payload_format,
      response,
    })
  }

  async fn renew(&self, row_id: Uuid) -> AuthResult<bool> {
    Ok(
      sqlx::query("UPDATE mcp_idempotency_keys SET lease_until = now() + interval '60 seconds' WHERE id = $1")
        .bind(row_id)
        .execute(&self.pool)
        .await
        .map_err(Self::storage)?
        .rows_affected()
        == 1,
    )
  }

  async fn complete(&self, row_id: Uuid, response: &Value) -> AuthResult<bool> {
    Ok(
      sqlx::query(
        "UPDATE mcp_idempotency_keys SET response_json = $2, completed_at = now()
         WHERE id = $1 AND ((NOT recovery_enabled AND response_json IS NULL) OR mutation_committed)",
      )
      .bind(row_id)
      .bind(response)
      .execute(&self.pool)
      .await
      .map_err(Self::storage)?
      .rows_affected()
        == 1,
    )
  }

  async fn abort(&self, row_id: Uuid) -> AuthResult<()> {
    sqlx::query("DELETE FROM mcp_idempotency_keys WHERE id = $1 AND response_json IS NULL AND NOT mutation_committed")
      .bind(row_id)
      .execute(&self.pool)
      .await
      .map_err(Self::storage)?;
    Ok(())
  }
}

/// Hold the admission row until the document transaction finishes. A recovered
/// admission has a different ID, so an abandoned writer fails before mutation.
pub(crate) async fn lock_document_write(
  tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
  actor_id: Option<Uuid>,
) -> AuthResult<()> {
  let Some(replay) = myoxus_application::mcp::current_mcp_document_write() else {
    return Ok(());
  };
  if actor_id != Some(replay.user_id) {
    return Err(AuthError::InvalidInput("MIX_MCP_IDEMPOTENCY_ACTOR_MISMATCH".into()));
  }
  let row = sqlx::query(
    "SELECT user_id, api_key_id, recovery_enabled, mutation_committed FROM mcp_idempotency_keys WHERE id = $1 FOR UPDATE",
  ).bind(replay.row_id).fetch_optional(&mut **tx).await.map_err(SqlxMcpIdempotencyRepository::storage)?;
  let valid = row.is_some_and(|row| {
    row.get::<Uuid, _>("user_id") == replay.user_id
      && row.get::<Uuid, _>("api_key_id") == replay.api_key_id
      && row.get::<bool, _>("recovery_enabled")
      && !row.get::<bool, _>("mutation_committed")
  });
  if !valid {
    return Err(AuthError::InvalidInput("MIX_MCP_IDEMPOTENCY_WRITER_FENCED".into()));
  }
  Ok(())
}

/// Publish the recoverable result atomically with its existing document/history/job owner.
pub(crate) async fn commit_document_write(
  tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
  commit: myoxus_application::mcp::McpDocumentWriteCommit<'_>,
) -> AuthResult<()> {
  let Some(replay) = myoxus_application::mcp::current_mcp_document_write() else {
    return Ok(());
  };
  let response = (replay.response)(commit)?;
  let affected = sqlx::query(
    "UPDATE mcp_idempotency_keys SET response_json = $2, mutation_committed = true, completed_at = now()
     WHERE id = $1 AND recovery_enabled AND NOT mutation_committed",
  )
  .bind(replay.row_id)
  .bind(response)
  .execute(&mut **tx)
  .await
  .map_err(SqlxMcpIdempotencyRepository::storage)?
  .rows_affected();
  if affected != 1 {
    return Err(AuthError::InvalidInput("MIX_MCP_IDEMPOTENCY_WRITER_FENCED".into()));
  }
  Ok(())
}

pub struct SqlxMcpMimePolicyReader {
  pool: PgPool,
}

impl SqlxMcpMimePolicyReader {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }
}

#[async_trait]
impl McpMimePolicyReader for SqlxMcpMimePolicyReader {
  async fn resolve(&self, fallback: &McpMimePolicyFallback) -> AuthResult<MimePolicyConfig> {
    let overrides = crate::app_config::load_validated_app_config_values(&self.pool)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    Ok(crate::mime_policy_config::resolve_mime_policy_config(
      &overrides,
      &crate::mime_policy_config::MimePolicyFallback {
        allowlist: &fallback.allowlist,
        blocklist: &fallback.blocklist,
        validation_mode: &fallback.validation_mode,
      },
    ))
  }
}
