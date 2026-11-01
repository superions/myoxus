//! Axum middleware for request logging and rate-limiting (throttling).
//!
//! Two middlewares are applied to the entire router (outermost layer first):
//!
//! 1. `logger_middleware` — records method/path/status/latency with `tracing`
//!    and updates the atomic request-metrics counters on [`ApiState`].
//! 2. `throttle_middleware` — Redis-backed fixed-window rate limiter.
//!    Authenticated users bypass public-route throttles.  Auth endpoints use a
//!    stricter per-IP limit to prevent brute-force attacks.
//!
//! The throttle policy is route-based: health and metrics endpoints are exempt;
//! auth endpoints use `ProtectedStrict`; telemetry collect has an independent per-IP
//! minute limit; remaining routes use their public or protected default policy.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::{
  extract::ConnectInfo,
  http::{HeaderMap, StatusCode},
  middleware::Next,
  response::{IntoResponse, Json},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use tracing::{Instrument, Level, debug, info, instrument, span, warn};

use crate::request_id::RequestId;
use crate::state::ApiState;

/// Throttle policy assigned to a route based on its path prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThrottleRoutePolicy {
  /// Health/metrics endpoints — always bypass rate limiting.
  NoThrottle,
  /// Public-facing routes (e.g. `/info`, OAuth callbacks) — throttled for
  /// unauthenticated callers only; authenticated users are exempt.
  PublicDefault,
  /// Authenticated API routes (GraphQL, blob, workspace, rpc) — throttled
  /// per-user with the default policy.
  ProtectedDefault,
  /// Sensitive auth endpoints (sign-in, magic-link, challenge) — throttled
  /// per-IP with a stricter limit to limit brute-force attacks.
  ProtectedStrict,
}

/// Axum middleware that logs every request and records latency metrics.
///
/// Creates a `tracing` span tagged with method, path, and request ID, then
/// calls the inner handler.  After the response is produced it records
/// latency and status code into the atomic counters on [`ApiState`].
#[instrument(skip_all)]
pub(crate) async fn logger_middleware(
  axum::extract::State(state): axum::extract::State<Arc<ApiState>>,
  request: axum::http::Request<axum::body::Body>,
  next: Next,
) -> impl IntoResponse {
  let start = Instant::now();
  let method = request.method().clone();
  // Query strings may contain OAuth codes, state and other bearer credentials.
  let uri = request.uri().path().to_string();
  let request_id = request.extensions().get::<RequestId>().cloned().unwrap_or_default();

  let span = span!(
      Level::INFO,
      "request",
      method = %method,
      uri = %uri,
      request_id = %request_id.0
  );

  // Enter on each poll, never hold a synchronous span guard across await.
  async move {
    debug!("started processing request");

    let response = next.run(request).await;

    let latency = start.elapsed();
    let status = response.status();
    state.record_request_metrics(status.as_u16(), latency);

    info!(
        status = %status.as_u16(),
        latency = ?latency,
        "finished processing request"
    );

    response
  }
  .instrument(span)
  .await
}

/// Map a request path to its [`ThrottleRoutePolicy`].
///
/// Called once per request before the Redis counter check.  The returned
/// policy drives which rate-limit bucket is used (or whether to skip entirely).
pub(crate) fn throttle_route_policy(path: &str) -> ThrottleRoutePolicy {
  if path == "/health" || path == "/ready" || path == "/live" || path == "/metrics" || path == "/metrics/prometheus" {
    return ThrottleRoutePolicy::NoThrottle;
  }

  if path.starts_with("/api/auth/sign-in")
    || path.starts_with("/api/auth/magic-link")
    || path.starts_with("/api/auth/open-app/sign-in")
    || path.starts_with("/api/auth/open-app/sign-in-code")
    || path.starts_with("/api/auth/challenge")
  {
    return ThrottleRoutePolicy::ProtectedStrict;
  }

  if path.starts_with("/graphql")
    || path.starts_with("/api/workspaces/")
    || path.starts_with("/api/blob-upload/")
    || path.starts_with("/api/storage/")
    || path.starts_with("/api/copilot/")
    || path.starts_with("/api/calendar/")
    || path.starts_with("/rpc/")
  {
    return ThrottleRoutePolicy::ProtectedDefault;
  }

  ThrottleRoutePolicy::PublicDefault
}

/// Map a request path to a stable short scope label used in the Redis throttle key.
///
/// Grouping many paths under a single label (e.g. all `/api/workspaces/*` paths
/// share `"workspaces"`) prevents the Redis key space from growing unboundedly.
pub(crate) fn throttle_scope(path: &str) -> &'static str {
  if path.starts_with("/graphql") {
    "graphql"
  } else if path.starts_with("/api/workspaces/") {
    "workspaces"
  } else if path.starts_with("/api/storage/") {
    "storage"
  } else if path.starts_with("/api/blob-upload/") {
    "blob-upload"
  } else if path.starts_with("/api/copilot/") {
    "copilot"
  } else if path.starts_with("/api/calendar/") {
    "calendar"
  } else if path.starts_with("/rpc/") {
    "rpc"
  } else if path.starts_with("/api/auth/") {
    "auth"
  } else {
    "public"
  }
}

/// Extract a stable client identifier from request headers for throttle tracking.
///
/// API-RV-08b: Only trust forwarded headers from trusted (loopback) proxies.
///
/// When `peer_addr` is available (via `ConnectInfo`):
/// - If the peer is a loopback address (127.0.0.1, ::1), the connection likely
///   comes through a local reverse proxy — forwarded headers are trusted.
/// - If the peer is any other address, the client is connecting directly and
///   could spoof forwarded headers — the peer address is used instead.
///
/// When `peer_addr` is `None` (e.g. `ConnectInfo` not configured), forwarded
/// headers are trusted for backward compatibility (the server is assumed to be
/// behind a proxy).
///
/// Forwarded headers (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`) are
/// validated to be plausible IP address format. Falls back to `User-Agent`,
/// then `"unknown"`.
pub(crate) fn throttle_client_id(headers: &HeaderMap, peer_addr: Option<SocketAddr>) -> String {
  throttle_ip_client_id(headers, peer_addr).unwrap_or_else(|| {
    headers
      .get(axum::http::header::USER_AGENT)
      .and_then(|h| h.to_str().ok())
      .filter(|ua| !ua.trim().is_empty())
      .map(ToString::to_string)
      .unwrap_or_else(|| "unknown".to_string())
  })
}

// Keep proxy/peer selection shared; telemetry must never inherit the generic
// User-Agent fallback, even when that header happens to contain a valid IP.
fn throttle_ip_client_id(headers: &HeaderMap, peer_addr: Option<SocketAddr>) -> Option<String> {
  // If we know the peer address and it is NOT loopback, the client is
  // connecting directly — use the peer IP, ignoring any forwarded headers
  // (which the client could have spoofed).
  if let Some(addr) = peer_addr
    && !addr.ip().is_loopback()
  {
    return Some(addr.ip().to_string());
  }

  // Either the peer is loopback (trusted proxy) or we have no peer info
  // (assume behind proxy for backward compatibility) — trust forwarded headers.
  for key in ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] {
    if let Some(value) = headers.get(key).and_then(|h| h.to_str().ok()) {
      let first = value.split(',').next().unwrap_or_default().trim();
      // Validate: must look like an IP address (v4 or v6), not arbitrary text
      if !first.is_empty() && (first.parse::<IpAddr>().is_ok() || first.contains(':')) {
        return Some(first.to_string());
      }
    }
  }

  // No forwarded headers — use peer address if available
  if let Some(addr) = peer_addr {
    return Some(addr.ip().to_string());
  }

  None
}

/// Axum middleware that enforces per-route, per-client rate limits via Redis.
///
/// Algorithm: for each request an atomic Redis counter is incremented under the
/// key `throttler:{client};{policy}:{scope}:{bucket}`.  The bucket is derived
/// from `floor(now_ms / ttl_ms)`, giving fixed windows.
/// When the counter exceeds the configured limit a `429 Too Many Requests`
/// response is returned with `Retry-After`, `X-RateLimit-Limit`,
/// `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.
///
/// Authenticated users are identified by their session user ID; unauthenticated
/// callers are identified by IP address.  Authenticated users are exempt from
/// public-route policies except telemetry collection, which always uses an IP
/// digest and its configured minute budget. Telemetry fails closed on Redis
/// errors; other routes retain their existing fail-open behavior.
#[instrument(skip_all)]
pub(crate) async fn throttle_middleware(
  axum::extract::State(state): axum::extract::State<Arc<ApiState>>,
  request: axum::http::Request<axum::body::Body>,
  next: Next,
) -> impl IntoResponse {
  let path = request.uri().path().to_string();
  let telemetry_ingest = path == "/api/telemetry/collect" && request.method() == axum::http::Method::POST;
  // Telemetry has its own master switch and IP budget, independent of auth
  // and throttle.enabled. Preserve the handler's disabled 503 acknowledgment.
  if telemetry_ingest && !state.config.telemetry.enabled {
    return next.run(request).await;
  }

  // P84-D-02: Use the cached throttle.enabled value (30s TTL) instead of
  // querying the DB on every single request.
  if !telemetry_ingest && !state.throttle_enabled_cached().await {
    return next.run(request).await;
  }

  let route_policy = throttle_route_policy(&path);
  if route_policy == ThrottleRoutePolicy::NoThrottle {
    return next.run(request).await;
  }

  let cookies = crate::graphql::utils::parse_cookies(request.headers());
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME);
  let session_user = if telemetry_ingest {
    None
  } else if let Some(session_id) = session_id {
    match state.auth().get_session_snapshot(session_id).await {
      Ok(Some(snapshot)) => Some(snapshot.user.id),
      Ok(None) => None,
      Err(error) => {
        warn!(%session_id, error = %error, "throttle session snapshot lookup failed");
        None
      }
    }
  } else {
    None
  };

  if !telemetry_ingest && route_policy == ThrottleRoutePolicy::PublicDefault && session_user.is_some() {
    return next.run(request).await;
  }

  let (policy_name, policy) = if route_policy == ThrottleRoutePolicy::ProtectedStrict {
    ("strict", &state.config.throttle.throttlers.strict)
  } else {
    ("default", &state.config.throttle.throttlers.default)
  };

  let ttl_ms = if telemetry_ingest { 60_000 } else { policy.ttl_ms.max(1) };
  let limit = if telemetry_ingest {
    state.config.telemetry.ingest_rate_limit_per_ip_per_min.max(1) as i64
  } else {
    policy.limit.max(1) as i64
  };
  let now_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  let bucket = now_ms / ttl_ms;
  let peer_addr = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|ci| ci.0);
  let client_id = if telemetry_ingest {
    throttle_ip_client_id(request.headers(), peer_addr).unwrap_or_else(|| "unknown".into())
  } else {
    throttle_client_id(request.headers(), peer_addr)
  };
  let tracker = if telemetry_ingest {
    // Reuse the proxy trust boundary, but never let User-Agent or alternate
    // IPv6 spellings create separate IP budgets. Persist only a digest.
    let ip = client_id
      .parse::<IpAddr>()
      .map(|ip| ip.to_string())
      .unwrap_or_else(|_| "unknown".into());
    format!("ip:{}", hex::encode(Sha256::digest(ip.as_bytes())))
  } else {
    session_user
      .map(|id| format!("user:{id}"))
      .unwrap_or_else(|| format!("ip:{client_id}"))
  };
  let scope = if telemetry_ingest {
    "telemetry-collect"
  } else {
    throttle_scope(&path)
  };
  let key = format!("throttler:{tracker};{policy_name}:{scope}:{bucket}");
  let ttl_seconds = if telemetry_ingest {
    (ttl_ms - now_ms % ttl_ms).div_ceil(1_000)
  } else {
    ttl_ms.div_ceil(1_000).max(1)
  };
  let redis = state.redis_port();

  let current = match redis.increase(&key, 1).await {
    Ok(current) => {
      if telemetry_ingest {
        // Refresh expiry on every attempt so a retry repairs a counter left
        // between INCR and EXPIRE. Never accept ingestion without bounded TTL.
        if !matches!(redis.expire_key(&key, ttl_seconds).await, Ok(true)) {
          warn!("telemetry throttle expiry failed; rejecting ingestion");
          return telemetry_throttle_unavailable();
        }
      } else if current == 1 {
        let _ = redis.expire_key(&key, ttl_seconds).await;
      }
      current
    }
    Err(error) => {
      if telemetry_ingest {
        warn!("telemetry throttle counter unavailable; rejecting ingestion");
        return telemetry_throttle_unavailable();
      }
      warn!(error = %error, key = %key, "throttle counter update failed; allowing request");
      return next.run(request).await;
    }
  };

  if current > limit {
    let retry_after = ttl_seconds.to_string();
    let mut response = (
      StatusCode::TOO_MANY_REQUESTS,
      Json(json!({
          "error": "too_many_requests",
          "message": "request rate limited by server throttle policy"
      })),
    )
      .into_response();
    if let Ok(value) = retry_after.parse() {
      response.headers_mut().insert(axum::http::header::RETRY_AFTER, value);
    }
    if let Ok(value) = limit.to_string().parse() {
      response.headers_mut().insert("x-ratelimit-limit", value);
    }
    if let Ok(value) = "0".parse() {
      response.headers_mut().insert("x-ratelimit-remaining", value);
    }
    if let Ok(value) = ttl_seconds.to_string().parse() {
      response.headers_mut().insert("x-ratelimit-reset", value);
    }
    return response;
  }

  let mut response = next.run(request).await;
  let remaining = (limit - current).max(0);
  if let Ok(value) = limit.to_string().parse() {
    response.headers_mut().insert("x-ratelimit-limit", value);
  }
  if let Ok(value) = remaining.to_string().parse() {
    response.headers_mut().insert("x-ratelimit-remaining", value);
  }
  if let Ok(value) = ttl_seconds.to_string().parse() {
    response.headers_mut().insert("x-ratelimit-reset", value);
  }
  response
}

fn telemetry_throttle_unavailable() -> axum::response::Response {
  (
    StatusCode::SERVICE_UNAVAILABLE,
    Json(json!({"error": "telemetry_throttle_unavailable"})),
  )
    .into_response()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn request_logs_exclude_credentials_without_changing_the_request() {
    use std::io::Write;
    use std::sync::Mutex;

    use axum::{Router, body::Body, http::Request, middleware, routing::get};
    use tower::ServiceExt;
    use tracing::instrument::WithSubscriber;

    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
      fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
      }

      fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
      }
    }

    let output = Arc::new(Mutex::new(Vec::new()));
    let writer = Capture(output.clone());
    let subscriber = tracing_subscriber::fmt()
      .with_ansi(false)
      .without_time()
      .with_writer(move || writer.clone())
      .finish();
    let state = Arc::new(ApiState::new(
      crate::config::AppConfig::load().expect("test configuration"),
    ));
    let router = Router::new()
      .route(
        "/logging-probe",
        get(|request: Request<Body>| async move {
          assert_eq!(request.uri().query(), Some("token=QUERY_CREDENTIAL_SENTINEL"));
          assert_eq!(
            request.headers()["referer"],
            "https://example.test/?token=REFERER_CREDENTIAL_SENTINEL"
          );
          StatusCode::ACCEPTED
        }),
      )
      .layer(middleware::from_fn_with_state(state, logger_middleware))
      .layer(middleware::from_fn(crate::request_id::attach_request_id));
    let response = router
      .oneshot(
        Request::builder()
          .uri("/logging-probe?token=QUERY_CREDENTIAL_SENTINEL")
          .header("referer", "https://example.test/?token=REFERER_CREDENTIAL_SENTINEL")
          .body(Body::empty())
          .unwrap(),
      )
      .with_subscriber(subscriber)
      .await
      .unwrap();

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let request_id = response.headers()["x-request-id"].to_str().unwrap();
    uuid::Uuid::parse_str(request_id).expect("usable request correlation");
    let logs = String::from_utf8(output.lock().unwrap().clone()).unwrap();
    for expected in ["method=GET", "uri=/logging-probe", "status=202", "latency=", request_id] {
      assert!(logs.contains(expected), "missing diagnostic field {expected}: {logs}");
    }
    assert!(!logs.contains("QUERY_CREDENTIAL_SENTINEL"));
    assert!(!logs.contains("REFERER_CREDENTIAL_SENTINEL"));
  }

  fn loopback_peer() -> Option<SocketAddr> {
    Some(SocketAddr::from(([127, 0, 0, 1], 12345)))
  }

  fn external_peer() -> Option<SocketAddr> {
    Some(SocketAddr::from(([198, 51, 100, 42], 54321)))
  }

  // --- Existing tests (peer_addr=None → backward-compatible, trusts headers) ---

  /// API-RV-08: throttle_client_id rejects non-IP forwarded values.
  #[test]
  fn throttle_rejects_non_ip_forwarded() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "not-an-ip".parse().unwrap());
    let id = throttle_client_id(&headers, None);
    assert_ne!(id, "not-an-ip");
  }

  #[test]
  fn throttle_accepts_valid_ipv4() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "203.0.113.1".parse().unwrap());
    assert_eq!(throttle_client_id(&headers, None), "203.0.113.1");
  }

  #[test]
  fn throttle_accepts_valid_ipv6() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "2001:db8::1".parse().unwrap());
    assert_eq!(throttle_client_id(&headers, None), "2001:db8::1");
  }

  #[test]
  fn throttle_falls_back_to_user_agent() {
    let mut headers = HeaderMap::new();
    headers.insert(axum::http::header::USER_AGENT, "TestBot/1.0".parse().unwrap());
    assert_eq!(throttle_client_id(&headers, None), "TestBot/1.0");
  }

  #[test]
  fn throttle_unknown_when_no_headers() {
    let headers = HeaderMap::new();
    assert_eq!(throttle_client_id(&headers, None), "unknown");
  }

  // --- API-RV-08b: Trusted proxy tests ---

  /// Loopback peer (trusted proxy): forwarded headers ARE trusted.
  #[test]
  fn throttle_loopback_trusts_forwarded_header() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "203.0.113.50".parse().unwrap());
    assert_eq!(throttle_client_id(&headers, loopback_peer()), "203.0.113.50");
  }

  /// External peer (direct connection): forwarded headers are IGNORED,
  /// peer IP is used even when x-forwarded-for is present.
  #[test]
  fn throttle_external_peer_ignores_forwarded_header() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "10.0.0.1".parse().unwrap());
    assert_eq!(throttle_client_id(&headers, external_peer()), "198.51.100.42");
  }

  /// External peer without any headers: uses peer IP.
  #[test]
  fn throttle_external_peer_uses_peer_ip() {
    let headers = HeaderMap::new();
    assert_eq!(throttle_client_id(&headers, external_peer()), "198.51.100.42");
  }

  /// Loopback peer with no forwarded headers falls back to peer IP.
  #[test]
  fn throttle_loopback_no_forwarded_falls_back_to_peer() {
    let headers = HeaderMap::new();
    assert_eq!(throttle_client_id(&headers, loopback_peer()), "127.0.0.1");
  }

  /// IPv6 loopback (::1) is also treated as trusted.
  #[test]
  fn throttle_ipv6_loopback_trusts_forwarded_header() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "203.0.113.77".parse().unwrap());
    let peer = Some(SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, 9999)));
    assert_eq!(throttle_client_id(&headers, peer), "203.0.113.77");
  }
}
