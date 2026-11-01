//! Shared utilities for GraphQL resolver modules.
//!
//! Provides cookie parsing helpers ([`parse_cookies`], [`parse_uuid_cookie`]),
//! the [`map_gql_error`] function that converts [`AuthError`] values into
//! structured async-graphql errors, `x_forwarded_for` header extraction, the
//! shared [`SESSION_COOKIE_NAME`] constant used by multiple resolver files, and
//! [`resolve_doc_id`] — the canonical workspace-scoped SQL resolution for a
//! client-supplied `docId`.
//!
//! Resolvers must never derive an internal UUID from untrusted input. The
//! frontend key may be a UUID, nanoid or system string, but its identity is
//! always `(workspace_id, external_id)`.

use std::collections::HashMap;
use std::sync::Arc;
use tracing::instrument;

use async_graphql::{Context, Error, ErrorExtensions, Result, Value};
use axum::http::HeaderMap;
use myoxus_application::{
  auth::{AuthError, SessionSnapshot},
  doc::DocSpaceKind,
};
use myoxus_domain::document_key::DocumentKey;
use uuid::Uuid;

use crate::state::ApiState;

pub const SESSION_COOKIE_NAME: &str = crate::auth::SESSION_COOKIE_NAME;
pub const LEGACY_SESSION_COOKIE_NAME: &str = crate::auth::LEGACY_SESSION_COOKIE_NAME;

/// Parse the `Cookie` header into a name → value map for use in GraphQL resolvers.
///
/// Only the first occurrence of each cookie name is kept.  Values are not decoded.
pub fn parse_cookies(headers: &HeaderMap) -> HashMap<String, String> {
  let mut cookies = HashMap::new();
  let cookie_header = headers.get(axum::http::header::COOKIE);
  if let Some(value) = cookie_header
    && let Ok(raw) = value.to_str()
  {
    for pair in raw.split(';') {
      let mut parts = pair.trim().splitn(2, '=');
      let Some(key) = parts.next() else {
        continue;
      };
      let Some(value) = parts.next() else {
        continue;
      };
      if !key.is_empty() {
        cookies.entry(key.to_string()).or_insert_with(|| value.to_string());
      }
    }
  }
  cookies
}

/// Look up a cookie by name and parse its value as a UUID.
pub fn parse_uuid_cookie(cookies: &HashMap<String, String>, key: &str) -> Option<Uuid> {
  cookies
    .get(key)
    .or_else(|| {
      if key == SESSION_COOKIE_NAME {
        cookies.get(LEGACY_SESSION_COOKIE_NAME)
      } else {
        None
      }
    })
    .and_then(|value| Uuid::parse_str(value).ok())
}

/// Return whether the parsed cookies contain any accepted session cookie name.
pub fn has_session_cookie(cookies: &HashMap<String, String>) -> bool {
  cookies.contains_key(SESSION_COOKIE_NAME) || cookies.contains_key(LEGACY_SESSION_COOKIE_NAME)
}

/// Extract the first IP address from the `X-Forwarded-For` header.
pub fn x_forwarded_for(headers: &HeaderMap) -> Option<String> {
  headers
    .get("x-forwarded-for")
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.split(',').next())
    .map(str::trim)
    .map(str::to_owned)
    .filter(|value| !value.is_empty())
}

/// Extract authenticated session from GraphQL context.
///
/// Replaces the 6-line boilerplate (parse cookies → parse session_id →
/// get_session_snapshot → unwrap) that was copy-pasted 85 times across resolvers.
///
/// When `auth.requireEmailVerification` is enabled (via admin settings / app_configs),
/// this function additionally checks `user.email_verified_at` and returns an error
/// if the user's email is not verified.  Use [`require_session_allow_unverified`]
/// for resolvers that unverified users must still access (e.g. `sendVerifyEmail`).
#[instrument(skip_all)]
pub async fn require_session(ctx: &Context<'_>) -> Result<(Arc<ApiState>, SessionSnapshot)> {
  let (state, snapshot) = require_session_allow_unverified(ctx).await?;

  // P42-B-02: enforce email verification when the config flag is enabled.
  // Admin users are exempt (typically created via CLI without verification).
  if snapshot.user.email_verified_at.is_none() && !snapshot.user.is_admin {
    let require_verification = state
      .effective_config()
      .await
      .bool("auth.require_email_verification")
      .unwrap_or(state.config_file_baseline.auth.require_email_verification);
    if require_verification {
      let mut err =
        async_graphql::Error::new("Your email address is not verified. Please verify your email to continue.");
      err = err.extend_with(|_, e| {
        e.set("code", "FORBIDDEN");
        e.set("type", "EMAIL_VERIFICATION_REQUIRED");
        e.set("name", "EMAIL_VERIFICATION_REQUIRED");
      });
      return Err(err);
    }
  }

  Ok((state, snapshot))
}

/// Extract authenticated session WITHOUT enforcing email verification.
///
/// Use this for resolvers that unverified users must access:
/// - `sendVerifyEmail` — user needs to request a verification email
/// - `verifyEmail` — user needs to complete verification
/// - `currentUser` — frontend needs the user profile to show verification UI
/// - `signOut` — user should always be able to sign out
#[instrument(skip_all)]
pub async fn require_session_allow_unverified(ctx: &Context<'_>) -> Result<(Arc<ApiState>, SessionSnapshot)> {
  let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
  let headers = ctx.data::<HeaderMap>().map_err(|_| "Internal error")?;
  let cookies = parse_cookies(headers);
  let session_id =
    parse_uuid_cookie(&cookies, SESSION_COOKIE_NAME).ok_or_else(|| map_gql_error(AuthError::AuthenticationRequired))?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(map_gql_error)?
    .ok_or_else(|| map_gql_error(AuthError::AuthenticationRequired))?;
  Ok((state.clone(), snapshot))
}

/// Convert an [`AuthError`] into an async-graphql [`Error`] with NestJS-compatible extension fields.
///
/// Adds `code`, `type`, and `name` extensions so the web client can show
/// localized error messages.  An optional `data` extension is included for
/// errors that carry a detail message (e.g. `NotFound`, `InvalidInput`).
pub fn map_gql_error(err: AuthError) -> Error {
  let mut gql_err = Error::new(err.to_string());

  let (name, type_name, code, data): (&str, &str, &str, Option<serde_json::Value>) = match err {
    AuthError::InvalidEmail => ("INVALID_EMAIL", "BAD_REQUEST", "BAD REQUEST", None),
    AuthError::WrongSignInCredentials => ("WRONG_SIGN_IN_CREDENTIALS", "BAD_REQUEST", "BAD REQUEST", None),
    AuthError::ActionForbidden => ("ACTION_FORBIDDEN", "ACTION_FORBIDDEN", "FORBIDDEN", None),
    AuthError::InvalidToken => ("INVALID_EMAIL_TOKEN", "BAD_REQUEST", "BAD REQUEST", None),
    AuthError::ExpiredToken => ("LINK_EXPIRED", "BAD_REQUEST", "BAD REQUEST", None),
    AuthError::TokenNotFound => ("NOT_FOUND", "RESOURCE_NOT_FOUND", "NOT FOUND", None),
    AuthError::OauthStateExpired => ("OAUTH_STATE_EXPIRED", "BAD_REQUEST", "BAD REQUEST", None),
    AuthError::SignUpForbidden => ("SIGN_UP_FORBIDDEN", "ACTION_FORBIDDEN", "FORBIDDEN", None),
    AuthError::AuthenticationRequired => (
      "AUTHENTICATION_REQUIRED",
      "AUTHENTICATION_REQUIRED",
      "UNAUTHORIZED",
      None,
    ),
    AuthError::NotFound(ref msg) => (
      "NOT_FOUND",
      "RESOURCE_NOT_FOUND",
      "NOT FOUND",
      Some(serde_json::json!({ "message": msg })),
    ),
    AuthError::InvalidInput(ref msg) if msg == "XWS_PREFLIGHT_STALE" => (
      "XWS_PREFLIGHT_STALE",
      "BAD_REQUEST",
      "BAD REQUEST",
      Some(serde_json::json!({ "message": "workspace content preflight is stale" })),
    ),
    AuthError::InvalidInput(ref msg) => (
      "INVALID_INPUT",
      "BAD_REQUEST",
      "BAD REQUEST",
      Some(serde_json::json!({ "message": msg })),
    ),
    AuthError::WorkspaceNameConflict { ref suggestion } => (
      "XWS_WORKSPACE_NAME_CONFLICT",
      "BAD_REQUEST",
      "BAD REQUEST",
      Some(serde_json::json!({ "suggestion": suggestion })),
    ),
    AuthError::WorkspaceOverviewRevisionConflict { current_revision } => (
      "WORKSPACE_OVERVIEW_REVISION_CONFLICT",
      "CONFLICT",
      "CONFLICT",
      Some(serde_json::json!({ "currentRevision": current_revision })),
    ),
    AuthError::StorageQuotaExceeded {
      workspace_id,
      current_bytes,
      write_bytes: _,
      quota_bytes,
    } => (
      "STORAGE_QUOTA_EXCEEDED",
      "STORAGE_QUOTA_EXCEEDED",
      "FORBIDDEN",
      Some(serde_json::json!({
        "workspace_id": workspace_id.to_string(),
        "current_usage": current_bytes,
        "quota_limit": quota_bytes,
      })),
    ),
    AuthError::UpdateTooLarge { .. } => ("UPDATE_TOO_LARGE", "BAD_REQUEST", "BAD REQUEST", None),
    AuthError::InvalidYjsUpdate => ("INVALID_YJS_UPDATE", "BAD_REQUEST", "BAD REQUEST", None),
    AuthError::YjsValidationUnavailable => (
      "INTERNAL_SERVER_ERROR",
      "INTERNAL_SERVER_ERROR",
      "INTERNAL SERVER ERROR",
      None,
    ),
    AuthError::InvalidYjsStateVector => ("INVALID_STATE_VECTOR", "BAD_REQUEST", "BAD REQUEST", None),
    AuthError::DocSyncPayloadTooLarge { .. } => ("SYNC_PAYLOAD_TOO_LARGE", "BAD_REQUEST", "BAD REQUEST", None),
    AuthError::DocSyncCancelled | AuthError::YjsDecoderUnavailable => (
      "SERVICE_UNAVAILABLE",
      "SERVICE_UNAVAILABLE",
      "SERVICE UNAVAILABLE",
      None,
    ),
    AuthError::Storage(_) => (
      "INTERNAL_SERVER_ERROR",
      "INTERNAL_SERVER_ERROR",
      "INTERNAL SERVER ERROR",
      None,
    ),
  };

  gql_err = gql_err.extend_with(|_, e| {
    e.set("code", code);
    e.set("type", type_name);
    e.set("name", name);
    if let Some(d) = data
      && let Ok(val) = Value::from_json(d)
    {
      e.set("data", val);
    }
  });

  gql_err
}

/// Map a direct product-write SQL failure without exposing database diagnostics.
///
/// New resolver code should prefer an application service over this adapter.
pub fn map_gql_write_error(_error: sqlx::Error) -> Error {
  Error::new("internal write failure")
}

/// Resolve a client-visible document key inside exactly one workspace.
pub async fn resolve_doc_id(state: &ApiState, workspace_id: Uuid, doc_id: &str) -> std::result::Result<Uuid, Error> {
  let document_key = DocumentKey::parse(doc_id).map_err(|error| map_gql_error(AuthError::InvalidInput(error)))?;
  state
    .doc()
    .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
    .await
    .map_err(map_gql_error)?
    .ok_or_else(|| map_gql_error(AuthError::NotFound("document".to_string())))
}
