//! WebSocket error classification and emission helpers.
//!
//! - `WsErrorCategory` maps auth errors to the three client-visible categories
//!   (`INTERNAL_ERROR` / `PERMANENT_ERROR` / `NOT_FOUND`).
//! - `classify_auth_error` produces a category from `AuthError`.
//! - `emit_sync_error` emits the legacy `"error"` event used by some handlers.
//!
//! Extracted from `mod.rs` in P107-C.

use serde_json::json;
use socketioxide::extract::SocketRef;

/// Decode the Socket.IO Base64 transport representation without exposing
/// decoder details or using a transport-specific error name.
pub(super) fn decode_external_update(encoded: &str) -> Result<Vec<u8>, myoxus_application::auth::AuthError> {
  use base64::{Engine as _, engine::general_purpose::STANDARD};
  STANDARD
    .decode(encoded)
    .map_err(|_| myoxus_application::auth::AuthError::InvalidYjsUpdate)
}

/// P101-WS-ERR-01: WebSocket error categories for ack responses.
///
/// The client checks `'error' in response` — if there is an `error` key, the
/// operation is treated as failed. The `name` field within the error object
/// determines the client's retry behavior:
///
/// - `INTERNAL_ERROR` — transient failures (DB timeout, connection lost, pool
///   exhaustion). The client may retry the operation after a backoff delay.
/// - `PERMANENT_ERROR` — structural failures (FK violation, invalid data,
///   circuit breaker open). Retrying the same operation will not succeed;
///   the client should stop retrying this specific doc update.
/// - `NOT_FOUND` — the referenced doc or space does not exist. The client
///   should invalidate its local cache for this entity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WsErrorCategory {
  /// Transient failure — client may retry.
  Internal,
  /// Structural failure — retrying won't help.
  Permanent,
  /// Entity not found — client should invalidate cache.
  NotFound,
}

impl WsErrorCategory {
  /// Returns the error name string sent in the ack response `error.name` field.
  pub(super) fn as_error_name(&self) -> &'static str {
    match self {
      WsErrorCategory::Internal => "INTERNAL_ERROR",
      WsErrorCategory::Permanent => "PERMANENT_ERROR",
      WsErrorCategory::NotFound => "NOT_FOUND",
    }
  }

  /// Returns a human-readable label for structured logging.
  pub(super) fn as_log_label(&self) -> &'static str {
    match self {
      WsErrorCategory::Internal => "transient",
      WsErrorCategory::Permanent => "permanent",
      WsErrorCategory::NotFound => "not_found",
    }
  }
}

/// P101-WS-ERR-01: Classify an `AuthError` into a WebSocket error category.
///
/// This mapping determines how the client should react to a failed doc operation:
/// - Storage errors (DB timeout, connection pool, I/O) → `Internal` (retryable)
/// - Quota exceeded → `Permanent` (retrying won't free space)
/// - Not found → `NotFound` (cache invalidation)
/// - Permission/auth errors → `Permanent` (structural)
/// - Invalid input → `Permanent` (bad data)
pub(super) fn classify_auth_error(err: &myoxus_application::auth::AuthError) -> WsErrorCategory {
  use myoxus_application::auth::AuthError;
  match err {
    // Storage errors are typically transient (connection timeouts, pool exhaustion,
    // temporary DB unavailability). The client should retry.
    AuthError::Storage(msg) => {
      // FK violations and constraint errors are permanent — the data is structurally
      // incompatible, and retrying with the same payload will fail again.
      if msg.contains("violates foreign key")
        || msg.contains("violates unique constraint")
        || msg.contains("violates check constraint")
        || msg.contains("duplicate key")
      {
        WsErrorCategory::Permanent
      } else {
        WsErrorCategory::Internal
      }
    }
    // Resource not found — client should invalidate its cache.
    AuthError::NotFound(_) => WsErrorCategory::NotFound,
    // Quota exceeded — a structural limitation, not transient.
    AuthError::StorageQuotaExceeded { .. } => WsErrorCategory::Permanent,
    // External Yjs ingress failures are structural client errors. The handler
    // emits their stable names directly before this fallback is consulted.
    AuthError::UpdateTooLarge { .. } | AuthError::InvalidYjsUpdate => WsErrorCategory::Permanent,
    AuthError::YjsValidationUnavailable | AuthError::YjsDecoderUnavailable | AuthError::DocSyncCancelled => {
      WsErrorCategory::Internal
    }
    AuthError::InvalidYjsStateVector | AuthError::DocSyncPayloadTooLarge { .. } => WsErrorCategory::Permanent,
    // Permission, auth, and input errors are permanent.
    AuthError::ActionForbidden
    | AuthError::AuthenticationRequired
    | AuthError::InvalidInput(_)
    | AuthError::WorkspaceNameConflict { .. }
    | AuthError::WorkspaceOverviewRevisionConflict { .. }
    | AuthError::InvalidEmail
    | AuthError::InvalidToken
    | AuthError::ExpiredToken
    | AuthError::TokenNotFound
    | AuthError::OauthStateExpired
    | AuthError::SignUpForbidden
    | AuthError::WrongSignInCredentials => WsErrorCategory::Permanent,
    // Default: treat unknown error variants as transient to err on the side of retry.
    #[allow(unreachable_patterns)]
    _ => WsErrorCategory::Internal,
  }
}

/// Return the stable client-visible error for a permanent external Yjs
/// ingress rejection. These errors bypass the generic circuit-breaker mapper
/// because retrying malformed input must not rewrite the contract.
pub(super) fn stable_external_ingress_error(
  err: &myoxus_application::auth::AuthError,
) -> Option<(&'static str, &'static str)> {
  use myoxus_application::auth::AuthError;
  match err {
    AuthError::UpdateTooLarge { .. } => Some(("UPDATE_TOO_LARGE", "update exceeds the configured size limit")),
    AuthError::InvalidYjsUpdate => Some(("INVALID_YJS_UPDATE", "invalid Yjs update")),
    _ => None,
  }
}

/// Stable acknowledged errors for `space:load-doc` protocol failures.
pub(super) fn stable_doc_load_error(
  err: &myoxus_application::auth::AuthError,
) -> Option<(&'static str, &'static str, bool)> {
  use myoxus_application::auth::AuthError;
  match err {
    AuthError::InvalidYjsStateVector => Some(("INVALID_STATE_VECTOR", "invalid Yjs state vector", false)),
    AuthError::DocSyncPayloadTooLarge { .. } => Some((
      "SYNC_PAYLOAD_TOO_LARGE",
      "document sync payload exceeds the configured size limit",
      true,
    )),
    AuthError::DocSyncCancelled => Some(("SYNC_CANCELLED", "document sync load was cancelled", true)),
    AuthError::YjsDecoderUnavailable => Some(("SYNC_BUSY", "document sync decoder is busy", true)),
    _ => None,
  }
}

/// Emit a legacy `"error"` event (non-ack channel) to the connected socket.
///
/// Used by handlers that pre-date the ack-based error contract for signalling
/// access/auth errors without failing the originating event's ack.
pub(super) fn emit_sync_error(socket: &SocketRef, code: &str, message: &str, space_id: Option<&str>) {
  let _ = socket.emit(
    "error",
    &json!({
        "code": code,
        "message": message,
        "spaceId": space_id
    }),
  );
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_application::auth::AuthError;

  #[test]
  fn stable_external_ingress_errors_are_not_rewritten() {
    assert_eq!(
      stable_external_ingress_error(&AuthError::UpdateTooLarge { max_bytes: 32 }),
      Some(("UPDATE_TOO_LARGE", "update exceeds the configured size limit"))
    );
    assert_eq!(
      stable_external_ingress_error(&AuthError::InvalidYjsUpdate),
      Some(("INVALID_YJS_UPDATE", "invalid Yjs update"))
    );
    assert_eq!(
      stable_external_ingress_error(&AuthError::YjsValidationUnavailable),
      None
    );
    assert_eq!(
      classify_auth_error(&AuthError::YjsValidationUnavailable),
      WsErrorCategory::Internal
    );
    assert_eq!(
      stable_doc_load_error(&AuthError::InvalidYjsStateVector),
      Some(("INVALID_STATE_VECTOR", "invalid Yjs state vector", false))
    );
  }

  #[test]
  fn websocket_maps_base64_and_yjs_errors_without_payload() {
    assert!(matches!(
      decode_external_update("not-base64"),
      Err(AuthError::InvalidYjsUpdate)
    ));
    assert_eq!(
      stable_external_ingress_error(&AuthError::InvalidYjsUpdate).map(|(name, _)| name),
      Some("INVALID_YJS_UPDATE")
    );
    assert_eq!(
      stable_external_ingress_error(&AuthError::UpdateTooLarge { max_bytes: 1 }).map(|(name, _)| name),
      Some("UPDATE_TOO_LARGE")
    );
  }
}
