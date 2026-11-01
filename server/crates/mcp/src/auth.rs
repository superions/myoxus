// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP API key authentication middleware.
//!
//! Extracts `Authorization: Bearer myoxus_<key>` from request headers,
//! SHA-256 hashes it, looks up the key in the database, and injects
//! [`McpAuthContext`] into the request extensions.

use axum::{
  extract::Request,
  http::{HeaderMap, StatusCode},
  middleware::Next,
  response::{IntoResponse, Response},
};
use std::sync::Arc;

use myoxus_application::auth::AuthError;
use serde::Serialize;
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use crate::router::McpState;

/// Authentication context injected into request extensions after successful
/// API key validation.
#[derive(Debug, Clone)]
pub struct McpAuthContext {
  /// The resolved user ID that owns this API key.
  pub user_id: Uuid,
  /// Scopes granted by this key (e.g. `["read:workspaces", "read:docs"]`).
  pub scopes: Vec<String>,
  /// The API key ID (for rate limiting and audit logging).
  pub key_id: Uuid,
}

impl McpAuthContext {
  /// Returns `true` if the context has the exact scope.
  ///
  /// MCP API keys are delegated user credentials. The historical `admin`
  /// wildcard is intentionally not honored here; tool authorization must stay
  /// explicit and then pass the normal workspace/document ACL checks.
  pub fn has_scope(&self, scope: &str) -> bool {
    self.scopes.iter().any(|s| s == scope)
  }
}

/// JSON error body matching MCP JSON-RPC 2.0 error format.
#[derive(Debug, Serialize)]
struct McpErrorResponse {
  jsonrpc: &'static str,
  error: McpError,
  id: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct McpError {
  code: i32,
  message: String,
}

fn auth_error_response(code: i32, message: &str) -> Response {
  let body = serde_json::to_string(&McpErrorResponse {
    jsonrpc: "2.0",
    error: McpError {
      code,
      message: message.to_string(),
    },
    id: None,
  })
  .unwrap_or_default();

  (StatusCode::UNAUTHORIZED, [("content-type", "application/json")], body).into_response()
}

/// Extract the raw Bearer token from `Authorization` header.
pub fn extract_bearer(headers: &HeaderMap) -> Option<String> {
  let value = headers.get("authorization")?.to_str().ok()?;
  let token = value.strip_prefix("Bearer ")?;
  if token.is_empty() {
    return None;
  }
  Some(token.to_string())
}

/// Axum middleware that validates the `Authorization: Bearer myoxus_<key>` header.
///
/// Injects [`McpAuthContext`] on success; returns 401 JSON-RPC error on failure.
#[instrument(skip(state, req, next))]
pub async fn mcp_auth_middleware(
  axum::extract::State(state): axum::extract::State<Arc<McpState>>,
  mut req: Request,
  next: Next,
) -> Response {
  // Feature-disabled MCP should look absent before token validation, matching
  // the product contract for all `/mcp` methods and avoiding auth oracle noise.
  if !state.enabled().await {
    state.record_transport_request("disabled", "unknown");
    return axum::response::Response::builder()
      .status(StatusCode::NOT_FOUND)
      .body(axum::body::Body::empty())
      .expect("static: valid response builder with no custom headers");
  }

  let token = match extract_bearer(req.headers()) {
    Some(t) => t,
    None => {
      state.record_auth_denied("missing_token");
      state.record_transport_request("auth_denied", "unknown");
      warn!("MCP request missing Authorization header");
      return auth_error_response(-32001, "Missing or invalid Authorization header");
    }
  };

  if !token.starts_with("myoxus_") {
    state.record_auth_denied("invalid_token");
    state.record_transport_request("auth_denied", "unknown");
    warn!("MCP request has non-myoxus Bearer token prefix");
    return auth_error_response(-32001, "Invalid API key format");
  }

  match state.key_service.authenticate(&token).await {
    Ok(key) => {
      debug!(key_id = %key.id, user_id = %key.user_id, "MCP request authenticated");
      req.extensions_mut().insert(McpAuthContext {
        user_id: key.user_id,
        scopes: key.scopes,
        key_id: key.id,
      });
      next.run(req).await
    }
    Err(e) => {
      state.record_auth_denied(auth_denied_reason(&e));
      state.record_transport_request("auth_denied", "unknown");
      warn!(error = %e, "MCP API key authentication failed");
      auth_error_response(-32001, "Invalid or expired API key")
    }
  }
}

fn auth_denied_reason(error: &AuthError) -> &'static str {
  match error {
    AuthError::ExpiredToken => "expired",
    AuthError::InvalidToken | AuthError::TokenNotFound => "invalid_token",
    _ => "other",
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn admin_scope_is_not_a_mcp_wildcard() {
    let ctx = McpAuthContext {
      user_id: Uuid::new_v4(),
      scopes: vec!["admin".to_string()],
      key_id: Uuid::new_v4(),
    };

    assert!(ctx.has_scope("admin"));
    assert!(
      !ctx.has_scope("write:docs"),
      "MCP API keys must grant delegated capabilities explicitly"
    );
  }
}
