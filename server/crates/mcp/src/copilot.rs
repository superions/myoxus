// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
//! Copilot's authenticated user adapter for reads registered by the existing MCP owner.

use crate::{
  tool_registry,
  tools::{McpToolState, call_user_read_tool},
};
use async_trait::async_trait;
use myoxus_application::copilot::provider::{LlmToolDefinition, LlmToolExecutor};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub struct CopilotReadTools {
  state: Arc<McpToolState>,
  user_id: Uuid,
  workspace_id: Uuid,
}

impl CopilotReadTools {
  pub fn new(state: Arc<McpToolState>, user_id: Uuid, workspace_id: Uuid) -> Self {
    Self {
      state,
      user_id,
      workspace_id,
    }
  }

  /// Schemas, descriptions and service visibility have one owner in MCP.
  pub fn definitions(&self) -> Vec<LlmToolDefinition> {
    tool_registry::tools()
      .iter()
      .filter(|tool| tool.native_read.is_some() && tool.services_available(self.state.tool_availability()))
      .map(|tool| {
        let mut input_schema = tool.input_schema.clone();
        input_schema["properties"]["workspace_id"]["const"] = json!(self.workspace_id);
        input_schema["properties"]["workspace_id"]["default"] = json!(self.workspace_id);
        LlmToolDefinition {
          name: tool.name.clone(),
          description: Some(tool.description.clone()),
          input_schema,
        }
      })
      .collect()
  }
}

#[async_trait]
impl LlmToolExecutor for CopilotReadTools {
  #[tracing::instrument(skip_all, fields(tool = tool_name, user_id = %self.user_id))]
  async fn execute(&self, tool_name: &str, arguments: &Value) -> Result<Value, String> {
    let mut arguments = arguments
      .as_object()
      .cloned()
      .ok_or("Tool arguments must be an object")?;
    let workspace = json!(self.workspace_id);
    if arguments.get("workspace_id").is_some_and(|target| target != &workspace) {
      return Err("Tool target must match the chat workspace".into());
    }
    arguments.insert("workspace_id".into(), workspace);
    call_user_read_tool(tool_name, &Value::Object(arguments), self.user_id, &self.state)
      .await
      .map_err(|(_, message)| message)
  }
}
