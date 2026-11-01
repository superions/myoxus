//! Core session authentication route handlers and cookie utilities.
//!
//! Implements sign-in (password and magic-link), sign-out, session refresh,
//! and user-info endpoints. Cookie helpers (`append_cookie`, `extract_session`)
//! and CSRF validation are shared across other auth sub-modules. The
//! `SESSION_COOKIE_NAME`, `USER_COOKIE_NAME`, and `CSRF_*` constants define
//! the client-visible cookie/header names expected by the web frontend.

use std::collections::HashMap;

use axum::{
  Json,
  extract::{Path, Query, State},
  http::{
    HeaderMap, HeaderValue,
    header::{CONTENT_LENGTH, CONTENT_TYPE, COOKIE, LAST_MODIFIED, SET_COOKIE, USER_AGENT},
  },
  response::{IntoResponse, Response},
};
use chrono::Utc;
use myoxus_application::auth::{AuthError, AuthSession, AuthUser, SessionContext, SessionGroupLink, SignInResult};
use myoxus_application::metrics::MetricsCategory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use crate::{error::ApiError, state::ApiState};

/// HTTP header carrying the ALTCHA solution payload (`x-captcha-token`).
pub const CAPTCHA_TOKEN_HEADER: &str = "x-captcha-token";

/// Hash a secret-ish string (IP, email) into a stable hex sha256 for use as a
/// rate-limit / replay key. DSGVO: raw IP addresses MUST NOT be persisted —
/// only the hash is used inside Redis (REVIEW-C).
fn sha256_hex(input: &str) -> String {
  hex::encode(Sha256::digest(input.as_bytes()))
}

/// Honeypot trap check — returns `true` when the hidden form field is set,
/// indicating an automated bot filled every field on the page.
///
/// Tracks a metric counter. Does NOT short-circuit — the caller decides
/// whether to reject.
pub(crate) fn honeypot_triggered(state: &ApiState, fields: &HashMap<String, serde_json::Value>) -> bool {
  let name = state.captcha().honeypot_field_name().to_string();
  if name.is_empty() {
    return false;
  }
  let Some(value) = fields.get(&name) else {
    return false;
  };
  let is_blank = match value {
    serde_json::Value::Null => true,
    serde_json::Value::String(s) => s.trim().is_empty(),
    _ => false,
  };
  if is_blank {
    return false;
  }
  state.increment_captcha_honeypot();
  true
}

/// Build an IP hash from a request's `X-Forwarded-For` header, or the
/// literal string `"unknown"` when no IP is available.
fn ip_hash_from_headers(headers: &HeaderMap) -> String {
  sha256_hex(&x_forwarded_for(headers).unwrap_or_else(|| "unknown".to_string()))
}

/// Verify the captcha solution presented by a request, if captcha is enabled.
///
/// Returns `Ok(())` immediately when the feature is disabled. Otherwise reads
/// `x-captcha-token`, computes sha256 hashes of the client IP and optional
/// account identifier, calls [`CaptchaService::verify`], and on failure
/// records an `auth` audit event (`captcha.rejected`) + increments metrics.
///
/// On success increments `captcha_verified_total`.
pub(crate) async fn verify_captcha_for_request(
  state: &ApiState,
  headers: &HeaderMap,
  account: Option<&str>,
) -> Result<(), ApiError> {
  let captcha = state.captcha();
  if !captcha.is_enabled() {
    return Ok(());
  }
  let token = headers
    .get(CAPTCHA_TOKEN_HEADER)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("")
    .to_string();
  if token.is_empty() {
    state.increment_captcha_rejected_with_reason("missing_token");
    record_captcha_audit(state, headers, account, "captcha_missing_token").await;
    return Err(ApiError::BadRequest {
      name: "CAPTCHA_MISSING_TOKEN".into(),
      message: "captcha token missing".into(),
      data: None,
    });
  }
  let ip_hash = ip_hash_from_headers(headers);
  let account_hash = account.map(|a| sha256_hex(&a.to_ascii_lowercase()));

  match captcha.verify(&token, &ip_hash, account_hash.as_deref()).await {
    Ok(()) => {
      state.increment_captcha_verified();
      Ok(())
    }
    Err(err) => {
      let code = err.code().to_string();
      state.increment_captcha_rejected_with_reason(&code);
      record_captcha_audit(state, headers, account, &code).await;
      Err(map_captcha_error(err))
    }
  }
}

/// Emit a `captcha.rejected` audit event in the `Auth` category. Captures
/// only hashed IP + hashed account (never raw) — DSGVO-compliant.
async fn record_captcha_audit(state: &ApiState, headers: &HeaderMap, account: Option<&str>, reason: &str) {
  use myoxus_application::audit::{AuditActor, AuditCategory, AuditEvent};
  let ip_hash = ip_hash_from_headers(headers);
  let account_hash = account.map(|a| sha256_hex(&a.to_ascii_lowercase()));
  let metadata = serde_json::json!({
    "reason": reason,
    "ip_hash": ip_hash,
    "account_hash": account_hash,
    "user_agent": header_to_string(headers, USER_AGENT),
  });
  let event = AuditEvent::mutation(
    "captcha.rejected",
    AuditCategory::Auth,
    None,
    AuditActor::system(),
    None,
    None,
  )
  .with_metadata(metadata);
  state.audit_recorder().record(event).await;
}

// ─── Runtime auth config helpers ──────────────────────────────────────────────

/// Read one live boolean from the shared effective configuration snapshot.
async fn read_auth_bool(state: &ApiState, key: &str, default: bool) -> bool {
  state.effective_config().await.bool(key).unwrap_or(default)
}

/// Check whether new user signups are allowed at runtime.
pub(crate) async fn is_signup_allowed(state: &ApiState) -> bool {
  read_auth_bool(state, "auth.allow_signup", state.config_file_baseline.auth.allow_signup).await
}

/// Check whether new user signups via OAuth are allowed at runtime.
pub(crate) async fn is_signup_for_oauth_allowed(state: &ApiState) -> bool {
  read_auth_bool(
    state,
    "auth.allow_signup_for_oauth",
    state.config_file_baseline.auth.allow_signup_for_oauth,
  )
  .await
}

/// Check whether accounts must have a verified e-mail address before they can
/// receive an authenticated session.
///
/// OAuth/OIDC callbacks use this before creating or linking local accounts so
/// the SSO path cannot bypass the same runtime policy enforced by GraphQL
/// resolvers after password/magic-link sign-in.
pub(crate) async fn is_email_verification_required(state: &ApiState) -> bool {
  read_auth_bool(
    state,
    "auth.require_email_verification",
    state.config_file_baseline.auth.require_email_verification,
  )
  .await
}

/// Validate an email address against domain verification rules.
///
/// Reads `auth.requireEmailDomainVerification`, `auth.allowedEmailDomains`,
/// `auth.rejectPlusAliases`, and `auth.dnsTimeoutSeconds` from `app_configs` DB.
/// `auth.rejectPlusAliases` falls back to `state.config.auth.reject_plus_aliases`
/// so new deployments enforce the server default before an admin override row
/// exists.
/// Returns `Ok(())` if verification is disabled or the domain passes.
/// Returns `Err(reason)` if the domain fails validation.
pub(crate) async fn validate_email_domain_for_signup(state: &ApiState, email: &str) -> Result<(), String> {
  let require_domain_verification = read_auth_bool(
    state,
    "auth.require_email_domain_verification",
    state.config_file_baseline.auth.require_email_domain_verification,
  )
  .await;
  let reject_plus = read_auth_bool(
    state,
    "auth.reject_plus_aliases",
    state.config_file_baseline.auth.reject_plus_aliases,
  )
  .await;

  // Quick plus-alias check (independent of domain verification)
  if reject_plus && email.split('@').next().is_some_and(|local| local.contains('+')) {
    return Err(format!("email aliases with '+' are not allowed: {email}"));
  }

  if !require_domain_verification {
    return Ok(());
  }

  let effective = state.effective_config().await;
  let allowed_domains = effective
    .string_array("auth.allowed_email_domains")
    .unwrap_or_else(|| state.config_file_baseline.auth.allowed_email_domains.clone());
  let dns_timeout = effective
    .value("auth.dns_timeout_seconds")
    .and_then(|value| value.as_u64())
    .unwrap_or(state.config_file_baseline.auth.dns_timeout_seconds);

  myoxus_application::dns::validate_email_for_signup(email, &allowed_domains, dns_timeout).await
}

pub const SESSION_COOKIE_NAME: &str = "affine_session";
pub const LEGACY_SESSION_COOKIE_NAME: &str = "affine_sid";
pub const USER_COOKIE_NAME: &str = "affine_user_id";
pub const CSRF_COOKIE_NAME: &str = "myoxus_csrf_token";
pub const CSRF_HEADER_NAME: &str = "x-myoxus-csrf-token";
// Deletion only: existing Myoxus browsers retire this cookie on session read or
// sign-in. It must never be accepted as a CSRF credential or issued with a value.
const RETIRED_CSRF_COOKIE_NAME: &str = "affine_csrf_token";

/// Request body for `POST /api/auth/preflight`.
#[derive(Debug, Deserialize)]
pub struct PreflightRequest {
  /// E-mail address to check.
  pub email: Option<String>,
}

/// Response body for `/api/auth/preflight`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResponse {
  /// Whether the e-mail address belongs to an existing account.
  pub registered: bool,
  /// Whether the account has a password set (or is OAuth-only).
  pub has_password: bool,
}

/// Request body for `POST /api/auth/sign-in`.
///
/// When `password` is present, performs a direct password sign-in.  When only
/// `email` is supplied, sends a magic-link OTP to the address.
#[derive(Debug, Deserialize)]
pub struct SignInRequest {
  /// Target e-mail address.
  pub email: Option<String>,
  /// Optional plaintext password for credential sign-in.
  pub password: Option<String>,
  /// URL the magic-link will redirect to after authentication.
  #[serde(alias = "callback_url")]
  pub callback_url: Option<String>,
  /// Client-generated nonce used by the desktop app open-app flow.
  #[serde(alias = "client_nonce")]
  pub client_nonce: Option<String>,
  /// P-Captcha-C: unknown / extra fields captured for honeypot inspection.
  /// The configured honeypot key (`captcha.honeypot_field_name`, default
  /// `website`) MUST remain empty — a non-empty value indicates a bot.
  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

/// Response body for magic-link send (no password path).
#[derive(Debug, Serialize)]
pub struct MagicLinkResponse {
  /// E-mail address the magic-link was sent to.
  pub email: String,
}

/// Serialized user information included in session responses.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUserResponse {
  /// User UUID.
  pub id: Uuid,
  /// Primary e-mail address.
  pub email: String,
  /// Optional avatar image URL.
  pub avatar_url: Option<String>,
  /// Display name.
  pub name: Option<String>,
  /// Whether the account is administratively disabled.
  pub disabled: bool,
  /// Whether a password credential is set on the account.
  pub has_password: bool,
  /// Whether the e-mail address has been verified.
  pub email_verified: bool,
}

/// Response body for `GET /api/auth/session`.
#[derive(Debug, Serialize)]
pub struct SessionResponse {
  /// `null` when no active session exists.
  pub user: Option<SessionUserResponse>,
}

/// Response body for `GET /api/auth/sessions`.
#[derive(Debug, Serialize)]
pub struct SessionsResponse {
  /// All users linked in the current session group.
  pub users: Vec<SessionUserResponse>,
}

/// Empty JSON object `{}` returned by sign-out and other side-effect-only endpoints.
#[derive(Debug, Serialize)]
pub struct EmptyObject {}

/// Query parameter for `DELETE /api/auth/session`.
#[derive(Debug, Deserialize)]
pub struct SignOutQuery {
  /// When present, sign out only the session belonging to this user ID.
  pub user_id: Option<String>,
}

/// Request body for `POST /api/auth/magic-link`.
#[derive(Debug, Deserialize)]
pub struct MagicLinkSignInRequest {
  /// E-mail address the OTP was sent to.
  pub email: String,
  /// One-time token from the magic-link URL.
  pub token: String,
  /// Optional nonce for the desktop open-app flow.
  pub client_nonce: Option<String>,
  /// P-Captcha-C: unknown / extra fields captured for honeypot inspection.
  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

/// Request body for `POST /api/auth/open-app/sign-in`.
#[derive(Debug, Deserialize)]
pub struct OpenAppSignInRequest {
  /// Short-lived code issued by `open_app_sign_in_code`.
  pub code: String,
}

/// Response body for `GET /api/auth/open-app/sign-in-code`.
#[derive(Debug, Serialize)]
pub struct OpenAppCodeResponse {
  /// Short-lived one-time code the desktop app passes to `open_app_sign_in`.
  pub code: String,
}

/// Request body for `POST /api/setup/create-admin-user`.
#[derive(Debug, Deserialize)]
pub struct CreateAdminUserRequest {
  /// E-mail address for the first admin account.
  pub email: String,
  /// Display name for the first admin account.
  pub name: String,
  /// Optional password; when absent, the account is created without one.
  pub password: Option<String>,
}

/// `POST /api/setup/create-admin-user` — bootstrap the first admin account.
///
/// Only succeeds when the user table is empty (i.e. the server has never been
/// initialized).  Creates the user, marks it as admin, and optionally sets a
/// password.  Returns `403 Forbidden` when any users already exist.
#[instrument(skip(state, request))]
pub async fn create_admin_user(
  State(state): State<ApiState>,
  Json(request): Json<CreateAdminUserRequest>,
) -> Result<impl IntoResponse, ApiError> {
  // 1. Check if any users exist
  let count = state.admin().count_users(None).await.map_err(ApiError::from)?;

  if count > 0 {
    return Err(ApiError::Forbidden {
      name: "ALREADY_INITIALIZED".into(),
      message: "Server already initialized".into(),
    });
  }

  if let Some(password) = request.password.as_deref() {
    state.auth().validate_password(password).await.map_err(ApiError::from)?;
  }

  // 2. Create the first user
  let user = state
    .auth()
    .store
    .fulfill_user(&request.email, Some(&request.name), None)
    .await
    .map_err(ApiError::from)?;

  // 3. Provision personal workspace (INV-WS-01).
  //    This is the first user on the server; they must have a workspace so
  //    the frontend can navigate them to their home screen immediately.
  state
    .workspace()
    .ensure_personal_workspace(user.id, user.name.as_deref())
    .await
    .map_err(ApiError::from)?;

  // 4. Set as admin
  state
    .admin_users()
    .set_admin(user.id, true, myoxus_domain::audit::AuditActor::system(), "bootstrap")
    .await
    .map_err(ApiError::from)?;

  // 5. If a password is provided, persist it through the same policy and
  // session-revoke boundary used by Admin, self-service and the CLI.
  if let Some(ref password) = request.password {
    state
      .auth()
      .set_user_password(user.id, password)
      .await
      .map_err(ApiError::from)?;
  }

  // The public server config is cached for several minutes. Invalidate both
  // local and peer caches only after every bootstrap write succeeded, so the
  // same browser can observe initialized=true immediately without a reload.
  state.query_cache.server_config.invalidate_all();
  state.query_cache.metrics_server_config.record_invalidation_local();
  state.publish_cache_invalidation("server_config", "all").await;

  tracing::info!(email = %request.email, "first admin user created via setup");

  Ok(Json(SessionUserResponse {
    id: user.id,
    email: user.email,
    avatar_url: user.avatar_url,
    name: user.name,
    disabled: user.disabled,
    has_password: request.password.is_some(),
    email_verified: true, // Auto-verify first admin
  }))
}

/// `POST /api/auth/preflight` — check whether an e-mail is registered and has a password.
///
/// Used by the sign-in page to decide whether to show the password field or the
/// magic-link prompt.
#[instrument(skip(state, request))]
pub async fn preflight(
  State(state): State<ApiState>,
  Json(request): Json<PreflightRequest>,
) -> Result<Json<PreflightResponse>, ApiError> {
  let email = request.email.unwrap_or_default();
  let result = state.auth().preflight(&email).await.map_err(map_auth_error)?;
  Ok(Json(PreflightResponse {
    registered: result.registered,
    has_password: result.has_password,
  }))
}

/// `POST /api/auth/sign-in` — password sign-in or magic-link send.
///
/// When `password` is present in the body, performs a credential sign-in and
/// sets session cookies.  Without a password, sends a magic-link OTP to the
/// given e-mail and returns `{ email }`.
///
/// An existing session cookie (from a previously logged-in browser tab) is
/// linked into the new session's group so that multi-account switching works.
#[instrument(skip(state, headers, request))]
pub async fn sign_in(
  State(state): State<ApiState>,
  headers: HeaderMap,
  Json(request): Json<SignInRequest>,
) -> Result<Response, ApiError> {
  let previous_session_id = parse_uuid_cookie(&parse_cookies(&headers), SESSION_COOKIE_NAME);
  let email = request.email.unwrap_or_default();
  let callback_url = request.callback_url.unwrap_or_else(|| "/magic-link".to_string());
  let client_nonce = request.client_nonce;
  let context = SessionContext {
    user_agent: header_to_string(&headers, USER_AGENT),
    ip_address: x_forwarded_for(&headers),
  };

  // P-Captcha-C: honeypot trap — non-empty decoy field signals a bot.
  if honeypot_triggered(&state, &request.extra) {
    warn!(email = %email, "sign_in: honeypot field set, rejecting");
    return Err(ApiError::BadRequest {
      name: "CAPTCHA_HONEYPOT".into(),
      message: "invalid form submission".into(),
      data: None,
    });
  }

  // P-Captcha-C: captcha verification (no-op when disabled).
  let account = if email.is_empty() { None } else { Some(email.as_str()) };
  verify_captcha_for_request(&state, &headers, account).await?;

  if request.password.is_some() {
    let result = state
      .auth()
      .sign_in(&email, request.password.as_deref(), context)
      .await
      .map_err(|e| {
        state
          .metrics()
          .record(MetricsCategory::Auth, "user_signin_failed", &[("method", "password")]);
        map_auth_error(e)
      })?;

    match result {
      SignInResult::PasswordSignIn { user, session } => {
        // Ensure personal workspace exists (INV-WS-01).
        // Users created before P12-B or via CLI may lack one.
        if let Err(e) = state
          .workspace()
          .ensure_personal_workspace(user.id, user.name.as_deref())
          .await
        {
          tracing::warn!(user_id = %user.id, error = %e, "sign_in: failed to ensure personal workspace");
        }
        link_session_group_after_sign_in(&state, previous_session_id, &session, user.id).await?;
        state
          .metrics()
          .record(MetricsCategory::Auth, "user_signin", &[("method", "password")]);
        Ok(create_session_user_response(&state, user, *session))
      }
      _ => Err(ApiError::Internal("Unexpected sign in result".into())),
    }
  } else {
    let user_exists = state
      .auth()
      .store
      .get_user_by_email(&email)
      .await
      .ok()
      .flatten()
      .is_some();

    // Gate signup: if auth.allowSignup is false and the user doesn't exist,
    // reject the magic-link request rather than creating a new account.
    if !user_exists && !is_signup_allowed(&state).await {
      return Err(ApiError::Forbidden {
        name: "SIGNUP_DISABLED".into(),
        message: "New user signup is disabled".into(),
      });
    }

    // P42-B-01: Domain verification for new signups.
    if !user_exists && let Err(reason) = validate_email_domain_for_signup(&state, &email).await {
      return Err(ApiError::Forbidden {
        name: "EMAIL_DOMAIN_INVALID".into(),
        message: reason,
      });
    }

    state
      .auth()
      .request_magic_link(&email, &callback_url, client_nonce)
      .await
      .map_err(map_auth_error)?;
    state.metrics().record(
      MetricsCategory::Auth,
      "magic_link_requested",
      &[("new_user", if user_exists { "false" } else { "true" })],
    );
    Ok(Json(MagicLinkResponse { email }).into_response())
  }
}

/// `POST /api/auth/magic-link` — consume a magic-link OTP and create a session.
///
/// Validates the e-mail + token combination, creates a new session, links it
/// into any existing session group, and sets the session cookies on the response.
#[instrument(skip(state, headers, req))]
pub async fn magic_link_sign_in(
  State(state): State<ApiState>,
  headers: HeaderMap,
  Json(req): Json<MagicLinkSignInRequest>,
) -> Result<Response, ApiError> {
  let previous_session_id = parse_uuid_cookie(&parse_cookies(&headers), SESSION_COOKIE_NAME);

  // P-Captcha-C: honeypot + captcha verification on magic-link consumption.
  if honeypot_triggered(&state, &req.extra) {
    warn!(email = %req.email, "magic_link_sign_in: honeypot field set, rejecting");
    return Err(ApiError::BadRequest {
      name: "CAPTCHA_HONEYPOT".into(),
      message: "invalid form submission".into(),
      data: None,
    });
  }
  verify_captcha_for_request(&state, &headers, Some(req.email.as_str())).await?;

  let user = state
    .auth()
    .consume_magic_link_otp(&req.email, &req.token, req.client_nonce)
    .await
    .map_err(|e| {
      state
        .metrics()
        .record(MetricsCategory::Auth, "user_signin_failed", &[("method", "magic_link")]);
      map_auth_error(e)
    })?;

  let context = SessionContext {
    user_agent: header_to_string(&headers, USER_AGENT),
    ip_address: x_forwarded_for(&headers),
  };
  let session = state
    .auth()
    .create_user_session(user.id, context)
    .await
    .map_err(map_auth_error)?;
  // Ensure personal workspace exists (INV-WS-01).
  if let Err(e) = state
    .workspace()
    .ensure_personal_workspace(user.id, user.name.as_deref())
    .await
  {
    tracing::warn!(user_id = %user.id, error = %e, "magic_link_sign_in: failed to ensure personal workspace");
  }
  link_session_group_after_sign_in(&state, previous_session_id, &session, user.id).await?;

  // If the user record was created just now (via magic-link first sign-in),
  // `registered` flips from false → true before reaching here; count the
  // signup event on the first consumed magic link.
  state
    .metrics()
    .record(MetricsCategory::Auth, "user_signin", &[("method", "magic_link")]);
  Ok(create_session_user_response(&state, user, session))
}

/// `GET /api/auth/open-app/sign-in-code` — issue a short-lived code for the desktop app.
///
/// The desktop app exchanges this code immediately via `open_app_sign_in`
/// to obtain a session cookie without exposing the full session token.
#[instrument(skip(state, headers))]
pub async fn open_app_sign_in_code(
  State(state): State<ApiState>,
  headers: HeaderMap,
) -> Result<Json<OpenAppCodeResponse>, ApiError> {
  let cookies = parse_cookies(&headers);
  let session_id = parse_uuid_cookie(&cookies, SESSION_COOKIE_NAME).ok_or(ApiError::Unauthorized {
    name: "AUTHENTICATION_REQUIRED".into(),
    message: "Unauthorized".into(),
  })?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(map_auth_error)?
    .ok_or(ApiError::Unauthorized {
      name: "AUTHENTICATION_REQUIRED".into(),
      message: "Unauthorized".into(),
    })?;

  let code = state
    .auth()
    .request_open_app_sign_in_code(snapshot.user.id)
    .await
    .map_err(map_auth_error)?;
  Ok(Json(OpenAppCodeResponse { code }))
}

/// `POST /api/auth/open-app/sign-in` — exchange an open-app code for a session.
///
/// Validates the short-lived code, creates a new authenticated session, and
/// sets session cookies.  The code is consumed and cannot be reused.
#[instrument(skip(state, headers, req))]
pub async fn open_app_sign_in(
  State(state): State<ApiState>,
  headers: HeaderMap,
  Json(req): Json<OpenAppSignInRequest>,
) -> Result<Response, ApiError> {
  let previous_session_id = parse_uuid_cookie(&parse_cookies(&headers), SESSION_COOKIE_NAME);
  let user = state.auth().open_app_sign_in(&req.code).await.map_err(map_auth_error)?;

  let context = SessionContext {
    user_agent: header_to_string(&headers, USER_AGENT),
    ip_address: x_forwarded_for(&headers),
  };
  let session = state
    .auth()
    .create_user_session(user.id, context)
    .await
    .map_err(map_auth_error)?;
  // Ensure personal workspace exists (INV-WS-01).
  if let Err(e) = state
    .workspace()
    .ensure_personal_workspace(user.id, user.name.as_deref())
    .await
  {
    tracing::warn!(user_id = %user.id, error = %e, "open_app_sign_in: failed to ensure personal workspace");
  }
  link_session_group_after_sign_in(&state, previous_session_id, &session, user.id).await?;

  Ok(create_session_user_response(&state, user, session))
}

/// `GET /api/auth/session` — return the currently active session user.
///
/// Reads the session and user-ID cookies.  When the user cookie references a
/// different account from the session cookie, attempts to switch to that user's
/// linked session.  Refreshes the session TTL if needed.  Returns
/// `{ user: null }` when no valid session exists (never returns an error).
#[instrument(skip(state, headers))]
pub async fn current_session(State(state): State<ApiState>, headers: HeaderMap) -> Result<Response, ApiError> {
  let cookies = parse_cookies(&headers);
  let Some(session_id) = parse_uuid_cookie(&cookies, SESSION_COOKIE_NAME) else {
    let ua = headers
      .get(axum::http::header::USER_AGENT)
      .and_then(|v| v.to_str().ok())
      .unwrap_or("-");
    debug!(user_agent = %ua, "current_session requested without session cookie");
    return Ok(Json(SessionResponse { user: None }).into_response());
  };
  let requested_user_id = parse_uuid_cookie(&cookies, USER_COOKIE_NAME);

  let mut snapshot = state
    .auth()
    .refresh_session_if_needed(session_id)
    .await
    .map_err(map_auth_error)?;
  if let (Some(requested_user_id), Some(current_snapshot)) = (requested_user_id, snapshot.clone())
    && requested_user_id != current_snapshot.user.id
    && let Some(target_session_id) = find_session_for_user(&state, session_id, requested_user_id).await?
  {
    snapshot = state
      .auth()
      .refresh_session_if_needed(target_session_id)
      .await
      .map_err(map_auth_error)?;
  }

  match snapshot {
    Some(snapshot) => {
      let user = snapshot.user;
      let session = snapshot.session;
      Ok(create_current_session_response(&state, Some(user), session))
    }
    None => {
      warn!(%session_id, "current_session resolved no active session");
      Ok(Json(SessionResponse { user: None }).into_response())
    }
  }
}

/// `GET /api/auth/sessions` — list all users in the current session group.
///
/// Multi-account sessions are stored as a linked group.  This endpoint returns
/// every user whose session is grouped with the caller's, enabling the account
/// switcher in the web client.  Returns an empty list when unauthenticated.
#[instrument(skip(state, headers))]
pub async fn current_sessions(State(state): State<ApiState>, headers: HeaderMap) -> Result<Response, ApiError> {
  let cookies = parse_cookies(&headers);
  let Some(session_id) = parse_uuid_cookie(&cookies, SESSION_COOKIE_NAME) else {
    debug!("current_sessions requested without session cookie");
    return Ok(Json(SessionsResponse { users: vec![] }).into_response());
  };

  let snapshot = state
    .auth()
    .refresh_session_if_needed(session_id)
    .await
    .map_err(map_auth_error)?;

  match snapshot {
    Some(snapshot) => {
      let session = snapshot.session;
      let mut users = Vec::new();
      let user_ids = list_group_user_ids(&state, session.id).await?;
      if user_ids.is_empty() {
        users.push(SessionUserResponse::from(snapshot.user.clone()));
      } else {
        for user_id in user_ids {
          if let Some(user) = state.auth().get_user_by_id(user_id).await.map_err(map_auth_error)? {
            users.push(SessionUserResponse::from(user));
          }
        }
      }
      let mut response = Json(SessionsResponse { users }).into_response();
      add_session_cookies(response.headers_mut(), &state, snapshot.user.id, &session);
      Ok(response)
    }
    None => Ok(Json(SessionsResponse { users: vec![] }).into_response()),
  }
}

/// `GET /api/auth/challenge` — issue an ALTCHA proof-of-work challenge.
///
/// Returns the JSON-serialised [`altcha_lib_rs::Challenge`] (algorithm, salt,
/// challenge hash, signature, maxnumber) for the client widget. When CAPTCHA
/// is disabled in config, this endpoint responds `503 Service Unavailable`
/// so the client can skip the widget and proceed (P-Captcha-B).
#[instrument(skip(state))]
pub async fn get_challenge(
  State(state): State<ApiState>,
) -> Result<Json<myoxus_application::captcha::Challenge>, ApiError> {
  let captcha = state.captcha();
  match captcha.create_challenge() {
    Ok(challenge) => Ok(Json(challenge)),
    Err(e) => Err(map_captcha_error(e)),
  }
}

/// Convert a [`myoxus_application::captcha::CaptchaError`] into an [`ApiError`].
///
/// [`CaptchaError::Disabled`] maps to 503 so the client can detect "feature
/// off" and skip the widget. Misconfiguration (empty hmac_key while enabled)
/// is a server bug and maps to 500. All verification failures map to 400
/// with a stable `error_code` so the frontend can show a precise message.
pub fn map_captcha_error(err: myoxus_application::captcha::CaptchaError) -> ApiError {
  use myoxus_application::captcha::CaptchaError as CE;
  let code = err.code();
  match err {
    CE::Disabled => ApiError::ServiceUnavailable("captcha is disabled".into()),
    CE::MissingHmacKey => ApiError::Internal("captcha hmac_key is not configured".into()),
    CE::Store(msg) | CE::Internal(msg) => ApiError::Internal(format!("{code}: {msg}")),
    other => ApiError::BadRequest {
      name: code.to_ascii_uppercase(),
      message: other.to_string(),
      data: None,
    },
  }
}

/// `GET /avatars/{id}` — serve a user avatar image from object storage.
///
/// Streams the avatar binary with the stored `Content-Type` and `Last-Modified`
/// headers.  Returns `404 Not Found` when no avatar exists for the given ID.
#[instrument(skip(state))]
pub async fn get_avatar(State(state): State<ApiState>, Path(id): Path<String>) -> Result<impl IntoResponse, ApiError> {
  let blob = state.storage().get_avatar(&id).await.map_err(|e| ApiError::NotFound {
    name: "USER_AVATAR_NOT_FOUND".into(),
    message: format!("Avatar not found: {e}"),
  })?;

  let mut response = blob.data.into_response();
  if let Some(ct) = blob.content_type {
    response.headers_mut().insert(
      CONTENT_TYPE,
      HeaderValue::from_str(&ct).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
  }
  if let Some(lm) = blob.last_modified {
    response.headers_mut().insert(
      LAST_MODIFIED,
      HeaderValue::from_str(&lm.to_rfc2822()).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
  }
  response
    .headers_mut()
    .insert(CONTENT_LENGTH, HeaderValue::from(blob.content_length));

  Ok(response)
}

/// Build a sign-in response that includes the user JSON body and session cookies.
fn create_session_user_response(state: &ApiState, user: AuthUser, session: AuthSession) -> Response {
  let mut response = Json(SessionUserResponse::from(user.clone())).into_response();
  add_session_cookies(response.headers_mut(), state, user.id, &session);
  response
}

/// Build a session response body with cookies for the current-session endpoint.
fn create_current_session_response(state: &ApiState, user: Option<AuthUser>, session: AuthSession) -> Response {
  let user_id = user.as_ref().map(|u| u.id);
  let mut response = Json(SessionResponse {
    user: user.map(SessionUserResponse::from),
  })
  .into_response();
  if let Some(uid) = user_id {
    add_session_cookies(response.headers_mut(), state, uid, &session);
  }
  response
}

/// Append the session cookies and expire the retired CSRF cookie.
///
/// These cookies are set for every successful authentication/session read:
/// - `affine_session` — the session ID (HttpOnly, not accessible to JS)
/// - `affine_sid` — legacy alias for the session ID kept for older clients
/// - `myoxus_csrf_token` — the CSRF token (readable by JS so the client can
///   send it back as `x-myoxus-csrf-token` on mutating requests)
/// - `affine_user_id` — the active user ID (readable by JS for multi-account
///   switching; the `affine_session` cookie's user may differ)
///
/// Cookie security attributes:
/// - `Secure` flag is added when the server's `origin` config uses HTTPS.
///   Omitted for `http://localhost` dev mode so cookies work without TLS.
/// - `SameSite=Lax` — prevents CSRF from cross-origin form submissions while
///   allowing top-level navigations (magic-link redirects).
/// - `HttpOnly` — on `affine_session` and the legacy `affine_sid` alias.
pub(super) fn add_session_cookies(headers: &mut HeaderMap, state: &ApiState, user_id: Uuid, session: &AuthSession) {
  let ttl = state.config.server.session_ttl.max(1);
  // SC-C-04: Add Secure flag when origin uses HTTPS (production).
  // In dev mode (http://localhost), omit Secure so cookies work without TLS.
  let secure_flag = if state.config.server.origin.starts_with("https://") {
    "; Secure"
  } else {
    ""
  };
  append_cookie(
    headers,
    SESSION_COOKIE_NAME,
    &session.id.to_string(),
    &format!("Path=/; HttpOnly; SameSite=Lax; Max-Age={ttl}{secure_flag}"),
  );
  append_cookie(
    headers,
    LEGACY_SESSION_COOKIE_NAME,
    &session.id.to_string(),
    &format!("Path=/; HttpOnly; SameSite=Lax; Max-Age={ttl}{secure_flag}"),
  );
  append_cookie(
    headers,
    CSRF_COOKIE_NAME,
    &session.csrf_token,
    &format!("Path=/; SameSite=Lax; Max-Age={ttl}{secure_flag}"),
  );
  append_cookie(
    headers,
    USER_COOKIE_NAME,
    &user_id.to_string(),
    &format!("Path=/; SameSite=Lax; Max-Age={ttl}{secure_flag}"),
  );
  clear_cookie(headers, RETIRED_CSRF_COOKIE_NAME, false);
}

/// `DELETE /api/auth/session` (legacy path) — sign out with a `Deprecation: true` header.
#[instrument(skip(state, query, headers))]
pub async fn sign_out_deprecated(
  State(state): State<ApiState>,
  Query(query): Query<SignOutQuery>,
  headers: HeaderMap,
) -> Result<Response, ApiError> {
  let target_user_id = query.user_id.and_then(|value| Uuid::parse_str(&value).ok());
  // SC-H-06: Enforce CSRF even on deprecated GET sign-out to prevent
  // cross-site logout attacks. Clients that still use this path must send
  // the x-myoxus-csrf-token header.
  let mut response = sign_out_internal(state, &headers, true, target_user_id).await?;
  response
    .headers_mut()
    .insert("Deprecation", HeaderValue::from_static("true"));
  Ok(response)
}

/// `DELETE /api/auth/session` — sign out the current or a specified linked session.
///
/// With `user_id` query param: terminates only the session for that user and
/// switches the active cookie to the next linked session.  Without `user_id`:
/// terminates all sessions in the group and clears all cookies.
///
/// CSRF validation is enforced; the `x-myoxus-csrf-token` header must match
/// the `myoxus_csrf_token` cookie.
#[instrument(skip(state, query, headers))]
pub async fn sign_out(
  State(state): State<ApiState>,
  Query(query): Query<SignOutQuery>,
  headers: HeaderMap,
) -> Result<Response, ApiError> {
  let target_user_id = query.user_id.and_then(|value| Uuid::parse_str(&value).ok());
  sign_out_internal(state, &headers, true, target_user_id).await
}

#[instrument(skip(state, headers, target_user_id))]
async fn sign_out_internal(
  state: ApiState,
  headers: &HeaderMap,
  enforce_csrf: bool,
  target_user_id: Option<Uuid>,
) -> Result<Response, ApiError> {
  let cookies = parse_cookies(headers);
  let Some(session_id) = parse_uuid_cookie(&cookies, SESSION_COOKIE_NAME) else {
    let mut response = Json(EmptyObject {}).into_response();
    clear_session_cookies(response.headers_mut());
    return Ok(response);
  };

  if enforce_csrf {
    let csrf_cookie = cookies.get(CSRF_COOKIE_NAME);
    let csrf_header = headers
      .get(CSRF_HEADER_NAME)
      .and_then(|header| header.to_str().ok())
      .map(str::to_owned);

    match csrf_header {
      None => {
        tracing::warn!("CSRF header missing on sign-out request");
        return Err(ApiError::Forbidden {
          name: "ACTION_FORBIDDEN".into(),
          message: "action forbidden".into(),
        });
      }
      Some(csrf_header_value) => {
        if csrf_cookie != Some(&csrf_header_value) {
          tracing::warn!("CSRF header/cookie mismatch on sign-out request");
          return Err(ApiError::Forbidden {
            name: "ACTION_FORBIDDEN".into(),
            message: "action forbidden".into(),
          });
        }
      }
    }
  }

  let current_snapshot = state
    .auth()
    .refresh_session_if_needed(session_id)
    .await
    .map_err(map_auth_error)?;

  let mut response = Json(EmptyObject {}).into_response();
  let Some(current_snapshot) = current_snapshot else {
    clear_session_cookies(response.headers_mut());
    return Ok(response);
  };

  match target_user_id {
    Some(target_user_id) => {
      let Some(target_session_id) = find_session_for_user(&state, session_id, target_user_id).await? else {
        return Ok(response);
      };
      state.auth().sign_out(target_session_id).await.map_err(map_auth_error)?;
      unlink_session(&state, target_session_id).await?;

      if target_session_id == session_id {
        if let Some(next_session_id) =
          newest_active_session_in_group(&state, session_id, Some(target_session_id)).await?
          && let Some(next_snapshot) = state
            .auth()
            .refresh_session_if_needed(next_session_id)
            .await
            .map_err(map_auth_error)?
        {
          add_session_cookies(
            response.headers_mut(),
            &state,
            next_snapshot.user.id,
            &next_snapshot.session,
          );
          return Ok(response);
        }
        clear_session_cookies(response.headers_mut());
      } else {
        add_session_cookies(
          response.headers_mut(),
          &state,
          current_snapshot.user.id,
          &current_snapshot.session,
        );
      }
      Ok(response)
    }
    None => {
      let linked = list_group_sessions(&state, session_id).await?;
      if linked.is_empty() {
        state.auth().sign_out(session_id).await.map_err(map_auth_error)?;
        clear_session_cookies(response.headers_mut());
        return Ok(response);
      }
      for linked_session_id in linked {
        state.auth().sign_out(linked_session_id).await.map_err(map_auth_error)?;
        unlink_session(&state, linked_session_id).await?;
      }
      clear_session_cookies(response.headers_mut());
      Ok(response)
    }
  }
}

/// Link the new session into the previous session's group after a successful sign-in.
///
/// If `previous_session_id` is `None` or equals the new session, the new
/// session becomes its own root.  If the previous session is valid, the new
/// session is linked under the same root so that multi-account switching works.
async fn link_session_group_after_sign_in(
  state: &ApiState,
  previous_session_id: Option<Uuid>,
  new_session: &AuthSession,
  new_user_id: Uuid,
) -> Result<(), ApiError> {
  let previous = previous_session_id.and_then(|id| if id == new_session.id { None } else { Some(id) });
  let root = resolve_linked_session_root(state, previous)
    .await?
    .unwrap_or(new_session.id);
  upsert_session_link(state, new_session.id, root, new_user_id).await?;
  Ok(())
}

/// Find the root session of the group for `previous_session_id`.
///
/// Cleans up stale session links as it walks the chain.  Returns `None` when
/// `previous_session_id` is `None` or has already expired.
async fn resolve_linked_session_root(
  state: &ApiState,
  previous_session_id: Option<Uuid>,
) -> Result<Option<Uuid>, ApiError> {
  let Some(previous_session_id) = previous_session_id else {
    return Ok(None);
  };

  let Some(previous_snapshot) = state
    .auth()
    .get_session_snapshot(previous_session_id)
    .await
    .map_err(map_auth_error)?
  else {
    debug!(%previous_session_id, "ignoring stale previous session during sign-in");
    unlink_session(state, previous_session_id).await?;
    return Ok(None);
  };

  let root = match session_group_root(state, previous_session_id).await? {
    Some(root_session_id) if root_session_id != previous_session_id => {
      if state
        .auth()
        .get_session_snapshot(root_session_id)
        .await
        .map_err(map_auth_error)?
        .is_some()
      {
        root_session_id
      } else {
        debug!(
          %previous_session_id,
          %root_session_id,
          "re-rooting session group away from stale root during sign-in"
        );
        previous_session_id
      }
    }
    Some(root_session_id) => root_session_id,
    None => previous_session_id,
  };

  upsert_session_link(state, previous_session_id, root, previous_snapshot.user.id).await?;
  Ok(Some(root))
}

/// Look up the root session ID for a session, or `None` if not linked.
async fn session_group_root(state: &ApiState, session_id: Uuid) -> Result<Option<Uuid>, ApiError> {
  state
    .auth()
    .session_group_root(session_id)
    .await
    .map_err(map_auth_error)
}

/// Insert or update a session → group-root link in the DB or in-memory store.
///
/// FR-10: Handles FK constraint violations gracefully.  When the
/// `root_session_id` references a session that was deleted between the
/// existence check and this INSERT (race with nightly cleanup), the function
/// falls back to making `session_id` its own root instead of propagating
/// the error.  If `session_id` itself is gone the link is simply skipped.
async fn upsert_session_link(
  state: &ApiState,
  session_id: Uuid,
  root_session_id: Uuid,
  user_id: Uuid,
) -> Result<(), ApiError> {
  state
    .auth()
    .upsert_session_group_link(SessionGroupLink {
      session_id,
      root_session_id,
      user_id,
      created_at: Utc::now(),
    })
    .await
    .map_err(map_auth_error)
}

/// Remove a session from its group (called after sign-out of a linked session).
async fn unlink_session(state: &ApiState, session_id: Uuid) -> Result<(), ApiError> {
  state
    .auth()
    .delete_session_group_link(session_id)
    .await
    .map_err(map_auth_error)
}

/// Return all session IDs in the group, ordered by creation time ascending.
///
/// Falls back to `[session_id]` when no links are recorded.
async fn list_group_sessions(state: &ApiState, session_id: Uuid) -> Result<Vec<Uuid>, ApiError> {
  let root = session_group_root(state, session_id).await?.unwrap_or(session_id);
  let sessions = state
    .auth()
    .list_session_group_sessions(root)
    .await
    .map_err(map_auth_error)?;
  if sessions.is_empty() {
    Ok(vec![session_id])
  } else {
    Ok(sessions)
  }
}

/// Return deduplicated user IDs for the session group, ordered by earliest link time.
async fn list_group_user_ids(state: &ApiState, session_id: Uuid) -> Result<Vec<Uuid>, ApiError> {
  let root = session_group_root(state, session_id).await?.unwrap_or(session_id);
  let users = state
    .auth()
    .list_session_group_users(root)
    .await
    .map_err(map_auth_error)?;
  if users.is_empty()
    && let Some(snapshot) = state
      .auth()
      .get_session_snapshot(session_id)
      .await
      .map_err(map_auth_error)?
  {
    return Ok(vec![snapshot.user.id]);
  }
  Ok(users)
}

/// Find the most-recently-linked session in the group that belongs to `user_id`.
async fn find_session_for_user(state: &ApiState, session_id: Uuid, user_id: Uuid) -> Result<Option<Uuid>, ApiError> {
  let root = session_group_root(state, session_id).await?.unwrap_or(session_id);
  state
    .auth()
    .find_session_group_session_for_user(root, user_id)
    .await
    .map_err(map_auth_error)
}

/// Return the most recently created *still-active* session in the group, excluding one.
///
/// Used after targeted sign-out to select the next session to activate.
async fn newest_active_session_in_group(
  state: &ApiState,
  session_id: Uuid,
  exclude: Option<Uuid>,
) -> Result<Option<Uuid>, ApiError> {
  let mut sessions = list_group_sessions(state, session_id).await?;
  sessions.reverse();
  for sid in sessions {
    if Some(sid) == exclude {
      continue;
    }
    if state
      .auth()
      .get_session_snapshot(sid)
      .await
      .map_err(map_auth_error)?
      .is_some()
    {
      return Ok(Some(sid));
    }
  }
  Ok(None)
}

/// Parse all `Cookie` headers into a name → value map.
///
/// When the same cookie name appears multiple times, the first value wins.
/// Values are not URL-decoded.
pub fn parse_cookies(headers: &HeaderMap) -> HashMap<String, String> {
  let mut cookies = HashMap::new();

  for value in headers.get_all(COOKIE) {
    let Ok(raw) = value.to_str() else {
      continue;
    };

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
///
/// Returns `None` when the cookie is absent or its value is not a valid UUID.
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

/// Append a `Set-Cookie` header to `headers` with the given name, value, and attributes string.
pub fn append_cookie(headers: &mut HeaderMap, key: &str, value: &str, attrs: &str) {
  if let Ok(header_value) = HeaderValue::from_str(&format!("{key}={value}; {attrs}")) {
    headers.append(SET_COOKIE, header_value);
  }
}

fn clear_session_cookies(headers: &mut HeaderMap) {
  clear_cookie(headers, SESSION_COOKIE_NAME, true);
  clear_cookie(headers, LEGACY_SESSION_COOKIE_NAME, true);
  clear_cookie(headers, USER_COOKIE_NAME, false);
  clear_cookie(headers, CSRF_COOKIE_NAME, false);
  clear_cookie(headers, RETIRED_CSRF_COOKIE_NAME, false);
}

/// Expire a cookie by setting `Max-Age=0` on the response.
///
/// When `http_only` is `true`, the cookie is also marked `HttpOnly`.
pub fn clear_cookie(headers: &mut HeaderMap, key: &str, http_only: bool) {
  let mut attrs = "Path=/; SameSite=Lax; Max-Age=0".to_string();
  if http_only {
    attrs.push_str("; HttpOnly");
  }
  append_cookie(headers, key, "", &attrs);
}

/// Extract an HTTP request header as an owned `String`, or `None` if absent or non-ASCII.
pub fn header_to_string(headers: &HeaderMap, key: axum::http::header::HeaderName) -> Option<String> {
  headers
    .get(key)
    .and_then(|value| value.to_str().ok())
    .map(str::to_owned)
}

/// Extract the real client IP from the `X-Forwarded-For` header.
///
/// Takes the first (leftmost) address from the comma-separated list.
/// Returns `None` when the header is absent or blank.
pub fn x_forwarded_for(headers: &HeaderMap) -> Option<String> {
  headers
    .get("x-forwarded-for")
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.split(',').next())
    .map(str::trim)
    .map(str::to_owned)
    .filter(|value| !value.is_empty())
}

/// Convert an [`AuthError`] domain error into the appropriate [`ApiError`] HTTP variant.
///
/// The mapping preserves the NestJS-compatible error `name` codes so the web
/// client can display localized error messages.
pub fn map_auth_error(err: AuthError) -> ApiError {
  match err {
    AuthError::InvalidEmail => ApiError::BadRequest {
      name: "INVALID_EMAIL".into(),
      message: "An invalid email provided.".into(),
      data: None,
    },
    AuthError::WrongSignInCredentials => ApiError::BadRequest {
      name: "WRONG_SIGN_IN_CREDENTIALS".into(),
      message: "Wrong sign in credentials".into(),
      data: None,
    },
    AuthError::ActionForbidden => ApiError::Forbidden {
      name: "ACTION_FORBIDDEN".into(),
      message: "action forbidden".into(),
    },
    AuthError::InvalidToken => ApiError::BadRequest {
      name: "INVALID_EMAIL_TOKEN".into(),
      message: "invalid token".into(),
      data: None,
    },
    AuthError::ExpiredToken => ApiError::BadRequest {
      name: "LINK_EXPIRED".into(),
      message: "expired token".into(),
      data: None,
    },
    AuthError::TokenNotFound => ApiError::NotFound {
      name: "NOT_FOUND".into(),
      message: "token not found".into(),
    },
    AuthError::OauthStateExpired => ApiError::BadRequest {
      name: "OAUTH_STATE_EXPIRED".into(),
      message: "oauth state expired".into(),
      data: None,
    },
    AuthError::SignUpForbidden => ApiError::Forbidden {
      name: "SIGN_UP_FORBIDDEN".into(),
      message: "sign up forbidden".into(),
    },
    AuthError::AuthenticationRequired => ApiError::Unauthorized {
      name: "AUTHENTICATION_REQUIRED".into(),
      message: "authentication required".into(),
    },
    AuthError::NotFound(message) => ApiError::NotFound {
      name: "NOT_FOUND".into(),
      message,
    },
    AuthError::InvalidInput(message) => ApiError::BadRequest {
      name: "INVALID_INPUT".into(),
      message,
      data: None,
    },
    AuthError::WorkspaceOverviewRevisionConflict { .. } => err.into(),
    AuthError::WorkspaceNameConflict { suggestion } => ApiError::BadRequest {
      name: "XWS_WORKSPACE_NAME_CONFLICT".into(),
      message: "workspace name is already reserved".into(),
      data: Some(serde_json::json!({ "suggestion": suggestion })),
    },
    AuthError::StorageQuotaExceeded { .. } => ApiError::Forbidden {
      name: "STORAGE_QUOTA_EXCEEDED".into(),
      message: err.to_string(),
    },
    AuthError::UpdateTooLarge { .. } => ApiError::BadRequest {
      name: "UPDATE_TOO_LARGE".into(),
      message: err.to_string(),
      data: None,
    },
    AuthError::InvalidYjsUpdate => ApiError::BadRequest {
      name: "INVALID_YJS_UPDATE".into(),
      message: err.to_string(),
      data: None,
    },
    AuthError::YjsValidationUnavailable => ApiError::Internal(err.to_string()),
    AuthError::InvalidYjsStateVector => ApiError::BadRequest {
      name: "INVALID_STATE_VECTOR".into(),
      message: err.to_string(),
      data: None,
    },
    AuthError::DocSyncPayloadTooLarge { .. } => ApiError::BadRequest {
      name: "SYNC_PAYLOAD_TOO_LARGE".into(),
      message: err.to_string(),
      data: None,
    },
    AuthError::DocSyncCancelled | AuthError::YjsDecoderUnavailable => ApiError::ServiceUnavailable(err.to_string()),
    AuthError::Storage(message) => ApiError::Internal(message),
  }
}

impl From<AuthUser> for SessionUserResponse {
  fn from(user: AuthUser) -> Self {
    Self {
      id: user.id,
      email: user.email,
      avatar_url: user.avatar_url,
      name: user.name,
      disabled: user.disabled,
      has_password: user.password_hash.is_some(),
      email_verified: user.email_verified_at.is_some(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn first_admin_creation_invalidates_a_primed_uninitialized_server_config() {
    let state = ApiState::new(crate::config::AppConfig::load().expect("test config"));
    state
      .query_cache
      .server_config
      .insert("global".to_string(), serde_json::json!({ "initialized": false }))
      .await;

    create_admin_user(
      State(state.clone()),
      Json(CreateAdminUserRequest {
        email: "first-admin@example.test".to_string(),
        name: "First Admin".to_string(),
        password: Some("correct-horse-battery-staple".to_string()),
      }),
    )
    .await
    .expect("first admin creation");

    assert!(
      state
        .query_cache
        .server_config
        .get(&"global".to_string())
        .await
        .is_none(),
      "the stale initialized=false entry must be gone before the response completes"
    );
    let account_state = state
      .auth()
      .store
      .auth_capability_account_state()
      .await
      .expect("account capability state");
    assert_eq!(account_state.total_users, 1);
    assert_eq!(account_state.active_password_users, 1);
  }
}
