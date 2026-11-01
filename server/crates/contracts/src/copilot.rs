// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Literal model IDs are object keys, never configuration paths. Absence keeps
/// the provider default; declaring a control promises both explicit states.
pub type CopilotModelOptionsMap = BTreeMap<String, CopilotModelOptions>;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CopilotModelOptions {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reasoning_control: Option<ReasoningControl>,
  /// Explicit operator declaration; never inferred from a model ID.
  #[serde(default, skip_serializing_if = "is_false")]
  pub supports_vision: bool,
}

fn is_false(value: &bool) -> bool {
  !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReasoningControl {
  EnableThinking,
  ReasoningEffort { on: ReasoningEffort, off: ReasoningEffort },
}

/// Only standard wire values; the operator chooses the pair supported by its
/// specific endpoint/model. This is not inferred from names or model weights.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
  None,
  Minimal,
  Low,
  Medium,
  High,
  Xhigh,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningMode {
  Enabled,
  Disabled,
}

impl From<bool> for ReasoningMode {
  fn from(enabled: bool) -> Self {
    if enabled { Self::Enabled } else { Self::Disabled }
  }
}

impl ReasoningControl {
  pub fn validate(&self) -> Result<(), &'static str> {
    if let Self::ReasoningEffort { on, off } = self
      && on == off
    {
      return Err("reasoning_effort requires distinct supported on and off values");
    }
    Ok(())
  }
}

/// Shared by the complete startup snapshot and Admin's candidate write. Do not
/// deserialize a parallel provider model here or include provider secrets in errors.
pub fn validate_model_options(providers: &serde_json::Value) -> Result<(), String> {
  let providers = providers.as_object().ok_or("copilot.providers must be an object")?;
  for provider in providers.values() {
    let Some(options) = provider.get("model_options") else {
      continue;
    };
    let options: CopilotModelOptionsMap = serde_json::from_value(options.clone())
      .map_err(|_| "copilot.providers model_options has an invalid reasoning control or value")?;
    for (model, options) in options {
      if !provider
        .get("models")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|models| models.iter().any(|value| value.as_str() == Some(model.as_str())))
      {
        return Err("copilot.providers model_options keys must match configured literal model IDs".into());
      }
      if let Some(control) = options.reasoning_control {
        control.validate().map_err(str::to_string)?;
      }
    }
  }
  Ok(())
}
