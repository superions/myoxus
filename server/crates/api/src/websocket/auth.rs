//! Socket.IO connect-time authentication middleware.
//!
//! Runs BEFORE the connection is established (matching NestJS's
//! `server.use((socket, next) => canActivate(socket))`). On success, stores the
//! authenticated user and session IDs so handlers and committed revocations
//! can address their owned resources immediately. On failure, returns `Err` → socketioxide sends `connect_error`
//! to the client.
//!
//! Extracted from `mod.rs` in P107-H.

use std::sync::Arc;

use serde::Serialize;
use sha2::{Digest, Sha256};
use socketioxide::extract::{SocketRef, State as SioState, TryData};
use tracing::{debug, info, trace, warn};
use uuid::Uuid;

use crate::graphql::utils::{SESSION_COOKIE_NAME, has_session_cookie, parse_cookies, parse_uuid_cookie};
use crate::state::ApiState;
use myoxus_application::doc::DocSyncClientKind;
use myoxus_application::metrics::{MetricsCategory, MetricsService};

use super::state::{
  SOCKET_CLIENT_CONTEXTS, SOCKET_SESSION_MAP, SOCKET_USER_MAP, SocketClientContext, register_socket_doc_load_state,
};
use super::types::HandshakeAuth;

fn hash_admission_scope(domain: &[u8], identifiers: &[&[u8]]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(domain);
  for identifier in identifiers {
    hasher.update([0]);
    hasher.update(identifier);
  }
  hex::encode(&hasher.finalize()[..16])
}

fn admission_keys(session_id: Uuid, user_id: Uuid) -> (String, String) {
  let session_key = hash_admission_scope(b"websocket-session", &[session_id.as_bytes()]);
  let account_key = hash_admission_scope(b"websocket-account", &[user_id.as_bytes()]);
  (session_key, account_key)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionAdmissionError<'a> {
  code: &'a str,
  retry_after_ms: u64,
}

fn admission_error(code: &str, retry_after_ms: u64) -> String {
  serde_json::to_string(&ConnectionAdmissionError { code, retry_after_ms })
    .expect("connection admission error has a static JSON shape")
}

fn record_connection_admission(
  metrics: &MetricsService,
  client_kind: DocSyncClientKind,
  outcome: &'static str,
  reason: &'static str,
) {
  metrics.record(
    MetricsCategory::Collab,
    "doc_sync_connection_admission_total",
    &[
      ("client_kind", client_kind.as_str()),
      ("outcome", outcome),
      ("reason", reason),
    ],
  );
}

async fn enforce_connection_admission(
  state: &ApiState,
  session_id: Uuid,
  user_id: Uuid,
  context: &SocketClientContext,
) -> Result<(), String> {
  const REDIS_UNAVAILABLE_RETRY_MS: u64 = 1_000;

  let limit = state.websocket_connection_admission_limit().await;
  let Some(adapter) = state.redis_ws_adapter() else {
    record_connection_admission(state.metrics(), context.kind, "rejected", "redis_unavailable");
    warn!(
      event = "doc_sync.connection.admission",
      client_kind = context.kind.as_str(),
      outcome = "rejected",
      reason = "redis_unavailable",
      retry_after_ms = REDIS_UNAVAILABLE_RETRY_MS,
      "connection admission unavailable"
    );
    return Err(admission_error("temporarily_unavailable", REDIS_UNAVAILABLE_RETRY_MS));
  };

  let (session_key, account_key) = admission_keys(session_id, user_id);
  let decision = match adapter.admit_connection(&session_key, &account_key, limit).await {
    Ok(decision) => decision,
    Err(_) => {
      record_connection_admission(state.metrics(), context.kind, "rejected", "redis_unavailable");
      warn!(
        event = "doc_sync.connection.admission",
        client_kind = context.kind.as_str(),
        outcome = "rejected",
        reason = "redis_unavailable",
        retry_after_ms = REDIS_UNAVAILABLE_RETRY_MS,
        "connection admission Redis operation failed"
      );
      return Err(admission_error("temporarily_unavailable", REDIS_UNAVAILABLE_RETRY_MS));
    }
  };

  if !decision.accepted {
    record_connection_admission(state.metrics(), context.kind, "rejected", "rate_limited");
    warn!(
      event = "doc_sync.connection.admission",
      client_kind = context.kind.as_str(),
      outcome = "rejected",
      reason = "rate_limited",
      retry_after_ms = decision.retry_after_ms,
      "connection admission rate limit exceeded"
    );
    return Err(admission_error("rate_limited", decision.retry_after_ms));
  }

  record_connection_admission(state.metrics(), context.kind, "accepted", "allowed");
  debug!(
    event = "doc_sync.connection.admission",
    client_kind = context.kind.as_str(),
    outcome = "accepted",
    reason = "allowed",
    "connection admitted"
  );
  Ok(())
}

async fn enforce_client_update_admission(state: &ApiState, context: &SocketClientContext) -> Result<(), String> {
  use myoxus_contracts::client_update::ClientUpdatePhase;

  if context.kind != DocSyncClientKind::Web {
    return Ok(());
  }

  let runtime = state.client_update_runtime().ok_or_else(|| {
    warn!("Browser Web connection rejected because client update policy is unavailable");
    admission_error("client_update_maintenance", 5_000)
  })?;
  match runtime.read_authoritative().await {
    Ok(control) if matches!(control.phase, ClientUpdatePhase::Normal | ClientUpdatePhase::Limited) => Ok(()),
    Ok(_) => {
      warn!("Browser Web connection rejected by client update policy");
      Err(admission_error("client_update_maintenance", 5_000))
    }
    Err(_) => {
      warn!("Browser Web connection rejected because client update policy is unreadable");
      Err(admission_error("client_update_maintenance", 5_000))
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SessionCredentialSource {
  Token,
  Cookie,
}

fn resolve_client_context(
  auth: &HandshakeAuth,
  credential_source: SessionCredentialSource,
) -> Result<SocketClientContext, String> {
  if credential_source == SessionCredentialSource::Cookie {
    return Ok(SocketClientContext {
      kind: DocSyncClientKind::Web,
    });
  }

  let kind = match auth.client_kind.as_deref() {
    Some("web") => DocSyncClientKind::Web,
    Some("electron") => DocSyncClientKind::Electron,
    Some("mobile") => DocSyncClientKind::Mobile,
    Some("unknown") | None => DocSyncClientKind::Unknown,
    Some(_) => return Err("INVALID_CLIENT_KIND".to_string()),
  };
  Ok(SocketClientContext { kind })
}

/// Socket.IO connect middleware — authenticates BEFORE the connection is
/// established, matching NestJS's `server.use((socket, next) => canActivate(socket))`.
///
/// Auth sources (in priority order, matching NestJS `canActivate`):
/// 1. `handshake.auth.token` — session ID from Desktop/Mobile clients
/// 2. HTTP cookie `affine_session` (or legacy `affine_sid`) — session ID from Web clients
///
/// On success: stores user and session IDs in the socket registries so event
/// handlers can use them immediately without the old polling hack.
/// On failure: returns `Err` → socketioxide sends `connect_error` to the client.
pub(super) async fn auth_middleware(
  socket: SocketRef,
  SioState(state): SioState<Arc<ApiState>>,
  TryData(auth): TryData<HandshakeAuth>,
) -> Result<(), String> {
  let auth = auth.unwrap_or_default();

  // NOTE: These trace!() calls are PERMANENT diagnostic instrumentation for the
  // Socket.IO auth path. They log at TRACE level (disabled in production by default)
  // and are essential for debugging auth failures across transports (polling vs websocket)
  // and credential sources (cookie vs handshake token). DO NOT REMOVE.
  let req_parts = socket.req_parts();
  let transport = req_parts.uri.query().unwrap_or("");
  trace!(
    sid = %socket.id,
    uri = %req_parts.uri,
    transport = %transport,
    has_auth_token = auth.token.is_some(),
    has_cookie_header = req_parts.headers.contains_key(axum::http::header::COOKIE),
    declared_client_kind = auth.client_kind.as_deref().unwrap_or("unknown"),
    "socket auth middleware: incoming connection"
  );

  // Priority 1: handshake auth token (Desktop/Mobile)
  // Priority 2: HTTP cookie (Web)
  let token_session_id = auth.token.as_deref().and_then(|t| uuid::Uuid::parse_str(t).ok());
  let (session_id, credential_source) = if let Some(session_id) = token_session_id {
    (session_id, SessionCredentialSource::Token)
  } else {
    let headers = &req_parts.headers;
    let cookies = parse_cookies(headers);
    // PERMANENT trace — shows cookie parsing result (cookie names only, no values).
    // Critical for diagnosing missing session cookies across browsers. DO NOT REMOVE.
    trace!(
      sid = %socket.id,
      cookie_count = cookies.len(),
      has_session_cookie = has_session_cookie(&cookies),
      cookie_keys = ?cookies.keys().collect::<Vec<_>>(),
      "socket auth middleware: parsed cookies"
    );
    let session_id = parse_uuid_cookie(&cookies, SESSION_COOKIE_NAME).ok_or_else(|| {
      warn!(sid = %socket.id, "socket auth middleware: no session (cookie or auth.token)");
      "AUTHENTICATION_REQUIRED".to_string()
    })?;
    (session_id, SessionCredentialSource::Cookie)
  };

  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|e| {
      warn!(sid = %socket.id, error = %e, "socket auth middleware: session lookup failed");
      "AUTHENTICATION_REQUIRED".to_string()
    })?
    .ok_or_else(|| {
      warn!(sid = %socket.id, "socket auth middleware: session not found or expired");
      "AUTHENTICATION_REQUIRED".to_string()
    })?;

  // Browser Web is identified by its authenticated cookie session, never by a
  // browser-profile identifier supplied by client JavaScript. Legacy
  // `clientInstanceId` fields are accepted but deliberately ignored.
  let client_context = resolve_client_context(&auth, credential_source)?;
  let user_id = snapshot.user.id;
  enforce_client_update_admission(&state, &client_context).await?;
  enforce_connection_admission(&state, session_id, user_id, &client_context).await?;
  let ws_user_agent = req_parts
    .headers
    .get(axum::http::header::USER_AGENT)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("-");
  info!(
    sid = %socket.id,
    %user_id,
    user_agent = %ws_user_agent,
    client_kind = client_context.kind.as_str(),
    "socket authenticated via middleware"
  );
  SOCKET_USER_MAP.insert(socket.id.to_string(), user_id);
  SOCKET_SESSION_MAP.insert(socket.id.to_string(), session_id);
  SOCKET_CLIENT_CONTEXTS.insert(socket.id.to_string(), client_context);
  register_socket_doc_load_state(&socket.id.to_string());

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn auth(kind: Option<&str>, instance_id: Option<&str>) -> HandshakeAuth {
    HandshakeAuth {
      token: None,
      user_id: None,
      client_kind: kind.map(ToOwned::to_owned),
      client_instance_id: instance_id.map(ToOwned::to_owned),
    }
  }

  #[test]
  fn cookie_session_is_web_and_ignores_legacy_profile_identity() {
    for instance_id in [None, Some("not-a-uuid"), Some("00000000-0000-1000-8000-000000000001")] {
      let context = resolve_client_context(
        &auth(Some("invalid-declaration-is-ignored"), instance_id),
        SessionCredentialSource::Cookie,
      )
      .expect("cookie-authenticated Browser Web context");
      assert_eq!(context.kind, DocSyncClientKind::Web);
    }
  }

  #[test]
  fn token_session_keeps_native_client_class_validation() {
    assert_eq!(
      resolve_client_context(&auth(Some("electron"), None), SessionCredentialSource::Token)
        .expect("electron context")
        .kind,
      DocSyncClientKind::Electron
    );
    assert_eq!(
      resolve_client_context(&auth(Some("invalid"), None), SessionCredentialSource::Token).unwrap_err(),
      "INVALID_CLIENT_KIND"
    );
  }

  #[test]
  fn admission_is_scoped_by_session_and_account() {
    let session_a = Uuid::new_v4();
    let session_b = Uuid::new_v4();
    let user = Uuid::new_v4();
    let (session_a_key, account_a_key) = admission_keys(session_a, user);
    let (session_b_key, account_b_key) = admission_keys(session_b, user);
    assert_ne!(session_a_key, session_b_key);
    assert_eq!(account_a_key, account_b_key);
  }

  #[test]
  fn admission_metric_uses_only_bounded_dimensions() {
    let metrics = MetricsService::in_memory_stub();
    let mut policy = myoxus_application::metrics::MetricsPolicy {
      enabled: true,
      cardinality_limit_per_metric: 100,
      ..Default::default()
    };
    policy.categories.insert("collab".to_string(), true);
    metrics.set_policy(policy);
    for kind in [
      DocSyncClientKind::Web,
      DocSyncClientKind::Electron,
      DocSyncClientKind::Mobile,
      DocSyncClientKind::Unknown,
    ] {
      record_connection_admission(&metrics, kind, "accepted", "allowed");
    }

    let prometheus = metrics.render_prometheus();
    for kind in ["web", "electron", "mobile", "unknown"] {
      assert!(prometheus.contains(&format!("client_kind=\"{kind}\"")));
    }
    assert!(prometheus.contains("outcome=\"accepted\""));
    assert!(prometheus.contains("reason=\"allowed\""));
    assert!(!prometheus.contains("session"));
    assert!(!prometheus.contains("client_instance"));
  }
}
