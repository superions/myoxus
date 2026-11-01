// SPDX-License-Identifier: AGPL-3.0-or-later

use chrono::{DateTime, Utc};
use myoxus_contracts::client_update::{
  CLIENT_UPDATE_SCHEMA_VERSION, ClientUpdateCompletion, ClientUpdateCompletionAction, ClientUpdateControlV1,
  ClientUpdatePhase,
};
use thiserror::Error;
use uuid::{Uuid, Version};

const BASELINE_STATE_ID: Uuid = Uuid::from_u128(0x00000000_0000_4000_8000_000000000000);
const BASELINE_UPDATED_AT: &str = "1970-01-01T00:00:00Z";
const MAX_ATTEMPTS: u8 = 100;
const MIN_RETRY_AFTER_MS: u32 = 1_000;
const MAX_RETRY_AFTER_MS: u32 = 300_000;
const MAX_WEB_BUILD_ID_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientUpdateCommand {
  LimitRetry {
    operation_id: Uuid,
    max_attempts: u8,
    retry_after_ms: u32,
  },
  NoRetry {
    operation_id: Uuid,
  },
  UpdateSuccess {
    operation_id: Uuid,
    action: ClientUpdateCompletionAction,
    required_web_build_id: Option<String>,
  },
  UpdateFailed {
    operation_id: Uuid,
  },
  UpdateAbort {
    operation_id: Uuid,
  },
}

impl ClientUpdateCommand {
  pub fn operation_id(&self) -> Uuid {
    match self {
      Self::LimitRetry { operation_id, .. }
      | Self::NoRetry { operation_id }
      | Self::UpdateSuccess { operation_id, .. }
      | Self::UpdateFailed { operation_id }
      | Self::UpdateAbort { operation_id } => *operation_id,
    }
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientUpdateTransition {
  pub state: ClientUpdateControlV1,
  pub changed: bool,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ClientUpdateError {
  #[error("client update control state is invalid: {0}")]
  InvalidState(String),
  #[error("client update command is invalid: {0}")]
  InvalidCommand(String),
  #[error("client update command conflicts with the current operation")]
  Conflict,
  #[error("client update cache epoch is exhausted")]
  CacheEpochExhausted,
}

pub fn baseline_client_update_control() -> ClientUpdateControlV1 {
  ClientUpdateControlV1 {
    schema_version: CLIENT_UPDATE_SCHEMA_VERSION,
    state_id: BASELINE_STATE_ID,
    phase: ClientUpdatePhase::Normal,
    operation_id: None,
    max_attempts: None,
    retry_after_ms: None,
    completion: None,
    required_web_build_id: None,
    cache_epoch: 0,
    updated_at: BASELINE_UPDATED_AT.to_string(),
  }
}

pub fn validate_client_update_control(state: &ClientUpdateControlV1) -> Result<(), ClientUpdateError> {
  if state.schema_version != CLIENT_UPDATE_SCHEMA_VERSION {
    return Err(invalid_state("unsupported schemaVersion"));
  }
  validate_v4_uuid(state.state_id, "stateId").map_err(invalid_state)?;
  DateTime::parse_from_rfc3339(&state.updated_at).map_err(|_| invalid_state("updatedAt must be RFC3339"))?;
  validate_build_id(state.required_web_build_id.as_deref()).map_err(invalid_state)?;

  match state.phase {
    ClientUpdatePhase::Normal => {
      if state.operation_id.is_some() || state.max_attempts.is_some() || state.retry_after_ms.is_some() {
        return Err(invalid_state("normal phase cannot contain active retry fields"));
      }
    }
    ClientUpdatePhase::Limited => {
      let operation_id = state
        .operation_id
        .ok_or_else(|| invalid_state("limited phase requires operationId"))?;
      validate_v4_uuid(operation_id, "operationId").map_err(invalid_state)?;
      if state.max_attempts.is_none() {
        return Err(invalid_state("limited phase requires maxAttempts"));
      }
      if state.max_attempts.is_some_and(|value| value > MAX_ATTEMPTS) {
        return Err(invalid_state("maxAttempts must be between 0 and 100"));
      }
      validate_retry_after(
        state
          .retry_after_ms
          .ok_or_else(|| invalid_state("limited phase requires retryAfterMs"))?,
      )
      .map_err(invalid_state)?;
      if state.completion.is_some() {
        return Err(invalid_state("limited phase cannot contain completion"));
      }
    }
    ClientUpdatePhase::Suspended | ClientUpdatePhase::Failed => {
      let operation_id = state
        .operation_id
        .ok_or_else(|| invalid_state("non-normal phase requires operationId"))?;
      validate_v4_uuid(operation_id, "operationId").map_err(invalid_state)?;
      if state.max_attempts.is_some() || state.retry_after_ms.is_some() || state.completion.is_some() {
        return Err(invalid_state(
          "suspended and failed phases cannot contain retry limits or completion",
        ));
      }
    }
  }

  if let Some(completion) = state.completion.as_ref() {
    if state.phase != ClientUpdatePhase::Normal {
      return Err(invalid_state("completion is only valid in normal phase"));
    }
    validate_v4_uuid(completion.operation_id, "completion.operationId").map_err(invalid_state)?;
  }
  Ok(())
}

pub fn transition_client_update_control(
  current: &ClientUpdateControlV1,
  command: ClientUpdateCommand,
  next_state_id: Uuid,
  now: DateTime<Utc>,
) -> Result<ClientUpdateTransition, ClientUpdateError> {
  validate_client_update_control(current)?;
  validate_command(&command)?;
  validate_v4_uuid(next_state_id, "next stateId").map_err(ClientUpdateError::InvalidCommand)?;

  let mut next = current.clone();
  let changed = match command {
    ClientUpdateCommand::LimitRetry {
      operation_id,
      max_attempts,
      retry_after_ms,
    } => match current.phase {
      ClientUpdatePhase::Normal => {
        if current
          .completion
          .as_ref()
          .is_some_and(|completion| completion.operation_id == operation_id)
        {
          return Err(ClientUpdateError::Conflict);
        }
        next.phase = ClientUpdatePhase::Limited;
        next.operation_id = Some(operation_id);
        next.max_attempts = Some(max_attempts);
        next.retry_after_ms = Some(retry_after_ms);
        next.completion = None;
        true
      }
      ClientUpdatePhase::Limited
        if current.operation_id == Some(operation_id)
          && current.max_attempts == Some(max_attempts)
          && current.retry_after_ms == Some(retry_after_ms) =>
      {
        false
      }
      _ => return Err(ClientUpdateError::Conflict),
    },
    ClientUpdateCommand::NoRetry { operation_id } => match current.phase {
      ClientUpdatePhase::Limited | ClientUpdatePhase::Failed if current.operation_id == Some(operation_id) => {
        next.phase = ClientUpdatePhase::Suspended;
        next.max_attempts = None;
        next.retry_after_ms = None;
        true
      }
      ClientUpdatePhase::Suspended if current.operation_id == Some(operation_id) => false,
      _ => return Err(ClientUpdateError::Conflict),
    },
    ClientUpdateCommand::UpdateSuccess {
      operation_id,
      action,
      required_web_build_id,
    } => match current.phase {
      ClientUpdatePhase::Limited | ClientUpdatePhase::Suspended | ClientUpdatePhase::Failed
        if current.operation_id == Some(operation_id) =>
      {
        next.phase = ClientUpdatePhase::Normal;
        next.operation_id = None;
        next.max_attempts = None;
        next.retry_after_ms = None;
        next.completion = Some(ClientUpdateCompletion { operation_id, action });
        next.required_web_build_id = required_web_build_id;
        if action == ClientUpdateCompletionAction::ResetLocalCache {
          next.cache_epoch = current
            .cache_epoch
            .checked_add(1)
            .ok_or(ClientUpdateError::CacheEpochExhausted)?;
        }
        true
      }
      ClientUpdatePhase::Normal => {
        let identical = current.completion.as_ref().is_some_and(|completion| {
          completion.operation_id == operation_id
            && completion.action == action
            && current.required_web_build_id == required_web_build_id
        });
        if identical {
          false
        } else {
          return Err(ClientUpdateError::Conflict);
        }
      }
      _ => return Err(ClientUpdateError::Conflict),
    },
    ClientUpdateCommand::UpdateFailed { operation_id } => match current.phase {
      ClientUpdatePhase::Limited | ClientUpdatePhase::Suspended if current.operation_id == Some(operation_id) => {
        next.phase = ClientUpdatePhase::Failed;
        next.max_attempts = None;
        next.retry_after_ms = None;
        true
      }
      ClientUpdatePhase::Failed if current.operation_id == Some(operation_id) => false,
      _ => return Err(ClientUpdateError::Conflict),
    },
    ClientUpdateCommand::UpdateAbort { operation_id } => match current.phase {
      ClientUpdatePhase::Limited | ClientUpdatePhase::Suspended | ClientUpdatePhase::Failed
        if current.operation_id == Some(operation_id) =>
      {
        next.phase = ClientUpdatePhase::Normal;
        next.operation_id = None;
        next.max_attempts = None;
        next.retry_after_ms = None;
        // The no-action completion marker makes an immediate retry idempotent
        // without retaining an unbounded command history.
        next.completion = Some(ClientUpdateCompletion {
          operation_id,
          action: ClientUpdateCompletionAction::None,
        });
        true
      }
      ClientUpdatePhase::Normal
        if current.completion.as_ref().is_some_and(|completion| {
          completion.operation_id == operation_id && completion.action == ClientUpdateCompletionAction::None
        }) =>
      {
        false
      }
      _ => return Err(ClientUpdateError::Conflict),
    },
  };

  if changed {
    next.state_id = next_state_id;
    next.updated_at = now.to_rfc3339();
  }
  validate_client_update_control(&next)?;
  Ok(ClientUpdateTransition { state: next, changed })
}

fn validate_command(command: &ClientUpdateCommand) -> Result<(), ClientUpdateError> {
  validate_v4_uuid(command.operation_id(), "operationId").map_err(ClientUpdateError::InvalidCommand)?;
  match command {
    ClientUpdateCommand::LimitRetry {
      max_attempts,
      retry_after_ms,
      ..
    } => {
      if *max_attempts > MAX_ATTEMPTS {
        return Err(ClientUpdateError::InvalidCommand(
          "maxAttempts must be between 0 and 100".to_string(),
        ));
      }
      validate_retry_after(*retry_after_ms).map_err(ClientUpdateError::InvalidCommand)
    }
    ClientUpdateCommand::UpdateSuccess {
      required_web_build_id, ..
    } => validate_build_id(required_web_build_id.as_deref()).map_err(ClientUpdateError::InvalidCommand),
    _ => Ok(()),
  }
}

fn validate_v4_uuid(value: Uuid, field: &str) -> Result<(), String> {
  if value.get_version() != Some(Version::Random) {
    return Err(format!("{field} must be a UUID-v4"));
  }
  Ok(())
}

fn validate_retry_after(value: u32) -> Result<(), String> {
  if !(MIN_RETRY_AFTER_MS..=MAX_RETRY_AFTER_MS).contains(&value) {
    return Err(format!(
      "retryAfterMs must be between {MIN_RETRY_AFTER_MS} and {MAX_RETRY_AFTER_MS}"
    ));
  }
  Ok(())
}

fn validate_build_id(value: Option<&str>) -> Result<(), String> {
  let Some(value) = value else {
    return Ok(());
  };
  if value.is_empty() || value.len() > MAX_WEB_BUILD_ID_BYTES || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
    return Err("requiredWebBuildId must be non-empty printable ASCII without whitespace".to_string());
  }
  Ok(())
}

fn invalid_state(message: impl Into<String>) -> ClientUpdateError {
  ClientUpdateError::InvalidState(message.into())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn operation_id() -> Uuid {
    Uuid::parse_str("c5bcf226-d532-40d4-87a3-7434e9d0d04d").expect("valid UUID")
  }

  fn next_state_id() -> Uuid {
    Uuid::parse_str("85a8f455-5770-44e4-b187-189ea149efb8").expect("valid UUID")
  }

  fn now() -> DateTime<Utc> {
    "2026-07-26T21:30:00Z".parse().expect("valid timestamp")
  }

  fn limited() -> ClientUpdateControlV1 {
    transition_client_update_control(
      &baseline_client_update_control(),
      ClientUpdateCommand::LimitRetry {
        operation_id: operation_id(),
        max_attempts: 3,
        retry_after_ms: 5_000,
      },
      next_state_id(),
      now(),
    )
    .expect("enter limited phase")
    .state
  }

  #[test]
  fn retry_limit_is_idempotent_but_conflicting_values_are_rejected() {
    let current = limited();

    let repeated = transition_client_update_control(
      &current,
      ClientUpdateCommand::LimitRetry {
        operation_id: operation_id(),
        max_attempts: 3,
        retry_after_ms: 5_000,
      },
      Uuid::new_v4(),
      Utc::now(),
    )
    .expect("identical retry");
    let conflict = transition_client_update_control(
      &current,
      ClientUpdateCommand::LimitRetry {
        operation_id: operation_id(),
        max_attempts: 4,
        retry_after_ms: 5_000,
      },
      Uuid::new_v4(),
      Utc::now(),
    );

    assert!(!repeated.changed);
    assert_eq!(repeated.state.state_id, current.state_id);
    assert_eq!(conflict, Err(ClientUpdateError::Conflict));
  }

  #[test]
  fn cache_reset_increments_epoch_exactly_once() {
    let current = limited();
    let command = ClientUpdateCommand::UpdateSuccess {
      operation_id: operation_id(),
      action: ClientUpdateCompletionAction::ResetLocalCache,
      required_web_build_id: Some("0.38.0-deadbeef".to_string()),
    };
    let completed =
      transition_client_update_control(&current, command.clone(), Uuid::new_v4(), Utc::now()).expect("complete");
    let repeated = transition_client_update_control(&completed.state, command, Uuid::new_v4(), Utc::now())
      .expect("repeat completion");

    assert_eq!(completed.state.cache_epoch, 1);
    assert!(!repeated.changed);
    assert_eq!(repeated.state.cache_epoch, 1);
    assert_eq!(repeated.state.state_id, completed.state.state_id);
  }

  #[test]
  fn stale_operation_cannot_complete_a_new_operation() {
    let first = limited();
    let aborted = transition_client_update_control(
      &first,
      ClientUpdateCommand::UpdateAbort {
        operation_id: operation_id(),
      },
      Uuid::new_v4(),
      Utc::now(),
    )
    .expect("abort");
    let second_operation = Uuid::new_v4();
    let second = transition_client_update_control(
      &aborted.state,
      ClientUpdateCommand::LimitRetry {
        operation_id: second_operation,
        max_attempts: 1,
        retry_after_ms: 1_000,
      },
      Uuid::new_v4(),
      Utc::now(),
    )
    .expect("start second operation");

    let stale = transition_client_update_control(
      &second.state,
      ClientUpdateCommand::UpdateSuccess {
        operation_id: operation_id(),
        action: ClientUpdateCompletionAction::Reload,
        required_web_build_id: None,
      },
      Uuid::new_v4(),
      Utc::now(),
    );

    assert_eq!(stale, Err(ClientUpdateError::Conflict));
  }

  #[test]
  fn corrupt_cross_field_state_fails_closed() {
    let mut corrupt = baseline_client_update_control();
    corrupt.phase = ClientUpdatePhase::Suspended;

    assert!(matches!(
      validate_client_update_control(&corrupt),
      Err(ClientUpdateError::InvalidState(_))
    ));
  }
}
