//! HTTP error types and response formatting for the API.
//!
//! Defines [`ApiError`] with variants for common HTTP error categories (400,
//! 401, 403, 404, 409, 429, 500) and [`ErrorEnvelope`], the canonical JSON
//! error body the server returns to clients. [`ApiError`] implements
//! [`IntoResponse`] so it can be returned directly from Axum handlers.

use axum::{
  Json,
  http::StatusCode,
  response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::request_id::RequestId;

/// The canonical JSON error body returned to API clients.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEnvelope {
  /// HTTP status code as an integer.
  pub status: u16,
  /// Short human-readable status phrase (e.g. `"BAD REQUEST"`).
  pub code: &'static str,
  /// Machine-readable error type identifier.
  pub type_name: &'static str,
  /// Application-level error name (upper-snake-case).
  pub name: String,
  /// Human-readable error description.
  pub message: String,
  /// Optional structured error payload for validation errors, etc.
  pub data: Option<serde_json::Value>,
  /// Correlation ID of the originating request, when available.
  pub request_id: Option<String>,
}

/// HTTP error variants that map to specific status codes.
///
/// All variants implement [`IntoResponse`] so they can be returned directly
/// from Axum handlers.
#[derive(Debug)]
pub enum ApiError {
  /// 400 Bad Request — invalid input from the client.
  BadRequest {
    /// Application-level error code.
    name: String,
    /// Human-readable description.
    message: String,
    /// Optional structured error detail.
    data: Option<serde_json::Value>,
  },
  /// 401 Unauthorized — missing or invalid authentication.
  Unauthorized {
    /// Application-level error code.
    name: String,
    /// Human-readable description.
    message: String,
  },
  /// 403 Forbidden — authenticated but not permitted.
  Forbidden {
    /// Application-level error code.
    name: String,
    /// Human-readable description.
    message: String,
  },
  /// 404 Not Found — the requested resource does not exist.
  NotFound {
    /// Application-level error code.
    name: String,
    /// Human-readable description.
    message: String,
  },
  /// 409 Conflict — a resource changed or already exists at the target location.
  Conflict {
    /// Application-level error code.
    name: String,
    /// Human-readable description.
    message: String,
  },
  /// 503 Service Unavailable.
  ServiceUnavailable(String),
  /// 500 Internal Server Error.
  Internal(String),
}

impl From<myoxus_application::auth::AuthError> for ApiError {
  fn from(err: myoxus_application::auth::AuthError) -> Self {
    match err {
      myoxus_application::auth::AuthError::InvalidEmail => Self::BadRequest {
        name: "INVALID_EMAIL".into(),
        message: "Invalid email".into(),
        data: None,
      },
      myoxus_application::auth::AuthError::WrongSignInCredentials => Self::BadRequest {
        name: "WRONG_SIGN_IN_CREDENTIALS".into(),
        message: "Wrong credentials".into(),
        data: None,
      },
      myoxus_application::auth::AuthError::ActionForbidden => Self::Forbidden {
        name: "ACTION_FORBIDDEN".into(),
        message: "Action forbidden".into(),
      },
      myoxus_application::auth::AuthError::InvalidToken => Self::BadRequest {
        name: "INVALID_TOKEN".into(),
        message: "Invalid token".into(),
        data: None,
      },
      myoxus_application::auth::AuthError::ExpiredToken => Self::BadRequest {
        name: "EXPIRED_TOKEN".into(),
        message: "Expired token".into(),
        data: None,
      },
      myoxus_application::auth::AuthError::TokenNotFound => Self::NotFound {
        name: "TOKEN_NOT_FOUND".into(),
        message: "Token not found".into(),
      },
      myoxus_application::auth::AuthError::OauthStateExpired => Self::BadRequest {
        name: "OAUTH_STATE_EXPIRED".into(),
        message: "State expired".into(),
        data: None,
      },
      myoxus_application::auth::AuthError::SignUpForbidden => Self::Forbidden {
        name: "SIGN_UP_FORBIDDEN".into(),
        message: "Sign up forbidden".into(),
      },
      myoxus_application::auth::AuthError::AuthenticationRequired => Self::Unauthorized {
        name: "AUTHENTICATION_REQUIRED".into(),
        message: "Auth required".into(),
      },
      myoxus_application::auth::AuthError::NotFound(msg) => Self::NotFound {
        name: "NOT_FOUND".into(),
        message: msg,
      },
      myoxus_application::auth::AuthError::InvalidInput(msg) => Self::BadRequest {
        name: "INVALID_INPUT".into(),
        message: msg,
        data: None,
      },
      myoxus_application::auth::AuthError::WorkspaceOverviewRevisionConflict { .. } => Self::Conflict {
        name: "WORKSPACE_OVERVIEW_REVISION_CONFLICT".into(),
        message: "workspace overview settings changed".into(),
      },
      myoxus_application::auth::AuthError::WorkspaceNameConflict { suggestion } => Self::BadRequest {
        name: "XWS_WORKSPACE_NAME_CONFLICT".into(),
        message: "workspace name is already reserved".into(),
        data: Some(serde_json::json!({ "suggestion": suggestion })),
      },
      myoxus_application::auth::AuthError::StorageQuotaExceeded { .. } => Self::Forbidden {
        name: "STORAGE_QUOTA_EXCEEDED".into(),
        message: err.to_string(),
      },
      myoxus_application::auth::AuthError::UpdateTooLarge { .. } => Self::BadRequest {
        name: "UPDATE_TOO_LARGE".into(),
        message: err.to_string(),
        data: None,
      },
      myoxus_application::auth::AuthError::InvalidYjsUpdate => Self::BadRequest {
        name: "INVALID_YJS_UPDATE".into(),
        message: err.to_string(),
        data: None,
      },
      myoxus_application::auth::AuthError::YjsValidationUnavailable => {
        Self::Internal("Yjs update validation is temporarily unavailable".into())
      }
      myoxus_application::auth::AuthError::InvalidYjsStateVector => Self::BadRequest {
        name: "INVALID_STATE_VECTOR".into(),
        message: err.to_string(),
        data: None,
      },
      myoxus_application::auth::AuthError::DocSyncPayloadTooLarge { .. } => Self::BadRequest {
        name: "SYNC_PAYLOAD_TOO_LARGE".into(),
        message: err.to_string(),
        data: None,
      },
      myoxus_application::auth::AuthError::DocSyncCancelled
      | myoxus_application::auth::AuthError::YjsDecoderUnavailable => Self::ServiceUnavailable(err.to_string()),
      myoxus_application::auth::AuthError::Storage(msg) => Self::Internal(msg),
    }
  }
}

impl ApiError {
  fn parts(
    &self,
  ) -> (
    StatusCode,
    &'static str,
    &'static str,
    String,
    String,
    Option<serde_json::Value>,
  ) {
    match self {
      Self::BadRequest { name, message, data } => (
        StatusCode::BAD_REQUEST,
        "BAD REQUEST",
        "BAD_REQUEST",
        name.clone(),
        message.clone(),
        data.clone(),
      ),
      Self::Unauthorized { name, message } => (
        StatusCode::UNAUTHORIZED,
        "UNAUTHORIZED",
        "AUTHENTICATION_REQUIRED",
        name.clone(),
        message.clone(),
        None,
      ),
      Self::Forbidden { name, message } => (
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
        "ACTION_FORBIDDEN",
        name.clone(),
        message.clone(),
        None,
      ),
      Self::NotFound { name, message } => (
        StatusCode::NOT_FOUND,
        "NOT FOUND",
        "RESOURCE_NOT_FOUND",
        name.clone(),
        message.clone(),
        None,
      ),
      Self::Conflict { name, message } => (
        StatusCode::CONFLICT,
        "CONFLICT",
        "RESOURCE_ALREADY_EXISTS",
        name.clone(),
        message.clone(),
        None,
      ),
      Self::ServiceUnavailable(message) => (
        StatusCode::SERVICE_UNAVAILABLE,
        "SERVICE UNAVAILABLE",
        "NETWORK_ERROR",
        "SERVICE_UNAVAILABLE".to_string(),
        message.clone(),
        None,
      ),
      Self::Internal(message) => (
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL SERVER ERROR",
        "INTERNAL_SERVER_ERROR",
        "INTERNAL_SERVER_ERROR".to_string(),
        message.clone(),
        None,
      ),
    }
  }
}

impl IntoResponse for ApiError {
  fn into_response(self) -> Response {
    render_error(self, None)
  }
}

/// Render an [`ApiError`] as an Axum [`Response`], optionally attaching a
/// request correlation ID.
pub fn render_error(error: ApiError, request_id: Option<RequestId>) -> Response {
  let (status, code, type_name, name, message, data) = error.parts();
  let envelope = ErrorEnvelope {
    status: status.as_u16(),
    code,
    type_name,
    name: name.to_uppercase(),
    message,
    data,
    request_id: request_id.map(|id| id.0),
  };
  (status, Json(envelope)).into_response()
}
