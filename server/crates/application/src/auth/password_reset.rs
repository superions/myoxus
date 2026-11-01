// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical password-reset link construction.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use tracing::instrument;
use url::Url;
use uuid::Uuid;

use super::{AuthError, AuthResult, AuthStore};

pub const DEFAULT_PASSWORD_RESET_TTL_SECONDS: i64 = 1_800;
pub const MIN_PASSWORD_RESET_TTL_SECONDS: i64 = 300;
pub const MAX_PASSWORD_RESET_TTL_SECONDS: i64 = 86_400;
pub const DEFAULT_PASSWORD_RESET_CALLBACK_PATH: &str = "/auth/changePassword";

const CALLBACK_PARSE_ORIGIN: &str = "https://callback.invalid";
const RESERVED_QUERY_PARAMETERS: &[&str] = &["token", "userid"];

/// Authorized secret output and the exact expiry supplied to token persistence.
/// Debug output deliberately redacts the URL; transports project it explicitly.
#[derive(Clone)]
pub struct PasswordResetLink {
  pub url: String,
  pub expires_at: DateTime<Utc>,
}

impl std::fmt::Debug for PasswordResetLink {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter
      .debug_struct("PasswordResetLink")
      .field("url", &"[REDACTED]")
      .field("expires_at", &self.expires_at)
      .finish()
  }
}

/// Creates one-time password-reset links from server-owned origin data.
///
/// Callers can choose only a local callback path. Origin, token purpose and
/// expiry remain application-owned so Admin, self-service and CLI cannot drift
/// into subtly different security contracts.
#[derive(Clone)]
pub struct PasswordResetLinkService {
  store: Arc<dyn AuthStore>,
  ttl_seconds: i64,
}

impl PasswordResetLinkService {
  pub fn new(store: Arc<dyn AuthStore>, ttl_seconds: i64) -> AuthResult<Self> {
    validate_password_reset_ttl_seconds(ttl_seconds)?;
    Ok(Self { store, ttl_seconds })
  }

  /// Persist a single-use token and return its authorized one-time link.
  /// Neither callback input nor generated secret is attached to the tracing
  /// span because both can carry security-sensitive navigation state.
  #[instrument(skip_all, fields(user_id = %user_id))]
  pub async fn create_link(
    &self,
    user_id: Uuid,
    server_origin: &str,
    callback_path: Option<&str>,
  ) -> AuthResult<PasswordResetLink> {
    if self.store.get_user_by_id(user_id).await?.is_none() {
      return Err(AuthError::NotFound("user".to_string()));
    }

    let mut link = build_callback_url(
      server_origin,
      callback_path.unwrap_or(DEFAULT_PASSWORD_RESET_CALLBACK_PATH),
    )?;
    let token = Uuid::new_v4().to_string();
    // PostgreSQL timestamps retain microseconds; use that same precision in
    // the authorized expiry projection and the InMemory persistence contract.
    let expires_at =
      DateTime::from_timestamp_micros((Utc::now() + Duration::seconds(self.ttl_seconds)).timestamp_micros())
        .ok_or_else(|| AuthError::Storage("password reset expiry is outside the supported range".to_string()))?;
    self
      .store
      .create_verification_token(Some(user_id), "ChangePassword", &token, None, expires_at, None)
      .await?;

    link
      .query_pairs_mut()
      .append_pair("userId", &user_id.to_string())
      .append_pair("token", &token);
    Ok(PasswordResetLink {
      url: link.into(),
      expires_at,
    })
  }
}

/// Validate the process-bound reset-token lifetime used by API and trusted
/// local CLI bootstraps before either service can mint a token.
pub fn validate_password_reset_ttl_seconds(ttl_seconds: i64) -> AuthResult<i64> {
  if !(MIN_PASSWORD_RESET_TTL_SECONDS..=MAX_PASSWORD_RESET_TTL_SECONDS).contains(&ttl_seconds) {
    return Err(AuthError::InvalidInput(
      "password reset TTL is outside the supported range".to_string(),
    ));
  }
  Ok(ttl_seconds)
}

fn invalid_callback() -> AuthError {
  AuthError::InvalidInput("password reset callback must be a safe local path".to_string())
}

fn contains_unsafe_percent_encoding(value: &str) -> bool {
  let bytes = value.as_bytes();
  let path_end = value.find('?').unwrap_or(value.len());
  let mut index = 0;
  while index < bytes.len() {
    if bytes[index] != b'%' {
      index += 1;
      continue;
    }
    let Some(encoded) = bytes.get(index + 1..index + 3) else {
      return true;
    };
    let Some(high) = (encoded[0] as char).to_digit(16) else {
      return true;
    };
    let Some(low) = (encoded[1] as char).to_digit(16) else {
      return true;
    };
    let decoded = ((high << 4) | low) as u8;
    if decoded.is_ascii_control() || decoded == 0x7f || (index < path_end && matches!(decoded, b'/' | b'\\')) {
      return true;
    }
    index += 3;
  }
  false
}

fn build_callback_url(server_origin: &str, callback_path: &str) -> AuthResult<Url> {
  let mut origin = Url::parse(server_origin)
    .map_err(|_| AuthError::InvalidInput("server.origin must be a valid HTTP(S) origin".to_string()))?;
  if !matches!(origin.scheme(), "http" | "https")
    || origin.host_str().is_none()
    || !origin.username().is_empty()
    || origin.password().is_some()
    || origin.query().is_some()
    || origin.fragment().is_some()
  {
    return Err(AuthError::InvalidInput(
      "server.origin must be a valid HTTP(S) origin".to_string(),
    ));
  }

  if callback_path.is_empty()
    || !callback_path.starts_with('/')
    || callback_path.starts_with("//")
    || callback_path.contains('\\')
    || callback_path.contains('#')
    || callback_path.chars().any(char::is_control)
    || contains_unsafe_percent_encoding(callback_path)
  {
    return Err(invalid_callback());
  }

  let callback_base = Url::parse(CALLBACK_PARSE_ORIGIN).expect("static callback parser origin");
  let callback = callback_base.join(callback_path).map_err(|_| invalid_callback())?;
  if callback.origin() != callback_base.origin() || callback.fragment().is_some() {
    return Err(invalid_callback());
  }
  if callback.query_pairs().any(|(key, _)| {
    RESERVED_QUERY_PARAMETERS
      .iter()
      .any(|reserved| key.eq_ignore_ascii_case(reserved))
  }) {
    return Err(AuthError::InvalidInput(
      "password reset callback contains a reserved query parameter".to_string(),
    ));
  }

  {
    let callback_segments = callback.path_segments().ok_or_else(invalid_callback)?;
    let mut target_segments = origin.path_segments_mut().map_err(|_| invalid_callback())?;
    target_segments.pop_if_empty();
    for segment in callback_segments {
      let decoded = urlencoding::decode(segment).map_err(|_| invalid_callback())?;
      target_segments.push(&decoded);
    }
  }
  origin.set_query(callback.query());
  Ok(origin)
}

#[cfg(test)]
mod tests {
  use std::sync::Arc;

  use chrono::Utc;

  use super::*;
  use crate::auth::{AuthUser, InMemoryAuthStore};

  fn user(id: Uuid) -> AuthUser {
    AuthUser {
      id,
      email: "reset@example.test".to_string(),
      name: None,
      avatar_url: None,
      password_hash: None,
      is_admin: false,
      disabled: false,
      email_verified_at: Some(Utc::now()),
      registered: true,
    }
  }

  #[tokio::test]
  async fn preserves_server_basepath_and_callback_query_without_reserved_duplicates() {
    let store = Arc::new(InMemoryAuthStore::default());
    let user_id = Uuid::new_v4();
    store.insert_user(user(user_id));
    let service = PasswordResetLinkService::new(store.clone(), 900).expect("service");

    let before = Utc::now();
    let link = service
      .create_link(
        user_id,
        "https://workspace.example.test/base",
        Some("/auth/changePassword?returnTo=%2Fsettings%3Ftab%3Dsecurity"),
      )
      .await
      .expect("reset link");
    let parsed = Url::parse(&link.url).expect("generated URL");
    assert_eq!(parsed.origin().ascii_serialization(), "https://workspace.example.test");
    assert_eq!(parsed.path(), "/base/auth/changePassword");
    assert_eq!(
      parsed
        .query_pairs()
        .find(|(key, _)| key == "returnTo")
        .map(|(_, value)| value.into_owned()),
      Some("/settings?tab=security".to_string())
    );
    assert_eq!(parsed.query_pairs().filter(|(key, _)| key == "token").count(), 1);
    assert_eq!(
      parsed
        .query_pairs()
        .find(|(key, _)| key == "userId")
        .map(|(_, value)| value.into_owned()),
      Some(user_id.to_string())
    );

    let token = parsed
      .query_pairs()
      .find(|(key, _)| key == "token")
      .map(|(_, value)| value.into_owned())
      .expect("token query parameter");
    let record = store
      .get_verification_token(&token)
      .await
      .expect("token lookup")
      .expect("stored token");
    assert_eq!(record.kind, "ChangePassword");
    assert_eq!(record.user_id, Some(user_id));
    assert_eq!(link.expires_at, record.expires_at);
    let debug = format!("{link:?}");
    assert!(!debug.contains(&link.url) && !debug.contains(&token));
    assert!(record.expires_at >= before + Duration::seconds(899));
    assert!(record.expires_at <= Utc::now() + Duration::seconds(901));
  }

  #[tokio::test]
  async fn preserves_percent_encoded_utf8_path_segments_without_double_encoding() {
    let store = Arc::new(InMemoryAuthStore::default());
    let user_id = Uuid::new_v4();
    store.insert_user(user(user_id));
    let service = PasswordResetLinkService::new(store, 900).expect("service");

    let link = service
      .create_link(
        user_id,
        "https://workspace.example.test/myoxus",
        Some("/auth/r%C3%A9initialiser%20le%20mot%20de%20passe"),
      )
      .await
      .expect("reset link");
    let parsed = Url::parse(&link.url).expect("generated URL");
    assert_eq!(parsed.path(), "/myoxus/auth/r%C3%A9initialiser%20le%20mot%20de%20passe");
    assert!(!parsed.path().contains("%25"), "path must not be double encoded");
  }

  #[tokio::test]
  async fn rejects_external_and_ambiguous_callback_forms_without_persisting_tokens() {
    let store = Arc::new(InMemoryAuthStore::default());
    let user_id = Uuid::new_v4();
    store.insert_user(user(user_id));
    let service = PasswordResetLinkService::new(store.clone(), 1_800).expect("service");

    assert!(
      matches!(
        service
          .create_link(Uuid::new_v4(), "https://workspace.example.test", None)
          .await,
        Err(AuthError::NotFound(_))
      ),
      "missing account must not receive a token"
    );

    for callback in [
      "https://evil.example/reset",
      "//evil.example/reset",
      "/\\evil",
      "/reset#fragment",
      "/reset\nnext",
      "/%5cevil",
      "/%2F%2Fevil.example/reset",
      "/reset?returnTo=%0d%0aInjected",
      "/reset?returnTo=%00",
      "/reset?returnTo=%zz",
      "/reset?token=attacker",
      "/reset?USERID=attacker",
      "reset",
      "",
    ] {
      let result = service
        .create_link(user_id, "https://workspace.example.test/base", Some(callback))
        .await;
      assert!(result.is_err(), "callback must be rejected: {callback:?}");
    }
    assert!(
      store
        .verification_tokens
        .read()
        .expect("verification token lock")
        .is_empty(),
      "rejected callbacks must never persist a reset token"
    );
  }

  #[tokio::test]
  async fn rejects_invalid_server_origins_without_persisting_tokens() {
    let store = Arc::new(InMemoryAuthStore::default());
    let user_id = Uuid::new_v4();
    store.insert_user(user(user_id));
    let service = PasswordResetLinkService::new(store.clone(), 1_800).expect("service");

    for origin in [
      "javascript:alert(1)",
      "https://user:secret@workspace.example.test",
      "https://workspace.example.test?redirect=evil",
      "https://workspace.example.test/#fragment",
      "//workspace.example.test",
      "not a URL",
    ] {
      let result = service.create_link(user_id, origin, None).await;
      assert!(result.is_err(), "server origin must be rejected: {origin:?}");
    }
    assert!(
      store
        .verification_tokens
        .read()
        .expect("verification token lock")
        .is_empty(),
      "rejected server origins must never persist a reset token"
    );
  }

  #[test]
  fn reset_ttl_is_bounded() {
    let store = Arc::new(InMemoryAuthStore::default());
    assert!(PasswordResetLinkService::new(store.clone(), 299).is_err());
    assert!(PasswordResetLinkService::new(store.clone(), 300).is_ok());
    assert!(PasswordResetLinkService::new(store.clone(), 86_400).is_ok());
    assert!(PasswordResetLinkService::new(store, 86_401).is_err());
  }
}
