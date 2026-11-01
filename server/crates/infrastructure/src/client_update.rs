// SPDX-License-Identifier: AGPL-3.0-or-later

use chrono::Utc;
use myoxus_application::client_update::{
  ClientUpdateCommand, ClientUpdateError, ClientUpdateTransition, baseline_client_update_control,
  transition_client_update_control, validate_client_update_control,
};
use myoxus_contracts::client_update::{CLIENT_UPDATE_CONFIG_KEY, CLIENT_UPDATE_NOTIFY_CHANNEL, ClientUpdateControlV1};
use sqlx::{PgPool, Row};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone)]
pub struct PgClientUpdateRepository {
  pool: PgPool,
}

#[derive(Debug, Error)]
pub enum ClientUpdateRepositoryError {
  #[error("stored client update control requires operator repair: {0}")]
  CorruptState(String),
  #[error(transparent)]
  Transition(#[from] ClientUpdateError),
  #[error("client update control persistence failed")]
  Persistence(#[source] sqlx::Error),
  #[error("client update control wake-up failed")]
  Wakeup(#[source] sqlx::Error),
}

impl PgClientUpdateRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  /// Reads the current desired state without creating the baseline row.
  #[tracing::instrument(skip_all)]
  pub async fn read(&self) -> Result<ClientUpdateControlV1, ClientUpdateRepositoryError> {
    let value = sqlx::query_scalar::<_, serde_json::Value>("SELECT value FROM app_configs WHERE id = $1")
      .bind(CLIENT_UPDATE_CONFIG_KEY)
      .fetch_optional(&self.pool)
      .await
      .map_err(ClientUpdateRepositoryError::Persistence)?;
    value.map_or_else(|| Ok(baseline_client_update_control()), parse_persisted_control)
  }

  /// Serializes every command through the single `app_configs` row.
  ///
  /// The baseline insert closes PostgreSQL's missing-row lock gap before the
  /// `FOR UPDATE` read. A conflict or corrupt value rolls the transaction back
  /// without modifying the current desired state.
  #[tracing::instrument(skip_all, fields(operation_id = %command.operation_id()))]
  pub async fn apply(
    &self,
    command: ClientUpdateCommand,
  ) -> Result<ClientUpdateTransition, ClientUpdateRepositoryError> {
    let baseline = serde_json::to_value(baseline_client_update_control())
      .map_err(|error| ClientUpdateRepositoryError::CorruptState(error.to_string()))?;
    let mut transaction = self
      .pool
      .begin()
      .await
      .map_err(ClientUpdateRepositoryError::Persistence)?;

    sqlx::query(
      "INSERT INTO app_configs (id, value, created_at, updated_at) \
       VALUES ($1, $2, now(), now()) ON CONFLICT (id) DO NOTHING",
    )
    .bind(CLIENT_UPDATE_CONFIG_KEY)
    .bind(baseline)
    .execute(&mut *transaction)
    .await
    .map_err(ClientUpdateRepositoryError::Persistence)?;

    let row = sqlx::query("SELECT value FROM app_configs WHERE id = $1 FOR UPDATE")
      .bind(CLIENT_UPDATE_CONFIG_KEY)
      .fetch_one(&mut *transaction)
      .await
      .map_err(ClientUpdateRepositoryError::Persistence)?;
    let current = parse_persisted_control(row.try_get("value").map_err(ClientUpdateRepositoryError::Persistence)?)?;
    let transition = transition_client_update_control(&current, command, Uuid::new_v4(), Utc::now())?;

    if transition.changed {
      let value = serde_json::to_value(&transition.state)
        .map_err(|error| ClientUpdateRepositoryError::CorruptState(error.to_string()))?;
      sqlx::query("UPDATE app_configs SET value = $2, updated_at = now() WHERE id = $1")
        .bind(CLIENT_UPDATE_CONFIG_KEY)
        .bind(value)
        .execute(&mut *transaction)
        .await
        .map_err(ClientUpdateRepositoryError::Persistence)?;
    }

    transaction
      .commit()
      .await
      .map_err(ClientUpdateRepositoryError::Persistence)?;
    Ok(transition)
  }

  /// Wakes API nodes after a committed change.
  ///
  /// This deliberately runs after the mutation transaction. A transient
  /// notification failure is observable but cannot undo a safe DB commit.
  #[tracing::instrument(skip_all, fields(state_id = %state_id))]
  pub async fn notify(&self, state_id: Uuid) -> Result<(), ClientUpdateRepositoryError> {
    sqlx::query("SELECT pg_notify($1, $2)")
      .bind(CLIENT_UPDATE_NOTIFY_CHANNEL)
      .bind(state_id.to_string())
      .execute(&self.pool)
      .await
      .map_err(ClientUpdateRepositoryError::Wakeup)?;
    Ok(())
  }
}

fn parse_persisted_control(value: serde_json::Value) -> Result<ClientUpdateControlV1, ClientUpdateRepositoryError> {
  let state: ClientUpdateControlV1 =
    serde_json::from_value(value).map_err(|error| ClientUpdateRepositoryError::CorruptState(error.to_string()))?;
  validate_client_update_control(&state)
    .map_err(|error| ClientUpdateRepositoryError::CorruptState(error.to_string()))?;
  Ok(state)
}
