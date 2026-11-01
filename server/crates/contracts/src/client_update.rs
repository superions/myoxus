// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const CLIENT_UPDATE_CONFIG_KEY: &str = "client.updateControl";
pub const CLIENT_UPDATE_SCHEMA_VERSION: u8 = 1;
pub const CLIENT_UPDATE_NOTIFY_CHANNEL: &str = "myoxus_client_update_control";

/// The single server-owned desired state for Browser Web update handling.
///
/// This value is persisted as JSON in `app_configs`. Strict deserialization is
/// intentional: an unknown or malformed field must fail closed instead of
/// silently projecting a normal operating state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientUpdateControlV1 {
  pub schema_version: u8,
  pub state_id: Uuid,
  pub phase: ClientUpdatePhase,
  pub operation_id: Option<Uuid>,
  pub max_attempts: Option<u8>,
  pub retry_after_ms: Option<u32>,
  pub completion: Option<ClientUpdateCompletion>,
  pub required_web_build_id: Option<String>,
  pub cache_epoch: u32,
  pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientUpdatePhase {
  Normal,
  Limited,
  Suspended,
  Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientUpdateCompletion {
  pub operation_id: Uuid,
  pub action: ClientUpdateCompletionAction,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientUpdateCompletionAction {
  None,
  Reload,
  ResetLocalCache,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn wire_contract_uses_the_declared_camel_case_shape() {
    let state = ClientUpdateControlV1 {
      schema_version: 1,
      state_id: Uuid::parse_str("00000000-0000-4000-8000-000000000000").expect("valid UUID"),
      phase: ClientUpdatePhase::Limited,
      operation_id: Some(Uuid::parse_str("c5bcf226-d532-40d4-87a3-7434e9d0d04d").expect("valid UUID")),
      max_attempts: Some(3),
      retry_after_ms: Some(5_000),
      completion: None,
      required_web_build_id: None,
      cache_epoch: 0,
      updated_at: "2026-07-26T21:30:00Z".to_string(),
    };

    let json = serde_json::to_value(&state).expect("serialize update control");

    assert_eq!(json["schemaVersion"], 1);
    assert_eq!(json["phase"], "limited");
    assert_eq!(json["maxAttempts"], 3);
    assert_eq!(json["retryAfterMs"], 5_000);
    assert!(json.get("schema_version").is_none());
  }

  #[test]
  fn unknown_persisted_fields_are_rejected() {
    let error = serde_json::from_value::<ClientUpdateControlV1>(serde_json::json!({
      "schemaVersion": 1,
      "stateId": "00000000-0000-4000-8000-000000000000",
      "phase": "normal",
      "operationId": null,
      "maxAttempts": null,
      "retryAfterMs": null,
      "completion": null,
      "requiredWebBuildId": null,
      "cacheEpoch": 0,
      "updatedAt": "1970-01-01T00:00:00Z",
      "unexpected": true
    }))
    .expect_err("unknown fields must fail closed");

    assert!(error.to_string().contains("unknown field"));
  }
}
