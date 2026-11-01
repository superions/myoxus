// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typed wire contracts shared by the MCP HTTP router and tool adapter.
//!
//! MCP keeps JSON-RPC failures separate from failures produced by a resolved
//! tool invocation. The latter are successful JSON-RPC responses whose tool
//! result carries `isError: true`, allowing clients to inspect and act on the
//! stable error payload.

pub use rmcp::model::CallToolResult;
use rmcp::model::ContentBlock;
use serde_json::{Value, json};

/// Preserve identical structured and compact JSON text projections.
///
/// Successful Myoxus results omit `isError`, rather than serializing false.
/// Protocol-version-specific result fields belong to the transport owner.
pub fn tool_success(value: Value) -> CallToolResult {
  let mut result = CallToolResult::structured(value);
  result.is_error = None;
  result
}

/// Keep payload-heavy results in structured content with a short text summary.
pub fn tool_success_with_summary(value: Value, summary: impl Into<String>) -> CallToolResult {
  let mut result = tool_success(value);
  result.content = vec![ContentBlock::text(summary)];
  result
}

/// Project stable, caller-safe execution errors into both SDK content channels.
pub fn tool_failure(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> CallToolResult {
  CallToolResult::structured_error(json!({
    "code": code.into(),
    "message": message.into(),
    "retryable": retryable,
  }))
}

/// Error boundary for MCP dispatch.
///
/// Protocol errors are emitted through the JSON-RPC `error` member. Execution
/// errors are emitted as `CallToolResult` values with `isError: true`; this
/// includes argument/domain validation once a known tool has been selected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpToolError {
  Protocol {
    code: i32,
    message: String,
  },
  Execution {
    code: &'static str,
    message: String,
    retryable: bool,
  },
}

impl McpToolError {
  pub fn protocol(code: i32, message: impl Into<String>) -> Self {
    Self::Protocol {
      code,
      message: message.into(),
    }
  }

  /// Convert the established handler error vocabulary at the adapter boundary.
  /// Internal details are deliberately replaced for backend failures.
  pub fn from_handler(code: i32, message: String) -> Self {
    let (stable_code, safe_message, retryable) = match code {
      -32602 if message.starts_with("MIX_MCP_IDEMPOTENCY_WRITER_FENCED") => (
        "RECOVERY_REQUIRED",
        "This admission was recovered by another caller; retry the same tool, key and payload".into(),
        true,
      ),
      -32602 => ("INVALID_ARGUMENT", message, false),
      -32009 if message.starts_with("RESULT_TOO_LARGE") => ("RESULT_TOO_LARGE", message, false),
      -32003 if message.starts_with("CALENDAR_EVENT_READ_ONLY") => ("CALENDAR_EVENT_READ_ONLY", message, false),
      -32003 if message.contains("Scope") => ("SCOPE_DENIED", message, false),
      -32003 => ("PERMISSION_DENIED", message, false),
      -32004 => ("NOT_FOUND", message, false),
      // The PDF adapter constructs only a stable class and bounded omission
      // counts for this code; it never forwards a compiler/backend detail.
      -32012 => ("PDF_EXPORT_FAILED", message, false),
      -32009 if message.starts_with("MIX_MCP_FOLDER_PATH_AMBIGUOUS") => ("FOLDER_PATH_AMBIGUOUS", message, false),
      -32009 if message.starts_with("MIX_MCP_FOLDER_ENTRY_DUPLICATE") => ("FOLDER_ENTRY_DUPLICATE", message, false),
      -32009 | -32010 if message.starts_with("MIX_MCP_FOLDER_TREE_REVISION_CONFLICT") => ("CONFLICT", message, true),
      -32010 if message.starts_with("MIX_MCP_IDEMPOTENCY_IN_PROGRESS") => ("CONFLICT", message, true),
      -32002
        if message.starts_with("MIX_MCP_DOCUMENT_IMPORT_RECOVERY_REQUIRED")
          || message.starts_with("MIX_MCP_DOCUMENT_IMPORT_COMPENSATED")
          || message.starts_with("MIX_MCP_DOCUMENT_IMPORT_COMPENSATION_FAILED") =>
      {
        ("RECOVERY_REQUIRED", message, false)
      }
      // Write owners construct these diagnostics from safe IDs and static stages.
      // A durable partial or uncertain write must never advertise retry.
      -32002 if message.starts_with("MIX_MCP_USER_CREATE_PARTIAL:")
        || message.starts_with("MIX_MCP_WORKSPACE_CREATE_PARTIAL:")
        || message.starts_with("MIX_MCP_WORKSPACE_LIFECYCLE_UNCERTAIN:") =>
        ("RECOVERY_REQUIRED", message, false),
      -32002 if message.starts_with("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN") => (
        "RECOVERY_REQUIRED",
        "Inspect the original resource through its owning tools before repairing it; uncertain effects must not be repeated with a new key".into(),
        false,
      ),
      -32002 if message.starts_with("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED") => (
        "RECOVERY_REQUIRED",
        "Retry the same tool, key and payload to recover the committed outcome; do not submit a new key".into(),
        true,
      ),
      -32009 | -32010 => ("CONFLICT", message, false),
      -32002 => {
        let safe_message = if message.contains("not enabled") || message.contains("not configured") {
          message
        } else {
          "The required service could not complete the operation".to_string()
        };
        ("SERVICE_UNAVAILABLE", safe_message, true)
      }
      _ => (
        "INTERNAL_ERROR",
        "The tool could not complete because of an internal server error".to_string(),
        true,
      ),
    };
    Self::Execution {
      code: stable_code,
      message: safe_message,
      retryable,
    }
  }

  pub fn into_tool_result(self) -> Result<CallToolResult, Self> {
    match self {
      Self::Execution {
        code,
        message,
        retryable,
      } => Ok(tool_failure(code, message, retryable)),
      protocol @ Self::Protocol { .. } => Err(protocol),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn success_keeps_text_and_structured_content_semantically_equal() {
    let value = json!({"items": [1, 2], "nextCursor": null});
    let result = tool_success(value.clone());
    let text = &result.content[0].as_text().expect("text projection").text;

    assert_eq!(result.structured_content, Some(value.clone()));
    assert_eq!(serde_json::from_str::<Value>(text).unwrap(), value);
    assert_eq!(result.is_error, None);
  }

  #[test]
  fn compact_success_keeps_the_authoritative_payload_out_of_text() {
    let value = json!({"folders": [{"id": "folder-1"}]});
    let result = tool_success_with_summary(value.clone(), "1 folder");

    assert_eq!(result.structured_content, Some(value));
    assert_eq!(result.content, vec![ContentBlock::text("1 folder")]);
    assert_eq!(result.is_error, None);
  }

  #[test]
  fn folder_tree_revision_conflict_is_retryable() {
    let result = McpToolError::from_handler(
      -32010,
      "MIX_MCP_FOLDER_TREE_REVISION_CONFLICT: organizer changed while building folder tree".into(),
    )
    .into_tool_result()
    .expect("known-tool conflict must remain a tool result");

    assert_eq!(result.is_error, Some(true));
    assert_eq!(result.structured_content.as_ref().unwrap()["code"], "CONFLICT");
    assert_eq!(result.structured_content.as_ref().unwrap()["retryable"], true);
  }

  #[test]
  fn handler_validation_is_a_tool_error_not_a_protocol_error() {
    let result = McpToolError::from_handler(-32602, "workspace_id is required".into())
      .into_tool_result()
      .expect("known-tool validation must remain a tool result");

    assert_eq!(result.is_error, Some(true));
    assert_eq!(result.structured_content.as_ref().unwrap()["code"], "INVALID_ARGUMENT");
    assert_eq!(result.structured_content.as_ref().unwrap()["retryable"], false);
  }
}
